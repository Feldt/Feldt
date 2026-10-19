#!/usr/bin/env node
// Leak scanner. Finds denylisted strings and non-noreply git identities in anything about to go public.
// The denylist lives outside every repo (LEAKS_DENYLIST, or the run folder default). Hits name the
// denylist line number, never the matched text, so output is safe to keep.
//
//   leaks.mjs <file|dir>...           scan files (a git dir scans its tracked files)
//   leaks.mjs --stdin                 scan stdin
//   leaks.mjs --history <repo> [--not-remote <name>]   every branch: patches, messages, identities
//   leaks.mjs --pre-push <remote> <url>   git pre-push hook mode (refs on stdin)
//   leaks.mjs --all                   run repos, oss clones, forks, PR text, Action logs
// Exit 0 clean, 1 leak, 2 bad input or no denylist.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN_DIR = join(homedir(), '.claude', 'marathon', 'github-aura-20261019');
const ZERO = /^0+$/;
const OK_EMAIL = /(@users\.noreply\.github\.com|^noreply@github\.com)$/i;

export function loadDenylist(path = process.env.LEAKS_DENYLIST || join(RUN_DIR, 'denylist.txt')) {
  if (!existsSync(path)) throw new Error(`denylist not found: ${path}`);
  const lits = [], res = [];
  readFileSync(path, 'utf8').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('re:')) res.push({ n: i + 1, re: new RegExp(line.slice(3), 'iu') });
    else lits.push({ n: i + 1, s: line.toLowerCase() });
  });
  return { lits, res };
}

const isWord = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

// Returns denylist line numbers found in text.
export function findHits(text, deny) {
  const lower = text.toLowerCase(), hits = new Set();
  for (const { n, s } of deny.lits) {
    let at = lower.indexOf(s);
    while (at !== -1) {
      const before = lower[at - 1], after = lower[at + s.length];
      // boundaries only matter where the entry itself starts/ends with a word character
      if ((!isWord(s[0]) || !isWord(before)) && (!isWord(s[s.length - 1]) || !isWord(after))) { hits.add(n); break; }
      at = lower.indexOf(s, at + 1);
    }
  }
  for (const { n, re } of deny.res) if (re.test(text)) hits.add(n);
  return [...hits].sort((a, b) => a - b);
}

const git = (dir, args, input) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, input });

// Scans commits selected by rev-list args: identity, message and patch.
export function scanCommits(dir, revArgs, deny, label = dir) {
  const problems = [];
  const shas = git(dir, ['rev-list', ...revArgs]).split('\n').filter(Boolean);
  for (const sha of shas) {
    const [an, ae, cn, ce] = git(dir, ['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce', sha]).trim().split('\0');
    if (!OK_EMAIL.test(ae)) problems.push(`${label} ${sha.slice(0, 7)}: author email is not a GitHub noreply address`);
    if (!OK_EMAIL.test(ce)) problems.push(`${label} ${sha.slice(0, 7)}: committer email is not a GitHub noreply address`);
    const body = `${an}\n${cn}\n` + git(dir, ['show', '--format=%B', '--patch', '--binary', '--no-color', sha]);
    for (const n of findHits(body, deny)) problems.push(`${label} ${sha.slice(0, 7)}: denylist line ${n}`);
  }
  return problems;
}

function walk(p, out = []) {
  const st = statSync(p);
  if (st.isFile()) { out.push(p); return out; }
  if (existsSync(join(p, '.git'))) {
    for (const f of git(p, ['ls-files', '-z']).split('\0').filter(Boolean)) if (existsSync(join(p, f))) out.push(join(p, f));
    return out;
  }
  for (const e of readdirSync(p)) if (e !== '.git' && e !== 'node_modules') walk(join(p, e), out);
  return out;
}

export function scanFiles(paths, deny) {
  const problems = [];
  for (const f of paths.flatMap((p) => walk(resolve(p)))) {
    for (const n of findHits(readFileSync(f, 'utf8'), deny)) problems.push(`${f}: denylist line ${n}`);
    if (findHits(f, deny).length) problems.push(`${f}: path matches the denylist`);
  }
  return problems;
}

