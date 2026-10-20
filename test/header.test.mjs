// M1.T4 header SVG: dark, light and mobile grids from the same loop, palette classes, merged runs,
// step-end animation, a typed tagline; the README picks the right one with <picture>.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, run } from './helpers.mjs';
import { svgProblems } from '../scripts/check.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = JSON.parse(readFileSync(join(ROOT, 'profile.json'), 'utf8'));
let out;
function built() {
  if (out) return out;
  out = tmp('header-');
  const r = run('node', [join(ROOT, 'scripts', 'render.mjs'), '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  return out;
}
const svg = (name) => readFileSync(join(built(), 'dist', `header-${name}.svg`), 'utf8');
const VARIANTS = ['dark', 'light', 'mobile-dark', 'mobile-light'];
// GitHub's page backgrounds
const BG = { dark: '0d1117', light: 'ffffff' };

const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const L = (hex) => { const [r, g, b] = [0, 2, 4].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const colours = (s) => [...s.matchAll(/\.c\d+\{fill:#([0-9a-f]{6})\}/g)].map((m) => m[1]);
const width = (s) => Number(/viewBox="0 0 ([\d.]+) /.exec(s)[1]);
const cols = (s) => Math.round(width(s) / Number(/data-cell="([\d.]+)"/.exec(s)[1]));

test('M1.T4: render writes dark, light and mobile headers, each a valid SVG under 150 KB', () => {
  for (const v of VARIANTS) {
    assert.deepEqual(svgProblems(join(built(), 'dist', `header-${v}.svg`), v), [], v);
  }
});

test('M1.T4: the README shows the headers through <picture>: mobile and dark sources, light fallback', () => {
  const md = readFileSync(join(built(), 'README.md'), 'utf8');
  const pic = /<picture>([\s\S]*?)<\/picture>/.exec(md);
  assert.ok(pic, md);
  const sources = [...pic[1].matchAll(/<source media="([^"]+)" srcset="([^"]+)">/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(sources, [
    ['(max-width: 600px) and (prefers-color-scheme: dark)', 'dist/header-mobile-dark.svg'],
    ['(max-width: 600px)', 'dist/header-mobile-light.svg'],
    ['(prefers-color-scheme: dark)', 'dist/header-dark.svg'],
  ]);
  assert.match(pic[1], /<img src="dist\/header-light\.svg" alt="[^"]+" width="100%">/);
  const r = run('node', [join(ROOT, 'scripts', 'check.mjs'), built()]);
  assert.equal(r.status, 0, r.stderr);
});

test('M1.T4: every Bud colour reads on its theme\'s GitHub background', () => {
  for (const v of VARIANTS) {
    const bg = BG[v.endsWith('dark') ? 'dark' : 'light'];
    const weak = colours(svg(v)).filter((c) => contrast(c, bg) < 1.5);
    assert.deepEqual(weak, [], `${v} colours too close to #${bg}`);
  }
  assert.notDeepEqual(colours(svg('dark')), colours(svg('light')), 'light has its own palette');
});

test('M1.T4: at 375 px (343 px content) the mobile header\'s glyphs are at least 6 px and the face still blinks', () => {
  for (const v of ['mobile-dark', 'mobile-light']) {
    const s = svg(v), font = Number(/font-size:([\d.]+)px/.exec(s)[1]);
    assert.ok(cols(s) <= 72, `${v}: ${cols(s)} cols`);
    assert.ok(font * Math.min(1, 343 / width(s)) >= 6, `${v}: glyphs ${(font * 343 / width(s)).toFixed(2)} px`);
    const blink = /<g class="f3">([\s\S]*?)<\/g>/.exec(s);
    assert.ok(blink && /<text/.test(blink[1]), `${v}: no blink rows`);
  }
  assert.ok(cols(svg('dark')) > cols(svg('mobile-dark')), 'desktop keeps the finer grid');
});

test('M1.T4: rows are merged runs of palette classes, never two touching runs of one class', () => {
  const s = svg('dark');
  for (const row of s.match(/<text[^>]*>.*?<\/text>/g)) {
    const runs = [...row.matchAll(/<tspan x="([\d.]+)" class="(c\d+)">([^<]*)<\/tspan>/g)];
    for (let i = 1; i < runs.length; i++) {
      const prev = runs[i - 1], cw = 6;
      const touching = Math.abs(Number(prev[1]) + prev[3].replace(/&\w+;/g, '_').length * cw - Number(runs[i][1])) < 0.01;
      assert.ok(!(touching && prev[2] === runs[i][2]), row.slice(0, 120));
    }
  }
  assert.ok(!/fill="#/.test(s), 'colours come from classes, not inline fills');
});

test('M1.T4: the tagline from profile.json types out one character per step, after the Bud loop starts', () => {
  const tag = profile.header.tagline;
  assert.ok(tag && tag.length <= 48, 'a short tagline in profile.json');
  for (const v of VARIANTS) {
    const s = svg(v);
    const t = /<text id="tagline"[^>]*>([^<]*)<\/text>/.exec(s);
    assert.ok(t, `${v}: no tagline`);
    assert.equal(t[1], tag);
    assert.match(s, new RegExp(`#tagline\\{[^}]*animation:type [\\d.]+s infinite steps\\(${tag.length},end\\)`));
    assert.match(s, /@keyframes type\{0%\{clip-path:inset\(0 100% 0 0\)\}[^}]*\}/);
    assert.ok(width(s) >= tag.length * Number(/#tagline\{[^}]*font-size:([\d.]+)px/.exec(s)[1]) * 0.6, `${v}: tagline wider than the header`);
  }
});
