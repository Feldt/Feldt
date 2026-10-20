#!/usr/bin/env node
// check.mjs <dir>: the one publish gate (D18, D21). The published README.md and dist/** must be exactly the render
// of the published inputs, and the inputs and that render must pass every rule in RULES. Exit 1 lists each problem.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
import { renderFiles, budInputs, BANNER_PICTURE, BANNER_PHONE, BANNER_DESKTOP } from './render.mjs';
import { unrle } from './tiles/lib/logo.mjs';
import { QUERY, statsOf, tileOf, dataFiles, dataJson } from './data.mjs';
import { BUDS } from './banner/buds.mjs';

export const MAX_SVG = 150 * 1024, MAX_BANNER = 600 * 1024;
const KB = (n) => `${n / 1024} KB`;

// The five XML entities and character references; anything else after & is not well-formed.
const ENTITY = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);/;
function textProblem(t, at) {
  for (let j = t.indexOf('&'); j >= 0; j = t.indexOf('&', j + 1)) {
    if (!ENTITY.test(t.slice(j))) return /^&\w+;/.test(t.slice(j)) ? `undefined entity ${/^&\w+;/.exec(t.slice(j))[0]} at ${at + j}` : `bare & at ${at + j}`;
  }
  return null;
}

// Well-formedness: balanced elements, quoted unique attributes, valid entities, comments/CDATA/PIs closed, one root.
export function xmlProblem(s) {
  const stack = []; let i = 0, roots = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const text = textProblem(s.slice(i, lt < 0 ? s.length : lt), i);
    if (text) return text;
    if (lt < 0) break;
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); if (e < 0) return 'unclosed comment'; i = e + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt); if (e < 0) return 'unclosed CDATA'; i = e + 3; continue; }
    if (s.startsWith('<?', lt)) { const e = s.indexOf('?>', lt); if (e < 0) return 'unclosed processing instruction'; i = e + 2; continue; }
    if (s.startsWith('<!', lt)) { const e = s.indexOf('>', lt); if (e < 0) return 'unclosed declaration'; i = e + 1; continue; }
    const m = /^<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/.exec(s.slice(lt));
    if (!m) return `bad tag at ${lt}`;
    const [all, close, name, attrs, self] = m;
    const seen = new Set();
    for (const a of attrs.matchAll(/([\w.:-]+)\s*=\s*("[^"]*"|'[^']*')/g)) {
      if (seen.has(a[1])) return `repeated attribute ${a[1]} at ${lt}`;
      seen.add(a[1]);
      const v = textProblem(a[2], lt);
      if (v) return v;
    }
    if (close) { if (stack.pop() !== name) return `mismatched </${name}> at ${lt}`; }
    else if (!self) { if (!stack.length) roots++; stack.push(name); }
    else if (!stack.length) roots++;
    i = lt + all.length;
  }
  if (stack.length) return `unclosed <${stack[stack.length - 1]}>`;
  if (roots !== 1) return `${roots} root elements`;
  return null;
}

