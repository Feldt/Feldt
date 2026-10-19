// M1.T0 header spike: one colour ASCII frame of the Bud as an SVG that GitHub can show in an <img>.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, run } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPIKE = join(ROOT, 'scripts', 'spike.mjs');

function build() {
  const out = tmp('spike-');
  const r = run('node', [SPIKE, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  return out;
}

test('M1.T0: the spike frame is well-formed SVG under 150 KB', () => {
  const svg = join(build(), 'frame.svg');
  assert.equal(run('xmllint', ['--noout', svg]).status, 0);
  assert.ok(statSync(svg).size <= 150 * 1024, `${statSync(svg).size} bytes`);
});

test('M1.T0: the frame is the Bud in colour, not a blank or one-colour grid', () => {
  const s = readFileSync(join(build(), 'frame.svg'), 'utf8');
  const classes = new Set([...s.matchAll(/<tspan[^>]* class="(c\d+)"/g)].map((m) => m[1]));
  assert.ok(classes.size >= 8, `${classes.size} colours`);
  const glyphs = [...s.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].reduce((n, m) => n + m[1].replace(/\s/g, '').length, 0);
  assert.ok(glyphs >= 600, `${glyphs} glyphs`);
  // the Bud's orange body dominates: more warm glyph runs than any other hue
  const fills = Object.fromEntries([...s.matchAll(/\.(c\d+)\{fill:#([0-9a-f]{6})\}/g)].map((m) => [m[1], m[2]]));
  const warm = Object.values(fills).filter((h) => { const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); return r > g && g > b; });
  assert.ok(warm.length * 2 > Object.keys(fills).length, 'mostly warm colours');
});

test('M1.T0: every run starts on its own grid column, so glyph width differences cannot drift', () => {
  const s = readFileSync(join(build(), 'frame.svg'), 'utf8');
  const cw = Number(s.match(/data-cell="([\d.]+)"/)[1]);
  const xs = [...s.matchAll(/<tspan x="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(xs.length > 50);
  for (const x of xs) assert.ok(Math.abs(x / cw - Math.round(x / cw)) < 1e-6, `x=${x} off grid ${cw}`);
  assert.equal([...s.matchAll(/<tspan(?![^>]* x=)/g)].length, 0, 'a run without its own x');
});

test('M1.T0: at 375 px wide the glyphs are at least 6 px', () => {
  const s = readFileSync(join(build(), 'frame.svg'), 'utf8');
  const vbw = Number(s.match(/viewBox="0 0 ([\d.]+) /)[1]);
  const fs = Number(s.match(/font-size:([\d.]+)px/)[1]);
  assert.ok((fs * 375) / vbw >= 6, `${((fs * 375) / vbw).toFixed(2)} px`);
});

test('M1.T0: the byte projection for a looping header is written and says whether it fits', () => {
  const p = JSON.parse(readFileSync(join(build(), 'projection.json'), 'utf8'));
  for (const k of ['frameBytes', 'frames', 'fullCopyBytes', 'deltaBytes', 'fits']) assert.ok(k in p, k);
  assert.equal(p.fits, p.deltaBytes <= 150 * 1024);
  assert.ok(p.frames >= 8);
});
