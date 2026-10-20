#!/usr/bin/env node
// tiles.mjs: one candy-coloured tile per open-source PR, for the github.com/Feldt profile README.
//
//   import { tileSvg, logoFor, fragment, writeTiles } from './tiles.mjs'
//   await writeTiles(prs, outDir)        // fetches each org's avatar, writes <outDir>/<tile files> + fragment.html
//   node tiles.mjs --demo <outDir>       // the demo set, avatars from cache/avatars when present
//
// A PR is { repo: 'owner/name', number, title, state: 'open' | 'merged' | 'closed', merged?, url }.
// Each tile is one self-contained SVG that passes GitHub's image CSP (default-src 'none'; style-src
// 'unsafe-inline'; sandbox): no scripts, no images, no fonts. The org avatar is redrawn as pixel cells
// (lib/logo.mjs) and every letter is a glyph path from Fredoka / Nunito (OFL), so a tile looks the same on
// every OS and long titles truncate at exact widths. Animation is CSS only (a pulse on open, a shine on merged,
// a slow glint on the logo) and stops under prefers-reduced-motion. No dependencies beyond node itself.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logoFromPng, logoCells } from './lib/logo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const font = (id) => JSON.parse(readFileSync(join(HERE, 'assets', `glyphs-${id}.json`), 'utf8'));
export const FONTS = { display: font('fredoka-600'), body: font('nunito-800') };

// ---- geometry (viewBox units = CSS px at the README's width="408") --------------------------------------------
export const W = 408, H = 132;
const CARD = { x: 4, y: 3, w: 400, h: 112, r: 26, lip: 6 };
const PLATE = { x: 17, y: 16, s: 86, r: 23 };
const TEXT_X = 118, TEXT_R = CARD.x + CARD.w - 16;

// ---- colour -----------------------------------------------------------------------------------------------------
// Candy palette, in order: Ash orange, Pearl blue, grape, Sprout green, bubblegum, lagoon. Adjacent tiles in a
// two-column grid never share a colour. top/bottom: body gradient, lip: the chunky 3D edge, ink: outlines and small
// text; title: the PR title's colour (ink on the light candies, white with an ink drop on the deep ones).
export const CANDY = [
  { name: 'tangerine', top: '#ffb13d', bottom: '#ff6a1a', lip: '#d2470a', ink: '#8f2c00', title: 'ink' },
  { name: 'sky', top: '#5ccbff', bottom: '#1a7dfa', lip: '#125dcc', ink: '#0b357a', title: 'white' },
  { name: 'grape', top: '#b98aff', bottom: '#7a45f5', lip: '#5629c9', ink: '#2f1275', title: 'white' },
  { name: 'leaf', top: '#7ae36a', bottom: '#1fae55', lip: '#13853f', ink: '#0a4a22', title: 'ink' },
  { name: 'bubblegum', top: '#ff8acb', bottom: '#ee3a90', lip: '#c2236f', ink: '#740c40', title: 'white' },
  { name: 'lagoon', top: '#4fe3d4', bottom: '#0ea5a8', lip: '#0a7e85', ink: '#05484d', title: 'ink' },
];
const BADGE = {
  open: { label: 'OPEN', fill: '#ffffff', text: '#11994a', dot: '#20c463' },
  merged: { label: 'MERGED', fill: '#8b4dff', fill2: '#6d28f0', text: '#ffffff', dot: '#ffffff' },
  closed: { label: 'CLOSED', fill: '#ffffff', text: '#d4283b', dot: '#f0384f' },
};

