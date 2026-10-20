// M1.T6 README: SkyBuds first (heading and first line), every fact line sourced in profile.json, brand name
// only, the themed header, then the open-source cards with one linked tile per PR from data.json.
// README_URL=<raw README url> also runs the copy checks on the live README.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, run } from './helpers.mjs';
import { build } from '../scripts/data.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = JSON.parse(readFileSync(join(ROOT, 'profile.json'), 'utf8'));
const render = (out) => run('node', [join(ROOT, 'scripts', 'render.mjs'), '--out', out]);
const check = (out) => run('node', [join(ROOT, 'scripts', 'check.mjs'), out]);
const readme = (out) => readFileSync(join(out, 'README.md'), 'utf8');

const pr = (repo, n, state, merged, created, title) => ({
  html_url: `https://github.com/${repo}/pull/${n}`, number: n, title, state, created_at: created,
  repository_url: `https://api.github.com/repos/${repo}`, pull_request: { merged_at: merged },
});
async function withData(out, items) {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ total_count: items.length, incomplete_results: false, items })); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try { return await build(out, { api: `http://127.0.0.1:${server.address().port}`, token: 'test-token', now: new Date('2026-10-21T00:00:00Z') }); }
  finally { server.close(); }
}

// the copy checks, shared by the local and the live README
function copyProblems(md) {
  const problems = [];
  const lines = md.split('\n');
  const h = lines.findIndex((l) => /^#{1,3} /.test(l));
  if (h < 0) return ['no heading'];
  if (!/SkyBuds/.test(lines[h])) problems.push(`first heading is not about SkyBuds: ${lines[h]}`);
  const first = lines.slice(h + 1).find((l) => l.trim());
  if (!first || !/SkyBuds/.test(first)) problems.push(`first line is not about SkyBuds: ${first}`);
  if (/<picture>/.test(md) && md.indexOf('<picture>') > md.indexOf(lines[h])) problems.push('header art is not above the heading');
  // every list line in the SkyBuds section is a profile.json fact with a source URL
  const end = lines.findIndex((l, i) => i > h && /^#{1,3} /.test(l));
  const section = lines.slice(h + 1, end < 0 ? undefined : end);
  const facts = new Map(profile.intro.facts.map((f) => [f.text, f.source]));
  for (const l of section.filter((x) => /^- /.test(x))) {
    const text = l.slice(2);
    if (!facts.has(text)) problems.push(`fact line not in profile.json: ${text}`);
  }
  if (section.filter((x) => /^- /.test(x)).length < 3) problems.push('fewer than 3 fact lines');
  if (/\b(Inc|LLC|Ltd|GmbH|ApS|Corp)\b\.?/.test(md)) problems.push('legal entity name in the README (brand name only)');
  return problems;
}

test('M1.T6: profile.json holds the SkyBuds heading, first line and facts, each fact with an https source', () => {
  const { intro } = profile;
  assert.match(intro.heading, /SkyBuds/);
  assert.match(intro.line.text, /SkyBuds/);
  assert.match(intro.line.source, /^https:\/\//);
  assert.ok(intro.facts.length >= 3);
  for (const f of intro.facts) assert.match(f.source, /^https:\/\//, f.text);
});

test('M1.T6: the README leads with the header art, then a SkyBuds heading and line, then sourced facts only', () => {
  const out = tmp('readme-');
  assert.equal(render(out).status, 0);
  const md = readme(out);
  assert.deepEqual(copyProblems(md), []);
  assert.ok(md.startsWith('<p align="center"><picture>'), 'header art first');
  for (const f of profile.intro.facts) assert.ok(md.includes(`- ${f.text}\n`), f.text);
});

test('M1.T6: with data.json the README shows stat chips, the trajectory and one linked tile per PR', async () => {
  const out = tmp('readme-');
  const { prs, stats } = await withData(out, [
    pr('nasa/fprime', 6134, 'open', null, '2026-10-19T21:00:00Z', 'Fix <off-by-one> & "overflow"'),
    pr('teslamotors/vehicle-command', 9, 'closed', '2026-10-20T03:00:00Z', '2026-10-19T22:00:00Z', 'Keep key order'),
  ]);
  assert.equal(render(out).status, 0);
  const md = readme(out);
  assert.match(md, /<img src="dist\/stats\.svg" alt="[^"]+"/);
  assert.match(md, /<img src="dist\/trajectory\.svg" alt="[^"]+"/);
  const tiles = [...md.matchAll(/<a href="([^"]+)"><img src="(dist\/mission\/[^"]+)" alt="([^"]*)"[^>]*><\/a>/g)];
  assert.equal(tiles.length, stats.prs);
  assert.deepEqual(tiles.map((m) => [m[1], m[2]]), prs.map((p) => [p.url, p.tile]));
  assert.ok(!/alt="[^"]*<|alt="[^"]*"overflow/.test(md), 'titles escaped in alt text');
  assert.ok(md.indexOf('dist/stats.svg') > md.indexOf(profile.intro.facts.at(-1).text), 'cards come after the SkyBuds section');
  const r = check(out);
  assert.equal(r.status, 0, r.stderr);
});

test('M1.T6: with no PRs yet the README still renders the cards and no tiles, and check passes', async () => {
  const out = tmp('readme-');
  await withData(out, []);
  assert.equal(render(out).status, 0);
  const md = readme(out);
  assert.match(md, /dist\/stats\.svg/);
  assert.ok(!/dist\/mission\//.test(md));
  assert.equal(check(out).status, 0, check(out).stderr);
});

test('M1.T6: without data.json (first render) the README has no card section and still passes check', () => {
  const out = tmp('readme-');
  assert.equal(render(out).status, 0);
  assert.ok(!existsSync(join(out, 'data.json')));
  assert.ok(!/dist\/stats\.svg/.test(readme(out)));
  assert.equal(check(out).status, 0, check(out).stderr);
});

test('M1.T6: the live README passes the same copy checks', { skip: !process.env.README_URL && 'set README_URL to check the live README' }, async () => {
  const res = await fetch(process.env.README_URL);
  assert.equal(res.status, 200);
  assert.deepEqual(copyProblems(await res.text()), []);
});
