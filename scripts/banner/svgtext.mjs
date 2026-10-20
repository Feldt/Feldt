// Glyph cells -> SVG <text> rows. Every glyph gets its own x (a per-character x list on the row), so no
// font's advance width can shift a glyph off its cell; a run of one colour class shares a <tspan>.
export const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// cells: [{r, c, ch, k}] (k = class name); cw/lh = cell size; base = baseline offset in the cell
export function rowsSvg(cells, { cw = 6, lh = 10, base = 8 } = {}) {
  const rows = new Map();
  for (const cell of cells) { if (!cell.ch || cell.ch === ' ') continue; if (!rows.has(cell.r)) rows.set(cell.r, []); rows.get(cell.r).push(cell); }
  const f = (v) => +v.toFixed(1);
  return [...rows.keys()].sort((a, b) => a - b).map((r) => {
    const row = rows.get(r).sort((a, b) => a.c - b.c);
    const xs = row.map((c) => f(c.c * cw)).join(' '), y = f(r * lh + base);
    const runs = [];
    for (const c of row) { const last = runs[runs.length - 1]; if (last && last.k === c.k) last.t += c.ch; else runs.push({ k: c.k, t: c.ch }); }
    if (runs.length === 1) return `<text x="${xs}" y="${y}" class="${runs[0].k}">${esc(runs[0].t)}</text>`;
    return `<text x="${xs}" y="${y}">${runs.map((u) => `<tspan class="${u.k}">${esc(u.t)}</tspan>`).join('')}</text>`;
  }).join('\n');
}
// short class names: a..z, then a0..z9 etc.
export function className(prefix, i) { const A = 'abcdefghijklmnopqrstuvwxyz0123456789'; let s = ''; do { s = A[i % 36] + s; i = Math.floor(i / 36) - 1; } while (i >= 0); return prefix + s; }
