// Linked folder: keeps the current kit's WAVs written into a folder on disk
// (Chrome/Edge File System Access API). Add that folder to Ableton Live's
// browser under Places and the stabs show up inside Live, ready to drag.
//
//   <linked folder>/Stab Lab - current kit/   mirrors the pads, rewritten as you edit
//   <linked folder>/Stab Lab - kept/          pads you saved with the ⬇ button

const DB = 'stablab', STORE = 'handles', KEY = 'linked';
export const CURRENT_DIR = 'Stab Lab - current kit';
export const KEPT_DIR = 'Stab Lab - kept';

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbPut(value) {
  try {
    const db = await openDb();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      if (value) tx.objectStore(STORE).put(value, KEY); else tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch { /* storage unavailable: link lasts for this session only */ }
}
async function dbGet() {
  try {
    const db = await openDb();
    return await new Promise((res) => {
      const g = db.transaction(STORE).objectStore(STORE).get(KEY);
      g.onsuccess = () => res(g.result ?? null);
      g.onerror = () => res(null);
    });
  } catch { return null; }
}

export async function writeFile(dir, path, data) {
  const parts = path.split('/');
  let d = dir;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(data);
  await w.close();
}

export class FolderLink {
  /**
   * @param {() => {key:string, names:string[], build:() => {name:string, data:Uint8Array}[]}[]} getGroups
   * @param {(state:string, detail?:string) => void} onState
   */
  constructor(getGroups, onState) {
    this.supported = typeof window.showDirectoryPicker === 'function';
    this.getGroups = getGroups;
    this.onState = onState;
    this.handle = null;
    this.state = 'off'; // off | needs-permission | linked
    this.written = new Map(); // file path -> content key
    this.timer = null;
    this.busy = false;
    this.again = false;
  }

  setState(s, detail) { this.state = s; this.onState(s, detail); }

  async init() {
    if (!this.supported) return;
    const h = await dbGet();
    if (!h) { this.setState('off'); return; }
    this.handle = h;
    let perm = 'prompt';
    try { perm = await h.queryPermission({ mode: 'readwrite' }); } catch { /* ignore */ }
    this.setState(perm === 'granted' ? 'linked' : 'needs-permission');
    if (perm === 'granted') this.schedule();
  }

  async link() {
    const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'stablab-link' });
    this.handle = h;
    this.written.clear();
    await dbPut(h);
    this.setState('linked');
    await this.sync();
  }

  async reconnect() {
    if (!this.handle) return this.link();
    const perm = await this.handle.requestPermission({ mode: 'readwrite' });
    if (perm === 'granted') { this.setState('linked'); this.written.clear(); await this.sync(); }
  }

  async unlink() {
    this.handle = null;
    this.written.clear();
    await dbPut(null);
    this.setState('off');
  }

  get name() { return this.handle?.name ?? ''; }

  schedule() {
    if (this.state !== 'linked') return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sync(), 400);
  }

  async sync() {
    if (this.state !== 'linked' || !this.handle) return;
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      const cur = await this.handle.getDirectoryHandle(CURRENT_DIR, { create: true });
      const groups = this.getGroups();
      const wanted = new Set();
      let wrote = 0;
      for (const g of groups) {
        for (const n of g.names) wanted.add(n);
        if (g.names.every((n) => this.written.get(n) === g.key)) continue;
        for (const f of g.build()) { await writeFile(cur, f.name, f.data); this.written.set(f.name, g.key); wrote++; }
      }
      // Remove files from pads that no longer exist or were renamed.
      const prune = async (dir, prefix) => {
        for await (const [name, h] of dir.entries()) {
          const path = prefix + name;
          if (h.kind === 'directory') await prune(h, path + '/');
          else if (name.endsWith('.wav') && !wanted.has(path)) { await dir.removeEntry(name); this.written.delete(path); }
        }
      };
      await prune(cur, '');
      this.onState('linked', wrote ? `updated ${wrote} file${wrote > 1 ? 's' : ''}` : '');
    } catch (err) {
      if (err?.name === 'NotAllowedError') this.setState('needs-permission');
      else this.onState('linked', `couldn't write: ${err.message}`);
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; this.schedule(); }
    }
  }

  /** Save one file into the "kept" folder (never overwritten by sync), optionally in its own subfolder. */
  async keep(name, data, sub = '') {
    let dir = await this.handle.getDirectoryHandle(KEPT_DIR, { create: true });
    if (sub) dir = await dir.getDirectoryHandle(sub, { create: true });
    let final = name, n = 2;
    // Don't overwrite an earlier keeper with the same name.
    for (;;) {
      try { await dir.getFileHandle(final); final = name.replace(/\.wav$/, ` (${n++}).wav`); } catch { break; }
    }
    await writeFile(dir, final, data);
    return sub ? `${sub}/${final}` : final;
  }
}
