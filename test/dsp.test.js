import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Oscillator, OSC_TYPES } from '../src/dsp/oscillators.js';
import { createFilter, FILTER_TYPES } from '../src/dsp/filters.js';
import { ADSR, EnvelopeFollower } from '../src/dsp/envelope.js';
import { Reverb, REVERB_TYPES } from '../src/dsp/reverb.js';
import { StereoDelay } from '../src/dsp/delay.js';
import { Saturator, SAT_MODES } from '../src/dsp/colour.js';
import { Rng } from '../src/dsp/rng.js';

const SR = 48000;
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

function sine(freq, n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

test('oscillators produce the requested pitch', () => {
  for (const type of ['saw', 'pulse', 'sine', 'tri']) {
    const o = new Oscillator(SR, { type, phaseRand: 0 }, 220, new Rng(1));
    let crossings = 0, prev = 0;
    for (let i = 0; i < SR; i++) {
      o.process(1);
      if (prev < 0 && o.l >= 0) crossings++;
      prev = o.l;
    }
    assert.ok(Math.abs(crossings - 220) <= 2, `${type}: ${crossings} cycles`);
  }
});

test('every oscillator type is finite and bounded', () => {
  for (const type of OSC_TYPES) {
    const o = new Oscillator(SR, { type, unison: 7, detune: 40 }, 110, new Rng(3));
    let peak = 0;
    for (let i = 0; i < SR / 2; i++) {
      o.process(1);
      assert.ok(Number.isFinite(o.l) && Number.isFinite(o.r), type);
      peak = Math.max(peak, Math.abs(o.l), Math.abs(o.r));
    }
    assert.ok(peak > 0.05 && peak < 4, `${type} peak ${peak}`);
  }
});

test('low-pass filters pass lows and cut highs', () => {
  for (const type of ['ladder', 'svf-lp24', 'svf-lp12', 'diode']) {
    const measure = (freq) => {
      const f = createFilter(type, SR);
      f.set(1000, 0.1, 0);
      const x = sine(freq, SR / 4);
      const y = Array.from(x, (v) => f.process(v * 0.3));
      return rms(y.slice(SR / 8)) / rms(Array.from(x.slice(SR / 8), (v) => v * 0.3));
    };
    const low = measure(100), high = measure(10000);
    assert.ok(low > 0.4, `${type} passband ${low}`);
    assert.ok(high < low * 0.12, `${type} stopband ${high} vs ${low}`);
  }
});

test('high-pass filter cuts lows', () => {
  const f = createFilter('svf-hp24', SR);
  f.set(2000, 0.1, 0);
  const y = Array.from(sine(100, SR / 4), (v) => f.process(v));
  assert.ok(rms(y.slice(SR / 8)) < 0.01);
});

test('filters stay stable under extreme settings and fast sweeps', () => {
  const rng = new Rng(9);
  for (const type of FILTER_TYPES) {
    const f = createFilter(type, SR);
    let peak = 0;
    for (let i = 0; i < SR; i++) {
      if (i % 16 === 0) f.set(20 * Math.pow(2, 10 * Math.abs(Math.sin(i / 3000))), 1, 1);
      const y = f.process(rng.bipolar() * 2);
      assert.ok(Number.isFinite(y), `${type} went non-finite`);
      peak = Math.max(peak, Math.abs(y));
    }
    assert.ok(peak < 20, `${type} peak ${peak}`);
  }
});

test('ADSR timing: reaches peak after attack and ends after release', () => {
  const e = new ADSR(SR, { a: 0.01, d: 0.1, s: 0.5, r: 0.2 }, 0.3);
  const out = [];
  while (!e.done) out.push(e.process());
  assert.ok(Math.abs(out.indexOf(Math.max(...out)) - 0.01 * SR) < 5);
  assert.ok(Math.abs(out[Math.round(0.25 * SR)] - 0.5) < 0.02, 'sustain level');
  assert.ok(Math.abs(out.length - 0.5 * SR) < 5, `length ${out.length}`);
});

test('envelope follower tracks level with attack/release', () => {
  const f = new EnvelopeFollower(SR, 0.001, 0.1);
  let y = 0;
  for (let i = 0; i < SR / 10; i++) y = f.process(Math.sin(i / 10));
  assert.ok(y > 0.5);
  for (let i = 0; i < SR / 10; i++) y = f.process(0);
  assert.ok(y < 0.4 && y > 0.3, `release ${y}`); // ~1/e after one time constant
});

test('reverb tails decay roughly as set and stay finite', () => {
  for (const type of REVERB_TYPES) {
    const rv = new Reverb(SR, { type, decay: 2, size: 0.6, predelay: 0 });
    const n = SR * 4;
    const env = [];
    let block = 0;
    for (let i = 0; i < n; i++) {
      rv.process(i === 0 ? 1 : 0, i === 0 ? 1 : 0);
      assert.ok(Number.isFinite(rv.l) && Number.isFinite(rv.r), type);
      block += rv.l * rv.l + rv.r * rv.r;
      if ((i + 1) % (SR / 10) === 0) { env.push(block); block = 0; }
    }
    const early = env[2], late = env[30];
    assert.ok(early > 0, `${type} produced no tail`);
    // Energy at 3 s should be far below energy at 0.2 s.
    assert.ok(late < early * 0.05, `${type} did not decay: ${late / early}`);
  }
});

test('delay repeats at the synced time', () => {
  const d = new StereoDelay(SR, 120, { mode: 'stereo', division: '1/4', feedback: 0, offset: 0, wow: 0, lpf: 18000, hpf: 10, sat: 0 });
  let first = -1;
  for (let i = 0; i < SR; i++) {
    d.process(i === 0 ? 1 : 0, i === 0 ? 1 : 0);
    if (first < 0 && Math.abs(d.l) > 0.05) first = i;
  }
  assert.ok(Math.abs(first - SR * 0.5) < 10, `first repeat at ${first}`);
});

test('saturation modes are bounded', () => {
  for (const mode of SAT_MODES) {
    const s = new Saturator(SR, { mode, drive: 1, mix: 1, bits: 4, rate: 0.5 });
    for (let i = 0; i < 2000; i++) {
      s.process(Math.sin(i / 7) * 2, Math.cos(i / 7) * 2);
      assert.ok(Math.abs(s.l) < 3 && Number.isFinite(s.r), mode);
    }
  }
});

test('blend oscillator: triangle at 0, saw at 0.5, square at 1', () => {
  const rng = new Rng(1);
  const grab = (shape, type = 'morph') => {
    const o = new Oscillator(SR, { type, shape, phaseRand: 0, pw: 0.5 }, 100, rng);
    const out = [];
    for (let i = 0; i < SR / 50; i++) { o.process(1); out.push(o.l); }
    return out;
  };
  const corr = (a, b) => {
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
    return ab / Math.sqrt(aa * bb);
  };
  assert.ok(corr(grab(0), grab(0, 'tri')) > 0.99);
  assert.ok(corr(grab(0.5), grab(0, 'saw')) > 0.99);
  assert.ok(corr(grab(1), grab(0, 'pulse')) > 0.99);
  for (const sh of [0.25, 0.75]) for (const v of grab(sh)) assert.ok(Number.isFinite(v) && Math.abs(v) < 1.5);
});
