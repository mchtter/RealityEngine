/**
 * Pure maths of the live objects layer (live-objects.ts): dead reckoning
 * between fixes, height of an object, its minimum on-screen size, fading of a
 * stale object and screen-space picking. No three.js here (unit tested).
 */

/** Longest a fix is carried forward along its course (s): a silent object stops there. */
export const MAX_PREDICT_S = 20;
/** Lowest an airborne object is drawn above the ground (m). */
export const AIR_CLEARANCE = 2;

/**
 * Where an object with a course and speed is `dtSec` after its fix (world
 * metres, x east / y north): carried along its heading, at most MAX_PREDICT_S.
 */
export function predictXY(
  x: number,
  y: number,
  headingDeg: number | undefined,
  speed: number | undefined,
  dtSec: number,
): [number, number] {
  if (
    headingDeg === undefined ||
    speed === undefined ||
    !Number.isFinite(headingDeg) ||
    !Number.isFinite(speed) ||
    speed < 0.5 ||
    dtSec <= 0
  )
    return [x, y];
  const t = Math.min(dtSec, MAX_PREDICT_S);
  const h = (headingDeg * Math.PI) / 180;
  return [x + Math.sin(h) * speed * t, y + Math.cos(h) * speed * t];
}

/**
 * World height of an object: `alt` (metres above sea level, the twin's height
 * datum) kept at least AIR_CLEARANCE above the ground; without one, the ground.
 */
export function liveHeight(alt: number | undefined, ground: number): number {
  if (alt === undefined || alt === null || !Number.isFinite(alt)) return ground;
  return Math.max(alt, ground + AIR_CLEARANCE);
}

/** Compass heading (degrees clockwise from north) → rotation about three's up axis (models face north). */
export const yawOf = (headingDeg: number) => (-headingDeg * Math.PI) / 180;

/** Eases `from` towards `to` (radians) the shortest way round by factor k. */
export function easeAngle(from: number, to: number, k: number): number {
  let d = to - from;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return from + d * k;
}

/** Share of the way to the target eased in `dt` seconds at `rate` (frame-rate independent). */
export const easeFactor = (dt: number, rate: number) => 1 - Math.exp(-Math.max(0, dt) * rate);

/**
 * Scale making an object of `size` metres at `distance` span at least `minPx`
 * pixels on a viewport `viewportPx` high (vertical field of view `fovDeg`);
 * 1 when it is big enough, at most `maxScale`.
 */
export function minScreenScale(
  distance: number,
  fovDeg: number,
  viewportPx: number,
  size: number,
  minPx: number,
  maxScale = 60,
): number {
  if (size <= 0 || viewportPx <= 0 || distance <= 0) return 1;
  const metresPerPx = (2 * distance * Math.tan((fovDeg * Math.PI) / 360)) / viewportPx;
  const need = (minPx * metresPerPx) / size;
  return Math.min(maxScale, Math.max(1, need));
}

/**
 * How faded a stale object is (0 fresh … 1 about to be dropped): fresh for
 * the first half of its feed's stale time, then fading.
 */
export function staleFade(ageMs: number, staleMs: number): number {
  if (staleMs <= 0) return 0;
  return Math.min(1, Math.max(0, (ageMs - staleMs / 2) / (staleMs / 2)));
}

/** A drawn object on the screen: px from the canvas' top left, its own radius (px). */
export interface ScreenPoint {
  x: number;
  y: number;
  radius: number;
}

/**
 * Index of the object nearest to a click at (sx, sy) within `maxPx` (or the
 * object's own drawn radius when larger); -1 when none.
 */
export function nearestOnScreen(
  points: readonly (ScreenPoint | null)[],
  sx: number,
  sy: number,
  maxPx = 12,
): number {
  let best = -1;
  let bestD = Infinity;
  points.forEach((p, i) => {
    if (!p) return;
    const d = Math.hypot(p.x - sx, p.y - sy);
    if (d <= Math.max(maxPx, p.radius) && d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}
