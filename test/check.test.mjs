// M1.T1 render pipeline: profile.json -> render.mjs -> dist/*.svg + README.md, guarded by check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, run } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const render = (out) => run('node', [join(ROOT, 'scripts', 'render.mjs'), '--out', out]);
const check = (out) => run('node', [join(ROOT, 'scripts', 'check.mjs'), out]);
function built() { const out = tmp('dist-'); const r = render(out); assert.equal(r.status, 0, r.stderr); return out; }
const imgs = (md) => [...md.matchAll(/<img[^>]* src="([^"]+)"/g), ...md.matchAll(/srcset="([^"]+)"/g)].map((m) => m[1]);

test('M1.T1: render writes a README whose every local image exists in the output', () => {
  const out = built();
  const md = readFileSync(join(out, 'README.md'), 'utf8');
  const local = imgs(md).filter((s) => !/^https?:/.test(s));
  assert.ok(local.length >= 1, 'the README shows the header');
  for (const s of local) assert.ok(existsSync(join(out, s)), `${s} missing`);
  assert.equal(check(out).status, 0, check(out).stderr);
});

test('M1.T1: render is deterministic for the same profile.json', () => {
  const a = built(), b = built();
  assert.equal(readFileSync(join(a, 'README.md'), 'utf8'), readFileSync(join(b, 'README.md'), 'utf8'));
  for (const v of ['dark', 'light', 'mobile-dark', 'mobile-light']) assert.equal(readFileSync(join(a, 'dist', `header-${v}.svg`), 'utf8'), readFileSync(join(b, 'dist', `header-${v}.svg`), 'utf8'), v);
});

// D21: the gate refuses any published file that is not the render, with the file and the reason in one line
const refused = (r, file, why) => { assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, new RegExp(`\\[published-is-rendered\\] .*${file.replace(/[.]/g, '\\.')} ${why}`)); };

test('M1.T1: check refuses a README pointing at a missing image', () => {
  const out = built();
  rmSync(join(out, 'dist', 'header-light.svg'));
  refused(check(out), 'dist/header-light.svg', 'missing');
});

test('M1.T1: check refuses an SVG over 150 KB or one that is not well-formed XML, and svgProblems names why', async () => {
  const { svgProblems } = await import(join(ROOT, 'scripts', 'check.mjs'));
  for (const [svg, why] of [[`<svg xmlns="http://www.w3.org/2000/svg"><!-- ${'x'.repeat(151 * 1024)} --></svg>`, /150 KB/], ['<svg xmlns="http://www.w3.org/2000/svg"><text>unclosed</svg>', /XML/]]) {
    const out = built(); const f = join(out, 'dist', 'header-light.svg');
    writeFileSync(f, svg);
    refused(check(out), 'dist/header-light.svg', 'differs from the render');
    assert.match(svgProblems(f, 'h').join('\n'), why);
  }
});

const SVGNS = 'xmlns="http://www.w3.org/2000/svg"';

test('M1.T1a: check refuses an SVG with a bare &, an unknown entity, a repeated attribute or no SVG namespace', async () => {
  const { svgProblems } = await import(join(ROOT, 'scripts', 'check.mjs'));
  for (const [svg, why] of [
    [`<svg ${SVGNS}><text>a & b</text></svg>`, /&/],
    [`<svg ${SVGNS}><text>a&nbsp;b</text></svg>`, /entity/],
    [`<svg ${SVGNS} a="1" a="2"/>`, /attribute/],
    ['<svg><text>x</text></svg>', /namespace/],
  ]) {
    const out = built(); const f = join(out, 'dist', 'header-light.svg');
    writeFileSync(f, svg);
    refused(check(out), 'dist/header-light.svg', 'differs from the render');
    assert.match(svgProblems(f, 'h').join('\n'), why, svg);
  }
  const ok = tmp('svg-'); writeFileSync(join(ok, 'a.svg'), `<svg ${SVGNS}><text>a &amp; b &#169; &#x2014;</text></svg>`);
  assert.deepEqual(svgProblems(join(ok, 'a.svg'), 'a'), []);
});

test('M1.T1a: a README with any other image, or none, is refused', () => {
  for (const md of ['![bud](dist/missing.svg)\n', "<img src='dist/gone.svg'>\n", '<picture><source srcset="dist/a.svg 1x, dist/b.svg 2x"><img src="dist/header-light.svg"></picture>\n', '# hi\n']) {
    const out = built();
    writeFileSync(join(out, 'README.md'), md);
    refused(check(out), 'README.md', 'differs from the render');
  }
});

test('M1.T1a: an image the render did not make is refused, wherever it lives', () => {
  const out = built();
  writeFileSync(join(out, 'dist', 'x.png'), '{"not":"an svg"}');
  refused(check(out), 'dist/x.png', 'not rendered by anything');
  const big = built();
  writeFileSync(join(big, 'dist', 'other.svg'), `<svg ${SVGNS}><!-- ${'x'.repeat(151 * 1024)} --></svg>`);
  refused(check(big), 'dist/other.svg', 'not rendered by anything');
});

