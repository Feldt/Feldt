// Org avatar -> pixel-art logo, no dependencies. GitHub serves README SVGs under a CSP that blocks every
// image inside the SVG, so the avatar is redrawn as vector cells: crisp at any zoom, a few KB per logo.
// The result is plain JSON ({ n, bleed, pal, px }) so it can be stored in data.json and re-rendered byte for byte.
import { decodePng, isPng } from './png.mjs';

const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
// cheap perceptual distance (redmean)
function dist(a, b) {
  const rm = (a[0] + b[0]) / 2, dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}
// palette index -> letter; px is run-length coded: a letter, then its run length when over 1 ('a12b3c')
const CODES = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const rle = (s) => s.replace(/(.)\1*/g, (m, c) => (m.length > 1 ? c + m.length : c));
export const unrle = (s) => s.replace(/([A-Za-z])(\d*)/g, (_, c, k) => c.repeat(k ? Number(k) : 1));

// opts.n: cells per side (64 keeps small marks like the NASA swoosh); opts.aa: blend steps on edges (default 3;
// 0 = hard pixel art, where opts.rarity sets how much louder rare colours vote); opts.maxColors: palette cap; opts.minShare: colours covering less than this share of the
// logo are folded into their nearest neighbour (anti-aliasing fringes), so edges stay clean.
export function logoFromImage({ width: w, height: h, data }, opts = {}) {
  const { n = 64, maxColors = 10, minShare = 0.004 } = opts;
  if (!('aa' in opts)) opts = { ...opts, aa: 3 };
  // 1. crop to the opaque content (drops transparent margins and soft drop shadows)
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 200) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  if (x1 < 0) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; }
  const at = (x, y) => { x = Math.min(w - 1, Math.max(0, Math.floor(x))); y = Math.min(h - 1, Math.max(0, Math.floor(y))); const o = (y * w + x) * 4; const a = data[o + 3] / 255; return [data[o] * a + 255 * (1 - a), data[o + 1] * a + 255 * (1 - a), data[o + 2] * a + 255 * (1 - a), data[o + 3]]; };
  // A solid avatar background (opaque, alike corners, sampled a little inside so rounded corners still count)
  // fills the whole plate: crop to the inner square. Otherwise the logo is padded on white: crop to the outer square.
  const solid = (sx, sy, side) => {
    const ins = side * 0.06;
    const c = [[sx + ins, sy + ins], [sx + side - 1 - ins, sy + ins], [sx + ins, sy + side - 1 - ins], [sx + side - 1 - ins, sy + side - 1 - ins]].map(([x, y]) => at(x, y));
    return c.every((k) => k[3] > 200 && dist(k, c[0]) < 110);
  };
  const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2, inner = Math.min(x1 - x0 + 1, y1 - y0 + 1), outer = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  const bleed = solid(cx - inner / 2, cy - inner / 2, inner);
  const side = bleed ? inner : outer, sx = cx - side / 2, sy = cy - side / 2;
  // 2. sample the crop on a fine grid (4x4 samples per cell), composited over white
  const S = 4, N = n * S, samples = new Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) samples[j * N + i] = at(sx + ((i + 0.5) * side) / N, sy + ((j + 0.5) * side) / N);
  // 3. palette: greedy over a 5-bit histogram, then one refinement pass to the mean of each cluster
  const hist = new Map();
  for (const s of samples) { const k = ((s[0] >> 3) << 10) | ((s[1] >> 3) << 5) | (s[2] >> 3); const e = hist.get(k) || [0, 0, 0, 0]; e[0]++; e[1] += s[0]; e[2] += s[1]; e[3] += s[2]; hist.set(k, e); }
  const bins = [...hist.values()].map((e) => [e[1] / e[0], e[2] / e[0], e[3] / e[0], e[0]]).sort((a, b) => b[3] - a[3]);
  let pal = [];
  for (const b of bins) { if (pal.length >= maxColors) break; if (pal.every((p) => dist(p, b) > 70)) pal.push(b.slice(0, 3)); }
  const nearest = (s, p = pal) => { let bi = 0, bd = Infinity; for (let i = 0; i < p.length; i++) { const d = dist(s, p[i]); if (d < bd) { bd = d; bi = i; } } return bi; };
  for (let pass = 0; pass < 3; pass++) {
    const acc = pal.map(() => [0, 0, 0, 0]);
    for (const s of samples) { const a = acc[nearest(s)]; a[0] += s[0]; a[1] += s[1]; a[2] += s[2]; a[3]++; }
    // drop fringe colours, keep the rest at their cluster mean
    const keep = acc.map((a, i) => [a, i]).filter(([a]) => a[3] / samples.length >= minShare);
    pal = keep.map(([a]) => [a[0] / a[3], a[1] / a[3], a[2] / a[3]]);
  }
  // snap near-white and near-black to pure (logos are usually designed that way)
  pal = pal.map((c) => (c.every((v) => v > 244) ? [255, 255, 255] : c.every((v) => v < 14) ? [0, 0, 0] : c));
  // 4. cells: coverage vote per palette colour; the dominant colour (background) votes at 0.65 so thin strokes survive
  const assign = samples.map((s) => nearest(s));
  const counts = pal.map(() => 0); for (const a of assign) counts[a]++;
  const bg = counts.indexOf(Math.max(...counts));
  // order palette by coverage so the background is index 0
  const order = pal.map((_, i) => i).sort((a, b) => counts[b] - counts[a]);
  const remap = new Map(order.map((o, i) => [o, i]));
  let px = '';
  if (opts.aa) {
    // anti-aliased cells: a cell on an edge between two palette colours takes a blend of them (in steps of 1/aa),
    // so diagonal edges and thin strokes stay smooth at small sizes instead of stair-stepping
    const steps = opts.aa, extra = new Map(), cells = [];
    const lerp = (a, b, t) => [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * t);
    for (let cy2 = 0; cy2 < n; cy2++) for (let cx2 = 0; cx2 < n; cx2++) {
      const m = [0, 0, 0];
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) { const s = samples[(cy2 * S + j) * N + cx2 * S + i]; m[0] += s[0]; m[1] += s[1]; m[2] += s[2]; }
      for (let k = 0; k < 3; k++) m[k] /= S * S;
      // the two palette colours whose blend best explains the cell mean
      let best = [nearest(m), nearest(m), 0, dist(m, pal[nearest(m)])];
      for (let a = 0; a < pal.length; a++) for (let b = a + 1; b < pal.length; b++) {
        const A = pal[a], B = pal[b], d = [0, 1, 2].map((k) => B[k] - A[k]), len = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
        if (!len) continue;
        const t = Math.min(1, Math.max(0, ((m[0] - A[0]) * d[0] + (m[1] - A[1]) * d[1] + (m[2] - A[2]) * d[2]) / len));
        const q = Math.round(t * steps) / steps, e = dist(m, lerp(A, B, t));
        if (e + 4 < best[3]) best = [a, b, q, e];
      }
      const [a, b, q] = best;
      if (q === 0 || q === 1) cells.push(q === 0 ? a : b);
      else { const key = `${a},${b},${q}`; if (!extra.has(key)) extra.set(key, lerp(pal[a], pal[b], q)); cells.push(key); }
    }
    const all = [...pal, ...extra.values()], keyIndex = new Map([...extra.keys()].map((k, i) => [k, pal.length + i]));
    const idx = cells.map((c) => (typeof c === 'number' ? c : keyIndex.get(c)));
    const cnt = all.map(() => 0); for (const i of idx) cnt[i]++;
    const ord = all.map((_, i) => i).filter((i) => cnt[i] > 0).sort((x, y) => cnt[y] - cnt[x] || x - y);
    const re = new Map(ord.map((o, i) => [o, i]));
    for (const i of idx) px += CODES[re.get(i)];
    return { n, bleed, pal: ord.map((o) => hex(...all[o])), px: rle(px) };
  }
  // rarer colours vote louder (thin accents like a swoosh or an outline survive the downsample), the background least
  const weight = counts.map((k, i) => (i === bg ? 0.65 : 1) * Math.min(4, Math.pow(samples.length / Math.max(1, k), opts.rarity ?? 0.35)));
  for (let cy2 = 0; cy2 < n; cy2++) for (let cx2 = 0; cx2 < n; cx2++) {
    const vote = new Map();
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) { const a = assign[(cy2 * S + j) * N + cx2 * S + i]; vote.set(a, (vote.get(a) || 0) + weight[a]); }
    let best = bg, bv = -1; for (const [k, v] of vote) if (v > bv || (v === bv && k < best)) { bv = v; best = k; }
    px += CODES[remap.get(best)];
  }
  return { n, bleed, pal: order.map((o) => hex(...pal[o])), px: rle(px) };
}

