#!/usr/bin/env node
// frames.mjs --out <dir> [--cols 96]: Ash's header loop as one base grid plus delta rows.
// Poses are 2D warps of the one public Ash image (profile.json): a blink paints the eyes shut with
// the fur around them, a flap rotates each wing about its shoulder. The float is a CSS translate, so
// it costs no bytes. Every pose is sampled with one shared palette; a frame keeps only the rows that
// differ from the base, and CSS shows each frame's rows (and hides the base rows they replace) on its
// own steps of the loop.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, sample, palette, FONT } from './spike.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// darkest to brightest; the darkest is a dot, not a space, so pupils stay visible on a light page
export const RAMP = ".:-=+*o#%@";
export const STEP_S = 0.18;
// eye and wing geometry in source fractions (Ash plush, 900x959 original)
export const EYES = [{ cx: 0.361, cy: 0.287, rx: 0.072, ry: 0.062 }, { cx: 0.631, cy: 0.287, rx: 0.072, ry: 0.062 }];
export const WINGS = [
  { side: -1, x0: 0, x1: 0.29, y0: 0.46, y1: 0.7, px: 0.29, py: 0.53 },
  { side: 1, x0: 0.71, x1: 1, y0: 0.46, y1: 0.7, px: 0.71, py: 0.53 },
];
// [frame name or null for the base, float offset in 2 px units]
export const TIMELINE = [
  [null, 0], ['flap1', 1], ['flap2', 2], ['flap1', 3], [null, 3], ['flap1', 2], ['flap2', 1], ['flap1', 0],
  [null, 0], [null, 1], [null, 2], ['blink', 3], [null, 3], [null, 2], [null, 1], [null, 0],
];

const lumOf = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const clone = ({ w, h, px }) => ({ w, h, px: Buffer.from(px) });

export function blink(img) {
  const out = clone(img), { w, h, px } = out;
  for (const e of EYES) {
    const cx = e.cx * w, cy = e.cy * h, rx = e.rx * w, ry = e.ry * h;
    const ring = [];
    for (let y = Math.floor(cy - ry * 1.5); y <= cy + ry * 1.5; y++) for (let x = Math.floor(cx - rx * 1.5); x <= cx + rx * 1.5; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (d > 1.2 && d < 2) { const o = (y * w + x) * 4; ring.push([px[o], px[o + 1], px[o + 2]]); }
    }
    ring.sort((a, b) => lumOf(b) - lumOf(a));
    const top = ring.slice(0, Math.max(1, ring.length >> 1));
    const fur = [0, 1, 2].map((i) => Math.round(top.reduce((s, c) => s + c[i], 0) / top.length));
    for (let y = Math.floor(cy - ry * 1.05); y <= cy + ry * 1.05; y++) for (let x = Math.floor(cx - rx * 1.05); x <= cx + rx * 1.05; x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy > 1.1) continue;
      const o = (y * w + x) * 4;
      // a closed, smiling eye: a dark lash arc across the lower middle of the eye
      const arc = cy + ry * (0.15 + 0.35 * (1 - dx * dx));
      const lash = Math.abs(y - arc) < ry * 0.16 && Math.abs(dx) < 0.95;
      const c = lash ? [74, 36, 20] : fur;
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
    }
  }
  return out;
}

export function flap(img, degrees) {
  const out = clone(img), { w, h, px } = out, src = img.px;
  const inWing = (wg, x, y) => x >= wg.x0 * w && x < wg.x1 * w && y >= wg.y0 * h && y < wg.y1 * h;
  for (const wg of WINGS) {
    // lift the wing out, then draw it rotated about the shoulder (tips go up)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inWing(wg, x, y)) px[(y * w + x) * 4 + 3] = 0;
    const t = (-wg.side * degrees * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t), pX = wg.px * w, pY = wg.py * h;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = x - pX, dy = y - pY;
      const sx = Math.round(pX + dx * cos + dy * sin), sy = Math.round(pY - dx * sin + dy * cos);
      if (sx < 0 || sy < 0 || sx >= w || sy >= h || !inWing(wg, sx, sy)) continue;
      const so = (sy * w + sx) * 4, o = (y * w + x) * 4;
      if (src[so + 3] < 128) continue;
      if (px[o + 3] >= 128 && !inWing(wg, x, y)) continue; // the body stays in front of the wing
      src.copy(px, o, so, so + 4);
    }
  }
  return out;
}

