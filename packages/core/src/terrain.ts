import { closestOnSegment } from './geo';
import type { Projection } from './tiles';
import type { GeoTerrainGrid, TerrainGrid, Vec2 } from './types';

/** Heights at or below this (m) in the source DEM are treated as open sea. */
const SEA_THRESHOLD = 0.2;
/** Depth given to sea cells so the shore slopes under the water plane. */
const SEABED = -4;

/**
 * Samples a terrain grid with the same triangulation the renderer uses: each
 * cell is split along its (i, j) → (i + 1, j + 1) diagonal. Draped geometry
 * sampled here sits exactly on the rendered mesh.
 */
export function terrainHeightAt(t: TerrainGrid, x: number, y: number): number {
  const fx = Math.min(Math.max((x - t.minX) / t.cellSize, 0), t.cols - 1.0001);
  const fy = Math.min(Math.max((y - t.minY) / t.cellSize, 0), t.rows - 1.0001);
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const u = fx - i;
  const v = fy - j;
  const h = (ii: number, jj: number) => t.heights[jj * t.cols + ii];
  const h00 = h(i, j);
  const h11 = h(i + 1, j + 1);
  if (u >= v) {
    // triangle (i,j) (i+1,j) (i+1,j+1)
    return h00 + (h(i + 1, j) - h00) * u + (h11 - h(i + 1, j)) * v;
  }
  // triangle (i,j) (i+1,j+1) (i,j+1)
  return h00 + (h11 - h(i, j + 1)) * u + (h(i, j + 1) - h00) * v;
}

function boxBlur(src: Float32Array, cols: number, rows: number, passes: number): Float32Array {
  let a = src;
  for (let pass = 0; pass < passes; pass++) {
    const b = new Float32Array(a.length);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let sum = 0;
        let n = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
            sum += a[rr * cols + cc];
            n++;
          }
        }
        b[r * cols + c] = sum / n;
      }
    }
    a = b;
  }
  return a;
}

/**
 * Resamples a geographic DEM onto a local metric grid. The Copernicus DEM is a
 * surface model (includes buildings / trees at 30 m), so it is smoothed before
 * use; sea cells are pushed below sea level to give a sloping shore.
 */
export function buildTerrain(
  geo: GeoTerrainGrid | undefined,
  proj: Projection,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  cellSize: number,
): TerrainGrid {
  const cols = Math.ceil((bounds.maxX - bounds.minX) / cellSize) + 1;
  const rows = Math.ceil((bounds.maxY - bounds.minY) / cellSize) + 1;
  // Without a DEM the city sits on a flat plain comfortably above sea level.
  const heights = new Array<number>(cols * rows).fill(10);
  const grid: TerrainGrid = {
    minX: bounds.minX,
    minY: bounds.minY,
    cellSize,
    cols,
    rows,
    heights,
    seaLevel: 0,
  };
  if (!geo) return grid;

  const raw = new Float32Array(geo.heights.length);
  for (let k = 0; k < raw.length; k++) {
    raw[k] = geo.heights[k] <= SEA_THRESHOLD ? SEABED : geo.heights[k];
  }
  const smooth = boxBlur(raw, geo.cols, geo.rows, 2);
  const sample = (lon: number, lat: number) => {
    const fc = ((lon - geo.west) / (geo.east - geo.west)) * (geo.cols - 1);
    const fr = ((geo.north - lat) / (geo.north - geo.south)) * (geo.rows - 1);
    const c = Math.min(Math.max(Math.floor(fc), 0), geo.cols - 2);
    const r = Math.min(Math.max(Math.floor(fr), 0), geo.rows - 2);
    const u = Math.min(Math.max(fc - c, 0), 1);
    const v = Math.min(Math.max(fr - r, 0), 1);
    const at = (rr: number, cc: number) => smooth[rr * geo.cols + cc];
    return (
      at(r, c) * (1 - u) * (1 - v) +
      at(r, c + 1) * u * (1 - v) +
      at(r + 1, c) * (1 - u) * v +
      at(r + 1, c + 1) * u * v
    );
  };

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const { lon, lat } = proj.inverse(bounds.minX + i * cellSize, bounds.minY + j * cellSize);
      heights[j * cols + i] = Math.round(sample(lon, lat) * 100) / 100;
    }
  }
  return grid;
}

