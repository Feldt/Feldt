// M1.T4b banner: Ash, Pearl and Sprout bouncing a beach ball in a meadow, in animated colour ASCII. render.mjs
// writes two self-contained SVGs (desktop 1200x300, phone 640x320) from the committed renders in assets/buds/,
// deterministic, safe under GitHub's image CSP, animated with CSS keyframes, still under reduced motion.
// M1.T2 (kept from the old header): the Bud art in profile.json is public SkyBuds art, recorded with its URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, run } from './helpers.mjs';
import { decodePng as decodeSpikePng } from '../scripts/spike.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = () => JSON.parse(readFileSync(join(ROOT, 'profile.json'), 'utf8'));
const KINDS = { desktop: [1200, 300], phone: [640, 320] };
const ALT = 'Ash, Pearl and Sprout, the three SkyBuds, bouncing a beach ball under a rainbow in a flower meadow, in animated colour ASCII';
const BUDS = ['pdp-ash-plush-900.png', 'pdp-pearl-plush-730.png', 'pdp-sprout-plush-900.png'];

function render() {
  const out = tmp('banner-');
  const r = run('node', [join(ROOT, 'scripts', 'render.mjs'), '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  return out;
}
let first;
const built = () => (first ??= render());
const banner = (kind, out = built()) => readFileSync(join(out, 'dist', `banner-${kind}.svg`), 'utf8');

test('M1.T4b: render writes the desktop and phone banners, and none of the old header files', () => {
  const out = built();
  for (const kind of Object.keys(KINDS)) assert.ok(existsSync(join(out, 'dist', `banner-${kind}.svg`)), kind);
  assert.deepEqual(readdirSync(join(out, 'dist')).filter((f) => f.startsWith('header-')), [], 'old header files');
});

test('M1.T4b: desktop is 1200x300 and phone 640x320, each well-formed XML in the SVG namespace, at most 600 KB', () => {
  for (const [kind, [w, h]] of Object.entries(KINDS)) {
    const f = join(built(), 'dist', `banner-${kind}.svg`), s = banner(kind);
    assert.match(s, new RegExp(`^<svg xmlns="http://www\\.w3\\.org/2000/svg"[^>]* viewBox="0 0 ${w} ${h}"`), kind);
    assert.equal(run('xmllint', ['--noout', f]).status, 0, `${kind}: xmllint`);
    assert.ok(statSync(f).size <= 600 * 1024, `${kind}: ${statSync(f).size} bytes`);
    assert.ok(statSync(f).size >= 100 * 1024, `${kind}: ${statSync(f).size} bytes is too small to be the full scene`);
  }
});

test('M1.T4b: two renders are byte-identical', () => {
  const again = render();
  for (const kind of Object.keys(KINDS)) assert.equal(banner(kind, again), banner(kind), kind);
  assert.equal(readFileSync(join(again, 'README.md'), 'utf8'), readFileSync(join(built(), 'README.md'), 'utf8'));
});

test("M1.T4b: the banners are safe under GitHub's image CSP: no script, image, foreignObject, data: URI, external reference or web font", () => {
  for (const kind of Object.keys(KINDS)) {
    const s = banner(kind);
    for (const [why, re] of [
      ['script', /<script\b/i], ['image', /<image\b/i], ['img', /<img\b/i], ['foreignObject', /<foreignObject\b/i], ['iframe', /<iframe\b/i],
      ['data: URI', /data:/i], ['javascript:', /javascript:/i], ['@import', /@import/i], ['web font', /@font-face/i],
      ['external url()', /url\(\s*(?!#)/i], ['external href', /\s(?:xlink:)?href\s*=\s*"(?!#)/i], ['src', /\ssrc\s*=/i],
    ]) assert.doesNotMatch(s, re, `${kind}: ${why}`);
  }
});

test('M1.T4b: the banners move with CSS keyframes (ball, Buds, blinks, clouds) and stop under prefers-reduced-motion', () => {
  for (const kind of Object.keys(KINDS)) {
    const s = banner(kind), frames = [...s.matchAll(/@keyframes ([\w-]+)\{/g)].map((m) => m[1]);
    assert.ok(frames.length >= 20, `${kind}: ${frames.length} keyframes`);
    for (const name of ['bx', 'by', 'sh', 'ah', 'ph', 'aes', 'pes', 'ses', 'cl-far', 'cl-near']) {
      assert.ok(frames.includes(name), `${kind}: @keyframes ${name}`);
      assert.match(s, new RegExp(`\\.${name}\\{[^}]*animation:${name} `), `${kind}: .${name} runs ${name}`);
    }
    assert.match(s, /@media \(prefers-reduced-motion:\s*reduce\)\{\*\{animation:none!important\}\}/, `${kind}: reduced motion`);
  }
});

test('M1.T4b: the three Buds are drawn: each has its own palette and hundreds of glyphs', () => {
  for (const kind of Object.keys(KINDS)) {
    const s = banner(kind);
    for (const p of ['S', 'A', 'P']) {
      const classes = new Set([...s.matchAll(new RegExp(`\\.(${p}[a-z0-9]+)\\{color:#[0-9a-f]{6}\\}`, 'g'))].map((m) => m[1]));
      assert.ok(classes.size >= 20, `${kind} ${p}: ${classes.size} colours`);
      const glyphs = [...s.matchAll(new RegExp(`class="${p}[a-z0-9]+">([^<]*)<`, 'g'))].reduce((n, m) => n + m[1].length, 0);
      assert.ok(glyphs >= 500, `${kind} ${p}: ${glyphs} glyphs`);
    }
  }
});

test('M1.T4b: the README opens with the centred banner <picture>: the phone source, then the desktop image', () => {
  const md = readFileSync(join(built(), 'README.md'), 'utf8');
  assert.ok(md.startsWith([
    '<p align="center"><picture>',
    '<source media="(max-width: 600px)" srcset="dist/banner-phone.svg">',
    `<img src="dist/banner-desktop.svg" alt="${ALT}" width="100%">`,
    '</picture></p>',
    '',
  ].join('\n')), md.slice(0, 400));
  assert.equal((md.match(/<source /g) || []).length, 1, 'no other sources (no reduced-motion stills)');
  const r = run('node', [join(ROOT, 'scripts', 'check.mjs'), built()]);
  assert.equal(r.status, 0, r.stderr);
});

test('M1.T4b: the banner inputs are the three public renders at 480 px on the long side, transparent around the Bud', async () => {
  const { decodePng } = await import('../scripts/banner/png.mjs');
  const note = readFileSync(join(ROOT, 'assets', 'buds', 'SOURCE.md'), 'utf8');
  for (const f of BUDS) {
    const { w, h, px } = decodePng(readFileSync(join(ROOT, 'assets', 'buds', f)));
    assert.equal(Math.max(w, h), 480, `${f}: ${w}x${h}`);
    assert.equal(px[3], 0, `${f}: top-left corner is background`);
    assert.ok(note.includes(`https://getskybuds.com/cdn/${f.replace('.png', '.webp')}`), `${f}: source URL in SOURCE.md`);
  }
});

test('M1.T2: profile.json names the Bud art by a public getskybuds.com URL that answers 200 logged out', async () => {
  const { bud } = profile();
  assert.match(bud.source.url, /^https:\/\/getskybuds\.com\//);
  const r = await fetch(bud.source.url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
  const body = Buffer.from(await r.arrayBuffer());
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^image\//);
  assert.ok(body.length > 10000, `${body.length} bytes`);
});

test('M1.T2: the recorded Bud art is the file with its sha256, a transparent background and an opaque Bud', () => {
  const { bud } = profile();
  const buf = readFileSync(join(ROOT, bud.source.file));
  assert.equal(createHash('sha256').update(buf).digest('hex'), bud.source.sha256);
  const { w, h, px } = decodeSpikePng(buf);
  assert.ok(w >= 384, `${w} px wide`);
  let clear = 0, solid = 0;
  // lossy WebP alpha sits at ~252 inside the Bud
  for (let i = 3; i < px.length; i += 4) { if (px[i] === 0) clear++; else if (px[i] >= 240) solid++; }
  assert.ok(clear / (w * h) > 0.15, 'background is transparent');
  assert.ok(solid / (w * h) > 0.4, 'the Bud is opaque');
  assert.equal(px[3], 0, 'top-left corner is background');
});
