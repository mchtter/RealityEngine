import { closestOnSegment, dist, pointInRing } from './geo';
import { offsetPolyline } from './roads';
import { RoadIndex } from './spatial';
import type { CityModel, Road, Vec2 } from './types';

/**
 * City objects at a point — the one answer to "what is here?", used where an
 * incident is filed (it is bound to the object) and where it is shown (the
 * object is outlined). Both run on the compiled tile model, so they agree
 * with what is drawn.
 *
 * Streets have no source objects for their parts, so a road is cut into
 * SEGMENT_LENGTH pieces along its centreline: carriageway (C) and the
 * sidewalks on its left (L) / right (R) in the road's drawing direction. A
 * segment id is `<road object id>:<C|L|R>:<index>` — stable as long as the
 * road's geometry is.
 */

/** Length of a street segment along the road (m). */
export const SEGMENT_LENGTH = 25;

export type CitySide = 'C' | 'L' | 'R';

export type CityLocationKind =
  | 'building'
  | 'carriageway'
  | 'sidewalk'
  | 'path'
  | 'prop'
  | 'utility_node'
  | 'area';

export interface CityLocation {
  kind: CityLocationKind;
  /** Stable object id: the canonical entity id, else the source ref; segments `<road>:<side>:<index>`. */
  id: string;
  /** Finer type: prop / area kind, road class, utility node type. */
  type?: string;
  /** The road of a segment (its object id). */
  parent?: string;
  /** Road name of a segment, building / area name when known. */
  name?: string;
  /** Segment: metres along the road [from, to]. */
  range?: [number, number];
  /** Outline to highlight (model coordinates, closed ring). */
  outline: Vec2[];
}

/** Stable id of a compiled object: canonical entity id, else source ref, else compiler id. */
export const objectIdOf = (o: { entity?: string; ref?: string; id: string }): string =>
  o.entity ?? o.ref ?? o.id;

/** Point objects (covers, poles, lamps …) are hit within this distance of their centre (m). */
const POINT_REACH = 0.8;

type Locatable = Pick<CityModel, 'roads' | 'buildings' | 'props' | 'areas'> &
  Partial<Pick<CityModel, 'utilityNodes'>>;

const circle = (c: Vec2, r: number): Vec2[] =>
  Array.from({ length: 16 }, (_, k) => {
    const a = (k / 16) * Math.PI * 2;
    return [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r] as Vec2;
  });

/** Distance along a polyline to its point nearest p, with that distance and the segment direction. */
function along(line: Vec2[], p: Vec2): { s: number; d: number; dir: Vec2 } {
  let best = { s: 0, d: Infinity, dir: [1, 0] as Vec2 };
  let acc = 0;
  for (let k = 1; k < line.length; k++) {
    const a = line[k - 1];
    const b = line[k];
    const len = dist(a, b);
    const hit = closestOnSegment(p, a, b);
    if (hit.d < best.d) {
      best = {
        s: acc + len * hit.t,
        d: hit.d,
        dir: len > 0 ? [(b[0] - a[0]) / len, (b[1] - a[1]) / len] : [1, 0],
      };
    }
    acc += len;
  }
  return best;
}

/** Part of a polyline between two distances along it. */
function slice(line: Vec2[], from: number, to: number): Vec2[] {
  const out: Vec2[] = [];
  let acc = 0;
  for (let k = 1; k < line.length; k++) {
    const a = line[k - 1];
    const b = line[k];
    const len = dist(a, b);
    const at = (s: number): Vec2 => {
      const t = len > 0 ? (s - acc) / len : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    };
    if (acc + len >= from && acc <= to) {
      if (!out.length) out.push(at(Math.max(from, acc)));
      if (acc + len <= to) out.push(b);
      else {
        out.push(at(to));
        break;
      }
    }
    acc += len;
  }
  return out;
}

const lengthOf = (line: Vec2[]) => line.reduce((s, p, k) => (k ? s + dist(line[k - 1], p) : 0), 0);

/** Band of a street segment: carriageway, or the sidewalk on one side. */
function bandOf(road: Road, side: CitySide): [number, number] {
  const h = road.width / 2;
  if (side === 'C') return [-h, h];
  const w = Math.max(road.sidewalk, 1);
  return side === 'L' ? [h, h + w] : [-h - w, -h];
}

/** Outline of a street segment (model coordinates), or null when the index is past the road's end. */
export function segmentOutline(road: Road, side: CitySide, index: number): Vec2[] | null {
  const total = lengthOf(road.centerline);
  const from = index * SEGMENT_LENGTH;
  if (from >= total) return null;
  const part = slice(road.centerline, from, Math.min(total, from + SEGMENT_LENGTH));
  if (part.length < 2) return null;
  const [a, b] = bandOf(road, side);
  return [...offsetPolyline(part, b), ...offsetPolyline(part, a).reverse()];
}

