#!/usr/bin/env node
// install-hooks.mjs <clone>: sets the Feldt noreply identity on the clone and installs a pre-push
// hook that runs leaks.mjs (denylist + identity) on every commit about to be published.
import { execFileSync } from 'node:child_process';
import { writeFileSync, chmodSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NAME = 'Feldt';
export const EMAIL = '204218226+Feldt@users.noreply.github.com';
export const MARKER = 'installed by install-hooks.mjs';
const LEAKS = join(dirname(fileURLToPath(import.meta.url)), 'leaks.mjs');

export function installHooks(clone) {
  const dir = resolve(clone);
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('config', 'user.name', NAME);
  git('config', 'user.email', EMAIL);
  // a custom hooksPath would bypass the hook; exit 5 just means none was set
  try { git('config', '--unset-all', 'core.hooksPath'); } catch (e) { if (e.status !== 5) throw e; }
  let common = git('rev-parse', '--git-common-dir');
  if (!isAbsolute(common)) common = join(dir, common);
  const hooks = join(common, 'hooks');
  mkdirSync(hooks, { recursive: true });
  // the hook carries its own copy of the scanner, so it keeps working if this checkout moves
  copyFileSync(LEAKS, join(hooks, 'leaks.mjs'));
  const hook = join(hooks, 'pre-push');
  writeFileSync(hook, `#!/bin/sh\n# ${MARKER}\nexec node "$(dirname "$0")/leaks.mjs" --pre-push "$@"\n`);
  chmodSync(hook, 0o755);
  return hook;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const clone = process.argv[2];
  if (!clone) { console.error('usage: install-hooks.mjs <clone>'); process.exit(2); }
  try { console.log(`hook: ${installHooks(clone)}`); }
  catch (e) { console.error(e.message); process.exit(1); }
}
