// Tempo-synced stereo delay: stereo, ping-pong and tape modes.
// Filtering and saturation sit inside the feedback loop, so repeats darken
// and smear like a real dub delay.

import { clamp, fastTanh, DIVISIONS, beatsToSeconds, TWO_PI } from './util.js';
import { OnePoleLP, OnePoleHP } from './filters.js';

export const DELAY_MODES = ['stereo', 'pingpong', 'tape'];

class Line {
  constructor(size) { this.buf = new Float64Array(size); this.size = size; this.w = 0; }
  write(x) { this.buf[this.w] = x; this.w = (this.w + 1) % this.size; }
  read(d) {
    let rp = this.w - d; while (rp < 0) rp += this.size;
    const i = Math.floor(rp), f = rp - i;
    const a = this.buf[i], b = this.buf[(i + 1) % this.size];
    return a + (b - a) * f;
  }
}

export class StereoDelay {
  constructor(sr, bpm, p = {}) {
    this.sr = sr;
    this.mode = p.mode ?? 'pingpong';
    const beats = DIVISIONS[p.division ?? '1/8d'] ?? 0.75;
    const secs = clamp(beatsToSeconds(beats, bpm), 0.02, 2.5);
    this.dL = secs * sr;
    // In stereo mode the right side is offset for width.
    if (this.mode === 'stereo' && p.divisionR && DIVISIONS[p.divisionR]) {
      this.dR = clamp(beatsToSeconds(DIVISIONS[p.divisionR], bpm), 0.02, 2.9) * sr;
    } else {
      this.dR = this.mode === 'stereo' ? clamp(secs * (1 + (p.offset ?? 0.12)), 0.02, 2.9) * sr : this.dL;
    }
    const size = Math.ceil(3.2 * sr);
    this.L = new Line(size); this.R = new Line(size);
    this.fb = clamp(p.feedback ?? 0.4, 0, 0.97);
    this.lp = [new OnePoleLP(sr, p.lpf ?? 5000), new OnePoleLP(sr, p.lpf ?? 5000)];
    this.hp = [new OnePoleHP(sr, p.hpf ?? 200), new OnePoleHP(sr, p.hpf ?? 200)];
    this.sat = clamp(p.sat ?? 0.2, 0, 1);
    this.wow = this.mode === 'tape' ? clamp(p.wow ?? 0.4, 0, 1) : clamp(p.wow ?? 0, 0, 1) * 0.3;
    this.ph = 0; this.ph2 = 0.37;
    this.l = 0; this.r = 0;
  }
  sat1(x) {
    if (this.sat === 0) return x;
    const d = 1 + this.sat * 3;
    return fastTanh(x * d) / d;
  }
  /** Feed dry stereo input; writes wet-only output to this.l / this.r. */
  process(inL, inR) {
    const sr = this.sr;
    let mod = 0;
    if (this.wow > 0) {
      this.ph += 0.6 / sr; if (this.ph >= 1) this.ph -= 1;   // wow
      this.ph2 += 5.3 / sr; if (this.ph2 >= 1) this.ph2 -= 1; // flutter
      mod = (Math.sin(TWO_PI * this.ph) * 0.0022 + Math.sin(TWO_PI * this.ph2) * 0.00035) * sr * this.wow;
    }
    const yL = this.L.read(this.dL + mod + 2);
    const yR = this.R.read(this.dR + mod * 0.9 + 2);
    const fL = this.sat1(this.hp[0].process(this.lp[0].process(yL)));
    const fR = this.sat1(this.hp[1].process(this.lp[1].process(yR)));
    if (this.mode === 'pingpong') {
      const mono = (inL + inR) * 0.5;
      this.L.write(mono + fR * this.fb);
      this.R.write(fL * this.fb);
    } else {
      this.L.write(inL + fL * this.fb);
      this.R.write(inR + fR * this.fb);
    }
    this.l = yL; this.r = yR;
  }
}
