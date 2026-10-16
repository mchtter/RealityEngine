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

/**
 * Named ground streets with a surface profile (others carry no name on the
 * map). The source splits a street at every junction: pieces of the same
 * name meeting end to end are joined into one line (its rank the highest),
 * so a name has the street's straight length to lie on, not one block's.
 */
export function streetLines(
  roads: {
    name?: string;
    cls: RoadClass;
    grade: string;
    centerline: [number, number][];
    profile?: number[];
  }[],
): StreetLine[] {
  const byName = new Map<string, StreetLine[]>();
  for (const r of roads) {
    const rank = RANK[r.cls];
    const name = r.name?.trim();
    if (!name || !rank || r.grade !== 'ground') continue;
    if (r.profile?.length !== r.centerline.length || r.centerline.length < 2) continue;
    const piece: StreetLine = {
      name,
      rank,
      path: r.centerline.map((p, k) => [p[0], p[1], r.profile![k]]),
    };
    const list = byName.get(name);
    if (list) list.push(piece);
    else byName.set(name, [piece]);
  }
  const out: StreetLine[] = [];
  for (const pieces of byName.values()) out.push(...joinPieces(pieces));
  return out;
}

/** Ends closer than 10 cm are the same point. */
const keyOf = (p: [number, number, number]) => `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`;

/** Chains pieces (of one name) that meet end to end; a piece may be walked backwards. */
function joinPieces(pieces: StreetLine[]): StreetLine[] {
  const ends = new Map<string, number[]>();
  pieces.forEach((s, i) => {
    for (const p of [s.path[0], s.path[s.path.length - 1]]) {
      const k = keyOf(p);
      const list = ends.get(k);
      if (list) list.push(i);
      else ends.set(k, [i]);
    }
  });
  const used = new Array<boolean>(pieces.length).fill(false);
  /** An unused piece touching `at`, oriented to start there. */
  const next = (at: [number, number, number]): StreetLine | null => {
    for (const i of ends.get(keyOf(at)) ?? []) {
      if (used[i]) continue;
      used[i] = true;
      const s = pieces[i];
      const forward = keyOf(s.path[0]) === keyOf(at);
      return { ...s, path: forward ? s.path : [...s.path].reverse() };
    }
    return null;
  };
  const out: StreetLine[] = [];
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let { rank } = pieces[i];
    let path = pieces[i].path;
    for (let s = next(path[path.length - 1]); s; s = next(path[path.length - 1])) {
      path = [...path, ...s.path.slice(1)];
      rank = Math.max(rank, s.rank);
    }
    for (let s = next(path[0]); s; s = next(path[0])) {
      path = [...[...s.path].reverse(), ...path.slice(1)];
      rank = Math.max(rank, s.rank);
    }
    out.push({ name: pieces[i].name, rank, path });
  }
  return out;
}

/** Largest bend (degrees) between a run's direction and any of its segments. */
const MAX_BEND = 14;

/** A nearly straight run of a path: its ends (the chord a name lies on) and length. */
export interface StraightRun {
  a: [number, number, number];
  b: [number, number, number];
  length: number;
}

/**
 * The nearly straight runs of a path (no segment bending more than MAX_BEND
 * from the run's first one), in order along it.
 */
export function straightRuns(path: [number, number, number][]): StraightRun[] {
  const out: StraightRun[] = [];
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
      if (length > 0) out.push({ a: path[i], b: path[j], length });
    }
    i = j;
  }
  return out;
}

/** The longest of a path's straight runs. */
export function straightestRun(path: [number, number, number][]): StraightRun | null {
  let best: StraightRun | null = null;
  for (const r of straightRuns(path)) if (!best || r.length > best.length) best = r;
  return best;
}
