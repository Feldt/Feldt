import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { tmp, FAKE, fakeDenylist, git, run, NOREPLY, repo, commit } from './helpers.mjs';
import { loadDenylist, findHits, scanFiles } from '../scripts/leaks.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LEAKS = join(ROOT, 'scripts', 'leaks.mjs');
const leaks = (args, env, input) => run('node', [LEAKS, ...args], { env, input });

test('M1.T0a: literal entries match case-insensitively on word boundaries, regex entries match', () => {
  const deny = loadDenylist(fakeDenylist());
  assert.deepEqual(findHits(`see ${FAKE.toUpperCase()} here`, deny), [2]);
  assert.deepEqual(findHits(`x${FAKE}y`, deny), [], 'inside a longer word is not a hit');
  assert.deepEqual(findHits('host.zzlan:8080', deny), [3]);
  assert.deepEqual(findHits('nothing to see', deny), []);
});

test('M1.T0a: a planted file is refused and the output never echoes the matched text', () => {
  const env = { LEAKS_DENYLIST: fakeDenylist() };
  const d = tmp();
  writeFileSync(join(d, 'clean.md'), 'hello\n');
  assert.equal(leaks([d], env).status, 0);
  writeFileSync(join(d, 'bad.md'), `a line with ${FAKE} in it\n`);
  const r = leaks([d], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bad\.md: denylist line 2/);
  assert.ok(!(r.stdout + r.stderr).includes(FAKE));
});

test('M1.T0a: stdin is scanned', () => {
  const env = { LEAKS_DENYLIST: fakeDenylist() };
  assert.equal(leaks(['--stdin'], env, 'PR body, clean').status, 0);
  assert.equal(leaks(['--stdin'], env, `PR body mentioning ${FAKE}`).status, 1);
});

test('M1.T0a: history scan covers every branch and refuses non-noreply identities', () => {
  const env = { LEAKS_DENYLIST: fakeDenylist() };
  const d = repo();
  commit(d, 'a.txt', 'clean\n');
  assert.equal(leaks(['--history', d], env).status, 0);
  git(d, ['switch', '-q', '-c', 'side']);
  commit(d, 'b.txt', `${FAKE}\n`);
  git(d, ['rm', '-q', 'b.txt']); git(d, ['commit', '-q', '-m', 'remove'], NOREPLY);
  git(d, ['switch', '-q', 'main']);
  const r = leaks(['--history', d], env);
  assert.equal(r.status, 1, 'a hit removed later on another branch is still public history');
  const d2 = repo();
  commit(d2, 'a.txt', 'clean\n', { ...NOREPLY, GIT_AUTHOR_EMAIL: 'someone@example.com' });
  const r2 = leaks(['--history', d2], env);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /author email is not a GitHub noreply address/);
});

test('M1.T0a: a missing denylist fails closed', () => {
  const r = leaks(['--stdin'], { LEAKS_DENYLIST: join(tmp(), 'nope.txt') }, 'x');
  assert.equal(r.status, 2);
});

test('M1.T0a: the denylist lives outside the repo', () => {
  const tracked = git(ROOT, ['ls-files']).split('\n');
  assert.ok(!tracked.some((f) => /denylist/i.test(f) && !f.startsWith('test/') && !f.startsWith('scripts/')), 'no denylist file is tracked');
  const def = join(homedir(), '.claude', 'marathon', 'github-aura-20261019', 'denylist.txt');
  assert.ok(!def.startsWith(ROOT));
});

const REAL = join(homedir(), '.claude', 'marathon', 'github-aura-20261019', 'denylist.txt');
test('M1.T0a: the real denylist catches the local username, home paths and LAN hostnames', { skip: !existsSync(REAL) && 'no run-folder denylist on this machine' }, () => {
  const deny = loadDenylist(REAL);
  for (const s of ['by ' + 'allan' + 'feldt', 'at /Use' + 'rs/x/y', 'ssh mac.l' + 'an']) assert.ok(findHits(s, deny).length, `should catch a planted ${s.length}-char sample`);
  assert.ok(deny.lits.length > 20, 'private repo names and PR titles are listed');
});

test('M1.T0a: this repo has no denylisted strings', { skip: !existsSync(REAL) && 'no run-folder denylist on this machine' }, () => {
  assert.deepEqual(scanFiles([ROOT], loadDenylist(REAL)), []);
});

test('M1.T0a: re: entries are case-sensitive, rei: ignore case, sub: matches glued into other text', () => {
  const deny = loadDenylist(fakeDenylist(['re:/Zq/', 'rei:/qz/', `sub:${FAKE}`]));
  assert.deepEqual(findHits('GET /zq/Feldt', deny), []);
  assert.deepEqual(findHits('at /Zq/x', deny), [2]);
  assert.deepEqual(findHits('at /QZ/x', deny), [3]);
  assert.deepEqual(findHits(`host-x${FAKE}9.local`, deny), [4]);
});

test('M1.T0a: a multi-word entry wrapped across lines still matches', () => {
  const deny = loadDenylist(fakeDenylist([`fix the ${FAKE} sync`]));
  assert.deepEqual(findHits(`we fix the\n${FAKE}   sync today`, deny), [2]);
});
