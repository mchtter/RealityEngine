import {
  type Bridge,
  type CityModel,
  CutGround,
  GroundModel,
  type Polygon,
  type RoadSurface,
  SURFACE_LIFT,
  type SurfaceKind,
  type TerrainGrid,
  bufferPolyline,
  clipPolygons,
  deckPriority,
  offsetPolygons,
  pointInRing,
  rectPolygon,
  subtractPolygons,
  TWIN_MEDIAN,
  terrainHeightAt,
  triangulate,
  unionPolygons,
} from '@opentwin/city-core';
import * as THREE from 'three/webgpu';
import { MeshBuilder, drapeOnTerrain, drapePolygon, drapeRingWall, toThree } from './geom';
import type { DtMaterials } from './materials';

/** Ground cell size (m) — the frustum culling unit of terrain and road surfaces. */
const CHUNK = 1000;

/** `surf` attribute values of the merged ground material (see materials.ts). */
const SURF: Record<SurfaceKind, number> = {
  asphalt: 0,
  paving: 1,
  sidewalk: 2,
  path: 3,
  island: 4,
  yard: 5,
  concrete: 7,
  parking: 8,
  playground: 9,
};
const SURF_KERB = 6;

/**
 * Height of each surface above the (road-conformed) terrain, metres. Surfaces
 * run exactly parallel to the terrain (drapeOnTerrain), so these fixed steps
 * are the whole layer order: terrain < yard < asphalt < markings < path <
 * paving < sidewalk / island (kerb height above the road).
 */
const LIFT = SURFACE_LIFT;
/** Lane markings / zebra stripes above the asphalt. */
const MARKING_LIFT = LIFT.asphalt + 0.025;
/**
 * Far tiles (> 900 m): terrain from every FAR_STEP-th grid node (40 m) and the
 * surfaces cut to that same mesh. Must divide the tile's 250 grid cells.
 */
const FAR_STEP = 10;
/** Extra lift of far surfaces: depth precision is coarser far away. */
const FAR_LIFT = 0.25;
/** Markings are re-sampled this often so they follow terrain creases along the road. */
const RIBBON_STEP = 2;

/** Terrain normal (three.js axes) at grid node (i, j), from central differences over the whole grid. */
function nodeNormal(t: TerrainGrid, i: number, j: number): [number, number, number] {
  const h = (a: number, b: number) =>
    t.heights[Math.min(t.rows - 1, Math.max(0, b)) * t.cols + Math.min(t.cols - 1, Math.max(0, a))];
  const dx =
    (h(i + 1, j) - h(i - 1, j)) / ((Math.min(t.cols - 1, i + 1) - Math.max(0, i - 1)) * t.cellSize);
  const dy =
    (h(i, j + 1) - h(i, j - 1)) / ((Math.min(t.rows - 1, j + 1) - Math.max(0, j - 1)) * t.cellSize);
  const l = Math.hypot(dx, dy, 1);
  return toThree(-dx / l, -dy / l, 1 / l);
}

/** Node normals blended bilinearly at a model point (matches the full-grid mesh's shading). */
function gridNormal(t: TerrainGrid, x: number, y: number): [number, number, number] {
  const fx = Math.min(t.cols - 1.001, Math.max(0, (x - t.minX) / t.cellSize));
  const fy = Math.min(t.rows - 1.001, Math.max(0, (y - t.minY) / t.cellSize));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const u = fx - i;
  const v = fy - j;
  const n: [number, number, number] = [0, 0, 0];
  for (const [a, b, w] of [
    [i, j, (1 - u) * (1 - v)],
    [i + 1, j, u * (1 - v)],
    [i, j + 1, (1 - u) * v],
    [i + 1, j + 1, u * v],
  ]) {
    const m = nodeNormal(t, a, b);
    for (let k = 0; k < 3; k++) n[k] += m[k] * w;
  }
  const l = Math.hypot(...n) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

/** Drapes a polygon on a grid with terrain shading (smooth grid normals, not flat up). */
function drapeShaded(mb: MeshBuilder, poly: Polygon, grid: TerrainGrid): void {
  const first = mb.vertexCount;
  drapeOnTerrain(mb, poly, grid, 0);
  for (let v = first; v < mb.vertexCount; v++) {
    const n = gridNormal(grid, mb.positions[v * 3], -mb.positions[v * 3 + 2]);
    mb.normals.splice(v * 3, 3, ...n);
  }
}

/** Grid cells (index of their lower-left node) that a footprint overlaps. */
function cellsUnder(t: TerrainGrid, holes: Polygon[]): Set<number> {
  const out = new Set<number>();
  for (const h of holes) {
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const q of h.outer)
      b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[0]), Math.max(b[3], q[1])];
    const i0 = Math.max(0, Math.floor((b[0] - t.minX) / t.cellSize));
    const i1 = Math.min(t.cols - 2, Math.floor((b[2] - t.minX) / t.cellSize));
    const j0 = Math.max(0, Math.floor((b[1] - t.minY) / t.cellSize));
    const j1 = Math.min(t.rows - 2, Math.floor((b[3] - t.minY) / t.cellSize));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const idx = j * t.cols + i;
        if (out.has(idx)) continue;
        const x = t.minX + i * t.cellSize;
        const y = t.minY + j * t.cellSize;
        const cell = rectPolygon(x, y, x + t.cellSize, y + t.cellSize);
        if (clipPolygons([h], [cell]).length) out.add(idx);
      }
    }
  }
  return out;
}

/**
 * Terrain mesh sampling every `step`-th grid node (1 = full 4 m grid), with
 * a skirt hanging `skirt` metres down along the tile edge so neighbouring
 * tiles at a different resolution never show cracks. Cells in `skip` (full
 * grid only) are left out: they are drawn carved around a cutting.
 */
