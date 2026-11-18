// Stab Lab — browser UI. All sound generation lives in src/dsp + src/engine;
// this file only wires controls, rendering, playback and export.

import { SCHEMA, MACROS, LOCK_GROUPS, getPath, setPath } from '../engine/patch.js';
import { PRESETS, PRESET_BY_ID, presetPatch } from '../engine/presets.js';
import { defaultKitSettings, generateKit, mutateStab, baseChordFor, CHORD_MODES, settingsKey, KEY_CHANGES } from '../engine/variation.js';
import { CHORD_TYPES, NOTE_NAMES, SCALES, noteName } from '../music/theory.js';
import { randomChord, mutateChord, VOICINGS, PROGRESSIONS } from '../music/chords.js';
import { defaultExportSettings, prepareStab, normaliseGains, stabFiles, stabFileBase, kitFolderName, encodeWav, finalLength } from '../engine/export.js';
import { Rng } from '../dsp/rng.js';
import { renderStab } from '../dsp/render.js';
import { FolderLink, CURRENT_DIR, KEPT_DIR } from './folderlink.js';
import { detectNotes, toMono } from '../music/detect.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) e.append(kid);
  return e;
};
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// ---------------------------------------------------------------- state
const STORE_KEY = 'stablab.v1';
const state = {
  settings: defaultKitSettings(),
  ex: defaultExportSettings(),
  stabs: [],
  renders: {},      // uid -> render result
  overrides: {},    // index -> { baseSeed, key, stab } (mutated pads)
  held: {},         // index -> stab (pads kept when generating a new kit)
  chops: {},        // uid -> sample position
  reversed: {},     // uid -> true when the pad plays backwards
  selected: 0,
  audition: 'mix',
  sidechain: null,  // Float32Array at export sample rate
  uid: 0,
  jobId: 0,
};
{
  const pr = PRESET_BY_ID[state.settings.presetId];
  if (pr.chord) Object.assign(state.settings.chord, pr.chord);
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ settings: state.settings, ex: state.ex }));
  } catch { /* storage unavailable: fine */ }
}
function restore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.settings) state.settings = { ...defaultKitSettings(), ...saved.settings };
    if (saved.ex) state.ex = { ...defaultExportSettings(), ...saved.ex };
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- rendering
let worker = null;
try {
  // eslint-disable-next-line no-undef
  const src = typeof __WORKER_SRC__ !== 'undefined' ? __WORKER_SRC__ : null;
  worker = src
    ? new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
    : new Worker(new URL('../worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => onWorkerMessage(e.data);
  worker.onerror = () => { worker = null; scheduleRender(); };
} catch { worker = null; }

let pendingUids = new Set();
let inlineTimer = null;

function renderOpts() {
  return { sr: state.ex.sampleRate, bpm: state.settings.bpm, maxTail: state.ex.maxSeconds, sidechainSignal: state.sidechain };
}

function scheduleRender() {
  const missing = state.stabs.filter((s) => !state.renders[s.uid]);
  pendingUids = new Set(missing.map((s) => s.uid));
  updateProgress();
  if (!missing.length) return;
  const items = missing.map((s) => ({ uid: s.uid, index: s.index, patch: s.patch, notes: s.chord.notes, renderSeed: s.renderSeed }));
  state.jobId++;
  if (worker) {
    worker.postMessage({ type: 'render', jobId: state.jobId, items, opts: renderOpts() });
  } else {
    // Fallback: render on the main thread, one stab per tick.
    clearTimeout(inlineTimer);
    const job = state.jobId;
    const step = () => {
      if (job !== state.jobId) return;
      const it = items.shift();
      if (!it) return;
      const r = renderStab(it.patch, it.notes, { ...renderOpts(), seed: it.renderSeed });
      onWorkerMessage({ type: 'stab', uid: it.uid, ...r });
      inlineTimer = setTimeout(step, 0);
    };
    inlineTimer = setTimeout(step, 0);
  }
}

const waiters = [];
function onWorkerMessage(m) {
  if (m.type !== 'stab') return;
  if (!state.stabs.some((s) => s.uid === m.uid)) return;
  state.renders[m.uid] = { sr: m.sr, length: m.length, dryLength: m.dryLength, peak: m.peak, dry: m.dry, wet: m.wet };
  pendingUids.delete(m.uid);
  updateProgress();
  const i = state.stabs.findIndex((s) => s.uid === m.uid);
  drawPad(i);
  if (i === state.selected) drawWave();
  if (autoPlayUid === m.uid) { autoPlayUid = null; play(i); }
  if (!pendingUids.size) while (waiters.length) waiters.shift()();
  syncFolder();
}
const allRendered = () => new Promise((res) => (pendingUids.size ? waiters.push(res) : res()));

function updateProgress() {
  const total = state.stabs.length || 1;
  const done = total - pendingUids.size;
  $('#progress div').style.width = `${(done / total) * 100}%`;
  $('#status').textContent = pendingUids.size ? `Rendering ${done}/${total}…` : `${total} stabs ready`;
}

// ---------------------------------------------------------------- kit generation
let regenTimer = null;
let autoPlayUid = null;
function regenerate({ immediate = false, audition = false } = {}) {
  clearTimeout(regenTimer);
  const run = () => {
    const s = state.settings;
    const prev = state.stabs;
    let stabs = generateKit(s, prev);
    const key = settingsKey(s);
    stabs = stabs.map((st, i) => {
      if (state.held[i]) return state.held[i];
      const ov = state.overrides[i];
      if (ov && ov.baseSeed === st.seed && ov.key === key) return ov.stab;
      if (ov) delete state.overrides[i];
      return st;
    });
    for (const st of stabs) if (!st.uid) st.uid = ++state.uid;
    // Forget renders that are no longer used.
    const live = new Set(stabs.map((x) => x.uid));
    for (const uid of Object.keys(state.renders)) if (!live.has(Number(uid))) { delete state.renders[uid]; delete state.chops[uid]; delete state.reversed[uid]; }
    state.stabs = stabs;
    if (state.selected >= stabs.length) state.selected = 0;
    if (audition && autoAudition) autoPlayUid = stabs[state.selected]?.uid ?? null;
    buildPads();
    scheduleRender();
    drawWave();
    updateChordDisplay();
    persist();
    syncFolder();
  };
  if (immediate) run(); else regenTimer = setTimeout(run, 180);
}

function invalidateAll() {
  state.renders = {};
  state.chops = {};
  for (const st of state.stabs) st.uid = ++state.uid;
  for (const h of Object.values(state.held)) h.uid = h.uid || ++state.uid;
  buildPads();
  scheduleRender();
}

function newSeed() {
  const words = ['dub', 'acid', 'warehouse', 'tape', 'chord', 'rave', 'deep', 'jack', 'echo', 'haze', 'vapour', 'plate', 'spring', 'steam', 'lofi', 'glass'];
  const r = new Rng(Date.now() ^ (Math.random() * 1e9));
  return `${r.pick(words)}-${r.int(100, 999)}`;
}

// ---------------------------------------------------------------- controls helpers
function field(label, input, cls = '') {
  return el('div', { class: `ctl ${cls}` }, el('label', {}, label), input);
}
function selectInput(options, value, onChange, labels) {
  const s = el('select', { onchange: (e) => onChange(e.target.value) });
  options.forEach((o, i) => {
    if (o && typeof o === 'object' && o.group) {
      const g = el('optgroup', { label: o.group });
      o.items.forEach((it) => g.append(el('option', { value: it.value }, it.label)));
      s.append(g);
    } else s.append(el('option', { value: o }, labels ? labels[i] : String(o)));
  });
  s.value = String(value);
  return s;
}
function fmt(v, unit, step) {
  if (unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`;
  if (unit === 's') return v < 1 ? `${Math.round(v * 1000 * 10) / 10} ms` : `${v.toFixed(2)} s`;
  const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return `${Number(v).toFixed(dec)}${unit ? ' ' + unit : ''}`;
}
function rangeInput({ label, min, max, step, scale, unit }, value, onChange, cls = '') {
  const log = scale === 'log' && min > 0;
  const toSlider = (v) => (log ? Math.log(v / min) / Math.log(max / min) * 1000 : v);
  const fromSlider = (x) => {
    if (!log) return Number(x);
    const v = min * Math.pow(max / min, x / 1000);
    return step ? Math.round(v / step) * step : v;
  };
  const val = el('span', { class: 'val' }, fmt(value, unit, step));
  const input = el('input', {
    type: 'range', min: log ? 0 : min, max: log ? 1000 : max, step: log ? 1 : step, value: toSlider(value),
    'aria-label': label,
  });
  const fill = () => input.style.setProperty('--pct', `${((input.value - input.min) / (input.max - input.min)) * 100}%`);
  fill();
  input.addEventListener('input', () => {
    fill();
    const v = fromSlider(input.value);
    val.textContent = fmt(v, unit, step);
    onChange(v);
  });
  return el('div', { class: `ctl ${cls}` }, el('label', {}, el('span', {}, label), val), input);
}

// Rotary knob for macros, drawn like RatMode's KnobPainter (UIConstants.h):
// recessed dark well, dim track ring, orange value arc, white pointer dot.
// 300 degree sweep starting at 7 o'clock. Macros are bipolar (0.5 = no
// change), so the arc grows out from a 12 o'clock centre tick.
function knob({ label, hint }, value, onChange) {
  const C = 32, R_ARC = 27, R_WELL = 26, START = 210, SWEEP = 300;
  // Angles are clockwise from 12 o'clock, as in RatMode.
  const pt = (deg, r) => {
    const a = (deg * Math.PI) / 180;
    return [C + r * Math.sin(a), C - r * Math.cos(a)];
  };
  const arcPath = (a0, a1, r) => {
    const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r);
    return `M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('role', 'slider');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('aria-valuemin', '0'); svg.setAttribute('aria-valuemax', '100');
  const mk = (tag, attrs) => { const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); svg.append(n); return n; };
  mk('circle', { cx: C, cy: C, r: R_WELL, class: 'well', 'stroke-width': 2 });
  mk('path', { d: arcPath(START, START + SWEEP, R_ARC), class: 'track', fill: 'none', 'stroke-width': 2.4 });
  const arc = mk('path', { class: 'arc', fill: 'none', 'stroke-width': 4, 'stroke-linecap': 'round' });
  const centre = START + SWEEP / 2;
  const [tx0, ty0] = pt(centre, R_ARC - 4), [tx1, ty1] = pt(centre, R_ARC + 4);
  mk('line', { x1: tx0, y1: ty0, x2: tx1, y2: ty1, class: 'detent', 'stroke-width': 3 });
  const dot = mk('circle', { r: 3, class: 'dot' });
  const valEl = el('span', { class: 'k-val' });
  let v = value;
  const draw = () => {
    const ang = START + SWEEP * v;
    arc.setAttribute('d', Math.abs(v - 0.5) > 0.003 ? arcPath(Math.min(centre, ang), Math.max(centre, ang), R_ARC) : '');
    const [x, y] = pt(ang, R_ARC);
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);
    const pct = Math.round((v - 0.5) * 200);
    valEl.textContent = pct === 0 ? '0' : (pct > 0 ? '+' : '') + pct;
    svg.setAttribute('aria-valuenow', String(Math.round(v * 100)));
  };
  const set = (nv) => { v = Math.min(1, Math.max(0, nv)); draw(); onChange(v); };
  let startY = 0, startV = 0;
  svg.addEventListener('pointerdown', (e) => { svg.setPointerCapture(e.pointerId); startY = e.clientY; startV = v; });
  svg.addEventListener('pointermove', (e) => {
    if (!svg.hasPointerCapture(e.pointerId)) return;
    set(startV + (startY - e.clientY) / (e.shiftKey ? 600 : 160));
  });
  svg.addEventListener('dblclick', () => set(0.5));
  svg.addEventListener('keydown', (e) => {
    const d = e.shiftKey ? 0.01 : 0.05;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { set(v + d); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { set(v - d); e.preventDefault(); }
  });
  draw();
  return el('div', { class: 'knob', title: `${hint} — drag, double-click to reset` }, svg, el('span', { class: 'k-label' }, label), valEl);
}

// ---------------------------------------------------------------- kit panel
function presetOptions() {
  const groups = [
    { group: 'Analogue', items: [] }, { group: 'Hybrid', items: [] }, { group: 'Digital', items: [] },
  ];
  for (const p of [...PRESETS].sort((a, b) => b.analog - a.analog)) {
    const g = p.analog >= 0.65 ? 0 : p.analog >= 0.3 ? 1 : 2;
    groups[g].items.push({ value: p.id, label: p.name });
  }
  if (state.settings.basePatch) groups.unshift({ group: 'Edited', items: [{ value: '__edited', label: `${PRESET_BY_ID[state.settings.presetId]?.name ?? ''} (edited)` }] });
  return groups;
}

function buildKitPanel() {
  const s = state.settings;
  const root = $('#kit-controls');
  root.replaceChildren();
  root.append(
    field('Character', selectInput(presetOptions(), s.basePatch ? '__edited' : s.presetId, (v) => {
      if (v === '__edited') return;
      loadPreset(v);
    }), 'wide'),
    field('Key', selectInput(NOTE_NAMES.map((_, i) => i), s.key, (v) => {
      const delta = Number(v) - s.key;
      s.key = Number(v);
      s.chord.root = (s.chord.root + delta + 12) % 12;
      if (s.customNotes) s.customNotes = s.customNotes.map((n) => n + delta);
      buildChordPanel(); regenerate();
    }, NOTE_NAMES)),
    field('Scale', selectInput(Object.keys(SCALES), s.scale, (v) => { s.scale = v; regenerate(); })),
    field('Tempo (BPM)', el('input', { type: 'number', min: 40, max: 220, value: s.bpm, onchange: (e) => { s.bpm = Math.min(220, Math.max(40, Number(e.target.value) || 124)); regenerate(); } })),
    field('Pads', selectInput([4, 8, 12, 16], s.size, (v) => { s.size = Number(v); regenerate(); })),
    field('Seed', el('div', { class: 'inline' },
      el('input', { type: 'text', value: s.seed, id: 'seed-input', onchange: (e) => { s.seed = e.target.value || 'stab'; s.stabSeeds = {}; regenerate(); } }),
      el('button', { class: 'btn small', title: 'New random seed', onclick: () => newKit() }, '🎲'),
    ), 'wide'),
    rangeInput({ label: 'Variation', min: 0, max: 1, step: 0.01 }, s.variation, (v) => { s.variation = v; regenerate(); }, 'wide'),
    rangeInput({ label: 'Family spread', min: 0, max: 1, step: 0.01 }, s.familySpread, (v) => { s.familySpread = v; regenerate(); }),
    rangeInput({ label: 'Tail spread', min: 0, max: 1, step: 0.01 }, s.tailSpread, (v) => { s.tailSpread = v; regenerate(); }),
    rangeInput({ label: 'Delay time spread', min: 0, max: 1, step: 0.01 }, s.delaySpread ?? 0, (v) => { s.delaySpread = v; regenerate(); }, 'wide'),
  );
}

function loadPreset(id) {
  const s = state.settings;
  s.presetId = id;
  s.basePatch = null;
  const pr = PRESET_BY_ID[id];
  if (pr?.chord && !s.customNotes) Object.assign(s.chord, pr.chord);
  $('#preset-title').textContent = pr?.name ?? 'Character';
  buildKitPanel(); buildChordPanel(); buildSoundPanel(); buildDelayStrip(); buildTextureStrip(); buildCompStrip();
  regenerate({ audition: true });
}

function newKit() {
  const s = state.settings;
  s.seed = newSeed();
  s.stabSeeds = {};
  state.overrides = {};
  const inp = $('#seed-input'); if (inp) inp.value = s.seed;
  regenerate({ immediate: true, audition: true });
}

// ---------------------------------------------------------------- chord panel
function buildChordPanel() {
  const s = state.settings;
  const root = $('#chord-controls');
  root.replaceChildren();
  const base = baseChordFor(s);
  const nameEl = el('div', { class: 'chord-name', id: 'chord-name' }, base.name,
    el('span', { class: 'sub' }, base.notes.map(noteName).join(' ')));
  const typeOpts = [];
  for (const t of CHORD_TYPES) {
    let g = typeOpts.find((x) => x.group === t.group);
    if (!g) { g = { group: t.group, items: [] }; typeOpts.push(g); }
    g.items.push({ value: t.id, label: t.suffix.trim() || 'maj' });
  }
  const useBuilder = !s.customNotes;
  const builder = el('div', { class: 'grid2' },
    field('Root', selectInput(NOTE_NAMES.map((_, i) => i), s.chord.root, (v) => { s.chord.root = Number(v); chordChanged(); }, NOTE_NAMES)),
    field('Type', selectInput(typeOpts, s.chord.type, (v) => { s.chord.type = v; chordChanged(); })),
    field('Inversion', selectInput([0, 1, 2, 3], s.chord.inversion, (v) => { s.chord.inversion = Number(v); chordChanged(); }, ['Root', '1st', '2nd', '3rd'])),
    field('Voicing', selectInput(VOICINGS, s.chord.voicing, (v) => { s.chord.voicing = v; chordChanged(); })),
    field('Register', selectInput([48, 54, 60, 66, 72], s.chord.centre, (v) => { s.chord.centre = Number(v); chordChanged(); }, ['Low', 'Low-mid', 'Mid', 'High-mid', 'High'])),
    el('div', { class: 'ctl' }, el('span', { class: 'lbl' }, 'Doubling'),
      el('div', { class: 'chips' },
        chip('Bass root', s.chord.bass, (on) => { s.chord.bass = on; chordChanged(); }),
        chip('Top octave', s.chord.top, (on) => { s.chord.top = on; chordChanged(); }))),
  );
  if (!useBuilder) builder.style.display = 'none';

  const modeSel = field('Across the kit', selectInput(Object.keys(CHORD_MODES), s.chordMode, (v) => { s.chordMode = v; buildChordPanel(); regenerate(); }, Object.values(CHORD_MODES)), 'wide');
  const prog = field('Progression', selectInput(Object.keys(PROGRESSIONS), s.progression, (v) => { s.progression = v; regenerate(); }), 'wide');
  if (s.chordMode !== 'progression') prog.style.display = 'none';

  root.append(
    nameEl,
    el('div', { class: 'row gap', style: 'margin:0 0 10px' },
      el('button', { class: 'btn small', onclick: () => {
        const r = new Rng(Date.now());
        const c = randomChord(r, { key: s.key, scale: s.scale, dissonance: s.dissonance, centre: s.chord.centre });
        s.customNotes = c.notes; state.reference = null; chordChanged(true);
      } }, 'Random chord'),
      el('button', { class: 'btn small', onclick: () => {
        const r = new Rng(Date.now());
        const c = mutateChord(r, baseChordFor(s), { strength: Math.max(0.3, s.mutation), dissonance: s.dissonance, key: s.key, scale: s.scale });
        s.customNotes = c.notes; state.reference = null; chordChanged(true);
      } }, 'Mutate chord'),
      s.customNotes ? el('button', { class: 'btn small', onclick: () => { s.customNotes = null; state.reference = null; chordChanged(true); } }, 'Back to builder') : null,
      el('label', { class: 'btn small file-btn', title: 'Or drop an audio file anywhere on the page' }, 'Copy notes from audio…',
        el('input', { type: 'file', accept: 'audio/*', hidden: true, onchange: (e) => { copyNotesFrom(e.target.files[0]); e.target.value = ''; } })),
    ),
    ...[referenceLine()].filter(Boolean),
    builder,
    el('div', { class: 'ctl wide', style: 'margin-top:10px' }, el('span', { class: 'lbl' }, 'Notes — click keys to build any chord, however crazy'), keyboard(base.notes)),
    el('div', { class: 'grid2', style: 'margin-top:10px' },
      modeSel, prog,
      field('Octave', selectInput([-2, -1, 0, 1, 2], s.octave ?? 0, (v) => { s.octave = Number(v); regenerate({ audition: true }); }, ['−2', '−1', '0', '+1', '+2'])),
      field('Octave spread', selectInput([0, 1, 2], s.octaveRange ?? 0, (v) => { s.octaveRange = Number(v); regenerate(); }, ['Same octave', 'Up to ±1 octave', 'Up to ±2 octaves'])),
      field('Key changes', selectInput(Object.keys(KEY_CHANGES), s.keyChange ?? 'off', (v) => { s.keyChange = v; buildChordPanel(); regenerate({ audition: true }); }, Object.values(KEY_CHANGES).map((k) => k.label)), 'wide'),
      (s.keyChange ?? 'off') !== 'off'
        ? field('Change key every', selectInput([1, 2, 4, 8], s.keyEvery ?? 4, (v) => { s.keyEvery = Number(v); regenerate(); }, ['pad', '2 pads', '4 pads', '8 pads']), 'wide')
        : null,
      rangeInput({ label: 'Dissonance', min: 0, max: 1, step: 0.01 }, s.dissonance, (v) => { s.dissonance = v; regenerate(); }),
      rangeInput({ label: 'Mutation', min: 0, max: 1, step: 0.01 }, s.mutation, (v) => { s.mutation = v; regenerate(); }),
    ),
  );
}

// ---------------------------------------------------------------- copy notes from a dropped stab
function referenceLine() {
  const ref = state.reference;
  if (!ref || !state.settings.customNotes) return null;
  const conf = ref.confidence > 0.6 ? 'clear' : ref.confidence > 0.3 ? 'fair' : 'rough guess';
  return el('div', { class: 'ref-line' },
    el('span', {}, `Copied from ${ref.name} (${conf})`),
    el('button', { class: 'btn small', onclick: playReference }, '▶ Original'),
    el('button', { class: 'btn small', onclick: () => { if (state.stabs[0]) { select(0); play(0); } } }, '▶ Pad 1'));
}

async function copyNotesFrom(file) {
  if (!file) return;
  if (!/^audio\//.test(file.type) && !/\.(wav|aiff?|mp3|m4a|flac|ogg|caf)$/i.test(file.name)) {
    $('#status').textContent = `${file.name} isn't an audio file`;
    return;
  }
  $('#status').textContent = `Listening to ${file.name}…`;
  try {
    const sr = 44100;
    const decoded = await new OfflineAudioContext(1, 1, sr).decodeAudioData(await file.arrayBuffer());
    const chs = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) chs.push(decoded.getChannelData(c).slice(0, sr * 8));
    const result = detectNotes(toMono(chs), decoded.sampleRate);
    if (!result.notes.length) { $('#status').textContent = `Couldn't hear clear notes in ${file.name}`; return; }
    state.reference = { name: file.name, channels: chs, sr: decoded.sampleRate, confidence: result.confidence };
    state.settings.customNotes = result.notes;
    $('#status').textContent = `${file.name}: ${result.name} (${result.notes.map(noteName).join(' ')})`;
    chordChanged(true);
  } catch (err) {
    $('#status').textContent = `Couldn't read ${file.name} (${err.message})`;
  }
}

function playReference() {
  const ref = state.reference;
  if (!ref) return;
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume();
  const buf = actx.createBuffer(Math.min(2, ref.channels.length), ref.channels[0].length, ref.sr);
  for (let c = 0; c < buf.numberOfChannels; c++) buf.copyToChannel(ref.channels[c], c);
  if (current) { try { current.s.stop(); } catch { /* already stopped */ } }
  const src = actx.createBufferSource(); src.buffer = buf;
  const g = actx.createGain(); src.connect(g).connect(actx.destination); src.start();
  current = { s: src, g };
}

// Drop an audio file anywhere to copy its notes.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; document.body.classList.add('dropping'); });
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0; document.body.classList.remove('dropping');
  const f = [...e.dataTransfer.files].find((x) => /^audio\//.test(x.type) || /\.(wav|aiff?|mp3|m4a|flac|ogg|caf)$/i.test(x.name));
  if (f) copyNotesFrom(f); else $('#status').textContent = 'Drop an audio file (WAV, AIFF, MP3…) to copy its notes';
});

