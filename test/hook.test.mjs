import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmp, FAKE, fakeDenylist, git, run, NOREPLY, commit } from './helpers.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTALL = join(ROOT, 'scripts', 'install-hooks.mjs');

function setup() {
  const remote = join(tmp('remote-'), 'r.git');
  git(tmp(), ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = join(tmp('clone-'), 'c');
  git(tmp(), ['clone', '-q', remote, seed]);
  git(seed, ['config', 'core.hooksPath', '/dev/null/nowhere']);
  const r = run('node', [INSTALL, seed]);
  assert.equal(r.status, 0, r.stderr);
  return { remote, clone: seed, env: { LEAKS_DENYLIST: fakeDenylist() } };
}
const push = (c, env, ...ref) => run('git', ['-C', c, 'push', '-q', 'origin', ...(ref.length ? ref : ['HEAD:main'])], { env });
const remoteHead = (remote, ref = 'main') => run('git', ['-C', remote, 'rev-parse', '--verify', '-q', ref]).stdout.trim();

test('M1.T0a: install-hooks sets the noreply identity and points core.hooksPath at its own hooks', () => {
  const { clone } = setup();
  assert.equal(git(clone, ['config', 'user.email']).trim(), '204218226+Feldt@users.noreply.github.com');
  assert.equal(git(clone, ['config', 'user.name']).trim(), 'Feldt');
  assert.match(git(clone, ['config', 'core.hooksPath']).trim(), /aura-hooks$/);
});

test('M1.T0a: a clean push goes through', () => {
  const { clone, remote, env } = setup();
  commit(clone, 'a.txt', 'clean\n', {});
  const r = push(clone, env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteHead(remote), git(clone, ['rev-parse', 'HEAD']).trim());
});

test('M1.T0a: a planted push is refused and the remote is unchanged', () => {
  const { clone, remote, env } = setup();
  commit(clone, 'a.txt', 'clean\n', {});
  assert.equal(push(clone, env).status, 0);
  const before = remoteHead(remote);
  commit(clone, 'b.txt', `oops ${FAKE}\n`, {});
  commit(clone, 'c.txt', 'later clean commit\n', {});
  const r = push(clone, env);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /denylist line 2/);
  assert.equal(remoteHead(remote), before);
});

test('M1.T0a: a new branch carrying a planted commit is refused', () => {
  const { clone, remote, env } = setup();
  commit(clone, 'a.txt', 'clean\n', {});
  assert.equal(push(clone, env).status, 0);
  git(clone, ['switch', '-q', '-c', 'fix']);
  commit(clone, 'b.txt', `${FAKE}\n`, {});
  const r = push(clone, env, 'fix');
  assert.notEqual(r.status, 0);
  assert.equal(remoteHead(remote, 'fix'), '');
});

test('M1.T0a: a non-noreply author or committer is refused', () => {
  const { clone, remote, env } = setup();
  commit(clone, 'a.txt', 'clean\n', { GIT_AUTHOR_EMAIL: 'fred@example.com' });
  const r = push(clone, env);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /author email/);
  git(clone, ['commit', '-q', '--amend', '--reset-author', '--no-edit'], { ...NOREPLY, GIT_COMMITTER_EMAIL: 'fred@example.com' });
  const r2 = push(clone, env);
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /committer email/);
  assert.equal(remoteHead(remote), '');
});

// An oss clone: upstream (public, other authors) and a fork as origin.
function ossSetup({ upstreamText = 'line one\nline two\nline three\n' } = {}) {
  const base = tmp('oss-');
  const up = join(base, 'up.git'), fork = join(base, 'fork.git'), seed = join(base, 'seed');
  git(base, ['init', '-q', '--bare', '-b', 'main', up]);
  git(base, ['clone', '-q', up, seed]);
  commit(seed, 'README.md', upstreamText, { ...NOREPLY, GIT_AUTHOR_EMAIL: 'maintainer@example.org', GIT_COMMITTER_EMAIL: 'maintainer@example.org' });
  git(seed, ['push', '-q', 'origin', 'HEAD:main']);
  git(base, ['clone', '-q', '--bare', up, fork]);
  const clone = join(base, 'clone');
  git(base, ['clone', '-q', fork, clone]);
  git(clone, ['remote', 'add', 'upstream', up]);
  git(clone, ['fetch', '-q', 'upstream']);
  assert.equal(run('node', [INSTALL, clone]).status, 0);
  return { up, fork, seed, clone, env: { LEAKS_DENYLIST: fakeDenylist() } };
}
const write = (d, f, data) => writeFileSync(join(d, f), data);
const add = (d, msg, env = {}) => { git(d, ['add', '-A']); git(d, ['commit', '-q', '-m', msg], env); };

test('M1.T0a: denylisted text inside a binary, UTF-16 or binary-attributed file is refused', () => {
  for (const [name, files] of [
    ['nul bytes', { 'a.bin': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(FAKE), Buffer.from([0])]) }],
    ['utf-16', { 'a.txt': Buffer.from('﻿hello ' + FAKE, 'utf16le') }],
    ['binary attribute', { '.gitattributes': '* binary\n', 'a.txt': `x ${FAKE}\n` }],
  ]) {
    const { clone, env } = setup();
    for (const [f, data] of Object.entries(files)) write(clone, f, data);
    add(clone, name);
    assert.notEqual(push(clone, env).status, 0, name);
  }
});

