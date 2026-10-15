/**
 * Lon/lat polygon helpers of the overview map (L0): point in polygon, ring
 * thinning, and whether a work area covers a real part of a province.
 */

export type Ring = [number, number][];
/** Outer ring first, then holes; rings open (the first point not repeated). */
export type Polygon = Ring[];

/** Grid step (deg) of the province ↔ work area overlap test. */
const OVERLAP_STEP = 0.03;

/** Even–odd point in polygon (rings: outer and holes), lon/lat. */
export function insidePolygon(poly: Polygon, lon: number, lat: number): boolean {
  let inside = false;
  for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
  }
  return inside;
}

/** Bounding box of polygons: west, south, east, north. */
function bboxOf(polys: Polygon[]): [number, number, number, number] {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const poly of polys)
    for (const [lon, lat] of poly[0] ?? []) {
      w = Math.min(w, lon);
      e = Math.max(e, lon);
      s = Math.min(s, lat);
      n = Math.max(n, lat);
    }
  return [w, s, e, n];
}

/** Douglas–Peucker over a lon/lat ring (tolerance in degrees); open rings. */
export function thinRing(ring: Ring, tolerance: number): Ring {
  if (ring.length < 8) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = ring[a];
    const [bx, by] = ring[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-12;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((ring[i][0] - ax) * dy - (ring[i][1] - ay) * dx) / len;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at >= 0 && worst > tolerance) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 3 ? out : ring;
}

/** Grid points (OVERLAP_STEP) inside polygons, lon/lat. */
export function samplePoints(polys: Polygon[]): [number, number][] {
  const [w, s, e, n] = bboxOf(polys);
  const out: [number, number][] = [];
  for (let lat = s + OVERLAP_STEP / 2; lat < n; lat += OVERLAP_STEP)
    for (let lon = w + OVERLAP_STEP / 2; lon < e; lon += OVERLAP_STEP)
      if (polys.some((p) => insidePolygon(p, lon, lat))) out.push([lon, lat]);
  return out;
}

/**
 * Whether the work area covers a real part of a province: at least 15 % of
 * the province lies in it, or at least 20 % of the work area lies in the
 * province (a district-sized city). The province borders (Natural Earth)
 * and the work area (from OSM) differ by up to a few km along shared
 * borders: the neighbours of a province-wide work area get a few percent
 * of their land "covered" by that strip, which must not count.
 */
export function overlaps(
  province: Polygon[],
  area: Polygon[],
  areaSamples: [number, number][] = samplePoints(area),
): boolean {
  const [pw, ps, pe, pn] = bboxOf(province);
  const [aw, as, ae, an] = bboxOf(area);
  if (pe < aw || ae < pw || pn < as || an < ps) return false;
  const inProvince = (lon: number, lat: number) =>
    lon >= pw &&
    lon <= pe &&
    lat >= ps &&
    lat <= pn &&
    province.some((p) => insidePolygon(p, lon, lat));
  const areaShare = areaSamples.length
    ? areaSamples.filter(([lon, lat]) => inProvince(lon, lat)).length / areaSamples.length
    : 0;
  if (areaShare >= 0.2) return true;
  const own = samplePoints(province);
  if (!own.length) return false;
  const covered = own.filter(
    ([lon, lat]) =>
      lon >= aw &&
      lon <= ae &&
      lat >= as &&
      lat <= an &&
      area.some((p) => insidePolygon(p, lon, lat)),
  ).length;
  return covered >= own.length * 0.15;
}

const RAD = Math.PI / 180;
/** Mean Earth radius (km). */
const EARTH_KM = 6371;

/** Great-circle distance (km) between two lon/lat points. */
export function haversineKm(a: [number, number], b: [number, number]): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** `n + 1` points along the great circle from `a` to `b` (lon/lat), both ends included. */
export function greatCircle(a: [number, number], b: [number, number], n: number): Ring {
  const vec = ([lon, lat]: [number, number]) => [
    Math.cos(lat * RAD) * Math.cos(lon * RAD),
    Math.cos(lat * RAD) * Math.sin(lon * RAD),
    Math.sin(lat * RAD),
  ];
  const p = vec(a);
  const q = vec(b);
  const omega = Math.acos(Math.min(1, Math.max(-1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2])));
  const out: Ring = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const [ka, kb] =
      omega < 1e-9
        ? [1 - t, t]
        : [Math.sin((1 - t) * omega) / Math.sin(omega), Math.sin(t * omega) / Math.sin(omega)];
    const x = ka * p[0] + kb * q[0];
    const y = ka * p[1] + kb * q[1];
    const z = ka * p[2] + kb * q[2];
    out.push([Math.atan2(y, x) / RAD, Math.atan2(z, Math.hypot(x, y)) / RAD]);
  }
  return out;
}

/**
 * Radius (km) of an earthquake's zone drawn on the overview map: the
 * Dobrovolsky radius R = 10^(0.43·M) km (Dobrovolsky, Zubkov & Miachkin
 * 1979, "Estimation of the size of earthquake preparation zones", Pure Appl.
 * Geophys. 117, doi:10.1007/BF00876083) — the zone of the quake's crustal
 * deformation, an indication of its reach, not its felt area.
 */
export function quakeZoneKm(magnitude: number): number {
  return 10 ** (0.43 * magnitude);
}
