import { dist, ringArea } from './geo';
import type { Projection } from './tiles';
import type {
  AreaKind,
  OsmElement,
  Polygon,
  SourceFeatureInput,
  SourceGeometry,
  Vec2,
} from './types';

/**
 * Source features in model metres, before any compiler decision. `ref` is the
 * stable source identity (e.g. "osm:w123", "maks:4711"); `priority` decides
 * which building wins where two sources describe the same place.
 */
interface SourceBase {
  ref: string;
  source: string;
  priority: number;
  /** From an authoritative building register (see SourceFeatureInput). */
  authoritative?: boolean;
  /** OSM element id when the feature comes from OSM. */
  osmId?: number;
  tags: Record<string, string>;
}

export interface SourceRoad extends SourceBase {
  points: Vec2[];
}

export interface SourceBuilding extends SourceBase {
  polygons: Polygon[];
}

export interface SourcePoint extends SourceBase {
  p: Vec2;
}

export interface SourceArea extends SourceBase {
  kind: AreaKind;
  polygons: Polygon[];
}

export interface SourceFeatures {
  roads: SourceRoad[];
  buildings: SourceBuilding[];
  points: SourcePoint[];
  areas: SourceArea[];
}

const NON_ROAD_HIGHWAYS = new Set([
  'construction',
  'proposed',
  'platform',
  'bus_stop',
  'elevator',
  'corridor',
  'raceway',
  'abandoned',
  'razed',
]);

/** Maps landuse / leisure / natural / amenity tags to a ground area kind. */
export function areaKindOf(tags: Record<string, string>): AreaKind | null {
  const { landuse, leisure, natural, amenity } = tags;
  if (natural === 'water' || landuse === 'reservoir' || landuse === 'basin') return 'water';
  if (leisure === 'playground') return 'playground';
  if (leisure === 'park' || leisure === 'garden') return 'park';
  if (natural === 'wood' || landuse === 'forest') return 'forest';
  if (
    natural === 'grassland' ||
    natural === 'scrub' ||
    natural === 'heath' ||
    landuse === 'grass' ||
    landuse === 'meadow' ||
    landuse === 'recreation_ground' ||
    landuse === 'cemetery' ||
    leisure === 'pitch'
  ) {
    return 'grass';
  }
  // Surface car parks only (a multi-storey or underground one is a building / nothing to see).
  if (
    amenity === 'parking' &&
    !['multi-storey', 'underground', 'rooftop'].includes(tags.parking ?? '')
  )
    return 'parking';
  if (amenity === 'school' || amenity === 'university' || amenity === 'hospital') return 'school';
  if (amenity === 'place_of_worship') return 'religious';
  if (amenity === 'marketplace' || tags.place === 'square') return 'plaza';
  if (landuse === 'industrial' || landuse === 'railway' || landuse === 'port') return 'industrial';
  if (landuse === 'residential' || landuse === 'commercial' || landuse === 'retail')
    return 'residential';
  return null;
}

