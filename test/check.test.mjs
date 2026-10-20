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

test('M1.T1: check refuses a README pointing at a missing image', () => {
  const out = built();
  rmSync(join(out, 'dist', 'header-light.svg'));
  const r = check(out);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /header-light\.svg/);
});

test('M1.T1: check refuses an SVG over 150 KB or one that is not well-formed XML', () => {
  const big = built();
  writeFileSync(join(big, 'dist', 'header-light.svg'), `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${'x'.repeat(151 * 1024)} --></svg>`);
  assert.equal(check(big).status, 1);
  assert.match(check(big).stderr, /150 KB/);
  const bad = built();
  writeFileSync(join(bad, 'dist', 'header-light.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text>unclosed</svg>');
  assert.equal(check(bad).status, 1);
  assert.match(check(bad).stderr, /XML/);
});

const SVGNS = 'xmlns="http://www.w3.org/2000/svg"';
function withHeader(svg) { const out = built(); writeFileSync(join(out, 'dist', 'header-light.svg'), svg); return check(out); }

test('M1.T1a: check refuses an SVG with a bare &, an unknown entity, a repeated attribute or no SVG namespace', () => {
  for (const [svg, why] of [
    [`<svg ${SVGNS}><text>a & b</text></svg>`, /&/],
    [`<svg ${SVGNS}><text>a&nbsp;b</text></svg>`, /entity/],
    [`<svg ${SVGNS} a="1" a="2"/>`, /attribute/],
    ['<svg><text>x</text></svg>', /namespace/],
  ]) {
    const r = withHeader(svg);
    assert.equal(r.status, 1, svg);
    assert.match(r.stderr, why, svg);
  }
  assert.equal(withHeader(`<svg ${SVGNS}><text>a &amp; b &#169; &#x2014;</text></svg>`).status, 0);
});

test('M1.T1a: check follows every image form the README uses, and needs at least one local SVG', () => {
  for (const md of ['![bud](dist/missing.svg)\n', "<img src='dist/gone.svg'>\n", '<picture><source srcset="dist/a.svg 1x, dist/b.svg 2x"><img src="dist/header-light.svg"></picture>\n']) {
    const out = built();
    writeFileSync(join(out, 'README.md'), md);
    const r = check(out);
    assert.equal(r.status, 1, md);
    assert.match(r.stderr, /missing/, md);
  }
  const none = built();
  writeFileSync(join(none, 'README.md'), '# hi\n');
  assert.equal(check(none).status, 1);
  assert.match(check(none).stderr, /no local SVG/);
});

test('M1.T1a: every referenced image is checked as an SVG, wherever it lives', () => {
  const out = built();
  writeFileSync(join(out, 'x.png'), '{"not":"an svg"}');
  writeFileSync(join(out, 'README.md'), '<img src="dist/header-light.svg">\n<img src="x.png">\n');
  const r = check(out);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /x\.png: not an SVG/);
  const big = built();
  writeFileSync(join(big, 'other.svg'), `<svg ${SVGNS}><!-- ${'x'.repeat(151 * 1024)} --></svg>`);
  writeFileSync(join(big, 'README.md'), '<img src="dist/header-light.svg">\n![o](other.svg)\n');
  assert.match(check(big).stderr, /other\.svg: \d+ bytes, over 150 KB/);
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

// M1.T7a (D18): check.mjs is the one publish gate. Each rule in RULES has one break here, and the break must be
// refused by that rule's own id, so deleting, weakening or adding a rule without a break fails this test.
test('M1.T7a: every publish rule refuses its own break of a good rendered profile', async () => {
  const { createServer } = await import('node:http');
  const { readdirSync, rmSync } = await import('node:fs');
  const { build } = await import(join(ROOT, 'scripts', 'data.mjs'));
  const { check: gate, RULES } = await import(join(ROOT, 'scripts', 'check.mjs'));
  const item = (repo, n, merged) => ({ html_url: `https://github.com/${repo}/pull/${n}`, number: n, title: `fix ${n}`, state: merged ? 'closed' : 'open', created_at: `2026-10-19T2${n}:00:00Z`, repository_url: `https://api.github.com/repos/${repo}`, pull_request: { merged_at: merged ? '2026-10-20T03:00:00Z' : null } });
  const good = async () => {
    const out = tmp('gate-');
    const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify({ total_count: 2, incomplete_results: false, items: [item('nasa/fprime', 1), item('teslamotors/kafka-helmsman', 2, true)] })); });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    try { await build(out, { api: `http://127.0.0.1:${server.address().port}`, token: 'test-token', now: new Date('2026-10-21T00:00:00Z') }); }
    finally { server.close(); }
    assert.equal(render(out).status, 0);
    return out;
  };
  const profile = JSON.parse(readFileSync(join(ROOT, 'profile.json'), 'utf8'));
  const R = (o) => join(o, 'README.md'), md = (o) => readFileSync(R(o), 'utf8'), edit = (o, f) => writeFileSync(R(o), f(md(o)));
  const file = (o, f, fn) => writeFileSync(join(o, f), fn(readFileSync(join(o, f), 'utf8')));
  const data = (o, fn) => { const d = JSON.parse(readFileSync(join(o, 'data.json'), 'utf8')); fn(d); writeFileSync(join(o, 'data.json'), JSON.stringify(d)); };
  const PIC = /<p align="center"><picture>[\s\S]*?<\/picture><\/p>\n/;
  const BREAKS = {
    'image-missing': (o) => edit(o, (m) => m + '\n<img src="dist/nope.svg">\n'),
    'image-svg': (o) => writeFileSync(join(o, 'dist', 'extra.svg'), `<svg ${SVGNS}><g></svg>`),
    'header-svg': (o) => edit(o, (m) => m.replace(/(src|srcset)="dist\/[^"]+"/g, '$1="https://example.com/a.png"')),
    'header-picture': (o) => edit(o, (m) => m.replace(/<source media="\(prefers-color-scheme: dark\)"[^>]*>\n/, '')),
    'header-contrast': (o) => file(o, 'dist/header-dark.svg', (s) => s.replace(/(\.c\d+\{fill:#)[0-9a-f]{6}/g, '$10e1118')),
    'header-mobile-glyphs': (o) => file(o, 'dist/header-mobile-dark.svg', (s) => s.replace(/font-size:[\d.]+px/, 'font-size:3px')),
    'copy-heading': (o) => edit(o, (m) => m.replace(`## ${profile.intro.heading}`, '## Hello')),
    'copy-first-line': (o) => edit(o, (m) => m.replace(profile.intro.line.text, 'Hello there.')),
    'copy-art-first': (o) => edit(o, (m) => { const pic = PIC.exec(m)[0], h = `## ${profile.intro.heading}\n`; return m.replace(pic, '').replace(h, h + pic); }),
    'copy-facts-sourced': (o) => edit(o, (m) => m.replace(`- ${profile.intro.facts[0].text}\n`, `- ${profile.intro.facts[0].text}\n- Best toy ever\n`)),
    'copy-facts-count': (o) => edit(o, (m) => profile.intro.facts.slice(2).reduce((x, f) => x.replace(`- ${f.text}\n`, ''), m)),
    'copy-brand-only': (o) => edit(o, (m) => m + '\nFeldt Toys, Inc.\n'),
    'readme-html': (o) => edit(o, (m) => m.replace('alt="nasa/fprime#1 open: fix 1"', 'alt="nasa/fprime#1 open: fix "1" <b>"')),
    'mission-data': (o) => rmSync(join(o, 'data.json')),
    'mission-order': (o) => edit(o, (m) => { const i = m.indexOf('## Open-source missions'); return m.slice(0, i).replace(`## ${profile.intro.heading}`, m.slice(i) + `\n## ${profile.intro.heading}`); }),
    'mission-allowlist': (o) => data(o, (d) => { Object.assign(d.prs[0], { repo: 'someone-else/x', org: 'someone-else', url: 'https://github.com/someone-else/x/pull/1' }); }),
    'mission-stats': (o) => data(o, (d) => { d.stats.merged = 9; }),
    'mission-tiles': (o) => edit(o, (m) => m.replace(/<a href="[^"]+pull\/2"><img [^>]+><\/a>\n/, '')),
    'mission-svgs': (o) => file(o, 'dist/stats.svg', (s) => s.replace('>2</text>', '>99</text>')),
  };
  assert.deepEqual(Object.keys(BREAKS).sort(), RULES.map((r) => r.id).sort(), 'one break per publish rule');
  const ok = await good();
  assert.deepEqual(gate(ok), [], 'a good profile passes every rule');
  assert.ok(readdirSync(join(ok, 'dist', 'mission')).length === 2);
  const unrefused = [];
  for (const [id, breakIt] of Object.entries(BREAKS)) {
    const out = await good();
    breakIt(out);
    if (!gate(out).some((p) => p.startsWith(`[${id}] `))) unrefused.push(id);
  }
  assert.deepEqual(unrefused, [], 'breaks not refused by their own rule');
  const r = check(ok);
  assert.equal(r.status, 0, r.stderr);
});