// Glyph from luminance stretched over the Bud's own range, so the face's darks and lights separate.
function cells(grid, pal, [lo, hi]) {
  return grid.map((row) => row.map((c) => {
    if (!c) return null;
    const lum = lumOf(c), t = Math.max(0, Math.min(0.999, (lum - lo) / (hi - lo)));
    return { ch: RAMP[Math.floor(t * RAMP.length)], cls: pal.index(c), lum };
  }));
}

export function deltaRows(base, grid) {
  const rows = [];
  base.forEach((row, y) => {
    if (row.some((c, x) => { const d = grid[y][x]; return (c ? c.ch + c.cls : '') !== (d ? d.ch + d.cls : ''); })) rows.push(y);
  });
  return rows;
}

const loops = new Map(); // the same image bytes and grid always give the same loop
export function buildLoop({ src = join(ROOT, JSON.parse(readFileSync(join(ROOT, 'profile.json'), 'utf8')).bud.source.file), cols = 96 } = {}) {
  const bytes = readFileSync(src), key = `${cols}:${createHash('sha256').update(bytes).digest('hex')}`;
  if (!loops.has(key)) loops.set(key, makeLoop(bytes, cols));
  return loops.get(key);
}
function makeLoop(bytes, cols) {
  const img = decodePng(bytes);
  const poses = { base: img, flap1: flap(img, 10), flap2: flap(img, 20), blink: blink(img) };
  const sampled = Object.fromEntries(Object.entries(poses).map(([k, v]) => [k, sample(v, cols)]));
  const all = Object.values(sampled).flat();
  const pal = palette(all, 32);
  const lums = all.flat().filter(Boolean).map(lumOf).sort((a, b) => a - b);
  const range = [lums[Math.floor(lums.length * 0.02)], lums[Math.floor(lums.length * 0.98)]];
  const base = cells(sampled.base, pal, range);
  const frames = ['flap1', 'flap2', 'blink'].map((name, i) => ({ id: `f${i + 1}`, name, grid: cells(sampled[name], pal, range) }));
  const byName = Object.fromEntries(frames.map((f) => [f.name, f.id]));
  const timeline = TIMELINE.map(([name, dy]) => ({ frame: name ? byName[name] : null, dy }));
  return { base, frames, timeline, palette: pal.hex };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function rowText(row, y, cw, lh, cls = '') {
  const runs = [];
  row.forEach((c, x) => {
    if (!c) return;
    const last = runs[runs.length - 1];
    if (last && last.cls === c.cls && last.x + last.text.length === x) last.text += c.ch;
    else runs.push({ x, cls: c.cls, text: c.ch });
  });
  if (!runs.length) return `<text y="${+((y + 1) * lh).toFixed(2)}"${cls}></text>`;
  return `<text y="${+((y + 1) * lh).toFixed(2)}"${cls}>${runs.map((r) => `<tspan x="${+(r.x * cw).toFixed(2)}" class="c${r.cls}">${esc(r.text)}</tspan>`).join('')}</text>`;
}

// Opacity keyframes that hold each step's value to the next stop (step-end), plus the seam at 100%.
function visKeyframes(name, vis) {
  const n = vis.length;
  return `@keyframes ${name}{${vis.map((v, i) => `${+((i * 100) / n).toFixed(3)}%{opacity:${v ? 1 : 0}}`).join('')}100%{opacity:${vis[0] ? 1 : 0}}}`;
}

// GitHub's page backgrounds and text colours per theme
export const THEMES = { dark: { bg: '0d1117', text: 'e6edf3' }, light: { bg: 'ffffff', text: '1f2328' } };
const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const relLum = (rgb) => 0.2126 * lin(rgb[0] / 255) + 0.7152 * lin(rgb[1] / 255) + 0.0722 * lin(rgb[2] / 255);
export const rgbOf = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
export const contrast = (a, b) => { const [x, y] = [relLum(a), relLum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// The Bud's palette for one theme: each colour too close to the page is pushed away from it (toward
// white on dark, toward black on light) just far enough to read, so the hue stays.
export function themePalette(hex, theme, min = 1.8) {
  const bg = rgbOf(THEMES[theme].bg), to = theme === 'dark' ? 255 : 0;
  return hex.map((h) => {
    let c = rgbOf(h);
    for (let k = 0; k < 40 && contrast(c, bg) < min; k++) c = c.map((v) => Math.round(v + (to - v) * 0.08));
    return c.map((v) => v.toString(16).padStart(2, '0')).join('');
  });
}

export function loopSvg(loop, { fontSize = 10, theme = 'dark', tagline = '' } = {}) {
  const cw = +(fontSize * 0.6).toFixed(3), lh = fontSize * 1.2, n = loop.timeline.length, dur = +(n * STEP_S).toFixed(2);
  const cols = loop.base[0].length, rows = loop.base.length, W = +(cols * cw).toFixed(2), budH = (rows + 1) * lh + 6;
  const tagFont = 14, H = +(budH + (tagline ? tagFont * 1.8 : 0)).toFixed(2);
  const deltas = Object.fromEntries(loop.frames.map((f) => [f.id, deltaRows(loop.base, f.grid)]));
  // base rows grouped by the steps they are hidden on
  const patterns = new Map();
  const rowClass = loop.base.map((_, y) => {
    const vis = loop.timeline.map((s) => !(s.frame && deltas[s.frame].includes(y)));
    if (vis.every(Boolean)) return '';
    const key = vis.map(Number).join('');
    if (!patterns.has(key)) patterns.set(key, { name: `h${patterns.size}`, vis });
    return patterns.get(key).name;
  });
  const css = [
    `text{font-family:${FONT};font-size:${fontSize}px;white-space:pre}`,
    ...themePalette(loop.palette, theme).map((h, i) => `.c${i}{fill:#${h}}`),
    `#float{animation:float ${dur}s infinite step-end}`,
    `@keyframes float{${loop.timeline.map((s, i) => `${+((i * 100) / n).toFixed(3)}%{transform:translateY(${s.dy * 2}px)}`).join('')}100%{transform:translateY(${loop.timeline[0].dy * 2}px)}}`,
    ...[...patterns.values()].map((p) => `.${p.name}{animation:${p.name} ${dur}s infinite step-end}${visKeyframes(p.name, p.vis)}`),
    ...loop.frames.map((f) => `.${f.id}{opacity:0;animation:${f.id} ${dur}s infinite step-end}${visKeyframes(f.id, loop.timeline.map((s) => s.frame === f.id))}`),
    ...(tagline ? [
      // types one character per step over the first 35% of three Bud loops, then holds
      `#tagline{font-size:${tagFont}px;fill:#${THEMES[theme].text};animation:type ${+(dur * 3).toFixed(2)}s infinite steps(${tagline.length},end)}`,
      '@keyframes type{0%{clip-path:inset(0 100% 0 0)}35%{clip-path:inset(0 0 0 0)}100%{clip-path:inset(0 0 0 0)}}',
    ] : []),
    '@media (prefers-reduced-motion:reduce){*{animation:none!important}g[class^="f"]{opacity:0}}',
  ].join('\n');
  const tagX = +((W - tagline.length * tagFont * 0.6) / 2).toFixed(2), tagY = +(budH + tagFont * 1.2).toFixed(2);
  const tag = tagline ? `\n<text id="tagline" x="${Math.max(0, tagX)}" y="${tagY}">${esc(tagline)}</text>` : '';
  const base = loop.base.map((row, y) => rowText(row, y, cw, lh, rowClass[y] ? ` class="${rowClass[y]}"` : '')).join('\n');
  const frames = loop.frames.map((f) => `<g class="${f.id}">\n${deltas[f.id].map((y) => rowText(f.grid[y], y, cw, lh)).join('\n')}\n</g>`).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" data-cell="${cw}" role="img" aria-label="Ash, a SkyBuds plush, floating, flapping and blinking in colour ASCII">\n<style>\n${css}\n</style>\n<g id="float">\n<g class="base">\n${base}\n</g>\n${frames}\n</g>${tag}\n</svg>\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const out = opt('--out');
  if (!out) { console.error('usage: frames.mjs --out <dir> [--cols n]'); process.exit(2); }
  const loop = buildLoop({ cols: Number(opt('--cols', 96)) });
  const svg = loopSvg(loop);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'loop.svg'), svg);
  const deltas = Object.fromEntries(loop.frames.map((f) => [f.name, deltaRows(loop.base, f.grid).length]));
  writeFileSync(join(out, 'loop.json'), JSON.stringify({ cols: loop.base[0].length, rows: loop.base.length, colours: loop.palette.length, steps: loop.timeline.length, stepSeconds: STEP_S, timeline: loop.timeline, deltaRows: deltas, bytes: Buffer.byteLength(svg) }, null, 1) + '\n');
  console.log(`loop.svg ${Buffer.byteLength(svg)} B, ${loop.base[0].length}x${loop.base.length}, ${loop.timeline.length} steps, delta rows ${JSON.stringify(deltas)}`);
}