function chordChanged(rebuild = false) {
  if (rebuild) buildChordPanel(); else updateChordDisplay(true);
  regenerate({ audition: true });
}

function updateChordDisplay(refreshKeys = false) {
  const base = baseChordFor(state.settings);
  const n = $('#chord-name');
  if (n) n.replaceChildren(base.name, el('span', { class: 'sub' }, base.notes.map(noteName).join(' ')));
  if (refreshKeys) {
    const k = $('#keys');
    if (k) k.replaceWith(keyboard(base.notes));
  }
}

function chip(label, on, onToggle) {
  const b = el('button', { class: `chip${on ? ' on' : ''}`, 'aria-pressed': on ? 'true' : 'false' }, label);
  b.addEventListener('click', () => {
    const now = !b.classList.contains('on');
    b.classList.toggle('on', now); b.setAttribute('aria-pressed', String(now));
    onToggle(now);
  });
  return b;
}

// Three-octave clickable keyboard (C2..B4 + C5).
function keyboard(active) {
  const LOW = 36, HIGH = 84;
  const whites = [];
  for (let m = LOW; m <= HIGH; m++) if (![1, 3, 6, 8, 10].includes(m % 12)) whites.push(m);
  const wPct = 100 / whites.length;
  const box = el('div', { class: 'keys', id: 'keys', role: 'group', 'aria-label': 'Chord notes' });
  const set = new Set(active);
  const toggle = (m) => {
    const s = state.settings;
    const cur = new Set(baseChordFor(s).notes);
    if (cur.has(m)) { if (cur.size > 1) cur.delete(m); } else cur.add(m);
    s.customNotes = [...cur].sort((a, b) => a - b);
    state.reference = null;
    chordChanged(true);
  };
  whites.forEach((m, i) => {
    const k = el('div', { class: `w${set.has(m) ? ' on' : ''}`, style: `left:${i * wPct}%;width:${wPct}%`, title: noteName(m), onclick: () => toggle(m) });
    box.append(k);
    if (m % 12 === 0) box.append(el('span', { class: 'c-mark', style: `left:calc(${i * wPct}% + 2px)` }, noteName(m)));
  });
  for (let m = LOW; m <= HIGH; m++) {
    if (![1, 3, 6, 8, 10].includes(m % 12)) continue;
    const wi = whites.indexOf(m - 1);
    box.append(el('div', { class: `b${set.has(m) ? ' on' : ''}`, style: `left:${(wi + 0.68) * wPct}%;width:${wPct * 0.64}%`, title: noteName(m), onclick: () => toggle(m) }));
  }
  return box;
}

