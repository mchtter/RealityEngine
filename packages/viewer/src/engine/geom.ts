import {
  type Polygon,
  type TerrainGrid,
  clipPolygons,
  terrainHeightAt,
  triangulate,
} from '@kavra/core';
import { drapeOnTerrain as drapeKernel, kavraGeoReady } from '@kavra/geo';
import * as THREE from 'three/webgpu';

/**
 * City model axes (x east, y north, z up) → three.js (x, y up, z south).
 */
export const toThree = (x: number, y: number, z: number): [number, number, number] => [x, z, -y];

/** Incremental indexed-geometry builder with optional per-vertex colour / uv / finish. */
export class MeshBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  readonly uvs: number[] = [];
  readonly finish: number[] = [];
  readonly indices: number[] = [];
  /** Optional owner per triangle (e.g. building index) for picking. */
  readonly triangleOwner: number[] = [];
  /** Extra per-vertex attributes; `current` values are stamped on every new vertex. */
  private readonly extras = new Map<string, { size: number; data: number[]; current: number[] }>();

  defineAttribute(name: string, size: number): void {
    this.extras.set(name, { size, data: [], current: new Array<number>(size).fill(0) });
  }

  /** Sets the value used for this attribute on subsequently added vertices. */
  setAttribute(name: string, values: number[]): void {
    const e = this.extras.get(name);
    if (e) e.current = values;
  }

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  vertex(
    p: [number, number, number],
    n: [number, number, number],
    c?: THREE.Color,
    u = 0,
    v = 0,
    f = 0,
  ): number {
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    if (c) this.colors.push(c.r, c.g, c.b);
    this.uvs.push(u, v);
    this.finish.push(f);
    for (const e of this.extras.values()) e.data.push(...e.current);
    return this.vertexCount - 1;
  }

  /** Owner stamped on subsequent triangles that pass none (feature picking). */
  private currentOwner = -1;

  setOwner(owner: number): void {
    this.currentOwner = owner;
  }

  triangle(a: number, b: number, c: number, owner = -1): void {
    this.indices.push(a, b, c);
    this.triangleOwner.push(owner >= 0 ? owner : this.currentOwner);
  }

  /**
   * Quad in model coordinates (counter-clockwise seen from the front).
   * Points are [x, y, z] model-space; uv per corner.
   */
  quad(
    pts: [number, number, number][],
    normal: [number, number, number],
    c: THREE.Color | undefined,
    uvs: [number, number][],
    f = 0,
    owner = -1,
  ): void {
    const n = toThree(normal[0], normal[1], normal[2]);
    const i = pts.map((p, k) =>
      this.vertex(toThree(p[0], p[1], p[2]), n, c, uvs[k][0], uvs[k][1], f),
    );
    this.triangle(i[0], i[1], i[2], owner);
    this.triangle(i[0], i[2], i[3], owner);
  }

  /**
   * Appends what `src` gained since it had `vertexStart` vertices and
   * `indexStart` indices (same attribute layout, every vertex coloured).
   */
  appendFrom(src: MeshBuilder, vertexStart: number, indexStart: number): void {
    const base = this.vertexCount - vertexStart;
    const copy = (to: number[], from: number[], start: number) => {
      for (let i = start; i < from.length; i++) to.push(from[i]);
    };
    copy(this.positions, src.positions, vertexStart * 3);
    copy(this.normals, src.normals, vertexStart * 3);
    copy(this.colors, src.colors, vertexStart * 3);
    copy(this.uvs, src.uvs, vertexStart * 2);
    copy(this.finish, src.finish, vertexStart);
    for (const [name, e] of this.extras) {
      const s = src.extras.get(name);
      if (s) copy(e.data, s.data, vertexStart * s.size);
    }
    for (let i = indexStart; i < src.indices.length; i++) this.indices.push(src.indices[i] + base);
    copy(this.triangleOwner, src.triangleOwner, indexStart / 3);
  }

  build(opts: { color?: boolean; uv?: boolean; finish?: boolean } = {}): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    if (opts.color && this.colors.length)
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    if (opts.uv !== false) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    if (opts.finish) g.setAttribute('finish', new THREE.Float32BufferAttribute(this.finish, 1));
    for (const [name, e] of this.extras)
      g.setAttribute(name, new THREE.Float32BufferAttribute(e.data, e.size));
    g.setIndex(
      this.vertexCount > 65535
        ? new THREE.Uint32BufferAttribute(this.indices, 1)
        : new THREE.Uint16BufferAttribute(this.indices, 1),
    );
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** A height source: a terrain grid, or a height function (e.g. the street surface). */
export type HeightSource = TerrainGrid | ((x: number, y: number) => number);
const heightOf = (h: HeightSource, x: number, y: number) =>
  typeof h === 'function' ? h(x, y) : terrainHeightAt(h, x, y);

