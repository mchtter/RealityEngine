import { closestOnSegment, pointInRing } from './geo';
import type { Projection } from './tiles';
import type { GeoTerrainGrid, Polygon, TerrainGrid, Vec2 } from './types';

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
  /** Half of the carriageway (levelled at the road's own height). */
  carriage?: number;
}

/** A road for the road surface: centreline with its (smoothed) heights. */
export interface SurfaceRoad {
  points: Vec2[];
  profile: number[];
  halfWidth: number;
  carriage: number;
}

interface SurfaceSeg {
  a: Vec2;
  b: Vec2;
  za: number;
  zb: number;
  half: number;
  carriage: number;
}

/**
 * The street surface as a continuous height field: on a carriageway the
 * road's own (along-road smoothed) centreline height, so roads have no
 * cross-slope; off it (sidewalks, medians, verges) the heights of the roads
 * around, weighted by closeness to their carriageway edges, so parallel roads
 * at different levels on a hillside meet in a slope across the median. The
 * terrain grid is levelled to it, and the viewer drapes road surfaces on it
 * directly (finer than the 4 m grid, whose triangles crossing a carriageway
 * edge drew the edge as a wave).
 */
export class RoadSurface {
  private readonly segs: SurfaceSeg[] = [];
  private readonly index = new Map<string, number[]>();
  private readonly bucket = 16;

  constructor(
    roads: SurfaceRoad[],
    private readonly shoulder = 4,
  ) {
    for (const road of roads) {
      for (let k = 1; k < road.points.length; k++) {
        this.segs.push({
          a: road.points[k - 1],
          b: road.points[k],
          za: road.profile[k - 1],
          zb: road.profile[k],
          half: road.halfWidth,
          carriage: Math.min(road.halfWidth, road.carriage),
        });
      }
    }
    this.segs.forEach((sg, k) => {
      const pad = sg.half + shoulder;
      const x0 = Math.floor((Math.min(sg.a[0], sg.b[0]) - pad) / this.bucket);
      const x1 = Math.floor((Math.max(sg.a[0], sg.b[0]) + pad) / this.bucket);
      const y0 = Math.floor((Math.min(sg.a[1], sg.b[1]) - pad) / this.bucket);
      const y1 = Math.floor((Math.max(sg.a[1], sg.b[1]) + pad) / this.bucket);
      for (let bx = x0; bx <= x1; bx++) {
        for (let by = y0; by <= y1; by++) {
          const key = `${bx},${by}`;
          const list = this.index.get(key);
          if (list) list.push(k);
          else this.index.set(key, [k]);
        }
      }
    });
  }

  /**
   * Surface height at a point and its coverage: 1 inside a street corridor
   * (carriageway + sidewalks), fading to 0 over the shoulder; null beyond.
   */
  sample(x: number, y: number): { z: number; w: number; carriage: boolean } | null {
    const list = this.index.get(`${Math.floor(x / this.bucket)},${Math.floor(y / this.bucket)}`);
    if (!list) return null;
    const p: Vec2 = [x, y];
    let cover = 0;
    let onRoad: { z: number; d: number } | null = null;
    let sumW = 0;
    let sumZ = 0;
    for (const k of list) {
      const sg = this.segs[k];
      const { t: tt, d } = closestOnSegment(p, sg.a, sg.b);
      const excess = d - sg.half;
      if (excess > this.shoulder) continue;
      const z = sg.za + (sg.zb - sg.za) * tt;
      cover = Math.max(cover, excess <= 0 ? 1 : 1 - excess / this.shoulder);
      if (d <= sg.carriage && (!onRoad || d < onRoad.d)) onRoad = { z, d };
      const w = 1 / (Math.max(0, d - sg.carriage) + 0.75) ** 2;
      sumW += w;
      sumZ += w * z;
    }
    if (cover <= 0) return null;
    return { z: onRoad ? onRoad.z : sumZ / sumW, w: cover, carriage: onRoad !== null };
  }

  /** Height inside a street corridor, null outside. */
  heightAt(x: number, y: number): number | null {
    const s = this.sample(x, y);
    return s && s.w >= 1 ? s.z : null;
  }
}

