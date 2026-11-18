import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderStab } from '../src/dsp/render.js';
import { defaultKitSettings, generateKit, applyTail, mutateStab } from '../src/engine/variation.js';
import { PRESETS, presetPatch } from '../src/engine/presets.js';
import { applyMacros, defaultMacros, SCHEMA, getPath, defaultPatch } from '../src/engine/patch.js';
import { encodeWav, makeZip, prepareStab, finalLength, defaultExportSettings, normaliseGains } from '../src/engine/export.js';

const SR = 24000; // lower rate keeps tests quick

test('every preset renders finite, non-silent, unclipped audio', () => {
  for (const p of PRESETS) {
    const r = renderStab(presetPatch(p.id), [57, 60, 64, 67], { sr: SR, bpm: 124, seed: 1, maxTail: 6 });
    let peak = 0;
    for (const ch of [...r.dry, ...r.wet]) for (const v of ch) { assert.ok(Number.isFinite(v), p.id); peak = Math.max(peak, Math.abs(v)); }
    assert.ok(peak > 0.02, `${p.id} too quiet (${peak})`);
    assert.ok(peak < 2.5, `${p.id} too hot (${peak})`);
  }
});

test('rendering is deterministic for a seed', () => {
  const p = presetPatch('dub-chord');
  const a = renderStab(p, [57, 60, 64], { sr: SR, seed: 42, maxTail: 2 });
  const b = renderStab(p, [57, 60, 64], { sr: SR, seed: 42, maxTail: 2 });
  assert.deepEqual(Array.from(a.dry[0].slice(0, 2000)), Array.from(b.dry[0].slice(0, 2000)));
});

test('tails extend beyond the dry part and stop when silent', () => {
  const p = presetPatch('dub-chord');
  const r = renderStab(p, [57, 60, 64], { sr: SR, seed: 1, maxTail: 20 });
  assert.ok(r.length > r.dryLength + SR, 'tail is at least a second');
  assert.ok(r.length < r.dryLength + 20 * SR, 'stopped before the cap');
  const dry = applyTail(p, 0);
  const rd = renderStab(dry, [57, 60, 64], { sr: SR, seed: 1 });
  assert.ok(rd.length < r.length);
});

test('kit generation is deterministic, sized and varied', () => {
  const s = { ...defaultKitSettings(), size: 8 };
  const a = generateKit(s), b = generateKit(s);
  assert.equal(a.length, 8);
  assert.deepEqual(a.map((x) => x.patch), b.map((x) => x.patch));
  const cutoffs = new Set(a.map((x) => Math.round(x.patch.filterA.cutoff)));
  assert.ok(cutoffs.size > 4, 'cutoff varies across the kit');
  const tails = new Set(a.map((x) => x.info.tailLabel));
  assert.ok(tails.size >= 3, 'tail lengths vary');
});

test('locks keep groups identical across the kit', () => {
  const s = { ...defaultKitSettings(), size: 6, variation: 1, familySpread: 1, locks: { filter: true, chord: true } };
  const kit = generateKit(s);
  const f0 = JSON.stringify(kit[0].patch.filterA);
  for (const st of kit) {
    assert.equal(JSON.stringify(st.patch.filterA), f0);
    assert.deepEqual(st.chord.notes, kit[0].chord.notes);
  }
});

test('re-rolling one pad keeps the others', () => {
  const s = { ...defaultKitSettings(), size: 4 };
  const kit = generateKit(s);
  const s2 = { ...s, stabSeeds: { 2: 1 } };
  const kit2 = generateKit(s2, kit);
  assert.equal(kit2[0], kit[0]);
  assert.equal(kit2[3], kit[3]);
  assert.notEqual(kit2[2].seed, kit[2].seed);
  const m = mutateStab(kit[1], s, 1);
  assert.notEqual(m.seed, kit[1].seed);
});

test('macros move parameters in the expected direction', () => {
  const p = defaultPatch();
  const bright = applyMacros(p, { ...defaultMacros(), bright: 1 });
  const dark = applyMacros(p, { ...defaultMacros(), bright: 0 });
  assert.ok(bright.filterA.cutoff > p.filterA.cutoff && dark.filterA.cutoff < p.filterA.cutoff);
  const wet = applyMacros(p, { ...defaultMacros(), space: 1 });
  assert.ok(wet.reverb.send > p.reverb.send && wet.reverb.decay > p.reverb.decay);
});

test('schema paths all exist on the default patch', () => {
  const p = defaultPatch();
  for (const sec of SCHEMA) for (const prm of sec.params) assert.notEqual(getPath(p, prm.path), undefined, prm.path);
});

