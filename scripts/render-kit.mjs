#!/usr/bin/env node
// Render a stab kit to disk from the command line.
//   node scripts/render-kit.mjs --preset dub-chord --size 8 --seed demo --out out/
//   node scripts/render-kit.mjs --all --out out/   (one kit per preset)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderStab } from '../src/dsp/render.js';
import { defaultKitSettings, generateKit } from '../src/engine/variation.js';
import { PRESETS, PRESET_BY_ID } from '../src/engine/presets.js';
import { defaultExportSettings, prepareStab, normaliseGains, stabFiles, stabFileBase, kitFolderName } from '../src/engine/export.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));

const out = args.out ?? 'out';
const ids = args.all ? PRESETS.map((p) => p.id) : [args.preset ?? 'dub-chord'];

for (const id of ids) {
  const s = { ...defaultKitSettings(), presetId: id, size: Number(args.size ?? 8), seed: String(args.seed ?? 'demo') };
  if (args.mode) s.chordMode = args.mode;
  if (args.dissonance) s.dissonance = Number(args.dissonance);
  const pr = PRESET_BY_ID[id];
  if (pr?.chord) s.chord = { ...s.chord, ...pr.chord };
  const ex = { ...defaultExportSettings(), stems: args.stems ?? 'mix' };
  const kit = { ...s, presetName: pr?.name ?? id };
  const t0 = Date.now();
  const stabs = generateKit(s);
  const renders = stabs.map((st) => renderStab(st.patch, st.chord.notes, { sr: ex.sampleRate, bpm: s.bpm, seed: st.renderSeed, maxTail: ex.maxSeconds }));
  const gains = normaliseGains(renders, ex);
  const dir = join(out, kitFolderName(kit));
  mkdirSync(join(dir, 'stems'), { recursive: true });
  stabs.forEach((st, i) => {
    const prep = prepareStab(renders[i], ex, s.bpm, gains[i]);
    for (const f of stabFiles(prep, stabFileBase(st, kit), ex)) writeFileSync(join(dir, f.name), f.data);
  });
  console.log(`${pr?.name ?? id}: ${stabs.length} stabs in ${Date.now() - t0} ms -> ${dir}`);
  for (const st of stabs) console.log(`   ${String(st.index + 1).padStart(2)}  ${st.chord.name.padEnd(18)} ${st.info.tailLabel}${st.info.borrowed ? `  (+${st.info.borrowed.groups.join('/')} from ${st.info.borrowed.from})` : ''}`);
}