/**
 * Triangulates a polygon and subdivides every triangle until no edge is
 * longer than `maxEdge`, then drapes the vertices on the ground so large
 * flat polygons (roads, sidewalks) follow it. Triangles keep to the
 * polygon's own edges (unlike a grid drape, none crosses a carriageway edge).
 */
export function drapePolygon(
  mb: MeshBuilder,
  poly: Polygon,
  terrain: HeightSource,
  lift: number,
  maxEdge = 4,
  c?: THREE.Color,
): void {
  const { vertices, indices } = triangulate(poly);
  const keyOf = (x: number, y: number) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
  const cache = new Map<string, number>();
  const up: [number, number, number] = [0, 1, 0];
  const vtx = (x: number, y: number) => {
    const key = keyOf(x, y);
    let id = cache.get(key);
    if (id === undefined) {
      const z = heightOf(terrain, x, y) + lift;
      id = mb.vertex(toThree(x, y, z), up, c, x, y);
      cache.set(key, id);
    }
    return id;
  };
  const max2 = maxEdge * maxEdge;
  const stack: [number, number, number, number, number, number][] = [];
  for (let k = 0; k < indices.length; k += 3) {
    const a = indices[k] * 2;
    const b = indices[k + 1] * 2;
    const d = indices[k + 2] * 2;
    const tri: [number, number, number, number, number, number] = [
      vertices[a],
      vertices[a + 1],
      vertices[b],
      vertices[b + 1],
      vertices[d],
      vertices[d + 1],
    ];
    // Force CCW (upward facing); earcut's output winding is not guaranteed.
    const cross = (tri[2] - tri[0]) * (tri[5] - tri[1]) - (tri[3] - tri[1]) * (tri[4] - tri[0]);
    if (Math.abs(cross) < 1e-9) continue;
    stack.push(cross > 0 ? tri : [tri[0], tri[1], tri[4], tri[5], tri[2], tri[3]]);
  }
  let guard = 0;
  while (stack.length && guard++ < 2_000_000) {
    const [ax, ay, bx, by, cx, cy] = stack.pop()!;
    const lab = (bx - ax) ** 2 + (by - ay) ** 2;
    const lbc = (cx - bx) ** 2 + (cy - by) ** 2;
    const lca = (ax - cx) ** 2 + (ay - cy) ** 2;
    const longest = Math.max(lab, lbc, lca);
    if (longest <= max2) {
      mb.triangle(vtx(ax, ay), vtx(bx, by), vtx(cx, cy));
      continue;
    }
    if (longest === lab) {
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      stack.push([ax, ay, mx, my, cx, cy], [mx, my, bx, by, cx, cy]);
    } else if (longest === lbc) {
      const mx = (bx + cx) / 2;
      const my = (by + cy) / 2;
      stack.push([ax, ay, bx, by, mx, my], [ax, ay, mx, my, cx, cy]);
    } else {
      const mx = (cx + ax) / 2;
      const my = (cy + ay) / 2;
      stack.push([ax, ay, bx, by, mx, my], [mx, my, bx, by, cx, cy]);
    }
  }
}

/**
 * Height of the terrain mesh built from every `step`-th grid node (see
 * terrainMesh): same (i, j) → (i + 1, j + 1) diagonal as terrainHeightAt.
 */