function isClosed(geometry: [number, number][]): boolean {
  if (geometry.length < 4) return false;
  const a = geometry[0];
  const b = geometry[geometry.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}

function openRing(points: Vec2[]): Vec2[] {
  if (points.length > 1 && dist(points[0], points[points.length - 1]) < 0.01) {
    return points.slice(0, -1);
  }
  return points;
}

/** Joins member ways into closed rings by matching endpoints. */
function assembleRings(parts: Vec2[][]): Vec2[][] {
  const pending = parts.map((p) => [...p]);
  const rings: Vec2[][] = [];
  while (pending.length) {
    let ring = pending.shift()!;
    let guard = 0;
    while (dist(ring[0], ring[ring.length - 1]) > 0.05 && guard++ < 1000) {
      const end = ring[ring.length - 1];
      const idx = pending.findIndex(
        (p) => dist(p[0], end) < 0.05 || dist(p[p.length - 1], end) < 0.05,
      );
      if (idx < 0) break;
      const next = pending.splice(idx, 1)[0];
      ring = ring.concat(dist(next[0], end) < 0.05 ? next.slice(1) : [...next].reverse().slice(1));
    }
    const open = openRing(ring);
    if (open.length >= 3) rings.push(open);
  }
  return rings;
}

function relationPolygons(el: OsmElement, project: (c: [number, number]) => Vec2): Polygon[] {
  const members = el.members ?? [];
  const outers = assembleRings(
    members.filter((m) => m.role !== 'inner').map((m) => m.geometry.map(project)),
  );
  const inners = assembleRings(
    members.filter((m) => m.role === 'inner').map((m) => m.geometry.map(project)),
  );
  return outers.map((outer) => ({
    outer,
    // Holes are matched to the outer containing their first vertex (Clipper fixes orientation).
    holes: inners.filter((h) => ringContains(outer, h[0])),
  }));
}

function ringContains(ring: Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (
      ring[i][1] > p[1] !== ring[j][1] > p[1] &&
      p[0] <
        ((ring[j][0] - ring[i][0]) * (p[1] - ring[i][1])) / (ring[j][1] - ring[i][1]) + ring[i][0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function osmBase(el: OsmElement) {
  return {
    ref: `osm:${el.type[0]}${el.id}`,
    source: 'osm',
    priority: 0,
    osmId: el.id,
    tags: el.tags ?? {},
  };
}

/** Converts compacted Overpass elements into local-metre source features. */
export function readOsm(elements: OsmElement[], proj: Projection): SourceFeatures {
  const project = ([lon, lat]: [number, number]): Vec2 => proj.forward(lon, lat);
  const out: SourceFeatures = { roads: [], buildings: [], points: [], areas: [] };

  for (const el of elements) {
    const tags = el.tags ?? {};
    if (el.type === 'node') {
      if (el.lon === undefined || el.lat === undefined) continue;
      out.points.push({ ...osmBase(el), p: proj.forward(el.lon, el.lat) });
      continue;
    }

    if (el.type === 'way') {
      const geometry = el.geometry ?? [];
      if (geometry.length < 2) continue;
      const points = geometry.map(project);
      const closed = isClosed(geometry);

      if (tags.building || tags['building:part']) {
        if (!closed || tags['building:part']) continue; // parts are refined later; outlines only for now
        out.buildings.push({ ...osmBase(el), polygons: [{ outer: openRing(points), holes: [] }] });
        continue;
      }
      if (tags.highway && !NON_ROAD_HIGHWAYS.has(tags.highway) && tags.area !== 'yes') {
        out.roads.push({ ...osmBase(el), points });
        continue;
      }
      const kind = areaKindOf(tags);
      if (kind && closed) {
        const ring = openRing(points);
        if (Math.abs(ringArea(ring)) > 1) {
          out.areas.push({ ...osmBase(el), kind, polygons: [{ outer: ring, holes: [] }] });
        }
      } else if (tags.highway === 'pedestrian' && closed) {
        out.areas.push({
          ...osmBase(el),
          kind: 'plaza',
          polygons: [{ outer: openRing(points), holes: [] }],
        });
      }
      continue;
    }

    // relation (multipolygon)
    const polygons = relationPolygons(el, project);
    if (!polygons.length) continue;
    if (tags.building) {
      out.buildings.push({ ...osmBase(el), polygons });
    } else {
      const kind = areaKindOf(tags);
      if (kind) out.areas.push({ ...osmBase(el), kind, polygons });
    }
  }
  return out;
}

// ─── Canonical features (source store) ───────────────────────────────────────

type Position = [number, number];

function geometryPolygons(g: SourceGeometry, project: (c: Position) => Vec2): Polygon[] {
  const rings = (coords: Position[][]): Polygon => ({
    outer: openRing(coords[0].map(project)),
    holes: coords.slice(1).map((r) => openRing(r.map(project))),
  });
  if (g.type === 'Polygon') return [rings(g.coordinates as Position[][])];
  if (g.type === 'MultiPolygon') return (g.coordinates as Position[][][]).map(rings);
  return [];
}

function geometryLines(g: SourceGeometry, project: (c: Position) => Vec2): Vec2[][] {
  if (g.type === 'LineString') return [(g.coordinates as Position[]).map(project)];
  if (g.type === 'MultiLineString')
    return (g.coordinates as Position[][]).map((l) => l.map(project));
  return [];
}

/**
 * Converts source-store features (OSM import, MAKS, platform layers) into
 * compiler source features. Tag names follow OSM conventions; adapters
 * normalise their attributes (e.g. MAKS kat sayısı → building:levels).
 */
export function readFeatures(features: SourceFeatureInput[], proj: Projection): SourceFeatures {
  const project = ([lon, lat]: Position): Vec2 => proj.forward(lon, lat);
  const out: SourceFeatures = { roads: [], buildings: [], points: [], areas: [] };
  for (const f of features) {
    const tags = Object.fromEntries(Object.entries(f.tags ?? {}).map(([k, v]) => [k, String(v)]));
    const base = {
      ref: f.ref,
      source: f.source,
      priority: f.priority ?? 0,
      authoritative: f.authoritative === true,
      tags,
    };
    const osmMatch = /^osm:[nwr](\d+)$/.exec(f.ref);
    const osmId = osmMatch ? Number(osmMatch[1]) : undefined;
    switch (f.kind) {
      case 'building': {
        const polygons = geometryPolygons(f.geometry, project).filter((p) => p.outer.length >= 3);
        if (polygons.length)
          out.buildings.push({ ...base, osmId, polygons, tags: { building: 'yes', ...tags } });
        break;
      }
      case 'road': {
        const lines = geometryLines(f.geometry, project);
        lines.forEach((points, i) => {
          if (points.length >= 2)
            out.roads.push({ ...base, ref: i ? `${f.ref}#${i}` : f.ref, osmId, points });
        });
        break;
      }
      case 'area': {
        const kind = areaKindOf(tags) ?? (tags.highway === 'pedestrian' ? 'plaza' : null);
        const polygons = geometryPolygons(f.geometry, project).filter((p) => p.outer.length >= 3);
        if (kind && polygons.length) out.areas.push({ ...base, osmId, kind, polygons });
        break;
      }
      case 'point': {
        if (f.geometry.type === 'Point') {
          out.points.push({ ...base, osmId, p: project(f.geometry.coordinates as Position) });
        }
        break;
      }
    }
  }
  return out;
}

export function mergeFeatures(...sets: SourceFeatures[]): SourceFeatures {
  return {
    roads: sets.flatMap((s) => s.roads),
    buildings: sets.flatMap((s) => s.buildings),
    points: sets.flatMap((s) => s.points),
    areas: sets.flatMap((s) => s.areas),
  };
}
