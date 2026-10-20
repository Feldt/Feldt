// D24: the class test for "untested code path". Every script under scripts/ is measured while the rest of the suite
// runs, and its count of uncovered lines and branches must equal its cap below: a new branch, function or file that
// no test reaches raises a count and fails; a new test that covers more lowers a count and fails until the cap is
// lowered to match, so the caps only ever ratchet down. A script no test loads fails as unmeasured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// path -> [uncovered lines, uncovered branches], measured 2026-10-20; only ever lowered
export const CAPS = {
  'scripts/check.mjs': [3, 34], 'scripts/data.mjs': [0, 6], 'scripts/frames.mjs': [0, 2], 'scripts/install-hooks.mjs': [3, 5],
  'scripts/leaks.mjs': [114, 29], 'scripts/render.mjs': [0, 4], 'scripts/spike.mjs': [3, 8],
  'scripts/tiles/lib/logo.mjs': [9, 7], 'scripts/tiles/lib/png.mjs': [10, 12], 'scripts/tiles/tiles.mjs': [10, 12],
};

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.mjs') ? [join(d, e.name)] : []));
export const scriptsIn = (root) => walk(join(root, 'scripts')).map((f) => relative(root, f)).sort();

// lcov text -> { 'scripts/x.mjs': [uncovered lines, uncovered branches] }, paths relative to root
export function parseLcov(text, root) {
  const rows = {};
  for (const rec of text.split('end_of_record')) {
    const sf = /^SF:(.+)$/m.exec(rec)?.[1];
    if (!sf) continue;
    const n = (k) => Number(new RegExp(`^${k}:(\\d+)$`, 'm').exec(rec)?.[1] ?? 0);
    rows[relative(root, sf)] = [n('LF') - n('LH'), n('BRF') - n('BRH')];
  }
  return rows;
}

// every script must be measured and must match its cap exactly
export function capProblems(rows, scripts, caps = CAPS) {
  const out = [];
  for (const f of new Set([...scripts, ...Object.keys(caps)])) {
    const r = rows[f], c = caps[f];
    if (!r) { out.push(`${f}: no test loads it`); continue; }
    if (!c) { out.push(`${f}: no cap (measured ${r[0]} uncovered lines, ${r[1]} uncovered branches)`); continue; }
    for (const [k, i] of [['lines', 0], ['branches', 1]]) if (r[i] !== c[i]) out.push(`${f}: ${r[i]} uncovered ${k}, cap ${c[i]}${r[i] > c[i] ? ' (test the new code)' : ' (lower the cap)'}`);
  }
  return out;
}

test('D24: a cap refuses new untested code, a file with no cap, an unloaded script, and a stale cap', () => {
  const caps = { 'scripts/a.mjs': [1, 2] };
  assert.deepEqual(capProblems({ 'scripts/a.mjs': [1, 2] }, ['scripts/a.mjs'], caps), []);
  assert.deepEqual(capProblems({ 'scripts/a.mjs': [1, 3] }, ['scripts/a.mjs'], caps), ['scripts/a.mjs: 3 uncovered branches, cap 2 (test the new code)']);
  assert.deepEqual(capProblems({ 'scripts/a.mjs': [0, 2] }, ['scripts/a.mjs'], caps), ['scripts/a.mjs: 0 uncovered lines, cap 1 (lower the cap)']);
  assert.deepEqual(capProblems({ 'scripts/a.mjs': [1, 2], 'scripts/b.mjs': [4, 0] }, ['scripts/a.mjs', 'scripts/b.mjs'], caps), ['scripts/b.mjs: no cap (measured 4 uncovered lines, 0 uncovered branches)']);
  assert.deepEqual(capProblems({ 'scripts/a.mjs': [1, 2] }, ['scripts/a.mjs', 'scripts/c.mjs'], caps), ['scripts/c.mjs: no test loads it']);
  assert.deepEqual(parseLcov('SF:/r/scripts/a.mjs\nLF:10\nLH:9\nBRF:4\nBRH:1\nend_of_record\n', '/r'), { 'scripts/a.mjs': [1, 3] });
});

test('D24: every script under scripts/ is measured and matches its uncovered-code cap', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cov-'));
  try {
    const lcov = join(tmp, 'lcov.info');
    const tests = readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs') && f !== 'coverage.test.mjs').map((f) => `test/${f}`);
    // a child of node --test inherits NODE_TEST_CONTEXT and would report to this run instead of writing lcov
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--experimental-test-coverage', '--test-coverage-include=scripts/**',
      '--test-reporter=lcov', `--test-reporter-destination=${lcov}`, '--test-reporter=dot', '--test-reporter-destination=stdout', ...tests],
    { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 << 20 });
    assert.equal(r.status, 0, `the suite failed under coverage:\n${(r.stdout + r.stderr).slice(-3000)}`);
    assert.deepEqual(capProblems(parseLcov(readFileSync(lcov, 'utf8'), ROOT), scriptsIn(ROOT)), []);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
