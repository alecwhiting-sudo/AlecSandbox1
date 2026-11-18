// Look-ahead peak limiter, applied after rendering (offline, so it can see
// ahead perfectly). Drive pushes the stab into the limiter: peaks are held to
// the stab's original peak while everything under them gets up to `drive` dB
// louder. One gain curve is applied to the dry and tail stems, so they still
// add up to the mix.
//
// Gain computer: the required gain per sample, a running minimum over the
// look-ahead window (so the gain is already down when a peak arrives), then a
// moving average over the same window (a smooth, click-free attack that still
// never exceeds the requirement), then a one-pole release.

import { clamp } from './util.js';

/**
 * @param {Float32Array[]} dry [L, R]
 * @param {Float32Array[]} wet [L, R]
 * @param {number} length samples to process
 * @param {number} sr
 * @param {object} p { on, drive (dB 0..18), release (s), lookahead (s) }
 * @returns {number} the largest gain reduction applied, in dB (<= 0)
 */
export function limitStems(dry, wet, length, sr, p = {}) {
  if (!p.on) return 0;
  const drive = Math.pow(10, clamp(p.drive ?? 3, 0, 24) / 20);
  const look = Math.max(1, Math.round(clamp(p.lookahead ?? 0.0015, 0.0002, 0.01) * sr));
  const relK = Math.exp(-1 / (clamp(p.release ?? 0.08, 0.005, 1) * sr));
  const n = length;
  // Peak of the mix before limiting: the ceiling.
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(Math.abs(dry[0][i] + wet[0][i]), Math.abs(dry[1][i] + wet[1][i]));
    if (a > peak) peak = a;
  }
  if (peak <= 0) return 0;
  const ceiling = peak * 0.98;
  // Required gain per sample after drive.
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = drive * Math.max(Math.abs(dry[0][i] + wet[0][i]), Math.abs(dry[1][i] + wet[1][i]));
    req[i] = a > ceiling ? ceiling / a : 1;
  }
  // Running minimum over [i, i + look] (monotonic deque).
  const minAhead = new Float32Array(n);
  const dq = new Int32Array(n + 1);
  let head = 0, tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (tail > head && req[dq[tail - 1]] >= req[i]) tail--;
    dq[tail++] = i;
    while (dq[head] > i + look) head++;
    minAhead[i] = req[dq[head]];
  }
  // Moving average over the window behind each sample: smooth attack.
  const gain = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += minAhead[i];
    if (i >= look) sum -= minAhead[i - look];
    gain[i] = Math.min(sum / Math.min(i + 1, look), minAhead[i]);
  }
  // Release: rise back slowly, never above what is required.
  let g = 1, worst = 1;
  for (let i = 0; i < n; i++) {
    const target = gain[i];
    g = target < g ? target : target + relK * (g - target);
    if (g > req[i]) g = req[i]; // hard guarantee: no sample over the ceiling
    if (g < worst) worst = g;
    const k = g * drive;
    dry[0][i] *= k; dry[1][i] *= k; wet[0][i] *= k; wet[1][i] *= k;
  }
  return 20 * Math.log10(worst);
}
