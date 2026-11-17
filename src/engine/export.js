// Export: tail length handling, normalisation, WAV encoding, ZIP packaging
// and file naming. Pure JS so it also runs in Node.

import { clamp, beatsToSeconds, dbToGain } from '../dsp/util.js';
import { NOTE_NAMES } from '../music/theory.js';

export function defaultExportSettings() {
  return {
    sampleRate: 48000,
    bitDepth: 24,
    stems: 'both',          // 'mix' | 'stems' (dry + tail) | 'both'
    lengthMode: 'auto',     // 'auto' (until silent) | 'snap' (round up to beat) | 'fixed'
    fixedBars: 2,
    maxSeconds: 16,
    fadeMs: 30,
    normalise: 'kit',       // 'kit' | 'each' | 'off'
    targetDb: -1,
  };
}

/** Decide final length in samples for a rendered stab. */
export function finalLength(rendered, ex, bpm) {
  const sr = rendered.sr;
  const max = Math.round(clamp(ex.maxSeconds ?? 16, 0.2, 60) * sr);
  let n = rendered.length;
  if (ex.lengthMode === 'fixed') {
    n = Math.round(beatsToSeconds((ex.fixedBars ?? 2) * 4, bpm) * sr);
  } else {
    // Trim trailing silence (~-70 dB relative to peak).
    const thr = Math.max(rendered.peak ?? 1, 1e-6) * 3e-4;
    const [dl, dr] = rendered.dry, [wl, wr] = rendered.wet;
    let last = rendered.dryLength;
    for (let i = rendered.length - 1; i >= rendered.dryLength; i--) {
      if (Math.abs(dl[i] + wl[i]) > thr || Math.abs(dr[i] + wr[i]) > thr) { last = i + 1; break; }
    }
    n = last;
    if (ex.lengthMode === 'snap') {
      const beat = beatsToSeconds(1, bpm) * sr;
      n = Math.ceil(n / beat) * beat;
    }
  }
  return Math.max(1, Math.min(Math.round(n), max));
}

/** Build output channels for a stab: { mix, dry, wet } each [L, R] at final length with fade. */
export function prepareStab(rendered, ex, bpm, gain = 1) {
  const n = finalLength(rendered, ex, bpm);
  const fade = Math.min(n, Math.round(((ex.fadeMs ?? 30) / 1000) * rendered.sr));
  const take = (src) => {
    const out = new Float32Array(n);
    out.set(src.subarray(0, Math.min(n, src.length)));
    // Only fade if we cut into audible signal.
    for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
    for (let i = 0; i < n; i++) out[i] *= gain;
    return out;
  };
  const dry = [take(rendered.dry[0]), take(rendered.dry[1])];
  const wet = [take(rendered.wet[0]), take(rendered.wet[1])];
  const mix = [new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) mix[c][i] = dry[c][i] + wet[c][i];
  return { sr: rendered.sr, length: n, dry, wet, mix };
}

export function peakOf(rendered) {
  let p = 0;
  for (let c = 0; c < 2; c++) {
    const d = rendered.dry[c], w = rendered.wet[c];
    for (let i = 0; i < rendered.length; i++) { const a = Math.abs(d[i] + w[i]); if (a > p) p = a; }
  }
  return p;
}

/** Gains per stab for normalisation. */
export function normaliseGains(renders, ex) {
  const target = dbToGain(ex.targetDb ?? -1);
  if (ex.normalise === 'off') return renders.map(() => 1);
  const peaks = renders.map((r) => (r ? peakOf(r) : 0));
  if (ex.normalise === 'each') return peaks.map((p) => (p > 0 ? target / p : 1));
  const kitPeak = Math.max(...peaks, 1e-9);
  return peaks.map(() => target / kitPeak);
}

// ---------- WAV ----------
export function encodeWav(channels, sr, bitDepth = 24) {
  const nch = channels.length, n = channels[0].length;
  const bytes = bitDepth / 8;
  const fmt = bitDepth === 32 ? 3 : 1;
  const dataSize = n * nch * bytes;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, fmt, true); v.setUint16(22, nch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nch * bytes, true); v.setUint16(32, nch * bytes, true);
  v.setUint16(34, bitDepth, true);
  str(36, 'data'); v.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const x = clamp(channels[c][i], -1, 1);
      if (bitDepth === 16) { v.setInt16(o, Math.round(x * 32767), true); o += 2; }
      else if (bitDepth === 24) {
        const s = Math.round(x * 8388607);
        v.setUint8(o, s & 0xff); v.setUint8(o + 1, (s >> 8) & 0xff); v.setUint8(o + 2, (s >> 16) & 0xff); o += 3;
      } else { v.setFloat32(o, x, true); o += 4; }
    }
  }
  return new Uint8Array(buf);
}

// ---------- ZIP (store, no compression; WAV barely compresses anyway) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {{name:string, data:Uint8Array}[]} files */
export function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint16(8, 0, true); h.setUint16(10, 0, true); h.setUint16(12, 0x21, true);
    h.setUint32(14, crc, true); h.setUint32(18, f.data.length, true); h.setUint32(22, f.data.length, true);
    h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, 0, true); c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true); c.setUint32(20, f.data.length, true); c.setUint32(24, f.data.length, true);
    c.setUint16(28, name.length, true); c.setUint16(30, 0, true); c.setUint16(32, 0, true);
    c.setUint16(34, 0, true); c.setUint16(36, 0, true); c.setUint32(38, 0, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)];
  const total = all.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

// ---------- naming ----------
const safe = (s) => String(s).replace(/[#]/g, 's').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

export function stabFileBase(stab, kit) {
  const idx = String(stab.index + 1).padStart(2, '0');
  const preset = safe(kit.presetName ?? 'stab').toLowerCase();
  return `${idx}_${safe(stab.chord.name)}_${kit.bpm}bpm_${preset}_${stab.info?.tailLabel ?? ''}`.replace(/_$/, '');
}

export function kitFolderName(kit) {
  return safe(`stabs_${NOTE_NAMES[kit.key]}${kit.scale === 'minor' ? 'm' : '-' + kit.scale}_${kit.bpm}bpm_${kit.presetName ?? ''}_${kit.seed}`);
}

/** Files to write for one prepared stab. */
export function stabFiles(prepared, base, ex) {
  const files = [];
  const bd = ex.bitDepth ?? 24;
  if (ex.stems === 'mix' || ex.stems === 'both') files.push({ name: `${base}.wav`, data: encodeWav(prepared.mix, prepared.sr, bd) });
  if (ex.stems === 'stems' || ex.stems === 'both') {
    files.push({ name: `stems/${base}_dry.wav`, data: encodeWav(prepared.dry, prepared.sr, bd) });
    files.push({ name: `stems/${base}_tail.wav`, data: encodeWav(prepared.wet, prepared.sr, bd) });
  }
  return files;
}
