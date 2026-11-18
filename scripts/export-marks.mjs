#!/usr/bin/env node
// Writes every Lab mark to brand/<kind>-lab.svg (for the website, app icons, etc.).
import { writeFileSync, mkdirSync } from 'node:fs';
import { LAB_GLYPHS, labMark } from '../src/ui/labmark.js';

mkdirSync('brand', { recursive: true });
for (const kind of Object.keys(LAB_GLYPHS)) {
  writeFileSync(`brand/${kind}-lab.svg`, labMark(kind, { size: 512 }) + '\n');
  console.log(`brand/${kind}-lab.svg`);
}
