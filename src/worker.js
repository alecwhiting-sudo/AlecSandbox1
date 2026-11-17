// Render worker: renders stabs off the main thread, one per task so a newer
// job can cancel an older one between stabs.

import { renderStab } from './dsp/render.js';

let currentJob = 0;
let queue = [];
let opts = null;
let scheduled = false;

function pump() {
  scheduled = false;
  const item = queue.shift();
  if (!item) { self.postMessage({ type: 'done', jobId: currentJob }); return; }
  const r = renderStab(item.patch, item.notes, { ...opts, seed: item.renderSeed });
  const msg = {
    type: 'stab', jobId: currentJob, uid: item.uid, index: item.index,
    sr: r.sr, length: r.length, dryLength: r.dryLength, peak: r.peak,
    dry: [r.dry[0].slice(), r.dry[1].slice()], wet: [r.wet[0].slice(), r.wet[1].slice()],
  };
  self.postMessage(msg, [msg.dry[0].buffer, msg.dry[1].buffer, msg.wet[0].buffer, msg.wet[1].buffer]);
  schedule();
}

function schedule() {
  if (!scheduled) { scheduled = true; setTimeout(pump, 0); }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'render') {
    currentJob = m.jobId;
    queue = m.items;
    opts = m.opts;
    schedule();
  }
};
