/**
 * Pure geometry of the city's work area (its boundary): ring extraction,
 * simplification, a grid index for inside tests and the nearest boundary
 * point, and the camera's spring step back inside. No three.js here (unit
 * tested in node).
 */

/** A ring as [x0, y0, x1, y1, …] (closing point not repeated). */
export type FlatRing = number[];

type Position = [number, number];

/** Outer rings ([lon, lat] lists) of a GeoJSON Polygon / MultiPolygon; [] for anything else. */
export function outerRings(geometry: unknown): Position[][] {
  if (!geometry || typeof geometry !== 'object') return [];
  const g = geometry as { type?: unknown; coordinates?: unknown };
  const valid = (ring: unknown): ring is Position[] =>
    Array.isArray(ring) &&
    ring.length >= 4 &&
    ring.every(
      (p) => Array.isArray(p) && Number.isFinite(p[0] as number) && Number.isFinite(p[1] as number),
    );
  const polys: unknown[] =
    g.type === 'Polygon'
      ? [g.coordinates]
      : g.type === 'MultiPolygon' && Array.isArray(g.coordinates)
        ? g.coordinates
        : [];
  const out: Position[][] = [];
  for (const poly of polys) {
    if (Array.isArray(poly) && valid(poly[0])) out.push(poly[0].map((p) => [p[0], p[1]]));
  }
  return out;
}

/** Whether a [lon, lat] point lies inside any of the rings (even–odd, planar). */
export function insideRingsLonLat(rings: Position[][], lon: number, lat: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
  }
  return inside;
}

/**
 * A point well inside the rings ([lon, lat]): on the horizontal line through
 * the largest ring's middle, the midpoint of the widest span inside. Null for
 * no rings.
 */
export function interiorPoint(rings: Position[][]): Position | null {
  let best: Position[] | null = null;
  let bestArea = -1;
  for (const ring of rings) {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
      a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    if (Math.abs(a) > bestArea) {
      bestArea = Math.abs(a);
      best = ring;
    }
  }
  if (!best) return null;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of best) {
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  // A few lines across the ring; the widest span on any of them wins.
  let winner: Position | null = null;
  let width = -1;
  for (const f of [0.5, 0.4, 0.6, 0.3, 0.7]) {
    const y = minY + (maxY - minY) * f;
    const xs: number[] = [];
    for (let i = 0, j = best.length - 1; i < best.length; j = i++) {
      const [xi, yi] = best[i];
      const [xj, yj] = best[j];
      if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      if (xs[k + 1] - xs[k] > width) {
        width = xs[k + 1] - xs[k];
        winner = [(xs[k] + xs[k + 1]) / 2, y];
      }
    }
  }
  return winner ?? best[0];
}

/** Squared distance from (px, py) to the segment a–b. */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

/**
 * Douglas–Peucker simplification of a closed ring (planar metres, closing
 * point not repeated): vertices closer than `tolerance` to the simplified
 * line are dropped. Iterative (provincial rings hold tens of thousands of
 * vertices). Keeps at least a triangle when the input has one.
 */
export function simplifyRing(ring: FlatRing, tolerance: number): FlatRing {
  const n = ring.length / 2;
  if (n <= 3) return ring.slice();
  // Split the ring at its first vertex and the vertex farthest from it.
  let far = 1;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const d = (ring[2 * i] - ring[0]) ** 2 + (ring[2 * i + 1] - ring[1]) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[far] = keep[n] = 1;
  const tol2 = tolerance * tolerance;
  const x = (i: number) => ring[2 * (i % n)];
  const y = (i: number) => ring[2 * (i % n) + 1];
  const stack: [number, number][] = [
    [0, far],
    [far, n],
  ];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let worstD = tol2;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(x(i), y(i), x(a), y(a), x(b), y(b));
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out: FlatRing = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[2 * i], ring[2 * i + 1]);
  return out.length >= 6 ? out : ring.slice();
}

