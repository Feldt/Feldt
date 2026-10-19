import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
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

test('M1.T0a: install-hooks sets the noreply identity and removes a bypassing hooksPath', () => {
  const { clone } = setup();
  assert.equal(git(clone, ['config', 'user.email']).trim(), '204218226+Feldt@users.noreply.github.com');
  assert.equal(git(clone, ['config', 'user.name']).trim(), 'Feldt');
  assert.equal(run('git', ['-C', clone, 'config', 'core.hooksPath']).status, 1);
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
