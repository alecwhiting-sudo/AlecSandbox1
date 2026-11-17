// Stab Lab — browser UI. All sound generation lives in src/dsp + src/engine;
// this file only wires controls, rendering, playback and export.

import { SCHEMA, MACROS, LOCK_GROUPS, getPath, setPath } from '../engine/patch.js';
import { PRESETS, PRESET_BY_ID, presetPatch } from '../engine/presets.js';
import { defaultKitSettings, generateKit, mutateStab, baseChordFor, CHORD_MODES, settingsKey } from '../engine/variation.js';
import { CHORD_TYPES, NOTE_NAMES, SCALES, noteName } from '../music/theory.js';
import { randomChord, mutateChord, VOICINGS, PROGRESSIONS } from '../music/chords.js';
import { defaultExportSettings, prepareStab, normaliseGains, stabFiles, stabFileBase, kitFolderName, encodeWav, makeZip, finalLength } from '../engine/export.js';
import { Rng } from '../dsp/rng.js';
import { renderStab } from '../dsp/render.js';

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
    for (const uid of Object.keys(state.renders)) if (!live.has(Number(uid))) { delete state.renders[uid]; delete state.chops[uid]; }
    state.stabs = stabs;
    if (state.selected >= stabs.length) state.selected = 0;
    if (audition && autoAudition) autoPlayUid = stabs[state.selected]?.uid ?? null;
    buildPads();
    scheduleRender();
    drawWave();
    updateChordDisplay();
    persist();
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
  input.addEventListener('input', () => {
    const v = fromSlider(input.value);
    val.textContent = fmt(v, unit, step);
    onChange(v);
  });
  return el('div', { class: `ctl ${cls}` }, el('label', {}, el('span', {}, label), val), input);
}

// Rotary knob for macros.
function knob({ label, hint }, value, onChange) {
  const R = 24, C = 32, START = 135, SWEEP = 270;
  const polar = (deg, r) => [C + r * Math.cos((deg * Math.PI) / 180), C + r * Math.sin((deg * Math.PI) / 180)];
  const arcPath = (a0, a1, r) => {
    const [x0, y0] = polar(a0, r), [x1, y1] = polar(a1, r);
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
  mk('path', { d: arcPath(START, START + SWEEP, R), class: 'track', fill: 'none', 'stroke-width': 5, 'stroke-linecap': 'round' });
  const arc = mk('path', { class: 'arc', fill: 'none', 'stroke-width': 5, 'stroke-linecap': 'round' });
  const dot = mk('circle', { r: 3.2, class: 'dot' });
  const valEl = el('span', { class: 'k-val' });
  let v = value;
  const draw = () => {
    const a = START + SWEEP * v;
    arc.setAttribute('d', v > 0.003 ? arcPath(START, a, R) : '');
    const [x, y] = polar(a, R - 9);
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);
    const pct = Math.round((v - 0.5) * 200);
    valEl.textContent = pct === 0 ? '·' : (pct > 0 ? '+' : '') + pct;
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
  );
}

