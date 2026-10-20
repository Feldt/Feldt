// M1.T1 render pipeline: profile.json -> render.mjs -> dist/*.svg + README.md, guarded by check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, run } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const render = (out) => run('node', [join(ROOT, 'scripts', 'render.mjs'), '--out', out]);
const check = (out) => run('node', [join(ROOT, 'scripts', 'check.mjs'), out]);
function built() { const out = tmp('dist-'); const r = render(out); assert.equal(r.status, 0, r.stderr); return out; }
const imgs = (md) => [...md.matchAll(/<img[^>]* src="([^"]+)"/g), ...md.matchAll(/srcset="([^"]+)"/g)].map((m) => m[1]);

test('M1.T1: render writes a README whose every local image exists in the output', () => {
  const out = built();
  const md = readFileSync(join(out, 'README.md'), 'utf8');
  const local = imgs(md).filter((s) => !/^https?:/.test(s));
  assert.ok(local.length >= 1, 'the README shows the header');
  for (const s of local) assert.ok(existsSync(join(out, s)), `${s} missing`);
  assert.equal(check(out).status, 0, check(out).stderr);
});

test('M1.T1: render is deterministic for the same profile.json', () => {
  const a = built(), b = built();
  assert.equal(readFileSync(join(a, 'README.md'), 'utf8'), readFileSync(join(b, 'README.md'), 'utf8'));
  assert.equal(readFileSync(join(a, 'dist', 'header.svg'), 'utf8'), readFileSync(join(b, 'dist', 'header.svg'), 'utf8'));
});

test('M1.T1: check refuses a README pointing at a missing image', () => {
  const out = built();
  rmSync(join(out, 'dist', 'header.svg'));
  const r = check(out);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /header\.svg/);
});

test('M1.T1: check refuses an SVG over 150 KB or one that is not well-formed XML', () => {
  const big = built();
  writeFileSync(join(big, 'dist', 'header.svg'), `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${'x'.repeat(151 * 1024)} --></svg>`);
  assert.equal(check(big).status, 1);
  assert.match(check(big).stderr, /150 KB/);
  const bad = built();
  writeFileSync(join(bad, 'dist', 'header.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text>unclosed</svg>');
  assert.equal(check(bad).status, 1);
  assert.match(check(bad).stderr, /XML/);
});
