import { type Polygon, type TerrainGrid, terrainHeightAt, triangulate } from '@opentwin/city-core';
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

  triangle(a: number, b: number, c: number, owner = -1): void {
    this.indices.push(a, b, c);
    this.triangleOwner.push(owner);
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

/**
 * Triangulates a polygon and subdivides every triangle until no edge is
 * longer than `maxEdge`, then drapes the vertices on the terrain so large
 * flat polygons (roads, sidewalks) follow the ground.
 */
export function drapePolygon(
  mb: MeshBuilder,
  poly: Polygon,
  terrain: TerrainGrid,
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
      const z = terrainHeightAt(terrain, x, y) + lift;
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

/** Splits a convex polygon by the line f(p) = 0 into its f ≤ 0 and f ≥ 0 parts. */
function splitConvex(poly: P2[], f: (p: P2) => number, snap: (p: P2) => P2): [P2[], P2[]] {
  const neg: P2[] = [];
  const pos: P2[] = [];
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % poly.length];
    const fa = f(a);
    const fb = f(b);
    if (fa <= 0) neg.push(a);
    if (fa >= 0) pos.push(a);
    if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) {
      const t = fa / (fa - fb);
      const p = snap([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      neg.push(p);
      pos.push(p);
    }
  }
  return [neg, pos];
}

const areaOf = (poly: P2[]) => {
  let s = 0;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
};

/**
 * Drapes a polygon exactly onto the terrain mesh: its triangles are cut along
 * every grid line and cell diagonal of the mesh, so each piece lies inside one
 * terrain triangle and runs parallel to it at `lift` metres. (Plain
 * subdivision only matched the terrain at the vertices; terrain creases in
 * between rose through thin road surfaces as green patches and z-fighting.)
 * `step` selects the mesh: every `step`-th grid node (1 = full grid).
 */
export function drapeOnTerrain(
  mb: MeshBuilder,
  poly: Polygon,
  terrain: TerrainGrid,
  lift: number,
  step = 1,
): void {
  const { vertices, indices } = triangulate(poly);
  const cs = terrain.cellSize * step;
  const keyOf = (x: number, y: number) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
  const cache = new Map<string, number>();
  const up: [number, number, number] = [0, 1, 0];
  const vtx = (p: P2) => {
    const key = keyOf(p[0], p[1]);
    let id = cache.get(key);
    if (id === undefined) {
      const z = gridHeightAt(terrain, step, p[0], p[1]) + lift;
      id = mb.vertex(toThree(p[0], p[1], z), up, undefined, p[0], p[1]);
      cache.set(key, id);
    }
    return id;
  };
  // Line families of the mesh: x = const, y = const, x − y = const (diagonals).
  const families: { g: (p: P2) => number; o: number; snap: (p: P2, v: number) => P2 }[] = [
    { g: (p) => p[0], o: terrain.minX, snap: (p, v) => [v, p[1]] },
    { g: (p) => p[1], o: terrain.minY, snap: (p, v) => [p[0], v] },
    { g: (p) => p[0] - p[1], o: terrain.minX - terrain.minY, snap: (p) => p },
  ];
  for (let k = 0; k < indices.length; k += 3) {
    let tri: P2[] = [
      [vertices[indices[k] * 2], vertices[indices[k] * 2 + 1]],
      [vertices[indices[k + 1] * 2], vertices[indices[k + 1] * 2 + 1]],
      [vertices[indices[k + 2] * 2], vertices[indices[k + 2] * 2 + 1]],
    ];
    const a = areaOf(tri);
    if (Math.abs(a) < 1e-9) continue;
    // Upward facing (CCW from above); earcut's winding is not guaranteed.
    if (a < 0) tri = [tri[0], tri[2], tri[1]];
    let pieces: P2[][] = [tri];
    for (const fam of families) {
      const next: P2[][] = [];
      for (const piece of pieces) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const p of piece) {
          const v = fam.g(p);
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
        let rest = piece;
        for (let m = Math.floor((lo - fam.o) / cs) + 1; fam.o + m * cs < hi; m++) {
          const line = fam.o + m * cs;
          const [below, above] = splitConvex(
            rest,
            (p) => fam.g(p) - line,
            (p) => fam.snap(p, line),
          );
          if (below.length >= 3 && Math.abs(areaOf(below)) > 1e-6) next.push(below);
          rest = above;
          if (rest.length < 3) break;
        }
        if (rest.length >= 3 && Math.abs(areaOf(rest)) > 1e-6) next.push(rest);
      }
      pieces = next;
    }
    for (const piece of pieces) {
      const ids = piece.map(vtx);
      for (let m = 1; m < ids.length - 1; m++) {
        if (ids[0] !== ids[m] && ids[m] !== ids[m + 1] && ids[0] !== ids[m + 1]) {
          mb.triangle(ids[0], ids[m], ids[m + 1]);
        }
      }
    }
  }
}

/** Vertical strip along a ring (kerbs, parapets), draped on the terrain. */
export function drapeRingWall(
  mb: MeshBuilder,
  ring: [number, number][],
  terrain: TerrainGrid,
  top: number,
  bottom: number,
  outward: boolean,
  step = 2,
  /** Edges to leave out (e.g. cuts along a ground chunk border). */
  skip?: (a: [number, number], b: [number, number]) => boolean,
): void {
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    if (skip?.(a, b)) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    const n = Math.max(1, Math.ceil(len / step));
    const dx = (b[0] - a[0]) / len;
    const dy = (b[1] - a[1]) / len;
    // CCW outer ring: outward normal is the right-hand side.
    const nx = outward ? dy : -dy;
    const ny = outward ? -dx : dx;
    for (let s = 0; s < n; s++) {
      const p0: [number, number] = [a[0] + (b[0] - a[0]) * (s / n), a[1] + (b[1] - a[1]) * (s / n)];
      const p1: [number, number] = [
        a[0] + (b[0] - a[0]) * ((s + 1) / n),
        a[1] + (b[1] - a[1]) * ((s + 1) / n),
      ];
      const z0 = terrainHeightAt(terrain, p0[0], p0[1]);
      const z1 = terrainHeightAt(terrain, p1[0], p1[1]);
      const pts: [number, number, number][] = outward
        ? [
            [p0[0], p0[1], z0 + bottom],
            [p1[0], p1[1], z1 + bottom],
            [p1[0], p1[1], z1 + top],
            [p0[0], p0[1], z0 + top],
          ]
        : [
            [p1[0], p1[1], z1 + bottom],
            [p0[0], p0[1], z0 + bottom],
            [p0[0], p0[1], z0 + top],
            [p1[0], p1[1], z1 + top],
          ];
      mb.quad(pts, [nx, ny, 0], undefined, [
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
