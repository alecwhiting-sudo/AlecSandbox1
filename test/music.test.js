import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChord, diatonicChord, randomChord, mutateChord } from '../src/music/chords.js';
import { detectChord, dissonanceOf, CHORD_TYPES } from '../src/music/theory.js';
import { Rng } from '../src/dsp/rng.js';

test('builds and names chords', () => {
  assert.equal(buildChord({ root: 9, type: 'min7' }).name, 'Am7');
  assert.equal(buildChord({ root: 0, type: 'maj' }).name, 'C');
  assert.equal(buildChord({ root: 2, type: 'min9' }).name, 'Dm9');
  assert.match(buildChord({ root: 0, type: 'maj', inversion: 1 }).name, /^C\/E$/);
});

test('every chord type builds within MIDI range', () => {
  for (const t of CHORD_TYPES) {
    for (const v of ['close', 'open', 'drop2', 'drop3', 'spread', 'wide']) {
      const c = buildChord({ root: 4, type: t.id, voicing: v, inversion: 2, bass: true, top: true });
      assert.ok(c.notes.length >= 2);
      assert.ok(c.notes.every((n) => n >= 24 && n <= 100), `${t.id}/${v}`);
    }
  }
});

test('bass option puts the root at the bottom', () => {
  const c = buildChord({ root: 9, type: 'min7', bass: true });
  assert.equal(c.notes[0] % 12, 9);
  assert.ok(c.notes[1] - c.notes[0] >= 5);
});

test('diatonic chords in A minor', () => {
  assert.equal(diatonicChord(9, 'minor', 0, 4).name, 'Am7');
  assert.equal(diatonicChord(9, 'minor', 5, 4).name, 'Fmaj7');
  assert.equal(diatonicChord(9, 'minor', 2, 3).name, 'C');
});

test('dissonance rating orders consonant below clusters', () => {
  assert.ok(dissonanceOf([57, 60, 64]) < dissonanceOf([60, 61, 62]));
  assert.ok(detectChord([60, 61, 62]).length > 0);
});

test('random chords are deterministic and respect dissonance', () => {
  const a = randomChord(new Rng('x'), { dissonance: 0.2 });
  const b = randomChord(new Rng('x'), { dissonance: 0.2 });
  assert.deepEqual(a, b);
  const avg = (d) => {
    const rng = new Rng('avg' + d);
    let s = 0;
    for (let i = 0; i < 200; i++) s += dissonanceOf(randomChord(rng, { dissonance: d }).notes);
    return s / 200;
  };
  assert.ok(avg(0.05) < avg(0.95));
});

test('mutation changes the chord and follows the dissonance target', () => {
  const base = buildChord({ root: 9, type: 'min7' });
  const rng = new Rng('m');
  let low = 0, high = 0;
  for (let i = 0; i < 100; i++) {
    const a = mutateChord(rng, base, { dissonance: 0.05, strength: 0.5 });
    const b = mutateChord(rng, base, { dissonance: 0.95, strength: 0.5 });
    assert.notDeepEqual(a.notes, base.notes);
    low += dissonanceOf(a.notes); high += dissonanceOf(b.notes);
  }
  assert.ok(low < high, `${low} vs ${high}`);
});
