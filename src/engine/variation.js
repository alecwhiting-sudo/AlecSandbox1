// Kit generation: one base sound -> a family of related stabs with subtle
// tone/timbre variation, different chords and different tail lengths.

import { Rng } from '../dsp/rng.js';
import { clamp, DIVISIONS } from '../dsp/util.js';
import { clone, applyMacros, applyLocks, LOCK_GROUPS, defaultMacros, MACROS } from './patch.js';
import { PRESET_BY_ID, presetPatch, presetsNear } from './presets.js';
import { buildChord, diatonicChord, randomChord, mutateChord, PROGRESSIONS } from '../music/chords.js';
import { detectChord, NOTE_NAMES } from '../music/theory.js';

export const CHORD_MODES = {
  fixed: 'Same chord (timbre variations only)',
  progression: 'Progression in key',
  random: 'Random chords',
  mutate: 'Mutate chain',
};

export function defaultKitSettings() {
  return {
    presetId: 'dub-chord',
    size: 8,
    key: 9, // A
    scale: 'minor',
    bpm: 124,
    seed: 'stab-1',
    chordMode: 'mutate',
    chord: { root: 9, type: 'min7', inversion: 0, voicing: 'open', centre: 60, bass: false, top: false },
    customNotes: null,
    progression: 'i-VI-III-VII',
    dissonance: 0.25,
    mutation: 0.4,
    variation: 0.35,
    familySpread: 0.15,
    tailSpread: 0.6,
    delaySpread: 0.6,
    macroVariation: 0.3, // per-pad random nudge on every macro knob (0 = identical)
    octave: 0,       // shift every pad by whole octaves (-2..+2)
    octaveRange: 0,  // 0 = same octave, 1 or 2 = pads spread up/down by that many octaves
    keyChange: 'off', // a KEY_CHANGES id: modulate as the kit goes on
    keyEvery: 4,      // pads per key section
    macros: defaultMacros(),
    locks: { chord: false, osc: false, filter: false, env: false, colour: false, space: false },
    basePatch: null, // edited patch; null = use preset
    stabSeeds: {},   // per-stab re-roll counters
  };
}

function rawPatchFor(settings) {
  return settings.basePatch ? clone(settings.basePatch) : presetPatch(settings.presetId);
}

export function basePatchFor(settings) {
  return applyMacros(rawPatchFor(settings), settings.macros ?? defaultMacros());
}

// How strongly each macro wanders per pad, relative to the others.
// Brightness gets a little extra: it's the one you hear first.
const MACRO_JITTER_WEIGHT = { bright: 1.2, bite: 1, body: 0.8, move: 1, grit: 0.8, space: 0.9, width: 0.7 };

/**
 * Per-pad macro values: the kit's knobs plus a seeded random nudge whose size
 * is set by settings.macroVariation (0..1; 1 = about ±0.18 knob travel, 1 sd).
 */
export function padMacros(settings, rng) {
  const m = settings.macros ?? defaultMacros();
  const amt = clamp(settings.macroVariation ?? 0, 0, 1);
  const out = {};
  for (const { id } of MACROS) {
    const base = m[id] ?? 0.5;
    out[id] = amt > 0 ? clamp(base + rng.gauss() * amt * 0.18 * (MACRO_JITTER_WEIGHT[id] ?? 1), 0, 1) : base;
  }
  return out;
}

export function baseChordFor(settings) {
  if (settings.customNotes && settings.customNotes.length) {
    const notes = [...settings.customNotes].sort((a, b) => a - b);
    return { notes, name: detectChord(notes) };
  }
  return buildChord(settings.chord);
}

const vmul = (rng, amt, oct) => Math.pow(2, rng.gauss() * amt * oct * 0.6);

