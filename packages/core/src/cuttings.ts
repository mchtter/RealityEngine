import { closestOnSegment, dist, normalize, pointInRing, samplePolyline, sub } from './geo';
import { bufferPolyline, offset, union } from './poly';
import { isVehicular } from './roads';
import { terrainHeightAt } from './terrain';
import type {
  Cutting,
  Polygon,
  Portal,
  Road,
  TerrainCut,
  TerrainGrid,
  Tunnel,
  Vec2,
  Vec3,
} from './types';

/**
 * Underpasses ("battı çıktı") and tunnel portals. OSM marks the covered part
 * of a road as `tunnel=yes`; the open ramps down to it are ordinary roads and
 * rarely tagged `cutting=yes`. So the trench is derived: from each portal of a
 * short urban tunnel the connected ground roads are followed back until the
 * ramp (≈ 6 % grade) reaches street level, and the terrain is cut along them.
 * Long tunnels through a hill get only their portals.
 */

/** Ramp grade of an underpass approach. */
const RAMP_GRADE = 0.06;
/** Clearance + deck: road level at the portal below the street above. */
const DEPTH_PER_LAYER = 6.5;
/** Ground over the tunnel this much above its ends ⇒ a hill tunnel, not an underpass. */
const HILL_RISE = 8;
/** Retaining walls stand this far outside the carriageway edge. */
const WALL_GAP = 0.6;
/** Clear height of a tunnel tube above the road. */
export const TUNNEL_HEIGHT = 5.4;
/**
 * Twin ramps closer than this (footprint to footprint, metres) share one
 * solid median wall: the strip between them is too narrow for the 4 m
 * terrain grid, which sagged into both trenches there as a grass wedge.
 */
export const TWIN_MEDIAN = 4;
/** Maintenance walkway each side inside a tube. */
const WALKWAY = 1.1;
/** Steepest grade of a road inside a tube (a deeper branch dips away from a joint). */
const TUBE_GRADE = 0.07;
/** Profile points along a tube at most this far apart (m). */
const TUBE_STEP = 5;

const endKey = (p: Vec2) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;

function arcLengths(points: Vec2[]): number[] {
  const at = [0];
  for (let k = 1; k < points.length; k++) at.push(at[k - 1] + dist(points[k - 1], points[k]));
  return at;
}

/**
 * The ramp polyline leaving a portal along the ground roads connected to it,
 * up to `length` metres (straight-ish continuations only).
 */
function approachFrom(
  portal: Vec2,
  away: Vec2,
  length: number,
  byEnd: Map<string, Road[]>,
  exclude: Road,
): { points: Vec2[]; width: number; road: Road | null } | null {
  const points: Vec2[] = [portal];
  let width = 0;
  let first: Road | null = null;
  let at = portal;
  let dir = away;
  let walked = 0;
  const used = new Set<Road>([exclude]);
  while (walked < length) {
    const candidates = (byEnd.get(endKey(at)) ?? []).filter((r) => !used.has(r));
    let best: { road: Road; pts: Vec2[]; turn: number } | null = null;
    for (const r of candidates) {
      const c = r.centerline;
      const pts = dist(c[0], at) < dist(c[c.length - 1], at) ? c : [...c].reverse();
      if (pts.length < 2) continue;
      const forward = dotDir(dir, normalize(sub(pts[1], pts[0])));
      if (forward < 0.85) continue;
      const turn = 1 - forward;
      if (!best || turn < best.turn) best = { road: r, pts, turn };
    }
    if (!best) break;
    used.add(best.road);
    first ??= best.road;
    width = Math.max(width, best.road.width);
    for (let k = 1; k < best.pts.length && walked < length; k++) {
      const seg = dist(best.pts[k - 1], best.pts[k]);
      if (walked + seg >= length) {
        const t = (length - walked) / seg;
        points.push([
          best.pts[k - 1][0] + (best.pts[k][0] - best.pts[k - 1][0]) * t,
          best.pts[k - 1][1] + (best.pts[k][1] - best.pts[k - 1][1]) * t,
        ]);
        walked = length;
        break;
      }
      walked += seg;
      points.push(best.pts[k]);
    }
    at = best.pts[best.pts.length - 1];
    dir = normalize(sub(at, best.pts[best.pts.length - 2]));
  }
  return points.length >= 2 && walked > 10 ? { points, width, road: first } : null;
}

