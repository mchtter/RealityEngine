import {
  add,
  dist,
  dot,
  lerp2,
  normalize,
  orientedBox,
  perp,
  ringCentroid,
  scale,
  sub,
} from './geo';
import type { SourceBuilding } from './osm';
import {
  bufferPolyline,
  clean,
  difference,
  intersection,
  polygonArea,
  totalArea,
  union,
} from './poly';
import { Rng } from './random';
import { isVehicular } from './roads';
import { type PolygonIndex, type RoadIndex, ringBounds } from './spatial';
import { ARCHETYPES, pickArchetype, pickStyle } from './styles';
import { terrainHeightAt } from './terrain';
import type {
  BayKind,
  Building,
  BuildingUse,
  FacadeEdge,
  Fix,
  Polygon,
  Provenance,
  Road,
  RoadClass,
  TerrainGrid,
  Vec2,
} from './types';

export interface BuildingContext {
  terrain: TerrainGrid;
  roads: RoadIndex;
}

const SMALL_TYPES = new Set([
  'garage',
  'garages',
  'shed',
  'kiosk',
  'roof',
  'carport',
  'hut',
  'toilets',
  'service',
  'container',
]);
const MAJOR: RoadClass[] = ['motorway', 'trunk', 'primary'];
const MEDIUM: RoadClass[] = ['secondary', 'tertiary', 'pedestrian'];

/** Minimum overlap (m²) worth reporting; smaller slivers are width-estimate noise. */
const ROAD_FIX_MIN_AREA = 2;
const BUILDING_FIX_MIN_AREA = 1;
/** Carriageway is shrunk by this much before testing overlaps (road widths are estimates). */
const ROAD_TOLERANCE = 0.6;
/** A building that reaches into a street is cut back this far behind the sidewalk's outer edge. */
const ROAD_SETBACK = 2;
/** Share of a building's area covered by a higher-priority source that makes it a duplicate. */
const SUPERSEDE_SHARE = 0.3;

const isFrontRoad = (r: Road) => r.grade === 'ground' && (r.formsBlocks || r.cls === 'service');

function edgeOutward(
  ring: Vec2[],
  k: number,
): { a: Vec2; b: Vec2; mid: Vec2; out: Vec2; len: number } {
  const a = ring[k];
  const b = ring[(k + 1) % ring.length];
  const dir = normalize(sub(b, a));
  // Outer rings are CCW: interior on the left, outward normal on the right.
  return { a, b, mid: lerp2(a, b, 0.5), out: scale(perp(dir), -1), len: dist(a, b) };
}

/** Edge that faces the nearest road; falls back to the longest edge. */
export function findFrontEdge(ring: Vec2[], roads: RoadIndex): { edge: number; road: Road | null } {
  let best = { edge: -1, score: Infinity, road: null as Road | null };
  let longest = { edge: 0, len: 0 };
  for (let k = 0; k < ring.length; k++) {
    const e = edgeOutward(ring, k);
    if (e.len > longest.len) longest = { edge: k, len: e.len };
    if (e.len < 2.5) continue;
    const probe = add(e.mid, e.out);
    const hit = roads.nearest(probe, 35, isFrontRoad);
    if (!hit) continue;
    const facing = dot(e.out, normalize(sub(hit.point, e.mid)));
    if (facing < 0.3) continue;
    const score = hit.d - e.len * 0.05 - (MAJOR.includes(hit.road.cls) ? 3 : 0);
    if (score < best.score) best = { edge: k, score, road: hit.road };
  }
  return best.edge >= 0 ? { edge: best.edge, road: best.road } : { edge: longest.edge, road: null };
}