test('WAV header and length are correct', () => {
  const n = 1000;
  const w = encodeWav([new Float32Array(n), new Float32Array(n)], 48000, 24);
  const v = new DataView(w.buffer);
  assert.equal(String.fromCharCode(...w.slice(0, 4)), 'RIFF');
  assert.equal(v.getUint32(24, true), 48000);
  assert.equal(v.getUint16(34, true), 24);
  assert.equal(v.getUint32(40, true), n * 2 * 3);
  assert.equal(w.length, 44 + n * 6);
});

test('ZIP archive is valid', (t) => {
  const zip = makeZip([
    { name: 'a.wav', data: encodeWav([new Float32Array(10)], 48000, 16) },
    { name: 'stems/b.txt', data: new TextEncoder().encode('hello') },
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'stabzip-'));
  const file = join(dir, 'k.zip');
  writeFileSync(file, zip);
  try {
    const out = execFileSync('unzip', ['-t', file]).toString();
    assert.match(out, /No errors detected/);
  } catch (e) {
    if (e.code === 'ENOENT') t.skip('unzip not installed'); else throw e;
  }
});

test('export length modes and normalisation', () => {
  const r = renderStab(presetPatch('dub-chord'), [57, 60, 64], { sr: SR, bpm: 120, seed: 3, maxTail: 10 });
  const ex = defaultExportSettings();
  const auto = finalLength(r, ex, 120);
  const snap = finalLength(r, { ...ex, lengthMode: 'snap' }, 120);
  const beat = SR * 0.5;
  assert.ok(snap >= auto && snap % beat === 0);
  assert.equal(finalLength(r, { ...ex, lengthMode: 'fixed', fixedBars: 1 }, 120), SR * 2);
  const [g] = normaliseGains([r], ex);
  const prep = prepareStab(r, ex, 120, g);
  let peak = 0;
  for (const ch of prep.mix) for (const v of ch) peak = Math.max(peak, Math.abs(v));
  assert.ok(Math.abs(peak - Math.pow(10, -1 / 20)) < 0.01, `peak ${peak}`);
  assert.ok(Math.abs(prep.mix[0][prep.length - 1]) < 1e-9, 'faded to zero');
});

test('width macro: mono at 0, wider than default at 1, and renders are stereo', () => {
  const corr = (r) => {
    let lr = 0, ll = 0, rr = 0;
    for (let i = 0; i < r.dryLength; i++) { const l = r.dry[0][i], x = r.dry[1][i]; lr += l * x; ll += l * l; rr += x * x; }
    return lr / Math.sqrt(ll * rr + 1e-12);
  };
  const base = presetPatch('detroit-strings');
  const render = (w) => renderStab(applyMacros(base, { ...defaultMacros(), width: w }), [57, 60, 64, 67], { sr: SR, seed: 5, maxTail: 1 });
  const mono = render(0), mid = render(0.5), wide = render(1);
  assert.ok(corr(mono) > 0.999, `mono corr ${corr(mono)}`);
  assert.ok(corr(mid) < 0.99, 'default is stereo');
  assert.ok(corr(wide) < corr(mid), `wide ${corr(wide)} vs ${corr(mid)}`);
});

test('ping-pong delay alternates sides', () => {
  const p = presetPatch('dub-chord');
  p.reverb.send = 0; p.delay = { ...p.delay, mode: 'pingpong', send: 1, feedback: 0.5, division: '1/4', wow: 0 };
  p.gate = 0.1; p.amp.r = 0.02;
  const r = renderStab(p, [57], { sr: SR, bpm: 120, seed: 1, maxTail: 3 });
  const beat = SR * 0.5;
  const energy = (ch, a) => { let e = 0; for (let i = a; i < a + beat * 0.5; i++) e += ch[i] * ch[i]; return e; };
  const [wl, wr] = r.wet;
  assert.ok(energy(wl, beat) > energy(wr, beat) * 10, 'first repeat left');
  assert.ok(energy(wr, beat * 2) > energy(wl, beat * 2) * 10, 'second repeat right');
});

test('delay time spread gives pads different tempo-synced times', async () => {
  const { DELAY_LADDER } = await import('../src/engine/variation.js');
  const s = { ...defaultKitSettings(), size: 8, delaySpread: 1 };
  const kit = generateKit(s);
  const divs = kit.map((k) => k.patch.delay.division);
  assert.ok(new Set(divs).size >= 4, `only ${[...new Set(divs)]}`);
  assert.ok(divs.every((d) => DELAY_LADDER.includes(d)));
  const same = generateKit({ ...s, delaySpread: 0 }).map((k) => k.patch.delay.division);
  assert.equal(new Set(same).size, 1);
  const locked = generateKit({ ...s, locks: { ...s.locks, space: true } }).map((k) => k.patch.delay.division);
  assert.equal(new Set(locked).size, 1);
});

