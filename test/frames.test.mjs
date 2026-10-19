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