export function inferLevels(
  tags: Record<string, string>,
  area: number,
  front: Road | null,
  rng: Rng,
): { levels: number; provenance: Provenance } {
  const tagged = Number.parseInt(tags['building:levels'] ?? '', 10);
  if (Number.isFinite(tagged) && tagged > 0)
    return { levels: Math.min(tagged, 40), provenance: 'observed' };
  const height = Number.parseFloat(tags.height ?? '');
  if (Number.isFinite(height) && height > 2)
    return { levels: Math.max(1, Math.round(height / 3)), provenance: 'observed' };
  if (SMALL_TYPES.has(tags.building)) return { levels: 1, provenance: 'inferred' };
  if (area < 45) return { levels: rng.int(1, 2), provenance: 'inferred' };
  if (area < 100) return { levels: rng.int(2, 4), provenance: 'inferred' };
  if (!front) return { levels: rng.int(3, 5), provenance: 'inferred' };
  if (MAJOR.includes(front.cls)) return { levels: rng.int(5, 8), provenance: 'inferred' };
  if (MEDIUM.includes(front.cls)) return { levels: rng.int(4, 7), provenance: 'inferred' };
  return { levels: rng.int(3, 6), provenance: 'inferred' };
}

/**
 * Builds the full building record for a final footprint: levels, heights on
 * the terrain, archetype, style. Facades are laid out later (they need all
 * neighbours to detect party walls).
 */
export function makeBuilding(
  id: string,
  footprint: Polygon,
  tags: Record<string, string>,
  /** Source name ("osm", "maks", …) or "synthetic". */
  source: string,
  ctx: BuildingContext,
  osmId?: number,
  levelsHint?: number,
): Building {
  const rng = new Rng(id);
  const area = polygonArea(footprint);
  const ring = footprint.outer;
  const front = findFrontEdge(ring, ctx.roads);
  const inferred = inferLevels(tags, area, front.road, rng);
  const levels = levelsHint ?? inferred.levels;
  const archetype = pickArchetype(levels, tags, rng);
  const box = orientedBox(ring);
  const rectangularity = box.area > 0 ? area / box.area : 0;
  const { style, fromData } = pickStyle(archetype, tags, rectangularity, box.halfWidth * 2, rng);

  const heights = ring.map((p) => terrainHeightAt(ctx.terrain, p[0], p[1]));
  const c = ringCentroid(ring);
  heights.push(terrainHeightAt(ctx.terrain, c[0], c[1]));
  const baseZ = Math.min(...heights) - 0.3;
  const fe = edgeOutward(ring, front.edge);
  const street = terrainHeightAt(ctx.terrain, fe.mid[0] + fe.out[0] * 2, fe.mid[1] + fe.out[1] * 2);

  const shopTag = Boolean(tags.shop) || ['commercial', 'retail', 'shop'].includes(tags.building);
  const shopfront =
    shopTag ||
    (levels >= 3 &&
      archetype !== 'mustakil' &&
      front.road !== null &&
      [...MAJOR, ...MEDIUM].includes(front.road.cls) &&
      rng.chance(0.85));
  // Houses and older apartments sit on a raised ground floor (stone / concrete
  // plinth, a few steps up to the door); shops and modern blocks open at street level.
  const raise =
    !shopfront && archetype !== 'modern' && archetype !== 'yuksek' ? rng.range(0.45, 1.0) : 0;
  const floorZ = Math.min(Math.max(street + raise, baseZ + 0.3), baseZ + 9);
  const plinth = Math.max(0, floorZ - street);
  const groundFloorHeight = shopfront ? rng.range(3.8, 4.4) : style.floorHeight + 0.2;
  const topZ = floorZ + groundFloorHeight + (levels - 1) * style.floorHeight;

  return {
    id,
    osmId,
    source,
    footprint,
    area,
    baseZ,
    floorZ,
    plinth,
    levels,
    floorHeight: style.floorHeight,
    groundFloorHeight,
    topZ,
    archetype,
    palette: style.palette,
    finishes: style.finishes,
    roof: {
      shape: style.roofShape,
      pitchDeg: style.pitchDeg,
      overhang:
        style.roofShape === 'flat' ? 0 : style.roofShape === 'barrel' ? 0.3 : rng.range(0.4, 0.7),
      parapet: style.roofShape === 'flat' ? rng.range(0.6, 1.0) : 0,
    },
    rail: style.rail,
    windowWidth: style.windowWidth,
    windowHeight: style.windowHeight,
    shopfront,
    use: buildingUse(tags, archetype, shopTag),
    facades: [
      { edge: front.edge, length: fe.len, bays: [], groundBays: [], bands: [], front: true },
    ],
    cornerBalconies: [],
    provenance: {
      footprint: source === 'synthetic' ? 'synthetic' : 'observed',
      levels: levelsHint !== undefined ? 'synthetic' : inferred.provenance,
      style: fromData ? 'observed' : 'synthetic',
    },
    fixIds: [],
    seed: rng.int(0, 2 ** 31 - 1),
  };
}