export const logoFromPng = (buf, opts) => (isPng(buf) ? logoFromImage(decodePng(buf), opts) : null);

// The logo's cells as SVG: the background colour as one square, then one path per other colour, made of
// rectangles merged across runs and rows (no seams inside a colour, few bytes).
export function logoCells(logo) {
  const { n, pal } = logo, px = unrle(logo.px), out = [];
  if (px.length !== n * n) throw new Error('logo cells do not match its size');
  const at = (x, y) => CODES.indexOf(px[y * n + x]);
  const used = new Uint8Array(n * n);
  const paths = pal.map(() => []);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (used[y * n + x]) continue;
    const c = at(x, y);
    if (c === 0) continue;
    let w = 1; while (x + w < n && !used[y * n + x + w] && at(x + w, y) === c) w++;
    let h = 1; grow: while (y + h < n) { for (let k = 0; k < w; k++) if (used[(y + h) * n + x + k] || at(x + k, y + h) !== c) break grow; h++; }
    for (let j = 0; j < h; j++) for (let k = 0; k < w; k++) used[(y + j) * n + x + k] = 1;
    paths[c].push(`M${x} ${y}h${w}v${h}h-${w}z`);
  }
  out.push(`<rect width="${n}" height="${n}" fill="${pal[0]}"/>`);
  for (let c = 1; c < pal.length; c++) if (paths[c].length) out.push(`<path fill="${pal[c]}" d="${paths[c].join('')}"/>`);
  return out.join('');
}
