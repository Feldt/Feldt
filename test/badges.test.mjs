// Fred 10-20 (after the tiles came off): "small badges for the open PRs". One 28 px pill per PR, light and dark.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { badgeOf, badgeWidth, badgeSvg, badgeFiles, badgeLine, badgeBlock, BADGE_H, THEMES, ICONS } = await import(join(ROOT, 'scripts', 'badges.mjs'));
const { xmlProblem } = await import(join(ROOT, 'scripts', 'check.mjs'));
const pr = (repo, number, state = 'open') => ({ repo, org: repo.split('/')[0], number, state, title: 'Fix "a" <b> & c', url: `https://github.com/${repo}/pull/${number}` });

test('badges: one light and one dark file per PR, named from repo and number', () => {
  assert.deepEqual(badgeOf('huggingface/tokenizers', 1773), { light: 'dist/badges/huggingface--tokenizers-1773-light.svg', dark: 'dist/badges/huggingface--tokenizers-1773-dark.svg' });
  const files = badgeFiles([pr('uber/h3', 1275), pr('cloudflare/workerd', 6134, 'merged')]);
  assert.deepEqual(Object.keys(files).sort(), ['dist/badges/cloudflare--workerd-6134-dark.svg', 'dist/badges/cloudflare--workerd-6134-light.svg', 'dist/badges/uber--h3-1275-dark.svg', 'dist/badges/uber--h3-1275-light.svg']);
});

test('badges: 28 px tall, wide enough for owner/repo #n at the widest monospace advance, and wider for longer text', () => {
  assert.equal(BADGE_H, 28);
  const short = pr('uber/h3', 1275), long = pr('huggingface/tokenizers', 1773);
  for (const p of [short, long]) {
    const text = `${p.repo} #${p.number}`.length * 12 * 0.618;
    for (const theme of ['light', 'dark']) {
      const s = badgeSvg(p, theme), w = Number(/<svg[^>]* width="(\d+)"/.exec(s)[1]);
      assert.match(s, new RegExp(`<svg[^>]* height="28" viewBox="0 0 ${w} 28"`));
      assert.equal(w, badgeWidth(p));
      const x = Number(/<text x="(\d+)"/.exec(s)[1]);
      assert.ok(x + text + 8 <= w, `${p.repo} ${theme}: text ends at ${x + text}, badge is ${w}`);
    }
  }
  assert.ok(badgeWidth(long) > badgeWidth(short));
});

test('badges: an open PR gets the pull-request icon in green, a merged one the merge icon in purple, per theme', () => {
  for (const theme of ['light', 'dark']) {
    const open = badgeSvg(pr('uber/h3', 1275), theme), merged = badgeSvg(pr('uber/h3', 1200, 'merged'), theme);
    assert.ok(open.includes(`fill="${THEMES[theme].open}" d="${ICONS.open}"`), theme);
    assert.ok(merged.includes(`fill="${THEMES[theme].merged}" d="${ICONS.merged}"`), theme);
    assert.ok(open.includes(`fill="${THEMES[theme].bg}"`) && open.includes(`<tspan fill="${THEMES[theme].dim}">uber/</tspan><tspan fill="${THEMES[theme].text}" font-weight="600">h3</tspan>`), theme);
  }
  assert.notEqual(THEMES.light.bg, THEMES.dark.bg);
});

test('badges: well-formed SVG with text only: no script, image, foreignObject, external href, url() or data: URI', () => {
  for (const p of [pr('uber/h3', 1275), pr('a.b/c_d-e', 1, 'merged')]) {
    for (const theme of ['light', 'dark']) {
      const s = badgeSvg(p, theme);
      assert.equal(xmlProblem(s), null);
      assert.doesNotMatch(s, /<(?:script|image|img|foreignObject|iframe)\b|href|url\(|data:|@import|@font-face/i);
    }
  }
});

test('badges: the README line links the PR, shows the dark file under the dark scheme, and escapes the alt text', () => {
  const p = pr('uber/h3', 1275), f = badgeOf(p.repo, p.number);
  assert.equal(badgeLine(p), `<a href="${p.url}"><picture><source media="(prefers-color-scheme: dark)" srcset="${f.dark}"><img src="${f.light}" alt="Open PR uber/h3#1275: Fix &quot;a&quot; &lt;b&gt; &amp; c" height="28"></picture></a>`);
  assert.match(badgeLine(pr('uber/h3', 1200, 'merged')), /alt="Merged PR uber\/h3#1200: /);
});

test('badges: the row is a <p> of badge lines, newest PR first, and nothing without PRs', () => {
  const a = pr('uber/h3', 1275), b = pr('cloudflare/workerd', 6134);
  assert.deepEqual(badgeBlock([a, b]), ['<p>', badgeLine(b), badgeLine(a), '</p>', '']);
  assert.deepEqual(badgeBlock([]), []);
});