function loadPreset(id) {
  const s = state.settings;
  s.presetId = id;
  s.basePatch = null;
  const pr = PRESET_BY_ID[id];
  if (pr?.chord && !s.customNotes) Object.assign(s.chord, pr.chord);
  $('#preset-title').textContent = pr?.name ?? 'Character';
  buildKitPanel(); buildChordPanel(); buildSoundPanel();
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
        s.customNotes = c.notes; chordChanged(true);
      } }, 'Random chord'),
      el('button', { class: 'btn small', onclick: () => {
        const r = new Rng(Date.now());
        const c = mutateChord(r, baseChordFor(s), { strength: Math.max(0.3, s.mutation), dissonance: s.dissonance, key: s.key, scale: s.scale });
        s.customNotes = c.notes; chordChanged(true);
      } }, 'Mutate chord'),
      s.customNotes ? el('button', { class: 'btn small', onclick: () => { s.customNotes = null; chordChanged(true); } }, 'Back to builder') : null,
    ),
    builder,
    el('div', { class: 'ctl wide', style: 'margin-top:10px' }, el('span', { class: 'lbl' }, 'Notes — click keys to build any chord, however crazy'), keyboard(base.notes)),
    el('div', { class: 'grid2', style: 'margin-top:10px' },
      modeSel, prog,
      rangeInput({ label: 'Dissonance', min: 0, max: 1, step: 0.01 }, s.dissonance, (v) => { s.dissonance = v; regenerate(); }),
      rangeInput({ label: 'Mutation', min: 0, max: 1, step: 0.01 }, s.mutation, (v) => { s.mutation = v; regenerate(); }),
    ),
  );
}

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
    if (rerender) invalidateAll(); else { drawAllPads(); drawWave(); }
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
  root.replaceChildren(...MACROS.map((m) => knob(m, state.settings.macros[m.id], (v) => {
    state.settings.macros[m.id] = v; regenerate({ audition: true });
  })));
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
      class: `pad${i === state.selected ? ' sel' : ''}`, tabindex: '0', draggable: 'true', 'data-i': i,
      role: 'button', 'aria-label': `Stab ${i + 1}: ${st.chord.name}`,
    },
    el('div', { class: 'p-top' }, el('span', { class: 'p-chord', title: st.chord.notes.map(noteName).join(' ') }, st.chord.name), el('span', { class: 'p-num' }, PAD_KEYS[i]?.toUpperCase() ?? '')),
    canvas,
    el('div', { class: 'p-top' }, el('span', { class: 'p-tail' }, `${st.info?.tailLabel ?? ''} tail`), el('span', { class: 'p-num', 'data-len': '' }, '')),
    el('div', { class: 'p-meta' }, st.info?.borrowed ? `+ ${st.info.borrowed.groups.join(', ')} from ${st.info.borrowed.from}` : st.info?.mutated ? `mutated ×${st.info.mutated}` : ''),
    el('div', { class: 'p-actions' },
      el('button', { title: 'Re-roll this pad', onclick: (e) => { e.stopPropagation(); rerollPad(i); } }, '↻'),
      el('button', { title: 'Mutate: small change to chord and tone', onclick: (e) => { e.stopPropagation(); mutatePad(i); } }, '✦'),
      el('button', { class: held ? 'on' : '', title: 'Hold: keep this pad when making a new kit', onclick: (e) => { e.stopPropagation(); holdPad(i); } }, held ? '●' : '○'),
      el('button', { title: 'Download WAV', onclick: (e) => { e.stopPropagation(); downloadPad(i); } }, '⬇'),
    ));
    pad.addEventListener('click', () => { select(i); play(i); });
    pad.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(i); play(i); } });
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
  return prepareStab(r, state.ex, state.settings.bpm, padGain(i), state.chops[st.uid] ?? null);
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
  if (!r) { $('#wave-info').textContent = st ? 'rendering…' : ''; return; }
  const full = prepareStab(r, state.ex, state.settings.bpm, padGain(state.selected), null);
  const chop = state.chops[st.uid];
  const span = full.length;
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
  const len = chop ?? full.length;
  const chs = st.chord.notes.map(noteName).join(' ');
  $('#wave-info').textContent = `${chs} · ${(len / r.sr).toFixed(2)} s${chop != null ? ' (chopped)' : ''} · ${(len / beat).toFixed(1)} beats`;
}

$('#wave').addEventListener('click', (e) => {
  const st = state.stabs[state.selected];
  const r = st && state.renders[st.uid];
  if (!r) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const full = finalLength(r, state.ex, state.settings.bpm);
  let pos = Math.round(((e.clientX - rect.left) / rect.width) * full);
  // Snap to the beat grid when close.
  const beat = (60 / state.settings.bpm) * r.sr;
  const nearest = Math.round(pos / beat) * beat;
  if (Math.abs(nearest - pos) < beat * 0.08) pos = nearest;
  state.chops[st.uid] = Math.max(Math.round(r.sr * 0.02), pos);
  drawWave(); drawPad(state.selected); play(state.selected);
});
$('#btn-unchop').addEventListener('click', () => {
  const st = state.stabs[state.selected];
  if (st) delete state.chops[st.uid];
  drawWave(); drawPad(state.selected);
});

// ---------------------------------------------------------------- playback
let actx = null;
let current = null;
let autoAudition = true;
function play(i) {
  const p = prepared(i);
  if (!p) return;
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume();
  const chs = state.audition === 'dry' ? p.dry : state.audition === 'wet' ? p.wet : p.mix;
  const buf = actx.createBuffer(2, p.length, p.sr);
  buf.copyToChannel(chs[0], 0); buf.copyToChannel(chs[1], 1);
  if (current) { try { current.g.gain.setTargetAtTime(0, actx.currentTime, 0.01); current.s.stop(actx.currentTime + 0.05); } catch { /* already stopped */ } }
  const s = actx.createBufferSource(); s.buffer = buf;
  const g = actx.createGain(); s.connect(g).connect(actx.destination);
  s.start();
  current = { s, g };
  const pad = document.querySelector(`.pad[data-i="${i}"]`);
  if (pad) { pad.classList.add('flash'); setTimeout(() => pad.classList.remove('flash'), 90); }
}

