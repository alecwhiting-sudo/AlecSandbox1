#!/usr/bin/env node
// Builds dist/index.html: one self-contained file (JS, CSS and the render
// worker inlined) that runs from disk, any static host, or as a web page.

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
mkdirSync(out, { recursive: true });

const worker = await build({
  entryPoints: [join(root, 'src/worker.js')],
  bundle: true, format: 'iife', minify: true, write: false, target: 'es2020',
});
const workerSrc = worker.outputFiles[0].text;

const app = await build({
  entryPoints: [join(root, 'src/ui/app.js')],
  bundle: true, format: 'iife', minify: true, write: false, target: 'es2020',
  define: { __WORKER_SRC__: JSON.stringify(workerSrc) },
});
const js = app.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync(join(root, 'src/ui/style.css'), 'utf8');

let html = readFileSync(join(root, 'src/ui/index.html'), 'utf8');
html = html.replace('<link rel="stylesheet" href="./style.css">', () => `<style>\n${css}</style>`);
html = html.replace('<script type="module" src="./app.js"></script>', () => `<script>\n${js}</script>`);
writeFileSync(join(out, 'index.html'), html);
console.log(`dist/index.html  ${(html.length / 1024).toFixed(0)} KB`);

// claude.ai artifact variant: the host supplies doctype/html/head/body.
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1]
  .replace(/<meta charset[^>]*>\s*/, '').replace(/<meta name="viewport"[^>]*>\s*/, '');
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
const artifact = `${head.trim().replace('<title>Stab Lab</title>', '<title>Stab Lab</title>\n<meta name="claude:viewport-fit-sides" content="cover">')}\n${body.trim()}\n`;
writeFileSync(join(out, 'artifact.html'), artifact);
console.log(`dist/artifact.html  ${(artifact.length / 1024).toFixed(0)} KB`);
