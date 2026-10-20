// D24: the class test for "untested code path". The rest of the suite runs with NODE_V8_COVERAGE set, so every node
// process it starts (test files, CLIs they spawn, the pre-push hook git runs from <git dir>/aura-hooks/) writes a raw
// V8 coverage dump. Each dumped script is matched to a file under scripts/ by content (sha256; by shape when the copy
// is gone), its per-character counts are unioned across processes, and every uncovered line is named by
// `<innermost function>|<line text>`. That multiset must equal test/coverage-baseline.json exactly, and the baseline
// may only lose entries against the base commit (COVERAGE_BASE, else merge-base with origin/main): new untested code
// adds an entry and fails even when it replaces a line a new test now covers. A script (.mjs, .cjs, .js) no process
// loads fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE = 'test/coverage-baseline.json';

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : /\.(mjs|cjs|js)$/.test(e.name) ? [join(d, e.name)] : []));
export const scriptsIn = (root) => Object.fromEntries(walk(join(root, 'scripts')).map((f) => [relative(root, f), readFileSync(f, 'utf8')]).sort(([a], [b]) => (a < b ? -1 : 1)));
const sha = (s) => createHash('sha256').update(s).digest('hex');
const readUrl = (url) => { try { const p = fileURLToPath(url); return existsSync(p) ? readFileSync(p, 'utf8') : null; } catch { return null; } };

// a dumped script whose file is gone: the one script of the same length that holds every named function at its offsets
function byShape(entry, scripts) {
  const len = Math.max(...entry.functions.flatMap((f) => f.ranges.map((r) => r.endOffset)));
  const fits = Object.entries(scripts).filter(([, s]) => s.length === len
    && entry.functions.every((f) => !f.functionName || s.slice(f.ranges[0].startOffset, f.ranges[0].endOffset).includes(f.functionName)));
  return fits.length === 1 ? fits[0][0] : null;
}

// dumps: parsed NODE_V8_COVERAGE files; scripts: { 'scripts/x.mjs': source } -> { seen, uncovered: { file: sorted keys } }
export function measure(dumps, scripts, read = readUrl) {
  const byHash = new Map(Object.entries(scripts).map(([f, s]) => [sha(s), f]));
  const covered = {}, fns = {};
  for (const d of dumps) for (const e of d.result ?? []) {
    if (!e.url?.startsWith('file:')) continue;
    const src = read(e.url);
    const f = src == null ? byShape(e, scripts) : byHash.get(sha(src));
    if (!f) continue;
    const n = scripts[f].length;
    // innermost range wins: paint outer before inner (start ascending, longer first)
    const ranges = e.functions.flatMap((fn) => fn.ranges).sort((a, b) => a.startOffset - b.startOffset || (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
    const count = new Float64Array(n);
    for (const r of ranges) count.fill(r.count, r.startOffset, Math.min(r.endOffset, n));
    const c = (covered[f] ??= new Uint8Array(n));
    for (let i = 0; i < n; i++) if (count[i] > 0) c[i] = 1;
    for (const fn of e.functions) (fns[f] ??= []).push([fn.ranges[0].startOffset, fn.ranges[0].endOffset, fn.functionName]);
  }
  const uncovered = {};
  for (const [f, c] of Object.entries(covered)) {
    const src = scripts[f], keys = [];
    let at = 0;
    for (const line of src.split('\n')) {
      const t = line.trim();
      const comment = /^(\/\/|\/\*|\*)/.test(t);
      let miss = -1;
      if (!comment) for (let i = 0; i < line.length; i++) if (!c[at + i] && /[\p{L}\p{N}_$]/u.test(line[i])) { miss = at + i; break; }
      if (miss >= 0) {
        const inner = fns[f].filter(([s, e]) => s <= miss && miss < e && !(s === 0 && e >= src.length)).sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]))[0];
        keys.push(`${inner ? inner[2] || '(anonymous)' : '<module>'}|${t}`);
      }
      at += line.length + 1;
    }
    uncovered[f] = keys.sort();
  }
  return { seen: Object.keys(covered).sort(), uncovered };
}

const counts = (keys = []) => keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map());