/** A polyline with points added so no segment is longer than `step`. */
function densify(points: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [points[0]];
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1];
    const b = points[k];
    const n = Math.ceil(dist(a, b) / step);
    for (let i = 1; i <= n; i++)
      out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  }
  return out;
}

function dotDir(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

/**
 * Finds underpass ramps, tunnel portals and tubes, and where they cut the
 * ground (`TerrainCut`). The terrain grid itself is left as it is.
 *
 * The terrain is a 4 m grid, so neither a vertical wall nor a hole can be
 * modelled in it: lowering grid nodes for a trench made triangles slope up
 * inside it, and the ground over a tube mouth closed the tube. Instead the
 * footprints are returned and the viewer leaves the terrain out inside them,
 * drawing the trench floor and the lid there from two grids of their own
 * (every node within one diagonal cell of a footprint is set, so triangles
 * inside a footprint lie entirely on the new surface).
 */
export function buildCuttings(
  roads: Road[],
  t: TerrainGrid,
): { cuttings: Cutting[]; portals: Portal[]; tunnels: Tunnel[]; cut: TerrainCut } {
  const ground = roads.filter((r) => r.grade === 'ground' && isVehicular(r.cls));
  const byEnd = new Map<string, Road[]>();
  for (const r of ground) {
    const c = r.centerline;
    for (const p of [c[0], c[c.length - 1]]) {
      const k = endKey(p);
      byEnd.set(k, [...(byEnd.get(k) ?? []), r]);
    }
  }
  const origAt = (p: Vec2) => terrainHeightAt(t, p[0], p[1]);
  const floorGrid: TerrainGrid = { ...t, heights: t.heights.slice() };
  const lidGrid: TerrainGrid = { ...t, heights: t.heights.slice() };
  const reach = t.cellSize * 1.5;
  const floorMin = t.seaLevel + 0.3;

  const cuttings: Cutting[] = [];
  const portals: Portal[] = [];
  const tunnels: Tunnel[] = [];
  const trenches: Polygon[] = [];
  const lids: Polygon[] = [];
  const tubes = roads.filter(
    (r) => r.grade === 'tunnel' && isVehicular(r.cls) && r.centerline.length >= 2,
  );
  const depthOf = (r: Road) => DEPTH_PER_LAYER * Math.min(2, Math.max(1, -r.layer));
  const isHill = (r: Road) => {
    const c = r.centerline;
    const endZ = Math.max(origAt(c[0]), origAt(c[c.length - 1]));
    let overZ = -Infinity;
    for (let k = 1; k < c.length - 1; k++) overZ = Math.max(overZ, origAt(c[k]));
    return overZ - endZ > HILL_RISE;
  };
  const hills = new Set(tubes.filter(isHill));
  // The source splits a tunnel network (an underpass junction) at every
  // branch: ends of tubes meeting are joints inside one network — one floor
  // level shared by all of them, no mouth, no ramp. A joint takes the
  // shallowest level of its tubes (a deeper one dips away from it); a mouth
  // is an end that meets no other tube. (Before, every piece got mouths of
  // its own: a layer −1 tube joining a −2 one met it 6.5 m higher, open.)
  const tubeEnds = new Map<string, Road[]>();
  for (const r of tubes)
    for (const p of [r.centerline[0], r.centerline[r.centerline.length - 1]]) {
      const k = endKey(p);
      tubeEnds.set(k, [...(tubeEnds.get(k) ?? []), r]);
    }
  const isJoint = (p: Vec2) => (tubeEnds.get(endKey(p))?.length ?? 0) > 1;
  const jointZ = (p: Vec2) => {
    const at = tubeEnds.get(endKey(p)) ?? [];
    return Math.max(floorMin, origAt(p) - Math.min(...at.map(depthOf)));
  };
  for (const tunnel of tubes) {
    const hill = hills.has(tunnel);
    const raw = tunnel.centerline;
    // Underpasses follow the street above at their depth: profile points every TUBE_STEP.
    const c = hill ? raw : densify(raw, TUBE_STEP);
    const ends = [
      { p: c[0], into: normalize(sub(c[1], c[0])) },
      { p: c[c.length - 1], into: normalize(sub(c[c.length - 2], c[c.length - 1])) },
    ];
    const joined = ends.map((e) => !hill && isJoint(e.p));
    const depth = depthOf(tunnel);
    const tubeHalf = tunnel.width / 2 + WALKWAY;
    // Road level in the tube at each end: a joint's shared level; at a mouth
    // street level into a hill, below the street for an underpass.
    const mouthZ = ends.map((e, k) =>
      joined[k] ? jointZ(e.p) : Math.max(floorMin, origAt(e.p) - (hill ? 0 : depth)),
    );
    const at = arcLengths(c);
    const total = at[at.length - 1];
    // A hill tunnel runs straight from mouth to mouth; an underpass keeps its
    // depth under the street, reached from its ends at most TUBE_GRADE.
    const zs = c.map((p, k) =>
      k === 0
        ? mouthZ[0]
        : k === c.length - 1
          ? mouthZ[1]
          : hill
            ? mouthZ[0] + (mouthZ[1] - mouthZ[0]) * (total > 0 ? at[k] / total : 0)
            : Math.max(
                floorMin,
                origAt(p) - depth,
                mouthZ[0] - TUBE_GRADE * at[k],
                mouthZ[1] - TUBE_GRADE * (total - at[k]),
              ),
    );
    /** Road level at arc length s. */
    const floorAt = (s: number) => {
      let k = 1;
      while (k < at.length - 1 && at[k] < s) k++;
      const t = (s - at[k - 1]) / (at[k] - at[k - 1] || 1);
      return zs[k - 1] + (zs[k] - zs[k - 1]) * Math.min(1, Math.max(0, t));
    };
    tunnels.push({
      id: `${tunnel.id}-t`,
      roadId: tunnel.id,
      ...(tunnel.name ? { name: tunnel.name } : {}),
      path: c.map((p, k) => [p[0], p[1], zs[k]]),
      width: tubeHalf * 2,
      height: TUNNEL_HEIGHT,
      carriageway: tunnel.width,
      lanes: tunnel.lanes,
      oneway: tunnel.oneway,
      edgeLines: ['motorway', 'trunk', 'primary'].includes(tunnel.cls),
    });

    ends.forEach((end, k) => {
      // A joint opens into the next tube of the network: no ramp, no mouth.
      if (joined[k]) return;
      const away: Vec2 = [-end.into[0], -end.into[1]];
      let half = tubeHalf;
      if (!hill) {
        const ramp = approachFrom(end.p, away, depth / RAMP_GRADE, byEnd, tunnel);
        if (ramp) {
          half = Math.max(tubeHalf, ramp.width / 2 + WALL_GAP);
          const ra = arcLengths(ramp.points);
          const rTotal = ra[ra.length - 1];
          const depthAt = (s: number) => {
            const x = Math.min(1, Math.max(0, s / rTotal));
            // Eased so the ramp meets the street without a kink.
            return depth * (1 - x * x * (3 - 2 * x));
          };
          // Flat trench floor: the centre's ground less the ramp depth, never below the sea.
          const floorOf = (p: Vec2, s: number) =>
            s >= rTotal ? origAt(p) : Math.max(floorMin, origAt(p) - depthAt(s));
          setAlong(floorGrid, ramp.points, ra, half + reach, (s, centre) => floorOf(centre, s), -1);
          trenches.push(...bufferPolyline(ramp.points, half, false));
          cuttings.push({
            id: `${tunnel.id}-c${k}`,
            roadId: tunnel.id,
            path: ramp.points.map((p, i) => [p[0], p[1], floorOf(p, ra[i])]),
            width: half * 2,
            carriageway: ramp.width,
            lanes: ramp.road?.lanes ?? tunnel.lanes,
            oneway: ramp.road?.oneway ?? tunnel.oneway,
            edgeLines: ['motorway', 'trunk', 'primary'].includes(ramp.road?.cls ?? tunnel.cls),
          });
        }
      }

      // The tube's first metres: where the ground over it (centre or either
      // side) is too thin, it is a cut-and-cover box under a lid.
      const inward = k === 0 ? c : [...c].reverse();
      const ia = arcLengths(inward);
      const floorIn = (s: number) => floorAt(k === 0 ? s : total - s);
      let shallow = 0;
      for (const smp of samplePolyline(inward, 2)) {
        const n: Vec2 = [-smp.dir[1] * half, smp.dir[0] * half];
        const cover =
          Math.min(
            origAt(smp.point),
            origAt([smp.point[0] + n[0], smp.point[1] + n[1]]),
            origAt([smp.point[0] - n[0], smp.point[1] - n[1]]),
          ) - floorIn(smp.at);
        if (cover >= TUNNEL_HEIGHT + 1) break;
        shallow = smp.at;
        if (shallow > 120) break;
      }
      const lidPts = slicePolyline(inward, ia, Math.min(total, shallow + 2));
      // Only a tunnel into a hill gets a lid: an underpass's tube runs under
      // the street, which is its cover (raising the ground there lifted the
      // street's own surface into humps around the mouth).
      if (hill && lidPts.length >= 2 && shallow > 0) {
        const la = arcLengths(lidPts);
        setAlong(lidGrid, lidPts, la, half + reach, (s) => floorIn(s) + TUNNEL_HEIGHT + 0.4, 1);
        lids.push(...bufferPolyline(lidPts, half, false));
      }
      portals.push({
        id: `${tunnel.id}-p${k}`,
        roadId: tunnel.id,
        at: [end.p[0], end.p[1], mouthZ[k]],
        facing: away,
        width: half * 2 + 1.6,
        opening: tubeHalf * 2,
        height: TUNNEL_HEIGHT,
        hill,
        wall: hill
          ? TUNNEL_HEIGHT + 2
          : Math.max(TUNNEL_HEIGHT + 0.6, origAt(end.p) - mouthZ[k] + 0.9),
      });
    });
  }
  const changed = (g: TerrainGrid): Vec3[] => {
    const out: Vec3[] = [];
    for (let idx = 0; idx < g.heights.length; idx++) {
      if (g.heights[idx] === t.heights[idx]) continue;
      const i = idx % t.cols;
      const j = (idx - i) / t.cols;
      out.push([t.minX + i * t.cellSize, t.minY + j * t.cellSize, g.heights[idx]]);
    }
    return out;
  };
  return {
    cuttings,
    portals,
    tunnels,
    cut: {
      // Closed by TWIN_MEDIAN / 2: twin ramps closer than TWIN_MEDIAN become
      // one footprint, the strip between them goes under their median wall.
      trenches: trenches.length
        ? offset(offset(union(trenches), TWIN_MEDIAN / 2, 'miter'), -TWIN_MEDIAN / 2, 'miter')
        : [],
      lids: lids.length ? union(lids) : [],
      floor: changed(floorGrid),
      lid: changed(lidGrid),
    },
  };
}

/**
 * The ground with underpasses and tunnel mouths cut into it: trench floor
 * inside trenches, the lid over a tube mouth, the terrain elsewhere.
 */
export class CutGround {
  readonly floor: TerrainGrid;
  readonly lid: TerrainGrid;
  private readonly trenchBoxes: [Polygon, number[]][];
  private readonly lidBoxes: [Polygon, number[]][];

  constructor(
    readonly terrain: TerrainGrid,
    readonly cut: TerrainCut | undefined,
  ) {
    this.floor = withNodes(terrain, cut?.floor ?? []);
    this.lid = withNodes(terrain, cut?.lid ?? []);
    const boxed = (polys: Polygon[]): [Polygon, number[]][] =>
      polys.map((p) => {
        let b = [Infinity, Infinity, -Infinity, -Infinity];
        for (const q of p.outer)
          b = [
            Math.min(b[0], q[0]),
            Math.min(b[1], q[1]),
            Math.max(b[2], q[0]),
            Math.max(b[3], q[1]),
          ];
        return [p, b];
      });
    this.trenchBoxes = boxed(cut?.trenches ?? []);
    this.lidBoxes = boxed(cut?.lids ?? []);
  }

  inTrench(x: number, y: number): boolean {
    return inside(this.trenchBoxes, x, y);
  }

  inLid(x: number, y: number): boolean {
    return inside(this.lidBoxes, x, y);
  }

  /** The grid that is the ground at (x, y). */
  gridAt(x: number, y: number): TerrainGrid {
    if (this.inTrench(x, y)) return this.floor;
    if (this.inLid(x, y)) return this.lid;
    return this.terrain;
  }

  heightAt(x: number, y: number): number {
    return terrainHeightAt(this.gridAt(x, y), x, y);
  }
}

function inside(boxes: [Polygon, number[]][], x: number, y: number): boolean {
  for (const [p, b] of boxes) {
    if (x < b[0] || y < b[1] || x > b[2] || y > b[3]) continue;
    if (pointInRing([x, y], p.outer) && !p.holes.some((h) => pointInRing([x, y], h))) return true;
  }
  return false;
}

/** Copy of a grid with some nodes (model x, y, height) changed; nodes off the grid are ignored. */
function withNodes(t: TerrainGrid, nodes: Vec3[]): TerrainGrid {
  if (!nodes.length) return t;
  const heights = t.heights.slice();
  for (const [x, y, z] of nodes) {
    const i = Math.round((x - t.minX) / t.cellSize);
    const j = Math.round((y - t.minY) / t.cellSize);
    if (i < 0 || j < 0 || i >= t.cols || j >= t.rows) continue;
    heights[j * t.cols + i] = z;
  }
  return { ...t, heights };
}

/** The first `length` metres of a polyline. */
function slicePolyline(points: Vec2[], at: number[], length: number): Vec2[] {
  const out: Vec2[] = [points[0]];
  for (let k = 1; k < points.length; k++) {
    if (at[k] >= length) {
      const t = (length - at[k - 1]) / (at[k] - at[k - 1] || 1);
      out.push([
        points[k - 1][0] + (points[k][0] - points[k - 1][0]) * t,
        points[k - 1][1] + (points[k][1] - points[k - 1][1]) * t,
      ]);
      return out;
    }
    out.push(points[k]);
  }
  return out;
}

/**
 * Sets grid nodes within `r` of a polyline to `height(s, centre)` from the arc
 * length and closest centreline point — only lowering (`sign` −1) or only
 * raising (+1), so overlapping cuts keep the deeper floor / higher lid. Nodes
 * past an end take the end's height: these grids only count inside footprints,
 * and a footprint's triangles reach one cell past its butt ends.
 */
function setAlong(
  t: TerrainGrid,
  points: Vec2[],
  at: number[],
  r: number,
  height: (s: number, centre: Vec2) => number,
  sign: 1 | -1,
): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  const i0 = Math.max(0, Math.floor((minX - r - t.minX) / t.cellSize));
  const i1 = Math.min(t.cols - 1, Math.ceil((maxX + r - t.minX) / t.cellSize));
  const j0 = Math.max(0, Math.floor((minY - r - t.minY) / t.cellSize));
  const j1 = Math.min(t.rows - 1, Math.ceil((maxY + r - t.minY) / t.cellSize));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const p: Vec2 = [t.minX + i * t.cellSize, t.minY + j * t.cellSize];
      let best = { d: Infinity, s: 0, c: points[0] };
      for (let k = 1; k < points.length; k++) {
        const a = points[k - 1];
        const b = points[k];
        const cl = closestOnSegment(p, a, b);
        if (cl.d < best.d)
          best = { d: cl.d, s: at[k - 1] + cl.t * (at[k] - at[k - 1]), c: cl.point };
      }
      if (best.d > r) continue;
      const idx = j * t.cols + i;
      const z = height(best.s, best.c);
      t.heights[idx] = sign < 0 ? Math.min(t.heights[idx], z) : Math.max(t.heights[idx], z);
    }
  }
}

