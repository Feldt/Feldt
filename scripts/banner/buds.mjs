// The three Buds as colour-ASCII sprites. Each Bud: one glyph grid sampled from its public render, cut into
// parts that move on their own (Ash's wings, Pearl's tail, Sprout's leaf), plus an eyes-shut copy of the
// eye cells for the blink. Behind the glyphs sits the Bud's silhouette (a dark backing with an outline), so
// the face reads on any sky and the dark pupils stay dark.
import { decodePng } from './png.mjs';
import { cropAlpha, subSample, toCells, glyphTable } from './ascii.mjs';
import { SX, SY } from './masks.mjs';
import { maskPath } from './contour.mjs';
import { lch, candy } from './color.mjs';

// Geometry only, in fractions of the alpha-cropped render. Which render each Bud is drawn from, and its sha256,
// is profile.json's buds (render.mjs budInputs), so the gate pins every banner input.
export const BUDS = {
  ash: {
    lash: [92, 38, 20], outline: '3a1606',
    eyes: [{ cx: 0.362, cy: 0.287, rx: 0.068, ry: 0.06 }, { cx: 0.632, cy: 0.287, rx: 0.068, ry: 0.06 }],
    parts: [
      { id: 'wl', pivot: [0.30, 0.52], poly: [[0, 0.44], [0.285, 0.44], [0.30, 0.50], [0.30, 0.69], [0, 0.69]] },
      { id: 'wr', pivot: [0.70, 0.52], poly: [[1, 0.44], [0.715, 0.44], [0.70, 0.50], [0.70, 0.69], [1, 0.69]] },
    ],
  },
  pearl: {
    lash: [24, 30, 80], outline: '0c1a4a',
    eyes: [{ cx: 0.219, cy: 0.372, rx: 0.072, ry: 0.058 }, { cx: 0.502, cy: 0.372, rx: 0.072, ry: 0.058 }],
    parts: [
      { id: 'tl', pivot: [0.63, 0.80], poly: [[0.585, 0.62], [1, 0.62], [1, 0.92], [0.70, 0.92], [0.66, 0.86], [0.60, 0.84]] },
    ],
  },
  sprout: {
    lash: [70, 40, 26], outline: '13300f',
    eyes: [{ cx: 0.331, cy: 0.346, rx: 0.072, ry: 0.055 }, { cx: 0.655, cy: 0.346, rx: 0.072, ry: 0.055 }],
    parts: [
      { id: 'lf', pivot: [0.485, 0.098], poly: [[0.37, 0], [0.62, 0], [0.62, 0.098], [0.37, 0.098]] },
    ],
  },
};

const inPoly = (poly, x, y) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
const lumOf = (px, o) => 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];

// Eyes shut: paint each eye with the fur around it, then a soft dark lash curve (a calm, happy blink).
export function shutEyes(img, eyes, lash) {
  const { w, h } = img, px = Buffer.from(img.px);
  for (const e of eyes) {
    const cx = e.cx * w, cy = e.cy * h, rx = e.rx * w, ry = e.ry * h, ring = [];
    for (let y = Math.floor(cy - ry * 1.7); y <= cy + ry * 1.7; y++) for (let x = Math.floor(cx - rx * 1.7); x <= cx + rx * 1.7; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2, o = (y * w + x) * 4;
      if (d > 1.35 && d < 2.6 && px[o + 3] > 200) ring.push([px[o], px[o + 1], px[o + 2]]);
    }
    ring.sort((a, b) => (0.2126 * b[0] + 0.7152 * b[1] + 0.0722 * b[2]) - (0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]));
    const top = ring.slice(Math.floor(ring.length * 0.15), Math.max(2, Math.floor(ring.length * 0.6)));
    const fur = [0, 1, 2].map((i) => Math.round(top.reduce((s, c) => s + c[i], 0) / top.length));
    for (let y = Math.floor(cy - ry * 1.25); y <= cy + ry * 1.25; y++) for (let x = Math.floor(cx - rx * 1.25); x <= cx + rx * 1.25; x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry, d = dx * dx + dy * dy;
      if (d > 1.45) continue;
      const o = (y * w + x) * 4;
      const arc = cy + ry * (0.05 + 0.4 * (1 - dx * dx)), lashOn = Math.abs(y - arc) < ry * 0.2 && Math.abs(dx) < 1.0;
      const c = lashOn ? lash : fur, k = d > 1.2 && !lashOn ? (1.45 - d) / 0.25 : 1; // feather the rim
      for (let i = 0; i < 3; i++) px[o + i] = Math.round(px[o + i] * (1 - k) + c[i] * k);
      px[o + 3] = 255;
    }
  }
  return { ...img, px };
}

// Eyes open, with more punch: inside each eye the darks go darker and the catch-lights go white, so the
// eyes survive the downsample and read as big, glossy and alive.
export function punchEyes(img, eyes, { dark = 0.5, light = 0.7 } = {}) {
  const { w, h } = img, px = Buffer.from(img.px);
  for (const e of eyes) {
    const cx = e.cx * w, cy = e.cy * h, rx = e.rx * w * 1.1, ry = e.ry * h * 1.15;
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2; if (d > 1) continue;
      const o = (y * w + x) * 4, L = lumOf(px, o) / 255, k = 1 - Math.max(0, d - 0.7) / 0.3; // feather the rim
      if (L < 0.42) for (let i = 0; i < 3; i++) px[o + i] = Math.round(px[o + i] * (1 - k * (1 - dark) * (1 - L / 0.42 * 0.5)));
      else if (L > 0.72) for (let i = 0; i < 3; i++) px[o + i] = Math.round(px[o + i] + (255 - px[o + i]) * light * k);
    }
  }
  return { ...img, px };
}

