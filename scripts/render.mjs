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
  const files = { 'dist/header.svg': loopSvg(buildLoop({ src: join(ROOT, profile.bud.source.file) })) };
  const alt = attr(`${profile.bud.name}, a SkyBuds plush, in animated colour ASCII`);
  files['README.md'] = `<p align="center"><img src="dist/header.svg" alt="${alt}" width="100%"></p>\n`;
  for (const [p, body] of Object.entries(files)) writeFileSync(join(out, p), body);
  return Object.keys(files);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  if (!out) { console.error('usage: render.mjs --out <dir>'); process.exit(2); }
  console.log(render(resolve(out)).join('\n'));
}
