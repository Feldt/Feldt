// M1.T5 data: Feldt's public PRs from GitHub search, kept only for allowlisted orgs, become stat chips,
// a trajectory graph and one mission tile per PR. A fetch error writes nothing.
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

test('M1.T5: stat chips, trajectory and one mission tile per PR are valid SVGs carrying the data', async () => {
  const api = await fakeApi((u, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ total_count: ITEMS.length, incomplete_results: false, items: ITEMS })); });
  const out = tmp('data-');
  assert.equal((await data(out, api.url)).status, 0);
  api.server.close();
  const d = JSON.parse(readFileSync(join(out, 'data.json'), 'utf8'));
  for (const f of ['dist/stats.svg', 'dist/trajectory.svg', ...d.prs.map((p) => p.tile)]) {
    assert.deepEqual(svgProblems(join(out, f), f), [], f);
  }
  const stats = readFileSync(join(out, 'dist', 'stats.svg'), 'utf8');
  assert.match(stats, />2<\/text>[\s\S]*PRs/);
  assert.match(stats, />1<\/text>[\s\S]*merged/);
  const tile = readFileSync(join(out, d.prs[0].tile), 'utf8');
  assert.match(tile, /nasa\/fprime/);
  assert.match(tile, /#6134/);
  assert.match(tile, /Fix &lt;off-by-one&gt; &amp; overflow/);
  assert.match(readFileSync(join(out, d.prs[1].tile), 'utf8'), /merged/);
  const traj = readFileSync(join(out, 'dist', 'trajectory.svg'), 'utf8');
  assert.equal((traj.match(/<circle /g) || []).length, 2, 'one point per PR');
});

test('M1.T5: no PRs yet still renders chips, a trajectory and no tiles', async () => {
  const api = await fakeApi((u, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"total_count":0,"incomplete_results":false,"items":[]}'); });
  const out = tmp('data-');
  assert.equal((await data(out, api.url)).status, 0);
  api.server.close();
  const d = JSON.parse(readFileSync(join(out, 'data.json'), 'utf8'));
  assert.deepEqual(d.prs, []);
  for (const f of ['dist/stats.svg', 'dist/trajectory.svg']) assert.deepEqual(svgProblems(join(out, f), f), [], f);
  assert.ok(!existsSync(join(out, 'dist', 'mission')) || readdirSync(join(out, 'dist', 'mission')).length === 0);
});