document.querySelectorAll('#audition button').forEach((b) => b.addEventListener('click', () => {
  state.audition = b.dataset.v;
  document.querySelectorAll('#audition button').forEach((x) => x.classList.toggle('on', x === b));
  drawAllPads(); drawWave();
}));

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  const i = PAD_KEYS.indexOf(k);
  if (i >= 0 && i < state.stabs.length) { select(i); play(i); return; }
  if (k === 'n') newKit();
});

// ---------------------------------------------------------------- export
const kitMeta = () => ({ ...state.settings, presetName: PRESET_BY_ID[state.settings.presetId]?.name ?? 'stab' });

function downloadBlob(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function padWav(i) {
  const p = prepared(i);
  if (!p) return null;
  const chs = state.audition === 'dry' ? p.dry : state.audition === 'wet' ? p.wet : p.mix;
  const suffix = state.audition === 'dry' ? '_dry' : state.audition === 'wet' ? '_tail' : '';
  return { data: encodeWav(chs, p.sr, state.ex.bitDepth), name: `${stabFileBase(state.stabs[i], kitMeta())}${suffix}.wav` };
}

function downloadPad(i) {
  const w = padWav(i);
  if (w) downloadBlob(w.data, w.name, 'audio/wav');
}

const dragCache = new Map();
function prepareDrag(i) {
  const st = state.stabs[i];
  if (!st || !state.renders[st.uid]) return;
  const key = `${st.uid}|${state.audition}|${JSON.stringify(state.ex)}|${state.chops[st.uid] ?? ''}`;
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

$('#btn-export').addEventListener('click', async () => {
  const btn = $('#btn-export');
  btn.disabled = true;
  $('#status').textContent = 'Preparing export…';
  await allRendered();
  const kit = kitMeta();
  const folder = kitFolderName(kit);
  const files = [];
  state.stabs.forEach((st, i) => {
    const p = prepared(i);
    if (!p) return;
    for (const f of stabFiles(p, stabFileBase(st, kit), state.ex)) files.push({ name: `${folder}/${f.name}`, data: f.data });
  });
  const manifest = {
    app: 'Stab Lab', version: 1, created: new Date().toISOString(),
    settings: state.settings, export: state.ex,
    stabs: state.stabs.map((s) => ({ index: s.index + 1, chord: s.chord.name, notes: s.chord.notes.map(noteName), tail: s.info?.tailLabel })),
  };
  files.push({ name: `${folder}/kit.json`, data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
  downloadBlob(makeZip(files), `${folder}.zip`, 'application/zip');
  btn.disabled = false;
  $('#status').textContent = `Exported ${state.stabs.length} stabs`;
});

// Save / load kit files (settings + mutated/held pads + chops).
$('#btn-save').addEventListener('click', () => {
  const strip = (st) => { const { uid, ...rest } = st; return rest; };
  const data = {
    app: 'Stab Lab', version: 1, settings: state.settings, ex: state.ex,
    overrides: Object.fromEntries(Object.entries(state.overrides).map(([i, o]) => [i, { ...o, stab: strip(o.stab) }])),
    held: Object.fromEntries(Object.entries(state.held).map(([i, st]) => [i, strip(st)])),
    chops: Object.fromEntries(state.stabs.map((st, i) => [i, state.chops[st.uid]]).filter(([, v]) => v != null)),
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
    state.stabs = []; state.renders = {}; state.chops = {};
    buildAll();
    regenerate({ immediate: true });
    for (const [i, v] of Object.entries(data.chops ?? {})) { const st = state.stabs[i]; if (st) state.chops[st.uid] = v; }
  } catch (err) {
    $('#status').textContent = `Could not load kit file (${err.message})`;
  }
  e.target.value = '';
});

// ---------------------------------------------------------------- boot
$('#btn-new').addEventListener('click', newKit);
$('#btn-reset-sound').addEventListener('click', () => loadPreset(state.settings.presetId));

function buildAll() {
  $('#preset-title').textContent = PRESET_BY_ID[state.settings.presetId]?.name ?? 'Character';
  buildKitPanel(); buildChordPanel(); buildLocks(); buildExportPanel(); buildMacros(); buildSoundPanel();
}

let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { drawAllPads(); drawWave(); }, 120); });

restore();
buildAll();
autoAudition = false;
regenerate({ immediate: true });
setTimeout(() => { autoAudition = true; }, 0);
