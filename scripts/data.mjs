#!/usr/bin/env node
// data.mjs --out <dir>: Feldt's public PRs -> <dir>/data.json and
// dist/mission/<org>--<repo>-<n>.svg (one tile per open or merged PR). Only PRs in pr-rules.json's orgs count;
// closed-unmerged PRs don't show. Every fetch finishes before anything is written, so a failed or incomplete
// search exits 1 and leaves the last good output alone. A good run replaces dist/mission whole, so a tile
// whose PR closed unmerged or left the allowlist goes away.
// Env: GITHUB_TOKEN (the Action's), GITHUB_API_URL (default https://api.github.com).
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const QUERY = 'is:pr is:public author:Feldt';
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "Menlo,Consolas,'DejaVu Sans Mono',monospace";
// one card look that reads on both GitHub themes
const CARD = { bg: '#161b22', border: '#30363d', text: '#e6edf3', dim: '#8b949e', open: '#3fb950', merged: '#a371f7', accent: '#f0883e' };

export async function fetchPrs({ api = process.env.GITHUB_API_URL || 'https://api.github.com', token = process.env.GITHUB_TOKEN } = {}) {
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const url = `${api}/search/issues?q=${encodeURIComponent(QUERY)}&sort=created&order=asc&per_page=100&page=${page}`;
    const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Feldt-profile', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    if (!res.ok) throw new Error(`search ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    if (body.incomplete_results !== false || !Array.isArray(body.items)) throw new Error('search returned incomplete results');
    items.push(...body.items);
    if (items.length >= body.total_count || body.items.length < 100) break;
  }
  return items;
}

export function shape(items, orgs) {
  const allow = new Set(orgs.map((o) => o.toLowerCase()));
  // search can repeat an item across pages, and only items with pull_request are PRs: one entry per PR url
  const seen = new Set();
  const prs = items
    .filter((it) => it.pull_request && !seen.has(it.html_url) && seen.add(it.html_url))
    .map((it) => {
      const repo = it.repository_url.replace(/^.*\/repos\//, '');
      const state = it.pull_request?.merged_at ? 'merged' : it.state === 'open' ? 'open' : 'closed';
      return { repo, org: repo.split('/')[0], number: it.number, title: it.title, url: it.html_url, state, created: it.created_at, merged: it.pull_request?.merged_at || null };
    })
    .filter((p) => allow.has(p.org.toLowerCase()) && p.state !== 'closed')
    .sort((a, b) => a.created.localeCompare(b.created) || a.url.localeCompare(b.url))
    .map((p) => ({ ...p, tile: tileOf(p.repo, p.number) }));
  return { prs, stats: statsOf(prs) };
}

// GitHub owner names never hold "--", so owner--repo can't collide (google/deepmind-lab vs google-deepmind/lab)
export const tileOf = (repo, number) => `dist/mission/${repo.replace('/', '--').toLowerCase()}-${number}.svg`;
export const statsOf = (prs) => ({
  prs: prs.length, merged: prs.filter((p) => p.state === 'merged').length, open: prs.filter((p) => p.state === 'open').length,
  repos: new Set(prs.map((p) => p.repo.toLowerCase())).size, orgs: new Set(prs.map((p) => p.org.toLowerCase())).size,
});

export function tileSvg(p) {
  const W = 420, H = 92, title = p.title.length > 52 ? `${p.title.slice(0, 51)}…` : p.title;
  const colour = p.state === 'merged' ? CARD.merged : CARD.open;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`${p.repo}#${p.number} ${p.state}: ${p.title}`)}">`
    + `<style>.r{font:600 14px ${FONT};fill:${CARD.text}}.n{font:13px ${MONO};fill:${CARD.dim}}.t{font:13px ${FONT};fill:${CARD.text}}.s{font:600 11px ${FONT};fill:#0d1117}</style>`
    + `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${CARD.bg}" stroke="${CARD.border}"/>`
    + `<text x="16" y="28" class="r">${esc(p.repo)}</text><text x="${W - 16}" y="28" text-anchor="end" class="n">#${p.number}</text>`
    + `<text x="16" y="54" class="t">${esc(title)}</text>`
    + `<rect x="16" y="64" width="62" height="18" rx="9" fill="${colour}"/><text x="47" y="77" text-anchor="middle" class="s">${p.state}</text></svg>\n`;
}

// Every file data.mjs publishes besides data.json, as { path: body }; check.mjs re-runs it on data.json.
export const dataFiles = ({ prs, stats }) => ({
  ...Object.fromEntries(prs.map((p) => [p.tile, tileSvg(p)])),
});
export const dataJson = ({ prs, stats }) => JSON.stringify({ query: QUERY, stats, prs }, null, 1) + '\n';

export async function build(out, opts = {}) {
  const orgs = JSON.parse(readFileSync(join(ROOT, 'pr-rules.json'), 'utf8')).orgs;
  const { prs, stats } = shape(await fetchPrs(opts), orgs); // throws before anything is written
  // render into a staging folder, then move it in: the mission folder is replaced whole, never merged
  const stage = join(out, '.data-new'), old = join(out, '.data-old');
  for (const d of [stage, old]) rmSync(d, { recursive: true, force: true });
  mkdirSync(join(stage, 'dist', 'mission'), { recursive: true });
  for (const [f, body] of Object.entries(dataFiles({ prs, stats }))) writeFileSync(join(stage, f), body);
  writeFileSync(join(stage, 'data.json'), dataJson({ prs, stats }));
  mkdirSync(join(out, 'dist'), { recursive: true });
  if (existsSync(join(out, 'dist', 'mission'))) renameSync(join(out, 'dist', 'mission'), old);
  for (const f of ['dist/mission', 'data.json']) renameSync(join(stage, f), join(out, f));
  for (const d of [stage, old]) rmSync(d, { recursive: true, force: true });
  return { prs, stats };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  if (!out) { console.error('usage: data.mjs --out <dir>'); process.exit(2); }
  try { const { stats } = await build(resolve(out)); console.log(`data: ${JSON.stringify(stats)}`); }
  catch (e) { console.error(`data: ${e.message}; nothing written`); process.exit(1); }
}