/** Humanise a patch. amount 0..1. Locked groups are left untouched. */
export function varyPatch(patch, rng, amount, locks = {}) {
  const v = clamp(amount, 0, 1);
  if (v === 0) return clone(patch);
  const p = clone(patch);
  if (!locks.osc) {
    for (const o of p.osc) {
      o.fine = clamp(o.fine + rng.bipolar() * v * 8, -50, 50);
      o.detune = clamp(o.detune * vmul(rng, v, 0.5), 0, 100);
      o.pw = clamp(o.pw + rng.bipolar() * v * 0.15, 0.05, 0.95);
      if (o.type === 'morph') o.shape = clamp((o.shape ?? 0.5) + rng.bipolar() * v * 0.12, 0, 1);
      o.fmIndex = clamp(o.fmIndex * vmul(rng, v, 0.6), 0, 12);
      o.fmDecay = clamp(o.fmDecay * vmul(rng, v, 0.6), 0.005, 2);
      o.pd = clamp(o.pd + rng.bipolar() * v * 0.2, 0, 1);
      if (o.type === 'fm' && rng.chance((v - 0.6) * 0.5)) o.fmRatio = rng.pick([0.5, 1, 1.5, 2, 3, 3.5, 4, 5, 7]);
      o.level = clamp(o.level * vmul(rng, v, 0.25), 0, 1);
    }
    p.drift = clamp(p.drift * vmul(rng, v, 0.7), 0, 60);
    p.noise.level = clamp(p.noise.level * vmul(rng, v, 0.6), 0, 1);
    p.sub.level = clamp(p.sub.level + rng.bipolar() * v * 0.1, 0, 1);
  }
  if (!locks.filter) {
    const a = p.filterA;
    a.cutoff = clamp(a.cutoff * vmul(rng, v, 1), 30, 18000);
    a.res = clamp(a.res + rng.bipolar() * v * 0.15, 0, 0.97);
    a.env = clamp(a.env + rng.bipolar() * v * 1.0, -6, 8);
    a.follow = clamp(a.follow + rng.bipolar() * v * 0.6, -4, 5);
    a.drive = clamp(a.drive + rng.bipolar() * v * 0.15, 0, 1);
    // Occasionally swap to a sibling low-pass for a different flavour.
    const lps = ['ladder', 'svf-lp24', 'svf-lp12', 'diode'];
    if (lps.includes(a.type) && rng.chance((v - 0.65) * 0.6)) a.type = rng.pick(lps);
    p.filterB.cutoff = clamp(p.filterB.cutoff * vmul(rng, v, 0.5), 20, 18000);
    p.follower.release = clamp(p.follower.release * vmul(rng, v, 0.6), 0.01, 3);
  }
  if (!locks.env) {
    p.amp.a = clamp(p.amp.a * vmul(rng, v, 0.9), 0.0003, 2);
    p.amp.d = clamp(p.amp.d * vmul(rng, v, 0.6), 0.005, 6);
    p.amp.r = clamp(p.amp.r * vmul(rng, v, 0.6), 0.005, 6);
    p.amp.s = clamp(p.amp.s + rng.bipolar() * v * 0.1, 0, 1);
    p.fenv.d = clamp(p.fenv.d * vmul(rng, v, 0.7), 0.005, 6);
    p.gate = clamp(p.gate * vmul(rng, v, 0.6), 0.05, 8);
    p.velocity = clamp(p.velocity + rng.bipolar() * v * 0.2, 0.2, 1);
    p.pitchEnv.amount = clamp(p.pitchEnv.amount + rng.bipolar() * v * 0.3, -24, 24);
    // Only vary a strum you've set; at zero it stays zero. (Same random draws as
    // before, so kits made from a seed keep their other values.)
    if (rng.chance(v * 0.3)) { const k = rng.range(0.6, 1.4); if (p.strum > 0) p.strum = clamp(p.strum * k, 0, 0.12); }
  }
  if (!locks.colour) {
    p.colour.drive = clamp(p.colour.drive + rng.bipolar() * v * 0.2, 0, 1);
    p.chorus.rate = clamp(p.chorus.rate + rng.bipolar() * v * 0.2, 0, 1);
    p.eq.tilt = clamp(p.eq.tilt + rng.bipolar() * v * 0.15, -1, 1);
    p.voiceSpread = clamp(p.voiceSpread + rng.bipolar() * v * 0.3, 0, 1);
    if (p.comp) p.comp.amount = clamp(p.comp.amount + rng.bipolar() * v * 0.1, 0, 1);
    if (p.texture) {
      p.texture.density = clamp(p.texture.density + rng.bipolar() * v * 0.2, 0, 1);
      p.texture.tone = clamp(p.texture.tone + rng.bipolar() * v * 0.2, 0, 1);
      if (p.texture.crackle > 0) p.texture.crackle = clamp(p.texture.crackle * vmul(rng, v, 0.5), 0, 1);
    }
  }
  if (!locks.space) {
    p.reverb.decay = clamp(p.reverb.decay * vmul(rng, v, 0.4), 0.2, 20);
    p.reverb.damping = clamp(p.reverb.damping + rng.bipolar() * v * 0.15, 0, 1);
    p.delay.feedback = clamp(p.delay.feedback + rng.bipolar() * v * 0.1, 0, 0.92);
    p.delay.grit = clamp((p.delay.grit ?? 0.4) + rng.bipolar() * v * 0.15, 0, 1);
    // Delay times are spread across the kit by delayPlan(), not here.
  }
  return p;
}