export const BUD_GLYPHS = glyphTable([...' .,:;\'"`^-_~=+*<>!|/\\()[]{}#%@&$8xoO0QWM']);
export const BUD_RAMP = ' .:-=+*o#%&@';

// One Bud sprite on a grid of `cols` columns, from its render's PNG bytes. Cell (r, c) sits at (c*6, r*10) in sprite units.
export function budSprite(name, png, { cols, ascii = {} }) {
  const spec = BUDS[name], img = punchEyes(cropAlpha(decodePng(png)), BUDS[name].eyes);
  const cwPx = img.w / cols, chPx = cwPx / 0.6, rows = Math.ceil(img.h / chPx);
  const view = [0, 0, cols * cwPx, rows * chPx];
  const opts = { glyphs: BUD_GLYPHS, ramp: BUD_RAMP, lo: 0.1, hi: 0.85, gamma: 0.8, edge: 0.2, sharp: 1.2, radius: 4, floor: 0.15, ...ascii };
  const sub = subSample(img, cols, rows, view), open = toCells(sub, opts);
  const shut = toCells(subSample(shutEyes(img, spec.eyes, spec.lash), cols, rows, view), opts);
  const fx = (c) => ((c + 0.5) * cwPx) / img.w, fy = (r) => ((r + 0.5) * chPx) / img.h;
  // Open eyes get solid glyphs: the edge matcher picks thin strokes (| " : !) inside an eye, which let the
  // backing through and turn the eye to mud. Pupils become dense dark @, irises # / 8 in the boosted iris
  // colour, catch-lights a white @ (colour fixed, outside the quantiser).
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const a = open[r][c]; if (!a) continue;
    const d = Math.min(...spec.eyes.map((e) => ((fx(c) - e.cx) / (e.rx * 1.02)) ** 2 + ((fy(r) - e.cy) / (e.ry * 1.08)) ** 2));
    if (d > 1) continue;
    const [L, C] = lch(a.rgb);
    if (L > 0.8 && C < 0.06) { a.ch = '@'; a.fix = [255, 255, 255]; }
    else if (L < 0.42) { a.ch = '@'; a.fix = a.rgb.map((v) => v * 0.55); }
    else { a.ch = L < 0.6 ? '#' : '8'; a.fix = candy(a.rgb, { chroma: 1.5, lift: 1.05 }); }
  }
  // Shut eyes: the lash glyphs (~ - _ ^ picked by the edge matcher) keep a crisp dark colour.
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const a = shut[r][c]; if (!a) continue;
    const d = Math.min(...spec.eyes.map((e) => ((fx(c) - e.cx) / (e.rx * 1.1)) ** 2 + ((fy(r) - e.cy) / (e.ry * 1.2)) ** 2));
    if (d <= 1 && lch(a.rgb)[0] < 0.62) a.fix = a.rgb.map((v) => v * 0.5);
  }
  const partOf = (x, y) => { for (const p of spec.parts) if (inPoly(p.poly, x, y)) return p.id; return 'body'; };
  // eye cells: inside the eye boxes (with a margin) and changed by the blink
  const inEye = (r, c) => spec.eyes.some((e) => Math.abs(fx(c) - e.cx) < e.rx * 1.35 && Math.abs(fy(r) - e.cy) < e.ry * 1.45);
  const cells = { body: [], eyeOpen: [], eyeShut: [] };
  for (const p of spec.parts) cells[p.id] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const a = open[r][c], b = shut[r][c];
    if (inEye(r, c) && (a?.ch !== b?.ch || (a && b && a.rgb.some((v, i) => Math.abs(v - b.rgb[i]) > 6)))) {
      if (a) cells.eyeOpen.push({ r, c, ...a });
      if (b) cells.eyeShut.push({ r, c, ...b });
      continue;
    }
    if (a) cells[partOf(fx(c), fy(r))].push({ r, c, ...a });
  }
  // silhouettes from the sub-grid alpha, one per part
  const subPart = (x, y) => partOf(((x + 0.5) / SX * cwPx) / img.w, ((y + 0.5) / SY * chPx) / img.h);
  const alphaAt = (x, y) => sub.data[(y * sub.W + x) * 4 + 3];
  const sil = {};
  for (const id of ['body', ...spec.parts.map((p) => p.id)]) {
    sil[id] = maskPath((x, y) => alphaAt(x, y) > 0.5 && subPart(x, y) === id, sub.W, sub.H, { sx: 6 / SX, sy: 10 / SY, tol: 0.9, minArea: 8, smooth: 2, digits: 1 });
  }
  const pivots = Object.fromEntries(spec.parts.map((p) => [p.id, [(p.pivot[0] * img.w) / cwPx * 6, (p.pivot[1] * img.h) / chPx * 10]]));
  return { W: cols * 6, H: rows * 10, cells, sil, pivots, spec };
}