// measured must equal the baseline both ways, and every script must be measured
export function baselineProblems({ seen, uncovered }, scripts, baseline) {
  const out = [];
  for (const f of Object.keys(scripts)) if (!seen.includes(f)) out.push(`${f}: no test loads it`);
  for (const f of new Set([...Object.keys(uncovered), ...Object.keys(baseline)])) {
    if (!scripts[f]) { out.push(`${f}: in the baseline but not under scripts/`); continue; }
    const m = counts(uncovered[f]), b = counts(baseline[f]);
    for (const [k, n] of m) if (n > (b.get(k) ?? 0)) out.push(`${f}: untested, not in the baseline (test it): ${k}`);
    for (const [k, n] of b) if (n > (m.get(k) ?? 0)) out.push(`${f}: covered now, still in the baseline (remove it): ${k}`);
  }
  return out;
}

// the baseline may only shrink against the base commit's baseline (a missing file there is empty)
export function raiseProblems(baseline, base) {
  const out = [];
  for (const [f, keys] of Object.entries(baseline)) {
    const b = counts(base[f]);
    for (const [k, n] of counts(keys)) if (n > (b.get(k) ?? 0)) out.push(`${f}: baseline entry added since the base commit: ${k}`);
  }
  return out;
}

const fn = (name, start, end, count, blocks = []) => ({ functionName: name, isBlockCoverage: true, ranges: [{ startOffset: start, endOffset: end, count }, ...blocks] });
const SRC = 'function a(x) {\n  return x + 1;\n}\nfunction b(y) {\n  return y * 2;\n}\n';
const A = [0, SRC.indexOf('function b')], B = [A[1], SRC.length];
const dump = (url, aCount, bCount) => ({ result: [{ url, functions: [fn('', 0, SRC.length, 1), fn('a', A[0] + 9, A[1] - 1, aCount), fn('b', B[0] + 9, B[1] - 1, bCount)] }] });
const S = { 'scripts/x.mjs': SRC };
const at = (src) => (u) => (u === 'file:///gone/x.mjs' ? null : src);

test('D24: a swap (one line covered, another untested line added) fails though the count is unchanged', () => {
  const baseline = measure([dump('file:///r/scripts/x.mjs', 0, 1)], S, at(SRC));
  assert.deepEqual(baseline.uncovered, { 'scripts/x.mjs': ['a|function a(x) {', 'a|return x + 1;'] });
  const swapped = measure([dump('file:///r/scripts/x.mjs', 1, 0)], S, at(SRC));
  assert.equal(swapped.uncovered['scripts/x.mjs'].length, baseline.uncovered['scripts/x.mjs'].length);
  const p = baselineProblems(swapped, S, baseline.uncovered);
  assert.ok(p.some((l) => l.includes('untested, not in the baseline') && l.includes('b|return y * 2;')), p.join('\n'));
  assert.ok(p.some((l) => l.includes('still in the baseline') && l.includes('a|return x + 1;')), p.join('\n'));
  assert.deepEqual(baselineProblems(baseline, S, baseline.uncovered), []);
});

test('D24: a copy run from elsewhere (the hook copy) counts, by content or by shape when the file is gone', () => {
  const byContent = measure([dump('file:///r/scripts/x.mjs', 0, 0), dump('file:///repo/.git/aura-hooks/x.mjs', 1, 0)], S, at(SRC));
  assert.ok(!byContent.uncovered['scripts/x.mjs'].some((k) => k.startsWith('a|')), 'the copy covered a');
  const byShape = measure([dump('file:///r/scripts/x.mjs', 0, 0), dump('file:///gone/x.mjs', 0, 1)], S, at(SRC));
  assert.ok(!byShape.uncovered['scripts/x.mjs'].some((k) => k.startsWith('b|')), 'the gone copy covered b');
  assert.deepEqual(measure([dump('file:///r/other.mjs', 1, 1)], S, () => 'something else').seen, []);
});

