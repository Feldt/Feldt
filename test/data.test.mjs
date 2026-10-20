// M1.T5 data: Feldt's public PRs from GitHub search, kept only for allowlisted orgs, become data.json
// and one mission tile per PR (tiles only, D22). A fetch error writes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmp } from './helpers.mjs';
import { svgProblems } from '../scripts/check.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const allow = JSON.parse(readFileSync(join(ROOT, 'pr-rules.json'), 'utf8')).orgs.map((o) => o.toLowerCase());

const pr = (repo, n, state, merged, created, title) => ({
  html_url: `https://github.com/${repo}/pull/${n}`, number: n, title, state, created_at: created,
  repository_url: `https://api.github.com/repos/${repo}`, user: { login: 'Feldt' },
  pull_request: { merged_at: merged },
});
const ITEMS = [
  pr('nasa/fprime', 6134, 'open', null, '2026-10-19T21:00:00Z', 'Fix <off-by-one> & overflow in Os::File'),
  pr('NASA-AMMOS/MMGIS', 442, 'closed', '2026-10-20T03:00:00Z', '2026-10-19T22:00:00Z', 'Keep layer order on reload'),
  pr('teslamotors/vehicle-command', 9, 'closed', null, '2026-10-19T23:00:00Z', 'closed unmerged: not shown'),
  pr('someone-else/random', 1, 'open', null, '2026-10-19T20:00:00Z', 'outside the allowlist'),
];

// a fake api.github.com: answers the search, records each query and its auth header
function fakeApi(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ path: u.pathname, q: u.searchParams.get('q'), auth: req.headers.authorization });
    handler(u, res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}
function data(out, api) {
  return new Promise((ok) => {
    const p = spawn('node', [join(ROOT, 'scripts', 'data.mjs'), '--out', out], { env: { ...process.env, GITHUB_API_URL: api, GITHUB_TOKEN: 'test-token' } });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => ok({ status, stderr }));
  });
}
const files = (d) => (existsSync(d) ? readdirSync(d, { recursive: true }) : []);

test('M1.T5: a fetch error exits 1 and writes nothing', async () => {
  for (const fail of [(u, res) => { res.writeHead(500); res.end('boom'); }, (u, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"incomplete_results":true,"items":[]}'); }]) {
    const api = await fakeApi(fail), out = tmp('data-');
    const r = await data(out, api.url);
    api.server.close();
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual(files(out), []);
  }
});

test('M1.T5: it searches public PRs by Feldt with the token, and keeps only allowlisted orgs', async () => {
  const api = await fakeApi((u, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ total_count: ITEMS.length, incomplete_results: false, items: ITEMS })); });
  const out = tmp('data-');
  const r = await data(out, api.url);
  api.server.close();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(api.seen[0].path, '/search/issues');
  for (const term of ['is:pr', 'is:public', 'author:Feldt']) assert.ok(api.seen[0].q.split(' ').includes(term), api.seen[0].q);
  assert.equal(api.seen[0].auth, 'Bearer test-token');
  const d = JSON.parse(readFileSync(join(out, 'data.json'), 'utf8'));
  assert.ok(allow.includes('nasa') && allow.includes('nasa-ammos') && !allow.includes('someone-else'));
  assert.deepEqual(d.prs.map((p) => `${p.repo}#${p.number}:${p.state}`), ['nasa/fprime#6134:open', 'NASA-AMMOS/MMGIS#442:merged']);
  assert.deepEqual(d.stats, { prs: 2, merged: 1, open: 1, repos: 2, orgs: 2 });
});

test('M1.T5: one mission tile per PR, each a valid SVG carrying the data, and no stat chips or chart (D22)', async () => {
  const api = await fakeApi((u, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ total_count: ITEMS.length, incomplete_results: false, items: ITEMS })); });
  const out = tmp('data-');
  assert.equal((await data(out, api.url)).status, 0);
  api.server.close();
  const d = JSON.parse(readFileSync(join(out, 'data.json'), 'utf8'));
  for (const f of d.prs.map((p) => p.tile)) assert.deepEqual(svgProblems(join(out, f), f), [], f);
  assert.deepEqual(d.stats, { prs: 2, merged: 1, open: 1, repos: 2, orgs: 2 });
  assert.ok(!existsSync(join(out, 'dist', 'stats.svg')) && !existsSync(join(out, 'dist', 'trajectory.svg')));
  const tile = readFileSync(join(out, d.prs[0].tile), 'utf8');
  assert.match(tile, /nasa\/fprime/);
  assert.match(tile, /#6134/);
  assert.match(tile, /Fix &lt;off-by-one&gt; &amp; overflow/);
  assert.match(readFileSync(join(out, d.prs[1].tile), 'utf8'), /merged/);
});

