// Colour helpers: sRGB <-> OKLab/OKLCH, and the candy boost used on every glyph colour.
const toLin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const toSrgb = (v) => { const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(c * 255))); };
export function oklab([r, g, b]) {
  const R = toLin(r), G = toLin(g), B = toLin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function labToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const inGamut = (lin) => lin.every((v) => v >= -0.0005 && v <= 1.0005);
// OKLCH -> sRGB, reducing chroma until the colour fits the gamut
export function fromLch(L, C, h) {
  for (;; C *= 0.94) {
    const lin = labToLinear([L, C * Math.cos(h), C * Math.sin(h)]);
    if (inGamut(lin) || C < 0.002) return lin.map(toSrgb);
  }
}
export const lch = (rgb) => { const [L, a, b] = oklab(rgb); return [L, Math.hypot(a, b), Math.atan2(b, a)]; };
// Candy: more chroma, lifted mids (glyphs sit on a dark ground, so they must glow)
// shift: [fromDeg, toDeg, byDeg] rotates hues inside that range (e.g. Sprout's olive fur toward fresh lime)
export function candy(rgb, { chroma = 1.3, lift = 0.82, minL = 0, maxL = 0.97, shift = null } = {}) {
  const [L, C, h] = lch(rgb);
  const L2 = Math.min(maxL, Math.max(minL, L ** lift));
  let h2 = h;
  if (shift && C > 0.04) { const deg = ((h * 180) / Math.PI + 360) % 360; if (deg >= shift[0] && deg <= shift[1]) h2 = h + (shift[2] * Math.PI) / 180; }
  return fromLch(L2, C * chroma, h2);
}
export const hex = (rgb) => rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
export const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
export const parseHex = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
