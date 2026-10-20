// Silhouette paths: trace the boundary of a binary mask along pixel edges (inside on the left, so holes wind
// the other way and nonzero filling keeps them open), simplify with Douglas-Peucker, round the corners
// with one Chaikin pass, and write an SVG path in the caller's units.
export function traceLoops(inside, W, H) {
  const at = (x, y) => x >= 0 && y >= 0 && x < W && y < H && inside(x, y);
  const out = new Map(); // "x,y" -> [[x2,y2], ...]
  const add = (x1, y1, x2, y2) => { const k = x1 + ',' + y1; if (!out.has(k)) out.set(k, []); out.get(k).push([x2, y2]); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!at(x, y)) continue;
    if (!at(x, y - 1)) add(x + 1, y, x, y);         // top edge, walking left
    if (!at(x - 1, y)) add(x, y, x, y + 1);         // left edge, walking down
    if (!at(x, y + 1)) add(x, y + 1, x + 1, y + 1); // bottom edge, walking right
    if (!at(x + 1, y)) add(x + 1, y + 1, x + 1, y); // right edge, walking up
  }
  const loops = [];
  const keys = [...out.keys()].sort((a, b) => { const [ax, ay] = a.split(',').map(Number), [bx, by] = b.split(',').map(Number); return ay - by || ax - bx; });
  for (const k0 of keys) {
    while (out.get(k0)?.length) {
      const loop = []; let k = k0, prev = null;
      for (let guard = 0; guard < 1e6; guard++) {
        const list = out.get(k);
        const [x, y] = k.split(',').map(Number);
        let pick = 0;
        if (list.length > 1 && prev) { // at a pinch point, turn left of the incoming direction
          const dx = x - prev[0], dy = y - prev[1];
          pick = list.findIndex(([nx, ny]) => (nx - x) === dy && (ny - y) === -dx);
        }
        const [nx, ny] = list.splice(pick, 1)[0];
        loop.push([x, y]); prev = [x, y]; k = nx + ',' + ny;
        if (k === k0) break;
      }
      if (loop.length > 2) loops.push(loop);
    }
  }
  return loops;
}

function dp(pts, tol) {
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let best = -1, bd = tol;
    const [ax, ay] = pts[a], [bx, by] = pts[b], L = Math.hypot(bx - ax, by - ay);
    for (let i = a + 1; i < b; i++) { const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L; if (d > bd) { bd = d; best = i; } }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function simplifyClosed(loop, tol) {
  // split the ring at its two most distant points so DP works on open chains
  let far = 0, fd = -1; for (let i = 0; i < loop.length; i++) { const d = (loop[i][0] - loop[0][0]) ** 2 + (loop[i][1] - loop[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const a = dp(loop.slice(0, far + 1), tol), b = dp([...loop.slice(far), loop[0]], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}
const chaikin = (p) => p.flatMap((q, i) => { const r = p[(i + 1) % p.length]; return [[0.75 * q[0] + 0.25 * r[0], 0.75 * q[1] + 0.25 * r[1]], [0.25 * q[0] + 0.75 * r[0], 0.25 * q[1] + 0.75 * r[1]]]; });
const area = (p) => p.reduce((s, q, i) => { const r = p[(i + 1) % p.length]; return s + q[0] * r[1] - r[0] * q[1]; }, 0) / 2;

// mask -> path d. sx, sy scale a mask pixel to output units; ox, oy offset; minArea drops specks (in mask px).
export function maskPath(inside, W, H, { sx = 1, sy = 1, ox = 0, oy = 0, tol = 0.8, minArea = 6, smooth = 1, digits = 1 } = {}) {
  const f = (v) => +v.toFixed(digits);
  return traceLoops(inside, W, H).filter((l) => Math.abs(area(l)) >= minArea).map((l) => {
    let p = simplifyClosed(l, tol); for (let i = 0; i < smooth; i++) p = chaikin(p);
    p = p.map(([x, y]) => [f(ox + x * sx), f(oy + y * sy)]);
    let d = `M${p[0][0]} ${p[0][1]}`, [px, py] = p[0];
    for (let i = 1; i < p.length; i++) { const [x, y] = p[i]; d += `l${f(x - px)} ${f(y - py)}`; px = x; py = y; }
    return d + 'z';
  }).join('');
}