// ---------------------------------------------------------------- locks + export panels
function buildLocks() {
  const root = $('#lock-controls');
  root.replaceChildren(...Object.entries(LOCK_GROUPS).map(([id, g]) =>
    chip(g.label, state.settings.locks[id], (on) => { state.settings.locks[id] = on; buildSoundPanel(); regenerate(); })));
}

function buildExportPanel() {
  const ex = state.ex;
  const root = $('#export-controls');
  const ch = (k, conv = (x) => x, rerender = false) => (v) => {
    ex[k] = conv(v); persist();
    if (rerender) invalidateAll(); else { drawAllPads(); drawWave(); syncFolder(); }
  };
  root.replaceChildren(
    field('Files', selectInput(['both', 'mix', 'stems'], ex.stems, ch('stems'), ['Mix + dry/tail stems', 'Mix only', 'Dry + tail stems only']), 'wide'),
    field('Tail length', selectInput(['auto', 'snap', 'fixed'], ex.lengthMode, (v) => { ch('lengthMode')(v); buildExportPanel(); }, ['Until silent', 'Until silent, snap to beat', 'Fixed bars'])),
    ex.lengthMode === 'fixed'
      ? field('Bars', selectInput([0.25, 0.5, 1, 2, 4, 8], ex.fixedBars, ch('fixedBars', Number), ['1 beat', '2 beats', '1 bar', '2 bars', '4 bars', '8 bars']))
      : field('Max length', selectInput([4, 8, 12, 16, 24, 30], ex.maxSeconds, ch('maxSeconds', Number, true), ['4 s', '8 s', '12 s', '16 s', '24 s', '30 s'])),
    field('Normalise', selectInput(['kit', 'each', 'off'], ex.normalise, ch('normalise'), ['Whole kit together', 'Each stab', 'Off'])),
    field('Peak', selectInput([-0.3, -1, -3, -6], ex.targetDb, ch('targetDb', Number), ['-0.3 dB', '-1 dB', '-3 dB', '-6 dB'])),
    field('Sample rate', selectInput([44100, 48000], ex.sampleRate, ch('sampleRate', Number, true), ['44.1 kHz', '48 kHz'])),
    field('Bit depth', selectInput([16, 24, 32], ex.bitDepth, ch('bitDepth', Number), ['16-bit', '24-bit', '32-bit float'])),
  );
}