/** Scale the tail: f 0 = bone dry, 0.5 = as patched, 1 = long and washy. */
export function applyTail(patch, f) {
  const p = clone(patch);
  const x = (clamp(f, 0, 1) - 0.5) * 2; // -1..1
  if (f < 0.1) { p.delay.send = 0; p.reverb.send = 0; return p; }
  const sendMul = Math.pow(2, x * 1.6);
  p.delay.send = clamp(p.delay.send * sendMul, 0, 1);
  p.reverb.send = clamp(p.reverb.send * sendMul, 0, 1);
  p.reverb.decay = clamp(p.reverb.decay * Math.pow(2, x * 1.3), 0.2, 20);
  p.delay.feedback = clamp(p.delay.feedback + x * 0.18, 0, 0.9);
  return p;
}

/** Borrow one or two sound groups from a neighbouring preset. */
function borrowFamily(patch, rng, settings, spread) {
  const base = PRESET_BY_ID[settings.presetId];
  if (!base || spread <= 0 || !rng.chance(spread * 0.7)) return { patch, borrowed: null };
  const near = presetsNear(base.analog, 0.1 + spread * 0.5).filter((p) => p.id !== base.id);
  if (!near.length) return { patch, borrowed: null };
  const donor = rng.pick(near);
  const donorPatch = applyMacros(presetPatch(donor.id), settings.macros ?? defaultMacros());
  const groups = ['osc', 'filter', 'colour', 'env'].filter((g) => !settings.locks?.[g]);
  if (!groups.length) return { patch, borrowed: null };
  const take = rng.shuffle(groups).slice(0, spread > 0.6 ? 2 : 1);
  const locks = Object.fromEntries(take.map((g) => [g, true]));
  return { patch: applyLocks(patch, donorPatch, locks), borrowed: { from: donor.name, groups: take.map((g) => LOCK_GROUPS[g].label) } };
}

function stabSeed(settings, i) {
  return `${settings.seed}|${i}|${settings.stabSeeds?.[i] ?? 0}`;
}

function chordFor(settings, i, rng, prevChord) {
  const base = baseChordFor(settings);
  if (settings.locks?.chord || settings.chordMode === 'fixed') return base;
  switch (settings.chordMode) {
    case 'progression': {
      const degs = PROGRESSIONS[settings.progression] ?? PROGRESSIONS['i-VI-III-VII'];
      const deg = degs[i % degs.length];
      const size = rng.chance(0.3 + settings.dissonance * 0.4) ? 5 : 4;
      let c = diatonicChord(settings.key, settings.scale, deg, size, (settings.chord?.centre ?? 60));
      if (settings.mutation > 0 && rng.chance(settings.mutation * 0.5)) {
        c = mutateChord(rng, c, { strength: settings.mutation * 0.5, dissonance: settings.dissonance, key: settings.key, scale: settings.scale });
      }
      return c;
    }
    case 'random':
      return randomChord(rng, { key: settings.key, scale: settings.scale, dissonance: settings.dissonance, centre: settings.chord?.centre ?? 60 });
    case 'mutate':
    default:
      if (i === 0) return base;
      return mutateChord(rng, prevChord ?? base, { strength: settings.mutation, dissonance: settings.dissonance, key: settings.key, scale: settings.scale });
  }
}

/** Tail amounts for each pad: evenly spread from dry to long, then shuffled. */
function tailPlan(settings) {
  const n = settings.size;
  const rng = new Rng(`${settings.seed}|tails`);
  const u = Array.from({ length: n }, (_, i) => (n === 1 ? 0.5 : i / (n - 1)));
  const order = rng.shuffle(u);
  const s = clamp(settings.tailSpread ?? 0, 0, 1);
  return order.map((x) => 0.5 + (x - 0.5) * s);
}

// Tempo-synced delay times from short to long.
export const DELAY_LADDER = ['1/16', '1/8t', '1/16d', '1/8', '1/4t', '1/8d', '1/4', '1/4d', '1/2'];

/**
 * Delay division per pad. spread 0 = every pad uses the base time; higher
 * spreads widen the window of times around it (up to the whole ladder) and
 * deal them out so neighbouring pads differ. All times are in beats, so they
 * follow the kit's BPM.
 */
