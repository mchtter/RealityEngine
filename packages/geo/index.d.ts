/** Loads the WebAssembly module (a URL, a Response or the bytes; default: next to this file). */
export function initKentosGeo(input?: string | URL | Response | BufferSource): Promise<void>;
/** Synchronous load from the module's bytes (Node, tests). */
export function initKentosGeoSync(bytes: BufferSource): void;
export function kentosGeoReady(): boolean;

export interface KentosGrid {
  cols: number;
  rows: number;
  minX: number;
  minY: number;
  cellSize: number;
  heights: ArrayLike<number>;
}

/** Drapes a polygon on the terrain mesh; `data` = `[n, m, f, x, y, z …, i0, i1, i2 …, ci, cj …]`. */
export function drapeOnTerrain(
  grid: KentosGrid,
  poly: { outer: [number, number][]; holes?: [number, number][][] },
  lift: number,
  step?: number,
): { vertices: number; triangles: number; cells: number; data: Float32Array };