/**
 * Places OSM buildings: repairs geometry, removes the parts that stand on the
 * carriageway or inside an earlier building, and records every correction as
 * a Fix (original geometry is never silently changed).
 */
export function placeObservedBuildings(
  source: SourceBuilding[],
  ctx: BuildingContext,
  within: Polygon[],
): { buildings: Building[]; fixes: Fix[]; superseded: Vec2[] } {
  const buildings: Building[] = [];
  const fixes: Fix[] = [];
  // Carriageway near a building = union of the buffers of the few roads around it
  // (clipping against the whole network — one polygon with many holes — dominated
  // compile time). Buffers are cached per road.
  const carriageRoad = (r: Road) => r.grade === 'ground' && r.formsBlocks && isVehicular(r.cls);
  const bufferCache = new Map<string, { full: Polygon[]; hard: Polygon[] }>();
  const roadBuffers = (r: Road) => {
    let b = bufferCache.get(r.id);
    if (!b) {
      b = {
        // Cut line: the street corridor (carriageway and sidewalks) plus the setback.
        full: bufferPolyline(r.centerline, r.width / 2 + r.sidewalk + ROAD_SETBACK),
        // Trigger: reaching into the corridor (less the width-estimate tolerance).
        hard: bufferPolyline(
          r.centerline,
          Math.max(0.1, r.width / 2 + r.sidewalk - ROAD_TOLERANCE),
        ),
      };
      bufferCache.set(r.id, b);
    }
    return b;
  };
  const roadsAround = (polys: Polygon[]) => {
    const b = polys.map((p) => ringBounds(p.outer));
    return ctx.roads
      .roadsNear(
        Math.min(...b.map((x) => x[0])) - 20,
        Math.min(...b.map((x) => x[1])) - 20,
        Math.max(...b.map((x) => x[2])) + 20,
        Math.max(...b.map((x) => x[3])) + 20,
      )
      .filter(carriageRoad);
  };
  // Placed footprints with bounding boxes: overlap checks only look at neighbours
  // (a growing global union made this step quadratic; profiled 2026-10-01).
  type Placed = { poly: Polygon; box: [number, number, number, number]; priority: number };
  const placed: Placed[] = [];
  const nearPlaced = (polys: Polygon[], pred: (p: Placed) => boolean = () => true) => {
    const boxes = polys.map((p) => ringBounds(p.outer));
    return placed
      .filter(
        (p) =>
          pred(p) &&
          boxes.some(
            (b) => p.box[2] >= b[0] && p.box[0] <= b[2] && p.box[3] >= b[1] && p.box[1] <= b[3],
          ),
      )
      .map((p) => p.poly);
  };

  // Highest priority first (MAKS before OSM), then by stable ref.
  const ordered = [...source].sort(
    (a, b) => b.priority - a.priority || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0),
  );
  // Centroids of lower-priority duplicates (counted by the caller inside its area).
  const superseded: Vec2[] = [];
  for (const src of ordered) {
    const id = `b:${src.ref}`;
    // A lower-priority building mostly covered by a higher-priority source is the
    // same building described twice: the better source wins, no fix is recorded.
    const higher = nearPlaced(src.polygons, (p) => p.priority > src.priority);
    if (higher.length) {
      const own = clean(union(src.polygons));
      const ownArea = totalArea(own);
      if (ownArea > 0 && totalArea(intersection(own, higher)) / ownArea > SUPERSEDE_SHARE) {
        superseded.push(ringCentroid(own[0]?.outer ?? src.polygons[0].outer));
        continue;
      }
    }
    const originalArea = totalArea(src.polygons);
    const repaired = clean(union(src.polygons));
    let parts = intersection(repaired, within);
    if (!parts.length) continue;
    const pending: Fix[] = [];

    // Shoelace area of a self-intersecting ring differs from its repaired union.
    const repairedArea = totalArea(repaired);
    if (originalArea > 0 && Math.abs(repairedArea - originalArea) / originalArea > 0.05) {
      pending.push({
        id: `${id}-geom`,
        kind: 'invalid-geometry',
        targetId: id,
        removedArea: Math.abs(originalArea - repairedArea),
        removed: [],
        height: 0,
        baseZ: 0,
        note: 'Bozuk (kendini kesen) poligon onarıldı',
      });
    }

    const around = roadsAround(parts);
    const onRoad = around.length
      ? intersection(
          parts,
          around.flatMap((r) => roadBuffers(r).hard),
        )
      : [];
    const onRoadArea = totalArea(onRoad);
    if (onRoadArea >= ROAD_FIX_MIN_AREA) {
      const nearRoad = union(around.flatMap((r) => roadBuffers(r).full));
      const removed = intersection(parts, nearRoad);
      parts = difference(parts, nearRoad);
      pending.push({
        id: `${id}-road`,
        kind: 'road-overlap',
        targetId: id,
        removedArea: totalArea(removed),
        removed,
        height: 0,
        baseZ: 0,
        note: 'Bina yola / kaldırıma taşıyor; kaldırımdan 2 m geride kesildi',
      });
    }

    const neighbours = nearPlaced(parts);
    if (neighbours.length) {
      const overlap = intersection(parts, neighbours);
      const overlapArea = totalArea(overlap);
      if (overlapArea >= BUILDING_FIX_MIN_AREA) {
        parts = difference(parts, neighbours);
        pending.push({
          id: `${id}-overlap`,
          kind: 'building-overlap',
          targetId: id,
          removedArea: overlapArea,
          removed: overlap,
          height: 0,
          baseZ: 0,
          note: 'Bina komşu binanın içine giriyor; çakışan kısım kırpıldı',
        });
      }
    }

    const kept = parts
      .filter((p) => polygonArea(p) >= 8)
      .sort((a, b) => polygonArea(b) - polygonArea(a));
    if (!kept.length) {
      // Entirely removed: report once so the UI can show the dropped footprint.
      if (pending.length) {
        fixes.push({
          ...pending[pending.length - 1],
          id: `${id}-drop`,
          note: 'Bina tamamen yol / başka bina üzerinde kaldı; çizilmedi',
          removed: src.polygons,
          removedArea: originalArea,
        });
      }
      continue;
    }
    kept.forEach((footprint, idx) => {
      const bid = idx === 0 ? id : `${id}-${idx}`;
      const b = makeBuilding(bid, footprint, src.tags, src.source, ctx, src.osmId);
      b.ref = src.ref;
      const attrs = sourceAttributes(src.tags);
      if (attrs) b.attrs = attrs;
      if (src.tags['ref:parcel']) b.parcelRef = src.tags['ref:parcel'];
      for (const f of pending) {
        const fix = { ...f, height: b.topZ - b.baseZ, baseZ: b.baseZ };
        if (idx === 0) fixes.push(fix);
        b.fixIds.push(f.id);
      }
      buildings.push(b);
    });
    for (const poly of kept)
      placed.push({ poly, box: ringBounds(poly.outer), priority: src.priority });
  }
  return { buildings, fixes, superseded };
}