function terrainMesh(
  t: TerrainGrid,
  mat: THREE.Material,
  step = 1,
  skirt = 0,
  /** Grid node range [i0, j0, i1, j1] (inclusive); whole grid by default. */
  range?: [number, number, number, number],
  skip?: Set<number>,
  /** Where the skirt must not hang down (over a tunnel tube it would cut across it). */
  noSkirt?: (x: number, y: number) => boolean,
): THREE.Mesh {
  const [i0, j0, i1, j1] = range ?? [0, 0, t.cols - 1, t.rows - 1];
  const cols = Math.floor((i1 - i0) / step) + 1;
  const rows = Math.floor((j1 - j0) / step) + 1;
  const positions: number[] = [];
  const gi = (i: number) => i0 + i * step;
  const gj = (j: number) => j0 + j * step;
  const height = (i: number, j: number) => t.heights[gj(j) * t.cols + gi(i)];
  const at = (i: number, j: number, dz = 0) =>
    toThree(t.minX + gi(i) * t.cellSize, t.minY + gj(j) * t.cellSize, height(i, j) - dz);
  // Normals from the whole tile grid (central differences), not per mesh:
  // computeVertexNormals on each chunk bent its edge normals towards the skirt
  // and its own triangles only, drawing a shading seam along every chunk and
  // tile border.
  const normals: number[] = [];
  const normalAt = (i: number, j: number) => nodeNormal(t, gi(i), gj(j));
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      positions.push(...at(i, j));
      normals.push(...normalAt(i, j));
    }
  }
  // Same diagonal as terrainHeightAt: (i,j)-(i+1,j+1).
  const indices: number[] = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      if (step === 1 && skip?.has(gj(j) * t.cols + gi(i))) continue;
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols + 1;
      const d = a + cols;
      indices.push(a, b, c, a, c, d);
    }
  }
  if (skirt > 0) {
    // Perimeter, counter-clockwise from above, with a dropped copy of every vertex.
    const ring: [number, number][] = [];
    for (let i = 0; i < cols - 1; i++) ring.push([i, 0]);
    for (let j = 0; j < rows - 1; j++) ring.push([cols - 1, j]);
    for (let i = cols - 1; i > 0; i--) ring.push([i, rows - 1]);
    for (let j = rows - 1; j > 0; j--) ring.push([0, j]);
    const top = ring.map(([i, j]) => j * cols + i);
    const bottom = ring.map(([i, j]) => {
      const k = positions.length / 3;
      positions.push(...at(i, j, skirt));
      normals.push(...normalAt(i, j));
      return k;
    });
    const xy = ([i, j]: [number, number]): [number, number] => [
      t.minX + gi(i) * t.cellSize,
      t.minY + gj(j) * t.cellSize,
    ];
    for (let k = 0; k < ring.length; k++) {
      const n = (k + 1) % ring.length;
      // A skirt piece is left out whole where it would hang into a cut (a
      // piece dropped at one end only stood as a big slanted triangle).
      if (noSkirt) {
        const a = xy(ring[k]);
        const b = xy(ring[n]);
        const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (noSkirt(...a) || noSkirt(...b) || noSkirt(...mid)) continue;
      }
      // Outward-facing quad (top edge k → n, dropped below).
      indices.push(top[k], bottom[k], bottom[n], top[k], bottom[n], top[n]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(
    positions.length / 3 > 65535
      ? new THREE.Uint32BufferAttribute(indices, 1)
      : new THREE.Uint16BufferAttribute(indices, 1),
  );
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true;
  mesh.name = step === 1 ? 'terrain' : 'terrain-coarse';
  return mesh;
}

/**
 * The terrain as drawn under the street surface: every grid node next to a
 * street (any sample of the surface within one cell) sits 0.3 m below the
 * lowest surface point around it. The grid's triangles interpolate between
 * nodes; one spanning a road and a higher median would otherwise rise through
 * the asphalt between them.
 */
function underStreet(t: TerrainGrid, surface: RoadSurface): TerrainGrid {
  // Surface sampled once on a half-cell grid (NaN off the streets), then the
  // minimum over the 5 × 5 samples around each node.
  const sc = (t.cols - 1) * 2 + 1;
  const sr = (t.rows - 1) * 2 + 1;
  const half = t.cellSize / 2;
  const samples = new Float32Array(sc * sr);
  let any = false;
  for (let j = 0; j < sr; j++) {
    for (let i = 0; i < sc; i++) {
      const z = surface.heightAt(t.minX + i * half, t.minY + j * half);
      samples[j * sc + i] = z ?? Number.NaN;
      if (z !== null) any = true;
    }
  }
  if (!any) return t;
  const heights = t.heights.slice();
  for (let j = 0; j < t.rows; j++) {
    for (let i = 0; i < t.cols; i++) {
      let low = Infinity;
      for (let b = Math.max(0, 2 * j - 2); b <= Math.min(sr - 1, 2 * j + 2); b++) {
        for (let a = Math.max(0, 2 * i - 2); a <= Math.min(sc - 1, 2 * i + 2); a++) {
          const z = samples[b * sc + a];
          if (z < low) low = z;
        }
      }
      if (low === Infinity) continue;
      const idx = j * t.cols + i;
      heights[idx] = Math.min(heights[idx], low - 0.3);
    }
  }
  return { ...t, heights };
}

/** Sea: a plane at sea level over the tile. */
export function seaPlane(
  model: Pick<CityModel, 'bounds' | 'terrain'>,
  mats: DtMaterials,
): THREE.Mesh {
  const b = model.bounds;
  // The tile's own extent (the terrain covers it where it is above the sea).
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(b.maxX - b.minX, b.maxY - b.minY), mats.water);
  sea.rotation.x = -Math.PI / 2;
  sea.position.set((b.minX + b.maxX) / 2, model.terrain.seaLevel, -(b.minY + b.maxY) / 2);
  sea.receiveShadow = true;
  sea.name = 'sea';
  return sea;
}

/** Inserts points so no segment is longer than `step` metres. */
function distToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const k = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - dx * k, p[1] - a[1] - dy * k);
}

function densify(pts: [number, number][], step: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < pts.length; k++) {
    if (k > 0) {
      const a = pts[k - 1];
      const b = pts[k];
      const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step);
      for (let s = 1; s < n; s++) {
        out.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
      }
    }
    out.push(pts[k]);
  }
  return out;
}

function ribbon(
  mb: MeshBuilder,
  heightAt: (x: number, y: number) => number,
  line: [number, number][],
  width: number,
  lift: number,
): void {
  const pts = densify(line, RIBBON_STEP);
  const half = width / 2;
  let prev: [number, number] | null = null;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    const n0 = pts[Math.max(0, k - 1)];
    const n1 = pts[Math.min(pts.length - 1, k + 1)];
    const dx = n1[0] - n0[0];
    const dy = n1[1] - n0[1];
    const l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l;
    const ny = dx / l;
    const z = heightAt(p[0], p[1]) + lift;
    const left = mb.vertex(toThree(p[0] + nx * half, p[1] + ny * half, z), [0, 1, 0]);
    const right = mb.vertex(toThree(p[0] - nx * half, p[1] - ny * half, z), [0, 1, 0]);
    if (prev) {
      // prev = [left, right] of the previous station; right side first keeps CCW from above.
      mb.triangle(prev[1], right, left);
      mb.triangle(prev[1], left, prev[0]);
    }
    prev = [left, right];
  }
}

/** Splits a polyline into dash runs (on/off metres). */
function dashes(pts: [number, number][], on: number, off: number): [number, number][][] {
  const out: [number, number][][] = [];
  let run: [number, number][] = [];
  let phase = 0;
  let drawing = true;
  for (let k = 1; k < pts.length; k++) {
    let a = pts[k - 1];
    const b = pts[k];
    let segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (segLen > 1e-6) {
      const limit = (drawing ? on : off) - phase;
      const step = Math.min(limit, segLen);
      const t = step / segLen;
      const p: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (drawing) {
        if (!run.length) run.push(a);
        run.push(p);
      }
      phase += step;
      segLen -= step;
      a = p;
      if (phase >= (drawing ? on : off) - 1e-6) {
        if (drawing && run.length >= 2) out.push(run);
        run = [];
        drawing = !drawing;
        phase = 0;
      }
    }
  }
  if (drawing && run.length >= 2) out.push(run);
  return out;
}

