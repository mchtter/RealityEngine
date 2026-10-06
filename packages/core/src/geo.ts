import type { LonLat, Vec2 } from './types';

const EARTH_RADIUS = 6_378_137;
const DEG = Math.PI / 180;

/**
 * Local tangent-plane projection (equirectangular around the origin). Error is
 * well under a centimetre per 100 m for city-sized areas (< 10 km).
 */
export class LocalProjection {
  private readonly kx: number;
  private readonly ky: number;
  /** Local mode has no global frame: ids and seeds use local coordinates. */
  readonly globalOffset: Vec2 = [0, 0];

  constructor(readonly origin: LonLat) {
    this.ky = EARTH_RADIUS * DEG;
    this.kx = EARTH_RADIUS * DEG * Math.cos(origin.lat * DEG);
  }

  forward(lon: number, lat: number): Vec2 {
    return [(lon - this.origin.lon) * this.kx, (lat - this.origin.lat) * this.ky];
  }

  inverse(x: number, y: number): LonLat {
    return { lon: this.origin.lon + x / this.kx, lat: this.origin.lat + y / this.ky };
  }
}

// ─── Vector helpers ──────────────────────────────────────────────────────────

export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const scale = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
export const len = (a: Vec2): number => Math.hypot(a[0], a[1]);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

export function normalize(a: Vec2): Vec2 {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l] : [1, 0];
}

/** Left-hand normal of a direction (rotate +90°). */
export const perp = (a: Vec2): Vec2 => [-a[1], a[0]];

export function polylineLength(points: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/** Closest point on segment ab to p, with parameter t in [0, 1]. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number; d: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  const point = lerp2(a, b, t);
  return { point, t, d: dist(p, point) };
}

/** Samples a polyline every `step` metres, returning points with their tangent. */
export function samplePolyline(
  points: Vec2[],
  step: number,
  offset = 0,
): { point: Vec2; dir: Vec2; at: number }[] {
  const out: { point: Vec2; dir: Vec2; at: number }[] = [];
  let walked = 0;
  let next = offset;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segLen = dist(a, b);
    if (segLen < 1e-6) continue;
    const dir = normalize(sub(b, a));
    while (next <= walked + segLen) {
      out.push({ point: lerp2(a, b, (next - walked) / segLen), dir, at: next });
      next += step;
    }
    walked += segLen;
  }
  return out;
}

/** Signed area of an open ring (positive = CCW). */
export function ringArea(ring: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return a / 2;
}

export function ringCentroid(ring: Vec2[]): Vec2 {
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = ring.length || 1;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInRing(p: Vec2, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Minimum-area oriented bounding rectangle (rotating calipers over hull edges). */
export function orientedBox(ring: Vec2[]): {
  center: Vec2;
  axis: Vec2;
  halfLength: number;
  halfWidth: number;
  area: number;
} {
  const hull = convexHull(ring);
  let best = {
    center: [0, 0] as Vec2,
    axis: [1, 0] as Vec2,
    halfLength: 0,
    halfWidth: 0,
    area: Infinity,
  };
  for (let i = 0; i < hull.length; i++) {
    const axis = normalize(sub(hull[(i + 1) % hull.length], hull[i]));
    const nrm = perp(axis);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = dot(p, axis);
      const v = dot(p, nrm);
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < best.area) {
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      let a = axis;
      let hl = (maxU - minU) / 2;
      let hw = (maxV - minV) / 2;
      if (hw > hl) {
        a = nrm;
        [hl, hw] = [hw, hl];
      }
      best = {
        center: add(scale(axis, cu), scale(nrm, cv)),
        axis: a,
        halfLength: hl,
        halfWidth: hw,
        area,
      };
    }
  }
  return best;
}

export function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(
        sub(lower[lower.length - 1], lower[lower.length - 2]),
        sub(p, lower[lower.length - 1]),
      ) <= 0
    )
      lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (
      upper.length >= 2 &&
      cross(
        sub(upper[upper.length - 1], upper[upper.length - 2]),
        sub(p, upper[upper.length - 1]),
      ) <= 0
    )
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Douglas–Peucker simplification of a closed ring (keeps at least 3 vertices). */
export function simplifyRing(ring: Vec2[], tolerance: number): Vec2[] {
  if (ring.length <= 4) return ring;
  // Split at the vertex farthest from the first so both halves are open polylines.
  let far = 0;
  let farD = -1;
  for (let k = 1; k < ring.length; k++) {
    const d = dist(ring[0], ring[k]);
    if (d > farD) {
      farD = d;
      far = k;
    }
  }
  const a = simplifyLine(ring.slice(0, far + 1), tolerance);
  const b = simplifyLine([...ring.slice(far), ring[0]], tolerance);
  const out = a.slice(0, -1).concat(b.slice(0, -1));
  return out.length >= 3 ? out : ring;
}

/** Douglas–Peucker simplification of an open polyline (keeps its ends). */
export function simplifyLine(points: Vec2[], tolerance: number): Vec2[] {
  if (points.length <= 2) return points;
  const a = points[0];
  const b = points[points.length - 1];
  let idx = -1;
  let maxD = 0;
  for (let k = 1; k < points.length - 1; k++) {
    const d = closestOnSegment(points[k], a, b).d;
    if (d > maxD) {
      maxD = d;
      idx = k;
    }
  }
  if (maxD <= tolerance) return [a, b];
  return simplifyLine(points.slice(0, idx + 1), tolerance)
    .slice(0, -1)
    .concat(simplifyLine(points.slice(idx), tolerance));
}
