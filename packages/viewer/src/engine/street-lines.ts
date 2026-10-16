import type { RoadClass } from '@opentwin/city-core';

/**
 * The street lines a tile carries for its names (street-labels.ts): pure, so
 * the tile worker builds them with the summary.
 */

/** A named street piece, tile-local (x east, y north, z height of the street surface). */
export interface StreetLine {
  name: string;
  /** Higher keeps its place when names collide (motorway 6 … service 1). */
  rank: number;
  path: [number, number, number][];
}

const RANK: Partial<Record<RoadClass, number>> = {
  motorway: 6,
  trunk: 6,
  primary: 5,
  secondary: 4,
  tertiary: 3,
  residential: 2,
  unclassified: 2,
  living_street: 2,
  pedestrian: 1,
  service: 1,
};

/** Named ground streets with a surface profile (others carry no name on the map). */
export function streetLines(
  roads: {
    name?: string;
    cls: RoadClass;
    grade: string;
    centerline: [number, number][];
    profile?: number[];
  }[],
): StreetLine[] {
  const out: StreetLine[] = [];
  for (const r of roads) {
    const rank = RANK[r.cls];
    const name = r.name?.trim();
    if (!name || !rank || r.grade !== 'ground') continue;
    if (r.profile?.length !== r.centerline.length || r.centerline.length < 2) continue;
    out.push({
      name,
      rank,
      path: r.centerline.map((p, k) => [p[0], p[1], r.profile![k]]),
    });
  }
  return out;
}

/** Largest bend (degrees) between a run's direction and any of its segments. */
const MAX_BEND = 14;

/**
 * The longest nearly straight run of a path (no segment bending more than
 * MAX_BEND from the run's first one): its ends, as the chord the name lies on.
 */
export function straightestRun(
  path: [number, number, number][],
): { a: [number, number, number]; b: [number, number, number]; length: number } | null {
  let best: { a: number; b: number; length: number } | null = null;
  const cos = Math.cos((MAX_BEND * Math.PI) / 180);
  for (let i = 0; i < path.length - 1; ) {
    const dx = path[i + 1][0] - path[i][0];
    const dy = path[i + 1][1] - path[i][1];
    const l = Math.hypot(dx, dy);
    let j = i + 1;
    if (l > 1e-6) {
      while (j < path.length - 1) {
        const ex = path[j + 1][0] - path[j][0];
        const ey = path[j + 1][1] - path[j][1];
        const el = Math.hypot(ex, ey);
        if (el > 1e-6 && (dx * ex + dy * ey) / (l * el) < cos) break;
        j++;
      }
      const length = Math.hypot(path[j][0] - path[i][0], path[j][1] - path[i][1]);
      if (!best || length > best.length) best = { a: i, b: j, length };
    }
    i = j;
  }
  return best && best.length > 0 ? { a: path[best.a], b: path[best.b], length: best.length } : null;
}
