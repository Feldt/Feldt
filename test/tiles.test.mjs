// node --test test/  (no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { homedir, userInfo } from 'node:os';
import { tileSvg, fragment, wrap, ellipsize, measure, normalize, FONTS, W, stateOf } from '../scripts/tiles/tiles.mjs';
import { logoFromImage, logoFromPng, logoCells, rle, unrle } from '../scripts/tiles/lib/logo.mjs';
import { decodePng } from '../scripts/tiles/lib/png.mjs';

// a tiny RGBA PNG built here, so the tests need no fixtures: a red square with a white bar, on transparent
function png(w, h, px) {
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type, 'latin1'), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = y % 5; for (let x = 0; x < w; x++) px(x, y).forEach((v, k) => { raw[y * (w * 4 + 1) + 1 + x * 4 + k] = v; }); }
  // apply each row's filter forwards so the decoder's unfiltering is exercised (types 0-4)
  const stride = w * 4, out = Buffer.from(raw);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)], o = y * (stride + 1) + 1, po = (y - 1) * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const v = raw[o + i], a = i >= 4 ? raw[o + i - 4] : 0, b = y ? raw[po + i] : 0, c = i >= 4 && y ? raw[po + i - 4] : 0;
      const p = a + b - c, pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      out[o + i] = (v - [0, a, b, (a + b) >> 1, pr][ft]) & 255;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(out)), chunk('IEND', Buffer.alloc(0))]);
}
const sample = (x, y) => (x < 4 || x > 43 ? [0, 0, 0, 0] : x > 18 && x < 30 && y > 8 && y < 40 ? [255, 255, 255, 255] : [220, 30, 25, 255]);
const PNG = png(48, 48, sample);

// Fixture PRs: Fred's three open PRs, then synthetic ones (example-org) for a merged badge, a title that must
// wrap and truncate, and a closed PR with a repo name too long for its line.
const pr = (repo, number, title, state) => ({ repo, number, title, state, merged: state === 'merged', url: `https://github.com/${repo}/pull/${number}` });
const PRS = [
  pr('runpod/runpod-python', 97, "Topic enforcer: don't try to decrease partition counts", 'open'),
  pr('neuralink/tsui', 38, 'Fix machine details preview overflowing an 80 column terminal', 'open'),
  pr('neuralinkcorp/datarepo', 84, 'Match contains filters as a literal substring', 'open'),
  pr('example-org/merged-change', 1, 'A merged change with "double quotes" in its title', 'merged'),
  pr('example-org/wrapping', 2, 'Add a fast path for rings that cross no pentagons and document the distortion bounds near the icosahedron edges in detail', 'open'),
  pr('example-org/a-repository-name-far-too-long-to-fit-on-its-line', 123456, 'Closed without merging', 'closed'),
];

test('the PNG decoder reads every filter type back exactly', () => {
  const im = decodePng(PNG);
  assert.equal(im.width, 48); assert.equal(im.height, 48);
  for (const [x, y] of [[0, 0], [10, 10], [20, 20], [44, 47]]) assert.deepEqual([...im.data.slice((y * 48 + x) * 4, (y * 48 + x) * 4 + 4)], sample(x, y));
});

