import type { Fence, FenceStyle, Vec3 } from './types';

/**
 * How far below the ground a garden boundary's body starts (m): sunk 0.3 m
 * so the ground's own folds between its points never show a gap under it.
 * Hedges were sunk 0.1 m and hung 3–11 cm over a lower street surface beside
 * them on slopes (İzmir 2026-10-16: fence.float).
 */
export const FENCE_FOOT: Record<FenceStyle, number> = {
  'wall-rail': 0.3,
  wall: 0.3,
  stone: 0.3,
  hedge: 0.3,
  mesh: 0.3,
};

/**
 * Points along a garden boundary on the ground, as the viewer draws it: every
 * metre where the ground bends, only the corners where it runs straight
 * (points where the ground leaves the straight line between kept points by
 * more than 4 cm). A 1 m sampling of every wall held more GPU memory than the
 * buildings in a dense tile (35 MB).
 */
export function fenceProfile(f: Fence, heightAt: (x: number, y: number) => number): Vec3[] {
  const fine: { p: Vec3; corner: boolean; s: number }[] = [];
  let s = 0;
  for (let k = 0; k < f.points.length; k++) {
    const a = f.points[k];
    if (k > 0) {
      const b = f.points[k - 1];
      const len = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const n = Math.ceil(len / 1);
      for (let i = 1; i < n; i++) {
        const x = b[0] + ((a[0] - b[0]) * i) / n;
        const y = b[1] + ((a[1] - b[1]) * i) / n;
        fine.push({ p: [x, y, heightAt(x, y)], corner: false, s: s + (len * i) / n });
      }
      s += len;
    }
    fine.push({ p: [a[0], a[1], heightAt(a[0], a[1])], corner: true, s });
  }
  // Keep corners, and the points where the ground leaves the straight line
  // between kept points by more than 4 cm (Douglas–Peucker on the profile).
  const keep = fine.map((q) => q.corner);
  const split = (i: number, j: number) => {
    if (j - i < 2) return;
    let worst = -1;
    let dev = 0.04;
    for (let m = i + 1; m < j; m++) {
      const t = (fine[m].s - fine[i].s) / (fine[j].s - fine[i].s || 1);
      const z = fine[i].p[2] + (fine[j].p[2] - fine[i].p[2]) * t;
      const d = Math.abs(fine[m].p[2] - z);
      if (d > dev) {
        dev = d;
        worst = m;
      }
    }
    if (worst < 0) return;
    keep[worst] = true;
    split(i, worst);
    split(worst, j);
  };
  let last = 0;
  for (let m = 1; m < fine.length; m++) {
    if (!keep[m]) continue;
    split(last, m);
    last = m;
  }
  return fine.filter((_, m) => keep[m]).map((q) => q.p);
}
