// Scene pieces drawn as small procedural images, then turned into colour ASCII with the same sampler as
// the Buds: sun, clouds, hills, meadow, flowers, the ball, butterflies, sparkles. Seeded, so every run
// writes the same bytes.
import { subSample, toCells, glyphTable } from './ascii.mjs';
import { SX, SY } from './masks.mjs';
import { maskPath } from './contour.mjs';
import { mix } from './color.mjs';

export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

// A w x h RGBA image from fn(x, y) -> [r, g, b, a(0..1)] | null, supersampled 2x2.
export function raster(w, h, fn) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let R = 0, G = 0, B = 0, A = 0;
    for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const c = fn(x + dx, y + dy); if (!c || c[3] <= 0) continue;
      R += c[0] * c[3]; G += c[1] * c[3]; B += c[2] * c[3]; A += c[3];
    }
    const o = (y * w + x) * 4;
    if (A > 0) { px[o] = Math.round(R / A); px[o + 1] = Math.round(G / A); px[o + 2] = Math.round(B / A); px[o + 3] = Math.round((A / 4) * 255); }
  }
  return { w, h, px };
}

export const SCENE_GLYPHS = glyphTable([...' .,:;\'"`^-_~=+*<>!|/\\()[]{}#%@&8oO0']);
export const SCENE_RAMP = ' .:-=+*o#%@';

// image -> ASCII sprite on `cols` columns: cells (r, c, ch, rgb) and the silhouette path, in 6x10 cell units
export function spriteOf(img, cols, { ascii = {}, silhouette = false } = {}) {
  const cwPx = img.w / cols, chPx = cwPx / 0.6, rows = Math.ceil(img.h / chPx);
  const sub = subSample(img, cols, rows, [0, 0, cols * cwPx, rows * chPx]);
  const grid = toCells(sub, { glyphs: SCENE_GLYPHS, ramp: SCENE_RAMP, lo: 0.1, hi: 0.9, gamma: 0.8, edge: 0.2, sharp: 0.6, radius: 3, floor: 0.2, ...ascii });
  const cells = [];
  grid.forEach((row, r) => row.forEach((c, k) => { if (c) cells.push({ r, c: k, ...c }); }));
  const sil = silhouette ? maskPath((x, y) => sub.data[(y * sub.W + x) * 4 + 3] > 0.5, sub.W, sub.H, { sx: 6 / SX, sy: 10 / SY, tol: 0.8, minArea: 6, smooth: 2 }) : '';
  return { rows, cells, sil, W: cols * 6, H: rows * 10 };
}

// ---- pieces --------------------------------------------------------------------------------------------
// Cumulus: a flat-bottomed union of circles, lit from the top, as a grey map whose brightness is the amount
// of shadow (so the ASCII sampler puts dense glyphs in the shade and leaves the lit tops clean), with the
// cloud's alpha.
export function cloudImage(seed, { w, h }) {
  // a few distinct bumps (one big crown, smaller shoulders) over a long flat-bottomed base
  const R = rng(seed), n = 3 + Math.floor(R() * 3), base = h * 0.86, blobs = [];
  const crown = 0.38 + R() * 0.24;
  for (let i = 0; i < n; i++) {
    const t = 0.14 + (0.72 * i) / (n - 1) + (R() - 0.5) * 0.06;
    const lift = 0.62 + 0.15 * R(), r = Math.min((base - 3) / (1 + lift), h * (0.24 + 0.34 * Math.exp(-(((t - crown) / 0.22) ** 2)) + 0.06 * R()));
    blobs.push([w * t, base - r * lift, r]);
  }
  blobs.push([w * 0.5, base - h * 0.16, -1]); // the base: a capsule along the bottom
  const capsule = (x, y) => { const hx = w * 0.42, ry = h * 0.2, cx = Math.max(w * 0.5 - hx, Math.min(w * 0.5 + hx, x)); return ry - Math.hypot(x - cx, y - (base - ry)); };
  return raster(w, h, (x, y) => {
    if (y > base) return null;
    let d = -1e9, d2 = -1e9, ny = 0, nx = 0;
    for (const [bx, by, r] of blobs) {
      const v = r < 0 ? capsule(x, y) : r - Math.hypot(x - bx, y - by);
      if (v > d) { if (r > 0 && d > d2) d2 = d; d = v; ny = r < 0 ? 0.2 + 0.5 * (y - (base - h * 0.2)) / (h * 0.2) : (y - by) / r; nx = r < 0 ? 0 : (x - bx) / r; } else if (r > 0 && v > d2) d2 = v;
    }
    if (d < 0) return null;
    // lit from the upper left: light texture everywhere, more toward each bump's lower right, the base in shadow
    const v = clamp(0.2 + 0.55 * smooth(-0.3, 0.95, ny * 0.9 + nx * 0.35) + 0.12 * smooth(base - h * 0.28, base, y));
    return [255 * v, 255 * v, 255 * v, smooth(0, 2, d)];
  });
}

// Sun disc: white-hot centre to candy orange rim.
export function sunImage(r) {
  const s = Math.ceil(r * 2);
  return raster(s, s, (x, y) => {
    const d = Math.hypot(x - r, y - r) / r; if (d > 1) return null;
    const c = d < 0.45 ? mix([255, 255, 236], [255, 236, 120], d / 0.45) : mix([255, 236, 120], [255, 168, 40], (d - 0.45) / 0.55);
    return [...c, smooth(1, 0.94, d)];
  });
}

// Beach ball: six candy segments, a glossy highlight, a soft shadow side.
export function ballImage(r) {
  const s = Math.ceil(r * 2), cols = [[255, 64, 96], [255, 220, 60], [64, 160, 255], [255, 255, 255], [80, 220, 120], [255, 140, 40]];
  return raster(s, s, (x, y) => {
    const dx = (x - r) / r, dy = (y - r) / r, d = Math.hypot(dx, dy); if (d > 1) return null;
    const z = Math.sqrt(1 - d * d), ang = Math.atan2(dy, dx * 0.9 + z * 0.25);
    const seg = cols[Math.floor(((ang + Math.PI) / (2 * Math.PI)) * 6) % 6];
    const shade = clamp(0.55 + 0.45 * (-dx * 0.45 - dy * 0.6 + z * 0.7));
    let c = seg.map((v) => v * (0.55 + 0.45 * shade));
    const hl = Math.hypot(dx + 0.35, dy + 0.42); if (hl < 0.28) c = mix(c, [255, 255, 255], smooth(0.28, 0.08, hl));
    if (d < 0.16) c = mix(c, [255, 255, 255], 0.7);
    return [...c.map(Math.round), smooth(1, 0.93, d)];
  });
}
