#!/usr/bin/env node
// install-hooks.mjs <clone> [--upstream <remote>]: guards a clone before anything is pushed from it.
// - sets the Feldt noreply identity;
// - points core.hooksPath at <git dir>/aura-hooks: a pre-push that runs leaks.mjs, then the repo's own
//   pre-push; every other hook just runs the repo's own (the folder core.hooksPath used before);
// - puts `leaks.mjs --gate` first among the GitHub credential helpers, so a push refuses before it
//   authenticates when the hook is no longer the one git will run (husky resetting core.hooksPath);
// - with --upstream, records the public project's remote and URL: only its refs count as already public.
import { execFileSync } from 'node:child_process';
import { writeFileSync, chmodSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NAME = 'Feldt';
export const EMAIL = '204218226+Feldt@users.noreply.github.com';
export const MARKER = 'installed by install-hooks.mjs';
export const HOSTS = ['https://github.com'];
const LEAKS = join(dirname(fileURLToPath(import.meta.url)), 'leaks.mjs');
const CHAINED = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'post-rewrite', 'reference-transaction', 'push-to-checkout'];

export function installHooks(clone, { upstream, hosts = HOSTS } = {}) {
  const dir = resolve(clone);
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const get = (...a) => { try { return git('config', ...a); } catch (e) { if (e.status === 1) return ''; throw e; } };
  const unset = (k) => { try { git('config', '--local', '--unset-all', k); } catch (e) { if (e.status !== 5) throw e; } };
  git('config', 'user.name', NAME);
  git('config', 'user.email', EMAIL);

  let common = git('rev-parse', '--git-common-dir');
  if (!isAbsolute(common)) common = join(dir, common);
  const aura = join(common, 'aura-hooks');
  // the repo's own hooks keep running after ours: whatever core.hooksPath pointed at before
  let prev = get('core.hooksPath');
  if (prev && !isAbsolute(prev)) prev = join(git('rev-parse', '--show-toplevel'), prev);
  if (!prev) prev = join(common, 'hooks');
  if (resolve(prev) !== resolve(aura)) git('config', 'aura.chainHooks', prev);

  mkdirSync(aura, { recursive: true });
  copyFileSync(LEAKS, join(aura, 'leaks.mjs'));
  const hook = join(aura, 'pre-push');
  writeFileSync(hook, `#!/bin/sh\n# ${MARKER}\nexec node "$(dirname "$0")/leaks.mjs" --pre-push "$@"\n`);
  chmodSync(hook, 0o755);
  for (const name of CHAINED) {
    const f = join(aura, name);
    writeFileSync(f, `#!/bin/sh\n# ${MARKER} (runs the repo's own ${name})\nc="$(git config aura.chainHooks)"\n[ -n "$c" ] && [ -x "$c/${name}" ] && exec "$c/${name}" "$@"\nexit 0\n`);
    chmodSync(f, 0o755);
  }
  git('config', '--local', 'core.hooksPath', aura);

  const gate = `!node "${join(aura, 'leaks.mjs')}" --gate`;
  for (const host of hosts) {
    const key = `credential.${host}.helper`;
    const others = get('--get-all', key).split('\n').filter((h) => h && !h.includes('--gate'));
    unset(key);
    git('config', '--local', '--add', key, ''); // reset the inherited list, then gate first
    git('config', '--local', '--add', key, gate);
    for (const h of others) git('config', '--local', '--add', key, h);
  }

  if (upstream) {
    git('config', 'aura.upstream', upstream);
    git('config', 'aura.upstreamUrl', git('remote', 'get-url', upstream));
  }
  return hook;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [clone, ...rest] = process.argv.slice(2);
  if (!clone || !existsSync(clone)) { console.error('usage: install-hooks.mjs <clone> [--upstream <remote>] [--host <url>]...'); process.exit(2); }
  const opt = (k) => rest.flatMap((a, i) => (a === k ? [rest[i + 1]] : []));
  try { console.log(`hook: ${installHooks(clone, { upstream: opt('--upstream')[0], hosts: opt('--host').length ? opt('--host') : HOSTS })}`); }
  catch (e) { console.error(e.message); process.exit(1); }
}
