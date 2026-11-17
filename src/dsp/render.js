// Stab renderer: turns a patch + chord into separate dry and wet (tail)
// stereo buffers. Runs offline, so it works the same in a browser worker,
// in Node (tests, batch export) or as a reference for a native port.

import { clamp, midiToHz, panGains, beatsToSeconds, dbToGain, DIVISIONS, DCBlocker } from './util.js';
import { Rng } from './rng.js';
import { Oscillator, Noise } from './oscillators.js';
import { ADSR, EnvelopeFollower, PitchEnv, Drift } from './envelope.js';
import { createFilter } from './filters.js';
import { Saturator, TransientShaper, Chorus, OutputEQ } from './colour.js';
import { StereoDelay } from './delay.js';
import { Reverb } from './reverb.js';

const CTRL = 16; // control-rate interval in samples

class Voice {
  constructor(sr, patch, note, index, count, rng, gateSec, startOffset) {
    this.sr = sr;
    this.patch = patch;
    this.note = note;
    this.start = startOffset;
    const freq = midiToHz(note);
    this.oscs = [];
    for (const o of patch.osc) {
      if (!o.on || o.level <= 0) continue;
      const f = freq * Math.pow(2, (o.octave ?? 0) + (o.semi ?? 0) / 12 + (o.fine ?? 0) / 1200);
      this.oscs.push({ osc: new Oscillator(sr, o, f, rng.fork('osc' + this.oscs.length)), level: o.level });
    }
    const isLowest = index === 0;
    this.sub = null;
    if (isLowest && patch.sub && patch.sub.level > 0) {
      const t = patch.sub.wave === 'square' ? 'pulse' : patch.sub.wave === 'tri' ? 'tri' : 'sine';
      this.sub = { osc: new Oscillator(sr, { type: t, pw: 0.5, phaseRand: 0 }, freq * Math.pow(2, patch.sub.octave ?? -1), rng), level: patch.sub.level };
    }
    this.noise = null;
    if (isLowest && patch.noise && patch.noise.level > 0) {
      this.noise = new Noise(rng.fork('noise'), patch.noise.colour ?? 0.6);
      this.noiseLevel = patch.noise.level;
      this.noiseK = Math.exp(-1 / (Math.max(patch.noise.decay ?? 0.02, 0.001) * sr));
      this.noiseEnv = 1;
    }
    this.amp = new ADSR(sr, patch.amp, gateSec);
    this.fenv = new ADSR(sr, patch.fenv, gateSec);
    this.pitch = new PitchEnv(sr, patch.pitchEnv?.amount ?? 0, patch.pitchEnv?.decay ?? 0.03);
    this.drift = new Drift(sr, rng.fork('drift'), patch.drift ?? 0, patch.driftRate ?? 0.6);
    this.follower = new EnvelopeFollower(sr, patch.follower?.attack ?? 0.01, patch.follower?.release ?? 0.15);
    this.fA = [createFilter(patch.filterA.type, sr), createFilter(patch.filterA.type, sr)];
    this.fBOn = patch.filterB && patch.filterB.type !== 'off';
    if (this.fBOn) this.fB = [createFilter(patch.filterB.type, sr), createFilter(patch.filterB.type, sr)];
    const pos = count === 1 ? 0 : (index / (count - 1)) * 2 - 1;
    // Alternate sides so adjacent notes separate rather than low-left/high-right.
    const alt = count > 2 ? (index % 2 ? 1 : -1) * Math.abs(pos) * 0.6 + pos * 0.4 : pos;
    [this.pl, this.pr] = panGains(alt * clamp(patch.voiceSpread ?? 0.5, 0, 1));
    this.keyOct = (note - 60) / 12;
    this.vel = clamp(patch.velocity ?? 0.8, 0, 1);
    this.ampVel = 0.4 + 0.6 * this.vel;
    this.n = 0;
    this.pitchMul = 1;
    this.lastOut = 0;
    this.l = 0; this.r = 0;
    this.done = false;
  }