test('M1.T5: no PRs yet writes data.json and no tiles', async () => {
  const api = await fakeApi((u, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"total_count":0,"incomplete_results":false,"items":[]}'); });
  const out = tmp('data-');
  assert.equal((await data(out, api.url)).status, 0);
  api.server.close();
  const d = JSON.parse(readFileSync(join(out, 'data.json'), 'utf8'));
  assert.deepEqual(d.prs, []);
  assert.ok(!existsSync(join(out, 'dist', 'mission')) || readdirSync(join(out, 'dist', 'mission')).length === 0);
});

// one fake API that serves `items` in pages of 100, like api.github.com
const paged = (items, fail = () => false) => (u, res) => {
  const page = Number(u.searchParams.get('page') || 1);
  if (fail(page)) { res.writeHead(502); res.end('bad gateway'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ total_count: items.length, incomplete_results: false, items: items.slice((page - 1) * 100, page * 100) }));
};
async function dataWith(out, handler) {
  const api = await fakeApi(handler);
  const r = await data(out, api.url);
  api.server.close();
  return r;
}
const tiles = (out) => (existsSync(join(out, 'dist', 'mission')) ? readdirSync(join(out, 'dist', 'mission')).sort() : []);
const snapshot = (out) => Object.fromEntries(files(out).filter((f) => f.endsWith('.svg') || f.endsWith('.json')).map((f) => [f, readFileSync(join(out, f), 'utf8')]));

test('M1.T5 r2: a rerun into the same folder drops tiles of PRs that closed unmerged or left the allowlist', async () => {
  const out = tmp('data-');
  const first = [pr('nasa/fprime', 5, 'open', null, '2026-10-19T21:00:00Z', 'a'), pr('NVIDIA/cutlass', 7, 'open', null, '2026-10-19T22:00:00Z', 'b')];
  assert.equal((await dataWith(out, paged(first))).status, 0);
  assert.equal(tiles(out).length, 2);
  const second = [pr('nasa/fprime', 5, 'closed', null, '2026-10-19T21:00:00Z', 'a'), pr('NVIDIA/cutlass', 7, 'open', null, '2026-10-19T22:00:00Z', 'b')];
  assert.equal((await dataWith(out, paged(second))).status, 0);
  const d = JSON.parse(readFileSync(join(out, 'data.json'), 'utf8'));
  assert.deepEqual(tiles(out), d.prs.map((p) => p.tile.split('/').pop()).sort(), 'tiles on disk are exactly the PRs in data.json');
  assert.equal(tiles(out).length, d.stats.prs);
});

test('M1.T5 r2: two allowlisted repos whose names join the same way still get one tile each', async () => {
  const out = tmp('data-');
  const items = [pr('google/deepmind-lab', 1, 'open', null, '2026-10-19T21:00:00Z', 'a'), pr('google-deepmind/lab', 1, 'open', null, '2026-10-19T22:00:00Z', 'b')];
  assert.equal((await dataWith(out, paged(items))).status, 0);
  const d = JSON.parse(readFileSync(join(out, 'data.json'), 'utf8'));
  assert.equal(new Set(d.prs.map((p) => p.tile)).size, 2, d.prs.map((p) => p.tile).join(' '));
  assert.equal(tiles(out).length, 2);
});

test('M1.T5 r2: every page is fetched, and a failure on any page or a malformed body leaves the last good output untouched', async () => {
  const out = tmp('data-');
  const many = Array.from({ length: 150 }, (_, i) => pr('nasa/fprime', i + 1, 'open', null, `2026-10-19T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`, `pr ${i + 1}`));
  assert.equal((await dataWith(out, paged(many))).status, 0);
  assert.equal(JSON.parse(readFileSync(join(out, 'data.json'), 'utf8')).stats.prs, 150, 'both pages counted');
  assert.equal(tiles(out).length, 150);
  const good = snapshot(out);
  const fresh = [...many, pr('nasa/fprime', 999, 'open', null, '2026-10-20T00:00:00Z', 'new')];
  for (const bad of [paged(fresh, (p) => p === 2), (u, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"items": [ not json'); }]) {
    const r = await dataWith(out, bad);
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual(snapshot(out), good, 'last good output unchanged');
  }
});

test('M1.T5a: a PR repeated across search pages and an issue in the results still give one tile per PR', async () => {
  const out = tmp('data-');
  const a = pr('nasa/fprime', 5, 'open', null, '2026-10-19T21:00:00Z', 'a');
  const issue = { ...pr('nasa/fprime', 7, 'open', null, '2026-10-19T22:00:00Z', 'an issue, not a PR') };
  delete issue.pull_request;
  issue.html_url = 'https://github.com/nasa/fprime/issues/7';
  assert.equal((await dataWith(out, paged([a, { ...a }, issue]))).status, 0);
  const d = JSON.parse(readFileSync(join(out, 'data.json'), 'utf8'));
  assert.deepEqual(d.prs.map((p) => `${p.repo}#${p.number}`), ['nasa/fprime#5']);
  assert.equal(d.stats.prs, 1);
  assert.deepEqual(tiles(out), ['nasa--fprime-5.svg']);
});

test('M1.T7: the same PRs give byte-identical output on a later run, so the hourly Action commits only on change', async () => {
  const items = paged(ITEMS);
  const a = tmp('data-'), b = tmp('data-');
  assert.equal((await dataWith(a, items)).status, 0);
  await new Promise((ok) => setTimeout(ok, 1100));
  assert.equal((await dataWith(b, items)).status, 0);
  assert.deepEqual(snapshot(b), snapshot(a));
});