// ---- text as glyph paths ----------------------------------------------------------------------------------------
const ELLIPSIS = '…';
// Characters the fonts lack lose their accents (NFKD), smart punctuation stays, anything else (emoji) is dropped.
export function normalize(str, f = FONTS.body) {
  let out = '';
  for (const ch of String(str).replace(/\s+/g, ' ').trim()) {
    if (f.glyphs[ch]) out += ch;
    else { const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, ''); for (const b of base) if (f.glyphs[b]) out += b; }
  }
  return out.replace(/ {2,}/g, ' ').trim();
}
// advance width in px of str set in font f at size px (kerning included)
export function measure(str, f, size) {
  let u = 0, prev = null;
  for (const ch of str) { u += (f.glyphs[ch]?.[0] || 0) + (prev ? f.kern[prev + ch] || 0 : 0); prev = ch; }
  return (u * size) / f.unitsPerEm;
}
// longest prefix of str that fits with an ellipsis; prefers a word break when it costs little
export function ellipsize(str, f, size, max) {
  if (measure(str, f, size) <= max) return str;
  let n = str.length;
  while (n > 0 && measure(str.slice(0, n).trimEnd() + ELLIPSIS, f, size) > max) n--;
  const cut = str.slice(0, n), sp = cut.lastIndexOf(' ');
  const head = sp > n * 0.7 ? cut.slice(0, sp) : cut;
  return head.replace(/[\s,.:;\-–—]+$/, '') + ELLIPSIS;
}
// greedy word wrap to at most `lines` lines; the last line ellipsizes what is left
export function wrap(str, f, size, max, lines = 2) {
  const words = str.split(' '), out = [];
  let i = 0;
  while (i < words.length && out.length < lines) {
    if (out.length === lines - 1) { out.push(ellipsize(words.slice(i).join(' '), f, size, max)); i = words.length; break; }
    let line = words[i++];
    if (measure(line, f, size) > max) {
      // a word wider than the line breaks where it fills the line; the rest goes on
      let k = line.length; while (k > 1 && measure(line.slice(0, k), f, size) > max) k--;
      out.push(line.slice(0, k)); words.splice(i, 0, line.slice(k));
      continue;
    }
    while (i < words.length && measure(`${line} ${words[i]}`, f, size) <= max) line += ` ${words[i++]}`;
    out.push(line);
  }
  return out;
}

// Collects the glyphs a tile uses and draws runs of them as <use> references (one <path> per glyph in <defs>).
class Glyphs {
  constructor() { this.used = new Map(); }
  id(fk, ch) { const id = `${fk[0]}${ch.codePointAt(0).toString(36)}`; this.used.set(id, [fk, ch]); return id; }
  // a run of text at (x, baseline y), size in px; attrs go on the run's <g>
  run(fk, str, x, y, size, attrs = '') {
    const f = FONTS[fk], k = size / f.unitsPerEm;
    let u = 0, prev = null, uses = '';
    for (const ch of str) {
      const g = f.glyphs[ch];
      if (!g) continue;
      u += prev ? f.kern[prev + ch] || 0 : 0;
      if (g[1]) uses += `<use href="#${this.id(fk, ch)}"${u ? ` x="${u}"` : ''}/>`;
      u += g[0]; prev = ch;
    }
    return `<g transform="translate(${r2(x)} ${r2(y)}) scale(${r4(k)})"${attrs}>${uses}</g>`;
  }
  defs() { return [...this.used].map(([id, [fk, ch]]) => `<path id="${id}" d="${FONTS[fk].glyphs[ch][1]}"/>`).join(''); }
}
const r2 = (v) => Math.round(v * 100) / 100, r4 = (v) => Math.round(v * 10000) / 10000;
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- the tile ---------------------------------------------------------------------------------------------------
export const stateOf = (p) => (p.state === 'merged' || p.merged ? 'merged' : p.state === 'open' ? 'open' : 'closed');
export const altOf = (p) => `${p.repo}#${p.number} ${stateOf(p)}: ${p.title}`;

