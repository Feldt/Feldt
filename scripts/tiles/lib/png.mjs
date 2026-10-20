// Minimal PNG decoder, no dependencies (node:zlib only). Handles every non-interlaced and Adam7 PNG with
// bit depth 1-16 and colour types 0, 2, 3, 4, 6, which covers GitHub avatars. Returns RGBA 8-bit.
import { inflateSync } from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export const isPng = (buf) => Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 8).equals(SIG);

export function decodePng(buf) {
  if (!isPng(buf)) throw new Error('not a PNG');
  let pos = 8, ihdr = null, palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], ctype: data[9], interlace: data[12] };
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!ihdr || !(ihdr.ctype in CHANNELS)) throw new Error('unsupported PNG');
  const { w, h, depth, ctype, interlace } = ihdr, ch = CHANNELS[ctype];
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8ClampedArray(w * h * 4);
  const bpp = Math.max(1, (ch * depth) >> 3);
  let off = 0;
  const pass = (x0, y0, dx, dy) => {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
    if (pw <= 0 || ph <= 0) return;
    const stride = Math.ceil((pw * ch * depth) / 8);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < ph; y++) {
      const ft = raw[off++], line = Uint8Array.from(raw.subarray(off, off + stride));
      off += stride;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        let v = line[i];
        if (ft === 1) v += a;
        else if (ft === 2) v += b;
        else if (ft === 3) v += (a + b) >> 1;
        else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        line[i] = v & 255;
      }
      prev = line;
      for (let x = 0; x < pw; x++) {
        const sample = (k) => {
          if (depth === 8) return line[x * ch + k];
          if (depth === 16) return line[(x * ch + k) * 2];
          const bit = (x * ch + k) * depth, byte = line[bit >> 3], shift = 8 - depth - (bit & 7);
          return (byte >> shift) & ((1 << depth) - 1);
        };
        const sample16 = (k) => (depth === 16 ? line[(x * ch + k) * 2] * 256 + line[(x * ch + k) * 2 + 1] : null);
        const scale = (v) => (depth >= 8 ? v : Math.round((v * 255) / ((1 << depth) - 1)));
        let r, g, b2, al = 255;
        if (ctype === 3) {
          const i = sample(0);
          r = palette[i * 3]; g = palette[i * 3 + 1]; b2 = palette[i * 3 + 2];
          if (trns && i < trns.length) al = trns[i];
        } else if (ctype === 0 || ctype === 4) {
          r = g = b2 = scale(sample(0));
          if (ctype === 4) al = scale(sample(1));
          else if (trns && (depth === 16 ? sample16(0) : sample(0)) === trns.readUInt16BE(0)) al = 0;
        } else {
          r = scale(sample(0)); g = scale(sample(1)); b2 = scale(sample(2));
          if (ctype === 6) al = scale(sample(3));
          else if (trns && depth === 8 && r === trns.readUInt16BE(0) && g === trns.readUInt16BE(2) && b2 === trns.readUInt16BE(4)) al = 0;
        }
        const o = ((y0 + y * dy) * w + (x0 + x * dx)) * 4;
        out[o] = r; out[o + 1] = g; out[o + 2] = b2; out[o + 3] = al;
      }
    }
  };
  if (interlace) for (const [x0, y0, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) pass(x0, y0, dx, dy);
  else pass(0, 0, 1, 1);
  return { width: w, height: h, data: out };
}
