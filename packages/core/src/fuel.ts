import { closestOnSegment, pointInRing, ringCentroid } from './geo';
import type { SourceArea, SourceBuilding, SourcePoint } from './osm';
import { intersection } from './poly';
import { isVehicular } from './roads';
import type { RoadIndex } from './spatial';
import type { Area, Building, Polygon, Prop, Vec2 } from './types';

/**
 * Fuel stations (OSM `amenity=fuel`), built like the airport is: from the
 * data, dressed by rule. A station's canopy is the data's own (`building=roof`
 * next to the station) or, where the data maps the station as a point only,
 * one laid parallel to the nearest road, clear of buildings and carriageways.
 * Under it pump islands in rows along its long side; by the road a price sign
 * (totem); round it a concrete forecourt. The canopy and the sign take the
 * brand's colours (trade dress only — no logos).
 */

/** Brands the twin colours; any other station is drawn in neutral colours. */
export type FuelBrand = 'shell' | 'bp' | 'opet' | 'po' | 'total' | 'generic';

/** Canopy fascia and accent (pumps, sign) per brand. */
export const FUEL_BRAND_COLOURS: Record<FuelBrand, { fascia: string; accent: string }> = {
  shell: { fascia: '#dd1d21', accent: '#fbce07' },
  bp: { fascia: '#009b3a', accent: '#c8d400' },
  opet: { fascia: '#1d3c8f', accent: '#f39200' },
  po: { fascia: '#e30613', accent: '#1b2f6b' },
  total: { fascia: '#e2001a', accent: '#0055a4' },
  generic: { fascia: '#2f5d86', accent: '#e9ecef' },
};

/** The brand a station's `brand` / `name` / `operator` tag names. */
export function fuelBrandOf(tags: Record<string, string>): FuelBrand {
  const s = `${tags.brand ?? ''} ${tags.name ?? ''} ${tags.operator ?? ''}`.toLocaleLowerCase('tr');
  if (/\bshell\b/.test(s)) return 'shell';
  if (/\bbp\b/.test(s)) return 'bp';
  if (/\bopet\b/.test(s)) return 'opet';
  if (/petrol ofisi|\bpo\b/.test(s)) return 'po';
  if (/\btotal/.test(s)) return 'total';
  return 'generic';
}

export interface FuelStation {
  id: string;
  /** The station's point (an area's centroid when the data maps it as an area). */
  at: Vec2;
  brand: FuelBrand;
  /** The station's grounds when the data maps them. */
  area?: Polygon;
  /** Source ref of its canopy (the data's or the one laid for it). */
  canopyRef?: string;
}

/** Search radius for a station's canopy in the data (m). */
const CANOPY_REACH = 45;
/** A canopy laid for a station: length along the road × depth (m), its height. */
const LAID_CANOPY: [number, number] = [16, 9];
const LAID_CANOPY_SMALL: [number, number] = [11, 7];
const CANOPY_HEIGHT = 5.4;
/** Clear gap between a laid canopy and the kerb (cars turn in), metres. */
const KERB_GAP = 4;
/** Pump island grid under a canopy: spacing along / across the long side (m). */
const ISLAND_ALONG = 9;
const ISLAND_ACROSS = 5.5;
/** Forecourt margin round the canopy (m). */
const APRON = 6;
/** Least gap between the price sign and the canopy's edge (m). */
const SIGN_CLEAR = 2;

const isFuel = (t: Record<string, string>) => t.amenity === 'fuel';

/** Stations of the data: `amenity=fuel` points, and areas holding none of them. */
export function fuelStations(points: SourcePoint[], areas: SourceArea[]): FuelStation[] {
  const out: FuelStation[] = points
    .filter((p) => isFuel(p.tags))
    .map((p) => ({ id: p.ref, at: p.p, brand: fuelBrandOf(p.tags) }));
  for (const a of areas) {
    if (!isFuel(a.tags)) continue;
    for (const poly of a.polygons) {
      const inside = out.find((s) => !s.area && pointInRing(s.at, poly.outer));
      if (inside) inside.area = poly;
      else
        out.push({
          id: a.ref,
          at: ringCentroid(poly.outer),
          brand: fuelBrandOf(a.tags),
          area: poly,
        });
    }
  }
  return out;
}