export function delayPlan(settings, baseDivision) {
  const n = settings.size;
  const s = clamp(settings.delaySpread ?? 0, 0, 1);
  if (s === 0) return Array(n).fill(baseDivision);
  const rng = new Rng(`${settings.seed}|delays`);
  let centre = DELAY_LADDER.indexOf(baseDivision);
  if (centre < 0) centre = 5;
  const reach = Math.round(1 + s * 4); // 2..5 steps either side
  const lo = Math.max(0, centre - reach), hi = Math.min(DELAY_LADDER.length - 1, centre + reach);
  const window = DELAY_LADDER.slice(lo, hi + 1);
  // Base time appears most often; the rest are shuffled in.
  const deck = [];
  while (deck.length < n) deck.push(...rng.shuffle(window), baseDivision);
  return rng.shuffle(deck.slice(0, n)).map((d) => d);
}

/**
 * Generate kit descriptors (no audio). Each stab has { index, seed, chord, patch, tail, info }.
 * Pass `previous` (the current kit) to keep chords of earlier stabs when re-rolling one pad.
 */
export function generateKit(settings, previous = null) {
  const base = basePatchFor(settings);
  const tails = tailPlan(settings);
  const delays = delayPlan(settings, base.delay.division);
  const keyOffsets = keyPlan(settings);
  const stabs = [];
  let prevChord = null;
  for (let i = 0; i < settings.size; i++) {
    const seed = stabSeed(settings, i);
    const rng = new Rng(seed);
    const prevStab = previous?.[i];
    const unchanged = prevStab && prevStab.seed === seed && prevStab.settingsKey === settingsKey(settings);
    if (unchanged) { stabs.push(prevStab); prevChord = prevStab.chord; continue; }
    const baseChord = chordFor(settings, i, rng.fork('chord'), prevChord);
    prevChord = baseChord; // mutate chains continue from the unshifted chord
    const keyed = transposeChord(baseChord, keyOffsets[i]);
    const { chord, octaveShift } = placeOctave(keyed, settings, rng.fork('octave'));
    // Each pad's own take on the macro knobs; locked groups keep the kit's values.
    let padBase = base, macros = settings.macros ?? defaultMacros();
    if ((settings.macroVariation ?? 0) > 0) {
      macros = padMacros(settings, rng.fork('macros'));
      padBase = applyLocks(applyMacros(rawPatchFor(settings), macros), base, settings.locks);
    }
    const { patch: fam, borrowed } = borrowFamily(padBase, rng.fork('family'), settings, settings.familySpread ?? 0);
    let patch = varyPatch(fam, rng.fork('vary'), settings.variation ?? 0, settings.locks);
    if (!settings.locks?.space) {
      patch = applyTail(patch, tails[i]);
      const s = clamp(settings.delaySpread ?? 0, 0, 1);
      if (s > 0) {
        const dr = rng.fork('delay');
        // A re-rolled pad draws a fresh time instead of its slot in the plan.
        patch.delay.division = (settings.stabSeeds?.[i] ?? 0) > 0
          ? dr.pick(DELAY_LADDER.slice(Math.max(0, DELAY_LADDER.indexOf(base.delay.division) - 3), DELAY_LADDER.indexOf(base.delay.division) + 4))
          : delays[i];
        // Polyrhythmic stereo echoes: a different time on the right.
        if (patch.delay.mode === 'stereo' && dr.chance(s * 0.5)) {
          const k = DELAY_LADDER.indexOf(patch.delay.division);
          patch.delay.divisionR = DELAY_LADDER[Math.min(DELAY_LADDER.length - 1, Math.max(0, k + dr.pick([-2, -1, 1, 2])))];
        } else delete patch.delay.divisionR;
      }
    }
    // Occasional dub throw on long-tail pads.
    if (!settings.locks?.space && tails[i] > 0.8 && rng.chance(0.35)) patch.delay.feedback = Math.max(patch.delay.feedback, 0.72);
    stabs.push({
      index: i, seed, chord, patch, tail: tails[i],
      renderSeed: rng.int(1, 2 ** 31 - 1),
      info: { borrowed, macros, tailLabel: tailLabel(tails[i]), delay: delayLabel(patch), octaveShift, key: keyOffsets[i] !== 0 || settings.keyChange !== 'off' ? keyName(settings, keyOffsets[i]) : '' },
      settingsKey: settingsKey(settings),
    });
  }
  return stabs;
}