test('D24: an inner block with count 0 is uncovered; processes union; comments and an unloaded script', () => {
  const blk = SRC.indexOf('return y');
  const d = { result: [{ url: 'file:///r/scripts/x.mjs', functions: [fn('', 0, SRC.length, 1), fn('b', B[0] + 9, B[1] - 1, 1, [{ startOffset: blk, endOffset: blk + 13, count: 0 }])] }] };
  assert.ok(measure([d], S, at(SRC)).uncovered['scripts/x.mjs'].includes('b|return y * 2;'));
  assert.ok(!measure([d, dump('file:///r/scripts/x.mjs', 1, 1)], S, at(SRC)).uncovered['scripts/x.mjs'].includes('b|return y * 2;'));
  const C = '// a comment\nfunction z() {\n  // inside\n  return 1;\n}\n';
  const m = measure([{ result: [{ url: 'file:///r/scripts/z.mjs', functions: [fn('', 0, C.length, 1), fn('z', 13, C.length - 1, 0)] }] }], { 'scripts/z.mjs': C }, at(C));
  assert.deepEqual(m.uncovered['scripts/z.mjs'], ['z|function z() {', 'z|return 1;']);
  assert.deepEqual(baselineProblems(m, { 'scripts/z.mjs': C, 'scripts/y.mjs': '' }, m.uncovered), ['scripts/y.mjs: no test loads it']);
});

test('D24: every script kind under scripts/ is in scope (.mjs, .cjs, .js)', () => {
  const d = mkdtempSync(join(tmpdir(), 'cov-scope-'));
  try {
    for (const f of ['scripts/a.mjs', 'scripts/lib/b.cjs', 'scripts/lib/c.js', 'scripts/notes.md']) { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), 'x'); }
    assert.deepEqual(Object.keys(scriptsIn(d)), ['scripts/a.mjs', 'scripts/lib/b.cjs', 'scripts/lib/c.js']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('D24: the baseline may only shrink against the base commit', () => {
  assert.deepEqual(raiseProblems({ 'scripts/x.mjs': ['a|k'] }, { 'scripts/x.mjs': ['a|k', 'b|j'] }), []);
  assert.deepEqual(raiseProblems({ 'scripts/x.mjs': ['a|k', 'a|k'] }, { 'scripts/x.mjs': ['a|k'] }), ['scripts/x.mjs: baseline entry added since the base commit: a|k']);
  assert.deepEqual(raiseProblems({ 'scripts/n.mjs': ['a|k'] }, {}), ['scripts/n.mjs: baseline entry added since the base commit: a|k']);
});

test('D24: every script under scripts/ is measured and its uncovered lines equal the baseline', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cov-'));
  try {
    const v8 = join(tmp, 'v8');
    const tests = readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs') && f !== 'coverage.test.mjs').map((f) => `test/${f}`);
    // a child of node --test inherits NODE_TEST_CONTEXT and would report to this run instead of running on its own
    const env = { ...process.env, NODE_V8_COVERAGE: v8 }; delete env.NODE_TEST_CONTEXT;
    // the baseline is one environment's: live checks that a variable switches on stay off here
    delete env.README_RAW;
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=dot', ...tests], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 << 20 });
    assert.equal(r.status, 0, `the suite failed under coverage:\n${(r.stdout + r.stderr).slice(-3000)}`);
    const dumps = readdirSync(v8).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(v8, f), 'utf8')));
    const scripts = scriptsIn(ROOT);
    const m = measure(dumps, scripts);
    if (process.env.COVERAGE_WRITE === '1') writeFileSync(join(ROOT, BASELINE), JSON.stringify(m.uncovered, null, 1) + '\n');
    assert.deepEqual(baselineProblems(m, scripts, JSON.parse(readFileSync(join(ROOT, BASELINE), 'utf8'))), []);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('D24: the baseline has no entry the base commit lacks', (t) => {
  const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' });
  const base = process.env.COVERAGE_BASE || git('merge-base', 'HEAD', 'origin/main').stdout.trim();
  if (!base || git('rev-parse', '--verify', `${base}^{commit}`).status !== 0) return t.skip(`no base commit to compare (${base || 'git or origin/main missing'})`);
  const shown = git('show', `${base}:${BASELINE}`);
  const prev = shown.status === 0 ? JSON.parse(shown.stdout) : {};
  assert.deepEqual(raiseProblems(JSON.parse(readFileSync(join(ROOT, BASELINE), 'utf8')), prev), [], `base ${base}`);
});