/** Distance from a point to a ring's edge; 0 inside it. */
function clearance(p: Vec2, ring: Vec2[]): number {
  if (pointInRing(p, ring)) return 0;
  let d = Infinity;
  for (let k = 0; k < ring.length; k++)
    d = Math.min(d, closestOnSegment(p, ring[k], ring[(k + 1) % ring.length]).d);
  return d;
}

const rect = (c: Vec2, u: Vec2, half: [number, number]): Vec2[] => {
  const v: Vec2 = [-u[1], u[0]];
  const at = (a: number, b: number): Vec2 => [
    c[0] + u[0] * a * half[0] + v[0] * b * half[1],
    c[1] + u[1] * a * half[0] + v[1] * b * half[1],
  ];
  return [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
};

/**
 * Finds each station's canopy in the data, and lays one for a station that
 * has none: a rectangle parallel to the nearest road, set back from the kerb,
 * clear of every building; none if no such place is near the point.
 * Returns the canopies laid (to be placed like observed buildings).
 */
export function stationCanopies(
  stations: FuelStation[],
  buildings: SourceBuilding[],
  roads: RoadIndex,
): SourceBuilding[] {
  const roofs = buildings
    .filter((b) => b.tags.building === 'roof' || b.tags.building === 'canopy')
    .map((b) => ({ b, c: ringCentroid(b.polygons[0].outer) }));
  const laid: SourceBuilding[] = [];
  for (const s of stations) {
    const own = roofs
      .map((r) => ({ r, d: Math.hypot(r.c[0] - s.at[0], r.c[1] - s.at[1]) }))
      .filter(({ r, d }) => d < CANOPY_REACH || (s.area && pointInRing(r.c, s.area.outer)))
      .sort((a, b) => a.d - b.d)[0];
    if (own) {
      s.canopyRef = own.r.b.ref;
      continue;
    }
    const road = roads.nearest(s.at, 60, (r) => r.grade === 'ground' && isVehicular(r.cls));
    if (!road) continue;
    const u = road.dir;
    // Away from the road, through the station's point.
    const away: Vec2 = [s.at[0] - road.point[0], s.at[1] - road.point[1]];
    const al = Math.hypot(away[0], away[1]) || 1;
    const n: Vec2 = [away[0] / al, away[1] / al];
    const kerb = road.road.width / 2 + road.road.sidewalk;
    let placed: Vec2[] | null = null;
    for (const size of [LAID_CANOPY, LAID_CANOPY_SMALL]) {
      const half: [number, number] = [size[0] / 2, size[1] / 2];
      const back = Math.max(al, kerb + KERB_GAP + half[1]);
      const c: Vec2 = [road.point[0] + n[0] * back, road.point[1] + n[1] * back];
      const ring = rect(c, u, half);
      const poly: Polygon = { outer: ring, holes: [] };
      const near = buildings.filter((b) =>
        b.polygons.some((p) => p.outer.some((q) => Math.hypot(q[0] - c[0], q[1] - c[1]) < 80)),
      );
      const clash =
        near.some((b) => intersection(b.polygons, [poly]).length > 0) ||
        ring.some((q) => roads.covering(q, (r) => (isVehicular(r.cls) ? r.width / 2 + 0.5 : 0)));
      if (!clash) {
        placed = ring;
        break;
      }
    }
    if (!placed) continue;
    const ref = `fuel:${s.id}`;
    s.canopyRef = ref;
    laid.push({
      ref,
      source: 'fuel',
      priority: 0,
      tags: { building: 'roof', height: String(CANOPY_HEIGHT), 'roof:shape': 'flat' },
      polygons: [{ outer: placed, holes: [] }],
    });
  }
  return laid;
}

/** Long axis of a ring (unit vector of its longest edge) and its extents along / across it. */
function frameOf(ring: Vec2[]): { u: Vec2; c: Vec2; half: [number, number] } {
  let best = 0;
  let u: Vec2 = [1, 0];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > best) {
      best = l;
      u = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    }
  }
  const v: Vec2 = [-u[1], u[0]];
  let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const p of ring) {
    const a = p[0] * u[0] + p[1] * u[1];
    const b = p[0] * v[0] + p[1] * v[1];
    u0 = Math.min(u0, a);
    u1 = Math.max(u1, a);
    v0 = Math.min(v0, b);
    v1 = Math.max(v1, b);
  }
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  return {
    u,
    c: [u[0] * cu + v[0] * cv, u[1] * cu + v[1] * cv],
    half: [(u1 - u0) / 2, (v1 - v0) / 2],
  };
}

