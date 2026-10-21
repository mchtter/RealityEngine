/** Loads the WebAssembly module (a URL, a Response or the bytes; default: next to this file). */
export function initKavraGeo(input?: string | URL | Response | BufferSource): Promise<void>;
/** Synchronous load from the module's bytes (Node, tests). */
export function initKavraGeoSync(bytes: BufferSource): void;
export function kavraGeoReady(): boolean;

export interface KavraGrid {
  cols: number;
  rows: number;
  minX: number;
  minY: number;
  cellSize: number;
  heights: ArrayLike<number>;
}

/** Drapes a polygon on the terrain mesh; `data` = `[n, m, f, x, y, z …, i0, i1, i2 …, ci, cj …]`. */
export function drapeOnTerrain(
  grid: KavraGrid,
  poly: { outer: [number, number][]; holes?: [number, number][][] },
  lift: number,
  step?: number,
): { vertices: number; triangles: number; cells: number; data: Float32Array };

export interface GroundLayerInput {
  polygons: { outer: [number, number][]; holes?: [number, number][][] }[];
  /** Metres above the height source. */
  lift: number;
  /** Heights come back NaN for the caller to fill. */
  deferred: boolean;
  /** Cuts the layers below and the bare ground but draws nothing (a trench, a lid). */
  mask?: boolean;
}

export interface GroundMesh {
  vertices: number;
  triangles: number;
  /** x, y, z per vertex (model metres, z up). */
  positions: Float32Array;
  /** Vertex indices (as floats). */
  indices: Float32Array;
}

/** One ground chunk with every surface layer made disjoint; see index.js. */
export function groundChunk(
  grid: KavraGrid,
  cells: [number, number, number, number],
  layers: GroundLayerInput[],
): {
  layers: (GroundMesh & { rings: { ring: [number, number][]; hole: boolean }[] })[];
  bare: GroundMesh;
  covered: Float32Array;
  touched: Float32Array;
};
