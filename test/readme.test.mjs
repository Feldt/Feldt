// M1.T6/T6a README: the header art, then profile.json's one line linking SkyBuds (D20), any fact line sourced in
// profile.json, brand name only, then one small badge per PR (Fred 10-20: no PR tiles, "small badges for the open PRs").
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
import { renderFiles } from '../scripts/render.mjs';

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
  if (profile.intro.facts.length) assert.ok(md.includes(`${profile.intro.line.text}\n\n${profile.intro.facts.map((f) => `- ${f.text}\n`).join('')}`), 'the facts as bullets under the line');
  else assert.ok(!/^- /m.test(md), 'no bullets when there are no facts');
  assert.ok(!/^#/m.test(md), 'no heading');
});

test('Fred 10-20b: "drop this": no about bullets under the line, and the PR row comes right after it', () => {
  assert.deepEqual(profile.intro.facts, []);
  const md = renderFiles(profile, { prs: [] })['README.md'];
  assert.ok(!/^- /m.test(md), 'no bullet lines');
  assert.ok(md.endsWith(`${profile.intro.line.text}\n`), 'the line is the last thing with no PRs');
});

test('M1.T6a: a fact line, if one is ever added back, renders as a bullet under the line', () => {
  const p = { ...profile, intro: { ...profile.intro, facts: [{ text: 'One fact', source: 'https://getskybuds.com/' }] } };
  assert.ok(renderFiles(p, null)['README.md'].includes(`${profile.intro.line.text}\n\n- One fact\n`));
});

test('Fred 10-20: with PRs in data.json the README ends with one small badge per PR, newest first, each linking its PR; no tiles', async () => {
  const out = tmp('readme-');
  const { stats } = await withData(out, [
    pr('cloudflare/workerd', 6134, 'open', null, '2026-10-19T21:00:00Z', 'Fix <off-by-one> & "overflow"'),
    pr('stripe/stripe-node', 9, 'closed', '2026-10-20T03:00:00Z', '2026-10-19T22:00:00Z', 'Keep key order'),
  ]);
  assert.equal(stats.prs, 2);
  assert.equal(render(out).status, 0);
  const md = readme(out);
  assert.ok(!/dist\/(mission\/|stats|trajectory)/.test(md), 'no tiles, stat chips or line chart');
  const after = md.slice(md.indexOf(profile.intro.line.text) + profile.intro.line.text.length);
  const row = after.slice(after.indexOf('\n<p>\n'));
  assert.ok(after.indexOf('\n<p>\n') >= 0 && !row.slice(4).includes('\n\n'), 'one badge row after the line and its facts');
  const links = [...row.matchAll(/<a href="([^"]+)"><picture><source media="\(prefers-color-scheme: dark\)" srcset="(dist\/badges\/[^"]+-dark\.svg)"><img src="(dist\/badges\/[^"]+-light\.svg)" alt="([^"]+)" height="28"><\/picture><\/a>/g)];
  assert.deepEqual(links.map((m) => m[1]), ['https://github.com/stripe/stripe-node/pull/9', 'https://github.com/cloudflare/workerd/pull/6134'], 'newest first');
  assert.deepEqual(links.map((m) => m[4]), ['Merged PR stripe/stripe-node#9: Keep key order', 'Open PR cloudflare/workerd#6134: Fix &lt;off-by-one&gt; &amp; &quot;overflow&quot;']);
  for (const m of links) for (const f of [m[2], m[3]]) assert.ok(existsSync(join(out, f)), `${f} rendered`);
  assert.ok(!/^#/m.test(md), 'no heading');
  const r = check(out);
  assert.equal(r.status, 0, r.stderr);
});

test('M1.T6: with no PRs yet the README renders no tiles, no badges and no heading, and check passes', async () => {
  const out = tmp('readme-');
  await withData(out, []);
  assert.equal(render(out).status, 0);
  const md = readme(out);
  assert.ok(!/^#/m.test(md));
  assert.ok(!/dist\/(mission\/|stats|trajectory|badges\/)/.test(md));
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
