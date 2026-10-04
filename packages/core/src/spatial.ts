import { closestOnSegment, normalize, pointInRing, sub } from './geo';
import type { Polygon, Road, Vec2 } from './types';

/** Uniform-grid spatial hash over axis-aligned boxes. */
export class GridIndex<T> {
  private readonly cells = new Map<string, T[]>();

  constructor(private readonly size: number) {}

  insert(item: T, minX: number, minY: number, maxX: number, maxY: number): void {
    for (let x = Math.floor(minX / this.size); x <= Math.floor(maxX / this.size); x++) {
      for (let y = Math.floor(minY / this.size); y <= Math.floor(maxY / this.size); y++) {
        const key = `${x},${y}`;
        const list = this.cells.get(key);
        if (list) list.push(item);
        else this.cells.set(key, [item]);
      }
    }
  }

  query(minX: number, minY: number, maxX: number, maxY: number): T[] {
    const seen = new Set<T>();
    for (let x = Math.floor(minX / this.size); x <= Math.floor(maxX / this.size); x++) {
      for (let y = Math.floor(minY / this.size); y <= Math.floor(maxY / this.size); y++) {
        for (const item of this.cells.get(`${x},${y}`) ?? []) seen.add(item);
      }
    }
    return [...seen];
  }
}

export function ringBounds(ring: Vec2[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

export interface RoadHit {
  road: Road;
  point: Vec2;
  dir: Vec2;
  d: number;
}

/** Nearest-road queries over road centreline segments. */
export class RoadIndex {
  private readonly grid = new GridIndex<{ road: Road; a: Vec2; b: Vec2 }>(40);

  constructor(roads: Road[]) {
    for (const road of roads) {
      for (let k = 1; k < road.centerline.length; k++) {
        const a = road.centerline[k - 1];
        const b = road.centerline[k];
        this.grid.insert(
          { road, a, b },
          Math.min(a[0], b[0]),
          Math.min(a[1], b[1]),
          Math.max(a[0], b[0]),
          Math.max(a[1], b[1]),
        );
      }
    }
  }

  /** Distinct roads with a segment inside the box. */
  roadsNear(minX: number, minY: number, maxX: number, maxY: number): Road[] {
    return [...new Set(this.grid.query(minX, minY, maxX, maxY).map((s) => s.road))];
  }

  /**
   * First road whose band of `reach(road)` metres around the centreline holds
   * `p` (roads with reach ≤ 0 are ignored). `maxReach` bounds the search.
   */
  covering(p: Vec2, reach: (r: Road) => number, maxReach = 30): Road | null {
    for (const s of this.grid.query(
      p[0] - maxReach,
      p[1] - maxReach,
      p[0] + maxReach,
      p[1] + maxReach,
    )) {
      const r = reach(s.road);
      if (r > 0 && closestOnSegment(p, s.a, s.b).d < r) return s.road;
    }
    return null;
  }

  nearest(p: Vec2, maxDist: number, accept: (r: Road) => boolean = () => true): RoadHit | null {
    let best: RoadHit | null = null;
    for (const s of this.grid.query(
      p[0] - maxDist,
      p[1] - maxDist,
      p[0] + maxDist,
      p[1] + maxDist,
    )) {
      if (!accept(s.road)) continue;
      const c = closestOnSegment(p, s.a, s.b);
      if (c.d <= maxDist && (!best || c.d < best.d)) {
        best = { road: s.road, point: c.point, dir: normalize(sub(s.b, s.a)), d: c.d };
      }
    }
    return best;
  }
}

/** Point-in-polygon lookups over many polygons (buildings, areas). */
export class PolygonIndex<T> {
  private readonly grid = new GridIndex<{ item: T; polygon: Polygon }>(30);

  add(item: T, polygon: Polygon): void {
    const [minX, minY, maxX, maxY] = ringBounds(polygon.outer);
    this.grid.insert({ item, polygon }, minX, minY, maxX, maxY);
  }

  /**
   * Distance from `p` to the nearest polygon edge within `maxDist` (0 when `p`
   * lies inside a polygon; Infinity when none is that close).
   */
  distanceTo(p: Vec2, maxDist: number): number {
    let best = Infinity;
    for (const e of this.grid.query(
      p[0] - maxDist,
      p[1] - maxDist,
      p[0] + maxDist,
      p[1] + maxDist,
    )) {
      if (pointInRing(p, e.polygon.outer) && !e.polygon.holes.some((h) => pointInRing(p, h))) {
        return 0;
      }
      for (const ring of [e.polygon.outer, ...e.polygon.holes]) {
        for (let k = 0; k < ring.length; k++) {
          const d = closestOnSegment(p, ring[k], ring[(k + 1) % ring.length]).d;
          if (d < best) best = d;
        }
      }
    }
    return best <= maxDist ? best : Infinity;
  }

  at(p: Vec2, except?: T): T | null {
    for (const e of this.grid.query(p[0], p[1], p[0], p[1])) {
      if (e.item === except) continue;
      if (pointInRing(p, e.polygon.outer) && !e.polygon.holes.some((h) => pointInRing(p, h))) {
        return e.item;
      }
    }
    return null;
  }
}

/**
 * Point-in-polygons for large polygon sets (the merged sidewalks of a tile
 * have thousands of vertices): every ring edge is filed in the 2 m rows it
 * spans; a query casts a ray to the nearer side of the set and counts only
 * the edges of its own row (even-odd over all rings, holes included).
 */
export class PolygonSet {
  private readonly rows = new Map<number, number[]>();
  private readonly edges: number[] = [];
  private readonly minX: number;
  private readonly maxX: number;
  private static readonly ROW = 2;

  constructor(polys: Polygon[]) {
    let minX = Infinity;
    let maxX = -Infinity;
    for (const p of polys) {
      for (const ring of [p.outer, ...p.holes]) {
        for (let k = 0; k < ring.length; k++) {
          const a = ring[k];
          const b = ring[(k + 1) % ring.length];
          if (a[1] === b[1]) continue;
          const id = this.edges.length / 4;
          this.edges.push(a[0], a[1], b[0], b[1]);
          minX = Math.min(minX, a[0], b[0]);
          maxX = Math.max(maxX, a[0], b[0]);
          const r0 = Math.floor(Math.min(a[1], b[1]) / PolygonSet.ROW);
          const r1 = Math.floor(Math.max(a[1], b[1]) / PolygonSet.ROW);
          for (let r = r0; r <= r1; r++) {
            const list = this.rows.get(r);
            if (list) list.push(id);
            else this.rows.set(r, [id]);
          }
        }
      }
    }
    this.minX = minX;
    this.maxX = maxX;
  }

  contains(x: number, y: number): boolean {
    if (x < this.minX || x > this.maxX) return false;
    const list = this.rows.get(Math.floor(y / PolygonSet.ROW));
    if (!list) return false;
    const right = this.maxX - x < x - this.minX;
    let inside = false;
    const e = this.edges;
    for (const id of list) {
      const ax = e[id * 4];
      const ay = e[id * 4 + 1];
      const bx = e[id * 4 + 2];
      const by = e[id * 4 + 3];
      if (ay > y === by > y) continue;
      const cx = ax + ((y - ay) * (bx - ax)) / (by - ay);
      if (right ? cx > x : cx < x) inside = !inside;
    }
    return inside;
  }
}