export interface ConformRoad {
  points: Vec2[];
  /** Half of carriageway + sidewalks. */
  halfWidth: number;
}

/**
 * Levels the terrain across every road corridor: vertices inside a corridor
 * take the (along-road smoothed) centreline height, with a linear blend over
 * `shoulder` metres outside. Roads then have no cross-slope and draped road
 * surfaces never cut into the ground.
 */
export function conformTerrainToRoads(t: TerrainGrid, roads: ConformRoad[], shoulder = 4): void {
  interface Seg {
    a: Vec2;
    b: Vec2;
    za: number;
    zb: number;
    half: number;
  }
  const segs: Seg[] = [];
  for (const road of roads) {
    const zs = smoothAlong(
      road.points.map((p) => terrainHeightAt(t, p[0], p[1])),
      road.points,
      25,
    );
    for (let k = 1; k < road.points.length; k++) {
      segs.push({
        a: road.points[k - 1],
        b: road.points[k],
        za: zs[k - 1],
        zb: zs[k],
        half: road.halfWidth,
      });
    }
  }

  // Spatial hash of segments by grid cell ranges.
  const bucket = 16;
  const index = new Map<string, number[]>();
  segs.forEach((s, k) => {
    const pad = s.half + shoulder;
    const x0 = Math.floor((Math.min(s.a[0], s.b[0]) - pad) / bucket);
    const x1 = Math.floor((Math.max(s.a[0], s.b[0]) + pad) / bucket);
    const y0 = Math.floor((Math.min(s.a[1], s.b[1]) - pad) / bucket);
    const y1 = Math.floor((Math.max(s.a[1], s.b[1]) + pad) / bucket);
    for (let bx = x0; bx <= x1; bx++) {
      for (let by = y0; by <= y1; by++) {
        const key = `${bx},${by}`;
        const list = index.get(key);
        if (list) list.push(k);
        else index.set(key, [k]);
      }
    }
  });

  const original = t.heights.slice();
  for (let j = 0; j < t.rows; j++) {
    for (let i = 0; i < t.cols; i++) {
      const p: Vec2 = [t.minX + i * t.cellSize, t.minY + j * t.cellSize];
      const list = index.get(`${Math.floor(p[0] / bucket)},${Math.floor(p[1] / bucket)}`);
      if (!list) continue;
      let bestW = 0;
      let bestZ = 0;
      let bestD = Infinity;
      for (const k of list) {
        const s = segs[k];
        const { t: tt, d } = closestOnSegment(p, s.a, s.b);
        const excess = d - s.half;
        if (excess > shoulder) continue;
        const w = excess <= 0 ? 1 : 1 - excess / shoulder;
        // Prefer the corridor the point is deepest inside (junctions: nearest centreline).
        if (w > bestW || (w === bestW && d < bestD)) {
          bestW = w;
          bestD = d;
          bestZ = s.za + (s.zb - s.za) * tt;
        }
      }
      if (bestW > 0) {
        const idx = j * t.cols + i;
        const h = original[idx] + (bestZ - original[idx]) * bestW;
        t.heights[idx] = Math.round(Math.max(h, t.seaLevel + 0.3) * 100) / 100;
      }
    }
  }
}

/** Moving average of values along a polyline over a window of `window` metres. */
function smoothAlong(values: number[], points: Vec2[], window: number): number[] {
  const at: number[] = [0];
  for (let k = 1; k < points.length; k++) {
    at.push(
      at[k - 1] + Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1]),
    );
  }
  return values.map((_, k) => {
    let sum = 0;
    let n = 0;
    for (let m = 0; m < values.length; m++) {
      if (Math.abs(at[m] - at[k]) <= window / 2) {
        sum += values[m];
        n++;
      }
    }
    return n ? sum / n : values[k];
  });
}
