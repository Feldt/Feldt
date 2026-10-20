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

// The SkyBuds copy: header art above a SkyBuds heading, a SkyBuds first line, then only profile.json's sourced
// facts (at least 3), and the brand name only. Shared with the live README test.
export function copyProblems(md, profile = JSON.parse(readFileSync(join(ROOT, 'profile.json'), 'utf8'))) {
  const problems = [];
  const lines = md.split('\n');
  const h = lines.findIndex((l) => /^#{1,3} /.test(l));
  if (h < 0) return ['no heading'];
  if (!/SkyBuds/.test(lines[h])) problems.push(`first heading is not about SkyBuds: ${lines[h]}`);
  const first = lines.slice(h + 1).find((l) => l.trim());
  if (!first || !/SkyBuds/.test(first)) problems.push(`first line is not about SkyBuds: ${first}`);
  if (/<picture>/.test(md) && md.indexOf('<picture>') > md.indexOf(lines[h])) problems.push('header art is not above the heading');
  const end = lines.findIndex((l, i) => i > h && /^#{1,3} /.test(l));
  const facts = new Set(profile.intro.facts.map((f) => f.text));
  const listed = lines.slice(h + 1, end < 0 ? undefined : end).filter((x) => /^- /.test(x)).map((x) => x.slice(2));
  for (const text of listed) if (!facts.has(text)) problems.push(`fact line not in profile.json: ${text}`);
  if (listed.length < 3) problems.push('fewer than 3 fact lines');
  if (/\b(Inc|LLC|Ltd|GmbH|ApS|Corp)\b\.?/.test(md)) problems.push('legal entity name in the README (brand name only)');
  return problems;
}

// The mission log: data.json's prs agree with stats.prs, the README links one tile per PR (and no other), and
// dist/mission holds exactly those tiles.
export function missionProblems(dir, md) {
  const file = join(dir, 'data.json');
  if (!existsSync(file)) return [];
  const { prs = [], stats = {} } = JSON.parse(readFileSync(file, 'utf8'));
  const problems = [];
  if (stats.prs !== prs.length) problems.push(`data.json stats.prs ${stats.prs} != ${prs.length} prs`);
  const linked = [...md.matchAll(/<a href="([^"]+)"><img src="(dist\/mission\/[^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
  const want = prs.map((p) => `${p.url} ${p.tile}`);
  for (const t of want) if (!linked.includes(t)) problems.push(`README lacks the tile for ${t}`);
  for (const t of linked) if (!want.includes(t)) problems.push(`README tile not in data.json: ${t}`);
  if (linked.length !== want.length) problems.push(`README has ${linked.length} tiles for ${want.length} prs`);
  const mission = join(dir, 'dist', 'mission');
  const files = existsSync(mission) ? readdirSync(mission).map((f) => `dist/mission/${f}`) : [];
  for (const p of prs) if (!files.includes(p.tile)) problems.push(`tile file missing: ${p.tile}`);
  for (const f of files) if (!prs.some((p) => p.tile === f)) problems.push(`tile file for no PR: ${f}`);
  return problems;
}

export function check(dir) {
  const problems = [], readme = join(dir, 'README.md');
  if (!existsSync(readme)) return ['README.md missing'];
  const md = readFileSync(readme, 'utf8');
  problems.push(...copyProblems(md), ...missionProblems(dir, md));
  const local = imageRefs(md).filter((r) => !/^(?:https?:|data:)/.test(r)).map((r) => r.replace(/^\.?\//, '').split(/[?#]/)[0]);
  const checked = new Set();
  for (const r of local) {
    const p = join(dir, r);
    if (!existsSync(p)) { problems.push(`README image missing: ${r}`); continue; }
    checked.add(resolve(p));
    problems.push(...svgProblems(p, r));
  }
  if (!local.some((r) => r.endsWith('.svg'))) problems.push('README shows no local SVG image (the header)');
  const dist = join(dir, 'dist');
  const svgs = (d, rel) => existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.svg')).map((n) => [join(d, n), `${rel}/${n}`]) : [];
  for (const [p, label] of [...svgs(dist, 'dist'), ...svgs(join(dist, 'mission'), 'dist/mission')]) {
    if (!checked.has(resolve(p))) problems.push(...svgProblems(p, label));
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: check.mjs <dir>'); process.exit(2); }
  const problems = check(resolve(dir));
  for (const p of problems) console.error(`check: ${p}`);
  if (problems.length) process.exit(1);
  console.log('check: ok');
}
