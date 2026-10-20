#!/usr/bin/env node
// render.mjs --out <dir>: profile.json + assets/buds/ -> <dir>/dist/*.svg + <dir>/README.md. No dependencies, deterministic.
// When <dir>/data.json exists (data.mjs ran first, as in the Action), the README adds the PR cards it wrote.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBanner } from './banner/banner.mjs';
import { W as TILE_W } from './tiles/tiles.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUDS_DIR = join(ROOT, 'assets', 'buds');

export const attr = (t) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// the README markup for data.mjs's output; check.mjs compares the README against these, so it is defined once.
// One linked tile per line: GitHub joins the lines with a space, so two 408 px tiles share a row in the ~838 px
// desktop column, and on a phone each shrinks to the column (max-width: 100%), one per row.
export const tileLink = (p) => `<a href="${attr(p.url)}"><img src="${attr(p.tile)}" alt="${attr(`${p.repo}#${p.number} ${p.state}: ${p.title}`)}" width="${TILE_W}"></a>`;
// the banner: one scene for both colour schemes (it has its own sky and rounded corners), the phone crop under
// 600 px; reduced motion is the SVG's own media query. check.mjs requires exactly this <picture>.
export const BANNER_PHONE = 'dist/banner-phone.svg', BANNER_DESKTOP = 'dist/banner-desktop.svg';
export const BANNER_ALT = 'Ash, Pearl and Sprout, the three SkyBuds, bouncing a beach ball under a rainbow in a flower meadow, in animated colour ASCII';
export const BANNER_PICTURE = [
  '<p align="center"><picture>',
  `<source media="(max-width: 600px)" srcset="${BANNER_PHONE}">`,
  `<img src="${BANNER_DESKTOP}" alt="${attr(BANNER_ALT)}" width="100%">`,
  '</picture></p>',
];

// the open-source section: one linked tile per PR, from data.mjs's data.json (tiles only, D22; no heading: the
// tiles say what they are)
function cards(data) {
  if (!data || !data.prs.length) return [];
  return [...data.prs.map(tileLink), ''];
}

// Every file render publishes, as { path: body }, from profile.json and data.json (null before data.mjs has run).
// check.mjs re-runs this and requires the published bytes to match, so nothing else can be published.
export function renderFiles(profile, data) {
  const files = { [BANNER_DESKTOP]: buildBanner('desktop', BUDS_DIR), [BANNER_PHONE]: buildBanner('phone', BUDS_DIR) };
  files['README.md'] = [
    ...BANNER_PICTURE,
    '',
    profile.intro.line.text,
    '',
    ...(profile.intro.facts.length ? [...profile.intro.facts.map((f) => `- ${f.text}`), ''] : []),
    ...cards(data),
  ].join('\n');
  return files;
}

export function render(out, profile = JSON.parse(readFileSync(join(ROOT, 'profile.json'), 'utf8'))) {
  const dataFile = join(out, 'data.json');
  const files = renderFiles(profile, existsSync(dataFile) ? JSON.parse(readFileSync(dataFile, 'utf8')) : null);
  mkdirSync(join(out, 'dist'), { recursive: true });
  for (const [p, body] of Object.entries(files)) writeFileSync(join(out, p), body);
  return Object.keys(files);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  if (!out) { console.error('usage: render.mjs --out <dir>'); process.exit(2); }
  console.log(render(resolve(out)).join('\n'));
}
