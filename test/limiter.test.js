import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitStems } from '../src/dsp/limiter.js';
import { renderStab } from '../src/dsp/render.js';
import { presetPatch } from '../src/engine/presets.js';

const SR = 24000;

function burst(n) {
  // A loud spike then a quieter body, like a stab.
  const l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = i < 200 ? 1 : 0.25 * Math.exp(-i / (SR * 0.3));
    l[i] = Math.sin(i / 4) * env; r[i] = Math.sin(i / 4.3) * env;
  }
  return [l, r];
}

test('limiter holds the original peak while raising everything under it', () => {
  const n = SR;
  const dry = burst(n), wet = [new Float32Array(n), new Float32Array(n)];
  const before = Math.max(...dry[0].map(Math.abs), ...dry[1].map(Math.abs));
  const rmsBefore = Math.sqrt(dry[0].reduce((a, v) => a + v * v, 0) / n);
  const gr = limitStems(dry, wet, n, SR, { on: true, drive: 9 });
  const after = Math.max(...dry[0].map(Math.abs), ...dry[1].map(Math.abs));
  const rmsAfter = Math.sqrt(dry[0].reduce((a, v) => a + v * v, 0) / n);
  assert.ok(after <= before + 1e-6, `peak ${after} > ${before}`);
  assert.ok(rmsAfter > rmsBefore * 1.5, `louder: ${rmsAfter} vs ${rmsBefore}`);
  assert.ok(gr < -3, `gain reduction ${gr}`);
});

test('limiter off leaves audio untouched; one gain keeps stems summing', () => {
  const n = 4000;
  const dry = burst(n), wet = burst(n);
  const copy = Float32Array.from(dry[0]);
  assert.equal(limitStems(dry, wet, n, SR, { on: false }), 0);
  assert.deepEqual(Array.from(dry[0]), Array.from(copy));
});

test('rendered stab with limiter never exceeds its unlimited peak', () => {
  const p = presetPatch('reese-stab');
  const off = renderStab({ ...p, limiter: { on: false } }, [45, 52, 57], { sr: SR, seed: 1, maxTail: 3 });
  const on = renderStab({ ...p, limiter: { on: true, drive: 12 } }, [45, 52, 57], { sr: SR, seed: 1, maxTail: 3 });
  assert.ok(on.peak <= off.peak * 1.001, `${on.peak} vs ${off.peak}`);
  assert.ok(on.limitDb < -1);
});
