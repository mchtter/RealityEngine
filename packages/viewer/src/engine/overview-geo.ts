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
