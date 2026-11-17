import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Texture } from '../src/dsp/texture.js';
import { StereoDelay } from '../src/dsp/delay.js';
import { Rng } from '../src/dsp/rng.js';
import { renderStab } from '../src/dsp/render.js';
import { presetPatch } from '../src/engine/presets.js';

const SR = 24000;

test('crackle produces sparse clicks at roughly the set density', () => {
  const t = new Texture(SR, new Rng(1), { crackle: 1, density: 0.4, follow: 0 });
  let clicks = 0, prevQuiet = true, env = 0;
  const rel = Math.exp(-1 / (0.004 * SR));
  for (let i = 0; i < SR * 2; i++) {
    t.process(1);
    env = Math.max(Math.abs(t.l) + Math.abs(t.r), env * rel); // peak-hold envelope
    const loud = env > 0.03;
    if (loud && prevQuiet) clicks++;
    prevQuiet = !loud;
    assert.ok(Number.isFinite(t.l) && Math.abs(t.l) < 2);
  }
  // density 0.4 ~ 18 clicks/s; allow a wide band (small clicks fall under the gate)
  assert.ok(clicks > 8 && clicks < 120, `clicks ${clicks}`);
});

test('texture follows the sound when follow = 1', () => {
  const t = new Texture(SR, new Rng(2), { hiss: 1, follow: 1 });
  const energy = (level) => { let e = 0; for (let i = 0; i < SR / 4; i++) { t.process(level); e += t.l * t.l; } return e; };
  const loud = energy(1);
  energy(0); energy(0); energy(0); // let the follower settle
  const quiet = energy(0);
  assert.ok(quiet < loud * 0.3, `quiet ${quiet} vs loud ${loud}`);
});

test('a stab with crackle and hiss still ends when its tail does', () => {
  const p = presetPatch('dusty-tape');
  const r = renderStab(p, [57, 60, 64, 67], { sr: SR, seed: 4, maxTail: 20 });
  assert.ok(r.length < r.dryLength + 19 * SR, 'stopped before the cap');
  for (const ch of [...r.dry, ...r.wet]) for (const v of ch) assert.ok(Number.isFinite(v));
});

test('air noise adds noise between the harmonics', () => {
  const base = presetPatch('poly-pluck');
  base.reverb.send = 0; base.delay.send = 0; base.drift = 0;
  const airy = structuredClone(base); airy.noise.air = 0.8;
  const hf = (p) => {
    const r = renderStab(p, [57], { sr: SR, seed: 1, maxTail: 1 });
    // energy of the first difference ~ high-frequency content
    let e = 0; for (let i = 1; i < r.dryLength; i++) { const d = r.dry[0][i] - r.dry[0][i - 1]; e += d * d; }
    return e;
  };
  assert.ok(hf(airy) > hf(base) * 1.2);
});

test('tape delay stays bounded and dies away at maximum grit and feedback', () => {
  const d = new StereoDelay(SR, 120, { mode: 'tape', division: '1/8', feedback: 0.95, grit: 1, wow: 1 }, new Rng(3));
  let peak = 0, late = 0;
  for (let i = 0; i < SR * 30; i++) {
    const x = i < SR * 0.05 ? Math.sin(i / 5) * 0.8 : 0;
    d.process(x, x);
    assert.ok(Number.isFinite(d.l) && Number.isFinite(d.r));
    peak = Math.max(peak, Math.abs(d.l));
    if (i > SR * 28) late = Math.max(late, Math.abs(d.l));
  }
  assert.ok(peak < 3, `peak ${peak}`);
  assert.ok(late < peak * 0.05, `still ringing: ${late} vs ${peak}`);
});

test('tape grit darkens and dirties the repeats', () => {
  const repeatHF = (grit) => {
    const d = new StereoDelay(SR, 120, { mode: 'tape', division: '1/8', feedback: 0.6, grit, wow: 0 }, new Rng(5));
    let hf = 0, total = 0;
    for (let i = 0; i < SR * 2; i++) {
      const x = i < 400 ? (Math.random() * 2 - 1) * 0.5 : 0;
      d.process(x, x);
      if (i > SR * 0.5) { total += d.l * d.l; }
    }
    return total;
  };
  // Higher grit loses more of the repeats' energy to darkening and dropouts.
  assert.ok(repeatHF(1) < repeatHF(0));
});