/**
 * Wall tops of every trench and the ground beside them made to agree: the top
 * is the street level just beyond the wall (street surface where there is
 * one, with the sidewalk's kerb lift, the terrain elsewhere — never another
 * trench's floor) plus a parapet, smoothed along the wall; then terrain nodes
 * within 1.5 cells outside the wall are lowered to 0.1 m below the top, so no
 * ground of this or a neighbouring tile rises over the wall.
 */
export function settleTrenchRims(
  cuttings: Cutting[],
  t: TerrainGrid,
  street: (x: number, y: number) => number | null,
  kerbLift: number,
): void {
  for (const c of cuttings) {
    const p = c.path;
    const half = c.width / 2;
    const n = p.map((_, k) => {
      const a = p[Math.max(0, k - 1)];
      const b = p[Math.min(p.length - 1, k + 1)];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l] as Vec2;
    });
    const rims: number[][] = [];
    for (const side of [1, -1]) {
      const beyond = p.map((q, k) => {
        const x = q[0] + n[k][0] * side * (half + 0.5);
        const y = q[1] + n[k][1] * side * (half + 0.5);
        const s = street(x, y);
        return Math.max(q[2] + 0.3, s !== null ? s + kerbLift : terrainHeightAt(t, x, y));
      });
      // Highest within ±2 points, then averaged: smooth and never below the ground.
      const win = (k: number) => {
        const out: number[] = [];
        for (let j = Math.max(0, k - 2); j <= Math.min(p.length - 1, k + 2); j++) out.push(j);
        return out;
      };
      const peak = beyond.map((_, k) => Math.max(...win(k).map((j) => beyond[j])));
      rims.push(
        p.map((q, k) => {
          const g = Math.max(win(k).reduce((s, j) => s + peak[j], 0) / win(k).length, beyond[k]);
          const depth = g - q[2];
          return Math.round((g + 0.15 + 0.75 * Math.min(1, Math.max(0, depth / 2))) * 100) / 100;
        }),
      );
    }
    c.rimL = rims[0];
    c.rimR = rims[1];
    // Ground beside the walls kept below their tops.
    const pts = p.map((q) => [q[0], q[1]] as Vec2);
    const reach = half + 0.4 + t.cellSize * 1.5;
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const q of pts)
      b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[0]), Math.max(b[3], q[1])];
    const i0 = Math.max(0, Math.floor((b[0] - reach - t.minX) / t.cellSize));
    const i1 = Math.min(t.cols - 1, Math.ceil((b[2] + reach - t.minX) / t.cellSize));
    const j0 = Math.max(0, Math.floor((b[1] - reach - t.minY) / t.cellSize));
    const j1 = Math.min(t.rows - 1, Math.ceil((b[3] + reach - t.minY) / t.cellSize));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const q: Vec2 = [t.minX + i * t.cellSize, t.minY + j * t.cellSize];
        let best = { d: Infinity, k: 0, side: 1 };
        for (let k = 1; k < pts.length; k++) {
          const cl = closestOnSegment(q, pts[k - 1], pts[k]);
          if (cl.d < best.d) {
            const ab = sub(pts[k], pts[k - 1]);
            const cross = ab[0] * (q[1] - pts[k - 1][1]) - ab[1] * (q[0] - pts[k - 1][0]);
            best = { d: cl.d, k: cl.t < 0.5 ? k - 1 : k, side: cross >= 0 ? 1 : -1 };
          }
        }
        if (best.d < half || best.d > reach) continue;
        const rim = (best.side > 0 ? rims[0] : rims[1])[best.k];
        const idx = j * t.cols + i;
        t.heights[idx] = Math.min(t.heights[idx], rim - 0.1);
      }
    }
  }
}