/** Centreline heights of a road on the terrain, smoothed over 25 m along it. */
export function roadProfile(t: TerrainGrid, points: Vec2[]): number[] {
  return smoothAlong(
    points.map((p) => terrainHeightAt(t, p[0], p[1])),
    points,
    25,
  );
}

/**
 * Levels the terrain to the street surface (RoadSurface) inside every road
 * corridor, blending into the ground over `shoulder` metres. Returns each
 * road's centreline profile (in the order given).
 */
export function conformTerrainToRoads(
  t: TerrainGrid,
  roads: ConformRoad[],
  shoulder = 4,
): number[][] {
  const surfaceRoads: SurfaceRoad[] = roads.map((r) => ({
    points: r.points,
    profile: roadProfile(t, r.points),
    halfWidth: r.halfWidth,
    carriage: r.carriage ?? r.halfWidth,
  }));
  const surface = new RoadSurface(surfaceRoads, shoulder);
  const original = t.heights.slice();
  for (let j = 0; j < t.rows; j++) {
    for (let i = 0; i < t.cols; i++) {
      const s = surface.sample(t.minX + i * t.cellSize, t.minY + j * t.cellSize);
      if (!s) continue;
      const idx = j * t.cols + i;
      const h = original[idx] + (s.z - original[idx]) * s.w;
      t.heights[idx] = Math.round(Math.max(h, t.seaLevel + 0.3) * 100) / 100;
    }
  }
  return surfaceRoads.map((r) => r.profile);
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

/**
 * Lifts ground the elevation model puts at or below the sea (reclaimed coast,
 * DEM noise) to just above it wherever there is land in the data: within
 * `reach` of a road, a building or a land area. The sea then shows only on
 * open water instead of flooding parks and streets on the shore.
 */
export function raiseLandAboveSea(
  t: TerrainGrid,
  land: { segments: [Vec2, Vec2][]; polygons: Polygon[] },
  reach = 20,
): void {
  const floor = t.seaLevel + 1.0;
  if (!t.heights.some((h) => h < floor)) return;
  const mark = new Uint8Array(t.heights.length);
  const nodes = (
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    fn: (idx: number, p: Vec2) => void,
  ) => {
    const i0 = Math.max(0, Math.floor((minX - t.minX) / t.cellSize));
    const i1 = Math.min(t.cols - 1, Math.ceil((maxX - t.minX) / t.cellSize));
    const j0 = Math.max(0, Math.floor((minY - t.minY) / t.cellSize));
    const j1 = Math.min(t.rows - 1, Math.ceil((maxY - t.minY) / t.cellSize));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const idx = j * t.cols + i;
        if (t.heights[idx] >= floor || mark[idx]) continue;
        fn(idx, [t.minX + i * t.cellSize, t.minY + j * t.cellSize]);
      }
  };
  for (const [a, b] of land.segments) {
    nodes(
      Math.min(a[0], b[0]) - reach,
      Math.min(a[1], b[1]) - reach,
      Math.max(a[0], b[0]) + reach,
      Math.max(a[1], b[1]) + reach,
      (idx, p) => {
        if (closestOnSegment(p, a, b).d <= reach) mark[idx] = 1;
      },
    );
  }
  for (const poly of land.polygons) {
    let bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const q of poly.outer)
      bb = [
        Math.min(bb[0], q[0]),
        Math.min(bb[1], q[1]),
        Math.max(bb[2], q[0]),
        Math.max(bb[3], q[1]),
      ];
    nodes(bb[0] - reach, bb[1] - reach, bb[2] + reach, bb[3] + reach, (idx, p) => {
      if (pointInRing(p, poly.outer)) mark[idx] = 1;
      else
        for (let k = 0; k < poly.outer.length && !mark[idx]; k++) {
          const a = poly.outer[k];
          const b = poly.outer[(k + 1) % poly.outer.length];
          if (closestOnSegment(p, a, b).d <= reach) mark[idx] = 1;
        }
    });
  }
  for (let idx = 0; idx < mark.length; idx++) if (mark[idx]) t.heights[idx] = floor;
}