test('M1.T0a: an annotated tag with a denylisted message or a personal tagger email is refused', () => {
  const { clone, remote, env } = setup();
  commit(clone, 'a.txt', 'clean\n', {});
  assert.equal(push(clone, env).status, 0);
  git(clone, ['tag', '-a', 'v1', '-m', `release ${FAKE}`]);
  assert.notEqual(push(clone, env, 'v1').status, 0);
  git(clone, ['tag', '-a', 'v2', '-m', 'release'], { GIT_COMMITTER_EMAIL: 'fred@example.com' });
  const r = push(clone, env, 'v2');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /tagger email/);
  assert.equal(run('git', ['-C', remote, 'tag']).stdout.trim(), '');
});

test('M1.T0a: ref names, file paths and author names are scanned', () => {
  const { clone, env } = setup();
  commit(clone, 'a.txt', 'clean\n', {});
  assert.notEqual(push(clone, env, `HEAD:refs/heads/x-${FAKE}`).status, 0, 'branch name');
  const s2 = setup(); commit(s2.clone, `${FAKE}.txt`, 'clean\n', {});
  assert.notEqual(push(s2.clone, s2.env).status, 0, 'file path');
  const s3 = setup(); commit(s3.clone, 'a.txt', 'clean\n', { ...NOREPLY, GIT_AUTHOR_NAME: FAKE });
  assert.notEqual(push(s3.clone, s3.env).status, 0, 'author name');
});

test('M1.T0a: a commit already on some other (maybe private) remote is not trusted', () => {
  const { clone, env } = setup();
  const priv = join(tmp('priv-'), 'p.git');
  git(tmp(), ['init', '-q', '--bare', '-b', 'main', priv]);
  git(clone, ['remote', 'add', 'private', priv]);
  commit(clone, 'a.txt', `${FAKE}\n`, {});
  run('git', ['-C', clone, 'push', '-q', '--no-verify', 'private', 'HEAD:main']);
  git(clone, ['fetch', '-q', 'private']);
  assert.notEqual(push(clone, env).status, 0);
});

test('M1.T0a: upstream lines next to, or removed by, a fix do not block the push', () => {
  const { clone, env } = ossSetup({ upstreamText: `line one\nupstream says ${FAKE}\nline three\n` });
  git(clone, ['switch', '-q', '-c', 'fix']);
  write(clone, 'README.md', `line one\nupstream says ${FAKE}\nline three fixed\n`);
  add(clone, 'edit next to an upstream line');
  write(clone, 'README.md', 'line one\nline three fixed\n');
  add(clone, 'remove the upstream line');
  const r = push(clone, env, 'fix');
  assert.equal(r.status, 0, r.stderr);
});

test('M1.T0a: rebasing a PR branch onto new upstream commits by other authors is allowed', () => {
  const { clone, seed, env } = ossSetup();
  git(clone, ['switch', '-q', '-c', 'pr']);
  commit(clone, 'fix.txt', 'my fix\n', {});
  assert.equal(push(clone, env, 'pr').status, 0);
  commit(seed, 'NEWS.md', 'upstream news\n', { ...NOREPLY, GIT_AUTHOR_EMAIL: 'maintainer@example.org', GIT_COMMITTER_EMAIL: 'maintainer@example.org' });
  git(seed, ['push', '-q', 'origin', 'HEAD:main']);
  git(clone, ['fetch', '-q', 'upstream']);
  git(clone, ['rebase', '-q', 'upstream/main']);
  const r = run('git', ['-C', clone, 'push', '-q', '-f', 'origin', 'pr'], { env });
  assert.equal(r.status, 0, r.stderr);
});

test('M1.T0a: a denylisted line added to an existing text file is refused', () => {
  const { clone, remote, env } = setup();
  commit(clone, 'notes.md', 'line one\nline two\n', {});
  assert.equal(push(clone, env).status, 0);
  commit(clone, 'notes.md', `line one\nline two\nnew line ${FAKE}\n`, {});
  assert.notEqual(push(clone, env).status, 0);
  assert.notEqual(remoteHead(remote), git(clone, ['rev-parse', 'HEAD']).trim());
});

test('M1.T0a: --check-clone notices a hooksPath set after install, a stale scanner copy, and a personal email', () => {
  const { clone } = setup();
  const check = () => run('node', [join(ROOT, 'scripts', 'leaks.mjs'), '--check-clone', clone], { env: { LEAKS_DENYLIST: fakeDenylist() } });
  assert.equal(check().status, 0, check().stderr);
  git(clone, ['config', 'core.hooksPath', '.husky']);
  assert.match(check().stderr, /hook not active/);
  assert.equal(run('node', [INSTALL, clone]).status, 0);
  assert.equal(check().status, 0, check().stderr);
  const copy = join(git(clone, ['rev-parse', '--git-common-dir']).trim(), 'aura-hooks', 'leaks.mjs');
  writeFileSync(copy.startsWith('/') ? copy : join(clone, copy), '// neutered\n');
  assert.match(check().stderr, /out of date/);
  assert.equal(run('node', [INSTALL, clone]).status, 0);
  git(clone, ['config', 'user.email', 'fred@example.com']);
  assert.match(check().stderr, /user\.email/);
});

test('M1.T0a: a force push over a remote tip we never fetched is scanned, not crashed', () => {
  const { clone, remote, env } = setup();
  commit(clone, 'a.txt', 'clean\n', {});
  assert.equal(push(clone, env).status, 0);
  const other = join(tmp('other-'), 'o');
  git(tmp(), ['clone', '-q', remote, other]);
  commit(other, 'b.txt', 'maintainer edit\n');
  git(other, ['push', '-q', '--no-verify', 'origin', 'HEAD:main']);
  commit(clone, 'c.txt', 'my edit\n', {});
  const r = run('git', ['-C', clone, 'push', '-q', '-f', 'origin', 'HEAD:main'], { env });
  assert.equal(r.status, 0, r.stderr);
});
