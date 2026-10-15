/**
 * Detail levels by the camera's height above the ground, numbered like LOD in
 * BIM (the higher, the more detail): L1 over the city (many tiles, no
 * detail) … L5 at walking height (under 10 m: every detail, few tiles). The
 * level sets how many tiles load and how many of them in full; within a
 * tile, detail falls off with the 3D distance to the camera (city-tile.ts).
 * Bounds follow the screen-space-error rule of 3D tile streaming (Cesium:
 * 16 px) worked out for a 1 km tile grid — tasks/kentos-lod-plan.md §2.
 */

export type DetailLevel = 1 | 2 | 3 | 4 | 5;

/** Upper height bound (m above ground) of L5 … L2; above the last one is L1. */
export const LEVEL_TOPS = [10, 100, 400, 1500] as const;
/** Hysteresis: a level is left only this far (share of the bound) past its bound. */
const BAND = 0.15;
/** A new level holds this long (ms) before it takes effect: no flicker on a zoom bounce. */
export const LEVEL_DWELL_MS = 500;

/** Index of a level's band in LEVEL_TOPS (0: L5, the lowest). */
const bandOf = (level: DetailLevel) => 5 - level;

/** Level of a height with no history. */
export function levelAt(height: number): DetailLevel {
  const k = LEVEL_TOPS.findIndex((top) => height < top);
  return (5 - (k < 0 ? LEVEL_TOPS.length : k)) as DetailLevel;
}

/**
 * Level of a height, given the current one: a bound is crossed only BAND
 * past it, so hovering at a bound does not switch back and forth.
 */
export function nextLevel(height: number, current: DetailLevel): DetailLevel {
  const plain = levelAt(height);
  if (plain === current) return current;
  const band = bandOf(current);
  if (plain < current) {
    // Going up: past the current level's top by the band.
    return height >= LEVEL_TOPS[band] * (1 + BAND) ? levelAt(height / (1 + BAND)) : current;
  }
  // Going down: under the bound below the current level by the band.
  return height < LEVEL_TOPS[band - 1] * (1 - BAND) ? levelAt(height / (1 - BAND)) : current;
}

/** Tiles per level (Chebyshev rings around the plan centre). */
export interface LevelPlan {
  /** Tiles downloaded and meshed. */
  load: number;
  /** Tiles the server compiles ahead. */
  request: number;
  /** Tiles released only beyond this. */
  keep: number;
  /** Tiles loaded in full (the rest at the far level); -1: none. */
  full: number;
}

export const LEVEL_PLANS: Record<DetailLevel, LevelPlan> = {
  // Street level: the tile and its neighbours in full, a ring beyond.
  5: { load: 2, request: 3, keep: 4, full: 1 },
  4: { load: 3, request: 4, keep: 5, full: 1 },
  3: { load: 4, request: 5, keep: 6, full: 1 },
  // From 400 m up the near detail does not show: only the tile below in full.
  2: { load: 5, request: 6, keep: 7, full: 0 },
  1: { load: 6, request: 6, keep: 8, full: -1 },
};
