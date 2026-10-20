#!/usr/bin/env node
// check.mjs <dir>: the rendered profile is publishable: every local image the README shows exists,
// every SVG is well-formed XML and at most 150 KB. Exit 1 lists each problem.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_SVG = 150 * 1024;

// Well-formedness: balanced elements, quoted attributes, comments/CDATA/PIs closed, one root.
export function xmlProblem(s) {
  const stack = []; let i = 0, roots = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); if (e < 0) return 'unclosed comment'; i = e + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt); if (e < 0) return 'unclosed CDATA'; i = e + 3; continue; }
    if (s.startsWith('<?', lt)) { const e = s.indexOf('?>', lt); if (e < 0) return 'unclosed processing instruction'; i = e + 2; continue; }
    if (s.startsWith('<!', lt)) { const e = s.indexOf('>', lt); if (e < 0) return 'unclosed declaration'; i = e + 1; continue; }
    const m = /^<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/.exec(s.slice(lt));
    if (!m) return `bad tag at ${lt}`;
    const [all, close, name, , self] = m;
    if (close) { if (stack.pop() !== name) return `mismatched </${name}> at ${lt}`; }
    else if (!self) { if (!stack.length) roots++; stack.push(name); }
    else if (!stack.length) roots++;
    i = lt + all.length;
  }
  if (stack.length) return `unclosed <${stack[stack.length - 1]}>`;
  if (roots !== 1) return `${roots} root elements`;
  return null;
}

export function check(dir) {
  const problems = [], readme = join(dir, 'README.md');
  if (!existsSync(readme)) return ['README.md missing'];
  const md = readFileSync(readme, 'utf8');
  const refs = [...md.matchAll(/<img[^>]* src="([^"]+)"/g), ...md.matchAll(/srcset="([^"]+)"/g)].map((m) => m[1].split(/\s+/)[0]);
  for (const r of refs) if (!/^https?:/.test(r) && !existsSync(join(dir, r))) problems.push(`README image missing: ${r}`);
  const dist = join(dir, 'dist');
  for (const f of existsSync(dist) ? readdirSync(dist).filter((n) => n.endsWith('.svg')) : []) {
    const p = join(dist, f), size = statSync(p).size;
    if (size > MAX_SVG) problems.push(`dist/${f}: ${size} bytes, over 150 KB`);
    const x = xmlProblem(readFileSync(p, 'utf8'));
    if (x) problems.push(`dist/${f}: not well-formed XML (${x})`);
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
