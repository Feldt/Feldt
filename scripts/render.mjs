#!/usr/bin/env node
// render.mjs --out <dir>: profile.json + the Bud renders it pins -> <dir>/dist/*.svg + <dir>/README.md. No dependencies, deterministic.
// The README never shows data.json's PRs (no PR tiles, Fred 10-20); data.mjs still writes the tile files.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildBanner } from './banner/banner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The banner's inputs: each Bud's render, read from the file profile.json names and refused unless its bytes have
// the sha256 recorded there, so no other image can reach the banner. { name: PNG bytes }
export function budInputs(profile) {
  return Object.fromEntries(Object.entries(profile.buds).map(([name, { file, sha256 }]) => {
    const f = join(ROOT, file), buf = existsSync(f) ? readFileSync(f) : null;
    if (!buf || createHash('sha256').update(buf).digest('hex') !== sha256) throw new Error(`${name}: ${file} does not match its sha256 in profile.json`);
    return [name, buf];
  }));
}

export const attr = (t) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

// Every file render publishes, as { path: body }, from profile.json and data.json (null before data.mjs has run).
// check.mjs re-runs this and requires the published bytes to match, so nothing else can be published.
export function renderFiles(profile, data) {
  const buds = budInputs(profile);
  const files = { [BANNER_DESKTOP]: buildBanner('desktop', buds), [BANNER_PHONE]: buildBanner('phone', buds) };
  files['README.md'] = [
    ...BANNER_PICTURE,
    '',
    profile.intro.line.text,
    '',
    ...(profile.intro.facts.length ? [...profile.intro.facts.map((f) => `- ${f.text}`), ''] : []),
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
