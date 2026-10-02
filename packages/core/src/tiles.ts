import type { LonLat, Vec2 } from './types';

/**
 * UTM (WGS84) projection — Krüger series to third order (sub-millimetre
 * inside a zone) — and the fixed 1 km city tile grid built on it.
 *
 * Every tile of a zone shares one metric frame, so neighbouring tiles
 * compile with identical coordinates at their common edge.
 */

const A_AXIS = 6_378_137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const E0 = 500_000;
const DEG = Math.PI / 180;

const n = F / (2 - F);
const A = (A_AXIS / (1 + n)) * (1 + (n * n) / 4 + n ** 4 / 64);
const alpha = [
  n / 2 - (2 * n * n) / 3 + (5 * n ** 3) / 16,
  (13 * n * n) / 48 - (3 * n ** 3) / 5,
  (61 * n ** 3) / 240,
];
const beta = [
  n / 2 - (2 * n * n) / 3 + (37 * n ** 3) / 96,
  (n * n) / 48 + n ** 3 / 15,
  (17 * n ** 3) / 480,
];
const delta = [
  2 * n - (2 * n * n) / 3 - 2 * n ** 3,
  (7 * n * n) / 3 - (8 * n ** 3) / 5,
  (56 * n ** 3) / 15,
];
const c = (2 * Math.sqrt(n)) / (1 + n);

export const utmZoneOf = (lon: number): number =>
  Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
const centralMeridian = (zone: number) => (zone - 1) * 6 - 180 + 3;

/** Geographic → UTM easting / northing (northern hemisphere). */
export function utmForward(lon: number, lat: number, zone: number): Vec2 {
  const phi = lat * DEG;
  const dl = (lon - centralMeridian(zone)) * DEG;
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - c * Math.atanh(c * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(dl));
  const eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let e = eta;
  let nn = xi;
  for (let j = 1; j <= 3; j++) {
    e += alpha[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    nn += alpha[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return [E0 + K0 * A * e, K0 * A * nn];
}

/** UTM easting / northing → geographic (northern hemisphere). */
export function utmInverse(easting: number, northing: number, zone: number): LonLat {
  const xi = northing / (K0 * A);
  const eta = (easting - E0) / (K0 * A);
  let xi1 = xi;
  let eta1 = eta;
  for (let j = 1; j <= 3; j++) {
    xi1 -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta1 -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
  let phi = chi;
  for (let j = 1; j <= 3; j++) phi += delta[j - 1] * Math.sin(2 * j * chi);
  const lon = centralMeridian(zone) + Math.atan2(Math.sinh(eta1), Math.cos(xi1)) / DEG;
  return { lon, lat: phi / DEG };
}

// ─── Tile grid ───────────────────────────────────────────────────────────────

/** Tile edge in metres. */
export const TILE_SIZE = 1000;

/**
 * A city tile: `size`-metre square with its SW corner at (originE, originN)
 * in UTM `zone`. Compiled with `margin` metres of context on every side;
 * model coordinates are UTM minus the origin.
 */
export interface TileFrame {
  zone: number;
  originE: number;
  originN: number;
  size: number;
  margin: number;
}

export const tileKey = (zone: number, eKm: number, nKm: number) => `utm${zone}/${eKm}/${nKm}`;

export function parseTileKey(key: string): { zone: number; eKm: number; nKm: number } | null {
  const m = /^utm(\d{1,2})\/(\d{1,4})\/(\d{1,5})$/.exec(key);
  if (!m) return null;
  const zone = Number(m[1]);
  if (zone < 1 || zone > 60) return null;
  return { zone, eKm: Number(m[2]), nKm: Number(m[3]) };
}

export function tileFrame(key: string, margin = 250): TileFrame {
  const k = parseTileKey(key);
  if (!k) throw new Error(`invalid tile key: ${key}`);
  return { zone: k.zone, originE: k.eKm * 1000, originN: k.nKm * 1000, size: TILE_SIZE, margin };
}

/** Keys of all 1 km tiles intersecting a lon/lat box (zone taken from its centre). */
export function tilesForBBox(bbox: [number, number, number, number]): string[] {
  const [w, s, e, nth] = bbox;
  const zone = utmZoneOf((w + e) / 2);
  const corners = [
    utmForward(w, s, zone),
    utmForward(e, s, zone),
    utmForward(w, nth, zone),
    utmForward(e, nth, zone),
  ];
  const minE = Math.floor(Math.min(...corners.map((p) => p[0])) / 1000);
  const maxE = Math.floor(Math.max(...corners.map((p) => p[0])) / 1000);
  const minN = Math.floor(Math.min(...corners.map((p) => p[1])) / 1000);
  const maxN = Math.floor(Math.max(...corners.map((p) => p[1])) / 1000);
  const keys: string[] = [];
  for (let ek = minE; ek <= maxE; ek++)
    for (let nk = minN; nk <= maxN; nk++) keys.push(tileKey(zone, ek, nk));
  return keys;
}

/** Lon/lat box of a tile plus `pad` metres (for source queries). */
export function tileBBox(frame: TileFrame, pad = frame.margin): [number, number, number, number] {
  const pts = [
    utmInverse(frame.originE - pad, frame.originN - pad, frame.zone),
    utmInverse(frame.originE + frame.size + pad, frame.originN - pad, frame.zone),
    utmInverse(frame.originE - pad, frame.originN + frame.size + pad, frame.zone),
    utmInverse(frame.originE + frame.size + pad, frame.originN + frame.size + pad, frame.zone),
  ];
  return [
    Math.min(...pts.map((p) => p.lon)),
    Math.min(...pts.map((p) => p.lat)),
    Math.max(...pts.map((p) => p.lon)),
    Math.max(...pts.map((p) => p.lat)),
  ];
}

/** Projection used by the compiler: model coords relative to an origin. */
export interface Projection {
  forward(lon: number, lat: number): Vec2;
  inverse(x: number, y: number): LonLat;
  /** Added to model coords to get frame-global coords (stable ids / seeds across tiles). */
  readonly globalOffset: Vec2;
}

export class TileProjection implements Projection {
  readonly globalOffset: Vec2;

  constructor(private readonly frame: TileFrame) {
    this.globalOffset = [frame.originE, frame.originN];
  }

  forward(lon: number, lat: number): Vec2 {
    const [e, nn] = utmForward(lon, lat, this.frame.zone);
    return [e - this.frame.originE, nn - this.frame.originN];
  }

  inverse(x: number, y: number): LonLat {
    return utmInverse(x + this.frame.originE, y + this.frame.originN, this.frame.zone);
  }
}