/** Mutate one existing stab: nudge its chord and its sound a little. */
export function mutateStab(stab, settings, salt) {
  const rng = new Rng(`${stab.seed}|mut|${salt}`);
  const chord = settings.locks?.chord ? stab.chord
    : mutateChord(rng.fork('c'), stab.chord, { strength: Math.max(0.25, settings.mutation), dissonance: settings.dissonance, key: settings.key, scale: settings.scale });
  const patch = varyPatch(stab.patch, rng.fork('p'), Math.max(0.15, (settings.variation ?? 0.3) * 0.6), settings.locks);
  return { ...stab, chord, patch, seed: `${stab.seed}~${salt}`, renderSeed: rng.int(1, 2 ** 31 - 1), info: { ...stab.info, mutated: (stab.info?.mutated ?? 0) + 1 } };
}

// Key changes: each step is the interval (semitones) to the next key section.
export const KEY_CHANGES = {
  off: { label: 'Off (one key)', steps: [] },
  'up-semitone': { label: 'Up a semitone (lift)', steps: [1] },
  'up-tone': { label: 'Up a whole tone', steps: [2] },
  fifths: { label: 'Circle of fifths', steps: [7] },
  fourths: { label: 'Circle of fourths', steps: [5] },
  'down-minor-third': { label: 'Down a minor third (dub)', steps: [-3] },
  'up-minor-third': { label: 'Up a minor third (house)', steps: [3] },
  mediants: { label: 'Chromatic mediants (cinematic)', steps: [4, -4] },
  'there-and-back': { label: 'Up a fourth and home again', steps: [5, -5] },
  random: { label: 'Random nice changes', steps: null },
};
const NICE_STEPS = [1, 2, 3, -3, 4, -4, 5, -5, 7, -2];

/**
 * Semitone offset from the kit's key for each pad. Pads are grouped in
 * sections of keyEvery; each new section moves by the next step. Offsets are
 * folded into -5..+6 so the kit doesn't climb out of register.
 */
export function keyPlan(settings) {
  const n = settings.size;
  const kc = KEY_CHANGES[settings.keyChange] ?? KEY_CHANGES.off;
  if (!kc.steps || kc.steps.length) {
    const every = Math.max(1, Math.round(settings.keyEvery ?? 4));
    const rng = new Rng(`${settings.seed}|keys`);
    const out = [];
    let offset = 0, section = 0;
    for (let i = 0; i < n; i++) {
      const s = Math.floor(i / every);
      while (section < s) {
        const step = kc.steps ? kc.steps[section % kc.steps.length] : rng.pick(NICE_STEPS);
        offset += step;
        section++;
      }
      let f = ((offset % 12) + 12) % 12;
      if (f > 6) f -= 12;
      out.push(f);
    }
    return out;
  }
  return Array(n).fill(0);
}

export function keyName(settings, offset) {
  const pc = (((settings.key ?? 0) + offset) % 12 + 12) % 12;
  const minorish = /minor|dorian|phrygian/.test(settings.scale ?? 'minor');
  return NOTE_NAMES[pc] + (minorish ? 'm' : '');
}

function transposeChord(chord, semis) {
  if (!semis) return chord;
  const notes = chord.notes.map((n) => n + semis);
  return { notes, name: detectChord(notes) };
}

/**
 * Move a chord by the kit's Octave setting plus a per-pad random shift within
 * Octave spread, kept inside a playable range (C1..C7).
 */
export function placeOctave(chord, settings, rng) {
  const range = Math.max(0, Math.min(2, Math.round(settings.octaveRange ?? 0)));
  let oct = Math.round(settings.octave ?? 0) + (range > 0 ? rng.int(-range, range) : 0);
  const lo = Math.min(...chord.notes), hi = Math.max(...chord.notes);
  while (hi + oct * 12 > 96 && oct > -4) oct--;
  while (lo + oct * 12 < 24 && oct < 4) oct++;
  if (oct === 0) return { chord, octaveShift: 0 };
  return { chord: { notes: chord.notes.map((n) => n + oct * 12), name: chord.name }, octaveShift: oct };
}

function delayLabel(p) {
  if (!(p.delay?.send > 0)) return '';
  return p.delay.divisionR ? `${p.delay.division}+${p.delay.divisionR}` : p.delay.division;
}

function tailLabel(f) {
  if (f < 0.1) return 'dry';
  if (f < 0.35) return 'short';
  if (f < 0.65) return 'medium';
  if (f < 0.85) return 'long';
  return 'huge';
}

// Everything that affects stab generation except per-stab seeds.
export function settingsKey(s) {
  const { stabSeeds, ...rest } = s;
  return JSON.stringify(rest);
}

export { DIVISIONS };
