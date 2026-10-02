import {
  type CityModel,
  type SurfaceKind,
  clipPolygons,
  rectPolygon,
  terrainHeightAt,
} from '@opentwin/city-core';
import * as THREE from 'three/webgpu';
import { MeshBuilder, drapeOnTerrain, drapeRingWall, toThree } from './geom';
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
};
const SURF_KERB = 6;

/**
 * Height of each surface above the (road-conformed) terrain, metres. Surfaces
 * run exactly parallel to the terrain (drapeOnTerrain), so these fixed steps
 * are the whole layer order: terrain < yard < asphalt < markings < path <
 * paving < sidewalk / island (kerb height above the road).
 */
const LIFT: Record<SurfaceKind, number> = {
  yard: 0.05,
  asphalt: 0.1,
  path: 0.13,
  paving: 0.16,
  sidewalk: 0.24,
  island: 0.24,
};
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

/**
 * Terrain mesh sampling every `step`-th grid node (1 = full 4 m grid), with
 * a skirt hanging `skirt` metres down along the tile edge so neighbouring
 * tiles at a different resolution never show cracks.
 */
function terrainMesh(
  model: CityModel,
  mat: THREE.Material,
  step = 1,
  skirt = 0,
  /** Grid node range [i0, j0, i1, j1] (inclusive); whole grid by default. */
  range?: [number, number, number, number],
): THREE.Mesh {
  const t = model.terrain;
  const [i0, j0, i1, j1] = range ?? [0, 0, t.cols - 1, t.rows - 1];
  const cols = Math.floor((i1 - i0) / step) + 1;
  const rows = Math.floor((j1 - j0) / step) + 1;
  const positions: number[] = [];
  const gi = (i: number) => i0 + i * step;
  const gj = (j: number) => j0 + j * step;
  const height = (i: number, j: number) => t.heights[gj(j) * t.cols + gi(i)];
  const at = (i: number, j: number, dz = 0) =>
    toThree(t.minX + gi(i) * t.cellSize, t.minY + gj(j) * t.cellSize, height(i, j) - dz);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) positions.push(...at(i, j));
  }
  // Same diagonal as terrainHeightAt: (i,j)-(i+1,j+1).
  const indices: number[] = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
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
      return k;
    });
    for (let k = 0; k < ring.length; k++) {
      const n = (k + 1) % ring.length;
      // Outward-facing quad (top edge k → n, dropped below).
      indices.push(top[k], bottom[k], bottom[n], top[k], bottom[n], top[n]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(
    positions.length / 3 > 65535
      ? new THREE.Uint32BufferAttribute(indices, 1)
      : new THREE.Uint16BufferAttribute(indices, 1),
  );
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true;
  mesh.name = step === 1 ? 'terrain' : 'terrain-coarse';
  return mesh;
}

/** Sea: a large plane at sea level, reaching past the terrain edge. */
export function seaPlane(
  model: Pick<CityModel, 'bounds' | 'terrain'>,
  mats: DtMaterials,
): THREE.Mesh {
  const b = model.bounds;
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), mats.water);
  sea.rotation.x = -Math.PI / 2;
  sea.position.set((b.minX + b.maxX) / 2, model.terrain.seaLevel, -(b.minY + b.maxY) / 2);
  sea.receiveShadow = true;
  sea.name = 'sea';
  return sea;
}

/** Inserts points so no segment is longer than `step` metres. */
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
  model: CityModel,
  line: [number, number][],
  width: number,
  lift: number,
): void {
  const pts = densify(line, RIBBON_STEP);
  const half = width / 2;
  const t = model.terrain;
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
    const z = terrainHeightAt(t, p[0], p[1]) + lift;
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
  const far = terrainMesh(model, mats.terrain, FAR_STEP, 6);
  far.userData.role = 'ground:far';
  group.add(far);
  if (opts.sea !== false) group.add(seaPlane(model, mats));

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

      const terrain = terrainMesh(model, mats.terrain, 1, 6, [i0, j0, i1, j1]);
      terrain.userData.role = 'ground:near';
      chunk.add(terrain);

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
      for (const surface of model.surfaces) {
        const polys = surface.polygons.length ? clipPolygons(surface.polygons, cell) : [];
        if (!polys.length) continue;
        for (const poly of polys) {
          overlay.setAttribute('surf', [SURF[surface.kind]]);
          drapeOnTerrain(overlay, poly, model.terrain, LIFT[surface.kind]);
          if (surface.kind === 'sidewalk' || surface.kind === 'island') {
            overlay.setAttribute('surf', [SURF_KERB]);
            for (const ring of [poly.outer, ...poly.holes]) {
              drapeRingWall(
                overlay,
                ring as [number, number][],
                model.terrain,
                LIFT[surface.kind],
                LIFT.asphalt - 0.05,
                true,
                6,
                onCut,
              );
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
        const pts = m.points as [number, number][];
        if (m.kind === 'center-dashed' || m.kind === 'lane-dashed') {
          for (const d of dashes(pts, 3, 5)) ribbon(marks, model, d, 0.13, MARKING_LIFT);
        } else {
          ribbon(marks, model, pts, m.kind === 'edge' ? 0.15 : 0.13, MARKING_LIFT);
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
          ribbon(marks, model, [a, e], 0.5, MARKING_LIFT);
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

  // Bridge decks with side walls.
  const decks = new MeshBuilder();
  for (const br of model.bridges) {
    const half = br.width / 2;
    for (let k = 1; k < br.path.length; k++) {
      const p0 = br.path[k - 1];
      const p1 = br.path[k];
      const dx = p1[0] - p0[0];
      const dy = p1[1] - p0[1];
      const l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l;
      const ny = dx / l;
      const L0: [number, number, number] = [p0[0] + nx * half, p0[1] + ny * half, p0[2]];
      const R0: [number, number, number] = [p0[0] - nx * half, p0[1] - ny * half, p0[2]];
      const L1: [number, number, number] = [p1[0] + nx * half, p1[1] + ny * half, p1[2]];
      const R1: [number, number, number] = [p1[0] - nx * half, p1[1] - ny * half, p1[2]];
      decks.quad([R0, R1, L1, L0], [0, 0, 1], undefined, [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]);
      const drop = 1.2;
      decks.quad(
        [
          [R0[0], R0[1], R0[2] - drop],
          [R1[0], R1[1], R1[2] - drop],
          [R1[0], R1[1], R1[2] + 0.9],
          [R0[0], R0[1], R0[2] + 0.9],
        ],
        [-nx, -ny, 0],
        undefined,
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      );
      decks.quad(
        [
          [L1[0], L1[1], L1[2] - drop],
          [L0[0], L0[1], L0[2] - drop],
          [L0[0], L0[1], L0[2] + 0.9],
          [L1[0], L1[1], L1[2] + 0.9],
        ],
        [nx, ny, 0],
        undefined,
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      );
      decks.quad(
        [
          [L0[0], L0[1], L0[2] - drop],
          [L1[0], L1[1], L1[2] - drop],
          [R1[0], R1[1], R1[2] - drop],
          [R0[0], R0[1], R0[2] - drop],
        ],
        [0, 0, -1],
        undefined,
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      );
    }
  }
  if (decks.vertexCount) {
    const deckMesh = new THREE.Mesh(decks.build(), mats.curb);
    deckMesh.castShadow = true;
    deckMesh.receiveShadow = true;
    deckMesh.name = 'bridges';
    group.add(deckMesh);
  }
  return group;
}
