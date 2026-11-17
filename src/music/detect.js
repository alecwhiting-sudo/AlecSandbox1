// Approximate note detection for a dropped-in stab.
// Averages a few FFT frames from just after the attack, then picks notes one
// at a time by harmonic salience, removing each found note's harmonics before
// looking for the next (iterative estimation in the style of Klapuri).
// It aims for "the notes a musician would write down", not perfect transcription.

import { detectChord } from './theory.js';

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Mix any number of channels to mono. */
export function toMono(channels) {
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length;
  return out;
}

/** Averaged magnitude spectrum of the body of the sound (after the attack). */
function spectrum(x, sr) {
  // Envelope in 10 ms blocks to find the attack and where it has died away.
  const blk = Math.round(sr * 0.01);
  const env = [];
  for (let i = 0; i < x.length; i += blk) {
    let e = 0;
    for (let k = i; k < Math.min(x.length, i + blk); k++) e += x[k] * x[k];
    env.push(Math.sqrt(e / blk));
  }
  const peakBlock = env.indexOf(Math.max(...env));
  const peak = env[peakBlock] || 1e-9;
  let endBlock = peakBlock;
  while (endBlock < env.length - 1 && env[endBlock + 1] > peak * 0.05) endBlock++;
  // Skip the first ~25 ms after the peak: clicks and noise live there.
  const start = Math.min((peakBlock + 2) * blk, x.length - 1);
  const end = Math.max(start + blk * 8, Math.min(x.length, (endBlock + 1) * blk));
  const N = 16384;
  const hop = N / 4;
  const mag = new Float64Array(N / 2);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  let frames = 0;
  for (let s = start; frames < 6 && (frames === 0 || s + N / 2 < end); s += hop) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N && s + i < x.length; i++) re[i] = x[s + i] * win[i];
    fft(re, im);
    for (let k = 0; k < N / 2; k++) mag[k] += Math.hypot(re[k], im[k]);
    frames++;
  }
  return { mag, binHz: sr / N };
}

/** Local maxima in the spectrum, with interpolated frequency. */
function findPeaks(mag, binHz) {
  let max = 0;
  for (let k = 0; k < mag.length; k++) if (mag[k] > max) max = mag[k];
  const floor = max * 0.01; // -40 dB
  const peaks = [];
  const kMin = Math.ceil(28 / binHz), kMax = Math.min(mag.length - 2, Math.floor(6000 / binHz));
  for (let k = Math.max(2, kMin); k < kMax; k++) {
    const m = mag[k];
    if (m < floor || m < mag[k - 1] || m < mag[k + 1] || m < mag[k - 2] || m < mag[k + 2]) continue;
    const a = Math.log(mag[k - 1] + 1e-12), b = Math.log(m), c = Math.log(mag[k + 1] + 1e-12);
    const off = 0.5 * (a - c) / (a - 2 * b + c || 1e-12);
    peaks.push({ f: (k + off) * binHz, a: m / max });
  }
  return peaks;
}

const HARM_KEEP = 1;
const midiOf = (f) => 69 + 12 * Math.log2(f / 440);
const hzOf = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * Detect the approximate notes of a stab.
 * @param {Float32Array} mono
 * @param {number} sr
 * @param {{maxNotes?: number}} [opts]
 * @returns {{notes: number[], name: string, confidence: number}}
 */
export function detectNotes(mono, sr, { maxNotes = 6 } = {}) {
  const { mag, binHz } = spectrum(mono, sr);
  const peaks = findPeaks(mag, binHz);
  if (!peaks.length) return { notes: [], name: '—', confidence: 0 };
  // Below ~70 Hz a semitone is narrower than our frequency resolution allows.
  const lowest = Math.max(28, Math.ceil(midiOf(Math.max(binHz * 3, 32))));
  const H = 10;
  const tol = 0.45; // semitones
  const salience = (m, live) => {
    const f0 = hzOf(m);
    let s = 0, hits = 0;
    for (let h = 1; h <= H; h++) {
      const target = midiOf(f0 * h);
      let best = 0;
      for (const p of live) {
        if (p.a <= 0) continue;
        const d = Math.abs(midiOf(p.f) - target);
        if (d < tol) best = Math.max(best, p.a * (1 - d / tol));
      }
      if (best > 0) hits++;
      s += best * Math.pow(0.84, h - 1);
    }
    // The fundamental itself should be present for a confident note.
    return { s: s * (0.5 + 0.5 * Math.min(1, hits / 3)), hits };
  };
  const live = peaks.map((p) => ({ ...p }));
  const notes = [];
  let first = 0;
  const found = new Set();
  // Octave copies (organ footages, sub-oscillators) don't use up a note slot.
  for (let n = 0; n < maxNotes + 1 && found.size < maxNotes; n++) {
    let bestM = -1, bestS = 0;
    for (let m = lowest; m <= 100; m++) {
      // A candidate needs energy at its own fundamental.
      const fundamental = live.some((p) => p.a > 0.02 && Math.abs(midiOf(p.f) - m) < tol);
      if (!fundamental) continue;
      const { s } = salience(m, live);
      if (s > bestS) { bestS = s; bestM = m; }
    }
    if (bestM < 0) break;
    if (n === 0) first = bestS;
    else if (bestS < first * 0.28) break;
    notes.push(bestM);
    found.add(bestM % 12);
    // Remove this note's harmonics so they aren't heard as new notes, but only
    // the share a harmonic would plausibly carry (about 1/h of the fundamental,
    // like a saw). A real chord tone sitting on a harmonic, e.g. the fifth
    // over a sub-octave, keeps the rest of its energy and is still found.
    const f0 = hzOf(bestM);
    let a0 = 0;
    for (const p of live) if (Math.abs(midiOf(p.f) - bestM) < tol) a0 = Math.max(a0, p.a);
    for (let h = 1; h <= H; h++) {
      const target = midiOf(f0 * h);
      for (const p of live) {
        if (Math.abs(midiOf(p.f) - target) >= tol) continue;
        p.a = h === 1 ? 0 : Math.max(0, p.a - (a0 * HARM_KEEP) / h);
      }
    }
  }
  // One note per pitch class, keeping the strongest-ranked octave of each
  // (found earlier = more salient), so octave ghosts don't pile up.
  const byPc = new Map();
  for (const m of notes) if (!byPc.has(m % 12)) byPc.set(m % 12, m);
  const sorted = [...byPc.values()].sort((a, b) => a - b);
  const confidence = Math.min(1, first / 1.5);
  return { notes: sorted, name: detectChord(sorted), confidence };
}
