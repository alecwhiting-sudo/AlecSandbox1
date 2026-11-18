import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Compressor } from '../src/dsp/compressor.js';
import { renderStab } from '../src/dsp/render.js';
import { presetPatch } from '../src/engine/presets.js';

const SR = 24000;

test('compressor reduces loud signals more than quiet ones', () => {
  const steady = (amp) => {
    const c = new Compressor(SR, { amount: 0.6, ratio: 6, attack: 0.002, release: 0.05, mix: 1 });
    let g = 1;
    for (let i = 0; i < SR / 2; i++) g = c.compute(amp * Math.sin(i / 3), amp * Math.sin(i / 3));
    return g;
  };
  const quiet = steady(0.01), loud = steady(0.8);
  assert.ok(loud < quiet * 0.5, `loud gain ${loud} vs quiet ${quiet}`);
  assert.equal(new Compressor(SR, { amount: 0 }).compute(1, 1), 1);
});

test('parallel mix keeps some of the uncompressed signal', () => {
  const run = (mix) => {
    const c = new Compressor(SR, { amount: 1, ratio: 20, attack: 0.001, mix });
    let g = 1;
    for (let i = 0; i < SR / 4; i++) g = c.compute(0.9, 0.9);
    return g;
  };
  assert.ok(run(0.5) > run(1));
});

test('glue mode: dry and tail stems still add up and the render stays finite', () => {
  for (const mode of ['stab', 'glue']) {
    const p = presetPatch('dub-chord');
    p.comp = { amount: 0.8, mode, ratio: 8, attack: 0.005, release: 0.2, mix: 1 };
    const r = renderStab(p, [57, 60, 64], { sr: SR, seed: 2, maxTail: 6 });
    for (const ch of [...r.dry, ...r.wet]) for (const v of ch) assert.ok(Number.isFinite(v) && Math.abs(v) < 4, mode);
    assert.ok(r.length < r.dryLength + 6 * SR, `${mode}: tail ended`);
  }
});