export function buildGround(
  model: CityModel,
  mats: DtMaterials,
  opts: { sea?: boolean } = {},
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'ground';
  // Ground is cut into CHUNK-metre cells so frustum culling can drop the parts
  // out of view (a whole 1 km tile used to be one mesh). Far tiles switch to
  // one coarse 20 m terrain mesh (CityTile toggles `ground:near` / `ground:far`).
  const t = model.terrain;
  const per = Math.max(1, Math.round(CHUNK / t.cellSize));
  // Tubes, their end segments extended: a tube's part in this tile may end at
  // a vertex short of the tile edge, the neighbour drawing the rest.
  const tubes = (model.tunnels ?? []).map((tn) => {
    const p = tn.path.map((q) => [q[0], q[1]] as [number, number]);
    const ext = (a: [number, number], b: [number, number]): [number, number] => {
      const l = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
      return [a[0] + ((a[0] - b[0]) / l) * 60, a[1] + ((a[1] - b[1]) / l) * 60];
    };
    return {
      half: tn.width / 2 + 2,
      path: [ext(p[0], p[1]), ...p, ext(p[p.length - 1], p[p.length - 2])],
    };
  });
  const overTube = (x: number, y: number) =>
    tubes.some((tb) =>
      tb.path.some((a, k) => k > 0 && distToSegment([x, y], tb.path[k - 1], a) < tb.half),
    );
  // Tile-edge skirts hang 6 m down to hide cracks between tiles; never where a
  // tube, trench or tube-mouth lid crosses the edge (the skirt stood across the
  // ramp there as a 6 m curtain).
  const cutGround = new CutGround(t, model.terrainCut);
  const noSkirt = (x: number, y: number) => {
    if (overTube(x, y)) return true;
    const r = t.cellSize;
    for (const [dx, dy] of [
      [0, 0],
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
      [r, r],
      [-r, r],
      [r, -r],
      [-r, -r],
    ]) {
      if (cutGround.inTrench(x + dx, y + dy) || cutGround.inLid(x + dx, y + dy)) return true;
    }
    return false;
  };
  const far = terrainMesh(t, mats.terrain, FAR_STEP, 6, undefined, undefined, noSkirt);
  far.userData.role = 'ground:far';
  group.add(far);
  if (opts.sea !== false) group.add(seaPlane(model, mats));

  // Underpasses and tunnel mouths: the terrain is left out inside their
  // footprints; the cells around them are drawn carved along the wall line,
  // the lid over a tube mouth from its own grid.
  const ground = cutGround;
  // Street surface (RoadSurface: road profiles, level across each carriageway,
  // sloping across medians). Road surfaces, kerbs and markings are draped on
  // it along their own polygon edges, not on the 4 m terrain grid whose
  // triangles across a carriageway edge drew the edge as a wave; the terrain
  // drawn under the street corridors sits 0.3 m lower, out of sight.
  // The compiler's ground (GroundModel): same street surface, fill and cuts.
  const groundModel = new GroundModel(model);
  const surface = groundModel.street;
  const streetAt = (x: number, y: number) => surface.heightAt(x, y) ?? terrainHeightAt(t, x, y);
  const shown = underStreet(t, surface);
  const trenches = model.terrainCut?.trenches ?? [];
  const lids = model.terrainCut?.lids ?? [];
  const holes = [...trenches, ...lids];
  const carved = cellsUnder(t, holes);
  const groundAt = (x: number, y: number) =>
    ground.inTrench(x, y) || ground.inLid(x, y) ? ground.heightAt(x, y) : streetAt(x, y);
  const onHoleEdge = (a: [number, number], b: [number, number]) =>
    holes.some((h) =>
      [h.outer, ...h.holes].some((ring) =>
        ring.some((p, k) => {
          const q = ring[(k + 1) % ring.length];
          return distToSegment(a, p, q) < 0.03 && distToSegment(b, p, q) < 0.03;
        }),
      ),
    );

  const markRuns = model.markings.map((m) => ({ m, mid: m.points[m.points.length >> 1] }));
  for (let j0 = 0; j0 < t.rows - 1; j0 += per) {
    for (let i0 = 0; i0 < t.cols - 1; i0 += per) {
      const i1 = Math.min(i0 + per, t.cols - 1);
      const j1 = Math.min(j0 + per, t.rows - 1);
      const x0 = t.minX + i0 * t.cellSize;
      const y0 = t.minY + j0 * t.cellSize;
      const x1 = t.minX + i1 * t.cellSize;
      const y1 = t.minY + j1 * t.cellSize;
      const inChunk = (p: readonly number[]) => p[0] >= x0 && p[0] < x1 && p[1] >= y0 && p[1] < y1;
      const chunk = new THREE.Group();
      chunk.name = `ground-${i0}-${j0}`;

      const terrain = terrainMesh(shown, mats.terrain, 1, 6, [i0, j0, i1, j1], carved, noSkirt);
      terrain.userData.role = 'ground:near';
      chunk.add(terrain);
      const cellsHere: Polygon[] = [];
      for (const idx of carved) {
        const ci = idx % t.cols;
        const cj = (idx - ci) / t.cols;
        if (ci < i0 || ci >= i1 || cj < j0 || cj >= j1) continue;
        const x = t.minX + ci * t.cellSize;
        const y = t.minY + cj * t.cellSize;
        cellsHere.push(rectPolygon(x, y, x + t.cellSize, y + t.cellSize));
      }
      if (cellsHere.length) {
        const patch = new MeshBuilder();
        const area = unionPolygons(cellsHere);
        for (const poly of subtractPolygons(area, holes)) drapeShaded(patch, poly, shown);
        for (const poly of clipPolygons(area, lids)) drapeShaded(patch, poly, ground.lid);
        if (patch.indices.length) {
          const mesh = new THREE.Mesh(patch.build(), mats.terrain);
          mesh.receiveShadow = true;
          mesh.name = 'terrain-carved';
          mesh.userData.role = 'ground:near';
          chunk.add(mesh);
        }
      }

      const cell = [rectPolygon(x0, y0, x1, y1)];
      // Kerbs are not built along the artificial chunk cut.
      const onCut = (a: [number, number], b: [number, number]) =>
        (Math.abs(a[0] - b[0]) < 0.02 &&
          (Math.abs(a[0] - x0) < 0.02 || Math.abs(a[0] - x1) < 0.02)) ||
        (Math.abs(a[1] - b[1]) < 0.02 &&
          (Math.abs(a[1] - y0) < 0.02 || Math.abs(a[1] - y1) < 0.02));
      // All surfaces and kerbs of the chunk in one mesh: one draw call (`ground` material).
      const overlay = new MeshBuilder();
      overlay.defineAttribute('surf', 1);
      // Not in a trench (it draws its own road), over a tube mouth on the lid.
      const nearCut = carved.size > 0 && clipPolygons(holes, cell).length > 0;
      const onGrids = (polys: Polygon[]): [Polygon[], TerrainGrid][] =>
        nearCut
          ? [
              [subtractPolygons(polys, holes), t],
              [clipPolygons(polys, lids), ground.lid],
            ]
          : [[polys, t]];
      /** Street corridor surfaces drape on the street surface (off the lids). */
      const STREET = new Set<SurfaceKind>(['asphalt', 'sidewalk', 'island', 'paving']);
      for (const surface of model.surfaces) {
        const clipped = surface.polygons.length ? clipPolygons(surface.polygons, cell) : [];
        if (!clipped.length) continue;
        for (const [polys, grid] of onGrids(clipped)) {
          for (const poly of polys) {
            overlay.setAttribute('surf', [SURF[surface.kind]]);
            const onStreet = STREET.has(surface.kind) && grid === t;
            if (onStreet) drapePolygon(overlay, poly, streetAt, LIFT[surface.kind], 6);
            else drapeOnTerrain(overlay, poly, grid, LIFT[surface.kind]);
            if (surface.kind === 'sidewalk' || surface.kind === 'island') {
              overlay.setAttribute('surf', [SURF_KERB]);
              for (const ring of [poly.outer, ...poly.holes]) {
                drapeRingWall(
                  overlay,
                  ring as [number, number][],
                  onStreet ? streetAt : grid,
                  LIFT[surface.kind],
                  // Down past the lowered terrain at the corridor's edge.
                  -1.0,
                  true,
                  6,
                  nearCut ? (a, b) => onCut(a, b) || onHoleEdge(a, b) : onCut,
                );
              }
            }
          }
        }
      }
      if (overlay.indices.length) {
        const mesh = new THREE.Mesh(overlay.build(), mats.ground);
        mesh.receiveShadow = true;
        mesh.name = 'surfaces';
        mesh.userData.role = 'ground:near';
        chunk.add(mesh);
      }
      // Far tiles: the same surfaces on the coarse terrain mesh (no kerbs) — far fewer triangles.
      const coarse = new MeshBuilder();
      coarse.defineAttribute('surf', 1);
      for (const surface of model.surfaces) {
        const polys = surface.polygons.length ? clipPolygons(surface.polygons, cell) : [];
        for (const poly of polys) {
          coarse.setAttribute('surf', [SURF[surface.kind]]);
          drapeOnTerrain(coarse, poly, model.terrain, LIFT[surface.kind] + FAR_LIFT, FAR_STEP);
        }
      }
      if (coarse.indices.length) {
        const mesh = new THREE.Mesh(coarse.build(), mats.ground);
        mesh.name = 'surfaces-coarse';
        mesh.userData.role = 'ground:far';
        chunk.add(mesh);
      }

      // Lane markings and zebra crossings of this chunk.
      const marks = new MeshBuilder();
      for (const { m, mid } of markRuns) {
        if (!inChunk(mid)) continue;
        // Markings stop at a trench (it paints its own lanes).
        const all = m.points as [number, number][];
        const parts: [number, number][][] = [];
        let part: [number, number][] = [];
        for (const q of all) {
          if (ground.inTrench(q[0], q[1])) {
            if (part.length >= 2) parts.push(part);
            part = [];
          } else part.push(q);
        }
        if (part.length >= 2) parts.push(part);
        for (const pts of parts) {
          if (m.kind === 'center-dashed' || m.kind === 'lane-dashed') {
            for (const d of dashes(pts, 3, 5)) ribbon(marks, groundAt, d, 0.13, MARKING_LIFT);
          } else {
            ribbon(marks, groundAt, pts, m.kind === 'edge' ? 0.15 : 0.13, MARKING_LIFT);
          }
        }
      }
      for (const c of model.crossings) {
        if (!inChunk(c.center)) continue;
        // Stripes run along the road, laid out across it.
        const n: [number, number] = [-c.dir[1], c.dir[0]];
        const stripes = Math.floor(c.length / 1.0);
        for (let s = 0; s < stripes; s++) {
          const off = -c.length / 2 + 0.5 + s * 1.0;
          const center: [number, number] = [c.center[0] + n[0] * off, c.center[1] + n[1] * off];
          const a: [number, number] = [center[0] - c.dir[0] * 1.5, center[1] - c.dir[1] * 1.5];
          const e: [number, number] = [center[0] + c.dir[0] * 1.5, center[1] + c.dir[1] * 1.5];
          ribbon(marks, groundAt, [a, e], 0.5, MARKING_LIFT);
        }
      }
      if (marks.indices.length) {
        const markMesh = new THREE.Mesh(marks.build({ uv: false }), mats.marking);
        markMesh.receiveShadow = true;
        markMesh.name = 'markings';
        markMesh.userData.role = 'ground:near';
        chunk.add(markMesh);
      }
      group.add(chunk);
    }
  }

  // Bridges and viaducts: asphalt deck with lane markings, walkways, concrete
  // barriers with a steel handrail, a slab edge and a narrower box girder
  // underneath, standing on piers (column(s) + cap beam) down to the ground.
  const structure = new MeshBuilder();
  const deckTops = new MeshBuilder();
  const walkways = new MeshBuilder();
  const deckMarks = new MeshBuilder();
  const Q: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  type V = [number, number, number];
  /** Axis-aligned-to-`dir` box: half sizes along / across, from z0 to z1 (five faces, no bottom). */
  const boxAt = (
    mb: MeshBuilder,
    c: [number, number],
    dir: [number, number],
    hAlong: number,
    hAcross: number,
    z0: number,
    z1: number,
    color?: THREE.Color,
  ) => {
    const [dx, dy] = dir;
    const nx = -dy;
    const ny = dx;
    const corner = (a: number, b: number): [number, number] => [
      c[0] + dx * a * hAlong + nx * b * hAcross,
      c[1] + dy * a * hAlong + ny * b * hAcross,
    ];
    const ring = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    for (let k = 0; k < 4; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % 4];
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const l = Math.hypot(ex, ey) || 1;
      mb.quad(
        [
          [a[0], a[1], z0],
          [b[0], b[1], z0],
          [b[0], b[1], z1],
          [a[0], a[1], z1],
        ] as V[],
        [ey / l, -ex / l, 0],
        color,
        Q,
      );
    }
    mb.quad(
      ring.map((p) => [p[0], p[1], z1] as V),
      [0, 0, 1],
      color,
      Q,
    );
  };
  /**
   * Mitred left normals per path vertex (scaled by 1/cos of the half turn), so
   * strips offset from the deck centreline join without gaps or overlaps at
   * bends: the deck reads as one continuous structure.
   */
  const miters = (path: V[]): [number, number][] =>
    path.map((_, k) => {
      const seg = (a: V, b: V): [number, number] => {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const l = Math.hypot(dx, dy) || 1;
        return [-dy / l, dx / l];
      };
      const n0 = k > 0 ? seg(path[k - 1], path[k]) : null;
      const n1 = k < path.length - 1 ? seg(path[k], path[k + 1]) : null;
      if (!n0) return n1!;
      if (!n1) return n0;
      const mx = n0[0] + n1[0];
      const my = n0[1] + n1[1];
      const ml = Math.hypot(mx, my) || 1;
      const cos = Math.max(0.5, (mx / ml) * n1[0] + (my / ml) * n1[1]);
      return [mx / ml / cos, my / ml / cos];
    });
  /**
   * Strip parallel to the deck path at lateral offsets o0..o1, at path height + z;
   * `nz` -1 for an underside (offsets given right to left so it faces down).
   */
  const along = (
    mb: MeshBuilder,
    path: V[],
    o0: number,
    o1: number,
    z: number,
    nz: 1 | -1 = 1,
    color?: THREE.Color,
  ) => {
    const n = miters(path);
    const at = (k: number, o: number): V => [
      path[k][0] + n[k][0] * o,
      path[k][1] + n[k][1] * o,
      path[k][2] + z,
    ];
    for (let k = 1; k < path.length; k++) {
      mb.quad([at(k - 1, o0), at(k, o0), at(k, o1), at(k - 1, o1)], [0, 0, nz], color, Q);
    }
  };
  /** Vertical face along the path at lateral offset o, from path z + z0 to + z1, facing `side`. */
  const face = (
    mb: MeshBuilder,
    path: V[],
    o: number,
    z0: number,
    z1: number,
    side: 1 | -1,
    color?: THREE.Color,
  ) => {
    const n = miters(path);
    const at = (k: number, z: number): V => [
      path[k][0] + n[k][0] * o,
      path[k][1] + n[k][1] * o,
      path[k][2] + z,
    ];
    for (let k = 1; k < path.length; k++) {
      const len = Math.hypot(n[k][0], n[k][1]) || 1;
      const quad: V[] =
        side > 0
          ? [at(k, z0), at(k - 1, z0), at(k - 1, z1), at(k, z1)]
          : [at(k - 1, z0), at(k, z0), at(k, z1), at(k - 1, z1)];
      mb.quad(quad, [(n[k][0] / len) * side, (n[k][1] / len) * side, 0], color, Q);
    }
  };
  /** Point-in-polygons test (bounding boxes first) for what another deck owns. */
  type Owned = { inside: (x: number, y: number) => boolean };
  const NONE: Owned = { inside: () => false };
  const owned = (polys: Polygon[]): Owned => {
    if (!polys.length) return NONE;
    const boxes = polys.map((p) => {
      let b = [Infinity, Infinity, -Infinity, -Infinity];
      for (const q of p.outer)
        b = [
          Math.min(b[0], q[0]),
          Math.min(b[1], q[1]),
          Math.max(b[2], q[0]),
          Math.max(b[3], q[1]),
        ];
      return { p, b };
    });
    return {
      inside: (x, y) =>
        boxes.some(
          ({ p, b }) =>
            x >= b[0] &&
            y >= b[1] &&
            x <= b[2] &&
            y <= b[3] &&
            pointInRing([x, y], p.outer) &&
            !p.holes.some((h) => pointInRing([x, y], h)),
        ),
    };
  };
  /** Path with extra vertices every `step` m (heights interpolated). */
  const densifyPath = (path: V[], step: number): V[] => {
    const out: V[] = [path[0]];
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1];
      const b = path[k];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
      for (let i = 1; i <= n; i++) {
        const f = i / n;
        out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
      }
    }
    return out;
  };
  /** Midpoint of a two-point piece of path, offset laterally by o. */
  const offsetAt = (seg: V[], o: number): [number, number] => {
    const [a, b] = [seg[0], seg[seg.length - 1]];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [
      (a[0] + b[0]) / 2 + (-(b[1] - a[1]) / l) * o,
      (a[1] + b[1]) / 2 + ((b[0] - a[0]) / l) * o,
    ];
  };
  /** Pieces of a (dense) path whose line at lateral offset o lies outside `skip`. */
  const runsOutside = (path: V[], o: number, skip: Owned): V[][] => {
    if (skip === NONE) return [path];
    const runs: V[][] = [];
    let run: V[] = [];
    for (let k = 1; k < path.length; k++) {
      if (skip.inside(...offsetAt([path[k - 1], path[k]], o))) {
        if (run.length >= 2) runs.push(run);
        run = [];
        continue;
      }
      if (!run.length) run.push(path[k - 1]);
      run.push(path[k]);
    }
    if (run.length >= 2) runs.push(run);
    return runs;
  };
  /**
   * `along` with the parts inside `clip` left out (polygon difference per
   * quad; heights follow the path).
   */
  const alongClipped = (
    mb: MeshBuilder,
    path: V[],
    o0: number,
    o1: number,
    z: number,
    clip: Polygon[],
  ) => {
    if (!clip.length) {
      along(mb, path, o0, o1, z);
      return;
    }
    const test = owned(clip);
    const n = miters(path);
    const up = toThree(0, 0, 1);
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1];
      const b = path[k];
      const corner = (i: number, o: number): [number, number] => [
        path[i][0] + n[i][0] * o,
        path[i][1] + n[i][1] * o,
      ];
      const quad = [corner(k - 1, o0), corner(k, o0), corner(k, o1), corner(k - 1, o1)];
      const touched =
        quad.some((q) => test.inside(q[0], q[1])) || test.inside(...offsetAt([a, b], 0));
      if (!touched) {
        along(mb, [a, b], o0, o1, z);
        continue;
      }
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy || 1;
      const zAt = (x: number, y: number) => {
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
        return a[2] + (b[2] - a[2]) * t + z;
      };
      for (const piece of subtractPolygons([{ outer: quad, holes: [] }], clip)) {
        const tri = triangulate(piece);
        const ids: number[] = [];
        for (let v = 0; v < tri.vertices.length; v += 2) {
          const x = tri.vertices[v];
          const y = tri.vertices[v + 1];
          ids.push(mb.vertex(toThree(x, y, zAt(x, y)), up, undefined, x, y));
        }
        for (let t = 0; t < tri.indices.length; t += 3) {
          const [i, j, m] = [tri.indices[t], tri.indices[t + 1], tri.indices[t + 2]];
          const p = (q: number) => [tri.vertices[q * 2], tri.vertices[q * 2 + 1]];
          const [pa, pb, pc] = [p(i), p(j), p(m)];
          const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pb[1] - pa[1]);
          if (Math.abs(area) < 1e-9) continue;
          // Upward facing: counter-clockwise from above.
          if (area > 0) mb.triangle(ids[i], ids[j], ids[m]);
          else mb.triangle(ids[i], ids[m], ids[j]);
        }
      }
    }
  };
  /** Horizontal distance from a point to a bridge's centreline. */
  const distanceTo = (br: Bridge, q: [number, number]): number => {
    let best = Infinity;
    for (let k = 1; k < br.path.length; k++) {
      const a = br.path[k - 1];
      const b = br.path[k];
      best = Math.min(best, distToSegment(q, [a[0], a[1]], [b[0], b[1]]));
    }
    return best;
  };
  /** Deck height of a bridge over the closest point of its path. */
  const deckAt = (br: Bridge, q: [number, number]): number => {
    let best = { d: Infinity, z: br.path[0][2] };
    for (let k = 1; k < br.path.length; k++) {
      const a = br.path[k - 1];
      const b = br.path[k];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2));
      const d = Math.hypot(q[0] - a[0] - dx * t, q[1] - a[1] - dy * t);
      if (d < best.d) best = { d, z: a[2] + (b[2] - a[2]) * t };
    }
    return best.z;
  };
  /** Dashed or solid line on the deck at lateral offset o. */
  const line = (path: V[], o: number, dash: number | null, skip: Owned = NONE) => {
    const w = 0.075;
    if (dash === null) {
      for (const run of runsOutside(path, o, skip)) along(deckMarks, run, o - w, o + w, 0.03);
      return;
    }
    // Dashes: 3 m paint every `dash` metres along the deck.
    let walked = 0;
    for (let k = 1; k < path.length; k++) {
      const p0 = path[k - 1];
      const p1 = path[k];
      const seg = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      for (let s = Math.ceil(walked / dash) * dash - walked; s < seg; s += dash) {
        const t0 = s / seg;
        const t1 = Math.min(1, (s + 3) / seg);
        const a: V = [
          p0[0] + (p1[0] - p0[0]) * t0,
          p0[1] + (p1[1] - p0[1]) * t0,
          p0[2] + (p1[2] - p0[2]) * t0,
        ];
        const b: V = [
          p0[0] + (p1[0] - p0[0]) * t1,
          p0[1] + (p1[1] - p0[1]) * t1,
          p0[2] + (p1[2] - p0[2]) * t1,
        ];
        if (!skip.inside(...offsetAt([a, b], o))) along(deckMarks, [a, b], o - w, o + w, 0.03);
      }
      walked += seg;
    }
  };

  /** Lane markings of a deck / tube floor, with the ground rules (roads.ts buildMarkings). */
  const laneLines = (
    path: V[],
    carriage: number,
    lanesIn: number,
    oneway: boolean,
    edge: boolean,
    /** Lane lines stop on a deck that owns the surface; edge lines wherever another deck joins. */
    skip: { lanes: Owned; edges: Owned } = { lanes: NONE, edges: NONE },
  ) => {
    const lanes = Math.max(1, lanesIn);
    const laneW = (2 * carriage) / lanes;
    if (edge) {
      line(path, carriage - 0.35, null, skip.edges);
      line(path, -carriage + 0.35, null, skip.edges);
    }
    if (lanes < 2 && !oneway) return;
    const lane = (o: number, dash: number | null) => line(path, o, dash, skip.lanes);
    if (oneway) {
      for (let k = 1; k < lanes; k++) lane(-carriage + k * laneW, 9);
    } else {
      const perSide = Math.floor(lanes / 2);
      if (lanes >= 4) {
        lane(0.12, null);
        lane(-0.12, null);
      } else lane(0, 9);
      for (let k = 1; k < perSide; k++) {
        lane(k * laneW, 9);
        lane(-k * laneW, 9);
      }
    }
  };

  // Decks that join at the same height (Y splits, slip roads, a ramp merging
  // into a viaduct) share one surface: where they overlap the higher-priority
  // (wider) deck draws the running surface, and barriers, walkways, slab
  // edges and edge lines stop where they would stand inside the other deck,
  // so the joining road opens into it instead of crossing it.
  const bridges = [...model.bridges].sort(deckPriority);
  const prints = bridges.map((br) =>
    bufferPolyline(
      br.path.map((q) => [q[0], q[1]] as [number, number]),
      br.width / 2,
      false,
    ),
  );
  const joins = bridges.map(() => ({ over: [] as Polygon[], all: [] as Polygon[] }));
  for (let a = 0; a < bridges.length; a++) {
    for (let b = a + 1; b < bridges.length; b++) {
      const shared = clipPolygons(prints[a], prints[b]);
      if (!shared.length) continue;
      const c = shared[0].outer.reduce(
        (m, q) => [m[0] + q[0] / shared[0].outer.length, m[1] + q[1] / shared[0].outer.length],
        [0, 0],
      ) as [number, number];
      if (Math.abs(deckAt(bridges[a], c) - deckAt(bridges[b], c)) > 2) continue;
      // The owner's surface stops 5 cm inside its edge; the other one fills up to there.
      joins[b].over.push(...offsetPolygons(prints[a], -0.05));
      joins[a].all.push(...prints[b]);
      joins[b].all.push(...prints[a]);
    }
  }
  // Picking: every structure's triangles carry the index of its feature id
  // ("<kind>|<source road id>|<detail>"), see CityTile.inspect.
  const features: string[] = [];
  const structureBuilders: MeshBuilder[] = [];
  const own = (id: string) => {
    features.push(id);
    for (const mb of structureBuilders) mb.setOwner(features.length - 1);
  };
  structureBuilders.push(structure, deckTops, walkways, deckMarks);
  bridges.forEach((br, idx) => {
    own(`bridge|${br.roadId}|${br.width.toFixed(1)} m · ${br.lanes ?? 2} şerit`);
    const path = br.path as V[];
    const dense = densifyPath(path, 1);
    const half = br.width / 2;
    const carriage = (br.carriageway ?? br.width) / 2;
    const over = owned(joins[idx].over);
    // Barriers yield only well inside another deck: twin decks side by side
    // that merely touch keep their median barriers.
    const joined = owned(offsetPolygons(joins[idx].all, -0.6));
    // A low deck (culvert, a bridge at street level) meeting a junction: its
    // barriers and walkways stop where they would stand on another road.
    const merged: Owned = {
      inside: (x, y) =>
        joined.inside(x, y) ||
        (deckAt(br, [x, y]) - groundModel.streetAt(x, y) < 2 &&
          groundModel.supportAt(x, y) === 'asphalt'),
    };
    // A barrier end that lies on another deck's barrier line carries on there.
    const continues = (q: [number, number]) =>
      bridges.some(
        (other, o) => o !== idx && Math.abs(distanceTo(other, q) - (other.width / 2 - 0.2)) < 0.6,
      );
    // Running surface to 5 cm short of the slab edge (under the barrier: a surface
    // reaching the barrier's outer face z-fought with it along the deck).
    alongClipped(deckTops, dense, -half + 0.05, half - 0.05, 0, joins[idx].over);
    if (half - carriage > 0.3) {
      for (const [o0, o1] of [
        [carriage, half - 0.4],
        [-(half - 0.4), -carriage],
      ]) {
        for (const run of runsOutside(dense, (o0 + o1) / 2, merged)) {
          along(walkways, run, o0, o1, 0.18);
          // Kerb face towards the carriageway, and a closed end where the walkway stops.
          const kerb = Math.abs(o0) < Math.abs(o1) ? o0 : o1;
          face(walkways, run, kerb, 0, 0.18, kerb > 0 ? -1 : 1);
          for (const [k, toward] of [
            [0, 1],
            [run.length - 1, run.length - 2],
          ]) {
            if (run.length < 2) break;
            const p0 = run[k];
            const d = [p0[0] - run[toward][0], p0[1] - run[toward][1]];
            const l = Math.hypot(d[0], d[1]) || 1;
            const mid = (o0 + o1) / 2;
            boxAt(
              walkways,
              [p0[0] + (-d[1] / l) * mid, p0[1] + (d[0] / l) * mid],
              [d[0] / l, d[1] / l],
              0.01,
              (o1 - o0) / 2,
              p0[2],
              p0[2] + 0.18,
            );
          }
        }
      }
    }
    laneLines(dense, carriage, br.lanes ?? 2, br.oneway, br.edgeLines, {
      lanes: over,
      edges: merged,
    });
    // Concrete barriers (0.4 m wide, 0.85 m high) with a steel handrail above,
    // on the slab edge; capped where they stop at a join.
    for (const side of [1, -1] as const) {
      const outer = side * half;
      const inner = side * (half - 0.4);
      const rail = side * (half - 0.2);
      for (const run of runsOutside(dense, rail, merged)) {
        face(structure, run, outer, -0.55, 0.85, side);
        face(structure, run, inner, 0, 0.85, -side as 1 | -1);
        along(structure, run, Math.min(inner, outer), Math.max(inner, outer), 0.85);
        // Handrail: a closed rail (seen from the road as well as from outside) on posts.
        face(structure, run, rail + 0.04 * side, 1.12, 1.2, side);
        face(structure, run, rail - 0.04 * side, 1.12, 1.2, -side as 1 | -1);
        along(structure, run, rail - 0.04, rail + 0.04, 1.2);
        along(structure, run, rail + 0.04, rail - 0.04, 1.12, -1);
        for (let k = 0; k < run.length; k += 2) {
          const q = run[k];
          const r = run[Math.min(run.length - 1, k + 1)];
          const pr = run[Math.max(0, k - 1)];
          const dx = r[0] - pr[0];
          const dy = r[1] - pr[1];
          const l = Math.hypot(dx, dy) || 1;
          boxAt(
            structure,
            [q[0] + (-dy / l) * rail, q[1] + (dx / l) * rail],
            [dx / l, dy / l],
            0.03,
            0.03,
            q[2] + 0.85,
            q[2] + 1.12,
          );
        }
        for (const [k, toward] of [
          [0, 1],
          [run.length - 1, run.length - 2],
        ]) {
          if (run.length < 2) break;
          const p0 = run[k];
          const d = [p0[0] - run[toward][0], p0[1] - run[toward][1]];
          const l = Math.hypot(d[0], d[1]) || 1;
          const at: [number, number] = [p0[0] + (-d[1] / l) * rail, p0[1] + (d[0] / l) * rail];
          // No cap where the barrier carries on along the next deck (decks end to end).
          if (continues(at)) continue;
          boxAt(structure, at, [d[0] / l, d[1] / l], 0.02, 0.2, p0[2], p0[2] + 0.85);
        }
      }
    }
    // Slab edge and box girder underneath (narrower), its soffit.
    const girder = Math.max(1.5, half * 0.62);
    along(structure, path, -half, half, -0.55);
    for (const side of [1, -1] as const) face(structure, path, side * girder, -1.4, -0.55, side);
    // Soffits (facing down): slab outside the girder and the girder bottom.
    along(structure, path, half, -half, -0.55, -1);
    along(structure, path, girder, -girder, -1.4, -1);
    // Closed ends: slab and girder end faces (seen where a deck stops).
    for (const [k, toward] of [
      [0, 1],
      [path.length - 1, path.length - 2],
    ]) {
      const p0 = path[k];
      const d = [p0[0] - path[toward][0], p0[1] - path[toward][1]];
      const l = Math.hypot(d[0], d[1]) || 1;
      const dir: [number, number] = [d[0] / l, d[1] / l];
      boxAt(structure, [p0[0], p0[1]], dir, 0.01, half, p0[2] - 0.55, p0[2] - 0.01);
      boxAt(structure, [p0[0], p0[1]], dir, 0.01, girder, p0[2] - 1.4, p0[2] - 0.55);
    }
    // Piers: one column under narrow decks, two under wide ones, and a cap beam.
    for (const pier of br.piers ?? []) {
      const dir = pier.dir as [number, number];
      const n: [number, number] = [-dir[1], dir[0]];
      // Column layout from the compiler (placed clear of the roads underneath).
      for (const o of pier.columns ?? (br.width > 13 ? [-girder * 0.6, girder * 0.6] : [0])) {
        boxAt(
          structure,
          [pier.at[0] + n[0] * o, pier.at[1] + n[1] * o],
          dir,
          0.6,
          0.6,
          pier.base,
          pier.top - 0.7,
        );
      }
      boxAt(
        structure,
        pier.at as [number, number],
        dir,
        0.7,
        girder + 0.4,
        pier.top - 0.8,
        pier.top,
      );
    }
  });
  const addMesh = (mb: MeshBuilder, mat: unknown, name: string, shadow: boolean) => {
    if (!mb.vertexCount) return;
    const m = new THREE.Mesh(mb.build(), mat as THREE.Material);
    m.castShadow = shadow;
    m.receiveShadow = true;
    m.name = name;
    m.userData.pick = { ids: features, owners: mb.triangleOwner };
    group.add(m);
  };

  // ─── Underpasses and tunnels ────────────────────────────────────────────
  const concrete = new MeshBuilder();
  const tubeWalls = new MeshBuilder();
  const glow = new MeshBuilder();
  const fixtures = new MeshBuilder();
  structureBuilders.push(concrete, tubeWalls, glow, fixtures);
  const C = (hex: string) => new THREE.Color(hex);
  const PANEL = C('#e6e3da');
  const COATING = C('#3d4246');

  // Trenches: the ramp road itself (asphalt wall to wall at the exact floor
  // height, lane lines, a raised kerb strip along the walls; ground surfaces
  // and markings are not draped in a trench) and a retaining wall along each
  // side, up to the ground at the wall line plus a parapet.
  // Twin ramps side by side (one per direction): where the gap between two
  // trench footprints is under TWIN_MEDIAN m, one wall fills it (from this trench's
  // floor to the other's), drawn by the earlier trench; the later one leaves
  // its wall out there. Two 0.4 m walls in a 0.7 m gap stood in each other
  // and flickered along the line where they crossed.
  const cutLines = (model.cuttings ?? []).map((c) => ({
    pts: c.path.map((q) => [q[0], q[1]] as [number, number]),
    z: c.path.map((q) => q[2]),
    half: c.width / 2,
  }));
  /**
   * Nearest other trench across the wall at q (outward u): its index, the gap
   * to its footprint and its floor height there (from its own ramp profile:
   * where two footprints overlap the cut ground holds only one of the floors).
   */
  const across = (self: number, q: [number, number], u: [number, number]) => {
    let best: { j: number; gap: number; floor: number } | null = null;
    for (let j = 0; j < cutLines.length; j++) {
      const o = cutLines[j];
      if (j === self) continue;
      let d = Infinity;
      let cp: [number, number] = q;
      let floor = 0;
      for (let k = 1; k < o.pts.length; k++) {
        const a = o.pts[k - 1];
        const b = o.pts[k];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const l2 = dx * dx + dy * dy || 1;
        const tt = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2));
        const c2: [number, number] = [a[0] + dx * tt, a[1] + dy * tt];
        const dd = Math.hypot(q[0] - c2[0], q[1] - c2[1]);
        if (dd < d) {
          d = dd;
          cp = c2;
          floor = o.z[k - 1] + (o.z[k] - o.z[k - 1]) * tt;
        }
      }
      // On the outward side, footprint within TWIN_MEDIAN of the wall line.
      if ((cp[0] - q[0]) * u[0] + (cp[1] - q[1]) * u[1] <= 0) continue;
      const gap = d - o.half;
      if (gap < TWIN_MEDIAN && (!best || gap < best.gap))
        best = { j, gap: Math.max(0, gap), floor };
    }
    return best;
  };
  (model.cuttings ?? []).forEach((c, ci) => {
    own(`cutting|${c.roadId}|${c.width.toFixed(1)} m genişlik`);
    const path: V[] = [];
    // Compiler wall tops (rimL / rimR), densified with the path.
    const rimDense: [number[], number[]] = [[], []];
    for (let k = 0; k < c.path.length; k++) {
      const a = c.path[k] as V;
      if (k > 0) {
        const b = c.path[k - 1] as V;
        const n = Math.ceil(Math.hypot(a[0] - b[0], a[1] - b[1]) / 2);
        for (let i = 1; i < n; i++) {
          const f = i / n;
          path.push([b[0] + (a[0] - b[0]) * f, b[1] + (a[1] - b[1]) * f, b[2] + (a[2] - b[2]) * f]);
          if (c.rimL && c.rimR) {
            rimDense[0].push(c.rimL[k - 1] + (c.rimL[k] - c.rimL[k - 1]) * f);
            rimDense[1].push(c.rimR[k - 1] + (c.rimR[k] - c.rimR[k - 1]) * f);
          }
        }
      }
      path.push(a);
      if (c.rimL && c.rimR) {
        rimDense[0].push(c.rimL[k]);
        rimDense[1].push(c.rimR[k]);
      }
    }
    const half = c.width / 2;
    const carriage = Math.min(half - 0.25, (c.carriageway ?? c.width) / 2);
    along(deckTops, path, -half, half, 0);
    laneLines(path, carriage, c.lanes ?? 2, c.oneway ?? false, c.edgeLines ?? false);
    if (half - carriage > 0.25) {
      for (const side of [1, -1] as const) {
        const [o0, o1] = side > 0 ? [carriage, half] : [-half, -carriage];
        along(walkways, path, o0, o1, 0.16);
        face(walkways, path, side * carriage, 0, 0.16, side > 0 ? -1 : 1);
      }
    }
    const n = miters(path);
    for (const side of [1, -1] as const) {
      const off = (k: number, o: number): [number, number] => [
        path[k][0] + n[k][0] * o,
        path[k][1] + n[k][1] * o,
      ];
      // Ground at the wall line, then the highest of each ±4 m and averaged
      // over ±4 m: the top runs smooth (the 4 m terrain grid is creased along a
      // street) and never below the ground beside it.
      // What lies beyond the wall (sidewalk at kerb height, terrain …), from
      // the one ground model: the wall top meets it, no gap and no overlap.
      // Beyond a median the next trench's floor lies: the top follows the street
      // level there instead (a wall top never drops to a trench floor).
      const ground = path.map((p, k) => {
        const q = off(k, side * (half + 0.5));
        const s = groundModel.surfaceAt(...q);
        return Math.max(p[2] + 0.3, s.support === 'trench' ? groundModel.streetAt(...q) : s.z);
      });
      const win = (k: number) => {
        const out: number[] = [];
        for (let j = Math.max(0, k - 2); j <= Math.min(path.length - 1, k + 2); j++) out.push(j);
        return out;
      };
      const peak = ground.map((_, k) => Math.max(...win(k).map((j) => ground[j])));
      const fromCompiler = c.rimL && c.rimR ? rimDense[side > 0 ? 0 : 1] : null;
      const top = path.map((p, k) => {
        if (fromCompiler) return fromCompiler[k];
        const g = win(k).reduce((sum, j) => sum + peak[j], 0) / win(k).length;
        const depth = g - p[2];
        return Math.max(g, ground[k]) + 0.15 + 0.75 * Math.min(1, Math.max(0, depth / 2));
      });
      const inner = side * half;
      // Per point: wall thickness (to the next trench's floor in a narrow
      // median) or none (the other trench draws the median wall).
      const medianFloor = path.map((p) => p[2]);
      const thick = path.map((_, k) => {
        const len = Math.hypot(n[k][0], n[k][1]) || 1;
        const u: [number, number] = [(n[k][0] / len) * side, (n[k][1] / len) * side];
        const o = across(ci, off(k, side * half), u);
        if (!o) return 0.4;
        if (o.j < ci) return 0;
        // The median wall goes down to the deeper of the two floors.
        medianFloor[k] = Math.min(path[k][2], o.floor);
        return Math.max(0.4, o.gap);
      });
      for (let k = 1; k < path.length; k++) {
        if (thick[k - 1] === 0 && thick[k] === 0) continue;
        const w = [Math.max(0.4, thick[k - 1]), Math.max(0.4, thick[k])];
        const pt = (i: number, o: number, z: number): V => {
          // Outer face: this point's own thickness.
          const oo = Math.abs(o) > Math.abs(inner) + 1e-6 ? side * (half + w[i === k ? 1 : 0]) : o;
          return [...off(i, oo), z];
        };
        const outer = side * (half + 0.4);
        const ks = [k - 1, k];
        const zb = ks.map((i) => medianFloor[i] - 0.3);
        const zt = ks.map((i) => top[i]);
        const len = Math.hypot(n[k][0], n[k][1]) || 1;
        const nn: V = [n[k][0] / len, n[k][1] / len, 0];
        for (const [o, s] of [
          [inner, -side],
          [outer, side],
        ] as [number, 1 | -1][]) {
          const quad: V[] =
            s > 0
              ? [pt(k, o, zb[1]), pt(k - 1, o, zb[0]), pt(k - 1, o, zt[0]), pt(k, o, zt[1])]
              : [pt(k - 1, o, zb[0]), pt(k, o, zb[1]), pt(k, o, zt[1]), pt(k - 1, o, zt[0])];
          concrete.quad(quad, [nn[0] * s, nn[1] * s, 0], undefined, Q);
        }
        const [a0, a1] = side > 0 ? [inner, outer] : [outer, inner];
        concrete.quad(
          [pt(k - 1, a0, zt[0]), pt(k, a0, zt[1]), pt(k, a1, zt[1]), pt(k - 1, a1, zt[0])],
          [0, 0, 1],
          undefined,
          Q,
        );
      }
    }
  });

  // Lids over tube mouths are drawn with the ground; where a lid stands above
  // the ground around it, its edge is a concrete face down to the ground.
  own('lid||tünel ağzı kapağı');
  for (const lid of model.terrainCut?.lids ?? []) {
    for (const ring of [lid.outer, ...lid.holes]) {
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % ring.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 0.01) continue;
        const steps = Math.ceil(len / 0.5);
        for (let i = 0; i < steps; i++) {
          const p0: [number, number] = [
            a[0] + ((b[0] - a[0]) * i) / steps,
            a[1] + ((b[1] - a[1]) * i) / steps,
          ];
          const p1: [number, number] = [
            a[0] + ((b[0] - a[0]) * (i + 1)) / steps,
            a[1] + ((b[1] - a[1]) * (i + 1)) / steps,
          ];
          const top = [terrainHeightAt(ground.lid, ...p0), terrainHeightAt(ground.lid, ...p1)];
          const foot = [terrainHeightAt(t, ...p0), terrainHeightAt(t, ...p1)];
          if (top[0] - foot[0] < 0.02 && top[1] - foot[1] < 0.02) continue;
          // Outer ring CCW: outward is the right-hand side of a → b.
          const nx = (b[1] - a[1]) / len;
          const ny = -(b[0] - a[0]) / len;
          concrete.quad(
            [
              [p0[0], p0[1], foot[0] - 0.3],
              [p1[0], p1[1], foot[1] - 0.3],
              [p1[0], p1[1], top[1]],
              [p0[0], p0[1], top[0]],
            ],
            [nx, ny, 0],
            undefined,
            Q,
          );
        }
      }
    }
  }

  // Portals: headwall around the tube opening.
  for (const p of model.portals ?? []) {
    own(`portal|${p.roadId}|${p.hill ? 'tepe tüneli' : 'alt geçit'} ağzı`);
    const [fx, fy] = p.facing;
    const nx = -fy;
    const ny = fx;
    const at = (s: number): [number, number] => [p.at[0] + nx * s, p.at[1] + ny * s];
    const half = p.width / 2;
    const open = p.opening / 2;
    const z = p.at[2];
    const dir: [number, number] = [fx, fy];
    // Piers either side of the opening, lintel above it (0.8 m thick, set into the mouth).
    const pier = (s0: number, s1: number) => {
      const m = at((s0 + s1) / 2);
      boxAt(
        concrete,
        [m[0] - fx * 0.4, m[1] - fy * 0.4],
        dir,
        0.4,
        Math.abs(s1 - s0) / 2,
        z - 0.3,
        z + p.wall,
      );
    };
    pier(-half, -open);
    pier(open, half);
    const lintel = at(0);
    boxAt(
      concrete,
      [lintel[0] - fx * 0.4, lintel[1] - fy * 0.4],
      dir,
      0.4,
      open,
      z + p.height,
      z + p.wall,
    );
  }

  // Tunnel tubes: road with markings, raised walkways, panelled walls with a
  // dark coating above, ceiling, two rows of lights, jet fans, lane signals,
  // emergency-exit signs and SOS cabinets.
  for (const tn of model.tunnels ?? []) {
    own(`tunnel|${tn.roadId}|${tn.name ?? ''}`);
    const path = tn.path as V[];
    const half = tn.width / 2;
    const carriage = tn.carriageway / 2;
    const h = tn.height;
    along(deckTops, path, -carriage, carriage, 0.02);
    laneLines(path, carriage, tn.lanes, tn.oneway, tn.edgeLines);
    for (const side of [1, -1] as const) {
      // Walkway: kerb face and top.
      const kerb = side * carriage;
      const edge = side * half;
      face(walkways, path, kerb, 0, 0.3, side > 0 ? -1 : 1);
      along(walkways, path, Math.min(kerb, edge), Math.max(kerb, edge), 0.3);
      // Walls: light panels to 3.5 m, dark coating above, facing into the tube.
      face(tubeWalls, path, edge, 0.3, 3.5, side > 0 ? -1 : 1, PANEL);
      face(tubeWalls, path, edge, 3.5, h, side > 0 ? -1 : 1, COATING);
    }
    along(concrete, path, half, -half, h, -1);

    // Fittings along the tube, by arc length.
    const samples = (step: number, offset: number) => {
      const out: { p: V; dir: [number, number] }[] = [];
      let walked = 0;
      let next = offset;
      for (let k = 1; k < path.length; k++) {
        const a = path[k - 1];
        const b = path[k];
        const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (seg < 1e-6) continue;
        const d: [number, number] = [(b[0] - a[0]) / seg, (b[1] - a[1]) / seg];
        while (next <= walked + seg) {
          const t = (next - walked) / seg;
          out.push({
            p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
            dir: d,
          });
          next += step;
        }
        walked += seg;
      }
      return out;
    };
    const lateral = (q: { p: V; dir: [number, number] }, o: number): [number, number] => [
      q.p[0] - q.dir[1] * o,
      q.p[1] + q.dir[0] * o,
    ];
    const WARM = C('#fff1d6');
    for (const q of samples(6, 3)) {
      for (const o of [-carriage * 0.55, carriage * 0.55]) {
        boxAt(glow, lateral(q, o), q.dir, 0.7, 0.12, q.p[2] + h - 0.12, q.p[2] + h - 0.02, WARM);
      }
    }
    for (const q of samples(120, 40)) {
      for (const o of [-1.4, 1.4]) {
        boxAt(
          fixtures,
          lateral(q, o),
          q.dir,
          1.5,
          0.55,
          q.p[2] + h - 1.25,
          q.p[2] + h - 0.15,
          C('#4a4f54'),
        );
      }
    }
    const lanes = Math.max(1, tn.lanes);
    const laneW = (2 * carriage) / lanes;
    for (const q of samples(150, 20)) {
      boxAt(
        fixtures,
        lateral(q, 0),
        q.dir,
        0.15,
        carriage,
        q.p[2] + h - 0.6,
        q.p[2] + h - 0.45,
        C('#2b2e31'),
      );
      for (let k = 0; k < lanes; k++) {
        const o = -carriage + (k + 0.5) * laneW;
        boxAt(
          fixtures,
          lateral(q, o),
          q.dir,
          0.2,
          0.45,
          q.p[2] + h - 1.4,
          q.p[2] + h - 0.6,
          C('#1c1e20'),
        );
        boxAt(
          glow,
          lateral(q, o),
          q.dir,
          0.22,
          0.25,
          q.p[2] + h - 1.2,
          q.p[2] + h - 0.8,
          C('#38e07a'),
        );
      }
    }
    for (const q of samples(100, 50)) {
      for (const side of [1, -1] as const) {
        const o = side * (half - 0.06);
        boxAt(glow, lateral(q, o), q.dir, 0.45, 0.04, q.p[2] + 2.4, q.p[2] + 2.75, C('#19c75a'));
      }
    }
    for (const q of samples(150, 75)) {
      for (const side of [1, -1] as const) {
        const o = side * (half - 0.2);
        boxAt(fixtures, lateral(q, o), q.dir, 0.5, 0.2, q.p[2] + 0.3, q.p[2] + 1.9, C('#e2701e'));
        boxAt(
          glow,
          lateral(q, side * (half - 0.41)),
          q.dir,
          0.2,
          0.01,
          q.p[2] + 1.55,
          q.p[2] + 1.75,
          C('#ffffff'),
        );
      }
    }
    // Speed limit boards just inside both mouths: red ring on white, on the wall.
    const len = path.reduce(
      (acc, p, k) => (k ? acc + Math.hypot(p[0] - path[k - 1][0], p[1] - path[k - 1][1]) : 0),
      0,
    );
    for (const q of [...samples(1e9, 12), ...samples(1e9, Math.max(12, len - 12))]) {
      for (const side of [1, -1] as const) {
        const o = side * (half - 0.08);
        boxAt(fixtures, lateral(q, o), q.dir, 0.45, 0.05, q.p[2] + 3.6, q.p[2] + 4.5, C('#c8262b'));
        boxAt(
          fixtures,
          lateral(q, side * (half - 0.14)),
          q.dir,
          0.33,
          0.01,
          q.p[2] + 3.72,
          q.p[2] + 4.38,
          C('#f4f4f2'),
        );
      }
    }
  }

  addMesh(structure, mats.curb, 'bridges', true);
  addMesh(concrete, mats.retaining, 'cuttings', true);
  addMesh(deckTops, mats.asphalt, 'bridge-decks', false);
  addMesh(walkways, mats.sidewalk, 'bridge-walkways', false);
  addMesh(deckMarks, mats.marking, 'bridge-markings', false);
  const colored = (mb: MeshBuilder, mat: unknown, name: string, shadow: boolean) => {
    if (!mb.vertexCount) return;
    const m = new THREE.Mesh(mb.build({ color: true }), mat as THREE.Material);
    m.castShadow = shadow;
    m.receiveShadow = true;
    m.name = name;
    m.userData.pick = { ids: features, owners: mb.triangleOwner };
    group.add(m);
  };
  colored(tubeWalls, mats.tunnelWall, 'tunnel-walls', true);
  colored(glow, mats.tunnelGlow, 'tunnel-lights', false);
  colored(fixtures, mats.tunnelFixture, 'tunnel-fittings', false);
  return group;
}