  updateControl(scMod) {
    const p = this.patch;
    const semis = this.pitch.v;
    for (let i = 1; i < CTRL; i++) this.pitch.process();
    this.pitch.process();
    this.pitchMul = Math.pow(2, (semis * 100 + this.drift.y) / 1200);
    const fe = this.fenv.level;
    const fol = clamp(this.follower.y * 2.5, 0, 1.5);
    const velOct = (this.vel - 0.7) * (p.filterA.vel ?? 1);
    const a = p.filterA;
    const cutA = a.cutoff * Math.pow(2, (a.env ?? 0) * fe + (a.key ?? 0.5) * this.keyOct + velOct + (a.follow ?? 0) * fol + scMod * (p.sidechain?.filter ?? 0));
    this.fA[0].set(cutA, a.res, a.drive); this.fA[1].set(cutA, a.res, a.drive);
    if (this.fBOn) {
      const b = p.filterB;
      const cutB = b.cutoff * Math.pow(2, (b.env ?? 0) * fe + (b.key ?? 0) * this.keyOct + (b.follow ?? 0) * fol);
      this.fB[0].set(cutB, b.res, b.drive); this.fB[1].set(cutB, b.res, b.drive);
    }
  }

  process(scMod) {
    if (this.n < this.start) { this.n++; this.l = 0; this.r = 0; return; }
    const local = this.n - this.start;
    if (local % CTRL === 0) this.updateControl(scMod);
    this.drift.process();
    this.fenv.process();
    const pm = this.pitchMul;
    let l = 0, r = 0;
    for (const o of this.oscs) { o.osc.process(pm); l += o.osc.l * o.level; r += o.osc.r * o.level; }
    if (this.sub) { this.sub.osc.process(pm); const s = this.sub.osc.l * this.sub.level; l += s; r += s; }
    if (this.noise) {
      const s = this.noise.process() * this.noiseLevel * this.noiseEnv;
      this.noiseEnv *= this.noiseK; l += s; r += s;
    }
    const p = this.patch;
    let yl, yr;
    if (this.fBOn && p.routing === 'parallel') {
      yl = (this.fA[0].process(l) + this.fB[0].process(l)) * 0.7;
      yr = (this.fA[1].process(r) + this.fB[1].process(r)) * 0.7;
    } else {
      yl = this.fA[0].process(l); yr = this.fA[1].process(r);
      if (this.fBOn) { yl = this.fB[0].process(yl); yr = this.fB[1].process(yr); }
    }
    const env = this.amp.process() * this.ampVel;
    yl *= env; yr *= env;
    // Follower tracks this voice's own output (one sample behind).
    this.follower.process((yl + yr) * 0.5);
    this.l = yl * this.pl; this.r = yr * this.pr;
    this.n++;
    if (this.amp.done) this.done = true;
  }
}

/** Builds a sidechain envelope: internal kick pulses or a supplied signal. */
function makeSidechain(sr, bpm, sc, total, external) {
  if (!sc || sc.mode === 'off' || !(sc.amount > 0)) return null;
  const env = new Float32Array(total);
  if (sc.mode === 'file' && external) {
    const f = new EnvelopeFollower(sr, 0.002, sc.release ?? 0.15);
    let peak = 1e-6;
    for (let i = 0; i < external.length; i++) peak = Math.max(peak, Math.abs(external[i]));
    for (let i = 0; i < total; i++) {
      const x = i < external.length ? external[i] / peak : 0;
      env[i] = Math.min(1, f.process(x) * 1.4);
    }
    return env;
  }
  // 'pump': a kick on every beat (or chosen division) shaped like a compressor release.
  const period = Math.max(1, Math.round(beatsToSeconds(DIVISIONS[sc.division ?? '1/4'] ?? 1, bpm) * sr));
  const rel = Math.max(0.01, sc.release ?? 0.18) * sr;
  for (let i = 0; i < total; i++) {
    const t = i % period;
    env[i] = t < 0.003 * sr ? t / (0.003 * sr) : Math.exp(-(t - 0.003 * sr) / (rel * 0.4));
  }
  return env;
}

/**
 * Render one stab.
 * @param {object} patch full patch (see engine/patch.js)
 * @param {number[]} notes MIDI notes of the chord (ascending)
 * @param {object} opts { sr, bpm, seed, maxTail, sidechainSignal }
 * @returns {{sr:number, dry:[Float32Array,Float32Array], wet:[Float32Array,Float32Array], length:number, dryLength:number}}
 */