// ---------------------------------------------------------------- macros
function buildMacros() {
  const root = $('#macros');
  for (const m of MACROS) if (state.settings.macros[m.id] == null) state.settings.macros[m.id] = 0.5;
  root.replaceChildren(...MACROS.map((m) => knob(m, state.settings.macros[m.id], (v) => {
    state.settings.macros[m.id] = v; regenerate({ audition: true });
  })));
  buildDelayStrip();
  buildTextureStrip();
  buildCompStrip();
}

// Quick delay controls next to the macros (edit the base sound).
function buildDelayStrip() {
  const root = $('#delay-strip');
  if (!root) return;
  const d = currentBase().delay;
  const mode = d.send <= 0 ? 'off' : d.mode;
  const set = (fn) => { const p = editablePatch(); fn(p.delay); markEdited(); buildSoundPanel(); buildDelayStrip(); regenerate({ audition: true }); };
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Delay style' },
    ...[['pingpong', 'Ping-pong'], ['stereo', 'Stereo'], ['tape', 'Tape'], ['off', 'Off']].map(([v, label]) =>
      el('button', { class: mode === v ? 'on' : '', onclick: () => set((x) => {
        if (v === 'off') { if (x.send > 0) x.lastSend = x.send; x.send = 0; }
        else { x.mode = v; if (x.send <= 0) x.send = x.lastSend || 0.25; }
      }) }, label)));
  root.replaceChildren(
    el('span', { class: 'lbl' }, 'Delay'), seg,
    el('div', { class: 'strip-ctl' }, selectInput(['1/16', '1/16d', '1/8t', '1/8', '1/8d', '1/4t', '1/4', '1/4d', '1/2'], d.division, (v) => set((x) => { x.division = v; }))),
    el('div', { class: 'strip-ctl wide' }, rangeInput({ label: 'Amount', min: 0, max: 1, step: 0.01 }, d.send, (v) => {
      const p = editablePatch(); p.delay.send = v; markEdited(); regenerate({ audition: true });
    })),
    el('div', { class: 'strip-ctl wide' }, rangeInput({ label: 'Feedback', min: 0, max: 0.95, step: 0.01 }, d.feedback, (v) => {
      const p = editablePatch(); p.delay.feedback = v; markEdited(); regenerate({ audition: true });
    })),
    el('div', { class: 'strip-ctl wide', title: 'Tape mode: saturation, head bump, hiss, wow and dropouts. Other modes: loop drive.' },
      rangeInput({ label: d.mode === 'tape' ? 'Tape grit' : 'Grit', min: 0, max: 1, step: 0.01 }, d.grit ?? 0.4, (v) => {
        const p = editablePatch(); p.delay.grit = v; markEdited(); regenerate({ audition: true });
      })),
  );
}

// Compressor quick controls, next to the macros.
function buildCompStrip() {
  const root = $('#comp-strip');
  if (!root) return;
  const c = currentBase().comp ?? { amount: 0, mode: 'stab', attack: 0.012, release: 0.15, mix: 1 };
  const mode = c.amount <= 0 ? 'off' : c.mode;
  const set = (fn) => { const p = editablePatch(); p.comp = p.comp ?? { amount: 0.3, mode: 'stab', ratio: 4, attack: 0.012, release: 0.15, mix: 1 }; fn(p.comp); markEdited(); buildSoundPanel(); buildCompStrip(); regenerate({ audition: true }); };
  const slider = (label, key, prm, hint) => el('div', { class: 'strip-ctl wide', title: hint },
    rangeInput({ label, ...prm }, c[key], (v) => { const p = editablePatch(); p.comp[key] = v; markEdited(); regenerate({ audition: true }); }));
  root.replaceChildren(
    el('span', { class: 'lbl' }, 'Comp'),
    el('div', { class: 'seg', role: 'group', 'aria-label': 'Compressor mode' },
      ...[['stab', 'Stab'], ['glue', 'Glue'], ['off', 'Off']].map(([v, label]) =>
        el('button', {
          class: mode === v ? 'on' : '',
          title: v === 'stab' ? 'Compress the hit before it feeds the delay and reverb' : v === 'glue' ? 'Compress the stab and its tails together, so the tails pump around the hit' : 'No compression',
          onclick: () => set((x) => {
            if (v === 'off') { if (x.amount > 0) x.lastAmount = x.amount; x.amount = 0; }
            else { x.mode = v; if (x.amount <= 0) x.amount = x.lastAmount || 0.3; }
          }),
        }, label))),
    slider('Amount', 'amount', { min: 0, max: 1, step: 0.01 }, 'How hard it squeezes'),
    slider('Attack', 'attack', { min: 0.0002, max: 0.3, step: 0.0001, scale: 'log', unit: 's' }, 'Slower attack lets the transient punch through'),
    slider('Release', 'release', { min: 0.01, max: 2, step: 0.01, scale: 'log', unit: 's' }, 'How fast it lets go; longer pumps less'),
    slider('Mix', 'mix', { min: 0, max: 1, step: 0.01 }, 'Parallel blend of compressed and uncompressed'),
  );
}