// ─── Facades ─────────────────────────────────────────────────────────────────

type BalconyPattern = 'ends' | 'alternate' | 'center' | 'inner-pair' | 'all';

/**
 * How often a building family shows a facade feature (reference renders,
 * soul_of_anatolia): a closed cumba, an ornamental motif strip, L-shaped
 * corner balconies.
 */
const FEATURE_CHANCE: Record<
  'oriel' | 'ornament' | 'corner',
  Record<Building['archetype'], number>
> = {
  oriel: { mustakil: 0, eski: 0.45, klasik: 0.25, modern: 0.1, yuksek: 0 },
  ornament: { mustakil: 0, eski: 0, klasik: 0.3, modern: 0.3, yuksek: 0.25 },
  corner: { mustakil: 0, eski: 0.1, klasik: 0.3, modern: 0.45, yuksek: 0.45 },
};
type BandPattern = 'none' | 'balconies' | 'edges' | 'center' | 'alternate-pairs';

/** Building use from OSM-style tags (`dt:use` overrides). */
function buildingUse(tags: Record<string, string>, archetype: string, shop: boolean): BuildingUse {
  const forced = tags['dt:use'];
  if (
    forced === 'residential' ||
    forced === 'house' ||
    forced === 'public' ||
    forced === 'commercial'
  )
    return forced;
  const b = tags.building ?? '';
  const PUBLIC_BUILDING = [
    'school',
    'university',
    'college',
    'kindergarten',
    'hospital',
    'public',
    'government',
    'civic',
    'office',
    'fire_station',
    'train_station',
    'transportation',
    'mosque',
    'church',
  ];
  const PUBLIC_AMENITY = [
    'school',
    'university',
    'college',
    'kindergarten',
    'hospital',
    'clinic',
    'townhall',
    'police',
    'fire_station',
    'courthouse',
    'library',
    'post_office',
    'community_centre',
  ];
  if (
    PUBLIC_BUILDING.includes(b) ||
    PUBLIC_AMENITY.includes(tags.amenity ?? '') ||
    tags.office === 'government' ||
    Boolean(tags.government)
  )
    return 'public';
  if (['commercial', 'retail', 'industrial', 'warehouse', 'supermarket'].includes(b))
    return 'commercial';
  if (archetype === 'mustakil') return 'house';
  return shop && b !== 'apartments' && b !== 'residential' ? 'commercial' : 'residential';
}