export function gridHeightAt(t: TerrainGrid, step: number, x: number, y: number): number {
  if (step === 1) return terrainHeightAt(t, x, y);
  const cs = t.cellSize * step;
  const nx = Math.floor((t.cols - 1) / step);
  const ny = Math.floor((t.rows - 1) / step);
  const fx = Math.min(Math.max((x - t.minX) / cs, 0), nx - 0.0001);
  const fy = Math.min(Math.max((y - t.minY) / cs, 0), ny - 0.0001);
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const u = fx - i;
  const v = fy - j;
  const h = (ii: number, jj: number) => t.heights[jj * step * t.cols + ii * step];
  const h00 = h(i, j);
  const h11 = h(i + 1, j + 1);
  if (u >= v) return h00 + (h(i + 1, j) - h00) * u + (h11 - h(i + 1, j)) * v;
  return h00 + (h11 - h(i, j + 1)) * u + (h(i, j + 1) - h00) * v;
}

type P2 = [number, number];

/**
 * Drapes a polygon exactly onto the terrain mesh (`step`: every `step`-th grid
 * node, 1 = full grid): each piece lies inside one terrain triangle and runs
 * parallel to it at `lift` metres, so terrain creases never rise through a thin
 * surface. Cell-first (see drapeCells): whole cells are the terrain's own
 * triangles, only edge cells are cut.
 */
export function drapeOnTerrain(
  mb: MeshBuilder,
  poly: Polygon,
  terrain: TerrainGrid,
  lift: number,
  step = 1,
  onFullCell?: (i: number, j: number) => void,
): void {
  // The Rust kernel (crates/kavra-geo as WebAssembly) once the worker has
  // loaded it: the same algorithm ~5× faster on Ankara tiles, and exact where
  // the boolean path here lost or doubled area round holes (2026-10-15, D-008).
  if (kavraGeoReady()) {
    const { vertices, triangles, cells, data } = drapeKernel(terrain, poly, lift, step);
    const up: [number, number, number] = [0, 1, 0];
    const base = mb.vertexCount;
    for (let k = 0; k < vertices; k++) {
      const x = data[3 + k * 3];
      const y = data[4 + k * 3];
      mb.vertex(toThree(x, y, data[5 + k * 3]), up, undefined, x, y);
    }
    const ix = 3 + vertices * 3;
    for (let k = 0; k < triangles; k++)
      mb.triangle(
        base + data[ix + k * 3],
        base + data[ix + k * 3 + 1],
        base + data[ix + k * 3 + 2],
      );
    if (onFullCell) {
      const c0 = ix + triangles * 3;
      for (let k = 0; k < cells; k++) onFullCell(data[c0 + k * 2], data[c0 + k * 2 + 1]);
    }
    return;
  }
  drapeCells(
    mb,
    poly,
    terrain,
    (x, y) => gridHeightAt(terrain, step, x, y),
    lift,
    step,
    undefined,
    onFullCell,
  );
}