test('M1.T1a: the README is rendered from profile.json, escaped', async () => {
  const { render: renderWith } = await import(join(ROOT, 'scripts', 'render.mjs'));
  const profile = JSON.parse(readFileSync(join(ROOT, 'profile.json'), 'utf8'));
  for (const name of ['Pearl', 'A"B<c>']) {
    const out = tmp('dist-');
    renderWith(out, { ...profile, bud: { ...profile.bud, name } });
    const md = readFileSync(join(out, 'README.md'), 'utf8');
    const esc = name.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    assert.ok(md.includes(`alt="${esc}, a SkyBuds`), md);
  }
});

// M1.T7a (D18, D21): the gate. (1) Coverage: every published file is covered byte for byte, and a stray file is
// refused, whatever files the render makes. (2) One break per rule: BREAKS keys equal the RULES ids, each break is
// refused by its own id. Rules overlap on purpose (published-is-rendered sees every output break), so a break may
// also trip others; that each condition inside a rule has its own break is P2, not claimed here.
async function gateFixture() {
  const { createServer } = await import('node:http');
  const { build } = await import(join(ROOT, 'scripts', 'data.mjs'));
  const item = (repo, n, merged) => ({ html_url: `https://github.com/${repo}/pull/${n}`, number: n, title: `fix ${n}`, state: merged ? 'closed' : 'open', created_at: `2026-10-19T2${n}:00:00Z`, repository_url: `https://api.github.com/repos/${repo}`, pull_request: { merged_at: merged ? '2026-10-20T03:00:00Z' : null } });
  const out = tmp('gate-');
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify({ total_count: 2, incomplete_results: false, items: [item('nasa/fprime', 1), item('teslamotors/kafka-helmsman', 2, true)] })); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try { await build(out, { api: `http://127.0.0.1:${server.address().port}`, avatars: `http://127.0.0.1:${server.address().port}`, token: 'test-token', now: new Date('2026-10-21T00:00:00Z') }); }
  finally { server.close(); }
  assert.equal(render(out).status, 0);
  return out;
}

test('M1.T7a: every published file is covered byte for byte, and nothing unrendered can be published', async () => {
  const { cpSync, appendFileSync, rmSync, mkdirSync } = await import('node:fs');
  const { check: gate, context } = await import(join(ROOT, 'scripts', 'check.mjs'));
  const good = await gateFixture();
  assert.deepEqual(gate(good), [], 'a good profile passes');
  const files = Object.keys(context(good).published);
  assert.ok(files.length >= 7 && files.includes('README.md') && files.some((f) => f.startsWith('dist/mission/')), files.join(' '));
  const copy = () => { const o = tmp('gate-'); cpSync(good, o, { recursive: true }); return o; };
  const missed = [];
  for (const f of files) {
    for (const [how, change] of [['one byte added', (o) => appendFileSync(join(o, f), ' ')], ['deleted', (o) => rmSync(join(o, f))]]) {
      const o = copy(); change(o);
      if (!gate(o).some((p) => p.startsWith('[published-is-rendered] ') || (f === 'README.md' && how === 'deleted'))) missed.push(`${f} ${how}`);
    }
  }
  for (const stray of ['dist/x.svg', 'dist/mission/x.svg', 'dist/a/b.txt']) {
    const o = copy(); mkdirSync(dirname(join(o, stray)), { recursive: true }); writeFileSync(join(o, stray), readFileSync(join(good, 'dist', 'header-light.svg')));
    if (!gate(o).some((p) => p.startsWith('[published-is-rendered] '))) missed.push(`${stray} stray`);
  }
  assert.deepEqual(missed, [], 'changes the gate let through');
});

