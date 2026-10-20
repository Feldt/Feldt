// Deterministic k-means in OKLab: many glyph colours -> k palette entries (class names), so a run of
// neighbouring glyphs can share one <tspan>.
import { oklab } from './color.mjs';
export function quantize(colors, k, iters = 12) {
  const uniq = new Map();
  for (const c of colors) { const key = c.map((v) => Math.round(v)).join(','); const e = uniq.get(key); if (e) e.n++; else uniq.set(key, { rgb: c.map((v) => Math.round(v)), n: 1 }); }
  const pts = [...uniq.values()].map((e) => ({ ...e, lab: oklab(e.rgb) }));
  if (pts.length <= k) return { centers: pts.map((p) => p.rgb), index: (c) => pts.findIndex((p) => p.rgb.join() === c.map((v) => Math.round(v)).join()) };
  pts.sort((a, b) => a.lab[0] - b.lab[0]); // a stable sort: equal lightness keeps first-seen order
  // seed: farthest-point from the most common colour (deterministic)
  const seeds = [pts.reduce((a, b) => (b.n > a.n ? b : a)).lab];
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const dist = pts.map((p) => d2(p.lab, seeds[0]));
  while (seeds.length < k) {
    let bi = 0, bv = -1; pts.forEach((p, i) => { const v = dist[i] * Math.sqrt(p.n); if (v > bv) { bv = v; bi = i; } });
    seeds.push(pts[bi].lab); pts.forEach((p, i) => { dist[i] = Math.min(dist[i], d2(p.lab, pts[bi].lab)); });
  }
  let C = seeds.map((s) => [...s]);
  const assign = new Int32Array(pts.length);
  for (let it = 0; it < iters; it++) {
    pts.forEach((p, i) => { let b = 0, bd = Infinity; C.forEach((c, j) => { const d = d2(p.lab, c); if (d < bd) { bd = d; b = j; } }); assign[i] = b; });
    const S = C.map(() => [0, 0, 0, 0]);
    pts.forEach((p, i) => { const s = S[assign[i]]; s[0] += p.lab[0] * p.n; s[1] += p.lab[1] * p.n; s[2] += p.lab[2] * p.n; s[3] += p.n; });
    // weights are counts (>= 1 per point): Math.max only matters for a cluster left empty (it moves to black)
    C = S.map((s) => [s[0], s[1], s[2]].map((v) => v / Math.max(s[3], 1)));
  }
  // centres back to sRGB as the mean of member colours (keeps them in gamut)
  const R = C.map(() => [0, 0, 0, 0]);
  pts.forEach((p, i) => { const r = R[assign[i]]; r[0] += p.rgb[0] * p.n; r[1] += p.rgb[1] * p.n; r[2] += p.rgb[2] * p.n; r[3] += p.n; });
  const centers = R.map((r) => [r[0], r[1], r[2]].map((v) => Math.round(v / Math.max(r[3], 1))));
  const labs = centers.map(oklab);
  const cache = new Map();
  const index = (c) => { const key = c.map((v) => Math.round(v)).join(','); if (cache.has(key)) return cache.get(key); const l = oklab(c); let b = 0, bd = Infinity; labs.forEach((x, j) => { const d = d2(l, x); if (d < bd) { bd = d; b = j; } }); cache.set(key, b); return b; };
  return { centers, index };
}