// Crackle, hiss and air noise, next to the macros.
function buildTextureStrip() {
  const root = $('#texture-strip');
  if (!root) return;
  const base = currentBase();
  const t = base.texture ?? {};
  const ctl = (label, path, value, hint) => el('div', { class: 'strip-ctl wide', title: hint },
    rangeInput({ label, min: 0, max: 1, step: 0.01 }, value ?? 0, (v) => {
      setPath(editablePatch(), path, v); markEdited(); regenerate({ audition: true });
    }));
  root.replaceChildren(
    el('span', { class: 'lbl' }, 'Texture'),
    ctl('Crackle', 'texture.crackle', t.crackle, 'Vinyl-style clicks and pops'),
    ctl('Density', 'texture.density', t.density, 'How often the crackle clicks'),
    ctl('Hiss', 'texture.hiss', t.hiss, 'Tape hiss'),
    ctl('Air', 'noise.air', base.noise?.air, 'Breathy noise inside the sound, shaped by the filter and envelope'),
  );
}

// ---------------------------------------------------------------- sound design panel
function editablePatch() {
  const s = state.settings;
  if (!s.basePatch) s.basePatch = presetPatch(s.presetId);
  return s.basePatch;
}
function currentBase() { return state.settings.basePatch ?? presetPatch(state.settings.presetId); }

function buildSoundPanel() {
  const root = $('#sound');
  const openIds = new Set([...root.querySelectorAll('details[open]')].map((d) => d.dataset.id));
  root.replaceChildren();
  const p = currentBase();
  for (const sec of SCHEMA) {
    const det = el('details', { 'data-id': sec.id });
    if (openIds.has(sec.id)) det.open = true;
    const locked = state.settings.locks[sec.lock];
    det.append(el('summary', {}, sec.label, locked ? el('span', { class: 'lock-tag' }, 'locked') : null));
    const grid = el('div', { class: 'grid2' });
    const oscType = sec.id.startsWith('osc') ? getPath(p, `osc.${Number(sec.id.slice(3)) - 1}.type`) : null;
    for (const prm of sec.params) {
      if (prm.show && oscType && !prm.show.includes(oscType)) continue;
      if (prm.path.endsWith('.perc') && oscType !== 'organ') continue;
      const value = getPath(p, prm.path);
      const onChange = (v) => {
        setPath(editablePatch(), prm.path, v);
        markEdited();
        if (prm.path.endsWith('.type') && sec.id.startsWith('osc')) buildSoundPanel();
        if (prm.path.startsWith('delay.')) buildDelayStrip();
        if (prm.path.startsWith('texture.') || prm.path === 'noise.air') buildTextureStrip();
        if (prm.path.startsWith('comp.')) buildCompStrip();
        regenerate({ audition: true });
      };
      if (prm.kind === 'range') grid.append(rangeInput(prm, value, onChange));
      else if (prm.kind === 'select') grid.append(field(prm.label, selectInput(prm.options, value, (v) => onChange(typeof prm.options[0] === 'number' ? Number(v) : v), prm.labels)));
      else if (prm.kind === 'toggle') {
        const cb = el('input', { type: 'checkbox', onchange: (e) => onChange(e.target.checked) });
        cb.checked = !!value;
        grid.append(el('label', { class: 'toggle ctl' }, cb, prm.label));
      }
    }
    if (sec.id === 'follower') {
      const inp = el('input', { type: 'file', accept: 'audio/*', onchange: (e) => loadSidechain(e.target.files[0]) });
      grid.append(el('div', { class: 'ctl wide' }, el('span', { class: 'lbl' }, `Sidechain audio ${state.sidechain ? '(loaded)' : '(for "Uploaded audio")'}`), inp));
    }
    det.append(grid);
    root.append(det);
  }
}

function markEdited() {
  const sel = $('#kit-controls select');
  if (sel && sel.value !== '__edited') buildKitPanel();
}

async function loadSidechain(file) {
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const sr = state.ex.sampleRate;
    const tmp = new OfflineAudioContext(1, 1, sr);
    const decoded = await tmp.decodeAudioData(buf);
    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * sr), sr);
    const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
    const rendered = await off.startRendering();
    state.sidechain = rendered.getChannelData(0).slice();
    setPath(editablePatch(), 'sidechain.mode', 'file');
    markEdited(); buildSoundPanel(); invalidateAll();
    regenerate({ immediate: true });
  } catch (err) {
    $('#status').textContent = `Could not read that audio file (${err.message})`;
  }
}

// ---------------------------------------------------------------- pads
const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', 'q', 'w', 'e', 'r', 't', 'y', 'u', 'i'];

function buildPads() {
  const root = $('#pads');
  root.replaceChildren();
  state.stabs.forEach((st, i) => {
    const canvas = el('canvas', { height: 38 });
    const held = !!state.held[i];
    const pad = el('div', {
      class: `pad${i === state.selected ? ' sel' : ''}${held ? ' held' : ''}`, tabindex: '0', draggable: 'true', 'data-i': i,
      role: 'button', 'aria-label': `Stab ${i + 1}: ${st.chord.name}`,
    },
    el('div', { class: 'p-top' }, el('span', { class: 'p-chord', title: st.chord.notes.map(noteName).join(' ') }, st.chord.name),
      el('span', { class: 'p-badges' }, state.reversed[st.uid] ? el('span', { class: 'p-held', title: 'This pad plays backwards' }, 'Rev') : null,
        held ? el('span', { class: 'p-held', title: 'New kit keeps this pad' }, 'Held') : null, el('span', { class: 'p-num' }, PAD_KEYS[i]?.toUpperCase() ?? ''))),
    canvas,
    el('div', { class: 'p-top' }, el('span', { class: 'p-tail' }, `${st.info?.tailLabel ?? ''} tail${st.info?.delay ? ` · ${st.info.delay}` : ''}`), el('span', { class: 'p-num', 'data-len': '' }, '')),
    el('div', { class: 'p-meta' }, [
      st.info?.key ? `key ${st.info.key}` : '',
      st.info?.octaveShift ? `${st.info.octaveShift > 0 ? '+' : '−'}${Math.abs(st.info.octaveShift)} oct` : '',
      st.info?.borrowed ? `+ ${st.info.borrowed.groups.join(', ')} from ${st.info.borrowed.from}` : st.info?.mutated ? `mutated ×${st.info.mutated}` : '',
    ].filter(Boolean).join(' · ')),
    el('div', { class: 'p-actions' },
      el('button', { title: 'Re-roll: replace this pad with a new stab', onclick: (e) => { e.stopPropagation(); rerollPad(i); } }, '↻ Re-roll'),
      el('button', { title: 'Mutate: nudge this pad\'s chord and tone a little', onclick: (e) => { e.stopPropagation(); mutatePad(i); } }, '✦ Mutate'),
      el('button', {
        class: held ? 'on' : '', 'aria-pressed': held ? 'true' : 'false',
        title: held ? 'Held: New kit keeps this pad. Click to release it.' : 'Hold: keep this pad when you press New kit',
        onclick: (e) => { e.stopPropagation(); holdPad(i); },
      }, held ? '● Held' : '○ Hold'),
      el('button', {
        title: folder.state === 'linked' ? `Save this WAV to "${KEPT_DIR}" in your linked folder` : 'Download this pad as a WAV',
        onclick: (e) => { e.stopPropagation(); downloadPad(i); },
      }, '⬇ Save'),
    ));
    pad.addEventListener('click', () => { select(i); play(i); });
    pad.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); select(i); play(i); } });
    pad.addEventListener('mouseenter', () => prepareDrag(i));
    pad.addEventListener('dragstart', (e) => onDragStart(e, i));
    if (!state.renders[st.uid]) pad.classList.add('pending');
    root.append(pad);
    drawPad(i);
  });
}

function drawAllPads() { state.stabs.forEach((_, i) => drawPad(i)); }

function padGain(i) {
  const renders = state.stabs.map((s) => state.renders[s.uid]).filter(Boolean);
  const gains = normaliseGains(renders, state.ex);
  const r = state.renders[state.stabs[i]?.uid];
  const idx = renders.indexOf(r);
  return idx >= 0 ? gains[idx] : 1;
}