/** Vertical strip along a ring (kerbs, parapets), draped on the terrain. */
export function drapeRingWall(
  mb: MeshBuilder,
  ring: [number, number][],
  terrain: HeightSource,
  top: number,
  bottom: number,
  outward: boolean,
  step = 2,
  /** Edges to leave out (e.g. cuts along a ground chunk border). */
  skip?: (a: [number, number], b: [number, number]) => boolean,
  /**
   * The ground drawn beside the ring: the face reaches down to it where it
   * lies lower than `bottom`, and a retaining face (towards the ring) rises to
   * it where it stands above `top` — no gap between the two either way.
   */
  beside?: HeightSource,
): void {
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    if (skip?.(a, b)) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    const at = (f: number): [number, number] => [
      a[0] + (b[0] - a[0]) * f,
      a[1] + (b[1] - a[1]) * f,
    ];
    // Metre samples of the ground beside: where it reaches the top the face
    // follows it metre by metre (the ground bends between the long steps).
    const metres = Math.max(1, Math.ceil(len));
    let rises = false;
    if (beside)
      for (let s = 0; s <= metres && !rises; s++) {
        const p = at(s / metres);
        rises = heightOf(beside, p[0], p[1]) > heightOf(terrain, p[0], p[1]) + top - 0.02;
      }
    const n = rises ? metres : Math.max(1, Math.ceil(len / step));
    const dx = (b[0] - a[0]) / len;
    const dy = (b[1] - a[1]) / len;
    // CCW outer ring: outward normal is the right-hand side.
    const nx = outward ? dy : -dy;
    const ny = outward ? -dx : dx;
    const per = Math.max(1, Math.round(metres / n));
    for (let s = 0; s < n; s++) {
      const p0 = at(s / n);
      const p1 = at((s + 1) / n);
      const z0 = heightOf(terrain, p0[0], p0[1]);
      const z1 = heightOf(terrain, p1[0], p1[1]);
      let low = Infinity;
      let g0 = -Infinity;
      let g1 = -Infinity;
      if (beside) {
        g0 = heightOf(beside, p0[0], p0[1]);
        g1 = heightOf(beside, p1[0], p1[1]);
        // The face's foot below the lowest ground along the piece (it is hidden there).
        for (let m = 0; m <= per; m++) {
          const q = at((s + m / per) / n);
          low = Math.min(low, heightOf(beside, q[0], q[1]) - 0.05);
        }
      }
      const b0 = Math.min(z0 + bottom, low);
      const b1 = Math.min(z1 + bottom, low);
      const pts: [number, number, number][] = outward
        ? [
            [p0[0], p0[1], b0],
            [p1[0], p1[1], b1],
            [p1[0], p1[1], z1 + top],
            [p0[0], p0[1], z0 + top],
          ]
        : [
            [p1[0], p1[1], b1],
            [p0[0], p0[1], b0],
            [p0[0], p0[1], z0 + top],
            [p1[0], p1[1], z1 + top],
          ];
      mb.quad(pts, [nx, ny, 0], undefined, [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]);
      if (!(g0 > z0 + top || g1 > z1 + top)) continue;
      // Retaining face: from the surface's top up to the ground, facing the surface.
      const t0 = Math.max(g0, z0 + top);
      const t1 = Math.max(g1, z1 + top);
      const up: [number, number, number][] = outward
        ? [
            [p1[0], p1[1], z1 + top],
            [p0[0], p0[1], z0 + top],
            [p0[0], p0[1], t0],
            [p1[0], p1[1], t1],
          ]
        : [
            [p0[0], p0[1], z0 + top],
            [p1[0], p1[1], z1 + top],
            [p1[0], p1[1], t1],
            [p0[0], p0[1], t0],
          ];
      mb.quad(up, [-nx, -ny, 0], undefined, [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]);
    }
  }
}

/** Box geometry with a flat vertex colour, positioned by its min corner offset. */
export function coloredBox(
  w: number,
  h: number,
  d: number,
  c: THREE.Color,
  offset: [number, number, number] = [0, 0, 0],
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(offset[0], offset[1], offset[2]);
  return paint(g, c);
}

