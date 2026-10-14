import { closestOnSegment } from './geo';
import type { OverheadSpan, Prop, Vec2 } from './types';

/**
 * Shortest and longest span between two pylons of one line (m). Parallel
 * lines run 30–60 m apart, so nothing shorter than MIN_SPAN joins them;
 * high-voltage spans in Turkey are 250–450 m.
 */
const MIN_SPAN = 120;
const MAX_SPAN = 560;
/** Most a line turns at a pylon (angle towers): 40°. */
const MAX_TURN_COS = Math.cos((40 * Math.PI) / 180);
/** A span passing this close to another pylon skips it: that pylon belongs on the line. */
const SKIP_CLEARANCE = 25;

/**
 * Overhead lines from the pylons alone, where the data has no line geometry:
 * each pylon is joined to at most two others, nearest first, so that the
 * line runs on nearly straight (≤ 40° at a pylon), never across to a parallel
 * line and never over another pylon. The pylons are turned to face along
 * their line (cross-arms across it).
 */
export function overheadSpans(pylons: Prop[]): OverheadSpan[] {
  const n = pylons.length;
  if (n < 2) return [];
  const at = (i: number): Vec2 => [pylons[i].position[0], pylons[i].position[1]];
  // Neighbours within reach, through a coarse grid.
  const cell = MAX_SPAN;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  pylons.forEach((p, i) => {
    const k = key(p.position[0], p.position[1]);
    const list = grid.get(k) ?? [];
    list.push(i);
    grid.set(k, list);
  });
  const near = (p: Vec2) => {
    const cx = Math.floor(p[0] / cell);
    const cy = Math.floor(p[1] / cell);
    const out: number[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) out.push(...(grid.get(`${cx + dx},${cy + dy}`) ?? []));
    return out;
  };
  const pairs: { i: number; j: number; d: number }[] = [];
  for (let i = 0; i < n; i++)
    for (const j of near(at(i))) {
      if (j <= i) continue;
      const d = Math.hypot(at(j)[0] - at(i)[0], at(j)[1] - at(i)[1]);
      if (d >= MIN_SPAN && d <= MAX_SPAN) pairs.push({ i, j, d });
    }
  // Spans that carry on a straight run (a third pylon in line beyond either
  // end) go first: a line's last pylon must not be joined to the end of a
  // neighbouring line just because that one is nearer.
  const dirOf = (i: number, j: number): Vec2 => {
    const d = Math.hypot(at(j)[0] - at(i)[0], at(j)[1] - at(i)[1]) || 1;
    return [(at(j)[0] - at(i)[0]) / d, (at(j)[1] - at(i)[1]) / d];
  };
  const partners = new Map<number, number[]>();
  for (const { i, j } of pairs) {
    partners.set(i, [...(partners.get(i) ?? []), j]);
    partners.set(j, [...(partners.get(j) ?? []), i]);
  }
  const carriesOn = (i: number, j: number) =>
    (partners.get(i) ?? []).some((k) => {
      if (k === j) return false;
      const u = dirOf(i, j);
      const v = dirOf(i, k);
      return u[0] * v[0] + u[1] * v[1] <= -MAX_TURN_COS;
    });
  const strong = (p: { i: number; j: number }) => carriesOn(p.i, p.j) || carriesOn(p.j, p.i);
  const rank = new Map(pairs.map((p) => [p, strong(p) ? 0 : 1]));
  pairs.sort((a, b) => rank.get(a)! - rank.get(b)! || a.d - b.d || a.i - b.i || a.j - b.j);

  /** Unit directions of the spans leaving each pylon. */
  const out: Vec2[][] = pylons.map(() => []);
  const straight = (i: number, dir: Vec2) =>
    out[i].length === 0 ||
    (out[i].length === 1 && out[i][0][0] * dir[0] + out[i][0][1] * dir[1] <= -MAX_TURN_COS);
  const spans: OverheadSpan[] = [];
  for (const { i, j, d } of pairs) {
    if (out[i].length >= 2 || out[j].length >= 2) continue;
    const a = at(i);
    const b = at(j);
    const dir: Vec2 = [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
    const back: Vec2 = [-dir[0], -dir[1]];
    if (!straight(i, dir) || !straight(j, back)) continue;
    const skips = near(a).some((k) => {
      if (k === i || k === j) return false;
      const c = closestOnSegment(at(k), a, b);
      return c.t > 0.02 && c.t < 0.98 && c.d < SKIP_CLEARANCE;
    });
    if (skips) continue;
    out[i].push(dir);
    out[j].push(back);
    spans.push({ a: pylons[i].position, b: pylons[j].position, provenance: 'inferred' });
  }
  // Face each pylon along its line (the mean of its spans' directions).
  pylons.forEach((p, i) => {
    const d = out[i];
    if (!d.length) return;
    const v: Vec2 = d.length === 2 ? [d[0][0] - d[1][0], d[0][1] - d[1][1]] : d[0];
    p.heading = Math.atan2(v[1], v[0]);
  });
  return spans;
}
