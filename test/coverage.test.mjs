// D24: the class test for "untested code path". The published generator's line and branch coverage, per file,
// may not fall below the floor measured when the class was redesigned: a new branch that no test reaches lowers
// it and fails the suite. Raise a floor when coverage rises; never lower one to make a change pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// [line %, branch %] per published file, measured 2026-10-20 at 4eeb724
export const FLOORS = {
  'check.mjs': [98, 86], 'data.mjs': [100, 86], 'frames.mjs': [100, 98], 'render.mjs': [100, 76],
  'logo.mjs': [92, 93], 'png.mjs': [87, 71], 'tiles.mjs': [94, 83],
};
const TESTS = ['check', 'data', 'readme', 'header', 'frames', 'tiles'].map((t) => `test/${t}.test.mjs`);
const INCLUDE = ['scripts/render.mjs', 'scripts/data.mjs', 'scripts/check.mjs', 'scripts/frames.mjs', 'scripts/tiles/**'];

// "ℹ  check.mjs    |  98.56 |    86.61 | ..." -> { 'check.mjs': [98.56, 86.61] }
export function parseCoverage(out) {
  const rows = {};
  for (const m of out.matchAll(/^ℹ\s+([\w.-]+\.mjs)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/gm)) rows[m[1]] = [Number(m[2]), Number(m[3])];
  return rows;
}
export const belowFloor = (rows, floors = FLOORS) => Object.entries(floors).flatMap(([f, [line, branch]]) => {
  const r = rows[f];
  if (!r) return [`${f}: not measured`];
  return [...(r[0] < line ? [`${f}: lines ${r[0]} < ${line}`] : []), ...(r[1] < branch ? [`${f}: branches ${r[1]} < ${branch}`] : [])];
});

test('D24: the coverage floor refuses a drop and a file it cannot see', () => {
  assert.deepEqual(belowFloor({ 'a.mjs': [90, 80] }, { 'a.mjs': [90, 80] }), []);
  assert.deepEqual(belowFloor({ 'a.mjs': [89.9, 80] }, { 'a.mjs': [90, 80] }), ['a.mjs: lines 89.9 < 90']);
  assert.deepEqual(belowFloor({ 'a.mjs': [90, 79] }, { 'a.mjs': [90, 80] }), ['a.mjs: branches 79 < 80']);
  assert.deepEqual(belowFloor({}, { 'a.mjs': [90, 80] }), ['a.mjs: not measured']);
});

test('D24: every published generator file keeps its line and branch coverage floor', () => {
  // a child of node --test inherits NODE_TEST_CONTEXT and would report to this run instead of printing the table
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--experimental-test-coverage', ...INCLUDE.map((i) => `--test-coverage-include=${i}`), ...TESTS],
    { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, `the generator tests failed:\n${r.stdout.slice(-2000)}`);
  const rows = parseCoverage(r.stdout);
  assert.deepEqual(belowFloor(rows), [], JSON.stringify(rows));
});
