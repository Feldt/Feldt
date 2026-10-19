#!/usr/bin/env node
// Leak scanner. Finds denylisted strings and non-noreply git identities in anything about to go public.
// The denylist lives outside every repo (LEAKS_DENYLIST, or the run folder default). Hits name the
// denylist line number, never the matched text, so output is safe to keep.
//
//   leaks.mjs <file|dir>...           scan files (a git dir scans its tracked files)
//   leaks.mjs --stdin                 scan stdin
//   leaks.mjs --history <repo> [--not-remote <name>]   every branch: added lines, blobs, messages, identities
//   leaks.mjs --pre-push <remote> <url>   git pre-push hook mode (refs on stdin)
//   leaks.mjs --check-clone <dir>    is this clone's hook active, current and its identity noreply?
//   leaks.mjs --all                   run repos, oss clones, forks, PR text, Action logs
// Exit 0 clean, 1 leak, 2 bad input or no denylist.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve, dirname, relative, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN_DIR = join(homedir(), '.claude', 'marathon', 'github-aura-20261019');
const ZERO = /^0+$/;
const OK_EMAIL = /(@users\.noreply\.github\.com|^noreply@github\.com)$/i;

// Denylist lines: a literal matches case-insensitively where it isn't glued to other letters or digits;
// `sub:` matches anywhere (usernames, hostnames); `re:` is a case-sensitive regex, `rei:` ignores case.
// Lower case with whitespace runs (line wraps included) collapsed, so a phrase wrapped across lines still matches.
const squash = (t) => t.toLowerCase().replace(/\s+/gu, ' ');

export function loadDenylist(path = process.env.LEAKS_DENYLIST || join(RUN_DIR, 'denylist.txt')) {
  if (!existsSync(path)) throw new Error(`denylist not found: ${path}`);
  const lits = [], subs = [], res = [];
  readFileSync(path, 'utf8').split('\n').forEach((raw, i) => {
    const line = raw.trim(), n = i + 1;
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('rei:')) res.push({ n, re: new RegExp(line.slice(4), 'iu') });
    else if (line.startsWith('re:')) res.push({ n, re: new RegExp(line.slice(3), 'u') });
    else if (line.startsWith('sub:')) subs.push({ n, s: squash(line.slice(4)) });
    else lits.push({ n, s: squash(line) });
  });
  return { lits, subs, res };
}

const isWord = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

// Returns denylist line numbers found in text.
export function findHits(text, deny) {
  const lower = squash(text), hits = new Set();
  for (const { n, s } of deny.lits) {
    let at = lower.indexOf(s);
    while (at !== -1) {
      const before = lower[at - 1], after = lower[at + s.length];
      // boundaries only matter where the entry itself starts/ends with a word character
      if ((!isWord(s[0]) || !isWord(before)) && (!isWord(s[s.length - 1]) || !isWord(after))) { hits.add(n); break; }
      at = lower.indexOf(s, at + 1);
    }
  }
  for (const { n, s } of deny.subs) if (lower.includes(s)) hits.add(n);
  for (const { n, re } of deny.res) if (re.test(text)) hits.add(n);
  return [...hits].sort((a, b) => a - b);
}

// Every way a blob's bytes could read as text: UTF-8, UTF-16 (either order), and Latin-1.
export function decodings(buf) {
  const out = [buf.toString('utf8')];
  if (buf.includes(0)) {
    out.push(buf.toString('utf16le'));
    const sw = Buffer.from(buf.subarray(0, buf.length - (buf.length % 2))); sw.swap16(); out.push(sw.toString('utf16le'));
    out.push(buf.toString('latin1').replace(/\0/g, ''));
  }
  return out;
}
const isText = (buf) => !buf.includes(0) && Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
const bufHits = (buf, deny) => [...new Set(decodings(buf).flatMap((t) => findHits(t, deny)))].sort((a, b) => a - b);

