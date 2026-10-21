// Kavra geometry kernels (crates/kavra-geo) in the browser and Node.
// docs/DECISIONS.md D-008. Call initKavraGeo() once (async) before use;
// until then `kavraGeoReady()` is false and callers keep their TS path.
import init, { Terrain, initSync } from './pkg/kavra_geo.js';

let ready = false;

/** Loads the WebAssembly module (a URL, a Response or the bytes; default: next to this file). */
export async function initKavraGeo(input) {
  if (ready) return;
  await init(input === undefined ? undefined : { module_or_path: input });
  ready = true;
}

/** Synchronous load from the module's bytes (Node, tests). */
export function initKavraGeoSync(bytes) {
  if (ready) return;
  initSync({ module: bytes });
  ready = true;
}

export const kavraGeoReady = () => ready;

// A tile's terrain is copied into WASM memory once and freed with the grid.
const terrains = new WeakMap();
const freeTerrain = new FinalizationRegistry((t) => t.free());

function terrainOf(grid) {
  let t = terrains.get(grid);
  if (!t) {
    const heights =
      grid.heights instanceof Float32Array ? grid.heights : Float32Array.from(grid.heights);
    t = new Terrain(heights, grid.cols, grid.rows, grid.minX, grid.minY, grid.cellSize);
    terrains.set(grid, t);
    freeTerrain.register(grid, t);
  }
  return t;
}

const flat = (ring) => {
  const out = new Float64Array(ring.length * 2);
  for (let k = 0; k < ring.length; k++) {
    out[k * 2] = ring[k][0];
    out[k * 2 + 1] = ring[k][1];
  }
  return out;
};

/**
 * Drapes a polygon on the terrain mesh (geom.ts `drapeOnTerrain`): returns
 * the vertex, triangle and whole-cell counts and one Float32Array `[n, m, f,
 * x, y, z …, i0, i1, i2 …, ci, cj …]` (positions in model metres, x east /
 * y north / z up, from 3; indices from `3 + 3n`; cells from `3 + 3n + 3m`).
 */
export function drapeOnTerrain(grid, poly, lift, step = 1) {
  const holes = poly.holes ?? [];
  let points = 0;
  for (const h of holes) points += h.length;
  const holeFlat = new Float64Array(points * 2);
  const starts = new Uint32Array(holes.length);
  let at = 0;
  holes.forEach((h, k) => {
    starts[k] = at;
    holeFlat.set(flat(h), at * 2);
    at += h.length;
  });
  const data = terrainOf(grid).drape(flat(poly.outer), holeFlat, starts, lift, step);
  return { vertices: data[0], triangles: data[1], cells: data[2], data };
}

/**
 * One ground chunk with every surface layer made disjoint (crates/kavra-geo
 * ground.rs). `cells`: the chunk's grid cells [i0, j0, i1, j1). `layers`:
 * highest priority first, `{ polygons, lift, deferred }` — a deferred layer's
 * heights come back NaN (the caller fills them, e.g. from the street
 * surface); a `mask` layer cuts the layers below and the bare ground but
 * draws nothing (a trench). Returns per layer its mesh and its region's rings, the bare
 * ground of the cells the surfaces touch, and the covered / touched cells
 * (row-major `j * cols + i`).
 */
export function groundChunk(grid, cells, layers) {
  const meta = new Float64Array(layers.length * 3);
  const parts = [];
  let size = 0;
  layers.forEach((l, k) => {
    meta[k * 3] = l.lift;
    meta[k * 3 + 1] = l.mask ? 2 : l.deferred ? 1 : 0;
    meta[k * 3 + 2] = l.polygons.length;
    for (const p of l.polygons) {
      const holes = p.holes ?? [];
      parts.push(p);
      size += 2 + holes.length + p.outer.length * 2 + holes.reduce((a, h) => a + h.length * 2, 0);
    }
  });
  const polys = new Float64Array(size);
  let at = 0;
  for (const p of parts) {
    const holes = p.holes ?? [];
    polys[at++] = p.outer.length;
    polys[at++] = holes.length;
    for (const h of holes) polys[at++] = h.length;
    for (const ring of [p.outer, ...holes])
      for (const q of ring) {
        polys[at++] = q[0];
        polys[at++] = q[1];
      }
  }
  const d = terrainOf(grid).ground(Uint32Array.from(cells), meta, polys);
  let i = 0;
  const mesh = () => {
    const vertices = d[i++];
    const triangles = d[i++];
    return { vertices, triangles };
  };
  const out = { layers: [], bare: null, covered: null, touched: null };
  const L = d[i++];
  for (let k = 0; k < L; k++) {
    const m = mesh();
    const count = d[i++];
    const shape = [];
    for (let c = 0; c < count; c++) shape.push([d[i++], d[i++] === 1]);
    const positions = d.subarray(i, i + m.vertices * 3);
    i += m.vertices * 3;
    const indices = d.subarray(i, i + m.triangles * 3);
    i += m.triangles * 3;
    const rings = shape.map(([n, hole]) => {
      const ring = [];
      for (let q = 0; q < n; q++) ring.push([d[i++], d[i++]]);
      return { ring, hole };
    });
    out.layers.push({ ...m, positions, indices, rings });
  }
  const b = mesh();
  const bp = d.subarray(i, i + b.vertices * 3);
  i += b.vertices * 3;
  const bi = d.subarray(i, i + b.triangles * 3);
  i += b.triangles * 3;
  out.bare = { ...b, positions: bp, indices: bi };
  const nc = d[i++];
  out.covered = d.subarray(i, i + nc);
  i += nc;
  const nt = d[i++];
  out.touched = d.subarray(i, i + nt);
  return out;
}
