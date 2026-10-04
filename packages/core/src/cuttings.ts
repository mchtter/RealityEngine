import { closestOnSegment, dist, normalize, pointInRing, samplePolyline, sub } from './geo';
import { bufferPolyline, union } from './poly';
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
/** Maintenance walkway each side inside a tube. */
const WALKWAY = 1.1;

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
  for (const tunnel of roads.filter((r) => r.grade === 'tunnel' && isVehicular(r.cls))) {
    const c = tunnel.centerline;
    if (c.length < 2) continue;
    const ends = [
      { p: c[0], into: normalize(sub(c[1], c[0])) },
      { p: c[c.length - 1], into: normalize(sub(c[c.length - 2], c[c.length - 1])) },
    ];
    const endZ = Math.max(...ends.map((e) => origAt(e.p)));
    let overZ = -Infinity;
    for (let k = 1; k < c.length - 1; k++) overZ = Math.max(overZ, origAt(c[k]));
    const hill = overZ - endZ > HILL_RISE;
    const depth = DEPTH_PER_LAYER * Math.min(2, Math.max(1, -tunnel.layer));
    const tubeHalf = tunnel.width / 2 + WALKWAY;
    // Road level in the tube at each mouth: street level into a hill, below the street for an underpass.
    const mouthZ = ends.map((e) => Math.max(floorMin, origAt(e.p) - (hill ? 0 : depth)));
    const at = arcLengths(c);
    const total = at[at.length - 1];
    const floorAt = (s: number) =>
      mouthZ[0] + (mouthZ[1] - mouthZ[0]) * (total > 0 ? s / total : 0);
    tunnels.push({
      id: `${tunnel.id}-t`,
      roadId: tunnel.id,
      ...(tunnel.name ? { name: tunnel.name } : {}),
      path: c.map((p, k) => [p[0], p[1], floorAt(at[k])]),
      width: tubeHalf * 2,
      height: TUNNEL_HEIGHT,
      carriageway: tunnel.width,
      lanes: tunnel.lanes,
      oneway: tunnel.oneway,
      edgeLines: ['motorway', 'trunk', 'primary'].includes(tunnel.cls),
    });

    ends.forEach((end, k) => {
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
      trenches: trenches.length ? union(trenches) : [],
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