const git = (dir, args, input) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, input });
const run0 = (dir, args) => { try { execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' }); return true; } catch { return false; } };
const gitBuf = (dir, args) => execFileSync('git', ['-C', dir, ...args], { maxBuffer: 1 << 30 });
const EMPTY = /^0+$/;

// What a commit adds to the world: lines added to text files (not context or removed lines, which
// were already public wherever the parent is), the whole of any non-text blob, and every new path.
function addedContent(dir, sha) {
  const parents = git(dir, ['show', '-s', '--format=%P', sha]).trim().split(' ').filter(Boolean);
  // a merge only adds what differs from every parent (conflict resolutions)
  const raw = parents.length > 1
    ? git(dir, ['diff-tree', '-r', '-z', '--no-commit-id', '-c', '--no-renames', sha])
    : git(dir, ['diff-tree', '-r', '-z', '--no-commit-id', '--root', '--no-renames', sha]);
  const f = raw.split('\0'); const items = [];
  for (let i = 0; i < f.length - 1; i += 2) {
    const meta = f[i].replace(/^:+/, '').split(' '), path = f[i + 1];
    const status = meta[meta.length - 1];
    if (/^D+$/.test(status)) continue;
    const shas = meta.filter((m) => /^[0-9a-f]{7,}$/.test(m));
    const newSha = shas[shas.length - 1], oldSha = parents.length > 1 ? shas[0] : shas[0];
    if (!newSha || EMPTY.test(newSha) || meta.includes('160000')) { items.push({ path }); continue; }
    items.push({ path, newSha, oldSha: EMPTY.test(oldSha) || oldSha === newSha ? null : oldSha });
  }
  return items;
}

export function scanCommits(dir, revArgs, deny, label = dir) {
  const problems = [];
  const shas = git(dir, ['rev-list', ...revArgs]).split('\n').filter(Boolean);
  for (const sha of shas) {
    const at = `${label} ${sha.slice(0, 7)}`;
    const [an, ae, cn, ce] = git(dir, ['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce', sha]).trim().split('\0');
    if (!OK_EMAIL.test(ae)) problems.push(`${at}: author email is not a GitHub noreply address`);
    if (!OK_EMAIL.test(ce)) problems.push(`${at}: committer email is not a GitHub noreply address`);
    const head = `${an}\n${ae}\n${cn}\n${ce}\n` + git(dir, ['show', '-s', '--format=%B', sha]);
    for (const n of findHits(head, deny)) problems.push(`${at}: denylist line ${n} (message or identity)`);
    for (const { path, newSha, oldSha } of addedContent(dir, sha)) {
      for (const n of findHits(path, deny)) problems.push(`${at}: path matches denylist line ${n}`);
      if (!newSha) continue;
      const blob = gitBuf(dir, ['cat-file', 'blob', newSha]);
      let hits;
      if (!isText(blob) || !oldSha) hits = bufHits(blob, deny);
      else {
        const old = gitBuf(dir, ['cat-file', 'blob', oldSha]);
        if (!isText(old)) hits = bufHits(blob, deny);
        else {
          const diff = git(dir, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--text', oldSha, newSha]);
          const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
          hits = findHits(added, deny);
        }
      }
      for (const n of hits) problems.push(`${at}: ${path}: denylist line ${n}`);
    }
  }
  return problems;
}

// Returns [absolute path, path as published]: a repo's files are named relative to the repo root.
function walk(p, out = [], root = null) {
  const st = statSync(p);
  if (st.isFile()) { out.push([p, root ? relative(root, p) : basename(p)]); return out; }
  if (existsSync(join(p, '.git'))) {
    for (const f of git(p, ['ls-files', '-z']).split('\0').filter(Boolean)) if (existsSync(join(p, f))) out.push([join(p, f), f]);
    return out;
  }
  for (const e of readdirSync(p)) if (e !== '.git' && e !== 'node_modules') walk(join(p, e), out, root || p);
  return out;
}

export function scanFiles(paths, deny) {
  const problems = [];
  for (const [f, name] of paths.flatMap((p) => walk(resolve(p)))) {
    for (const n of bufHits(readFileSync(f), deny)) problems.push(`${name}: denylist line ${n}`);
    for (const n of findHits(name, deny)) problems.push(`${name}: path matches denylist line ${n}`);
  }
  return problems;
}

// Pre-push: everything the push makes public that isn't public already. Public already means reachable
// from the remote being pushed to, or from `upstream` (the public project an oss clone forks).
// Other remotes may be private, so they prove nothing.
export function prePush(dir, refLines, deny, remote = '') {
  const problems = [];
  const remotes = git(dir, ['remote']).split('\n').filter(Boolean);
  const known = ['upstream', remote].filter((r) => remotes.includes(r)).map((r) => `--remotes=${r}`);
  for (const line of refLines.split('\n').filter(Boolean)) {
    const [, localSha, remoteRef, remoteSha] = line.split(' ');
    if (ZERO.test(localSha)) continue; // deleting a remote ref publishes nothing
    for (const n of findHits(remoteRef, deny)) problems.push(`${remoteRef}: ref name matches denylist line ${n}`);
    let target = localSha;
    while (git(dir, ['cat-file', '-t', target]).trim() === 'tag') {
      const tag = git(dir, ['cat-file', 'tag', target]);
      const tagger = (tag.match(/^tagger .*<([^>]*)>/m) || [])[1];
      if (tagger !== undefined && !OK_EMAIL.test(tagger)) problems.push(`${remoteRef}: tagger email is not a GitHub noreply address`);
      for (const n of findHits(tag, deny)) problems.push(`${remoteRef}: tag denylist line ${n}`);
      target = (tag.match(/^object ([0-9a-f]+)/m) || [])[1];
    }
    if (git(dir, ['cat-file', '-t', target]).trim() !== 'commit') {
      for (const n of bufHits(gitBuf(dir, ['cat-file', '-p', target]), deny)) problems.push(`${remoteRef}: object denylist line ${n}`);
      continue;
    }
    // a remote tip we never fetched (e.g. a maintainer's edit to a PR branch) can't be excluded locally
    const haveRemote = !ZERO.test(remoteSha) && run0(dir, ['cat-file', '-e', `${remoteSha}^{commit}`]);
    const rev = [target, '--not', ...known, ...(haveRemote ? [remoteSha] : [])];
    problems.push(...scanCommits(dir, rev, deny, remoteRef));
  }
  return problems;
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const ghJson = (args) => JSON.parse(gh(args) || 'null');

function textHits(label, text, deny) { return findHits(text || '', deny).map((n) => `${label}: denylist line ${n}`); }

// Is this clone really guarded? Uses git's own effective hooks dir (so a core.hooksPath set later,
// e.g. by husky on npm install, shows up), and the hook's scanner copy must match the current one.
export function checkClone(d) {
  const problems = [];
  let hooks = git(d, ['rev-parse', '--git-path', 'hooks']).trim();
  if (!isAbsolute(hooks)) hooks = join(d, hooks);
  const hook = join(hooks, 'pre-push'), copy = join(hooks, 'leaks.mjs');
  if (!existsSync(hook) || !readFileSync(hook, 'utf8').includes('installed by install-hooks.mjs')) problems.push('pre-push hook not active (core.hooksPath changed, or install-hooks.mjs not run)');
  else if (!existsSync(copy) || !readFileSync(copy).equals(readFileSync(fileURLToPath(import.meta.url)))) problems.push("the hook's scanner copy is out of date (re-run install-hooks.mjs)");
  let email = ''; try { email = git(d, ['config', 'user.email']).trim(); } catch {}
  if (!OK_EMAIL.test(email)) problems.push('user.email is not the noreply address');
  return problems;
}

// Everything this run made public. Older public repos are reported, not gated.
export function scanAll(deny, { here = dirname(dirname(fileURLToPath(import.meta.url))) } = {}) {
  const gated = [], reported = [];
  gated.push(...scanFiles([here], deny), ...scanCommits(here, ['--all'], deny, 'Feldt/Feldt'));
  const clones = join(dirname(here), 'oss-aura');
  if (existsSync(clones)) for (const c of readdirSync(clones)) {
    const d = join(clones, c);
    if (!existsSync(join(d, '.git'))) continue;
    gated.push(...checkClone(d).map((p) => `${c}: ${p}`));
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
  } else if (args[0] === '--pre-push') problems = prePush(process.cwd(), readFileSync(0, 'utf8'), deny, args[1]);
  else if (args[0] === '--check-clone') { if (!args[1]) return usage(); problems = checkClone(resolve(args[1])); }
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