export function prePush(dir, refLines, deny) {
  const problems = [];
  for (const line of refLines.split('\n').filter(Boolean)) {
    const [, localSha, remoteRef, remoteSha] = line.split(' ');
    if (ZERO.test(localSha)) continue; // deleting a remote ref publishes nothing
    const rev = ZERO.test(remoteSha) ? [localSha, '--not', '--remotes'] : [`${remoteSha}..${localSha}`];
    problems.push(...scanCommits(dir, rev, deny, remoteRef));
    for (const n of findHits(remoteRef, deny)) problems.push(`${remoteRef}: branch name matches denylist line ${n}`);
  }
  return problems;
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const ghJson = (args) => JSON.parse(gh(args) || 'null');

function textHits(label, text, deny) { return findHits(text || '', deny).map((n) => `${label}: denylist line ${n}`); }

// Everything this run made public. Older public repos are reported, not gated.
export function scanAll(deny, { here = dirname(dirname(fileURLToPath(import.meta.url))) } = {}) {
  const gated = [], reported = [];
  gated.push(...scanFiles([here], deny), ...scanCommits(here, ['--all'], deny, 'Feldt/Feldt'));
  const clones = join(dirname(here), 'oss-aura');
  if (existsSync(clones)) for (const c of readdirSync(clones)) {
    const d = join(clones, c);
    if (!existsSync(join(d, '.git'))) continue;
    const remotes = git(d, ['remote']).split('\n');
    const not = remotes.includes('upstream') ? ['--not', '--remotes=upstream'] : ['--not', '--remotes'];
    gated.push(...scanCommits(d, ['--branches', ...(remotes.includes('origin') ? ['--remotes=origin'] : []), ...not], deny, c));
  }
  const user = 'Feldt';
  for (const r of ghJson(['repo', 'list', user, '--limit', '200', '--json', 'nameWithOwner,isFork,createdAt']) || []) {
    if (r.nameWithOwner === 'Feldt/Feldt') continue;
    const mine = r.isFork || r.createdAt >= '2026-10-19' ? gated : reported;
    const repo = ghJson(['api', `repos/${r.nameWithOwner}`]);
    for (const b of ghJson(['api', `repos/${r.nameWithOwner}/branches`, '--paginate']) || []) {
      const base = repo.parent ? `${repo.parent.owner.login}:${repo.parent.default_branch}` : null;
      const commits = base
        ? (ghJson(['api', `repos/${r.nameWithOwner}/compare/${base}...${user}:${b.name}`]) || {}).commits || []
        : ghJson(['api', `repos/${r.nameWithOwner}/commits?sha=${b.name}&per_page=100`]) || [];
      for (const c of commits) {
        const label = `${r.nameWithOwner}@${b.name} ${c.sha.slice(0, 7)}`;
        for (const who of [c.commit.author, c.commit.committer]) if (!OK_EMAIL.test(who.email)) mine.push(`${label}: ${who === c.commit.author ? 'author' : 'committer'} email is not a GitHub noreply address`);
        const full = ghJson(['api', `repos/${r.nameWithOwner}/commits/${c.sha}`]);
        mine.push(...textHits(label, c.commit.message + '\n' + (full.files || []).map((f) => f.filename + '\n' + (f.patch || '')).join('\n'), deny));
      }
    }
  }
  const prs = ghJson(['search', 'prs', '--author', user, '--limit', '200', '--json', 'url,title,body,repository,number']) || [];
  const discussed = ghJson(['search', 'issues', '--commenter', user, '--include-prs', '--limit', '200', '--json', 'url,repository,number']) || [];
  const seen = new Set();
  for (const p of [...prs, ...discussed]) {
    if (seen.has(p.url)) continue; seen.add(p.url);
    const nwo = p.repository.nameWithOwner;
    if (p.title !== undefined) gated.push(...textHits(p.url, `${p.title}\n${p.body}`, deny));
    const comments = [
      ...(ghJson(['api', `repos/${nwo}/issues/${p.number}/comments`, '--paginate']) || []),
      ...(p.title !== undefined ? ghJson(['api', `repos/${nwo}/pulls/${p.number}/comments`, '--paginate']) || [] : []),
    ].filter((c) => c.user?.login === user);
    for (const c of comments) gated.push(...textHits(c.html_url, c.body, deny));
  }
  for (const run of ghJson(['run', 'list', '-R', 'Feldt/Feldt', '--limit', '10', '--json', 'databaseId']) || []) {
    let log = '';
    try { log = gh(['run', 'view', String(run.databaseId), '-R', 'Feldt/Feldt', '--log']); } catch { continue; }
    gated.push(...textHits(`Action run ${run.databaseId}`, log, deny));
  }
  return { gated, reported };
}

function main(argv) {
  let deny;
  try { deny = loadDenylist(argv.includes('--denylist') ? argv[argv.indexOf('--denylist') + 1] : undefined); }
  catch (e) { console.error(`leaks: ${e.message}`); return 2; }
  const args = argv.filter((a, i) => a !== '--denylist' && argv[i - 1] !== '--denylist');
  let problems = [];
  if (args[0] === '--stdin') problems = textHits('stdin', readFileSync(0, 'utf8'), deny);
  else if (args[0] === '--history') {
    const dir = args[1]; if (!dir) return usage();
    const not = args.indexOf('--not-remote');
    problems = scanCommits(dir, not > 0 ? ['--all', '--not', `--remotes=${args[not + 1]}`] : ['--all'], deny);
  } else if (args[0] === '--pre-push') problems = prePush(process.cwd(), readFileSync(0, 'utf8'), deny);
  else if (args[0] === '--all') {
    const { gated, reported } = scanAll(deny);
    for (const r of reported) console.log(`report (older repo, not gated): ${r}`);
    problems = gated;
  } else if (args.length) problems = scanFiles(args, deny);
  else return usage();
  for (const p of problems) console.error(`leak: ${p}`);
  if (problems.length) { console.error(`leaks: ${problems.length} problem(s); refusing`); return 1; }
  console.log('leaks: clean');
  return 0;
}

function usage() { console.error('usage: leaks.mjs <path>... | --stdin | --history <repo> [--not-remote <name>] | --pre-push <remote> <url> | --all'); return 2; }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
