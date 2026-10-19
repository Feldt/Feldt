#!/usr/bin/env node
// spike.mjs --out <dir> [--cols 72] [--src assets/bud/ash-plush-192.png]
// M1.T0 header spike: one colour ASCII frame of the Bud as an SVG GitHub can show in an <img>.
// - every colour run is its own <tspan x=…> on a fixed cell grid, so a font whose advance isn't
//   exactly 0.6em (Consolas, DejaVu) can only drift inside a run, never across the row;
// - the float is a CSS translate in steps() on the whole grid: it costs no bytes per frame, so only
//   the blink needs delta frames. projection.json estimates a 12-step loop from that.
// No dependencies: a small PNG decoder (8-bit RGB/RGBA, non-interlaced) on node:zlib.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RAMP = '.:-=+*#%@';
export const FONT = "Menlo,Consolas,'DejaVu Sans Mono','Liberation Mono',monospace";

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let p = 8, w, h, depth, type, inter;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString('latin1', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; inter = data[12]; }
    if (kind === 'IDAT') idat.push(data);
    if (kind === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || inter !== 0 || (type !== 6 && type !== 2)) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${inter})`);
  const bpp = type === 6 ? 4 : 3, stride = w * bpp, raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * 4), prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      px[o] = cur[x * bpp]; px[o + 1] = cur[x * bpp + 1]; px[o + 2] = cur[x * bpp + 2]; px[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    cur.copy(prev);
  }
  return { w, h, px };
}

// Box-average each cell; a cell under half covered is blank.
export function sample({ w, h, px }, cols) {
  const rows = Math.round((cols * h) / w / 2);
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * w) / cols), x1 = Math.max(x0 + 1, Math.floor(((c + 1) * w) / cols));
      const y0 = Math.floor((r * h) / rows), y1 = Math.max(y0 + 1, Math.floor(((r + 1) * h) / rows));
      let R = 0, G = 0, B = 0, A = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const o = (y * w + x) * 4, a = px[o + 3] / 255;
        R += px[o] * a; G += px[o + 1] * a; B += px[o + 2] * a; A += a; n++;
      }
      row.push(A / n < 0.5 ? null : [R / A, G / A, B / A]);
    }
    grid.push(row);
  }
  return grid;
}

// Bucket to 6 levels per channel, keep the most used `max` buckets, map the rest to the nearest kept one.
export function palette(grid, max = 28) {
  const key = ([r, g, b]) => [r, g, b].map((v) => Math.min(5, Math.round(v / 51))).join(',');
  const counts = new Map();
  for (const row of grid) for (const c of row) if (c) { const k = key(c); const e = counts.get(k) || { n: 0, s: [0, 0, 0] }; e.n++; c.forEach((v, i) => (e.s[i] += v)); counts.set(k, e); }
  const kept = [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, max).map(([k, e]) => ({ k, rgb: e.s.map((v) => Math.round(v / e.n)) }));
  const hex = kept.map(({ rgb }) => rgb.map((v) => v.toString(16).padStart(2, '0')).join(''));
  const index = (c) => {
    const i = kept.findIndex((p) => p.k === key(c));
    if (i >= 0) return i;
    let best = 0, bd = Infinity;
    kept.forEach((p, j) => { const d = p.rgb.reduce((s, v, t) => s + (v - c[t]) ** 2, 0); if (d < bd) { bd = d; best = j; } });
    return best;
  };
  return { hex, index };
}

const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function rowRuns(row, pal) {
  const runs = [];
  row.forEach((c, x) => {
    if (!c) return;
    const cls = pal.index(c), ch = RAMP[Math.min(RAMP.length - 1, Math.floor(lum(c) * RAMP.length))];
    const last = runs[runs.length - 1];
    if (last && last.cls === cls && last.x + last.text.length === x) last.text += ch;
    else runs.push({ x, cls, text: ch });
  });
  return runs;
}

export function frameSvg(grid, { fontSize = 10, steps = 8 } = {}) {
  const pal = palette(grid), cw = +(fontSize * 0.6).toFixed(3), lh = fontSize * 1.2;
  const cols = grid[0].length, rows = grid.length, W = +(cols * cw).toFixed(3), H = +(rows * lh + lh).toFixed(3);
  const body = grid.map((row, y) => {
    const runs = rowRuns(row, pal).map((r) => `<tspan x="${+(r.x * cw).toFixed(3)}" class="c${r.cls}">${esc(r.text)}</tspan>`).join('');
    return runs ? `<text y="${+((y + 1) * lh).toFixed(3)}">${runs}</text>` : '';
  }).join('\n');
  const css = [
    `text{font-family:${FONT};font-size:${fontSize}px;white-space:pre}`,
    ...pal.hex.map((h, i) => `.c${i}{fill:#${h}}`),
    `#bud{animation:float 2.4s steps(${steps},end) infinite}`,
    `@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(${lh}px)}}`,
    '@media (prefers-reduced-motion:reduce){#bud{animation:none}}',
  ].join('\n');
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" data-cell="${cw}" role="img" aria-label="Ash, a SkyBuds plush, drawn in colour ASCII">\n<style>\n${css}\n</style>\n<g id="bud">\n`;
  return { svg: `${head}${body}\n</g>\n</svg>\n`, body, head, cols, rows, colours: pal.hex.length };
}

// A 12-step loop: the float is CSS (no per-frame bytes); the blink swaps the eye rows in two frames.
export function projection(frame, frames = 12) {
  const bodyBytes = Buffer.byteLength(frame.body);
  const lines = frame.body.split('\n');
  const eyes = lines.slice(Math.floor(lines.length * 0.25), Math.floor(lines.length * 0.35)).join('\n');
  const blinkFrames = 2, eyeBytes = Buffer.byteLength(eyes);
  const frameBytes = Buffer.byteLength(frame.svg);
  const deltaBytes = frameBytes + blinkFrames * (eyeBytes + 200);
  return { frameBytes, frames, fullCopyBytes: Buffer.byteLength(frame.head) + frames * bodyBytes, deltaBytes, blinkFrames, eyeRowBytes: eyeBytes, fits: deltaBytes <= 150 * 1024, cols: frame.cols, rows: frame.rows, colours: frame.colours };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const out = opt('--out'), cols = Number(opt('--cols', 72)), src = resolve(ROOT, opt('--src', 'assets/bud/ash-plush-192.png'));
  if (!out) { console.error('usage: spike.mjs --out <dir> [--cols n] [--src png]'); process.exit(2); }
  const frame = frameSvg(sample(decodePng(readFileSync(src)), cols));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'frame.svg'), frame.svg);
  const p = projection(frame);
  writeFileSync(join(out, 'projection.json'), JSON.stringify(p, null, 2) + '\n');
  console.log(`frame.svg ${p.frameBytes} B, ${p.cols}x${p.rows}, ${p.colours} colours; 12-step loop ~${p.deltaBytes} B (full copies ${p.fullCopyBytes} B); fits=${p.fits}`);
}