// p: a PR; index: its place in the list (picks the colour and staggers the glint); logo: from logoFor/logoFromPng, or
// null for a monogram plate.
export function tileSvg(p, { index = 0, logo = null } = {}) {
  const c = CANDY[index % CANDY.length], state = stateOf(p), b = BADGE[state], G = new Glyphs();
  const [org, name] = p.repo.split('/');
  const { x, y, w, h, r, lip } = CARD;
  const textW = TEXT_R - TEXT_X;

  // badge (top right): pill sized to its label
  const bSize = 11.5, bLabelW = measure(b.label, FONTS.display, bSize), bW = Math.round(bLabelW + 34), bH = 23;
  const bX = TEXT_R - bW + 2, bY = 15;
  // org line, left of the badge
  const orgSize = 13, orgText = ellipsize(normalize(`${org} · PR #${p.number}`), FONTS.body, orgSize, bX - 10 - TEXT_X);
  // repo name: chunky, shrinks from 24 to 19 px before it ellipsizes
  const repo = normalize(name, FONTS.display);
  let repoSize = 24;
  while (repoSize > 19 && measure(repo, FONTS.display, repoSize) > textW) repoSize -= 0.5;
  const repoText = ellipsize(repo, FONTS.display, repoSize, textW);
  // title: two lines at most
  const titleSize = 15, lines = wrap(normalize(p.title) || `Pull request #${p.number}`, FONTS.body, titleSize, textW, 2);

  const glint = (index * 1.7) % 9;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(altOf(p))}">`);
  parts.push(`<title>${esc(altOf(p))}</title>`);
  parts.push('<style>'
    + '.pulse{transform-box:fill-box;transform-origin:center;animation:pulse 2.4s cubic-bezier(.2,.7,.3,1) infinite}'
    + '@keyframes pulse{0%{transform:scale(.6);opacity:.75}70%,100%{transform:scale(2.3);opacity:0}}'
    + `.shine{animation:shine 4.2s ease-in-out infinite;transform:translateX(${bX - 30}px)}`
    + `@keyframes shine{0%,55%{transform:translateX(${bX - 30}px)}85%,100%{transform:translateX(${bX + bW + 10}px)}}`
    + `.glint{animation:glint 9s ease-in-out ${r2(glint)}s infinite;transform:translateX(${PLATE.x - 50}px)}`
    + `@keyframes glint{0%,80%{transform:translateX(${PLATE.x - 50}px)}92%,100%{transform:translateX(${PLATE.x + PLATE.s + 30}px)}}`
    + '.tw{transform-box:fill-box;transform-origin:center;animation:tw 3.6s ease-in-out infinite}'
    + '@keyframes tw{0%,100%{transform:scale(.55);opacity:.55}50%{transform:scale(1);opacity:1}}'
    + '@media (prefers-reduced-motion:reduce){.pulse,.shine,.glint,.tw{animation:none}.pulse{opacity:0}}'
    + '</style>');
  parts.push('<defs>'
    + `<linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.top}"/><stop offset="1" stop-color="${c.bottom}"/></linearGradient>`
    + '<linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity=".04"/></linearGradient>'
    + '<linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".75"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>'
    + '<linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'
    + (state === 'merged' ? `<linearGradient id="bfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${b.fill}"/><stop offset="1" stop-color="${b.fill2}"/></linearGradient>` : '')
    + `<clipPath id="card"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/></clipPath>`
    + `<clipPath id="plate"><rect x="${PLATE.x + 5}" y="${PLATE.y + 5}" width="${PLATE.s - 10}" height="${PLATE.s - 10}" rx="${PLATE.r - 5}"/></clipPath>`
    + `<clipPath id="pill"><rect x="${bX}" y="${bY}" width="${bW}" height="${bH}" rx="${bH / 2}"/></clipPath>`
    + '<pattern id="dots" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><circle cx="3" cy="3" r="1.6" fill="#fff" fill-opacity=".16"/><circle cx="10" cy="10" r="1.6" fill="#fff" fill-opacity=".16"/></pattern>'
    + `<filter id="soft" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="3.5"/></filter>`
    + '__GLYPHS__</defs>');

  // card: soft floor shadow, chunky lip, glossy candy body, rim light, dotted texture on the right
  parts.push(`<rect x="${x + 10}" y="${y + lip + 8}" width="${w - 20}" height="${h - 6}" rx="${r}" fill="${c.ink}" opacity=".28" filter="url(#soft)"/>`);
  parts.push(`<rect x="${x}" y="${y + lip}" width="${w}" height="${h}" rx="${r}" fill="${c.lip}"/>`);
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="url(#body)"/>`);
  parts.push(`<g clip-path="url(#card)"><rect x="${x + w * 0.55}" y="${y}" width="${w * 0.45}" height="${h}" fill="url(#dots)"/>`
    + `<rect x="${x + 7}" y="${y + 5}" width="${w - 14}" height="${h * 0.42}" rx="${r - 6}" fill="url(#gloss)"/></g>`);
  parts.push(`<rect x="${x + 0.75}" y="${y + 0.75}" width="${w - 1.5}" height="${h - 1.5}" rx="${r - 0.75}" fill="none" stroke="url(#rim)" stroke-width="1.5"/>`);

  // logo plate: white sticker with its own lip, the pixel avatar inside, a gloss and a slow glint
  const P = PLATE;
  parts.push(`<rect x="${P.x}" y="${P.y + 4}" width="${P.s}" height="${P.s}" rx="${P.r}" fill="${c.ink}" opacity=".35"/>`);
  parts.push(`<rect x="${P.x}" y="${P.y}" width="${P.s}" height="${P.s}" rx="${P.r}" fill="#fff"/>`);
  const li = P.s - 10, lx = P.x + 5, ly = P.y + 5;
  if (logo) {
    const s = logo.bleed ? li : li - 14, o = (li - s) / 2;
    parts.push(`<g clip-path="url(#plate)"><rect x="${lx}" y="${ly}" width="${li}" height="${li}" fill="${logo.bleed ? logo.pal[0] : '#fff'}"/>`
      + `<g transform="translate(${r2(lx + o)} ${r2(ly + o)}) scale(${r4(s / logo.n)})">${logoCells(logo)}</g>`);
  } else {
    // monogram when there is no avatar: the org's first letter in the tile's colours
    const m = normalize(org, FONTS.display).slice(0, 1).toUpperCase() || '?', ms = 46, mw = measure(m, FONTS.display, ms);
    parts.push(`<g clip-path="url(#plate)"><rect x="${lx}" y="${ly}" width="${li}" height="${li}" fill="url(#body)"/>`
      + G.run('display', m, lx + (li - mw) / 2, ly + li / 2 + ms * 0.36, ms, ' fill="#fff"'));
  }
  parts.push(`<rect x="${lx}" y="${ly}" width="${li}" height="${li * 0.45}" fill="url(#gloss)" opacity=".55"/>`
    + `<g class="glint"><rect x="0" y="${P.y - 10}" width="24" height="${P.s + 20}" fill="url(#sheen)" opacity=".6" transform="skewX(-18)"/></g>`
    + '</g>');
  parts.push(`<rect x="${lx - 0.5}" y="${ly - 0.5}" width="${li + 1}" height="${li + 1}" rx="${P.r - 4.5}" fill="none" stroke="#000" stroke-opacity=".08"/>`);
  // a sparkle on the plate's corner
  const sx = P.x + P.s - 4, sy = P.y + 3;
  parts.push(`<path class="tw" d="M${sx} ${sy - 7}Q${sx + 1} ${sy - 1} ${sx + 7} ${sy}Q${sx + 1} ${sy + 1} ${sx} ${sy + 7}Q${sx - 1} ${sy + 1} ${sx - 7} ${sy}Q${sx - 1} ${sy - 1} ${sx} ${sy - 7}Z" fill="#fff" style="animation-delay:${r2((index * 1.3) % 3.6)}s"/>`);

  // text: org line, chunky repo name with an ink outline and drop, two title lines with a soft ink shadow
  parts.push(G.run('body', orgText, TEXT_X, 34, orgSize, ` fill="${c.ink}" fill-opacity=".78"`));
  const repoY = 61, sw = r2((3.2 * FONTS.display.unitsPerEm) / repoSize);
  parts.push(G.run('display', repoText, TEXT_X, repoY + 2, repoSize, ` fill="${c.ink}" stroke="${c.ink}" stroke-width="${sw}" stroke-linejoin="round" opacity=".55"`));
  parts.push(G.run('display', repoText, TEXT_X, repoY, repoSize, ` fill="${c.ink}" stroke="${c.ink}" stroke-width="${sw}" stroke-linejoin="round"`));
  parts.push(G.run('display', repoText, TEXT_X, repoY, repoSize, ' fill="#fff"'));
  lines.forEach((line, i) => {
    const ty = 84 + i * 19;
    if (c.title === 'white') parts.push(G.run('body', line, TEXT_X, ty + 1.3, titleSize, ` fill="${c.ink}" fill-opacity=".55"`));
    parts.push(G.run('body', line, TEXT_X, ty, titleSize, ` fill="${c.title === 'white' ? '#fff' : c.ink}"`));
  });

  // badge: white (or purple, for merged) pill with a lip; a pulsing dot on open, a passing shine on merged
  parts.push(`<rect x="${bX}" y="${bY + 2.5}" width="${bW}" height="${bH}" rx="${bH / 2}" fill="${c.ink}" opacity=".35"/>`);
  parts.push(`<rect x="${bX}" y="${bY}" width="${bW}" height="${bH}" rx="${bH / 2}" fill="${state === 'merged' ? 'url(#bfill)' : b.fill}"${state === 'merged' ? ' stroke="#fff" stroke-width="2"' : ''}/>`);
  const dx = bX + 13, dy = bY + bH / 2;
  if (state === 'open') parts.push(`<circle class="pulse" cx="${dx}" cy="${dy}" r="4" fill="${b.dot}"/>`);
  if (state === 'merged') {
    // GitHub's merge mark: a trunk with a branch curving into a second node
    parts.push(`<path d="M${dx - 3} ${dy - 3.2}V${dy + 5.2}M${dx - 3} ${dy - 2}Q${dx - 3} ${dy + 2.6} ${dx + 1.6} ${dy + 2.6}" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>`
      + `<circle cx="${dx - 3}" cy="${dy - 4.6}" r="2.1" fill="#fff"/><circle cx="${dx + 3.4}" cy="${dy + 2.6}" r="2.1" fill="#fff"/>`);
  } else parts.push(`<circle cx="${dx}" cy="${dy}" r="4" fill="${b.dot}"/>`);
  parts.push(G.run('display', b.label, bX + 23, bY + 15.8, bSize, ` fill="${b.text}"`));
  if (state === 'merged') parts.push(`<g clip-path="url(#pill)"><g class="shine"><rect x="0" y="${bY - 4}" width="20" height="${bH + 8}" fill="url(#sheen)" opacity=".75" transform="skewX(-20)"/></g></g>`);
  parts.push('</svg>');
  return parts.join('').replace('__GLYPHS__', G.defs()) + '\n';
}

// ---- logos ------------------------------------------------------------------------------------------------------
// The org's GitHub avatar as a PNG buffer. github.com/<org>.png redirects to the current avatars.githubusercontent.com/u/<id>
// image (resized to PNG); the login-based avatars URL can serve a stale or default image (it did for teslamotors).
// base can point the fetch at a fake server in tests (data.mjs passes GITHUB_AVATARS_URL).
export const AVATARS = 'https://github.com';
export async function fetchAvatar(org, { size = 240, base = AVATARS, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const res = await fetchImpl(`${base}/${encodeURIComponent(org)}.png?size=${size}`, { headers: { 'user-agent': 'Feldt-profile' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`avatar ${org}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
// org -> logo, or null when the avatar can't be fetched or isn't a PNG (the tile then shows a monogram). Never throws.
// cacheDir keeps fetched avatars on disk (tests and local previews); the Action passes none.
export async function logoFor(org, { cacheDir = null, n = 64, base = AVATARS, ...opts } = {}) {
  const cached = cacheDir && join(cacheDir, `${org.toLowerCase()}.png`);
  try {
    const buf = cached && existsSync(cached) ? readFileSync(cached) : await fetchAvatar(org, { base: base || AVATARS, ...opts });
    if (cached && !existsSync(cached)) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(cached, buf); }
    return logoFromPng(buf, { n });
  } catch { return null; }
}

