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
  for (const v of ['desktop', 'phone']) assert.equal(readFileSync(join(a, 'dist', `banner-${v}.svg`), 'utf8'), readFileSync(join(b, 'dist', `banner-${v}.svg`), 'utf8'), v);
});

// M1.T4b: the gate pins the banner's real inputs. Swap one Bud render for another in a copy of the repo, render, and
// the gate must refuse it by name and sha256, so a wrong image cannot publish.
test('M1.T4b: a Bud render swapped for another is refused by the gate after a fresh render', async () => {
  const { cpSync, copyFileSync } = await import('node:fs');
  const repo = tmp('swap-');
  cpSync(ROOT, repo, { recursive: true, filter: (src) => !/[\\/](?:\.git|node_modules)$/.test(src) });
  copyFileSync(join(repo, 'assets', 'buds', 'pdp-pearl-plush-730.png'), join(repo, 'assets', 'buds', 'pdp-ash-plush-900.png'));
  const r = run('sh', ['-c', 'node scripts/render.mjs --out . && node scripts/check.mjs .'], { cwd: repo });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.notEqual(r.status, 0, out);
  assert.match(out, /ash:/, out);
  assert.match(out, /sha256/, out);
});

// D21: the gate refuses any published file that is not the render, with the file and the reason in one line
const refused = (r, file, why) => { assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, new RegExp(`\\[published-is-rendered\\] .*${file.replace(/[.]/g, '\\.')} ${why}`)); };

test('M1.T1: check refuses a README pointing at a missing image', () => {
  const out = built();
  rmSync(join(out, 'dist', 'banner-desktop.svg'));
  refused(check(out), 'dist/banner-desktop.svg', 'missing');
});

test('M1.T1: check refuses a banner over 600 KB, a tile over 150 KB, or an SVG that is not well-formed XML, and svgProblems names why', async () => {
  const { svgProblems, MAX_SVG, MAX_BANNER } = await import(join(ROOT, 'scripts', 'check.mjs'));
  assert.equal(MAX_SVG, 150 * 1024);
  assert.equal(MAX_BANNER, 600 * 1024);
  for (const [svg, max, why] of [
    [`<svg xmlns="http://www.w3.org/2000/svg"><!-- ${'x'.repeat(601 * 1024)} --></svg>`, MAX_BANNER, /600 KB/],
    [`<svg xmlns="http://www.w3.org/2000/svg"><!-- ${'x'.repeat(151 * 1024)} --></svg>`, MAX_SVG, /150 KB/],
    ['<svg xmlns="http://www.w3.org/2000/svg"><text>unclosed</svg>', MAX_BANNER, /XML/],
  ]) {
    const out = built(); const f = join(out, 'dist', 'banner-desktop.svg');
    writeFileSync(f, svg);
    refused(check(out), 'dist/banner-desktop.svg', 'differs from the render');
    assert.match(svgProblems(f, 'h', max).join('\n'), why);
  }
  const ok = tmp('svg-'); writeFileSync(join(ok, 'a.svg'), `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${'x'.repeat(151 * 1024)} --></svg>`);
  assert.deepEqual(svgProblems(join(ok, 'a.svg'), 'a', MAX_BANNER), [], 'a banner may be over 150 KB');
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
    const out = built(); const f = join(out, 'dist', 'banner-phone.svg');
    writeFileSync(f, svg);
    refused(check(out), 'dist/banner-phone.svg', 'differs from the render');
    assert.match(svgProblems(f, 'h').join('\n'), why, svg);
  }
  const ok = tmp('svg-'); writeFileSync(join(ok, 'a.svg'), `<svg ${SVGNS}><text>a &amp; b &#169; &#x2014;</text></svg>`);
  assert.deepEqual(svgProblems(join(ok, 'a.svg'), 'a'), []);
});