function prepared(i) {
  const st = state.stabs[i];
  const r = st && state.renders[st.uid];
  if (!r) return null;
  const p = prepareStab(r, state.ex, state.settings.bpm, padGain(i), state.chops[st.uid] ?? null);
  if (state.reversed[st.uid]) for (const chs of [p.dry, p.wet, p.mix]) for (const ch of chs) ch.reverse();
  return p;
}

// File name for a pad: reversed pads get a _rev suffix.
function padFileBase(i, kit = kitMeta()) {
  const st = state.stabs[i];
  return `${stabFileBase(st, kit)}${state.reversed[st.uid] ? '_rev' : ''}`;
}

function toggleReverse(i = state.selected) {
  const st = state.stabs[i];
  if (!st) return;
  if (state.reversed[st.uid]) delete state.reversed[st.uid]; else state.reversed[st.uid] = true;
  buildPads(); drawWave(); play(i); syncFolder();
}

function drawPad(i) {
  const pad = document.querySelector(`.pad[data-i="${i}"]`);
  if (!pad) return;
  const st = state.stabs[i];
  const r = st && state.renders[st.uid];
  pad.classList.toggle('pending', !r);
  const canvas = pad.querySelector('canvas');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 120, h = 38;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!r) return;
  const p = prepared(i);
  drawPeaks(ctx, p, w, h, Math.max(p.length, r.sr * 2));
  const lenEl = pad.querySelector('[data-len]');
  if (lenEl) lenEl.textContent = `${(p.length / p.sr).toFixed(1)}s`;
}

function drawPeaks(ctx, p, w, h, span) {
  const mid = h / 2;
  const cols = Math.max(1, Math.floor(w));
  const per = span / cols;
  const draw = (chs, colour) => {
    ctx.fillStyle = colour;
    for (let x = 0; x < cols; x++) {
      const a = Math.floor(x * per), b = Math.min(p.length, Math.floor((x + 1) * per));
      if (a >= p.length) break;
      let mx = 0;
      for (let k = a; k < b; k += 2) {
        const v = Math.max(Math.abs(chs[0][k]), Math.abs(chs[1][k]));
        if (v > mx) mx = v;
      }
      // sqrt scale so quiet tails stay visible next to the attack
      const hh = Math.max(0.5, Math.sqrt(mx) * (h / 2 - 1));
      ctx.fillRect(x, mid - hh, 1, hh * 2);
    }
  };
  const tail = cssVar('--accent-2'), dry = cssVar('--accent');
  if (state.audition !== 'dry') { ctx.globalAlpha = 0.55; draw(p.wet, tail); }
  ctx.globalAlpha = 1;
  if (state.audition !== 'wet') draw(p.dry, dry);
}

function select(i) {
  state.selected = i;
  document.querySelectorAll('.pad').forEach((pd) => pd.classList.toggle('sel', Number(pd.dataset.i) === i));
  drawWave();
}

function rerollPad(i) {
  const s = state.settings;
  s.stabSeeds = { ...s.stabSeeds, [i]: (s.stabSeeds[i] ?? 0) + 1 };
  delete state.overrides[i];
  delete state.held[i];
  state.selected = i;
  regenerate({ immediate: true, audition: true });
}

function mutatePad(i) {
  const st = state.stabs[i];
  if (!st) return;
  const ov = state.overrides[i];
  const salt = Date.now() % 100000;
  const m = mutateStab(st, state.settings, salt);
  m.uid = ++state.uid;
  const genSeed = ov ? ov.baseSeed : st.seed;
  state.overrides[i] = { baseSeed: genSeed, key: settingsKey(state.settings), stab: m };
  if (state.held[i]) state.held[i] = m;
  state.selected = i;
  regenerate({ immediate: true, audition: true });
}

function holdPad(i) {
  if (state.held[i]) delete state.held[i]; else state.held[i] = state.stabs[i];
  buildPads();
}

// ---------------------------------------------------------------- waveform / chop
function drawWave() {
  const canvas = $('#wave');
  const st = state.stabs[state.selected];
  const r = st && state.renders[st.uid];
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600, h = 140;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  $('#wave-title').textContent = st ? `Pad ${state.selected + 1} · ${st.chord.name}` : '—';
  $('#btn-unchop').hidden = !(st && state.chops[st.uid] != null);
  const rev = !!(st && state.reversed[st.uid]);
  const rb = $('#btn-reverse');
  rb.disabled = !st;
  rb.classList.toggle('on', rev);
  rb.setAttribute('aria-pressed', String(rev));
  rb.textContent = rev ? '⇆ Reversed' : '⇆ Reverse';
  if (!r) { $('#wave-info').textContent = st ? 'rendering…' : ''; return; }
  const full = prepareStab(r, state.ex, state.settings.bpm, padGain(state.selected), null);
  const chop = state.chops[st.uid];
  const span = full.length;
  // A reversed pad is drawn mirrored, so what you see is what plays.
  ctx.save();
  if (rev) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  drawPeaks(ctx, full, w, h, span);
  // dry-end marker
  ctx.fillStyle = cssVar('--muted');
  const dx = (r.dryLength / span) * w;
  ctx.fillRect(dx, 0, 1, h);
  if (chop != null) {
    const cx = (chop / span) * w;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(cx, 0, w - cx, h);
    ctx.fillStyle = cssVar('--danger');
    ctx.fillRect(cx - 1, 0, 2, h);
  }
  // beat grid
  const beat = (60 / state.settings.bpm) * r.sr;
  ctx.fillStyle = cssVar('--line');
  for (let b = beat; b < span; b += beat) ctx.fillRect((b / span) * w, h - 6, 1, 6);
  ctx.restore();
  const len = chop ?? full.length;
  const chs = st.chord.notes.map(noteName).join(' ');
  $('#wave-info').textContent = `${chs} · ${(len / r.sr).toFixed(2)} s${chop != null ? ' (chopped)' : ''}${rev ? ' · reversed' : ''} · ${(len / beat).toFixed(1)} beats`;
}

$('#wave').addEventListener('click', (e) => {
  const st = state.stabs[state.selected];
  const r = st && state.renders[st.uid];
  if (!r) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const full = finalLength(r, state.ex, state.settings.bpm);
  let x = (e.clientX - rect.left) / rect.width;
  if (state.reversed[st.uid]) x = 1 - x; // the view is mirrored
  let pos = Math.round(x * full);
  // Snap to the beat grid when close.
  const beat = (60 / state.settings.bpm) * r.sr;
  const nearest = Math.round(pos / beat) * beat;
  if (Math.abs(nearest - pos) < beat * 0.08) pos = nearest;
  state.chops[st.uid] = Math.max(Math.round(r.sr * 0.02), pos);
  drawWave(); drawPad(state.selected); play(state.selected); syncFolder();
});
$('#btn-reverse').addEventListener('click', () => toggleReverse());
$('#btn-unchop').addEventListener('click', () => {
  const st = state.stabs[state.selected];
  if (st) delete state.chops[st.uid];
  drawWave(); drawPad(state.selected); syncFolder();
});

// ---------------------------------------------------------------- playback
let actx = null;
let current = null;
let autoAudition = true;
// iPhone/iPad: web audio is treated as "ambient" by default, so the ring/
// silent switch mutes it. Ask for the media playback channel instead (Safari
// 16.4+), and on older iOS keep a silent looping <audio> element playing,
// which moves the page into that channel.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* not supported */ }
let mediaKeepAlive = null;

function ensureAudio() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  // 'suspended' before the first tap; 'interrupted' after a call or Siri on iOS.
  if (actx.state !== 'running') actx.resume().catch(() => {});
  return actx;
}

// Called on the first touch/click/key (and again until audio is running):
// iOS only lets audio start inside a user gesture.
function unlockAudio() {
  const ctx = ensureAudio();
  if (ctx.state === 'running' && (mediaKeepAlive || !isIOS)) return;
  try {
    const b = ctx.createBuffer(1, 1, ctx.sampleRate);
    const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0);
  } catch { /* ignore */ }
  if (isIOS && !mediaKeepAlive && !navigator.audioSession) {
    const wav = encodeWav([new Float32Array(4410)], 44100, 16);
    mediaKeepAlive = new Audio(URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })));
    mediaKeepAlive.loop = true;
    mediaKeepAlive.setAttribute('playsinline', '');
    mediaKeepAlive.play().catch(() => { mediaKeepAlive = null; });
  }
}
for (const ev of ['pointerdown', 'touchend', 'keydown', 'click']) document.addEventListener(ev, unlockAudio, { capture: true, passive: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden && actx && actx.state !== 'running') actx.resume().catch(() => {}); });

