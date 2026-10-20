#!/usr/bin/env node
// render.mjs --out <dir>: profile.json -> <dir>/dist/*.svg + <dir>/README.md. No dependencies, deterministic.
// When <dir>/data.json exists (data.mjs ran first, as in the Action), the README adds the PR cards it wrote.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLoop, loopSvg } from './frames.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const attr = (t) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// the README markup for data.mjs's output; check.mjs compares the README against these, so it is defined once
export const statsAlt = (s) => `${s.prs} PRs, ${s.merged} merged, ${s.repos} repos, ${s.orgs} orgs`;
export const tileLink = (p) => `<a href="${attr(p.url)}"><img src="${attr(p.tile)}" alt="${attr(`${p.repo}#${p.number} ${p.state}: ${p.title}`)}" width="420"></a>`;
// the themed header: [media, file] sources in order, then the light fallback; check.mjs requires the same
export const HEADER_SOURCES = [
  ['(max-width: 600px) and (prefers-color-scheme: dark)', 'dist/header-mobile-dark.svg', 'dark'],
  ['(max-width: 600px)', 'dist/header-mobile-light.svg', 'light'],
  ['(prefers-color-scheme: dark)', 'dist/header-dark.svg', 'dark'],
];
export const HEADER_FALLBACK = ['dist/header-light.svg', 'light'];
export const MISSIONS = '## Open-source missions';

// the open-source section: stat chips, the trajectory and one linked tile per PR, from data.mjs's data.json
function cards(file) {
  if (!existsSync(file)) return [];
  const { stats, prs } = JSON.parse(readFileSync(file, 'utf8'));
  return [
    MISSIONS,
    '',
    `<img src="dist/stats.svg" alt="${attr(statsAlt(stats))}">`,
    '',
    `<img src="dist/trajectory.svg" alt="${attr(`${stats.prs} open-source PRs over time`)}">`,
    '',
    ...prs.map(tileLink),
    ...(prs.length ? [''] : []),
  ];
}

export function render(out, profile = JSON.parse(readFileSync(join(ROOT, 'profile.json'), 'utf8'))) {
  const dist = join(out, 'dist');
  mkdirSync(dist, { recursive: true });
  const src = join(ROOT, profile.bud.source.file), tagline = profile.header?.tagline || '';
  // desktop keeps the finer grid; 72 columns keep glyphs >= 6 px in a 375 px phone's 343 px column
  const grids = { '': buildLoop({ src, cols: 96 }), 'mobile-': buildLoop({ src, cols: 72 }) };
  const files = {};
  for (const [prefix, loop] of Object.entries(grids)) for (const theme of ['dark', 'light']) {
    files[`dist/header-${prefix}${theme}.svg`] = loopSvg(loop, { theme, tagline });
  }
  const alt = attr(`${profile.bud.name}, a SkyBuds plush, in animated colour ASCII`);
  files['README.md'] = [
    '<p align="center"><picture>',
    ...HEADER_SOURCES.map(([media, file]) => `<source media="${media}" srcset="${file}">`),
    `<img src="${HEADER_FALLBACK[0]}" alt="${alt}" width="100%">`,
    '</picture></p>',
    '',
    profile.intro.line.text,
    '',
    ...(profile.intro.facts.length ? [...profile.intro.facts.map((f) => `- ${f.text}`), ''] : []),
    ...cards(join(out, 'data.json')),
  ].join('\n');
  for (const [p, body] of Object.entries(files)) writeFileSync(join(out, p), body);
  return Object.keys(files);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  if (!out) { console.error('usage: render.mjs --out <dir>'); process.exit(2); }
  console.log(render(resolve(out)).join('\n'));
}