test('M1.T1a: a README with any other image, or none, is refused', () => {
  for (const md of ['![bud](dist/missing.svg)\n', "<img src='dist/gone.svg'>\n", '<picture><source srcset="dist/a.svg 1x, dist/b.svg 2x"><img src="dist/banner-desktop.svg"></picture>\n', '# hi\n']) {
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

test('M1.T1a: the README is rendered from profile.json; the banner alt is the scene, escaped', async () => {
  const { render: renderWith, attr, BANNER_ALT } = await import(join(ROOT, 'scripts', 'render.mjs'));
  const profile = JSON.parse(readFileSync(join(ROOT, 'profile.json'), 'utf8'));
  assert.equal(attr('A"B<c>&'), 'A&quot;B&lt;c&gt;&amp;');
  for (const text of ['I make [plush](https://getskybuds.com) friends.', 'Hello from [SkyBuds](https://getskybuds.com/).']) {
    const out = tmp('dist-');
    renderWith(out, { ...profile, intro: { ...profile.intro, line: { ...profile.intro.line, text } } });
    const md = readFileSync(join(out, 'README.md'), 'utf8');
    assert.ok(md.includes(`</picture></p>\n\n${text}\n`), md);
    assert.ok(md.includes(`alt="${attr(BANNER_ALT)}" width="100%">`), md);
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
  assert.ok(files.length >= 5 && files.includes('README.md') && files.includes('dist/banner-desktop.svg') && files.includes('dist/banner-phone.svg') && files.some((f) => f.startsWith('dist/mission/')), files.join(' '));
  const copy = () => { const o = tmp('gate-'); cpSync(good, o, { recursive: true }); return o; };
  const missed = [];
  for (const f of files) {
    for (const [how, change] of [['one byte added', (o) => appendFileSync(join(o, f), ' ')], ['deleted', (o) => rmSync(join(o, f))]]) {
      const o = copy(); change(o);
      if (!gate(o).some((p) => p.startsWith('[published-is-rendered] ') || (f === 'README.md' && how === 'deleted'))) missed.push(`${f} ${how}`);
    }
  }
  for (const stray of ['dist/x.svg', 'dist/mission/x.svg', 'dist/a/b.txt']) {
    const o = copy(); mkdirSync(dirname(join(o, stray)), { recursive: true }); writeFileSync(join(o, stray), readFileSync(join(good, 'dist', 'banner-phone.svg')));
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
    'profile-brand-only': (c) => { c.profile.bud.name = 'Feldt Toys, Inc.'; },
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
    'svg-size': (c) => svg(c, pr(c).tile, (s) => s.replace('</svg>', `<!-- ${'x'.repeat(151 * 1024)} --></svg>`)),
    'readme-refs-resolve': (c) => md(c, (m) => m.replace(pr(c).tile, 'dist/gone.svg')),
    'readme-alts': (c) => md(c, (m) => m.replace(/ alt="[^"]*" width="408"/, ' width="408"')),
    'readme-html': (c) => md(c, (m) => m.replace('alt="nasa/fprime#1 open: fix 1"', 'alt="nasa/fprime#1 open: fix "1" <b>"')),
    'banner-picture': (c) => md(c, (m) => m.replace('<source media="(max-width: 600px)" srcset="dist/banner-phone.svg">\n', '')),
    'banner-wellformed': (c) => svg(c, 'dist/banner-phone.svg', (s) => s.replace('</svg>', '<g></svg>')),
    'banner-viewbox': (c) => svg(c, 'dist/banner-phone.svg', (s) => s.replace('viewBox="0 0 640 320"', 'viewBox="0 0 1200 300"')),
    'banner-size': (c) => svg(c, 'dist/banner-desktop.svg', (s) => s.replace('</svg>', `<!-- ${'x'.repeat(601 * 1024)} --></svg>`)),
    'banner-csp-safe': (c) => svg(c, 'dist/banner-desktop.svg', (s) => s.replace('</svg>', '<image href="https://example.com/a.png"/></svg>')),
    'banner-animated': (c) => svg(c, 'dist/banner-phone.svg', (s) => s.replace(/@keyframes /g, '@frames ')),
    'banner-reduced-motion': (c) => svg(c, 'dist/banner-desktop.svg', (s) => s.replace(/@media \(prefers-reduced-motion:\s*reduce\)/, '@media print')),
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

test("M1.T4b: banner-csp-safe refuses each construct GitHub's image CSP blocks, and allows in-file url(#id) and href=\"#id\"", async () => {
  const { context, runRules } = await import(join(ROOT, 'scripts', 'check.mjs'));
  const base = context(built());
  assert.deepEqual(runRules(base), []);
  const s = base.expected['dist/banner-desktop.svg'];
  assert.match(s, /url\(#/, 'the banner uses in-file url(#id)');
  assert.match(s, /href="#/, 'the banner uses in-file href="#id"');
  const missed = [];
  for (const bad of ['<script>x()</script>', '<image href="#a"/>', '<foreignObject/>', '<rect fill="url(https://example.com/p.svg#x)"/>', '<use href="https://example.com/a.svg#x"/>',
    '<use xlink:href="other.svg#x"/>', '<style>@import "x.css";</style>', '<style>@font-face{font-family:x;src:local(x)}</style>', '<a href="javascript:alert(1)"/>', '<rect fill="url(data:image/png;base64,AAAA)"/>']) {
    const c = structuredClone(base);
    c.expected['dist/banner-desktop.svg'] = s.replace('</svg>', `${bad}</svg>`);
    if (!runRules(c).some((p) => p.startsWith('[banner-csp-safe] '))) missed.push(bad);
  }
  assert.deepEqual(missed, []);
});

test('M1.T4b: banner-wellformed refuses a banner the render did not make, one outside the SVG namespace, and one that is not well-formed', async () => {
  const { context, runRules } = await import(join(ROOT, 'scripts', 'check.mjs'));
  const base = context(built());
  const cases = {
    'not rendered': (c) => { delete c.expected['dist/banner-phone.svg']; },
    'no <svg> root in the SVG namespace': (c) => { c.expected['dist/banner-desktop.svg'] = c.expected['dist/banner-desktop.svg'].replace(' xmlns="http://www.w3.org/2000/svg"', ''); },
    'mismatched </svg>': (c) => { c.expected['dist/banner-desktop.svg'] = c.expected['dist/banner-desktop.svg'].replace('</svg>', '<g></svg>'); },
  };
  for (const [why, breakIt] of Object.entries(cases)) {
    const c = structuredClone(base); breakIt(c);
    const p = runRules(c).find((l) => l.startsWith('[banner-wellformed] '));
    assert.ok(p && p.includes(why), `${why}: ${p}`);
  }
});
