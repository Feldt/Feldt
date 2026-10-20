#!/usr/bin/env node
// render.mjs --out <dir>: profile.json -> <dir>/dist/*.svg + <dir>/README.md. No dependencies, deterministic.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLoop, loopSvg } from './frames.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const attr = (t) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
    '<source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="dist/header-mobile-dark.svg">',
    '<source media="(max-width: 600px)" srcset="dist/header-mobile-light.svg">',
    '<source media="(prefers-color-scheme: dark)" srcset="dist/header-dark.svg">',
    `<img src="dist/header-light.svg" alt="${alt}" width="100%">`,
    '</picture></p>',
    '',
  ].join('\n');
  for (const [p, body] of Object.entries(files)) writeFileSync(join(out, p), body);
  return Object.keys(files);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  if (!out) { console.error('usage: render.mjs --out <dir>'); process.exit(2); }
  console.log(render(resolve(out)).join('\n'));
}