/** Points added along a closed ring so that no edge is longer than `maxLen` (for terrain following). */
export function densifyRing(ring: FlatRing, maxLen: number): FlatRing {
  const n = ring.length / 2;
  const out: FlatRing = [];
  for (let i = 0; i < n; i++) {
    const ax = ring[2 * i];
    const ay = ring[2 * i + 1];
    const bx = ring[2 * ((i + 1) % n)];
    const by = ring[2 * ((i + 1) % n) + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / maxLen));
    for (let s = 0; s < steps; s++)
      out.push(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps);
  }
  return out;
}

/** Nearest boundary point and the edge it lies on. */
export interface Nearest {
  x: number;
  y: number;
  dist: number;
  edge: number;
}

/**
 * Closed rings (planar metres) with a uniform grid over their edges: inside
 * tests (even–odd, only the edges crossing the point's grid row) and the
 * nearest boundary point (grid cells searched outward) stay cheap on rings
 * of thousands of edges.
 */
export class PolygonIndex {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly cell: number;
  private readonly nx: number;
  private readonly ny: number;
  /** Edges as [ax, ay, bx, by] × count. */
  private readonly edges: Float64Array;
  /** Edge indices per grid row (y band), for inside tests. */
  private readonly rows: number[][];
  /** Edge indices per grid cell (row-major), for the nearest point. */
  private readonly cells: (number[] | undefined)[];