/**
 * Dresses each station whose canopy stands: the canopy in the brand's
 * colours, pump islands under it, a price sign by the road, the forecourt.
 */
export function dressStations(
  stations: FuelStation[],
  buildings: Building[],
  roads: RoadIndex,
): { props: Prop[]; areas: Area[] } {
  const props: Prop[] = [];
  const areas: Area[] = [];
  const byRef = new Map(buildings.filter((b) => b.ref).map((b) => [b.ref!, b]));
  for (const s of stations) {
    const canopy = s.canopyRef ? byRef.get(s.canopyRef) : undefined;
    if (!canopy) continue;
    const colours = FUEL_BRAND_COLOURS[s.brand];
    canopy.palette = {
      ...canopy.palette,
      wall: colours.fascia,
      roof: '#eceeef',
      trim: colours.accent,
    };
    const { u, c, half } = frameOf(canopy.footprint.outer);
    const v: Vec2 = [-u[1], u[0]];
    const heading = Math.atan2(u[1], u[0]);
    // Pump islands: rows across the canopy, a few along it, inside its posts.
    const along = Math.max(1, Math.min(4, Math.floor((half[0] * 2) / ISLAND_ALONG)));
    const across = Math.max(1, Math.min(4, Math.floor((half[1] * 2) / ISLAND_ACROSS)));
    for (let i = 0; i < along; i++)
      for (let j = 0; j < across; j++) {
        const a = -half[0] + (half[0] * 2 * (i + 0.5)) / along;
        const b = -half[1] + (half[1] * 2 * (j + 0.5)) / across;
        props.push({
          id: `p:fuel:${s.id}:${i}:${j}`,
          kind: 'fuel-pump',
          position: [c[0] + u[0] * a + v[0] * b, c[1] + u[1] * a + v[1] * b, 0],
          heading,
          scale: 1,
          provenance: 'inferred',
          reason: 'Akaryakıt istasyonu: kanopi altında pompa adası',
          brand: s.brand,
        });
      }
    // Price sign by the road, at the canopy's end nearest to it.
    const road = roads.nearest(c, 70, (r) => r.grade === 'ground' && isVehicular(r.cls));
    if (road) {
      const off = road.road.width / 2 + road.road.sidewalk + 1.5;
      const side: Vec2 = [c[0] - road.point[0], c[1] - road.point[1]];
      const sl = Math.hypot(side[0], side[1]) || 1;
      let at: Vec2 = [road.point[0] + (side[0] / sl) * off, road.point[1] + (side[1] / sl) * off];
      // A canopy reaching the kerb would swallow the sign: it goes past the
      // canopy's nearer end, along the road.
      const d = road.dir;
      const t = canopy.footprint.outer.map((q) => (q[0] - at[0]) * d[0] + (q[1] - at[1]) * d[1]);
      const [t0, t1] = [Math.min(...t), Math.max(...t)];
      if (clearance(at, canopy.footprint.outer) < SIGN_CLEAR) {
        const shift = -t0 < t1 ? t0 - SIGN_CLEAR : t1 + SIGN_CLEAR;
        at = [at[0] + d[0] * shift, at[1] + d[1] * shift];
      }
      props.push({
        id: `p:fuel:${s.id}:sign`,
        kind: 'fuel-totem',
        position: [at[0], at[1], 0],
        // The panel stands across the road: drivers both ways read it.
        heading: Math.atan2(road.dir[1], road.dir[0]),
        scale: 1,
        provenance: 'inferred',
        reason: 'Akaryakıt istasyonu: fiyat tabelası',
        brand: s.brand,
      });
    }
    // Forecourt: the data's grounds, else the canopy plus a margin.
    const ground: Polygon = s.area ?? {
      outer: rect(c, u, [half[0] + APRON, half[1] + APRON]),
      holes: [],
    };
    areas.push({ id: `a:fuel:${s.id}`, kind: 'fuel', polygon: ground, provenance: 'inferred' });
  }
  return { props, areas };
}
