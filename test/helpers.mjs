import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

export const tmp = (p = 'aura-') => realpathSync(mkdtempSync(join(tmpdir(), p)));
// Planted fakes are built at runtime so no test file carries a real denylisted string.
export const FAKE = ['zq', 'plant', 'ed-', 'org'].join('');
export function fakeDenylist(lines = [FAKE, 're:\\.zzlan\\b']) {
  const f = join(tmp('deny-'), 'denylist.txt');
  writeFileSync(f, '# test denylist\n' + lines.join('\n') + '\n');
  return f;
}
export const git = (dir, args, env = {}) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
export const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts, env: { ...process.env, ...(opts.env || {}) } });
export const NOREPLY = { GIT_AUTHOR_NAME: 'Feldt', GIT_AUTHOR_EMAIL: '204218226+Feldt@users.noreply.github.com', GIT_COMMITTER_NAME: 'Feldt', GIT_COMMITTER_EMAIL: '204218226+Feldt@users.noreply.github.com' };
export function repo() {
  const d = tmp('repo-');
  git(d, ['init', '-q', '-b', 'main']);
  return d;
}
export function commit(d, file, text, env = NOREPLY) {
  writeFileSync(join(d, file), text);
  git(d, ['add', file]);
  git(d, ['commit', '-q', '-m', `add ${file}`], env);
}