  constructor(rings: FlatRing[], maxCells = 256) {
    let count = 0;
    for (const r of rings) if (r.length >= 6) count += r.length / 2;
    this.edges = new Float64Array(count * 4);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let k = 0;
    for (const r of rings) {
      if (r.length < 6) continue;
      const n = r.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        this.edges.set([r[2 * i], r[2 * i + 1], r[2 * j], r[2 * j + 1]], k * 4);
        k++;
        minX = Math.min(minX, r[2 * i]);
        maxX = Math.max(maxX, r[2 * i]);
        minY = Math.min(minY, r[2 * i + 1]);
        maxY = Math.max(maxY, r[2 * i + 1]);
      }
    }
    if (!count) minX = minY = maxX = maxY = 0;
    this.minX = minX;
    this.minY = minY;
    this.maxX = maxX;
    this.maxY = maxY;
    this.cell = Math.max(100, Math.max(maxX - minX, maxY - minY) / maxCells);
    this.nx = Math.max(1, Math.ceil((maxX - minX) / this.cell) + 1);
    this.ny = Math.max(1, Math.ceil((maxY - minY) / this.cell) + 1);
    this.rows = Array.from({ length: this.ny }, () => []);
    this.cells = new Array<number[] | undefined>(this.nx * this.ny);
    const e = this.edges;
    for (let i = 0; i < count; i++) {
      const [ax, ay, bx, by] = [e[4 * i], e[4 * i + 1], e[4 * i + 2], e[4 * i + 3]];
      const r0 = this.rowOf(Math.min(ay, by));
      const r1 = this.rowOf(Math.max(ay, by));
      const c0 = this.colOf(Math.min(ax, bx));
      const c1 = this.colOf(Math.max(ax, bx));
      for (let r = r0; r <= r1; r++) {
        this.rows[r].push(i);
        for (let c = c0; c <= c1; c++) (this.cells[r * this.nx + c] ??= []).push(i);
      }
    }
  }

  get edgeCount(): number {
    return this.edges.length / 4;
  }

  private rowOf(y: number): number {
    return Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)));
  }

  private colOf(x: number): number {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)));
  }

  /** Whether (x, y) lies inside the rings (even–odd: rings inside rings cut holes). */
  contains(x: number, y: number): boolean {
    if (!this.edgeCount || x < this.minX || x > this.maxX || y < this.minY || y > this.maxY)
      return false;
    const e = this.edges;
    let inside = false;
    for (const i of this.rows[this.rowOf(y)]) {
      const ax = e[4 * i];
      const ay = e[4 * i + 1];
      const bx = e[4 * i + 2];
      const by = e[4 * i + 3];
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    }
    return inside;
  }

  /** The nearest point on the boundary to (x, y); null without edges. */
  nearest(x: number, y: number): Nearest | null {
    if (!this.edgeCount) return null;
    const cx = Math.floor((x - this.minX) / this.cell);
    const cy = Math.floor((y - this.minY) / this.cell);
    // Rings of cells around the point's cell; cells in ring r + 1 lie at
    // least r cells away, so the search ends once the best is that close.
    const gap = Math.max(0, -cx, cx - (this.nx - 1), -cy, cy - (this.ny - 1));
    const maxR = gap + Math.max(this.nx, this.ny);
    const e = this.edges;
    let best = -1;
    let bestD2 = Infinity;
    const seen = new Set<number>();
    const visit = (c: number, r: number) => {
      if (c < 0 || r < 0 || c >= this.nx || r >= this.ny) return;
      const list = this.cells[r * this.nx + c];
      if (!list) return;
      for (const i of list) {
        if (seen.has(i)) continue;
        seen.add(i);
        const d2 = segDist2(x, y, e[4 * i], e[4 * i + 1], e[4 * i + 2], e[4 * i + 3]);
        if (d2 < bestD2) {
          bestD2 = d2;
          best = i;
        }
      }
    };
    for (let r = Math.max(0, gap - 1); r <= maxR; r++) {
      if (r === 0) visit(cx, cy);
      else {
        for (let c = cx - r; c <= cx + r; c++) {
          visit(c, cy - r);
          visit(c, cy + r);
        }
        for (let q = cy - r + 1; q <= cy + r - 1; q++) {
          visit(cx - r, q);
          visit(cx + r, q);
        }
      }
      if (best >= 0 && Math.sqrt(bestD2) <= r * this.cell) break;
    }
    if (best < 0) return null;
    const [ax, ay, bx, by] = [e[4 * best], e[4 * best + 1], e[4 * best + 2], e[4 * best + 3]];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return { x: ax + t * dx, y: ay + t * dy, dist: Math.sqrt(bestD2), edge: best };
  }

  /**
   * A point `margin` metres inside the boundary nearest to (x, y) (for a point
   * outside it). Falls back to the boundary point itself where the margin
   * would leave the area (narrow necks). Null without edges.
   */
  inwardPoint(x: number, y: number, margin: number): [number, number] | null {
    const near = this.nearest(x, y);
    if (!near) return null;
    const e = this.edges;
    const i = near.edge;
    const ex = e[4 * i + 2] - e[4 * i];
    const ey = e[4 * i + 3] - e[4 * i + 1];
    const el = Math.hypot(ex, ey) || 1;
    const dirs: [number, number][] = [];
    if (near.dist > 1e-6) dirs.push([(near.x - x) / near.dist, (near.y - y) / near.dist]);
    dirs.push([-ey / el, ex / el], [ey / el, -ex / el]);
    for (const m of [margin, margin / 4]) {
      for (const [dx, dy] of dirs) {
        const gx = near.x + dx * m;
        const gy = near.y + dy * m;
        if (this.contains(gx, gy)) return [gx, gy];
      }
    }
    return [near.x, near.y];
  }
}

/**
 * One frame of the soft pull back inside: the move (dx, dy) from `from`
 * towards `goal`, exponential at `rate` per second (a spring without
 * overshoot); the last half metre is taken at once.
 */
export function clampStep(
  from: [number, number],
  goal: [number, number],
  dt: number,
  rate = 7,
): [number, number] {
  const dx = goal[0] - from[0];
  const dy = goal[1] - from[1];
  if (Math.hypot(dx, dy) < 0.5) return [dx, dy];
  const k = 1 - Math.exp(-rate * Math.max(0, Math.min(dt, 0.25)));
  return [dx * k, dy * k];
}
