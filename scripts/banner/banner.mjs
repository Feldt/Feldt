// buildBanner('desktop' | 'phone', { ash, pearl, sprout: PNG bytes of each Bud's render }) -> SVG string. Called by scripts/render.mjs.
// The three Buds playing keepy-uppy in a candy meadow, in colour ASCII, as two self-contained animated
// SVGs (desktop 1200x300, phone 640x320) that GitHub can show through <img>. No dependencies, no network,
// deterministic: the same renders always give the same bytes.
//
// How it moves: every sprite is a group of absolutely placed glyphs; CSS keyframes move whole groups
// (translate / rotate / scale about each sprite's own origin: feet, shoulder, tail root), and only the
// blink swaps glyphs (step-end opacity on the eye cells). One 10 s loop; clouds drift on 30 s / 60 s.
import { budSprite } from './buds.mjs';
import { spriteOf, cloudImage, sunImage, ballImage, rng } from './scene.mjs';
import { rowsSvg, className, esc } from './svgtext.mjs';
import { glyphTable } from './ascii.mjs';
import { candy, hex, mix, parseHex, lch, fromLch } from './color.mjs';
import { quantize } from './quant.mjs';

export const LOOP = 10; // seconds
const MOSAIC_L = 0.75; // cell background lightness, relative to the glyph's
const FONT = "Menlo,Consolas,'DejaVu Sans Mono','Liberation Mono','Courier New',monospace";
const f1 = (v) => +(+v).toFixed(1), f2 = (v) => +(+v).toFixed(2), f3 = (v) => +(+v).toFixed(3);

// ---- palette -------------------------------------------------------------------------------------------
export const PAL = {
  skyTop: '1f63ff', skyMid: '45b4ff', skyLow: '9fe9ff', haze: 'ffd6f2',
  hillFar: ['3fc7b0', '2a9f95'], hillNear: ['44d36a', '22a34c'],
  meadow: ['3fd04f', '1d9a3c', '157a31'], grass: ['b6ff6a', '7af05a', '4fdc4c', 'e6ff8a'],
  flowers: [['ff4fa3', 'ffe14a'], ['ffe14a', 'ff8a1c'], ['ff5b5b', 'ffe14a'], ['b77bff', 'fff3a0'], ['ffffff', 'ffcf3a'], ['ff8ad8', 'ffffff']],
  butterflies: [['ff5fc8', 'ffe14a'], ['ffe14a', 'ff7a2a'], ['5fe0ff', 'b77bff']],
  rim: '0b1b4d',
};

// ---- layouts ------------------------------------------------------------------------------------------
// Units are viewBox units. Bud: x = feet centre, y = ground under the feet, h = sprite height, cols = grid.
export const LAYOUTS = {
  desktop: {
    W: 1200, H: 300, r: 22, cell: 1, // scenery cell = 6x10 units * cell
    horizon: 214, meadowTop: 236,
    sun: { x: 1118, y: 64, r: 30 },
    rainbow: { cx: 600, cy: 330, r: 292, band: 6, op: 0.92 },
    buds: {
      sprout: { x: 262, y: 298, h: 210, cols: 56 },
      ash: { x: 600, y: 238, h: 182, cols: 58 },
      pearl: { x: 938, y: 299, h: 214, cols: 58 },
    },
    clouds: { far: [[60, 34, 120], [420, 22, 100], [760, 40, 110], [1010, 118, 90]], near: [[180, 62, 170], [700, 92, 150], [1000, 30, 140]] },
    ball: { r: 21, cols: 8 },
    ashShadow: 254,
    flowers: 24, front: 34,
  },
  phone: {
    W: 640, H: 320, r: 20, cell: 1.6,
    horizon: 214, meadowTop: 238,
    sun: { x: 580, y: 52, r: 26 },
    rainbow: { cx: 320, cy: 332, r: 300, band: 7, op: 0.92 },
    buds: {
      sprout: { x: 114, y: 320, h: 222, cols: 56 },
      ash: { x: 322, y: 250, h: 190, cols: 58 },
      pearl: { x: 510, y: 321, h: 224, cols: 58 },
    },
    ashShadow: 276,
    clouds: { far: [[20, 30, 110], [300, 16, 90], [470, 120, 80]], near: [[90, 70, 150], [420, 86, 130]] },
    ball: { r: 18, cols: 8 },
    flowers: 14, front: 18,
  },
};

// ---- small builders -----------------------------------------------------------------------------------
class Palette {
  constructor(prefix) { this.prefix = prefix; this.list = []; this.map = new Map(); }
  cls(rgb) { const h = hex(rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))))); if (!this.map.has(h)) { this.map.set(h, className(this.prefix, this.list.length)); this.list.push(h); } return this.map.get(h); }
  css() { return this.list.map((h) => `.${this.map.get(h)}{color:#${h}}`).join(''); }
  hexOf(cls) { return this.list.find((h) => this.map.get(h) === cls); }
}
// sprite cells -> classes via a k-colour quantisation (candy-boosted first)
function classify(cellLists, pal, k, boost) {
  const all = cellLists.flat().map((c) => (c.boosted ||= candy(c.rgb, boost)));
  const q = quantize(all, k);
  const names = q.centers.map((c) => pal.cls(c));
  for (const list of cellLists) for (const c of list) c.k = names[q.index(c.boosted)];
}
const keyframes = (name, frames) => `@keyframes ${name}{${frames.map(([t, tf, ease]) => `${f3(t * 100)}%{transform:${tf}${ease ? `;animation-timing-function:${ease}` : ''}}`).join('')}}`;
const T = ({ y = 0, sx = 1, sy = 1 }) => [y ? `translate(0px,${f2(y)}px)` : '', sx !== 1 || sy !== 1 ? `scale(${f3(sx)},${f3(sy)})` : ''].filter(Boolean).join(' ') || 'none';
const EASE = { io: 'cubic-bezier(.45,0,.55,1)', out: 'cubic-bezier(.2,.7,.4,1)', in: 'cubic-bezier(.6,0,.8,.3)', up: 'cubic-bezier(.33,.66,.66,1)', down: 'cubic-bezier(.33,0,.66,.33)', lin: 'linear' };