/** The street segment a segment id names, in a compiled model. */
export function findSegment(
  model: Pick<CityModel, 'roads'>,
  id: string,
): { road: Road; side: CitySide; index: number; outline: Vec2[] } | null {
  const m = /^(.*):([CLR]):(\d+)$/.exec(id);
  if (!m) return null;
  const road = model.roads.find((r) => objectIdOf(r) === m[1]);
  if (!road) return null;
  const side = m[2] as CitySide;
  const index = Number(m[3]);
  const outline = segmentOutline(road, side, index);
  return outline ? { road, side, index, outline } : null;
}

/**
 * The city object at a point (model coordinates): a building it lies in, a
 * point object (cover, pole, lamp …) right at it, the street segment
 * (carriageway / sidewalk / path) it is on, or an area it lies in. Null on
 * open ground.
 */
export function locate(model: Locatable, p: Vec2): CityLocation | null {
  for (const b of model.buildings) {
    if (!pointInRing(p, b.footprint.outer)) continue;
    if (b.footprint.holes.some((h) => pointInRing(p, h))) continue;
    return {
      kind: 'building',
      id: objectIdOf(b),
      type: b.archetype,
      ...(b.attrs?.name ? { name: b.attrs.name } : {}),
      outline: b.footprint.outer,
    };
  }

  let point: { d: number; loc: CityLocation } | null = null;
  for (const n of model.utilityNodes ?? []) {
    const d = dist(p, [n.position[0], n.position[1]]);
    if (d < POINT_REACH && (!point || d < point.d))
      point = {
        d,
        loc: {
          kind: 'utility_node',
          id: objectIdOf(n),
          type: `${n.kind}:${n.type}`,
          outline: circle([n.position[0], n.position[1]], 0.5),
        },
      };
  }
  for (const pr of model.props) {
    if (pr.buildingId) continue;
    const d = dist(p, [pr.position[0], pr.position[1]]);
    if (d < POINT_REACH && (!point || d < point.d))
      point = {
        d,
        loc: {
          kind: 'prop',
          id: objectIdOf(pr),
          type: pr.kind,
          outline: circle([pr.position[0], pr.position[1]], 0.6),
        },
      };
  }
  if (point) return point.loc;

  // Streets: the nearest road whose carriageway + sidewalks hold the point.
  const index = new RoadIndex(model.roads);
  let street: { d: number; loc: CityLocation } | null = null;
  for (const road of index.roadsNear(p[0] - 40, p[1] - 40, p[0] + 40, p[1] + 40)) {
    if (road.grade === 'tunnel') continue;
    const hit = along(road.centerline, p);
    const half = road.width / 2;
    // Carriageway and sidewalks, a little beyond the kerb line (a path: its own width).
    const reach = half + (road.sidewalk > 0 ? road.sidewalk : 0) + 0.3;
    if (hit.d > reach || (street && hit.d >= street.d)) continue;
    const path = ['footway', 'cycleway', 'steps', 'pedestrian', 'track'].includes(road.cls);
    let side: CitySide = 'C';
    if (!path && hit.d > half) {
      // Left / right of the drawing direction at the nearest centreline point.
      const q = nearestPoint(road.centerline, p);
      const z = hit.dir[0] * (p[1] - q[1]) - hit.dir[1] * (p[0] - q[0]);
      side = z > 0 ? 'L' : 'R';
    }
    const i = Math.floor(hit.s / SEGMENT_LENGTH);
    const outline = segmentOutline(road, side, i);
    if (!outline) continue;
    const total = lengthOf(road.centerline);
    const parent = objectIdOf(road);
    street = {
      d: hit.d,
      loc: {
        kind: path ? 'path' : side === 'C' ? 'carriageway' : 'sidewalk',
        id: `${parent}:${side}:${i}`,
        type: road.cls,
        parent,
        ...(road.name ? { name: road.name } : {}),
        range: [i * SEGMENT_LENGTH, Math.min(total, (i + 1) * SEGMENT_LENGTH)],
        outline,
      },
    };
  }
  if (street) return street.loc;

  for (const a of model.areas) {
    if (!pointInRing(p, a.polygon.outer)) continue;
    return { kind: 'area', id: objectIdOf(a), type: a.kind, outline: a.polygon.outer };
  }
  return null;
}

function nearestPoint(line: Vec2[], p: Vec2): Vec2 {
  let best: { d: number; q: Vec2 } = { d: Infinity, q: line[0] };
  for (let k = 1; k < line.length; k++) {
    const hit = closestOnSegment(p, line[k - 1], line[k]);
    if (hit.d < best.d) best = { d: hit.d, q: hit.point };
  }
  return best.q;
}
