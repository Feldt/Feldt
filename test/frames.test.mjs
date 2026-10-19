// M1.T2 Bud source: the header's art is public SkyBuds art, recorded with its URL, and usable as a frame source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from '../scripts/spike.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = () => JSON.parse(readFileSync(join(ROOT, 'profile.json'), 'utf8'));

test('M1.T2: profile.json names the Bud art by a public getskybuds.com URL that answers 200 logged out', async () => {
  const { bud } = profile();
  assert.match(bud.source.url, /^https:\/\/getskybuds\.com\//);
  const r = await fetch(bud.source.url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
  const body = Buffer.from(await r.arrayBuffer());
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^image\//);
  assert.ok(body.length > 10000, `${body.length} bytes`);
});

test('M1.T2: the local frame source is the recorded file, with a transparent background and an opaque Bud', () => {
  const { bud } = profile();
  const buf = readFileSync(join(ROOT, bud.source.file));
  assert.equal(createHash('sha256').update(buf).digest('hex'), bud.source.sha256);
  const { w, h, px } = decodePng(buf);
  assert.ok(w >= 384, `${w} px wide`);
  let clear = 0, solid = 0;
  // lossy WebP alpha sits at ~252 inside the Bud
  for (let i = 3; i < px.length; i += 4) { if (px[i] === 0) clear++; else if (px[i] >= 240) solid++; }
  assert.ok(clear / (w * h) > 0.15, 'background is transparent');
  assert.ok(solid / (w * h) > 0.4, 'the Bud is opaque');
  assert.equal(px[3], 0, 'top-left corner is background');
});

// M1.T3 frames: Ash's seamless loop (float + blink + wing flap) as one base grid plus delta rows.
const loopMod = () => import('../scripts/frames.mjs');
let cached;
async function loop() { if (!cached) { const m = await loopMod(); cached = { m, l: m.buildLoop({ src: join(ROOT, profile().bud.source.file) }) }; } return cached; }
const rowsOf = (grid) => grid.map((row) => row.map((c) => (c ? c.ch + c.cls : ' ')).join('|'));

test('M1.T3: the loop has at least 8 steps and every step is the base or a named frame', async () => {
  const { l } = await loop();
  assert.ok(l.timeline.length >= 8, `${l.timeline.length} steps`);
  const ids = new Set(l.frames.map((f) => f.id));
  for (const s of l.timeline) assert.ok(s.frame === null || ids.has(s.frame), JSON.stringify(s));
  assert.ok(new Set(l.timeline.map((s) => `${s.frame}/${s.dy}`)).size >= 8, 'at least 8 distinct poses');
});

test('M1.T3: the loop is seamless: it starts on the base pose and its last step leads back to it', async () => {
  const { l } = await loop();
  const first = l.timeline[0], last = l.timeline[l.timeline.length - 1];
  assert.equal(first.frame, null);
  assert.equal(first.dy, 0);
  assert.ok(Math.abs(last.dy - first.dy) <= 1, `float jumps ${last.dy} -> ${first.dy}`);
  assert.ok(last.frame === null || l.frames.find((f) => f.id === last.frame).name.startsWith('flap'), 'no blink across the seam');
});

test('M1.T3: Ash blinks: the closed-eye frame changes only the eye rows, and the eye highlights go', async () => {
  const { l, m } = await loop();
  const blink = l.frames.find((f) => f.name === 'blink');
  assert.ok(blink, 'a blink frame');
  const changed = m.deltaRows(l.base, blink.grid);
  assert.ok(changed.length > 0 && changed.length <= Math.ceil(l.base.length * 0.15), `${changed.length} rows`);
  const [lo, hi] = [Math.min(...changed), Math.max(...changed)];
  assert.ok(lo >= l.base.length * 0.18 && hi <= l.base.length * 0.40, `eye rows ${lo}-${hi}`);
  const bright = (g) => g.flat().filter((c) => c && c.lum > 0.85).length;
  assert.ok(bright(blink.grid) < bright(l.base), 'eye highlights hidden');
});

test('M1.T3: Ash flaps: wing frames change the wing rows at the sides, never the face', async () => {
  const { l, m } = await loop();
  const flaps = l.frames.filter((f) => f.name.startsWith('flap'));
  assert.ok(flaps.length >= 2, `${flaps.length} flap frames`);
  const cols = l.base[0].length;
  for (const f of flaps) {
    const changed = m.deltaRows(l.base, f.grid);
    assert.ok(changed.length > 0, `${f.name} changes nothing`);
    for (const y of changed) {
      const xs = l.base[y].map((c, x) => [c, f.grid[y][x], x]).filter(([a, b]) => JSON.stringify(a) !== JSON.stringify(b)).map(([, , x]) => x);
      for (const x of xs) assert.ok(x < cols * 0.36 || x > cols * 0.64, `${f.name} changed row ${y} col ${x}`);
    }
  }
});

test('M1.T3: the animated SVG stores the base once and each frame as its changed rows only, under 150 KB', async () => {
  const { l, m } = await loop();
  const out = tmp('loop-');
  const r = run('node', [join(ROOT, 'scripts', 'frames.mjs'), '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const svg = join(out, 'loop.svg');
  assert.equal(run('xmllint', ['--noout', svg]).status, 0);
  const s = readFileSync(svg, 'utf8');
  assert.ok(s.length <= 150 * 1024, `${s.length} bytes`);
  assert.equal([...s.matchAll(/<g class="base"/g)].length, 1);
  for (const f of l.frames) {
    const g = s.match(new RegExp(`<g class="${f.id}"[^>]*>([\\s\\S]*?)</g>`));
    assert.ok(g, `group for ${f.id}`);
    assert.equal([...g[1].matchAll(/<text /g)].length, m.deltaRows(l.base, f.grid).length, `${f.id} carries only its changed rows`);
  }
  const steps = Number(s.match(/steps\((\d+)/)[1]);
  assert.ok(steps >= 8);
  assert.match(s, /prefers-reduced-motion/);
});