test('M1.T7a: every gate rule refuses its own break', async () => {
  const { context, runRules, RULES } = await import(join(ROOT, 'scripts', 'check.mjs'));
  const good = await gateFixture();
  const base = context(good);
  assert.deepEqual(runRules(base), [], 'a good profile passes every rule');
  const clone = () => structuredClone(base);
  const pr = (c) => c.data.prs[0];
  const svg = (c, f, fn) => { c.expected[f] = fn(c.expected[f]); };
  const md = (c, fn) => { c.expected['README.md'] = fn(c.expected['README.md']); };
  // each break makes one input or the render wrong in one way; published files follow the render where needed
  const BREAKS = {
    'published-is-rendered': (c) => { c.published['README.md'] += ' '; },
    'profile-shape': (c) => { c.profileOk = false; c.profile.intro.heading = 'About me'; },
    'profile-bud-asset': (c) => { c.profile.bud.source.sha256 = '0'.repeat(64); },
    'profile-line-links-skybuds': (c) => { c.profile.intro.line.text = 'I make AI plush companions for curious kids.'; },
    'profile-line-plain': (c) => { c.profile.intro.line.text = '## [About](https://getskybuds.com) me'; },
    'profile-facts-sourced': (c) => { c.profile.intro.facts = [{ text: 'Best toy ever', source: 'trust me' }]; },
    'profile-facts-plain': (c) => { c.profile.intro.facts = [{ text: '<b>Best</b>', source: 'https://getskybuds.com/' }]; },
    'profile-brand-only': (c) => { c.profile.header.tagline = 'Feldt Toys, Inc.'; },
    'profile-tagline-short': (c) => { c.profile.header.tagline = 'x'.repeat(49); },
    'data-shape': (c) => { c.dataOk = false; c.data.logos = { nasa: { n: 2, bleed: true, pal: ['#ffffff'], px: 'a3' } }; },
    'data-canonical': (c) => { c.dataRaw += '\n'; },
    'data-query': (c) => { c.data.query = 'is:pr author:Feldt'; },
    'pr-allowlisted': (c) => { Object.assign(pr(c), { org: 'someone', repo: 'someone/x' }); },
    'pr-org-of-repo': (c) => { pr(c).org = 'teslamotors'; },
    'pr-open-or-merged': (c) => { pr(c).state = 'closed'; },
    'pr-url-of-repo': (c) => { pr(c).url = pr(c).url.replace('/pull/1', '/pull/7'); },
    'pr-tile-name': (c) => { pr(c).tile = 'dist/mission/x.svg'; },
    'prs-unique': (c) => { c.data.prs.push({ ...pr(c), created: '2026-10-22T00:00:00Z' }); },
    'prs-ordered': (c) => { c.data.prs.reverse(); },
    'stats-derived': (c) => { c.data.stats.merged = 9; },
    'svg-root': (c) => svg(c, pr(c).tile, (s) => s.replace(' xmlns="http://www.w3.org/2000/svg"', '')),
    'svg-wellformed': (c) => svg(c, pr(c).tile, (s) => s.replace('</svg>', '<g></svg>')),
    'svg-size': (c) => svg(c, 'dist/header-light.svg', (s) => s.replace('</svg>', `<!-- ${'x'.repeat(151 * 1024)} --></svg>`)),
    'readme-refs-resolve': (c) => md(c, (m) => m.replace(pr(c).tile, 'dist/gone.svg')),
    'readme-alts': (c) => md(c, (m) => m.replace(/ alt="[^"]*" width="408"/, ' width="408"')),
    'readme-html': (c) => md(c, (m) => m.replace('alt="nasa/fprime#1 open: fix 1"', 'alt="nasa/fprime#1 open: fix "1" <b>"')),
    'header-picture': (c) => md(c, (m) => m.replace(' width="100%">', '>')),
    'header-contrast': (c) => svg(c, 'dist/header-dark.svg', (s) => s.replace(/(\.c\d+\{fill:#)[0-9a-f]{6}/, '$10e1118')),
    'header-mobile-glyphs': (c) => svg(c, 'dist/header-mobile-light.svg', (s) => s.replace(/font-size:[\d.]+px/, 'font-size:3px')),
    'header-blink': (c) => svg(c, 'dist/header-mobile-dark.svg', (s) => s.replace('<g class="f3">', '<g class="f9">')),
    'header-tagline': (c) => svg(c, 'dist/header-dark.svg', (s) => s.replace(/(<text id="tagline"[^>]*>)[^<]*/, '$1hello')),
    'readme-line-first': (c) => md(c, (m) => m.replace('</picture></p>\n', '</picture></p>\n\nHi!\n')),
    'readme-one-heading': (c) => md(c, (m) => m.replace('</picture></p>\n', '</picture></p>\n## About me\n')),
    'readme-tiles': (c) => md(c, (m) => m.replace(/<a href="[^"]+pull\/2"><img [^>]+><\/a>\n/, '')),
    'readme-cards-last': (c) => md(c, (m) => { const line = c.profile.intro.line.text; return m.replace(`${line}\n`, '') + `${line}\n`; }),
    'tile-csp-safe': (c) => svg(c, pr(c).tile, (s) => s.replace('</svg>', '<image href="https://example.com/a.png"/></svg>')),
  };
  assert.deepEqual(Object.keys(BREAKS).sort(), RULES.map((r) => r.id).sort(), 'one break per gate rule');
  const wrong = [];
  for (const [id, breakIt] of Object.entries(BREAKS)) {
    const c = clone(); breakIt(c);
    if (!runRules(c).some((p) => p.startsWith(`[${id}] `))) wrong.push(`${id}: not refused by its own rule`);
  }
  assert.deepEqual(wrong, []);
});