function balconyBays(n: number, pattern: BalconyPattern): Set<number> {
  const s = new Set<number>();
  if (n < 2) return s;
  switch (pattern) {
    case 'ends':
      if (n >= 3) s.add(0).add(n - 1);
      break;
    case 'alternate':
      for (let k = 1; k < n; k += 2) s.add(k);
      break;
    case 'center':
      s.add(Math.floor((n - 1) / 2));
      if (n % 2 === 0) s.add(n / 2);
      break;
    case 'inner-pair':
      if (n >= 4) s.add(1).add(n - 2);
      else s.add(Math.floor(n / 2));
      break;
    case 'all':
      for (let k = 0; k < n; k++) s.add(k);
      break;
  }
  return s;
}

/**
 * Convex, near-square corners between two walls with openings, front corners
 * first; the bays next to a chosen corner become windows (the balcony wraps them).
 */
function cornerBalconies(b: Building, ring: Vec2[], rng: Rng): number[] {
  const n = ring.length;
  const candidates: { k: number; score: number }[] = [];
  for (let k = 0; k < n; k++) {
    const fa = b.facades[k];
    const fb = b.facades[(k + 1) % n];
    if (!fa?.bays.length || !fb?.bays.length) continue;
    const ea = edgeOutward(ring, k);
    const eb = edgeOutward(ring, (k + 1) % n);
    if (ea.len < 6 || eb.len < 6) continue;
    if (dot(normalize(sub(eb.b, eb.a)), ea.out) > -0.9) continue;
    if (fa.oriel && fa.oriel[1] === fa.bays.length - 1) continue;
    if (fb.oriel && fb.oriel[0] === 0) continue;
    candidates.push({ k, score: (fa.front || fb.front ? 0 : 1) + rng.next() * 0.5 });
  }
  candidates.sort((x, y) => x.score - y.score);
  const chosen = candidates.slice(0, rng.chance(0.5) ? 2 : 1).map((c) => c.k);
  for (const k of chosen) {
    const fa = b.facades[k];
    const fb = b.facades[(k + 1) % n];
    const last = fa.bays.length - 1;
    if (fa.bays[last] === 'balcony' || fa.bays[last] === 'glazed-balcony') fa.bays[last] = 'window';
    if (fb.bays[0] === 'balcony' || fb.bays[0] === 'glazed-balcony') fb.bays[0] = 'window';
  }
  return chosen;
}

function bandFor(k: number, n: number, pattern: BandPattern, balconies: Set<number>): number {
  switch (pattern) {
    case 'balconies':
      return balconies.has(k) ? 1 : 0;
    case 'edges':
      return k === 0 || k === n - 1 ? 1 : 0;
    case 'center':
      return n >= 3 && k === Math.floor(n / 2) ? 1 : 0;
    case 'alternate-pairs':
      return Math.floor(k / 2) % 2 === 1 ? 1 : 0;
    default:
      return 0;
  }
}

