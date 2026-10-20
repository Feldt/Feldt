#!/usr/bin/env node
// check.mjs <dir>: the one publish gate (D18). Every rule of the published profile is checked here, not only in
// tests: the README shows at least one local SVG; every local image it references (html src in either quotes,
// every srcset candidate, markdown) exists and is an SVG in the SVG namespace, well-formed XML and at most 150 KB;
// so is every SVG in dist/; the SkyBuds copy follows profile.json; and with data.json, the mission log has one
// linked tile per PR and nothing else. Exit 1 lists each problem.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
import { attr, statsAlt, tileLink, HEADER_SOURCES, HEADER_FALLBACK, MISSIONS } from './render.mjs';
import { statsOf, tileOf, statsSvg, trajectorySvg, tileSvg } from './data.mjs';
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

// The publish rules (D18). Each rule takes the rendered profile and returns its problems; check() runs them all.
// The class test in test/check.test.mjs keeps one break per rule id, so a rule can't be dropped or added unseen.
// Markup and numbers come from the code that makes them (render.mjs, data.mjs), never re-typed here.
const local = (ref) => !/^(?:https?:|data:)/.test(ref);
const clean = (ref) => ref.replace(/^\.?\//, '').split(/[?#]/)[0];
const svgFiles = (dir, rel) => { const d = join(dir, rel); return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.svg')).map((n) => `${rel}/${n}`) : []; };
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// the intro: the lines between the header art and the PR cards
function intro(md) {
  const lines = md.split('\n'), start = lines.findIndex((l) => /<\/picture>/.test(l)) + 1;
  const end = lines.findIndex((l, i) => i >= start && l === MISSIONS);
  return lines.slice(start, end < 0 ? undefined : end);
}
const facts = (md) => intro(md).filter((x) => /^- /.test(x)).map((x) => x.slice(2));

export const RULES = [
  // images: every local image the README shows exists and is a publishable SVG; so is every SVG we ship
  { id: 'image-missing', run: ({ dir, refs }) => refs.filter((r) => !existsSync(join(dir, r))).map((r) => `README image missing: ${r}`) },
  { id: 'image-svg', run: ({ dir, refs, files }) => [...new Set([...refs.filter((r) => existsSync(join(dir, r))), ...files])].flatMap((r) => svgProblems(join(dir, r), r)) },
  { id: 'header-svg', run: ({ refs }) => (refs.some((r) => r.endsWith('.svg')) ? [] : ['README shows no local SVG image (the header)']) },
  // the themed header: one <picture> at the top with the mobile and dark sources in order and the light fallback
  { id: 'header-picture', run: ({ md }) => {
    const pic = /^<p align="center"><picture>([\s\S]*?)<\/picture><\/p>/.exec(md);
    if (!pic) return ['README does not open with the <picture> header'];
    const got = [...pic[1].matchAll(/<source media="([^"]+)" srcset="([^"]+)">/g)].map((m) => [m[1], m[2]]);
    const problems = sameJson(got, HEADER_SOURCES.map(([m, f]) => [m, f])) ? [] : [`header sources ${JSON.stringify(got)}`];
    if (!new RegExp(`<img src="${HEADER_FALLBACK[0]}" alt="[^"]+"`).test(pic[1])) problems.push('header has no light fallback with alt text');
    return problems;
  } },
  // every Bud colour reads on its theme's GitHub background
  { id: 'header-contrast', run: ({ dir }) => [...HEADER_SOURCES.map(([, f, t]) => [f, t]), HEADER_FALLBACK].flatMap(([f, theme]) => {
    if (!existsSync(join(dir, f))) return [];
    const bg = rgbOf(THEMES[theme].bg);
    return [...readFileSync(join(dir, f), 'utf8').matchAll(/\.c\d+\{fill:#([0-9a-f]{6})\}/g)].map((m) => m[1])
      .filter((c) => contrast(rgbOf(c), bg) < 1.5).map((c) => `${f}: #${c} too close to #${THEMES[theme].bg}`);
  }) },
  // at 375 px (343 px of content) the mobile header's glyphs are at least 6 px
  { id: 'header-mobile-glyphs', run: ({ dir }) => HEADER_SOURCES.filter(([m]) => /max-width/.test(m)).flatMap(([, f]) => {
    if (!existsSync(join(dir, f))) return [];
    const s = readFileSync(join(dir, f), 'utf8'), font = Number(/font-size:([\d.]+)px/.exec(s)?.[1]), w = Number(/viewBox="0 0 ([\d.]+) /.exec(s)?.[1]);
    const px = font * Math.min(1, 343 / w);
    return px >= 6 ? [] : [`${f}: glyphs ${px.toFixed(2)} px at 375 px wide`];
  }) },
  // the SkyBuds copy, from profile.json (D20): profile.json's one line right under the header art, linking getskybuds.com;
  // any bullet is a sourced profile.json fact; the brand name only
  { id: 'copy-line', run: ({ md, profile }) => {
    const first = intro(md).find((l) => l.trim());
    if (first !== profile.intro.line.text) return [`first line under the header art is not profile.json's line: ${first}`];
    return /\]\(https:\/\/getskybuds\.com[/)]/.test(first) ? [] : ['the first line does not link getskybuds.com'];
  } },
  { id: 'copy-facts-sourced', run: ({ md, profile }) => { const ok = new Set(profile.intro.facts.filter((f) => /^https:\/\//.test(f.source)).map((f) => f.text)); return facts(md).filter((t) => !ok.has(t)).map((t) => `fact line not in profile.json with a source: ${t}`); } },
  { id: 'copy-brand-only', run: ({ md }) => (/\b(Inc|LLC|Ltd|GmbH|ApS|Corp)\b\.?/.test(md) ? ['legal entity name in the README (brand name only)'] : []) },
  // the README's own HTML: every tag has only quoted attributes with no raw < or " inside
  { id: 'readme-html', run: ({ md }) => [...md.matchAll(/<(?:img|a|source|picture|p)\b[^\n]*?>/g)].map((m) => m[0])
    .filter((t) => !/^<(?:img|a|source|picture|p)(?:\s+[\w-]+="[^"<>]*")*\s*\/?>$/.test(t)).map((t) => `malformed tag: ${t.slice(0, 80)}`) },
  // the mission log: cards only with data.json, after the SkyBuds section
  { id: 'mission-data', run: ({ md, data }) => (!data && /dist\/(?:mission\/|stats\.svg|trajectory\.svg)/.test(md) ? ['README shows PR cards but there is no data.json'] : []) },
  { id: 'mission-order', run: ({ md, profile }) => { const m = md.indexOf(MISSIONS), l = md.indexOf(profile.intro.line.text); return m >= 0 && (l < 0 || m < l) ? ['the PR cards are not after the intro line'] : []; } },
  // every PR is an open or merged PR in an allowlisted org, its tile named from its repo and number
  { id: 'mission-allowlist', run: ({ data, orgs }) => (data?.prs || []).flatMap((p) => {
    const problems = [];
    if (!orgs.has(String(p.repo).split('/')[0].toLowerCase())) problems.push(`PR outside the org allowlist: ${p.url}`);
    if (p.url !== `https://github.com/${p.repo}/pull/${p.number}`) problems.push(`PR url does not match its repo and number: ${p.url}`);
    if (!['open', 'merged'].includes(p.state)) problems.push(`PR neither open nor merged: ${p.url}`);
    if (p.tile !== tileOf(p.repo, p.number)) problems.push(`tile name ${p.tile} for ${p.url}`);
    return problems;
  }) },
  { id: 'mission-stats', run: ({ data }) => (data && !sameJson(data.stats, statsOf(data.prs)) ? [`data.json stats ${JSON.stringify(data.stats)} != ${JSON.stringify(statsOf(data.prs))} from its prs`] : []) },
  // the README shows exactly render.mjs's markup for each PR, and the stat chips' alt, nothing else
  { id: 'mission-tiles', run: ({ md, data }) => {
    if (!data) return [];
    const problems = data.prs.filter((p) => !md.includes(tileLink(p))).map((p) => `README lacks the tile for ${p.url}`);
    const shown = (md.match(/dist\/mission\//g) || []).length;
    if (shown !== data.prs.length) problems.push(`README shows ${shown} tiles for ${data.prs.length} prs`);
    if (!md.includes(`alt="${attr(statsAlt(statsOf(data.prs)))}"`)) problems.push('stat chips alt does not match the prs');
    return problems;
  } },
  // the published SVGs are exactly what data.mjs draws from data.json, and dist/mission holds nothing else
  { id: 'mission-svgs', run: ({ dir, data }) => {
    if (!data) return [];
    const want = { 'dist/stats.svg': statsSvg(statsOf(data.prs)), 'dist/trajectory.svg': trajectorySvg(data.prs), ...Object.fromEntries(data.prs.map((p) => [p.tile, tileSvg(p)])) };
    const problems = Object.entries(want).filter(([f, body]) => !existsSync(join(dir, f)) || readFileSync(join(dir, f), 'utf8') !== body).map(([f]) => `${f} missing or not drawn from data.json`);
    for (const f of svgFiles(dir, 'dist/mission')) if (!(f in want)) problems.push(`tile file for no PR: ${f}`);
    return problems;
  } },
];

// The SkyBuds copy rules alone, for the live README test.
export function copyProblems(md, profile = JSON.parse(readFileSync(join(ROOT, 'profile.json'), 'utf8'))) {
  return RULES.filter((r) => r.id.startsWith('copy-')).flatMap((r) => r.run({ md, profile }));
}

export function check(dir) {
  const readme = join(dir, 'README.md');
  if (!existsSync(readme)) return ['README.md missing'];
  const md = readFileSync(readme, 'utf8');
  const ctx = {
    dir, md,
    refs: [...new Set(imageRefs(md).filter(local).map(clean))],
    files: [...svgFiles(dir, 'dist'), ...svgFiles(dir, 'dist/mission')],
    data: existsSync(join(dir, 'data.json')) ? JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8')) : null,
    profile: JSON.parse(readFileSync(join(ROOT, 'profile.json'), 'utf8')),
    orgs: new Set(JSON.parse(readFileSync(join(ROOT, 'pr-rules.json'), 'utf8')).orgs.map((o) => o.toLowerCase())),
  };
  return RULES.flatMap((r) => r.run(ctx).map((p) => `[${r.id}] ${p}`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: check.mjs <dir>'); process.exit(2); }
  const problems = check(resolve(dir));
  for (const p of problems) console.error(`check: ${p}`);
  if (problems.length) process.exit(1);
  console.log('check: ok');
}
