// M1.T6/T6a README: the header art, then profile.json's one line linking SkyBuds (D20), any fact line sourced in
// profile.json, brand name only, then the open-source cards with one linked tile per PR from data.json.
// README_RAW=<raw base url at one sha> also checks the live README equals the render of the live data.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, run } from './helpers.mjs';
import { build } from '../scripts/data.mjs';
import { liveProblems } from '../scripts/check.mjs';

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
  try { return await build(out, { api: `http://127.0.0.1:${server.address().port}`, avatars: `http://127.0.0.1:${server.address().port}`, token: 'test-token', now: new Date('2026-10-21T00:00:00Z') }); }
  finally { server.close(); }
}

test('M1.T6a: profile.json holds one short line that links SkyBuds, and every fact (if any) has an https source', () => {
  const { intro } = profile;
  assert.equal(intro.heading, undefined, 'no heading (D20)');
  assert.match(intro.line.text, /\]\(https:\/\/getskybuds\.com\)/);
  assert.ok(intro.line.text.length <= 80, 'one short line');
  assert.match(intro.line.source, /^https:\/\//);
  for (const f of intro.facts) assert.match(f.source, /^https:\/\//, f.text);
});

test('M1.T6a: the README leads with the banner, then profile.json\'s line, and passes the copy rules', () => {
  const out = tmp('readme-');
  assert.equal(render(out).status, 0);
  const md = readme(out);
  const c = check(out);
  assert.equal(c.status, 0, c.stderr);
  assert.ok(md.startsWith('<p align="center"><picture>\n<source media="(max-width: 600px)" srcset="dist/banner-phone.svg">\n<img src="dist/banner-desktop.svg" alt="'), 'the banner first');
  assert.ok(md.includes(`</picture></p>\n\n${profile.intro.line.text}\n`), 'the line right under the art');
  assert.ok(!/^#/m.test(md), 'no heading');
});

test('M1.T6b: with data.json the README shows one linked tile per PR after the line, and nothing else (D22)', async () => {
  const out = tmp('readme-');
  const { prs, stats } = await withData(out, [
    pr('nasa/fprime', 6134, 'open', null, '2026-10-19T21:00:00Z', 'Fix <off-by-one> & "overflow"'),
    pr('teslamotors/vehicle-command', 9, 'closed', '2026-10-20T03:00:00Z', '2026-10-19T22:00:00Z', 'Keep key order'),
  ]);
  assert.equal(render(out).status, 0);
  const md = readme(out);
  assert.ok(!/stats\.svg|trajectory\.svg/.test(md), 'no stat chips or line chart');
  assert.ok(!existsSync(join(out, 'dist', 'stats.svg')) && !existsSync(join(out, 'dist', 'trajectory.svg')), 'neither is rendered');
  const tiles = [...md.matchAll(/<a href="([^"]+)"><img src="(dist\/mission\/[^"]+)" alt="([^"]*)"[^>]*><\/a>/g)];
  assert.equal(tiles.length, stats.prs);
  assert.deepEqual(tiles.map((m) => [m[1], m[2]]), prs.map((p) => [p.url, p.tile]));
  assert.ok(!/alt="[^"]*<|alt="[^"]*"overflow/.test(md), 'titles escaped in alt text');
  const section = md.slice(md.indexOf(profile.intro.line.text) + profile.intro.line.text.length);
  assert.equal(section.replace(/<a href="[^"]+"><img [^>]+><\/a>\n/g, '').trim(), '', 'nothing but tiles after the line');
  assert.ok(md.indexOf('<a href="https://github.com/') > md.indexOf(profile.intro.line.text), 'tiles come after the intro line');
  assert.ok(!/^#/m.test(md), 'no heading');
  const r = check(out);
  assert.equal(r.status, 0, r.stderr);
});

test('M1.T6: with no PRs yet the README renders no tiles and no heading, and check passes', async () => {
  const out = tmp('readme-');
  await withData(out, []);
  assert.equal(render(out).status, 0);
  const md = readme(out);
  assert.ok(!/^#/m.test(md));
  assert.ok(!/dist\/(mission\/|stats|trajectory)/.test(md));
  assert.equal(check(out).status, 0, check(out).stderr);
});

test('M1.T6: without data.json (first render) the README has no card section and still passes check', () => {
  const out = tmp('readme-');
  assert.equal(render(out).status, 0);
  assert.ok(!existsSync(join(out, 'data.json')));
  assert.ok(!/dist\/stats\.svg/.test(readme(out)));
  assert.equal(check(out).status, 0, check(out).stderr);
});

test('M1.T6: the live README is the render of the live data.json and profile', { skip: !process.env.README_RAW && 'set README_RAW to check the live README' }, async () => {
  const get = async (f) => { const res = await fetch(`${process.env.README_RAW}/${f}`); assert.equal(res.status, 200, f); return res.text(); };
  const [md, data, live] = await Promise.all([get('README.md'), get('data.json'), get('profile.json')]);
  assert.deepEqual(liveProblems(md, JSON.parse(data), JSON.parse(live)), []);
});
