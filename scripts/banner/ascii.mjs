// Image -> colour ASCII cells. Each cell is sampled on an SX x SY sub-grid; the glyph is the one whose ink
// pattern (Menlo masks, measured once at dev time) best matches the cell's brightness pattern, so outlines
// pick / \ ( ) _ | and flat fur picks dense glyphs. The colour is the average of the cell's inked pixels.
import { readFileSync } from 'node:fs';
import { decodePng } from './png.mjs';
import { MASKS, SX, SY } from './masks.mjs';

export function loadImage(path) { return decodePng(readFileSync(path)); }

// Crop to the alpha bounding box.
export function cropAlpha(img, thr = 24) {
  const { w, h, px } = img; let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) px.copy(out, y * cw * 4, ((y + y0) * w + x0) * 4, ((y + y0) * w + x1 + 1) * 4);
  return { w: cw, h: ch, px: out, box: [x0, y0, x1, y1] };
}

// Area-average the image onto a (cols*SX) x (rows*SY) grid; premultiplied colour + alpha per sub-cell.
export function subSample({ w, h, px }, cols, rows, view = [0, 0, w, h]) {
  const [vx, vy, vw, vh] = view, W = cols * SX, H = rows * SY, out = new Float32Array(W * H * 4);
  for (let j = 0; j < H; j++) {
    const fy0 = vy + (j * vh) / H, fy1 = vy + ((j + 1) * vh) / H;
    for (let i = 0; i < W; i++) {
      const fx0 = vx + (i * vw) / W, fx1 = vx + ((i + 1) * vw) / W;
      let R = 0, G = 0, B = 0, A = 0, n = 0;
      for (let y = Math.floor(fy0); y < Math.ceil(fy1); y++) {
        const wy = Math.min(fy1, y + 1) - Math.max(fy0, y);
        if (y < 0 || y >= h || wy <= 0) { n += Math.max(0, wy) * (fx1 - fx0); continue; }
        for (let x = Math.floor(fx0); x < Math.ceil(fx1); x++) {
          const wx = Math.min(fx1, x + 1) - Math.max(fx0, x);
          const wt = wx * wy; n += wt;
          if (x < 0 || x >= w) continue;
          const o = (y * w + x) * 4, a = (px[o + 3] / 255) * wt;
          R += px[o] * a; G += px[o + 1] * a; B += px[o + 2] * a; A += a;
        }
      }
      const o = (j * W + i) * 4;
      out[o] = A ? R / A : 0; out[o + 1] = A ? G / A : 0; out[o + 2] = A ? B / A : 0; out[o + 3] = A / n;
    }
  }
  return { W, H, cols, rows, data: out };
}

const value = (r, g, b) => Math.max(r, g, b) / 255;
const luma = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

// Glyph tables: masks scaled so the densest glyph's mean ink is 1.
export function glyphTable(chars) {
  const top = Math.max(...Object.values(MASKS).map((m) => m.reduce((s, v) => s + v, 0) / m.length));
  return chars.map((ch) => {
    const m = MASKS[ch].map((v) => v / top);
    return { ch, m, mean: m.reduce((s, v) => s + v, 0) / m.length };
  });
}

// Local contrast: unsharp-mask the sub-grid's brightness so eyes, mouths and outlines survive the downsample.
function sharpen(sub, amount, radius) {
  const { W, H, data } = sub, L = new Float32Array(W * H), B = new Float32Array(W * H), T = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = 0.55 * value(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) + 0.45 * luma(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  const blur1 = (src, dst, dx, dy) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, n = 0; for (let k = -radius; k <= radius; k++) { const xx = x + k * dx, yy = y + k * dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const a = data[(yy * W + xx) * 4 + 3]; s += src[yy * W + xx] * a; n += a; } dst[y * W + x] = n ? s / n : src[y * W + x]; } };
  blur1(L, T, 1, 0); blur1(T, B, 0, 1);
  return L.map((v, i) => v + amount * (v - B[i]));
}

// cells: sub-sampled image -> grid of {ch, rgb, ink} | null. Flat cells take a density ramp; cells whose
// brightness pattern varies (outlines, eyes, mouths) take the best-matching glyph shape.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);
export function toCells(sub, { glyphs, ramp, lo = 0.05, hi = 0.95, gamma = 1, minAlpha = 0.35, edge = 0.18, sharp = 0.8, radius = 3, floor = 0, dither = 0 } = {}) {
  const { W, cols, rows, data } = sub, n = SX * SY, Lm = sharpen(sub, sharp, radius);
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      const t = new Float32Array(n), col = [];
      let cover = 0;
      for (let sy = 0; sy < SY; sy++) for (let sx = 0; sx < SX; sx++) {
        const k = (r * SY + sy) * W + c * SX + sx, o = k * 4, a = data[o + 3];
        const v = Math.max(0, Math.min(1, (Lm[k] - lo) / (hi - lo))) ** gamma;
        t[sy * SX + sx] = a * (floor + (1 - floor) * v);
        cover += a; col.push([data[o], data[o + 1], data[o + 2], a]);
      }
      cover /= n;
      if (cover < minAlpha) { row.push(null); continue; }
      const tm = t.reduce((s, v) => s + v, 0) / n, sd = Math.sqrt(t.reduce((s, v) => s + (v - tm) ** 2, 0) / n);
      let best;
      if (sd < edge) best = { ch: ramp[Math.max(0, Math.min(ramp.length - 1, Math.floor(tm * ramp.length + dither * BAYER[(r % 4) * 4 + (c % 4)])))], m: null };
      else {
        let bc = Infinity;
        for (const g of glyphs) {
          let cost = 0;
          for (let i = 0; i < n; i++) { const d = t[i] - g.m[i]; cost += d * d; }
          cost = cost / n + 2 * (tm - g.mean) ** 2;
          if (cost < bc) { bc = cost; best = g; }
        }
      }
      // colour: weight sub-cells by alpha and brightness (the inked part of the cell)
      let R = 0, G = 0, B = 0, Wt = 0;
      col.forEach(([cr, cg, cb, a], i) => { const wt = a * (0.2 + (best.m ? best.m[i] : t[i])); R += cr * wt; G += cg * wt; B += cb * wt; Wt += wt; });
      row.push({ ch: best.ch, rgb: [R / Wt, G / Wt, B / Wt], ink: tm, edge: sd >= edge, cover });
    }
    grid.push(row);
  }
  return grid;
}