/**
 * Lays out bays for every wall. Walls touching a neighbour (party walls) stay
 * blank. The front wall gets the entrance and, on shopfront buildings, shop
 * windows; front and back walls carry the balconies.
 */
export function layoutFacades(buildings: Building[], index: PolygonIndex<Building>): void {
  for (const b of buildings) {
    const rng = new Rng(b.seed);
    const spec = ARCHETYPES[b.archetype];
    const pub = b.use === 'public';
    const house = b.use === 'house' || b.archetype === 'mustakil';
    // Openings per wall: a flat's frontage has three or four, not a window
    // every 2.5 m; public buildings keep a regular, denser rhythm.
    const bayTarget =
      b.windowWidth +
      (pub ? rng.range(1.6, 2.2) : house ? rng.range(2.2, 3.2) : rng.range(2.0, 2.8));
    const frontEdge = b.facades[0]?.edge ?? 0;
    const ring = b.footprint.outer;
    const frontOut = edgeOutward(ring, frontEdge).out;
    const balconyPattern: BalconyPattern =
      b.archetype === 'mustakil'
        ? 'center'
        : rng.weighted([
            ['ends', 0.25],
            ['alternate', 0.2],
            ['center', 0.15],
            ['inner-pair', 0.25],
            ['all', 0.15],
          ] as const);
    const bandPattern: BandPattern =
      b.archetype === 'modern'
        ? rng.weighted([
            ['balconies', 0.35],
            ['edges', 0.25],
            ['alternate-pairs', 0.25],
            ['center', 0.15],
          ] as const)
        : b.archetype === 'yuksek'
          ? 'edges'
          : b.archetype === 'klasik'
            ? rng.weighted([
                ['center', 0.4],
                ['balconies', 0.3],
                ['none', 0.3],
              ] as const)
            : 'none';
    // Public buildings (schools, offices, hospitals) have no balconies.
    const hasBalconies = !pub && b.levels >= 2 && (!house || rng.chance(0.3));
    const glazed = !pub && rng.chance(spec.glazedBalcony * 1.6);
    const modernish = b.archetype === 'modern' || b.archetype === 'yuksek';
    /** Column kind of a window bay, by use and wall. */
    const windowKind = (main: boolean): BayKind => {
      if (pub)
        return rng.weighted([
          ['pair-window', 0.6],
          ['window', 0.3],
          ['wide-window', 0.1],
        ] as const);
      if (house)
        return rng.weighted([
          ['wide-window', 0.34],
          ['pair-window', 0.2],
          ['window', 0.2],
          ['tall-pair', 0.1],
          ['small-window', main ? 0.06 : 0.16],
          ['blank', 0.04],
        ] as const);
      return main
        ? rng.weighted([
            ['window', 0.28],
            ['pair-window', 0.2],
            ['wide-window', 0.18],
            ['french-window', 0.12],
            ['tall-pair', modernish ? 0.08 : 0.04],
            ['tall-triple', modernish ? 0.06 : 0.02],
            ['small-window', 0.05],
            ['blank', 0.04],
          ] as const)
        : rng.weighted([
            ['window', 0.35],
            ['small-window', 0.25],
            ['pair-window', 0.1],
            ['blank', 0.3],
          ] as const);
    };
    const wantOriel = b.levels >= 3 && rng.chance(FEATURE_CHANCE.oriel[b.archetype]);
    const wantOrnament = b.levels >= 3 && rng.chance(FEATURE_CHANCE.ornament[b.archetype]);
    const wantCorner = b.levels >= 3 && rng.chance(FEATURE_CHANCE.corner[b.archetype]);

    const facades: FacadeEdge[] = [];
    for (let k = 0; k < ring.length; k++) {
      const e = edgeOutward(ring, k);
      const isFront = k === frontEdge;
      const facing = dot(e.out, frontOut);
      const isBack = !isFront && facing < -0.8;
      const party =
        e.len >= 2 &&
        [0.25, 0.5, 0.75].filter((t) => index.at(add(lerp2(e.a, e.b, t), scale(e.out, 0.9)), b))
          .length >= 2;
      if (e.len < 2.2 || party) {
        facades.push({
          edge: k,
          length: e.len,
          bays: [],
          groundBays: [],
          bands: [],
          front: isFront,
        });
        continue;
      }
      const n = Math.max(1, Math.round(e.len / bayTarget));
      if (e.len < b.windowWidth + 0.9) {
        facades.push({
          edge: k,
          length: e.len,
          bays: [],
          groundBays: [],
          bands: [],
          front: isFront,
        });
        continue;
      }
      const balconies =
        hasBalconies && (isFront || isBack) ? balconyBays(n, balconyPattern) : new Set<number>();
      const side = !isFront && !isBack;
      const bays: BayKind[] = [];
      const groundBays: BayKind[] = [];
      const bands: number[] = [];
      const door = isFront ? (n >= 3 ? Math.floor(n / 2) : 0) : -1;
      for (let i = 0; i < n; i++) {
        if (balconies.has(i)) bays.push(glazed && rng.chance(0.7) ? 'glazed-balcony' : 'balcony');
        else bays.push(windowKind(isFront || isBack));

        // Ground floor: entrance, shops, otherwise the column's window (no
        // balcony or French window at street level).
        const up = bays[i];
        if (i === door) groundBays.push('door');
        else if (isFront && b.shopfront) groundBays.push('shop');
        else if (side && b.shopfront && rng.chance(0.4)) groundBays.push('shop');
        else
          groundBays.push(
            up === 'blank' || up === 'small-window'
              ? up
              : up === 'wide-window' || up === 'tall-triple'
                ? 'wide-window'
                : up === 'pair-window'
                  ? 'pair-window'
                  : 'window',
          );

        bands.push(bandFor(i, n, bandPattern, balconies));
      }
      let oriel: [number, number] | undefined;
      if (wantOriel && (isFront || isBack) && n >= 3) {
        const c = Math.floor((n - 1) / 2);
        oriel = n >= 5 && rng.chance(0.5) ? [c, c + 1] : [c, c];
        for (let i = oriel[0]; i <= oriel[1]; i++)
          if (bays[i] !== 'wide-window') bays[i] = 'window';
      }
      const ornament = wantOrnament && isFront && n >= 4 && !oriel ? Math.round(n / 2) : undefined;
      // Flats differ from their column: each household glazes (or reopens) its
      // own balcony, a few swap a window for a French window or a door-height one.
      const cells: [number, number, BayKind][] = [];
      if (!pub) {
        for (let lv = 1; lv < b.levels; lv++) {
          for (let i = 0; i < n; i++) {
            if (oriel && i >= oriel[0] && i <= oriel[1]) continue;
            const k = bays[i];
            if (k === 'balcony' && rng.chance(0.28)) cells.push([lv, i, 'glazed-balcony']);
            else if (k === 'glazed-balcony' && rng.chance(0.25)) cells.push([lv, i, 'balcony']);
            else if ((k === 'window' || k === 'pair-window') && rng.chance(0.07))
              cells.push([lv, i, rng.chance(0.5) ? 'french-window' : 'tall-pair']);
            else if (k === 'wide-window' && rng.chance(0.08)) cells.push([lv, i, 'tall-triple']);
            else if (k === 'french-window' && rng.chance(0.15)) cells.push([lv, i, 'window']);
          }
        }
      }
      facades.push({
        edge: k,
        length: e.len,
        bays,
        groundBays,
        bands,
        front: isFront,
        ...(oriel ? { oriel } : {}),
        ...(ornament !== undefined ? { ornament } : {}),
        ...(cells.length ? { cells } : {}),
      });
    }
    b.facades = facades;
    b.cornerBalconies = wantCorner ? cornerBalconies(b, ring, rng) : [];
  }
}

/**
 * Columns of the source row (`attr:<column>` tags written by source adapters,
 * e.g. the MAKS table), kept on the building for the building card and for
 * joining scenario data (e.g. KIMLIKNO).
 */
function sourceAttributes(tags: Record<string, string>): Record<string, string> | undefined {
  let out: Record<string, string> | undefined;
  for (const [k, v] of Object.entries(tags)) {
    if (!k.startsWith('attr:')) continue;
    (out ??= {})[k.slice(5)] = v;
  }
  return out;
}
