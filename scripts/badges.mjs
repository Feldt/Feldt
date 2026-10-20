// badges.mjs: one small badge per PR for the README (Fred 10-20, after the tiles came off: "small badges for the
// open PRs", like the small social badges on a profile). A 28 px pill: GitHub's pull-request icon (merge icon once
// merged) in GitHub's state colour, then owner/repo #number in system monospace. One light and one dark file per PR;
// the README's <picture> picks one by GitHub's colour scheme. Text only, nothing loaded: inside GitHub's image CSP.
// Icons: Primer Octicons git-pull-request-16 and git-merge-16 (MIT, GitHub Inc.).

export const BADGE_H = 28;
const FONT = 12, ADV = 0.62, PAD = 11, ICON = 14, GAP = 6; // ADV: the widest advance in the font stack (SF Mono 0.618 em)
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";
export const THEMES = {
  light: { bg: '#f6f8fa', line: '#d1d9e0', text: '#1f2328', dim: '#59636e', open: '#1a7f37', merged: '#8250df' },
  dark: { bg: '#151b23', line: '#3d444d', text: '#f0f6fc', dim: '#9198a1', open: '#3fb950', merged: '#ab7df8' },
};
export const ICONS = {
  open: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  merged: 'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z',
};

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// the two files of a PR's badge, named like its tile (owner--repo can't collide: owners never hold "--")
export const badgeOf = (repo, number) => {
  const base = `dist/badges/${repo.replace('/', '--').toLowerCase()}-${number}`;
  return { light: `${base}-light.svg`, dark: `${base}-dark.svg` };
};

// the badge's width: both paddings, the icon and the text at the widest advance, so no font in the stack clips it
export const badgeWidth = (p) => PAD + ICON + GAP + Math.ceil(`${p.repo} #${p.number}`.length * FONT * ADV) + PAD;

export function badgeSvg(p, theme) {
  const t = THEMES[theme], w = badgeWidth(p), [owner, name] = p.repo.split('/');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${BADGE_H}" viewBox="0 0 ${w} ${BADGE_H}">`
    + `<rect x="0.5" y="0.5" width="${w - 1}" height="${BADGE_H - 1}" rx="${(BADGE_H - 1) / 2}" fill="${t.bg}" stroke="${t.line}"/>`
    + `<path transform="translate(${PAD} ${(BADGE_H - ICON) / 2}) scale(${ICON / 16})" fill="${t[p.state]}" d="${ICONS[p.state]}"/>`
    + `<text x="${PAD + ICON + GAP}" y="18" font-family="${MONO}" font-size="${FONT}">`
    + `<tspan fill="${t.dim}">${esc(owner)}/</tspan><tspan fill="${t.text}" font-weight="600">${esc(name)}</tspan><tspan fill="${t.dim}"> #${p.number}</tspan>`
    + '</text></svg>\n';
}

// { path: body } for every PR's two badge files
export const badgeFiles = (prs) => Object.fromEntries(prs.flatMap((p) => Object.entries(badgeOf(p.repo, p.number)).map(([theme, f]) => [f, badgeSvg(p, theme)])));

// one README line per badge: a link to the PR around a <picture> that shows the dark file under the dark scheme
export function badgeLine(p) {
  const f = badgeOf(p.repo, p.number), alt = `${p.state === 'merged' ? 'Merged' : 'Open'} PR ${p.repo}#${p.number}: ${p.title}`;
  return `<a href="${esc(p.url)}"><picture><source media="(prefers-color-scheme: dark)" srcset="${f.dark}"><img src="${f.light}" alt="${esc(alt)}" height="${BADGE_H}"></picture></a>`;
}

// the README's badge row, newest PR first; none without PRs
export const badgeBlock = (prs) => (prs.length ? ['<p>', ...[...prs].reverse().map(badgeLine), '</p>', ''] : []);
