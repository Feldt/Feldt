#!/usr/bin/env node
// check.mjs <dir>: the rendered profile is publishable: the README shows at least one local SVG; every
// local image it references (html src in either quotes, every srcset candidate, markdown) exists and is an
// SVG in the SVG namespace, well-formed XML and at most 150 KB; so is every SVG in dist/. Exit 1 lists each problem.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function check(dir) {
  const problems = [], readme = join(dir, 'README.md');
  if (!existsSync(readme)) return ['README.md missing'];
  const local = imageRefs(readFileSync(readme, 'utf8')).filter((r) => !/^(?:https?:|data:)/.test(r)).map((r) => r.replace(/^\.?\//, '').split(/[?#]/)[0]);
  const checked = new Set();
  for (const r of local) {
    const p = join(dir, r);
    if (!existsSync(p)) { problems.push(`README image missing: ${r}`); continue; }
    checked.add(resolve(p));
    problems.push(...svgProblems(p, r));
  }
  if (!local.some((r) => r.endsWith('.svg'))) problems.push('README shows no local SVG image (the header)');
  const dist = join(dir, 'dist');
  for (const f of existsSync(dist) ? readdirSync(dist).filter((n) => n.endsWith('.svg')) : []) {
    if (!checked.has(resolve(join(dist, f)))) problems.push(...svgProblems(join(dist, f), `dist/${f}`));
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
