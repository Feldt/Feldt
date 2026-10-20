#!/usr/bin/env node
// check.mjs <dir>: the one publish gate (D18, D21). The published README.md and dist/** must be exactly the render
// of the published inputs, and the inputs and that render must pass every rule in RULES. Exit 1 lists each problem.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
import { createHash } from 'node:crypto';
import { attr, tileLink, renderFiles, HEADER_SOURCES, HEADER_FALLBACK } from './render.mjs';
import { unrle } from './tiles/lib/logo.mjs';
import { QUERY, statsOf, tileOf, dataFiles, dataJson } from './data.mjs';
import { THEMES, rgbOf, contrast } from './frames.mjs';

export const MAX_SVG = 150 * 1024;

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

// One published SVG: an SVG root in the SVG namespace, well-formed, at most 150 KB.
export function svgProblems(path, label) {
  const body = readFileSync(path, 'utf8'), problems = [], size = statSync(path).size;
  if (!SVG_ROOT.test(body)) return [`${label}: not an SVG`];
  if (size > MAX_SVG) problems.push(`${label}: ${size} bytes, over 150 KB`);
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
function profileShape(p) {
  const s = p?.bud?.source;
  return keysOf(p || {}) === 'bud,header,intro' && keysOf(p.bud || {}) === 'animation,name,source' && isStr(p.bud.name) && isStr(p.bud.animation)
    && keysOf(s || {}) === 'file,note,sha256,url' && [s.file, s.note, s.sha256, s.url].every(isStr)
    && keysOf(p.header || {}) === 'tagline' && isStr(p.header.tagline)
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
const headers = (ctx) => [...HEADER_SOURCES.map(([, f, t]) => [f, t]), HEADER_FALLBACK].filter(([f]) => ctx.expected?.[f]);
const TILE_LINE = /^<a href="[^"]*"><img src="dist\/mission\//;
const introLines = (md) => { const l = md.split('\n'), i = l.findIndex((x) => /<\/picture>/.test(x)) + 1, e = l.findIndex((x, k) => k >= i && TILE_LINE.test(x)); return l.slice(i, e < 0 ? undefined : e); };
// a tile must stay inside GitHub's image CSP: no scripts, images, fonts or text elements, references inside the file only
const CSP_UNSAFE = /<(?:script|image|img|foreignObject|iframe|text|font)\b|@import|@font-face|javascript:|\shref="(?!#)|url\((?!#)/i;

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
  { id: 'profile-bud-asset', layer: 'profile', test: (ctx) => { const s = ctx.profile?.bud?.source; const f = s && join(ROOT, s.file); return f && existsSync(f) && createHash('sha256').update(readFileSync(f)).digest('hex') === s.sha256 ? null : 'the Bud image does not match its sha256 in profile.json'; } },
  { id: 'profile-line-links-skybuds', layer: 'profile', test: (ctx) => (/\]\(https:\/\/getskybuds\.com[/)]/.test(ctx.profile?.intro?.line?.text) ? null : 'the intro line does not link getskybuds.com') },
  { id: 'profile-line-plain', layer: 'profile', test: (ctx) => (plain(ctx.profile?.intro?.line?.text) ? null : 'the intro line is not one plain line (no heading, no HTML)') },
  { id: 'profile-facts-sourced', layer: 'profile', test: (ctx) => bad((ctx.profile?.intro?.facts || []).filter((f) => !/^https:\/\//.test(f.source)).map((f) => f.text), 'facts without an https source') },
  { id: 'profile-facts-plain', layer: 'profile', test: (ctx) => bad((ctx.profile?.intro?.facts || []).filter((f) => !plain(f.text)).map((f) => f.text), 'facts that are not one plain line') },
  { id: 'profile-brand-only', layer: 'profile', test: (ctx) => (LEGAL.test(JSON.stringify([ctx.profile?.intro, ctx.profile?.header, ctx.profile?.bud?.name])) ? 'a legal entity name in the profile copy (brand name only)' : null) },
  { id: 'profile-tagline-short', layer: 'profile', test: (ctx) => { const t = ctx.profile?.header?.tagline; return isStr(t) && t.length >= 1 && t.length <= 48 && plain(t) ? null : 'the header tagline is not one plain line of 1 to 48 characters'; } },
  // data.json (absent before data.mjs has run; then the README has no cards)
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
  { id: 'svg-size', layer: 'output', test: (ctx) => bad(Object.entries(ctx.expected || {}).filter(([f, b]) => f.endsWith('.svg') && Buffer.byteLength(b) > MAX_SVG).map(([f]) => f), 'SVGs over 150 KB') },
  { id: 'readme-refs-resolve', layer: 'output', test: (ctx) => bad(imageRefs(README(ctx)).filter(local).map(clean).filter((r) => !(r in (ctx.expected || {}))), 'README images that are not rendered') },
  { id: 'readme-alts', layer: 'output', test: (ctx) => bad([...README(ctx).matchAll(/<img\b[^>]*>/g)].map((m) => m[0]).filter((t) => !/\salt="[^"]+"/.test(t)).map((t) => t.slice(0, 60)), 'README images without alt text') },
  { id: 'readme-html', layer: 'output', test: (ctx) => bad([...README(ctx).matchAll(/<(?:img|a|source|picture|p)\b[^\n]*?>/g)].map((m) => m[0]).filter((t) => !/^<(?:img|a|source|picture|p)(?:\s+[\w-]+="[^"<>]*")*\s*\/?>$/.test(t)).map((t) => t.slice(0, 60)), 'malformed README tags') },
  { id: 'header-picture', layer: 'output', test: (ctx) => {
    const pic = /^<p align="center"><picture>\n([\s\S]*?)\n<\/picture><\/p>\n/.exec(README(ctx));
    const want = [...HEADER_SOURCES.map(([m, f]) => `<source media="${m}" srcset="${f}">`), `<img src="${HEADER_FALLBACK[0]}" alt="`];
    const got = pic ? pic[1].split('\n') : [];
    return got.length === want.length && want.every((w, i) => got[i].startsWith(w)) && / width="100%">$/.test(got.at(-1)) ? null : 'the README does not open with the themed <picture> header';
  } },
  { id: 'header-contrast', layer: 'output', test: (ctx) => bad(headers(ctx).flatMap(([f, theme]) => [...ctx.expected[f].matchAll(/\.c\d+\{fill:#([0-9a-f]{6})\}/g)].filter((m) => contrast(rgbOf(m[1]), rgbOf(THEMES[theme].bg)) < 1.5).map((m) => `${f} #${m[1]}`)), 'Bud colours too close to the page') },
  { id: 'header-mobile-glyphs', layer: 'output', test: (ctx) => bad(HEADER_SOURCES.filter(([m, f]) => /max-width/.test(m) && ctx.expected?.[f]).map(([, f]) => f).filter((f) => { const s = ctx.expected[f]; return Number(/font-size:([\d.]+)px/.exec(s)?.[1]) * Math.min(1, 343 / Number(/viewBox="0 0 ([\d.]+) /.exec(s)?.[1])) < 6; }), 'mobile headers with glyphs under 6 px at 375 px') },
  { id: 'header-blink', layer: 'output', test: (ctx) => bad(headers(ctx).map(([f]) => f).filter((f) => !/<g class="f3">[\s\S]*?<text/.test(ctx.expected[f])), 'headers without the blink frame') },
  { id: 'header-tagline', layer: 'output', test: (ctx) => bad(headers(ctx).map(([f]) => f).filter((f) => /<text id="tagline"[^>]*>([^<]*)<\/text>/.exec(ctx.expected[f])?.[1] !== ctx.profile?.header?.tagline), "headers whose tagline is not profile.json's") },
  { id: 'readme-line-first', layer: 'output', test: (ctx) => (introLines(README(ctx)).find((l) => l.trim()) === ctx.profile?.intro?.line?.text ? null : "the first line under the header art is not profile.json's line") },
  { id: 'readme-one-heading', layer: 'output', test: (ctx) => bad(README(ctx).split('\n').filter((l) => /^\s*#/.test(l)), 'README headings (the tiles need none)') },
  { id: 'readme-tiles', layer: 'output', test: (ctx) => { const md = README(ctx), p = prsOf(ctx); return p.every((x) => md.includes(tileLink(x))) && (md.match(/dist\/mission\//g) || []).length === p.length ? null : 'README does not show exactly one linked tile per PR'; } },
  { id: 'readme-cards-last', layer: 'output', test: (ctx) => { const md = README(ctx), m = md.search(/^<a href="[^"]*"><img src="dist\/mission\//m); return m < 0 || m > md.indexOf(ctx.profile?.intro?.line?.text) ? null : 'the PR cards are not after the intro line'; } },
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