// The channels you hear for the current audition mode (Mix / Dry / Tail).
function auditionChannels(p) {
  return state.audition === 'dry' ? p.dry : state.audition === 'wet' ? p.wet : p.mix;
}

// Length up to the last audible sample, so silence (e.g. the empty tail of a
// Dry audition) doesn't stretch the gap in Play all.
function audibleLength(chs) {
  let peak = 0;
  for (const ch of chs) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
  const thr = Math.max(peak * 1e-3, 1e-5);
  for (let i = chs[0].length - 1; i > 0; i--) if (Math.abs(chs[0][i]) > thr || Math.abs(chs[1][i]) > thr) return i + 1;
  return 1;
}

function startSource(chs, sr, when = 0) {
  const ctx = ensureAudio();
  const buf = ctx.createBuffer(2, chs[0].length, sr);
  buf.copyToChannel(chs[0], 0); buf.copyToChannel(chs[1], 1);
  const s = ctx.createBufferSource(); s.buffer = buf;
  const g = ctx.createGain(); s.connect(g).connect(ctx.destination);
  s.start(when || 0);
  return { s, g };
}

function fadeOut(v) {
  if (!v) return;
  try { v.g.gain.setTargetAtTime(0, actx.currentTime, 0.01); v.s.stop(actx.currentTime + 0.05); } catch { /* already stopped */ }
}

function flashPad(i) {
  const pad = document.querySelector(`.pad[data-i="${i}"]`);
  if (pad) { pad.classList.add('flash'); setTimeout(() => pad.classList.remove('flash'), 90); }
}

function stopPlayback() {
  fadeOut(current); current = null;
  if (sequence) {
    sequence.voices.forEach(fadeOut);
    sequence.timers.forEach(clearTimeout);
    sequence = null;
  }
  updatePlayAllButton();
}

function play(i) {
  const p = prepared(i);
  if (!p) return;
  stopPlayback();
  current = startSource(auditionChannels(p), p.sr);
  flashPad(i);
}

// Play every pad in order, each starting 150 ms after the previous one ends.
const PLAY_ALL_GAP = 0.15;
let sequence = null;
async function playAll() {
  if (sequence) { stopPlayback(); return; }
  const ctx = ensureAudio(); // inside the key/click gesture, before any await
  sequence = { voices: [], timers: [] };
  updatePlayAllButton();
  if (pendingUids.size) $('#status').textContent = 'Waiting for every pad to render…';
  await allRendered();
  if (!sequence) return; // stopped while waiting
  fadeOut(current); current = null;
  let t = ctx.currentTime + 0.05;
  const seq = sequence;
  state.stabs.forEach((st, i) => {
    const p = prepared(i);
    if (!p) return;
    const full = auditionChannels(p);
    const n = audibleLength(full);
    const chs = [full[0].subarray(0, n), full[1].subarray(0, n)];
    seq.voices.push(startSource(chs, p.sr, t));
    const at = (t - ctx.currentTime) * 1000;
    seq.timers.push(setTimeout(() => { if (sequence === seq) { select(i); flashPad(i); $('#status').textContent = `Playing ${i + 1}/${state.stabs.length}`; } }, at));
    t += n / p.sr + PLAY_ALL_GAP;
  });
  seq.timers.push(setTimeout(() => {
    if (sequence !== seq) return;
    sequence = null; updatePlayAllButton();
    $('#status').textContent = `${state.stabs.length} stabs ready`;
  }, (t - ctx.currentTime) * 1000));
}

function updatePlayAllButton() {
  const b = $('#btn-play-all');
  if (!b) return;
  b.textContent = sequence ? '■ Stop' : '▶ Play all';
  b.classList.toggle('on', !!sequence);
}

document.querySelectorAll('#audition button').forEach((b) => b.addEventListener('click', () => {
  state.audition = b.dataset.v;
  document.querySelectorAll('#audition button').forEach((x) => x.classList.toggle('on', x === b));
  drawAllPads(); drawWave();
}));

const isTextField = (t) => !!t.closest('select, textarea, input:not([type=range]):not([type=checkbox]):not([type=file])');
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || isTextField(e.target)) return;
  // Space replays the selected pad, Shift+Space plays them all. This takes
  // priority over buttons, so a focused button isn't clicked again by Space.
  if (e.code === 'Space' || e.key === ' ') {
    e.preventDefault();
    if (e.repeat) return;
    if (e.shiftKey) playAll(); else play(state.selected);
    return;
  }
  if (e.key === 'Escape') { stopPlayback(); return; }
  const k = e.key.toLowerCase();
  const i = PAD_KEYS.indexOf(k);
  if (i >= 0 && i < state.stabs.length) { select(i); play(i); return; }
  if (k === 'n') newKit();
});

// ---------------------------------------------------------------- export
const kitMeta = () => ({ ...state.settings, presetName: PRESET_BY_ID[state.settings.presetId]?.name ?? 'stab' });

// Inside a claude.ai artifact, files can only be saved through the downloads
// capability, whose allowlist does not include .wav. We never fall back to ZIP:
// the artifact explains that WAVs need the standalone page instead.
const inArtifact = !!(window.claude && typeof window.claude.use === 'function');
const downloadsCap = inArtifact ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);
const NO_WAV_MSG = 'This claude.ai preview can\'t save WAV files. Open the standalone Stab Lab (dist/index.html) to save WAVs.';

function showNotice(text) {
  let n = $('#notice');
  if (!n) {
    n = el('div', { id: 'notice', class: 'notice', role: 'status' });
    $('.main').prepend(n);
  }
  n.textContent = text;
}

async function downloadBlob(data, name, type) {
  if (inArtifact) {
    const d = await downloadsCap;
    if (!d) { showNotice(NO_WAV_MSG); return false; }
    try {
      await d.save({ filename: name, data: new Blob([data]) });
      $('#status').textContent = `Saved ${name}`;
      return true;
    } catch (err) {
      if (err?.code === 'rejected_extension' || err?.code === 'extension_not_enabled') showNotice(NO_WAV_MSG);
      else if (err?.code !== 'declined') $('#status').textContent = `Could not save ${name} (${err?.code ?? 'error'})`;
      return false;
    }
  }
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}

function padWav(i) {
  const p = prepared(i);
  if (!p) return null;
  const chs = state.audition === 'dry' ? p.dry : state.audition === 'wet' ? p.wet : p.mix;
  const suffix = state.audition === 'dry' ? '_dry' : state.audition === 'wet' ? '_tail' : '';
  return { data: encodeWav(chs, p.sr, state.ex.bitDepth), name: `${padFileBase(i)}${suffix}.wav` };
}

async function downloadPad(i) {
  const w = padWav(i);
  if (!w) return;
  if (folder.state === 'linked') {
    try {
      const name = await folder.keep(w.name, w.data);
      $('#status').textContent = `Saved to ${KEPT_DIR}/${name}`;
    } catch (err) { $('#status').textContent = `Couldn't save to the linked folder (${err.message})`; }
    return;
  }
  downloadBlob(w.data, w.name, 'audio/wav');
}

// ---------------------------------------------------------------- linked folder (Ableton)
function folderGroups() {
  const kit = kitMeta();
  const exKey = JSON.stringify(state.ex);
  const groups = [];
  state.stabs.forEach((st, i) => {
    if (!state.renders[st.uid]) return;
    const base = padFileBase(i, kit);
    const names = [];
    if (state.ex.stems !== 'stems') names.push(`${base}.wav`);
    if (state.ex.stems !== 'mix') names.push(`stems/${base}_dry.wav`, `stems/${base}_tail.wav`);
    groups.push({
      key: `${st.uid}|${state.chops[st.uid] ?? ''}|${state.reversed[st.uid] ? 'r' : ''}|${padGain(i).toFixed(6)}|${exKey}`,
      names,
      build: () => stabFiles(prepared(i), base, state.ex),
    });
  });
  return groups;
}

const folder = new FolderLink(folderGroups, (st, detail) => renderFolderButton(st, detail));
function syncFolder() { folder.schedule(); }