export function renderStab(patch, notes, opts = {}) {
  const sr = opts.sr ?? 48000;
  const bpm = opts.bpm ?? 124;
  const rng = new Rng(opts.seed ?? 1);
  const sorted = [...notes].sort((a, b) => a - b);
  const gateSec = Math.max(0.01, beatsToSeconds(patch.gate ?? 0.5, bpm));
  const strum = Math.round(clamp(patch.strum ?? 0, 0, 0.12) * sr);
  const strumUp = (patch.strumDir ?? 'up') !== 'down';
  const voices = sorted.map((n, i) => new Voice(
    sr, patch, n, i, sorted.length, rng.fork('v' + i), gateSec,
    strum * (strumUp ? i : sorted.length - 1 - i),
  ));
  const dryLength = Math.ceil(gateSec * sr + Math.max(patch.amp.r, 0.002) * sr + strum * sorted.length + 0.01 * sr);
  const maxTail = Math.round((opts.maxTail ?? 20) * sr);
  const hasDelay = (patch.delay?.send ?? 0) > 0;
  const hasVerb = (patch.reverb?.send ?? 0) > 0;
  const capacity = dryLength + ((hasDelay || hasVerb) ? maxTail : Math.round(0.05 * sr));

  const sat = new Saturator(sr, patch.colour);
  const trans = new TransientShaper(sr, patch.transient?.attack ?? 0, patch.transient?.sustain ?? 0);
  const chorus = new Chorus(sr, patch.chorus);
  const eq = new OutputEQ(sr, patch.eq);
  const delay = hasDelay ? new StereoDelay(sr, bpm, patch.delay) : null;
  const reverb = hasVerb ? new Reverb(sr, patch.reverb) : null;
  const duckF = new EnvelopeFollower(sr, 0.005, patch.duck?.release ?? 0.25);
  const duckAmt = clamp(patch.duck?.amount ?? 0, 0, 1);
  const sc = makeSidechain(sr, bpm, patch.sidechain, capacity, opts.sidechainSignal);
  const scAmt = clamp(patch.sidechain?.amount ?? 0, 0, 1);
  const dcL = new DCBlocker(sr), dcR = new DCBlocker(sr);

  const voiceGain = dbToGain(patch.level ?? 0) * 0.55 / Math.sqrt(Math.max(1, sorted.length));
  const width = clamp(patch.width ?? 1, 0, 1.5);
  const dSend = patch.delay?.send ?? 0;
  const rSend = patch.reverb?.send ?? 0;
  const d2r = clamp(patch.delayToReverb ?? 0.3, 0, 1);

  const dryL = new Float32Array(capacity), dryR = new Float32Array(capacity);
  const wetL = new Float32Array(capacity), wetR = new Float32Array(capacity);

  const BLOCK = 512;
  let peak = 1e-9, quietBlocks = 0, end = capacity;
  for (let start = 0; start < capacity; start += BLOCK) {
    const stop = Math.min(capacity, start + BLOCK);
    let blockPeak = 0;
    for (let i = start; i < stop; i++) {
      const scv = sc ? sc[i] : 0;
      let l = 0, r = 0;
      if (i < dryLength) {
        for (const v of voices) {
          if (v.done) continue;
          v.process(-scv * 2);
          l += v.l; r += v.r;
        }
        l *= voiceGain; r *= voiceGain;
      }
      sat.process(l, r); trans.process(sat.l, sat.r); chorus.process(trans.l, trans.r);
      eq.process(chorus.l, chorus.r);
      l = dcL.process(eq.l); r = dcR.process(eq.r);
      const mid = (l + r) * 0.5, side = (l - r) * 0.5 * width;
      l = mid + side; r = mid - side;

      let wl = 0, wr = 0;
      if (delay) { delay.process(l * dSend, r * dSend); wl += delay.l; wr += delay.r; }
      if (reverb) {
        const dl = delay ? delay.l * d2r : 0, dr = delay ? delay.r * d2r : 0;
        reverb.process(l * rSend + dl, r * rSend + dr);
        wl += reverb.l; wr += reverb.r;
      }
      if (duckAmt > 0) {
        const f = duckF.process((Math.abs(l) + Math.abs(r)) * 0.5);
        const g = 1 - duckAmt * clamp(f * 4, 0, 1);
        wl *= g; wr *= g;
      }
      if (sc) {
        const g = 1 - scAmt * scv;
        l *= g; r *= g; wl *= g; wr *= g;
      }
      dryL[i] = l; dryR[i] = r; wetL[i] = wl; wetR[i] = wr;
      const a = Math.max(Math.abs(l + wl), Math.abs(r + wr));
      if (a > blockPeak) blockPeak = a;
    }
    if (blockPeak > peak) peak = blockPeak;
    // After the dry part, stop once the tail is ~80 dB below the peak.
    if (stop > dryLength) {
      if (blockPeak < peak * 1e-4) { if (++quietBlocks >= 6) { end = stop; break; } }
      else quietBlocks = 0;
    }
  }
  const length = end;
  return {
    sr,
    dry: [dryL.subarray(0, length), dryR.subarray(0, length)],
    wet: [wetL.subarray(0, length), wetR.subarray(0, length)],
    length,
    dryLength: Math.min(dryLength, length),
    peak,
  };
}