export function paint(g: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

// ─── Cell-first draping (one thin layer, as few triangles as the grid allows) ─

type Ring2 = P2[];
interface Piece {
  outer: Ring2;
  holes: Ring2[];
}

const ringArea2 = (r: Ring2) => {
  let s = 0;
  for (let k = 0; k < r.length; k++) {
    const p = r[k];
    const q = r[(k + 1) % r.length];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(s / 2);
};
const piecesArea = (ps: Piece[]) =>
  ps.reduce((s, p) => s + ringArea2(p.outer) - p.holes.reduce((h, r) => h + ringArea2(r), 0), 0);
const ccw = (r: Ring2): Ring2 => {
  let s = 0;
  for (let k = 0; k < r.length; k++) {
    const p = r[k];
    const q = r[(k + 1) % r.length];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s < 0 ? [...r].reverse() : r;
};

/** Axis-aligned bounds of a ring: [minX, minY, maxX, maxY]. */
function ringBox(r: Ring2): [number, number, number, number] {
  let a = Infinity;
  let b = Infinity;
  let c = -Infinity;
  let d = -Infinity;
  for (const [x, y] of r) {
    if (x < a) a = x;
    if (y < b) b = y;
    if (x > c) c = x;
    if (y > d) d = y;
  }
  return [a, b, c, d];
}

/** True for a convex ring (no turn against the others). */
function isConvex(r: Ring2): boolean {
  let sign = 0;
  for (let k = 0; k < r.length; k++) {
    const a = r[k];
    const b = r[(k + 1) % r.length];
    const c = r[(k + 2) % r.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

/** Sutherland–Hodgman: a ring clipped to a convex counter-clockwise window. */
function clipRingConvex(ring: Ring2, win: Ring2): Ring2 {
  let out = ring;
  for (let e = 0; e < win.length && out.length; e++) {
    const a = win[e];
    const b = win[(e + 1) % win.length];
    const side = (p: P2) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const input = out;
    out = [];
    for (let k = 0; k < input.length; k++) {
      const p = input[k];
      const q = input[(k + 1) % input.length];
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) out.push(p);
      if (sp >= 0 !== sq >= 0) {
        const t = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out;
}

/**
 * Pieces clipped to a convex window (`win`, bounds `wb`). Rings wholly inside
 * the window are kept and rings wholly outside dropped without clipping. A
 * piece whose hole crosses the window edge goes through the exact boolean
 * clip: the hole then becomes part of the outline (the plain ring clip would
 * leave it touching the outline, which triangulation does not subtract).
 */
function clipPieces(
  pieces: Piece[],
  win: Ring2,
  wb: [number, number, number, number],
  rectWindow: boolean,
): Piece[] {
  const inside = (b: number[]) =>
    rectWindow && b[0] >= wb[0] && b[1] >= wb[1] && b[2] <= wb[2] && b[3] <= wb[3];
  const outside = (b: number[]) => b[2] <= wb[0] || b[0] >= wb[2] || b[3] <= wb[1] || b[1] >= wb[3];
  const out: Piece[] = [];
  for (const p of pieces) {
    const ob = ringBox(p.outer);
    if (outside(ob)) continue;
    if (inside(ob)) {
      out.push(p);
      continue;
    }
    const holes = p.holes.filter((h) => !outside(ringBox(h)));
    // Exact boolean clip: a hole crossing the window edge (it becomes part of
    // the outline), or a concave outline cut by a cell triangle (the plain ring
    // clip leaves seams along the window that triangulation may fill twice).
    if (holes.some((h) => !inside(ringBox(h))) || (!rectWindow && !isConvex(p.outer))) {
      for (const q of clipPolygons(
        [{ outer: p.outer, holes } as Polygon],
        [{ outer: win, holes: [] }],
      ))
        out.push({ outer: ccw(q.outer as Ring2), holes: (q.holes as Ring2[]).map(ccw) });
      continue;
    }
    const o = clipRingConvex(p.outer, win);
    if (o.length >= 3 && ringArea2(o) > 1e-6) out.push({ outer: o, holes });
  }
  return out;
}

/**
 * Drapes a polygon as one thin layer on a square grid (the terrain mesh's
 * cells, `cellSize`): a quadtree clips the polygon to ever smaller squares; a
 * square it covers whole is emitted as the grid's own triangles (2 per cell,
 * split along the (i, j) → (i + 1, j + 1) diagonal like the terrain), and only
 * cells on its edge are cut to their two triangles. Heights come from
 * `heightAt` at every vertex, so on the terrain grid each piece lies exactly in
 * its terrain triangle. On a dense İzmir tile: 57 % fewer surface triangles
 * than cutting each triangulation triangle along every grid line, same area.
 */
export function drapeCells(
  mb: MeshBuilder,
  poly: Polygon,
  grid: Pick<TerrainGrid, 'minX' | 'minY' | 'cellSize'>,
  heightAt: (x: number, y: number) => number,
  lift: number,
  step = 1,
  c?: THREE.Color,
  /** Each grid cell (i, j) the polygon covers whole: the layer under it need not be drawn. */
  onFullCell?: (i: number, j: number) => void,
): void {
  const cs = grid.cellSize * step;
  const ox = grid.minX;
  const oy = grid.minY;
  const cache = new Map<string, number>();
  const up: [number, number, number] = [0, 1, 0];
  const vtx = (p: P2) => {
    const key = `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
    let id = cache.get(key);
    if (id === undefined) {
      id = mb.vertex(toThree(p[0], p[1], heightAt(p[0], p[1]) + lift), up, c, p[0], p[1]);
      cache.set(key, id);
    }
    return id;
  };
  const emit = (a: P2, b: P2, d: P2) => {
    const ia = vtx(a);
    const ib = vtx(b);
    const id = vtx(d);
    if (ia !== ib && ib !== id && ia !== id) mb.triangle(ia, ib, id);
  };
  const triangulatePieces = (pieces: Piece[]) => {
    for (const p of pieces) {
      const { vertices: v, indices: ix } = triangulate(p as unknown as Polygon);
      for (let k = 0; k < ix.length; k += 3) {
        const a: P2 = [v[ix[k] * 2], v[ix[k] * 2 + 1]];
        let b: P2 = [v[ix[k + 1] * 2], v[ix[k + 1] * 2 + 1]];
        let d: P2 = [v[ix[k + 2] * 2], v[ix[k + 2] * 2 + 1]];
        const cross = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
        if (Math.abs(cross) < 1e-9) continue;
        // Upward facing (CCW from above); earcut's winding is not guaranteed.
        if (cross < 0) [b, d] = [d, b];
        emit(a, b, d);
      }
    }
  };
  const visit = (pieces: Piece[], i0: number, j0: number, n: number) => {
    if (!pieces.length) return;
    const x0 = ox + i0 * cs;
    const y0 = oy + j0 * cs;
    if (piecesArea(pieces) >= n * cs * n * cs * (1 - 1e-6)) {
      for (let j = j0; j < j0 + n; j++)
        for (let i = i0; i < i0 + n; i++) {
          const a = ox + i * cs;
          const b = oy + j * cs;
          emit([a, b], [a + cs, b], [a + cs, b + cs]);
          emit([a, b], [a + cs, b + cs], [a, b + cs]);
          onFullCell?.(i, j);
        }
      return;
    }
    if (n === 1) {
      const x1 = x0 + cs;
      const y1 = y0 + cs;
      triangulatePieces(
        clipPieces(
          pieces,
          [
            [x0, y0],
            [x1, y0],
            [x1, y1],
          ],
          [x0, y0, x1, y1],
          false,
        ),
      );
      triangulatePieces(
        clipPieces(
          pieces,
          [
            [x0, y0],
            [x1, y1],
            [x0, y1],
          ],
          [x0, y0, x1, y1],
          false,
        ),
      );
      return;
    }
    const h = n >> 1;
    for (const [di, dj] of [
      [0, 0],
      [h, 0],
      [0, h],
      [h, h],
    ]) {
      const sx = x0 + di * cs;
      const sy = y0 + dj * cs;
      const ex = sx + h * cs;
      const ey = sy + h * cs;
      visit(
        clipPieces(
          pieces,
          [
            [sx, sy],
            [ex, sy],
            [ex, ey],
            [sx, ey],
          ],
          [sx, sy, ex, ey],
          true,
        ),
        i0 + di,
        j0 + dj,
        h,
      );
    }
  };
  const [minX, minY, maxX, maxY] = ringBox(poly.outer as Ring2);
  if (!Number.isFinite(minX)) return;
  const i0 = Math.floor((minX - ox) / cs);
  const j0 = Math.floor((minY - oy) / cs);
  let n = 1;
  while (ox + (i0 + n) * cs < maxX || oy + (j0 + n) * cs < maxY) n *= 2;
  visit([{ outer: ccw(poly.outer as Ring2), holes: (poly.holes as Ring2[]).map(ccw) }], i0, j0, n);
}