// ---- README fragment --------------------------------------------------------------------------------------------
export const tileName = (repo, number) => `${repo.replace('/', '--').toLowerCase()}-${number}.svg`;
const attr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// One linked tile per line: GitHub joins the lines with a space, two 408 px tiles share a row in the ~838 px
// desktop column, and on a phone each tile shrinks to the column (max-width: 100%), one per row.
export const tileLink = (p, dir = 'dist/mission') => `<a href="${attr(p.url)}"><img src="${attr(`${dir}/${tileName(p.repo, p.number)}`)}" alt="${attr(altOf(p))}" width="${W}"></a>`;
export const fragment = (prs, dir = 'dist/mission') => prs.map((p) => tileLink(p, dir)).join('\n') + '\n';

// Writes every tile and fragment.html into outDir; returns { files, logos }.
export async function writeTiles(prs, outDir, { cacheDir = null, logos = {}, dir = 'dist/mission' } = {}) {
  mkdirSync(outDir, { recursive: true });
  for (const org of new Set(prs.map((p) => p.repo.split('/')[0]))) if (!(org.toLowerCase() in logos)) logos[org.toLowerCase()] = await logoFor(org, { cacheDir });
  const files = prs.map((p, i) => {
    const f = tileName(p.repo, p.number);
    writeFileSync(join(outDir, f), tileSvg(p, { index: i, logo: logos[p.repo.split('/')[0].toLowerCase()] }));
    return f;
  });
  writeFileSync(join(outDir, 'fragment.html'), fragment(prs, dir));
  return { files, logos };
}