export function buildBanner(kind, buds) {
  const L = LAYOUTS[kind], R = rng(kind === 'desktop' ? 7 : 11);
  const { W, H } = L, cs = L.cell, cw = 6 * cs, lh = 10 * cs;
  const css = [], defs = [], layers = [];
  const pal = new Palette('x');
  const anim = (cls, name, frames, dur = LOOP, extra = '') => { css.push(`.${cls}{animation:${name} ${dur}s infinite${extra}}`, keyframes(name, frames)); };

  // ---- sky ------------------------------------------------------------------------------------------
  defs.push(`<linearGradient id="sky" x1="0" y1="0" x2="0" y2="${L.horizon}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#${PAL.skyTop}"/><stop offset=".55" stop-color="#${PAL.skyMid}"/><stop offset=".86" stop-color="#${PAL.skyLow}"/><stop offset="1" stop-color="#${PAL.haze}"/></linearGradient>`);
  defs.push(`<radialGradient id="glow" cx="${L.sun.x}" cy="${L.sun.y}" r="${L.sun.r * 5}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff7c2" stop-opacity=".95"/><stop offset=".25" stop-color="#ffe38a" stop-opacity=".5"/><stop offset="1" stop-color="#ffd0f0" stop-opacity="0"/></radialGradient>`);
  layers.push(`<rect width="${W}" height="${L.meadowTop + 10}" fill="url(#sky)"/>`, `<rect width="${W}" height="${L.meadowTop}" fill="url(#glow)"/>`);
  // sky glyphs: sparse, jittered specks, a little denser toward the horizon, none around the sun
  {
    const cells = [], rows = Math.floor(L.horizon / lh), cols = Math.ceil(W / cw), specks = ".'`.:'+";
    const top = parseHex(PAL.skyTop), mid = parseHex(PAL.skyMid), low = parseHex(PAL.skyLow);
    for (let r = 0; r < rows; r++) {
      const t = (r + 0.5) / rows, band = Math.round(t * 5) / 5, base = band < 0.55 ? mix(top, mid, band / 0.55) : mix(mid, low, (band - 0.55) / 0.45);
      const k = [pal.cls(mix(base, [255, 255, 255], 0.45)), pal.cls(mix(base, [255, 255, 255], 0.7))];
      for (let c = 0; c < cols; c++) {
        const n = R(), m = R(), x = c * cw, y = r * lh;
        if (Math.hypot(x - L.sun.x, y - L.sun.y) < L.sun.r * 2.6) continue;
        if (n > 0.07 + 0.13 * t * t) continue;
        cells.push({ r, c, ch: specks[Math.floor(m * specks.length)], k: k[m < 0.8 ? 0 : 1] });
      }
    }
    layers.push(`<g class="sky">${rowsSvg(cells, { cw, lh, base: 8 * cs })}</g>`);
  }
  // ---- rainbow: six bands of tangent-rotated glyphs over a soft white glow ----------------------------
  {
    const { cx, cy, r: R0, band, op } = L.rainbow, cols6 = ['ff4f7b', 'ff9a3c', 'ffe14a', '6fe85a', '4fd2ff', 'b77bff'], out = [];
    out.push(`<path d="M${cx - R0 + band * 3} ${cy}A${R0 - band * 3} ${R0 - band * 3} 0 0 1 ${cx + R0 - band * 3} ${cy}" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width="${band * 6 + 8}"/>`);
    cols6.forEach((h, i) => {
      const r = R0 - band * (i + 0.5), n = Math.round((Math.PI * r) / 6.4), xs = [], ys = [], rot = [];
      // a translucent band of the same colour under the glyphs (the cheap stand-in for a glyph halo)
      out.push(`<path d="M${f1(cx - r)} ${cy}A${f1(r)} ${f1(r)} 0 0 1 ${f1(cx + r)} ${cy}" fill="none" stroke="#${h}" stroke-opacity=".42" stroke-width="${band + 0.6}"/>`);
      let txt = '';
      for (let j = 0; j <= n; j++) {
        const a = Math.PI + (j / n) * Math.PI, gx = cx + Math.cos(a) * r, gy = cy + Math.sin(a) * r;
        if (gy > L.horizon + 6) continue;
        const deg = (a * 180) / Math.PI + 90; // tangent
        // put the glyph's centre (3, -3.5 from its baseline origin, in its own rotated frame) on the arc
        const th = (deg * Math.PI) / 180, ox = 3 * Math.cos(th) + 3.5 * Math.sin(th), oy = 3 * Math.sin(th) - 3.5 * Math.cos(th);
        xs.push(f1(gx - ox)); ys.push(f1(gy - oy));
        rot.push(Math.round(deg)); txt += '=#'[(j + i) % 2];
      }
      out.push(`<text x="${xs.join(' ')}" y="${ys.join(' ')}" rotate="${rot.join(' ')}" class="${pal.cls(parseHex(h))}">${esc(txt)}</text>`);
    });
    layers.push(`<g class="rb" opacity="${op}">${out.join('')}</g>`);
    // a glint that slides along the rainbow once a loop (a rotation about the rainbow's centre)
    const gr = R0 - band * 3, a0 = Math.asin(Math.min(1, (cy - L.horizon) / gr)) * 180 / Math.PI; // where the arc meets the hills
    anim('rg', 'rg', [[0, `rotate(${f1(a0)}deg)`, EASE.lin], [0.06, `rotate(${f1(a0)}deg)`, EASE.io], [0.42, `rotate(${f1(180 - a0)}deg)`, EASE.lin], [1, `rotate(${f1(180 - a0)}deg)`]]);
    anim('rgo', 'rgo', [[0, 'scale(0)', EASE.lin], [0.06, 'scale(0)', EASE.out], [0.1, 'scale(1)', EASE.lin], [0.37, 'scale(1)', EASE.in], [0.42, 'scale(0)', EASE.lin], [1, 'scale(0)']]);
    css.push('.rgs text{stroke-width:7px;stroke-opacity:.55}');
    layers.push(`<g transform="translate(${cx} ${cy})"><g class="rg"><g transform="translate(${-gr} 0)"><g class="rgo"><g class="rgs" transform="rotate(-90)"><text x="-5.5" y="6" style="font-size:17px" class="${pal.cls([255, 255, 255])}">*</text><text x="-3" y="4" class="${pal.cls([255, 246, 160])}">+</text></g></g></g></g></g>`);
  }
  // ---- sun -----------------------------------------------------------------------------------------
  {
    const { x, y, r } = L.sun, img = sunImage(64);
    const sp = spriteOf(img, Math.max(10, Math.round((r * 2) / (6 * 0.62)))), s = (r * 2) / sp.W;
    classify([sp.cells], pal, 10, { chroma: 1.1, lift: 1 });
    // rays: 12 spokes of glyphs, long and short, rotating slowly
    const rays = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2, long = i % 2 === 0, ch = ['|', '/', '-', '\\'][Math.round(((a + Math.PI / 2) / Math.PI) * 4) % 4];
      for (let j = 0; j < (long ? 3 : 2); j++) {
        const d = r * 1.38 + j * 12, gx = Math.cos(a) * d, gy = Math.sin(a) * d;
        rays.push(`<text x="${f1(gx - 4.5)}" y="${f1(gy + 5.5)}" style="font-size:15px" class="${pal.cls(mix([255, 226, 80], [255, 150, 40], j / 3))}">${esc(ch)}</text>`);
      }
    }
    css.push('.sun text{stroke-width:5px;stroke-opacity:.35}.rays text{stroke-width:6px;stroke-opacity:.45}');
    anim('rays', 'rays', [[0, 'rotate(0deg)', EASE.lin], [1, 'rotate(60deg)']], 40);
    anim('pulse', 'pulse', [[0, 'scale(1)', EASE.io], [0.5, 'scale(1.06)', EASE.io], [1, 'scale(1)']], 5);
    layers.push(`<g class="sun" transform="translate(${x} ${y})"><g class="rays">${rays.join('')}</g><g class="pulse"><g transform="scale(${f3(s)}) translate(${f1(-sp.W / 2)} ${f1(-sp.H / 2)})">${rowsSvg(sp.cells)}</g></g></g>`);
  }
  // ---- clouds (two parallax layers, each tiled twice for the wrap) -------------------------------------
  // Each cloud is a white puff (its silhouette) shaded with glyphs: none on the sunlit top, ( ) _ along the
  // outline, denser round glyphs in the shadow underneath, lavender to pink toward the base.
  const CLOUD_RAMP = ' .:ooO@', CLOUD_GLYPHS = glyphTable([...' .,:;\'`_()oO@']), cloudInk = [[160, 184, 255], [186, 174, 255], [246, 168, 226]];
  for (const [layer, list, dur, op] of [['far', L.clouds.far, 60, 0.9], ['near', L.clouds.near, 30, 1]]) {
    const parts = list.map(([cx, cy, cwid], i) => {
      const img = cloudImage((layer === 'far' ? 100 : 200) + i * 17, { w: 220, h: 90 });
      const sp = spriteOf(img, Math.round(cwid / (layer === 'far' ? 3.4 : 3.8)), { silhouette: true, ascii: { glyphs: CLOUD_GLYPHS, ramp: CLOUD_RAMP, lo: 0.1, hi: 0.95, gamma: 1, floor: 0, edge: 0.25, sharp: 0.3, minAlpha: 0.72, dither: 1 } });
      const s = cwid / sp.W;
      for (const c of sp.cells) { const t = c.r / Math.max(1, sp.rows - 1); c.k = pal.cls(t < 0.5 ? cloudInk[0] : t < 0.8 ? cloudInk[1] : cloudInk[2]); }
      return `<g transform="translate(${cx} ${cy}) scale(${f3(s)})"><path d="${sp.sil}" fill="#fff" stroke="#e3ecff" stroke-width="${f1(2.4 / s)}" stroke-linejoin="round" paint-order="stroke"/>${rowsSvg(sp.cells)}</g>`;
    }).join('');
    defs.push(`<g id="cl-${layer}">${parts}</g>`);
    anim(`cl-${layer}`, `cl-${layer}`, [[0, 'translateX(0px)', EASE.lin], [1, `translateX(${-W}px)`]], dur);
    layers.push(`<g opacity="${op}"><g class="cl-${layer}"><use href="#cl-${layer}"/><use href="#cl-${layer}" x="${W}"/></g></g>`);
  }
  // ---- hills -----------------------------------------------------------------------------------------
  const hill = (seed, base, amp, [cTop, cBot], glyphs, halo) => {
    const H2 = rng(seed), ph = [H2() * 6, H2() * 6, H2() * 6];
    const ridge = (x) => base - amp * (0.55 * Math.sin(x / W * Math.PI * 2.2 + ph[0]) * 0.5 + 0.5 * (0.6 + 0.4 * Math.sin(x / W * Math.PI * 5.3 + ph[1])) + 0.15 * Math.sin(x / W * Math.PI * 13 + ph[2]));
    let d = `M0 ${H}`; for (let x = 0; x <= W; x += 10) d += `L${x} ${f1(ridge(x))}`; d += `L${W} ${H}z`;
    const top = parseHex(cTop), bot = parseHex(cBot), cells = [];
    for (let c = 0; c < Math.ceil(W / cw); c++) {
      const yr = ridge(c * cw + cw / 2);
      for (let r = Math.ceil((yr - 2) / lh); r * lh < L.meadowTop + 12; r++) {
        const depth = r * lh - yr, t = Math.max(0, Math.min(1, depth / 40)), n = H2();
        const ch = depth < 6 ? (n < 0.5 ? '^' : n < 0.8 ? '~' : 'n') : glyphs[Math.floor(n * glyphs.length)];
        cells.push({ r, c, ch, k: pal.cls(mix(mix(top, [255, 255, 255], 0.3 * (1 - t)), bot, t * 0.6)) });
      }
    }
    return `<path d="${d}" fill="#${cBot}"/><g class="${halo}">${rowsSvg(cells, { cw, lh, base: 8 * cs })}</g>`;
  };
  layers.push(hill(31, L.horizon + 4, 30, PAL.hillFar, ".:'^-", 'hl'));
  layers.push(hill(47, L.meadowTop + 4, 18, PAL.hillNear, ".,:;'", 'hl'));
  // ---- meadow ----------------------------------------------------------------------------------------
  {
    defs.push(`<linearGradient id="mdw" x1="0" y1="${L.meadowTop}" x2="0" y2="${H}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#${PAL.meadow[0]}"/><stop offset=".55" stop-color="#${PAL.meadow[1]}"/><stop offset="1" stop-color="#${PAL.meadow[2]}"/></linearGradient>`);
    const M = rng(91);
    let d = `M0 ${H}L0 ${L.meadowTop + 6}`; for (let x = 0; x <= W; x += 20) d += `L${x} ${f1(L.meadowTop + 4 + 3 * Math.sin(x / 70))}`; d += `L${W} ${H}z`;
    const cells = [], gl = ",'\"`;v";
    for (let r = Math.floor(L.meadowTop / lh); r * lh < H; r++) for (let c = 0; c < Math.ceil(W / cw); c++) {
      const n = M(); if (n < 0.3) continue;
      const t = (r * lh - L.meadowTop) / (H - L.meadowTop), gi = Math.floor(M() * PAL.grass.length);
      const col = mix(parseHex(PAL.grass[gi]), parseHex(PAL.meadow[2]), 0.15 + 0.35 * t);
      cells.push({ r, c, ch: gl[Math.floor(M() * gl.length)], k: pal.cls(col) });
    }
    layers.push(`<path d="${d}" fill="url(#mdw)"/><g class="md">${rowsSvg(cells, { cw, lh, base: 8 * cs })}</g>`);
  }
  // meadow flowers: classic ASCII flowers, a bold @ * or o head (its thick halo is the petals, the glyph
  // itself the centre) on a | stem with a leaf; each sways on its stem
  const centreCls = new Map();
  const centre = (h) => { if (!centreCls.has(h)) { const n = `xf${centreCls.size}`; centreCls.set(h, n); css.push(`.${n}{fill:#${h}}`); } return centreCls.get(h); };
  const flowerGroup = (n, yMin, yMax, sizeMin, sizeMax, seed, cls) => {
    const F = rng(seed), out = [];
    for (let i = 0; i < n; i++) {
      const x = (i + 0.2 + F() * 0.6) * (W / n), y = yMin + F() * (yMax - yMin), size = sizeMin + F() * (sizeMax - sizeMin);
      const [petal, mid] = PAL.flowers[Math.floor(F() * PAL.flowers.length)], head = '****oo'[Math.floor(F() * 6)];
      const stem = Math.round(size * 1.1), segs = Math.max(1, Math.round(stem / 8)), green = pal.cls(parseHex('1f9e3e')), leaf = pal.cls(parseHex('5be35a'));
      const g = [];
      for (let k = 0; k < segs; k++) g.push(`<text x="-3" y="${f1(-k * 8 - 2)}" class="${green}">|</text>`);
      g.push(`<text x="${F() < 0.5 ? -7 : 1}" y="${f1(-stem * 0.45)}" class="${leaf}">${F() < 0.5 ? '\\' : '/'}</text>`);
      g.push(`<text x="${f1(-size * 0.3)}" y="${f1(-stem + size * 0.36)}" style="font-size:${f1(size)}px;stroke-width:${f1(size * (head === '*' ? 0.3 : 0.4))}px" class="fh ${pal.cls(parseHex(petal))} ${centre(mid)}">${esc(head)}</text>`);
      out.push(`<g transform="translate(${f1(x)} ${f1(y)})"><g class="${cls}" style="animation-delay:${f2(-F() * 4)}s">${g.join('')}</g></g>`);
    }
    return out.join('');
  };
  css.push('.fh{stroke-opacity:1!important}');
  css.push('.fl text,.ff text{stroke-width:6px;stroke-opacity:.45}');
  anim('fl', 'fl', [[0, 'rotate(-5deg)', EASE.io], [0.5, 'rotate(5deg)', EASE.io], [1, 'rotate(-5deg)']], 5);
  layers.push(flowerGroup(L.flowers, L.meadowTop + 16, L.meadowTop + 44, 10, 14, 5, 'fl'));

  // ---- Buds ------------------------------------------------------------------------------------------
  // No stroked glyphs on the Buds: a stroked glyph is rasterised as a path every frame (with GPU raster, the
  // haloed version ran at ~7 fps vs ~50 without). The colour between glyphs comes from a cell mosaic instead:
  // one path per colour under the glyphs (ANSI style: every cell has a background and a foreground colour).
  const mosaic = (cells, bgOf) => {
    const byCol = new Map();
    for (const c of cells) { if (c.cover < 0.9) continue; const h = bgOf(c); if (!byCol.has(h)) byCol.set(h, []); byCol.get(h).push(c); }
    return [...byCol].map(([h, list]) => {
      list.sort((a, b) => a.r - b.r || a.c - b.c);
      let d = '';
      for (let i = 0; i < list.length;) { let j = i; while (j + 1 < list.length && list[j + 1].r === list[i].r && list[j + 1].c === list[j].c + 1) j++; const w = (j - i + 1) * 6 + 0.8; d += `M${f1(list[i].c * 6 - 0.4)} ${f1(list[i].r * 10 - 0.4)}h${f1(w)}v10.8h${f1(-w)}z`; i = j + 1; }
      return `<path d="${d}" fill="#${h}"/>`;
    }).join('');
  };
  const budSvg = {}, contact = {};
  const SPEC = { sprout: { k: 30, shift: [85, 135, 16] }, ash: { k: 30 }, pearl: { k: 30 } };
  for (const name of ['sprout', 'ash', 'pearl']) {
    const B = L.buds[name], sp = budSprite(name, buds[name], { cols: B.cols, ascii: { dither: 0.6 } });
    const bp = new Palette(name[0].toUpperCase());
    classify(Object.values(sp.cells), bp, SPEC[name].k, { chroma: 1.45, lift: 0.92, shift: SPEC[name].shift });
    for (const c of Object.values(sp.cells).flat()) if (c.fix) c.k = bp.cls(c.fix); // eye glyphs keep their own colour
    css.push(bp.css());
    const bgCache = new Map(), bgOf = (c) => { if (!bgCache.has(c.k)) { const [L0, C1, h1] = lch(parseHex(bp.hexOf(c.k))); bgCache.set(c.k, hex(fromLch(L0 * MOSAIC_L, C1 * 1.05, h1))); } return bgCache.get(c.k); };
    const s = B.h / sp.H;
    const ox = -sp.W / 2, oy = -sp.H; // sprite origin at the feet centre
    // backing: a deep, saturated tone of the Bud's own colour (so the gaps between glyphs stay candy, and dark
    // pupils still read), edged with a thin dark outline of ~1.1 viewBox units
    const all = Object.values(sp.cells).flat(), wsum = all.reduce((t, c) => t + c.ink, 0);
    const avg = [0, 1, 2].map((i) => all.reduce((t, c) => t + c.boosted[i] * c.ink, 0) / wsum), [, C0, h0] = lch(avg);
    const deep = hex(fromLch(0.3, Math.min(0.15, C0), h0)), ow = 1.1 / s;
    const sil = (id) => `<path d="${sp.sil[id]}" fill="#${deep}" stroke="#${sp.spec.outline}" stroke-width="${f1(ow * 2)}" stroke-linejoin="round" paint-order="stroke"/>`;
    const txt = (cells) => mosaic(cells, bgOf) + rowsSvg(cells);
    const part = (id, cls) => { const [px, py] = sp.pivots[id]; return `<g transform="translate(${f1(px)} ${f1(py)})"><g class="${cls}"><g transform="translate(${f1(-px)} ${f1(-py)})">${sil(id)}${txt(sp.cells[id])}</g></g></g>`; };
    const parts = sp.spec.parts.map((p) => part(p.id, `${name[0]}${p.id}`));
    // wings go behind the body, tail behind, leaf on top
    const behind = name === 'sprout' ? '' : parts.join(''), front = name === 'sprout' ? parts.join('') : '';
    const body = `${sil('body')}${txt(sp.cells.body)}<g class="${name[0]}eo">${txt(sp.cells.eyeOpen)}</g><g class="${name[0]}es">${txt(sp.cells.eyeShut)}</g>`;
    budSvg[name] = { s, B, sp, inner: `<g transform="scale(${f3(s)}) translate(${f1(ox)} ${f1(oy)})">${behind}${body}${front}</g>` };
    // head-top contact point for the ball, in viewBox units (at rest)
    const headTop = { sprout: 0.085, ash: 0.04, pearl: 0.0 }[name], headX = { sprout: 0.0, ash: 0.0, pearl: -0.13 }[name];
    contact[name] = { x: B.x + headX * sp.W * s, y: B.y - sp.H * s * (1 - headTop) };
  }
  // ---- choreography ----------------------------------------------------------------------------------
  // The ball goes Sprout -> Ash -> Pearl -> Ash -> Sprout, one hop each 2.5 s; each Bud bops it with its head.
  const HOP = 17, br = L.ball.r;
  const seq = [['sprout', 0], ['ash', 0.25], ['pearl', 0.5], ['ash', 0.75], ['sprout', 1]];
  const hit = (name) => ({ x: contact[name].x, y: contact[name].y - (name === 'ash' ? 10 : HOP) - br * 0.9 });
  const apex = Math.max(br + 6, 16);
  // the ball's resting place (also the reduced-motion still): balanced on Ash's head
  const ball0 = { x: contact.ash.x, y: contact.ash.y - br * 0.92 };
  {
    const xs = seq.map(([n, t]) => [t, `translateX(${f1(hit(n).x - ball0.x)}px)`, EASE.lin]);
    const ys = [];
    seq.forEach(([n, t], i) => { ys.push([t, `translateY(${f1(hit(n).y - ball0.y)}px)`, EASE.up]); if (i < seq.length - 1) ys.push([t + 0.125, `translateY(${f1(apex - ball0.y)}px)`, EASE.down]); });
    anim('bx', 'bx', xs); anim('by', 'by', ys);
    anim('bs', 'bs', [[0, 'rotate(0deg)', EASE.lin], [1, 'rotate(720deg)']], 5);
    const img = ballImage(48), sp = spriteOf(img, L.ball.cols, { silhouette: true, ascii: { floor: 0.45, lo: 0.05, hi: 0.8 } }), s = (br * 2) / sp.W;
    classify([sp.cells], pal, 10, { chroma: 1.25, lift: 0.95 });
    css.push('.ball text{stroke-width:6px;stroke-opacity:.35}');
    var ballSvg = `<g transform="translate(${f1(ball0.x)} ${f1(ball0.y)})"><g class="bx"><g class="by"><g class="bs"><g class="ball" transform="scale(${f3(s)}) translate(${f1(-sp.W / 2)} ${f1(-sp.H / 2)})"><path d="${sp.sil}" fill="#3a0d2e" stroke="#2a0a3e" stroke-width="${f1(1.0 / s * 2)}" stroke-linejoin="round" paint-order="stroke"/>${rowsSvg(sp.cells)}</g></g></g></g></g>`;
  }
  // per-Bud body motion: bop at its contact times, gentle breathing between
  const bop = (t0, hop) => {
    // keyframes around a contact at t0 (fractions of the loop): squash, launch, peak at contact, land, settle
    const k = (dt) => t0 + dt / LOOP;
    return [[k(-0.55), { sx: 1, sy: 1 }, EASE.io], [k(-0.3), { sx: 1.07, sy: 0.9 }, EASE.out], [k(0), { y: -hop, sx: 0.96, sy: 1.06 }, EASE.in], [k(0.36), { sx: 1.08, sy: 0.9 }, EASE.out], [k(0.62), { sx: 0.98, sy: 1.025 }, EASE.io], [k(0.85), { sx: 1, sy: 1 }, EASE.io]];
  };
  const breathe = (a, b) => [[a, { sx: 1, sy: 1 }, EASE.io], [(a + b) / 2, { sx: 1.012, sy: 0.988 }, EASE.io]];
  const norm = (frames) => {
    // wrap times into [0,1), sort, and close the loop with a copy of the first frame at 100%
    const fr = frames.map(([t, v, e]) => [((t % 1) + 1) % 1, v, e]).sort((a, b) => a[0] - b[0]);
    if (fr[0][0] !== 0) { const last = fr[fr.length - 1]; fr.unshift([0, last[1], last[2]]); }
    fr.push([1, fr[0][1]]);
    return fr.map(([t, v, e]) => [t, T(v), e]);
  };
  anim('sh', 'sh', norm([...bop(0, HOP), ...breathe(0.12, 0.5), ...breathe(0.5, 0.9)]));
  anim('ph', 'ph', norm([...bop(0.5, HOP), ...breathe(0.62, 0.98), ...breathe(0.02, 0.4)]));
  // Ash hovers: a slow bob, rising to meet the ball at 25% and 75%
  const ashBob = (t0) => [[t0 - 0.11, { y: 8, sx: 1.03, sy: 0.97 }, EASE.io], [t0, { y: -10, sx: 0.98, sy: 1.03 }, EASE.out], [t0 + 0.12, { y: 0 }, EASE.io]];
  anim('ah', 'ah', norm([...ashBob(0.25), ...ashBob(0.75)]));
  // everyone leans toward the ball and follows it with their eyes (a slow rotation about the feet / hover point)
  const ballX = (t) => { t = ((t % 1) + 1) % 1; let i = 0; while (t > seq[i + 1][1]) i++; const [[n0, t0], [n1, t1]] = [seq[i], seq[i + 1]]; return hit(n0).x + (hit(n1).x - hit(n0).x) * ((t - t0) / (t1 - t0)); };
  const lean = (name, deg, lag = 0.025) => { const fr = []; for (let i = 0; i <= 20; i++) { const t = i / 20; fr.push([t, `rotate(${f2(deg * Math.tanh((ballX(t - lag) - L.buds[name].x) / 260))}deg)`, EASE.io]); } fr[20][1] = fr[0][1]; return fr; };
  anim('sl', 'sl', lean('sprout', 4)); anim('al', 'al', lean('ash', 5)); anim('pl', 'pl', lean('pearl', 4));
  // shadows follow the height
  const shadow = (frames) => norm(frames.map(([t, v, e]) => [t, { sx: 1 - Math.max(0, -(v.y || 0)) / 40, sy: 1 - Math.max(0, -(v.y || 0)) / 40 }, e]));
  anim('ss', 'ss', shadow([...bop(0, HOP)])); anim('ps', 'ps', shadow([...bop(0.5, HOP)]));
  anim('as', 'as', norm([[0.14, { sx: 0.82, sy: 0.82 }, EASE.io], [0.25, { sx: 1.05, sy: 1.05 }, EASE.io], [0.37, { sx: 0.95, sy: 0.95 }, EASE.io], [0.64, { sx: 0.82, sy: 0.82 }, EASE.io], [0.75, { sx: 1.05, sy: 1.05 }, EASE.io], [0.87, { sx: 0.95, sy: 0.95 }, EASE.io]]));
  // parts: Ash flaps, Pearl's tail swishes, Sprout's leaf wiggles
  anim('awl', 'awl', [[0, 'rotate(-8deg)', EASE.io], [0.5, 'rotate(16deg)', EASE.io], [1, 'rotate(-8deg)']], 0.625);
  anim('awr', 'awr', [[0, 'rotate(8deg)', EASE.io], [0.5, 'rotate(-16deg)', EASE.io], [1, 'rotate(8deg)']], 0.625);
  anim('ptl', 'ptl', [[0, 'rotate(-6deg)', EASE.io], [0.5, 'rotate(7deg)', EASE.io], [1, 'rotate(-6deg)']], 1.25);
  anim('slf', 'slf', [[0, 'rotate(-9deg)', EASE.io], [0.5, 'rotate(9deg)', EASE.io], [1, 'rotate(-9deg)']], 2.5);
  // blinks (step-end opacity swaps on the eye cells)
  const blink = (p, times) => {
    const shut = `@keyframes ${p}es{0%{opacity:0}${times.map((t) => `${f3(t * 100)}%{opacity:1}${f3((t + 0.016) * 100)}%{opacity:0}`).join('')}100%{opacity:0}}`;
    const open = `@keyframes ${p}eo{0%{opacity:1}${times.map((t) => `${f3(t * 100)}%{opacity:0}${f3((t + 0.016) * 100)}%{opacity:1}`).join('')}100%{opacity:1}}`;
    css.push(`.${p}es{opacity:0;animation:${p}es ${LOOP}s infinite step-end}.${p}eo{animation:${p}eo ${LOOP}s infinite step-end}`, shut, open);
  };
  blink('s', [0.33, 0.37]); blink('a', [0.56]); blink('p', [0.82, 0.12]);

  const budGroup = (name, hopCls, shCls, leanCls) => {
    const { B, inner } = budSvg[name], wide = { sprout: 0.36, ash: 0.3, pearl: 0.42 }[name] * B.h;
    const shY = name === 'ash' ? L.ashShadow : B.y - 3;
    return `<g transform="translate(${f1(B.x)} ${f1(shY)})"><g class="${shCls}"><ellipse rx="${f1(wide)}" ry="${f1(wide * 0.16)}" fill="#0a5a2a" opacity=".38"/></g></g>`
      + `<g class="bd" transform="translate(${f1(B.x)} ${f1(B.y)})"><g class="${hopCls}"><g class="${leanCls}">${inner}</g></g></g>`;
  };
  layers.push(budGroup('ash', 'ah', 'as', 'al'), budGroup('sprout', 'sh', 'ss', 'sl'), budGroup('pearl', 'ph', 'ps', 'pl'));
  layers.push(ballSvg);
  // bop sparkles: a star burst at each contact
  {
    const burst = (name, t0, i) => {
      const p = hit(name), id = `bz${i}`;
      const st = f3(t0 * 100), a = f3(Math.max(0, t0 * 100 - 0.01)), e = f3(Math.min(100, t0 * 100 + 6));
      css.push(`.${id}{animation:${id} ${LOOP}s infinite}@keyframes ${id}{0%{transform:scale(.2);opacity:0}${a}%{transform:scale(.2);opacity:0;animation-timing-function:${EASE.out}}${st}%{transform:scale(.4);opacity:1;animation-timing-function:${EASE.out}}${e}%{transform:scale(1.5);opacity:0}100%{transform:scale(1.5);opacity:0}}`);
      const g = [];
      for (let j = 0; j < 8; j++) { const ang = (j / 8) * Math.PI * 2 + 0.3, d = br * 1.9; g.push(`<text x="${f1(Math.cos(ang) * d - 3)}" y="${f1(Math.sin(ang) * d + 4)}" class="${pal.cls(j % 2 ? [255, 240, 120] : [255, 255, 255])}">${j % 2 ? '+' : '*'}</text>`); }
      return `<g transform="translate(${f1(p.x)} ${f1(p.y)})"><g class="${id} bzz">${g.join('')}</g></g>`;
    };
    css.push('.bz text{stroke-width:5px;stroke-opacity:.4}');
    layers.push(`<g class="bz">${seq.slice(0, 4).map(([n, t], i) => burst(n, t === 0 ? 0.0005 : t, i)).join('')}</g>`);
  }
  // ---- front grass + flowers ---------------------------------------------------------------------------
  {
    const G = rng(123), out = [];
    for (let i = 0; i < L.front; i++) {
      const x = (i + G()) * (W / L.front), y = H + 2, hgt = 18 + G() * 16, n = 2 + Math.floor(G() * 3), blades = [];
      for (let j = 0; j < n; j++) {
        const lean = (j - (n - 1) / 2) * 0.35 + (G() - 0.5) * 0.3, segs = Math.max(2, Math.round(hgt / 9));
        for (let k = 0; k < segs; k++) {
          const t = (k + 0.5) / segs, bx = lean * hgt * t * t * 0.9 + (j - (n - 1) / 2) * 3, by = -t * hgt;
          const slope = lean * 2 * t; const ch = Math.abs(slope) < 0.25 ? '|' : slope > 0 ? '/' : '\\';
          blades.push(`<text x="${f1(bx - 3)}" y="${f1(by + 5)}" class="${pal.cls(mix(parseHex(PAL.grass[(i + j) % 3]), [20, 120, 50], 0.45 * (1 - t)))}">${esc(ch)}</text>`);
        }
      }
      const delay = f2(-(x / W) * 2.5 - G() * 0.4);
      out.push(`<g transform="translate(${f1(x)} ${f1(y)})"><g class="gs" style="animation-delay:${delay}s">${blades.join('')}</g></g>`);
    }
    anim('gs', 'gs', [[0, 'skewX(-7deg)', EASE.io], [0.5, 'skewX(9deg)', EASE.io], [1, 'skewX(-7deg)']], 2.5);
    layers.push(`<g class="fg">${out.join('')}</g>`);
    anim('ff', 'ff', [[0, 'rotate(-7deg)', EASE.io], [0.5, 'rotate(6deg)', EASE.io], [1, 'rotate(-7deg)']], 2.5);
    layers.push(flowerGroup(Math.round(L.front / 3), H - 6, H - 1, 16, 22, 9, 'ff'));
  }
  // ---- butterflies -----------------------------------------------------------------------------------
  {
    const paths = kind === 'desktop'
      ? [[{ x: 425, y: 196 }, 55, 26, 0], [{ x: 765, y: 168 }, 55, 22, 3.3], [{ x: 1104, y: 206 }, 42, 20, 6.6]]
      : [[{ x: 214, y: 150 }, 20, 14, 0], [{ x: 612, y: 196 }, 14, 16, 5]];
    const out = [];
    paths.forEach(([p, ax, ay, delay], i) => {
      const [c1, c2] = PAL.butterflies[i % 3], k1 = `bw ${pal.cls(parseHex(c1))} ${centre(hex(mix(parseHex(c1), [255, 255, 255], 0.55)))}`, k2 = `bw ${pal.cls(parseHex(c2))} ${centre(hex(mix(parseHex(c2), [255, 255, 255], 0.5)))}`;
      const wing = `<text x=".4" y="1" style="font-size:13px" class="${k1}">D</text><text x=".8" y="8.6" style="font-size:9px" class="${k2}">D</text>`;
      out.push(`<g transform="translate(${p.x} ${p.y})"><g class="fx${i}"><g class="fy"><g transform="scale(${kind === 'desktop' ? 1.6 : 1.8})"><g class="fw"><g transform="scale(-1 1)">${wing}</g>${wing}</g><text x="-3" y="7" class="${pal.cls([58, 22, 70])}">|</text><text x="-3" y="-1" style="font-size:8px" class="${pal.cls([58, 22, 70])}">"</text></g></g></g></g>`);
      anim(`fx${i}`, `fx${i}`, [[0, `translate(${-ax}px,0px)`, EASE.io], [0.25, `translate(${-ax * 0.2}px,${-ay}px)`, EASE.io], [0.5, `translate(${ax}px,${-ay * 0.3}px)`, EASE.io], [0.75, `translate(${ax * 0.2}px,${ay * 0.6}px)`, EASE.io], [1, `translate(${-ax}px,0px)`]], LOOP, `;animation-delay:-${delay}s`);
    });
    anim('fy', 'fy', [[0, 'translateY(0px)', EASE.io], [0.5, 'translateY(-5px)', EASE.io], [1, 'translateY(0px)']], 0.833);
    anim('fw', 'fw', [[0, 'scaleX(1)', EASE.io], [0.5, 'scaleX(.42)', EASE.io], [1, 'scaleX(1)']], 0.25);
    css.push('.bf text{stroke-width:2px;stroke-opacity:.5}.bf .bw{stroke-width:3px;stroke-opacity:1}');
    layers.push(`<g class="bf">${out.join('')}</g>`);
  }
  // ---- twinkles in the sky ---------------------------------------------------------------------------
  {
    const S = rng(77), out = [];
    const n = kind === 'desktop' ? 10 : 6;
    for (let i = 0; i < n; i++) {
      const x = 20 + S() * (W - 40), y = 12 + S() * (L.horizon - 70), ch = S() < 0.5 ? '*' : '+';
      out.push(`<g transform="translate(${f1(x)} ${f1(y)})"><g class="tw" style="animation-delay:${f2(-S() * 2.5)}s"><text x="-3" y="4" class="${pal.cls([255, 255, 255])}">${ch}</text></g></g>`);
    }
    anim('tw', 'tw', [[0, 'scale(.2) rotate(0deg)', EASE.io], [0.5, 'scale(1.1) rotate(45deg)', EASE.io], [1, 'scale(.2) rotate(90deg)']], 2.5);
    css.push('.tws text{stroke-width:4px;stroke-opacity:.5}');
    layers.splice(3, 0, `<g class="tws">${out.join('')}</g>`);
  }

  // ---- assemble --------------------------------------------------------------------------------------
  const style = [
    `text{font-family:${FONT};font-size:10px;font-weight:700;fill:currentColor;stroke:none;paint-order:stroke;stroke-linejoin:round}`,
    // halos (a soft stroke in the glyph's own colour) only on the few small sprites that need them
    '.rgs text,.sun text,.rays text,.fl text,.ff text,.ball text,.bz text,.bf text,.tws text{stroke:currentColor}',
    'tspan{fill:currentColor}',
    pal.css(),
    ...css,
    // the static look (no animation running) is the still frame: bursts and the rainbow glint hidden
    '.bzz{opacity:0}.rgo{transform:scale(0)}',
    '@media (prefers-reduced-motion:reduce){*{animation:none!important}}',
  ].join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Ash, Pearl and Sprout, the three SkyBuds, bouncing a beach ball between them under a rainbow in a flower meadow, drawn in colour ASCII">
<style>
${style}
</style>
<defs><clipPath id="card"><rect width="${W}" height="${H}" rx="${L.r}"/></clipPath>${defs.join('\n')}</defs>
<g clip-path="url(#card)">
${layers.join('\n')}
</g>
<rect x=".75" y=".75" width="${W - 1.5}" height="${H - 1.5}" rx="${L.r - 0.75}" fill="none" stroke="#${PAL.rim}" stroke-opacity=".55" stroke-width="1.5"/>
</svg>
`;
  return svg;
}