const SVG_ROOT = /^(?:\s*<\?xml[^>]*\?>)?(?:\s*<!--[\s\S]*?-->)*\s*<svg[\s>]/;
const SVG_NS = /^[^>]*\sxmlns\s*=\s*(["'])http:\/\/www\.w3\.org\/2000\/svg\1/;

// One published SVG: an SVG root in the SVG namespace, well-formed, at most `max` bytes (150 KB; a banner 600 KB).
export function svgProblems(path, label, max = MAX_SVG) {
  const body = readFileSync(path, 'utf8'), problems = [], size = statSync(path).size;
  if (!SVG_ROOT.test(body)) return [`${label}: not an SVG`];
  if (size > max) problems.push(`${label}: ${size} bytes, over ${KB(max)}`);
  if (!SVG_NS.test(body.slice(body.indexOf('<svg')))) problems.push(`${label}: <svg> lacks the SVG namespace`);
  const x = xmlProblem(body);
  if (x) problems.push(`${label}: not well-formed XML (${x})`);
  return problems;
}

// Every image URL the README shows: <img src> in either quotes, every srcset candidate, markdown ![](url).
export function imageRefs(md) {
  const refs = [];
  for (const m of md.matchAll(/<(?:img|source)\b[^>]*?\ssrc\s*=\s*(["'])(.*?)\1/gi)) refs.push(m[2]);
  for (const m of md.matchAll(/\ssrcset\s*=\s*(["'])(.*?)\1/gi)) refs.push(...m[2].split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean));
  for (const m of md.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) refs.push(m[1]);
  return [...new Set(refs)];
}

// The publish gate (D18, D21). Every published file is generated: the gate re-runs data.mjs's and render.mjs's
// pure functions on the published inputs (profile.json, pr-rules.json, data.json) and requires README.md and
// every file under dist/ to be byte-identical to that render, with nothing missing and nothing extra. What is
// left to rule on is the inputs and the generator's output, one condition per rule, each with its own break in
// the class test (test/check.test.mjs). A rule's test returns a problem string, or null when it holds.
const local = (ref) => !/^(?:https?:|data:)/.test(ref);
const clean = (ref) => ref.replace(/^\.?\//, '').split(/[?#]/)[0];
const walk = (dir, rel) => { const d = join(dir, rel); return existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(dir, `${rel}/${e.name}`) : [`${rel}/${e.name}`])) : []; };
const keysOf = (o) => Object.keys(o).sort().join(',');
const isStr = (v) => typeof v === 'string';
const plain = (t) => isStr(t) && !/[\n<]/.test(t) && !/^\s*#/.test(t);
const LEGAL = /\b(Inc|LLC|Ltd|GmbH|ApS|Corp)\b/;
const bad = (items, why) => (items.length ? `${why}: ${items.slice(0, 3).join(', ')}` : null);

// profile.json, exact keys and types (unknown keys refused, so no field reaches render.mjs unchecked)
// buds: exactly the Buds the banner draws (buds.mjs BUDS), each pinned to a render under assets/buds/ by sha256,
// with the public getskybuds.com image it came from
const budShape = (b) => keysOf(b || {}) === 'file,sha256,url' && [b.file, b.sha256, b.url].every(isStr)
  && b.file.startsWith('assets/buds/') && b.url.startsWith('https://getskybuds.com/');
export function profileShape(p) {
  return keysOf(p || {}) === 'buds,intro' && p.buds && typeof p.buds === 'object' && Object.keys(p.buds).join(',') === Object.keys(BUDS).join(',')
    && Object.values(p.buds).every(budShape)
    && keysOf(p.intro || {}) === 'facts,line' && keysOf(p.intro.line || {}) === 'source,text' && isStr(p.intro.line.text) && isStr(p.intro.line.source)
    && Array.isArray(p.intro.facts) && p.intro.facts.every((f) => keysOf(f || {}) === 'source,text' && isStr(f.text) && isStr(f.source));
}
// data.json, exact keys and types; a logo is null (monogram) or pixel cells whose run-length code fills n x n
const PR_KEYS = 'created,merged,number,org,repo,state,tile,title,url';
const logoShape = (l) => l === null || (keysOf(l || {}) === 'bleed,n,pal,px' && Number.isInteger(l.n) && l.n > 0 && l.n <= 128 && typeof l.bleed === 'boolean'
  && Array.isArray(l.pal) && l.pal.length >= 1 && l.pal.length <= 52 && l.pal.every((c) => /^#[0-9a-f]{6}$/.test(c))
  && isStr(l.px) && /^(?:[A-Za-z]\d*)+$/.test(l.px) && unrle(l.px).length === l.n * l.n && [...unrle(l.px)].every((c) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(c) < l.pal.length));
function dataShape(d) {
  return keysOf(d || {}) === 'logos,prs,query,stats' && isStr(d.query) && d.logos && typeof d.logos === 'object' && !Array.isArray(d.logos) && Object.values(d.logos).every(logoShape) && keysOf(d.stats || {}) === 'merged,open,orgs,prs,repos'
    && Object.values(d.stats).every(Number.isInteger) && Array.isArray(d.prs)
    && d.prs.every((p) => keysOf(p || {}) === PR_KEYS && Number.isInteger(p.number) && ['created', 'org', 'repo', 'state', 'tile', 'title', 'url'].every((k) => isStr(p[k])) && (p.merged === null || isStr(p.merged)));
}
const prsOf = (ctx) => (ctx.dataOk ? ctx.data.prs : []);
const README = (ctx) => ctx.expected?.['README.md'] ?? '';
// the two banners and their viewBoxes; banners(ctx) gives [file, body, viewBox] for each one the render made
const BANNERS = [[BANNER_DESKTOP, '0 0 1200 300'], [BANNER_PHONE, '0 0 640 320']];
const banners = (ctx) => BANNERS.filter(([f]) => isStr(ctx.expected?.[f])).map(([f, vb]) => [f, ctx.expected[f], vb]);
const TILE_LINE = /^<a href="[^"]*"><img src="dist\/mission\//;
const introLines = (md) => { const l = md.split('\n'), i = l.findIndex((x) => /<\/picture>/.test(x)) + 1, e = l.findIndex((x, k) => k >= i && TILE_LINE.test(x)); return l.slice(i, e < 0 ? undefined : e); };
// a tile must stay inside GitHub's image CSP: no scripts, images, fonts or text elements, references inside the file only
const CSP_UNSAFE = /<(?:script|image|img|foreignObject|iframe|text|font)\b|@import|@font-face|javascript:|\shref="(?!#)|url\((?!#)/i;
// a banner draws with <text> in system monospace fonts, otherwise the same: nothing loaded, nothing run, no data:
// URIs, every url() and href inside the file
const BANNER_UNSAFE = /<(?:script|image|img|foreignObject|iframe|object|embed|audio|video)\b|@import|@font-face|data:|javascript:|\s(?:xlink:)?href\s*=\s*["'](?!#)|\ssrc\s*=|url\(\s*(?!["']?#)/i;

export const RULES = [
  // the published files are exactly the render of the published inputs
  { id: 'published-is-rendered', layer: 'publish', test: (ctx) => {
    if (!ctx.expected) return `cannot render the inputs: ${ctx.renderError}`;
    const want = Object.keys(ctx.expected), got = Object.keys(ctx.published);
    return bad([...want.filter((f) => !(f in ctx.published)).map((f) => `${f} missing`), ...got.filter((f) => !(f in ctx.expected)).map((f) => `${f} not rendered by anything`),
      ...want.filter((f) => f in ctx.published && ctx.published[f] !== ctx.expected[f]).map((f) => `${f} differs from the render`)], 'published files are not the render of the inputs');
  } },
  // profile.json
  { id: 'profile-shape', layer: 'profile', test: (ctx) => (ctx.profileOk ? null : 'profile.json keys or types are not the known shape') },
  { id: 'profile-buds-pinned', layer: 'profile', test: (ctx) => { try { budInputs(ctx.profile); return null; } catch (e) { return e.message; } } },
  { id: 'profile-line-links-skybuds', layer: 'profile', test: (ctx) => (/\]\(https:\/\/getskybuds\.com[/)]/.test(ctx.profile?.intro?.line?.text) ? null : 'the intro line does not link getskybuds.com') },
  { id: 'profile-line-plain', layer: 'profile', test: (ctx) => (plain(ctx.profile?.intro?.line?.text) ? null : 'the intro line is not one plain line (no heading, no HTML)') },
  { id: 'profile-facts-sourced', layer: 'profile', test: (ctx) => bad((ctx.profile?.intro?.facts || []).filter((f) => !/^https:\/\//.test(f.source)).map((f) => f.text), 'facts without an https source') },
  { id: 'profile-facts-plain', layer: 'profile', test: (ctx) => bad((ctx.profile?.intro?.facts || []).filter((f) => !plain(f.text)).map((f) => f.text), 'facts that are not one plain line') },
  { id: 'profile-brand-only', layer: 'profile', test: (ctx) => (LEGAL.test(JSON.stringify(ctx.profile?.intro)) ? 'a legal entity name in the profile copy (brand name only)' : null) },
  // data.json (absent before data.mjs has run)
  { id: 'data-shape', layer: 'data', test: (ctx) => (!ctx.data || ctx.dataOk ? null : 'data.json keys or types are not the known shape') },
  { id: 'data-canonical', layer: 'data', test: (ctx) => (!ctx.dataOk || ctx.dataRaw === dataJson(ctx.data) ? null : 'data.json is not as data.mjs writes it') },
  { id: 'data-query', layer: 'data', test: (ctx) => (!ctx.dataOk || ctx.data.query === QUERY ? null : `data.json query is not ${QUERY}`) },
  { id: 'pr-allowlisted', layer: 'data', test: (ctx) => bad(prsOf(ctx).filter((p) => !ctx.orgs.has(p.org.toLowerCase())).map((p) => p.url), 'PRs outside the org allowlist') },
  { id: 'pr-org-of-repo', layer: 'data', test: (ctx) => bad(prsOf(ctx).filter((p) => p.repo.split('/')[0] !== p.org).map((p) => p.url), 'PRs whose org is not their repo owner') },
  { id: 'pr-open-or-merged', layer: 'data', test: (ctx) => bad(prsOf(ctx).filter((p) => !(p.state === 'open' && p.merged === null) && !(p.state === 'merged' && isStr(p.merged))).map((p) => p.url), 'PRs neither open nor merged') },
  { id: 'pr-url-of-repo', layer: 'data', test: (ctx) => bad(prsOf(ctx).filter((p) => p.url !== `https://github.com/${p.repo}/pull/${p.number}`).map((p) => p.url), 'PR urls that are not their repo and number') },
  { id: 'pr-tile-name', layer: 'data', test: (ctx) => bad(prsOf(ctx).filter((p) => p.tile !== tileOf(p.repo, p.number)).map((p) => p.tile), 'tile names not made from repo and number') },
  { id: 'prs-unique', layer: 'data', test: (ctx) => bad(prsOf(ctx).map((p) => p.url).filter((u, i, a) => a.indexOf(u) !== i), 'PRs listed twice') },
  { id: 'prs-ordered', layer: 'data', test: (ctx) => { const p = prsOf(ctx); return p.every((x, i) => i === 0 || p[i - 1].created.localeCompare(x.created) < 0 || (p[i - 1].created === x.created && p[i - 1].url.localeCompare(x.url) < 0)) ? null : 'PRs are not in created order'; } },
  { id: 'stats-derived', layer: 'data', test: (ctx) => (!ctx.dataOk || JSON.stringify(ctx.data.stats) === JSON.stringify(statsOf(ctx.data.prs)) ? null : 'data.json stats are not counted from its prs') },
  // the generator's output (the render the published files must equal)
  { id: 'svg-root', layer: 'output', test: (ctx) => bad(Object.entries(ctx.expected || {}).filter(([f, b]) => f.endsWith('.svg') && !(SVG_ROOT.test(b) && SVG_NS.test(b.slice(b.indexOf('<svg'))))).map(([f]) => f), 'SVGs without an <svg> root in the SVG namespace') },
  { id: 'svg-wellformed', layer: 'output', test: (ctx) => bad(Object.entries(ctx.expected || {}).filter(([f, b]) => f.endsWith('.svg') && xmlProblem(b)).map(([f, b]) => `${f} (${xmlProblem(b)})`), 'SVGs that are not well-formed XML') },
  { id: 'tile-csp-safe', layer: 'output', test: (ctx) => bad(Object.entries(ctx.expected || {}).filter(([f, b]) => f.startsWith('dist/mission/') && CSP_UNSAFE.test(b)).map(([f]) => f), "tiles GitHub's image CSP would break") },
  { id: 'svg-size', layer: 'output', test: (ctx) => bad(Object.entries(ctx.expected || {}).filter(([f, b]) => f.endsWith('.svg') && !BANNERS.some(([x]) => x === f) && Buffer.byteLength(b) > MAX_SVG).map(([f]) => f), 'SVGs other than the banners over 150 KB') },
  { id: 'readme-refs-resolve', layer: 'output', test: (ctx) => bad(imageRefs(README(ctx)).filter(local).map(clean).filter((r) => !(r in (ctx.expected || {}))), 'README images that are not rendered') },
  { id: 'readme-alts', layer: 'output', test: (ctx) => bad([...README(ctx).matchAll(/<img\b[^>]*>/g)].map((m) => m[0]).filter((t) => !/\salt="[^"]+"/.test(t)).map((t) => t.slice(0, 60)), 'README images without alt text') },
  { id: 'readme-html', layer: 'output', test: (ctx) => bad([...README(ctx).matchAll(/<(?:img|a|source|picture|p)\b[^\n]*?>/g)].map((m) => m[0]).filter((t) => !/^<(?:img|a|source|picture|p)(?:\s+[\w-]+="[^"<>]*")*\s*\/?>$/.test(t)).map((t) => t.slice(0, 60)), 'malformed README tags') },
  // the banner: exactly the centred <picture> render.mjs writes, and two well-formed, animated, CSP-safe SVGs
  { id: 'banner-picture', layer: 'output', test: (ctx) => (README(ctx).startsWith(`${BANNER_PICTURE.join('\n')}\n`) && (README(ctx).match(/<picture>/g) || []).length === 1 ? null : 'the README does not open with the banner <picture> (phone source, desktop image)') },
  { id: 'banner-wellformed', layer: 'output', test: (ctx) => bad([...BANNERS.filter(([f]) => !isStr(ctx.expected?.[f])).map(([f]) => `${f} not rendered`), ...banners(ctx).filter(([, b]) => !SVG_ROOT.test(b) || !SVG_NS.test(b.slice(b.indexOf('<svg'))) || xmlProblem(b)).map(([f, b]) => `${f} (${xmlProblem(b) || 'no <svg> root in the SVG namespace'})`)], 'banners that are not well-formed SVG') },
  { id: 'banner-viewbox', layer: 'output', test: (ctx) => bad(banners(ctx).filter(([, b, vb]) => /<svg\b[^>]*\sviewBox="([^"]*)"/.exec(b)?.[1] !== vb).map(([f, , vb]) => `${f} (want ${vb})`), 'banners with the wrong viewBox') },
  { id: 'banner-size', layer: 'output', test: (ctx) => bad(banners(ctx).filter(([, b]) => Buffer.byteLength(b) > MAX_BANNER).map(([f, b]) => `${f} (${Buffer.byteLength(b)} bytes)`), 'banners over 600 KB') },
  { id: 'banner-csp-safe', layer: 'output', test: (ctx) => bad(banners(ctx).filter(([, b]) => BANNER_UNSAFE.test(b)).map(([f, b]) => `${f} (${BANNER_UNSAFE.exec(b)[0]})`), "banners GitHub's image CSP would break") },
  { id: 'banner-animated', layer: 'output', test: (ctx) => bad(banners(ctx).filter(([, b]) => !/@keyframes [\w-]+\{/.test(b) || !/\{[^{}]*animation:[\w-]+ [\d.]+s/.test(b)).map(([f]) => f), 'banners without CSS keyframe animations') },
  { id: 'banner-reduced-motion', layer: 'output', test: (ctx) => bad(banners(ctx).filter(([, b]) => !/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\*\s*\{\s*animation:\s*none\s*!important/.test(b)).map(([f]) => f), 'banners that keep moving under prefers-reduced-motion') },
  { id: 'readme-line-first', layer: 'output', test: (ctx) => (introLines(README(ctx)).find((l) => l.trim()) === ctx.profile?.intro?.line?.text ? null : "the first line under the banner is not profile.json's line") },
  { id: 'readme-one-heading', layer: 'output', test: (ctx) => bad(README(ctx).split('\n').filter((l) => /^\s*#/.test(l)), 'README headings (the tiles need none)') },
  // no PR tiles on the profile (Fred 10-20): the README ends at the intro line and its facts
  { id: 'readme-no-tiles', layer: 'output', test: (ctx) => (/dist\/mission\//.test(README(ctx)) ? 'README shows PR tiles (Fred 10-20: none)' : null) },
];

const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
// What the gate looks at: the published files, the inputs, and the render of the inputs.
export function context(dir) {
  const profile = JSON.parse(readFileSync(join(ROOT, 'profile.json'), 'utf8'));
  const dataRaw = read(join(dir, 'data.json'));
  let data = null; try { data = dataRaw === null ? null : JSON.parse(dataRaw); } catch { data = {}; }
  const ctx = {
    profile, profileOk: profileShape(profile), dataRaw, data, dataOk: data !== null && dataShape(data),
    orgs: new Set(JSON.parse(readFileSync(join(ROOT, 'pr-rules.json'), 'utf8')).orgs.map((o) => o.toLowerCase())),
    published: Object.fromEntries(['README.md', ...walk(dir, 'dist')].filter((f) => existsSync(join(dir, f))).map((f) => [f, readFileSync(join(dir, f), 'utf8')])),
    expected: null, renderError: null,
  };
  try { ctx.expected = { ...(ctx.dataOk ? dataFiles(data) : {}), ...renderFiles(profile, ctx.dataOk ? data : null) }; }
  catch (e) { ctx.renderError = e.message; }
  if (data !== null && !ctx.dataOk) ctx.expected = null, ctx.renderError ||= 'data.json is not the known shape';
  return ctx;
}
export const runRules = (ctx, rules = RULES) => rules.flatMap((r) => { const p = r.test(ctx); return p ? [`[${r.id}] ${p}`] : []; });
export function check(dir) {
  if (!existsSync(join(dir, 'README.md'))) return ['README.md missing'];
  return runRules(context(dir));
}
// The live README is the render of the live inputs.
export function liveProblems(md, data, profile = JSON.parse(readFileSync(join(ROOT, 'profile.json'), 'utf8'))) {
  return md === renderFiles(profile, data)['README.md'] ? [] : ["the live README is not the render of profile.json and the live data.json"];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: check.mjs <dir>'); process.exit(2); }
  const problems = check(resolve(dir));
  for (const p of problems) console.error(`check: ${p}`);
  if (problems.length) process.exit(1);
  console.log('check: ok');
}
