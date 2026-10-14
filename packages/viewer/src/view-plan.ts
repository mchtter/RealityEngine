/**
 * Which tiles to fetch first, from where the camera stands and looks: tiles
 * in view come before tiles behind, near before far, and the plan leans
 * ahead of a moving camera so the place it heads for is ready on arrival.
 */

/** The camera for planning: ground position (UTM metres), height above the ground, view direction. */
export interface EyeView {
  e: number;
  n: number;
  /** Height above the ground (m). */
  height: number;
  /** Compass heading the camera looks along (degrees, 0 = north, clockwise). */
  heading: number;
  /** Degrees below the horizon the camera looks (90 = straight down). */
  pitch: number;
}

/** Half the horizontal field of view counted as "in view", with a margin for turning. */
const IN_VIEW_DEG = 55;
/** Around the eye every tile counts as in view (the ground under and beside the camera). */
const AROUND_EYE_M = 700;
/** How much farther a tile right behind the camera counts (× its distance). */
const BEHIND_FACTOR = 4;
/** Lean of the plan ahead of the camera: never more than this (m). */
const MAX_LEAN_M = 1500;
/** Motion look-ahead: where the camera will be this many seconds on, at most this far (m). */
const AHEAD_S = 1.5;
const MAX_AHEAD_M = 2000;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 1 looking straight down (direction does not matter), 0 looking at the horizon. */
export const downness = (pitch: number) => smooth(55, 80, pitch);

/**
 * Planning distance (m) of a tile centre from the eye: its distance in 3D,
 * longer for a tile outside the view (up to BEHIND_FACTOR × right behind).
 */
export function viewScore(tile: [number, number], eye: EyeView): number {
  const dx = tile[0] - eye.e;
  const dy = tile[1] - eye.n;
  const flat = Math.hypot(dx, dy);
  const d3 = Math.hypot(flat, Math.max(0, eye.height));
  if (flat < AROUND_EYE_M) return d3;
  const h = (eye.heading * Math.PI) / 180;
  const cos = (dx * Math.sin(h) + dy * Math.cos(h)) / flat;
  const edge = Math.cos((IN_VIEW_DEG * Math.PI) / 180);
  const outside = cos >= edge ? 0 : (edge - cos) / (edge + 1);
  const weight = 1 + outside * (BEHIND_FACTOR - 1) * (1 - downness(eye.pitch));
  return d3 * weight;
}

/**
 * Centre of the tile plan (UTM metres): the camera target, leaned toward the
 * view (more the higher and flatter the camera looks) and ahead of the
 * motion (`velocity` m/s).
 */
export function planCentre(
  target: [number, number],
  eye: EyeView,
  velocity: [number, number] = [0, 0],
): [number, number] {
  const h = (eye.heading * Math.PI) / 180;
  const lean = (1 - downness(eye.pitch)) * Math.min(MAX_LEAN_M, Math.max(300, eye.height * 3));
  let ax = velocity[0] * AHEAD_S;
  let ay = velocity[1] * AHEAD_S;
  const ahead = Math.hypot(ax, ay);
  if (ahead > MAX_AHEAD_M) {
    ax *= MAX_AHEAD_M / ahead;
    ay *= MAX_AHEAD_M / ahead;
  }
  return [target[0] + Math.sin(h) * lean + ax, target[1] + Math.cos(h) * lean + ay];
}