test('stereo delay can use a separate right-hand time', async () => {
  const { StereoDelay } = await import('../src/dsp/delay.js');
  const d = new StereoDelay(48000, 120, { mode: 'stereo', division: '1/8', divisionR: '1/4', feedback: 0, wow: 0 });
  assert.equal(Math.round(d.dL), 12000);
  assert.equal(Math.round(d.dR), 24000);
});

test('octave moves every pad; octave spread varies pads within the range', () => {
  const s = { ...defaultKitSettings(), size: 8, chordMode: 'fixed' };
  const base = generateKit(s).map((k) => k.chord.notes);
  const up = generateKit({ ...s, octave: 1 }).map((k) => k.chord.notes);
  up.forEach((notes, i) => assert.deepEqual(notes, base[i].map((n) => n + 12)));
  const spread = generateKit({ ...s, octaveRange: 2 });
  const shifts = new Set(spread.map((k) => k.info.octaveShift));
  assert.ok(shifts.size >= 2, `shifts ${[...shifts]}`);
  for (const k of spread) {
    assert.ok(Math.abs(k.info.octaveShift) <= 2);
    assert.ok(k.chord.notes.every((n) => n >= 21 && n <= 108));
  }
  // Extreme settings stay in range.
  for (const k of generateKit({ ...s, octave: 4, octaveRange: 4 })) assert.ok(Math.max(...k.chord.notes) <= 108);
  for (const k of generateKit({ ...s, octave: -4, octaveRange: 4 })) assert.ok(Math.min(...k.chord.notes) >= 21);
  // Each step up the -4..+4 range raises the chord (never lowers it). A mid
  // chord bottoms out on the lowest piano notes around -3, so only the very
  // bottom steps may be equal.
  const avg = (o) => { const n = generateKit({ ...s, size: 1, octave: o })[0].chord.notes; return n.reduce((a, b) => a + b, 0) / n.length; };
  for (let o = -4; o < 4; o++) assert.ok(avg(o + 1) >= avg(o), `octave ${o} -> ${o + 1}`);
  for (let o = -3; o < 4; o++) assert.ok(avg(o + 1) > avg(o), `octave ${o} -> ${o + 1} should move`);
});

test('key changes move pad sections into new keys', async () => {
  const { keyPlan, KEY_CHANGES } = await import('../src/engine/variation.js');
  const s = { ...defaultKitSettings(), size: 8, chordMode: 'fixed', keyEvery: 2 };
  assert.deepEqual(keyPlan({ ...s, keyChange: 'off' }), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(keyPlan({ ...s, keyChange: 'up-semitone' }), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.deepEqual(keyPlan({ ...s, keyChange: 'fifths' }), [0, 0, -5, -5, 2, 2, -3, -3]);
  assert.deepEqual(keyPlan({ ...s, keyChange: 'there-and-back' }), [0, 0, 5, 5, 0, 0, 5, 5]);
  for (const id of Object.keys(KEY_CHANGES)) {
    for (const off of keyPlan({ ...s, keyChange: id })) assert.ok(off >= -5 && off <= 6, `${id}: ${off}`);
  }
  // Chords really move: a fixed Am7 kit rising by semitones.
  const kit = generateKit({ ...s, keyChange: 'up-semitone' });
  assert.equal(kit[0].chord.name, 'Am7');
  assert.equal(kit[2].chord.name, 'A#m7');
  assert.equal(kit[2].info.key, 'A#m');
  assert.deepEqual(kit[2].chord.notes, kit[0].chord.notes.map((n) => n + 1));
});

test('knob variation nudges each pad; 0 keeps them identical; locks win', () => {
  const s = { ...defaultKitSettings(), size: 8, variation: 0, familySpread: 0, tailSpread: 0, delaySpread: 0 };
  const cut = (kit) => kit.map((k) => Math.round(k.patch.filterA.cutoff));
  assert.equal(new Set(cut(generateKit({ ...s, macroVariation: 0 }))).size, 1);
  const varied = generateKit({ ...s, macroVariation: 0.5 });
  assert.ok(new Set(cut(varied)).size >= 6, `cutoffs ${cut(varied)}`);
  assert.ok(new Set(varied.map((k) => k.patch.reverb.send.toFixed(4))).size >= 4, 'space varies too');
  const locked = generateKit({ ...s, macroVariation: 0.5, locks: { ...s.locks, filter: true } });
  assert.equal(new Set(cut(locked)).size, 1);
});

test('strum set to zero stays zero on every pad, even with high variation', () => {
  const s = { ...defaultKitSettings(), size: 16, variation: 1 };
  for (const st of generateKit(s)) assert.equal(st.patch.strum, 0, `pad ${st.index + 1}`);
  const strummed = { ...s, basePatch: { ...presetPatch('dub-chord'), strum: 0.02 } };
  assert.ok(generateKit(strummed).some((st) => st.patch.strum > 0));
});
