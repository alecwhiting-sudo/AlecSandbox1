// "Labs" marks: one family of logos for Stab Lab and future Labs (Kick Lab,
// Hat Lab, ...). Drawn in RatMode's circuit-trace style (acid-orange traces
// with solder-pad rings on a dark grid) but with its own frame: a hexagon,
// where RatMode uses a diamond. Each Lab differs only by the glyph inside.
//
//   labMark('stab')  -> SVG markup string
//   LAB_GLYPHS       -> add a new Lab by adding a glyph here

const ORANGE = '#ff4500';
const BG = '#141414';
const GRID = '#2a1c14';

// Glyphs live in a 64x64 box; keep them inside roughly x 16..48, y 18..46.
// Use traces (stroked paths), pads (rings) and dots (filled vias).
export const LAB_GLYPHS = {
  // A stab: sharp attack, exponential decay, ending in a pad.
  stab: {
    name: 'Stab Lab',
    traces: ['M17 43 H22 V20 C25 33 31 39 44 41'],
    pads: [[46.5, 41.5]],
    dots: [[22, 20]],
  },
  // A kick: a thump, one big swing settling into smaller ones.
  kick: {
    name: 'Kick Lab',
    traces: ['M16 32 C19 15 25 15 27 32 S33 43 36 32 S40 27 42 32 S44.5 34.5 45 32'],
    pads: [[47.8, 32]],
    dots: [[16, 32]],
  },
  // Hats: three short bursts.
  hats: {
    name: 'Hat Lab',
    traces: ['M22 44 V28', 'M32 44 V22', 'M42 44 V31'],
    pads: [[22, 25.5], [32, 19.5], [42, 28.5]],
    dots: [],
  },
  // Snares / claps: a burst with a noisy tail.
  snare: {
    name: 'Snare Lab',
    traces: ['M17 43 H21 V21 L24 36 L27 28 L30 38 L33 32 L36 40 H44'],
    pads: [[46.5, 40]],
    dots: [[21, 21]],
  },
};

/** Flat-top hexagon points around (32, 32). */
function hexagon(r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    pts.push(`${(32 + r * Math.cos(a)).toFixed(2)},${(32 + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

/**
 * @param {keyof LAB_GLYPHS} kind
 * @param {{ size?: number, background?: boolean, title?: string }} [opts]
 */
export function labMark(kind = 'stab', { size = 64, background = true, title } = {}) {
  const g = LAB_GLYPHS[kind] ?? LAB_GLYPHS.stab;
  const label = title ?? g.name;
  const grid = [];
  for (let v = 8; v < 64; v += 14) {
    grid.push(`<path d="M${v} 0 V64 M0 ${v} H64" stroke="${GRID}" stroke-width="0.6"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${label}">`
    + `<title>${label}</title>`
    + (background ? `<rect width="64" height="64" rx="10" fill="${BG}"/>${grid.join('')}` : '')
    + `<polygon points="${hexagon(27)}" fill="none" stroke="${ORANGE}" stroke-width="3.4" stroke-linejoin="round"/>`
    + g.traces.map((d) => `<path d="${d}" fill="none" stroke="${ORANGE}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`).join('')
    + g.pads.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.6" fill="${BG}" stroke="${ORANGE}" stroke-width="2.4"/>`).join('')
    + g.dots.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.6" fill="${ORANGE}"/>`).join('')
    + '</svg>';
}

/** data: URI for favicons. */
export const labMarkDataUri = (kind, opts) =>
  `data:image/svg+xml,${encodeURIComponent(labMark(kind, opts))}`;