test('a solid avatar becomes a full-bleed logo; run-length coding round-trips', () => {
  const logo = logoFromPng(PNG, { n: 16 });
  assert.equal(logo.bleed, true);
  assert.equal(logo.pal[0], '#dc1e19');
  assert.equal(unrle(logo.px).length, 16 * 16);
  assert.equal(unrle(rle('aaabccccd')), 'aaabccccd');
  assert.match(logoCells(logo), /^<rect width="16" height="16" fill="#dc1e19"\/><path fill="#ffffff" d="M/);
  assert.equal(JSON.stringify(logoFromPng(PNG, { n: 16 })), JSON.stringify(logo), 'deterministic');
  assert.equal(logoFromPng(Buffer.from('GIF89a')), null, 'non-PNG avatars fall back to a monogram');
});

test('a logo on a transparent background is padded on white', () => {
  const logo = logoFromImage(decodePng(png(40, 40, (x, y) => ((x - 20) ** 2 + (y - 20) ** 2 < 150 ? [11, 61, 145, 255] : [0, 0, 0, 0]))), { n: 16 });
  assert.equal(logo.bleed, false);
});

const logo = logoFromPng(PNG);
// machine-local markers are read at run time, so this file never holds the home path, user name or a LAN host
const LOCAL = [homedir(), userInfo().username].filter((s) => s && s.length > 3);
const LAN = new RegExp(['\\.', 'lan', '\\b'].join(''));
const tiles = PRS.map((p, i) => tileSvg(p, { index: i, logo: i % 2 ? logo : null }));

test('tiles pass GitHub\'s image CSP: no scripts, images, fonts, text elements or outside references', () => {
  for (const t of tiles) {
    assert.match(t, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 408 132"/);
    assert.doesNotMatch(t, /<(script|image|img|foreignObject|text|font|iframe|a)\b/i);
    assert.doesNotMatch(t, /@import|@font-face|javascript:/i);
    for (const m of t.matchAll(/url\(([^)]*)\)/g)) assert.match(m[1], /^#/);
    for (const m of t.matchAll(/\shref="([^"]*)"/g)) assert.match(m[1], /^#/);
    assert.equal([...t.matchAll(/https?:/g)].length, 1, 'only the SVG namespace');
    assert.ok(Buffer.byteLength(t) < 150 * 1024, `${Buffer.byteLength(t)} bytes`);
    for (const s of LOCAL) assert.ok(!t.toLowerCase().includes(s.toLowerCase()), 'no home folder or user name');
    assert.doesNotMatch(t, LAN, 'no LAN host name');
  }
});

test('tiles are well-formed: balanced tags, every used glyph defined once', () => {
  for (const t of tiles) {
    const stack = [];
    for (const m of t.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
      if (m[1]) assert.equal(stack.pop(), m[2]); else if (!m[3]) stack.push(m[2]);
    }
    assert.equal(stack.length, 0);
    const defs = [...t.matchAll(/<path id="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(defs).size, defs.length);
    for (const m of t.matchAll(/<use href="#([^"]+)"/g)) assert.ok(defs.includes(m[1]), m[1]);
  }
});

test('tiles are deterministic and say what they show', () => {
  assert.equal(tileSvg(PRS[0], { index: 0, logo }), tileSvg(PRS[0], { index: 0, logo }));
  assert.match(tiles[0], /aria-label="runpod\/runpod-python#97 open: Topic enforcer: don&#39;t|aria-label="runpod\/runpod-python#97 open: Topic enforcer: don't/);
  assert.match(tiles[3], /#8b4dff/, 'merged badge');
  assert.match(tiles[5], /#d4283b/, 'closed badge');
  assert.match(tiles[3], /aria-label="[^"]*&quot;double quotes&quot;/);
  assert.equal(stateOf({ state: 'closed', merged: '2026-01-01' }), 'merged');
});

test('long titles wrap to two lines and end in an ellipsis inside the column', () => {
  const f = FONTS.body, max = 270;
  const long = wrap(normalize(PRS[4].title), f, 15, max, 2);
  assert.equal(long.length, 2);
  assert.ok(long[1].endsWith('…'));
  for (const l of long) assert.ok(measure(l, f, 15) <= max, l);
  const word = wrap('x'.repeat(200), f, 15, max, 2);
  assert.equal(word.length, 2);
  for (const l of word) assert.ok(measure(l, f, 15) <= max);
  assert.equal(ellipsize('short', f, 15, max), 'short');
  assert.equal(normalize('✨ café “quotes” 🚀'), 'café “quotes”');
});

test('the fragment is one linked tile per PR, 408 wide, two to a desktop row', () => {
  const html = fragment(PRS);
  const links = html.trim().split('\n');
  assert.equal(links.length, PRS.length);
  links.forEach((l, i) => assert.equal(l, `<a href="${PRS[i].url}"><img src="dist/mission/${PRS[i].repo.replace('/', '--').toLowerCase()}-${PRS[i].number}.svg" alt="${PRS[i].repo}#${PRS[i].number} ${stateOf(PRS[i])}: ${PRS[i].title.replace(/"/g, '&quot;')}" width="${W}"></a>`));
  assert.ok(2 * W + 6 <= 838, 'two tiles and a space fit the desktop README column');
});
