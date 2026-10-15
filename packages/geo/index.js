// KentOS geometry kernels (crates/kentos-geo) in the browser and Node.
// docs/DECISIONS.md D-008. Call initKentosGeo() once (async) before use;
// until then `kentosGeoReady()` is false and callers keep their TS path.
import init, { Terrain, initSync } from './pkg/kentos_geo.js';

let ready = false;

/** Loads the WebAssembly module (a URL, a Response or the bytes; default: next to this file). */
export async function initKentosGeo(input) {
  if (ready) return;
  await init(input === undefined ? undefined : { module_or_path: input });
  ready = true;
}

/** Synchronous load from the module's bytes (Node, tests). */
export function initKentosGeoSync(bytes) {
  if (ready) return;
  initSync({ module: bytes });
  ready = true;
}

export const kentosGeoReady = () => ready;

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
