import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectNotes, toMono } from '../src/music/detect.js';
import { renderStab } from '../src/dsp/render.js';
import { presetPatch } from '../src/engine/presets.js';
import { applyTail } from '../src/engine/variation.js';

const SR = 44100;
const pcs = (notes) => [...new Set(notes.map((n) => n % 12))].sort((a, b) => a - b);

function sines(notes, secs = 0.6) {
  const n = Math.round(SR * secs);
  const x = new Float32Array(n);
  for (const m of notes) {
    const f = 440 * Math.pow(2, (m - 69) / 12);
    for (let i = 0; i < n; i++) x[i] += Math.sin((2 * Math.PI * f * i) / SR) * Math.exp(-i / (SR * 0.5)) * 0.2;
  }
  return x;
}

test('detects a sine chord exactly', () => {
  const r = detectNotes(sines([57, 60, 64, 67]), SR);
  assert.deepEqual(r.notes, [57, 60, 64, 67]);
  assert.equal(r.name, 'Am7');
});

// Real stabs from our own engine: the pitch classes should match closely.
const CASES = [
  ['chicago-organ', [57, 60, 64, 67]],
  ['poly-pluck', [55, 59, 62, 66]],
  ['dub-chord', [53, 57, 60, 64]],
  ['brass-stab', [55, 59, 62]],
  ['cz-reso', [48, 51, 55, 58]],
];
for (const [preset, chord] of CASES) {
  test(`recovers the notes of a ${preset} stab`, () => {
    const p = applyTail(presetPatch(preset), 0); // dry
    p.drift = 0;
    const r = renderStab(p, chord, { sr: SR, seed: 3, maxTail: 1 });
    const got = detectNotes(toMono(r.dry), SR);
    const want = pcs(chord);
    const hit = want.filter((pc) => pcs(got.notes).includes(pc)).length;
    const extra = pcs(got.notes).filter((pc) => !want.includes(pc)).length;
    assert.ok(hit >= want.length - 1, `${preset}: wanted ${want} got ${pcs(got.notes)} (${got.name})`);
    assert.ok(extra <= 1, `${preset}: extra notes ${pcs(got.notes)} (${got.name})`);
  });
}

test('bells are approximate: chord tones are still found', () => {
  const p = applyTail(presetPatch('fm-bell'), 0);
  const chord = [60, 64, 67, 71];
  const r = renderStab(p, chord, { sr: SR, seed: 3, maxTail: 1 });
  const got = pcs(detectNotes(toMono(r.dry), SR).notes);
  assert.ok(pcs(chord).filter((pc) => got.includes(pc)).length >= 3, `got ${got}`);
});

test('organ with sub-octave drawbar and tails: octave copies do not crowd out chord tones', () => {
  const chord = [50, 53, 57, 60]; // Dm7
  const r = renderStab(presetPatch('chicago-organ'), chord, { sr: SR, seed: 9, maxTail: 2 });
  const mix = [0, 1].map((c) => r.dry[c].map((v, i) => v + r.wet[c][i]));
  assert.deepEqual(pcs(detectNotes(toMono(mix), SR).notes), pcs(chord));
});