function renderFolderButton(st, detail) {
  const b = $('#btn-folder');
  if (!b) return;
  b.hidden = !folder.supported || inArtifact;
  b.classList.toggle('linked', st === 'linked');
  if (st === 'linked') {
    b.textContent = `Ableton folder: ${folder.name} ✓`;
    b.title = `WAVs are kept in "${folder.name}/${CURRENT_DIR}". Click to change or unlink.`;
    if (detail) $('#status').textContent = `Linked folder ${detail}`;
  } else if (st === 'needs-permission') {
    b.textContent = `Reconnect ${folder.name}`;
    b.title = 'Chrome asks again after a restart before the page may write to your folder.';
  } else {
    b.textContent = 'Link Ableton folder';
    b.title = 'Write the current kit as WAVs into a folder you add to Ableton\'s browser';
  }
  const hint = $('#drag-hint');
  if (hint) hint.textContent = st === 'linked'
    ? `1–8 / Q–I to play · Space replays · Shift+Space plays all · drag from Ableton's browser: ${folder.name} › ${CURRENT_DIR}`
    : '1–8 / Q–I to play · Space replays · Shift+Space plays all · drag a pad out, or link an Ableton folder';
}

function folderHelp() {
  showNotice(`Linked "${folder.name}". The current kit is kept up to date in "${CURRENT_DIR}" and pads you save with ⬇ go to "${KEPT_DIR}". In Ableton Live, open the browser, click "Add Folder…" under Places and pick "${folder.name}" once; your stabs then appear there, ready to drag onto a track.`);
}

function folderMenu() {
  const b = $('#btn-folder');
  let m = $('#folder-menu');
  if (m) { m.remove(); return; }
  m = el('div', { id: 'folder-menu', class: 'menu', role: 'menu' },
    el('button', { role: 'menuitem', onclick: async () => { m.remove(); try { await folder.link(); folderHelp(); } catch { /* cancelled */ } } }, 'Choose a different folder'),
    el('button', { role: 'menuitem', onclick: () => { m.remove(); folderHelp(); } }, 'How to see it in Ableton'),
    el('button', { role: 'menuitem', onclick: async () => { m.remove(); await folder.unlink(); $('#notice')?.remove(); } }, 'Unlink folder'),
  );
  b.after(m);
}

$('#btn-folder').addEventListener('click', async () => {
  try {
    if (folder.state === 'linked') { folderMenu(); return; }
    if (folder.state === 'needs-permission') { await folder.reconnect(); return; }
    await folder.link();
    folderHelp();
  } catch (err) {
    if (err?.name !== 'AbortError') $('#status').textContent = `Couldn't link that folder (${err.message})`;
  }
});
document.addEventListener('click', (e) => {
  const m = $('#folder-menu');
  if (m && !e.target.closest('#folder-menu, #btn-folder')) m.remove();
});

const dragCache = new Map();
function prepareDrag(i) {
  const st = state.stabs[i];
  if (!st || !state.renders[st.uid]) return;
  const key = `${st.uid}|${state.audition}|${JSON.stringify(state.ex)}|${state.chops[st.uid] ?? ''}|${state.reversed[st.uid] ? 'r' : ''}`;
  if (dragCache.get(i)?.key === key) return;
  const w = padWav(i);
  if (!w) return;
  const old = dragCache.get(i); if (old) URL.revokeObjectURL(old.url);
  dragCache.set(i, { key, url: URL.createObjectURL(new Blob([w.data], { type: 'audio/wav' })), name: w.name });
}
function onDragStart(e, i) {
  prepareDrag(i);
  const d = dragCache.get(i);
  if (!d) { e.preventDefault(); return; }
  // Chrome/Edge: drop a real file onto the desktop or into a DAW.
  e.dataTransfer.setData('DownloadURL', `audio/wav:${d.name}:${d.url}`);
  e.dataTransfer.setData('text/uri-list', d.url);
  e.dataTransfer.effectAllowed = 'copy';
}

// Export every stab as individual WAV files.
// Chrome/Edge: write straight into a folder the user picks (with a stems/ subfolder).
// Other browsers: download the WAVs one after another.
$('#btn-export').addEventListener('click', async () => {
  if (inArtifact) { showNotice(NO_WAV_MSG); return; }
  const btn = $('#btn-export');
  let dir = null;
  if (window.showDirectoryPicker) {
    try {
      dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'stablab-export' });
    } catch (err) {
      if (err?.name === 'AbortError') return; // user cancelled the folder picker
      dir = null;
    }
  }
  btn.disabled = true;
  $('#status').textContent = 'Preparing export…';
  await allRendered();
  const kit = kitMeta();
  const folder = kitFolderName(kit);
  const files = [];
  state.stabs.forEach((st, i) => {
    const p = prepared(i);
    if (p) files.push(...stabFiles(p, padFileBase(i, kit), state.ex));
  });
  try {
    if (dir) {
      const kitDir = await dir.getDirectoryHandle(folder, { create: true });
      const manifest = {
        app: 'Stab Lab', version: 1, created: new Date().toISOString(),
        settings: state.settings, export: state.ex,
        stabs: state.stabs.map((s) => ({ index: s.index + 1, chord: s.chord.name, notes: s.chord.notes.map(noteName), tail: s.info?.tailLabel })),
      };
      files.push({ name: 'kit.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
      for (const [n, f] of files.entries()) {
        const parts = f.name.split('/');
        let d = kitDir;
        for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, { create: true });
        const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await w.write(f.data); await w.close();
        $('#status').textContent = `Writing ${n + 1}/${files.length}…`;
      }
      $('#status').textContent = `Saved ${state.stabs.length} stabs to ${folder}/`;
    } else {
      for (const [n, f] of files.entries()) {
        await downloadBlob(f.data, f.name.split('/').at(-1), 'audio/wav');
        $('#status').textContent = `Downloading ${n + 1}/${files.length}…`;
        await new Promise((r) => setTimeout(r, 250)); // browsers drop rapid-fire downloads
      }
      $('#status').textContent = `Downloaded ${files.length} WAV files`;
    }
  } catch (err) {
    $('#status').textContent = `Export failed (${err.message})`;
  }
  btn.disabled = false;
});

// Save / load kit files (settings + mutated/held pads + chops).
$('#btn-save').addEventListener('click', () => {
  const strip = (st) => { const { uid, ...rest } = st; return rest; };
  const data = {
    app: 'Stab Lab', version: 1, settings: state.settings, ex: state.ex,
    overrides: Object.fromEntries(Object.entries(state.overrides).map(([i, o]) => [i, { ...o, stab: strip(o.stab) }])),
    held: Object.fromEntries(Object.entries(state.held).map(([i, st]) => [i, strip(st)])),
    chops: Object.fromEntries(state.stabs.map((st, i) => [i, state.chops[st.uid]]).filter(([, v]) => v != null)),
    reversed: state.stabs.map((st, i) => (state.reversed[st.uid] ? i : -1)).filter((i) => i >= 0),
  };
  downloadBlob(JSON.stringify(data, null, 2), `${kitFolderName(kitMeta())}.json`, 'application/json');
});
$('#file-load').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    state.settings = { ...defaultKitSettings(), ...data.settings };
    state.ex = { ...defaultExportSettings(), ...data.ex };
    state.overrides = data.overrides ?? {};
    state.held = data.held ?? {};
    state.stabs = []; state.renders = {}; state.chops = {}; state.reversed = {};
    buildAll();
    regenerate({ immediate: true });
    for (const [i, v] of Object.entries(data.chops ?? {})) { const st = state.stabs[i]; if (st) state.chops[st.uid] = v; }
    for (const i of data.reversed ?? []) { const st = state.stabs[i]; if (st) state.reversed[st.uid] = true; }
    buildPads(); drawWave();
  } catch (err) {
    $('#status').textContent = `Could not load kit file (${err.message})`;
  }
  e.target.value = '';
});

// ---------------------------------------------------------------- boot
$('#btn-new').addEventListener('click', newKit);
$('#btn-reset-sound').addEventListener('click', () => loadPreset(state.settings.presetId));
$('#btn-trigger').addEventListener('click', () => play(state.selected));
$('#btn-play-all').addEventListener('click', () => playAll());
// Stop Space's keyup from activating whichever button has focus.
document.addEventListener('keyup', (e) => { if ((e.code === 'Space' || e.key === ' ') && !isTextField(e.target)) e.preventDefault(); });

function buildAll() {
  $('#preset-title').textContent = PRESET_BY_ID[state.settings.presetId]?.name ?? 'Character';
  buildKitPanel(); buildChordPanel(); buildLocks(); buildExportPanel(); buildMacros(); buildSoundPanel();
}

let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { drawAllPads(); drawWave(); }, 120); });

restore();
buildAll();
if (inArtifact) showNotice(NO_WAV_MSG);
renderFolderButton('off');
folder.init();
autoAudition = false;
regenerate({ immediate: true });
setTimeout(() => { autoAudition = true; }, 0);
