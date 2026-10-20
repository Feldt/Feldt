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

// M1.T7a (D18): check.mjs is the one publish gate, so breaking any rule of the published profile makes it refuse:
// the SkyBuds copy from profile.json, and the mission invariant (data.json prs = stats.prs = README tiles = tile files).
test('M1.T7a: check refuses a rendered profile with any published rule broken', async () => {
  const { createServer } = await import('node:http');
  const { readdirSync, renameSync } = await import('node:fs');
  const { build } = await import(join(ROOT, 'scripts', 'data.mjs'));
  const item = (repo, n) => ({ html_url: `https://github.com/${repo}/pull/${n}`, number: n, title: `fix ${n}`, state: 'open', created_at: '2026-10-19T21:00:00Z', repository_url: `https://api.github.com/repos/${repo}`, pull_request: { merged_at: null } });
  const good = async () => {
    const out = tmp('gate-');
    const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify({ total_count: 2, incomplete_results: false, items: [item('nasa/fprime', 1), item('nasa/fprime', 2)] })); });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    try { await build(out, { api: `http://127.0.0.1:${server.address().port}`, token: 'test-token', now: new Date('2026-10-21T00:00:00Z') }); }
    finally { server.close(); }
    assert.equal(render(out).status, 0);
    return out;
  };
  {
    const ok = await good();
    assert.equal(check(ok).status, 0, check(ok).stderr);
    const md = (out) => readFileSync(join(out, 'README.md'), 'utf8');
    const profile = JSON.parse(readFileSync(join(ROOT, 'profile.json'), 'utf8'));
    const breaks = {
      'heading not SkyBuds': (out) => writeFileSync(join(out, 'README.md'), md(out).replace(`## ${profile.intro.heading}`, '## Hello')),
      'unsourced fact line': (out) => writeFileSync(join(out, 'README.md'), md(out).replace(`- ${profile.intro.facts[0].text}\n`, `- ${profile.intro.facts[0].text}\n- Best toy ever\n`)),
      'legal entity name': (out) => writeFileSync(join(out, 'README.md'), md(out) + '\nFeldt Toys, Inc.\n'),
      'tile missing from the README': (out) => writeFileSync(join(out, 'README.md'), md(out).replace(/<a href="[^"]+pull\/2"><img [^>]+><\/a>\n?/, '')),
      'tile file missing': (out) => { const d = join(out, 'dist', 'mission'); renameSync(join(d, readdirSync(d)[0]), join(out, 'gone.svg')); },
      'stray tile file': (out) => writeFileSync(join(out, 'dist', 'mission', 'nasa--old-9.svg'), readFileSync(join(out, 'dist', 'stats.svg'))),
      'stats.prs disagrees': (out) => { const p = join(out, 'data.json'), d = JSON.parse(readFileSync(p, 'utf8')); d.stats.prs = 3; writeFileSync(p, JSON.stringify(d)); },
      'tile links the wrong PR': (out) => writeFileSync(join(out, 'README.md'), md(out).replace('pull/1"', 'pull/7"')),
    };
    for (const [why, breakIt] of Object.entries(breaks)) {
      const out = await good();
      breakIt(out);
      const r = check(out);
      assert.equal(r.status, 1, `${why}: check passed`);
    }
  }
});