// ---- demo -------------------------------------------------------------------------------------------------------
export const DEMO = [
  { repo: 'teslamotors/kafka-helmsman', number: 97, title: "Topic enforcer: don't try to decrease partition counts", state: 'open', merged: false, url: 'https://github.com/teslamotors/kafka-helmsman/pull/97' },
  { repo: 'neuralink/tsui', number: 38, title: 'Fix machine details preview overflowing an 80 column terminal', state: 'open', merged: false, url: 'https://github.com/neuralink/tsui/pull/38' },
  { repo: 'neuralinkcorp/datarepo', number: 84, title: 'Match contains filters as a literal substring', state: 'open', merged: false, url: 'https://github.com/neuralinkcorp/datarepo/pull/84' },
  // hypothetical PRs, only to exercise the grid (merged badge, long repo name, long title)
  { repo: 'nasa/fprime', number: 3912, title: 'CmdSequencer: Reject sequences with zero records', state: 'merged', merged: true, url: 'https://github.com/nasa/fprime/pull/3912' },
  { repo: 'uber/h3', number: 1007, title: 'Add gridRingUnsafe fast path for pentagon-free rings and document the distortion bounds near icosahedron edges', state: 'open', merged: false, url: 'https://github.com/uber/h3/pull/1007' },
  { repo: 'NVIDIA/nvidia-container-toolkit', number: 1240, title: 'Skip missing CDI spec directories instead of failing', state: 'open', merged: false, url: 'https://github.com/NVIDIA/nvidia-container-toolkit/pull/1240' },
];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), i = args.indexOf('--demo');
  if (i < 0) { console.error('usage: tiles.mjs --demo <outDir>'); process.exit(2); }
  const out = resolve(args[i + 1] || join(HERE, 'demo'));
  const { files } = await writeTiles(DEMO, out, { cacheDir: join(HERE, 'cache', 'avatars') });
  for (const f of files) console.log(f, readFileSync(join(out, f)).length, 'bytes');
}
