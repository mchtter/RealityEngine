import {
  campusWalls,
  gardenWalls,
  groundSurfaces,
  parkingLayout,
  pitchMarkings,
  playgroundLayout,
  runwayMarkings,
  trackGrounds,
} from './amenities';
import {
  buildBlocks,
  infillAlongRoads,
  isRoundaboutIsland,
  observedCoverage,
  regionRect,
  scatter,
} from './blocks';
import {
  STADIUM_BUILDINGS,
  layoutFacades,
  makeBuilding,
  lowestGroundAround,
  placeObservedBuildings,
} from './buildings';
import {
  CutGround,
  STATION_PIT,
  STATION_PIT_LENGTH,
  buildCuttings,
  settleTrenchRims,
} from './cuttings';
import { undergroundBuilding } from './forms';
import { dressStations, fuelStations, stationCanopies } from './fuel';
import {
  LocalProjection,
  closestOnSegment,
  dist,
  lerp2,
  normalize,
  pointInRing,
  polylineLength,
  ringCentroid,
  samplePolyline,
  sub,
} from './geo';
import { isGraded, transferGrades } from './grade';
import { GroundModel, SURFACE_LIFT } from './ground-model';
import { furnishGrounds } from './grounds';
import { RAIL_DECK, layGuideways } from './guideways';
import { type Envelope, Harmonizer } from './harmony/engine';
import {
  connectJunctions,
  inferTurns,
  junctionMarkings,
  layoutJunctions,
  setStops,
} from './junctions';
import {
  ENTITY_TAG,
  LANDFORM_LINES,
  type SourceArea,
  type SourceBuilding,
  type SourceFeatures,
  type SourceRoad,
  mergeFeatures,
  readFeatures,
  readOsm,
} from './osm';
import { overheadSpans } from './overhead';
import {
  bufferPolyline,
  difference,
  dropHairlines,
  intersection,
  offset,
  polygonArea,
  union,
} from './poly';
import {
  buildingDetails,
  carriageReach,
  clearOfBridges,
  clearOfCuts,
  corridorReach,
  decorateStreets,
  observedProps,
  resolvePropPlacement,
  suggestBusStops,
} from './props';
import { Rng } from './random';
import {
  buildCrossings,
  buildMarkings,
  pathEdgeMarkings,
  buildSurfaces,
  classifyRoads,
  deckHalf,
  densify,
  findJunctions,
  isVehicular,
} from './roads';
import { GridIndex, PolygonIndex, PolygonSet, RoadIndex, ringBounds } from './spatial';
import {
  RoadSurface,
  conformTerrainToStreets,
  buildTerrain,
  conformTerrainToFill,
  conformTerrainToRoads,
  raiseLandAboveSea,
  sharpenLandforms,
  terrainHeightAt,
} from './terrain';
import { type Projection, TileProjection } from './tiles';
import type {
  Area,
  AreaKind,
  Bridge,
  Building,
  CityModel,
  CitySource,
  CompileOptions,
  Fence,
  Poi,
  Polygon,
  StationEntrance,
  UndergroundStructure,
  UndergroundTrack,
  Prop,
  RailLine,
  Road,
  TerrainGrid,
  Vec2,
  Vec3,
  SurfaceKind,
} from './types';
import { buildUtilities, isServiceLine, utilityKindOf } from './utilities';
import { SUPPORTS, fenceIndex, inFence } from './validate';

/**
 * Bump whenever compiled output changes for the same input: cached city tiles
 * carry this in their source version and are rebuilt on the next request.
 */
/**
 * Direction of the nearest ground street within ENTRANCE_STREET m of a
 * point (radians from +x; a metro entrance's stairs run along the pavement),
 * else 0.
 */
function streetHeading(roads: Road[], p: Vec2): number {
  let best = ENTRANCE_STREET;
  let heading = 0;
  for (const r of roads) {
    if (r.grade !== 'ground') continue;
    for (let k = 1; k < r.centerline.length; k++) {
      const a = r.centerline[k - 1];
      const b = r.centerline[k];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      if (l2 < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
      const d = Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
      if (d < best) [best, heading] = [d, Math.atan2(dy, dx)];
    }
  }
  return heading;
}

/**
 * The way a metro entrance's stairs run down: along the nearest street
 * (streetHeading), the one of its two ways that leads towards the nearest
 * station (the street's drawing direction is arbitrary: half the pits ran
 * away from their station, the passage doubling back under them).
 */
function entranceHeading(roads: Road[], p: Vec2, stations: { polygons: Polygon[] }[]): number {
  const heading = streetHeading(roads, p);
  let best = ENTRANCE_REACH;
  let edge: Vec2 | null = null;
  for (const s of stations)
    for (const poly of s.polygons) {
      const c = ringCentroid(poly.outer);
      if (Math.hypot(c[0] - p[0], c[1] - p[1]) > ENTRANCE_REACH) continue;
      const ring = poly.outer;
      for (let k = 1; k < ring.length; k++) {
        const cl = closestOnSegment(p, ring[k - 1], ring[k]);
        if (cl.d < best) [best, edge] = [cl.d, cl.point];
      }
    }
  if (!edge) return heading;
  const toward = (edge[0] - p[0]) * Math.cos(heading) + (edge[1] - p[1]) * Math.sin(heading);
  return toward < 0 ? heading + Math.PI : heading;
}

/** A platform's stairs go up to a concourse whose middle lies within this distance (m). */
const PLATFORM_REACH = 150;
/** Platform stairs' width (m). */
const PLATFORM_STAIRS = 3;
/** Rail level below a platform's floor (m). */
const PLATFORM_HEIGHT = 1.1;
/** Profile points along an underground track at most this far apart (m). */
const TRACK_STEP = 10;

/** Direction (unit) of a ring's longest edge: a platform's long side. */
function longAxis(ring: Vec2[]): Vec2 {
  let best: Vec2 = [1, 0];
  let len = 0;
  for (let k = 1; k < ring.length; k++) {
    const dx = ring[k][0] - ring[k - 1][0];
    const dy = ring[k][1] - ring[k - 1][1];
    const l = Math.hypot(dx, dy);
    if (l > len) [len, best] = [l, [dx / l, dy / l]];
  }
  return best;
}

/** A level down under the street: a station's concourse floor this far below its ground (m). */
const STATION_CONCOURSE = 6;
/** A passage ends this far inside the station's outline (m). */
const PASSAGE_INTO = 3;

/**
 * The corridor from a stair pit's bottom to the nearest edge of its station
 * and on into it: from the pit's floor level down (or up) to the concourse.
 */
function stationPassage(
  at: Vec2,
  heading: number,
  top: number,
  station: UndergroundStructure,
): Vec3[] {
  const f: Vec2 = [Math.cos(heading), Math.sin(heading)];
  const door: Vec2 = [at[0] + f[0] * STATION_PIT_LENGTH, at[1] + f[1] * STATION_PIT_LENGTH];
  const z0 = top - STATION_PIT.depth;
  const ring = station.footprint.outer;
  const inside = pointInRing(door, ring);
  let edge: Vec2 = door;
  let best = Infinity;
  if (!inside)
    for (let k = 1; k < ring.length; k++) {
      const cl = closestOnSegment(door, ring[k - 1], ring[k]);
      if (cl.d < best) [best, edge] = [cl.d, cl.point];
    }
  // On past the edge into the concourse (towards the station's middle).
  const mid = ringCentroid(ring);
  const into = Math.hypot(mid[0] - edge[0], mid[1] - edge[1]);
  const t = into > 0 ? Math.min(1, PASSAGE_INTO / into) : 0;
  const end: Vec2 = [edge[0] + (mid[0] - edge[0]) * t, edge[1] + (mid[1] - edge[1]) * t];
  return [
    [door[0], door[1], z0],
    ...(inside ? [] : [[edge[0], edge[1], station.floorZ] as Vec3]),
    [end[0], end[1], station.floorZ],
  ];
}

/** A metro entrance's stairs follow a street within this distance (m). */
const ENTRANCE_STREET = 40;

/** An entrance leads into the underground structure whose middle lies within this distance (m). */
const ENTRANCE_REACH = 200;

export const COMPILER_VERSION = '116';

/** Area kinds where no synthetic building may be placed. */
const NO_BUILD: AreaKind[] = [
  'park',
  'grass',
  'forest',
  'water',
  'parking',
  'playground',
  'school',
  'religious',
  'plaza',
  'stadium',
  'pitch',
  'track',
  'bus_station',
  'cemetery',
  'construction',
  'quarry',
  'harbour',
  'military',
  'marketplace',
  'substation',
  'power_plant',
  'airport',
  'apron',
  'runway',
  'taxiway',
];

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

const EMPTY: SourceFeatures = { roads: [], buildings: [], points: [], areas: [], lines: [] };

/**
 * Compiles source data into a renderable, deterministic city model:
 * terrain → road network → observed buildings (with fixes) → city blocks →
 * block infill → facades → props. Same input + options ⇒ same output.
 *
 * With `src.frame` the model is one 1 km UTM tile: the city is compiled with
 * `frame.margin` metres of context, then every output is cut to the tile —
 * buildings / props / blocks by centroid, surfaces / markings / terrain by
 * geometry — so adjacent tiles join without gaps or duplicates.
 */
/**
 * The stretches of a line over a tile's core: cut at 5 m steps, a step kept
 * where its middle is inside — neighbouring tiles' stretches meet end to end.
 */
function linePieces(points: Vec2[], inside: (p: Vec2) => boolean): Vec2[][] {
  const pts = densify(points, 5);
  const out: Vec2[][] = [];
  let run: Vec2[] = [];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    if (inside([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])) {
      if (!run.length) run.push(a);
      run.push(b);
    } else if (run.length) {
      out.push(run);
      run = [];
    }
  }
  if (run.length >= 2) out.push(run);
  return out.filter((r) => r.length >= 2);
}

/** A wall as pieces of at most `max` metres along it (vertices kept, pieces share their ends). */
function fencePieces(f: Fence, max: number): Fence[] {
  const out: Fence[] = [];
  let piece: Vec2[] = [f.points[0]];
  let run = 0;
  for (let k = 1; k < f.points.length; k++) {
    const a = f.points[k - 1];
    const b = f.points[k];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / max));
    for (let i = 1; i <= n; i++) {
      const p: Vec2 = [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n];
      piece.push(p);
      run += len / n;
      if (run >= max) {
        out.push({ ...f, points: piece });
        piece = [p];
        run = 0;
      }
    }
  }
  if (piece.length >= 2) out.push({ ...f, points: piece });
  return out;
}

/** Building types that, mapped round other buildings, are the grounds of a campus. */
const CAMPUS_TYPES = new Set(['school', 'kindergarten', 'college', 'university', 'hospital']);

/**
 * A school / hospital "building" with other buildings standing inside it is
 * its grounds mapped as a building (a whole lise campus as one 27 000 m²
 * block of flats): it becomes the campus area — walled yard round the real
 * buildings — instead of a building.
 */
function campusGrounds(f: SourceFeatures): SourceFeatures {
  const isCampusType = (b: SourceBuilding) =>
    CAMPUS_TYPES.has(b.tags.building ?? '') || CAMPUS_TYPES.has(b.tags.amenity ?? '');
  const candidates = f.buildings.filter(isCampusType);
  if (!candidates.length) return f;
  const centres = f.buildings.map((b) => ({
    b,
    c: ringCentroid(b.polygons[0].outer),
    area: b.polygons.reduce((s, p) => s + polygonArea(p), 0),
  }));
  const grounds = new Set<SourceBuilding>();
  for (const cand of candidates) {
    const holds = centres.some(
      (o) =>
        o.b !== cand &&
        o.area >= 100 &&
        cand.polygons.some(
          (p) => pointInRing(o.c, p.outer) && !p.holes.some((h) => pointInRing(o.c, h)),
        ),
    );
    if (holds) grounds.add(cand);
  }
  if (!grounds.size) return f;
  return {
    ...f,
    buildings: f.buildings.filter((b) => !grounds.has(b)),
    areas: [
      ...f.areas,
      ...[...grounds].map(
        (b): SourceArea => ({
          ref: b.ref,
          source: b.source,
          priority: b.priority,
          tags: b.tags,
          kind: 'school',
          polygons: b.polygons,
        }),
      ),
    ],
  };
}

/** Overlap (intersection over union) from which two areas of a kind are one area. */
const SAME_AREA = 0.85;

/**
 * Each area once: the same park or building site can come from two sources
 * (a city layer and a raw OSM extract of the district), and drawn twice it
 * doubles its walls, cranes and graves and fights itself on the ground. Of
 * near-identical areas of a kind, the higher priority wins, then a city
 * entity, then the first by ref.
 */
function distinctAreas(list: SourceArea[]): SourceArea[] {
  const ordered = [...list].sort(
    (a, b) =>
      b.priority - a.priority ||
      Number(!!b.tags[ENTITY_TAG]) - Number(!!a.tags[ENTITY_TAG]) ||
      (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0),
  );
  const kept: { a: SourceArea; box: [number, number, number, number]; area: number }[] = [];
  for (const a of ordered) {
    const boxes = a.polygons.map((p) => ringBounds(p.outer));
    const box: [number, number, number, number] = [
      Math.min(...boxes.map((b) => b[0])),
      Math.min(...boxes.map((b) => b[1])),
      Math.max(...boxes.map((b) => b[2])),
      Math.max(...boxes.map((b) => b[3])),
    ];
    const area = a.polygons.reduce((s, p) => s + polygonArea(p), 0);
    const same = kept.some((k) => {
      if (k.a.kind !== a.kind) return false;
      if (k.box[2] < box[0] || k.box[0] > box[2] || k.box[3] < box[1] || k.box[1] > box[3])
        return false;
      if (Math.min(k.area, area) < SAME_AREA * Math.max(k.area, area)) return false;
      const common = intersection(k.a.polygons, a.polygons).reduce((s, p) => s + polygonArea(p), 0);
      return common / (k.area + area - common) >= SAME_AREA;
    });
    if (!same) kept.push({ a, box, area });
  }
  return kept.map((k) => k.a);
}

export function compileCity(src: CitySource, opts: CompileOptions = {}): CityModel {
  const started = Date.now();
  const { infill = true, decorate = true } = opts;
  const cell = opts.terrainCell ?? 4;
  // City-wide analyses (bus stop coverage) are not tile-local; they run on whole areas only.
  const suggest = (opts.suggest ?? true) && !src.frame;

  let proj: Projection;
  let region: Bounds;
  let core: Bounds;
  if (src.frame) {
    proj = new TileProjection(src.frame);
    const { size, margin } = src.frame;
    core = { minX: 0, minY: 0, maxX: size, maxY: size };
    region = { minX: -margin, minY: -margin, maxX: size + margin, maxY: size + margin };
  } else {
    const [w, s, e, n] = src.bbox;
    proj = new LocalProjection({ lon: (w + e) / 2, lat: (s + n) / 2 });
    const [minX, minY] = proj.forward(w, s);
    const [maxX, maxY] = proj.forward(e, n);
    core = region = { minX, minY, maxX, maxY };
  }
  const origin = proj.inverse(0, 0);
  const g = proj.globalOffset;
  const regionPoly = regionRect(region);
  const inRegion = (p: Vec2) =>
    p[0] >= region.minX && p[0] <= region.maxX && p[1] >= region.minY && p[1] <= region.maxY;
  const inCore = (p: Vec2) =>
    p[0] >= core.minX && p[0] < core.maxX && p[1] >= core.minY && p[1] < core.maxY;

  const features = campusGrounds(
    mergeFeatures(
      src.osm ? readOsm(src.osm, proj) : EMPTY,
      src.features ? readFeatures(src.features, proj) : EMPTY,
    ),
  );
  // Buildings under the ground are not surface buildings (Kızılay's metro
  // station under Güvenpark was drawn as a house the streets cut up).
  const undergroundSources = features.buildings.filter((b) => undergroundBuilding(b.tags));
  if (undergroundSources.length)
    features.buildings = features.buildings.filter((b) => !undergroundBuilding(b.tags));
  // Rail lines and the airfield (road-theme lines that are not roads).
  const guide = layGuideways(
    features.roads,
    features.areas.filter((a) => a.kind === 'apron').flatMap((a) => a.polygons),
  );
  // Authoritative road network (e.g. the municipality's centrelines): other
  // sources' roads yield where it has data, so two networks never overlap.
  // Exceptions: national roads (motorway / trunk and their ramps, outside a
  // municipal register) and grade-separated roads. A bridge or tunnel running
  // along an authoritative centreline hands its grade to it (the register has
  // none); one crossing over or under it is kept as it is.
  const authoritativeRoads = features.roads.filter((r) => r.authoritative);
  const roadCovered = authorityCoverage(
    authoritativeRoads.map((r) => ({ points: r.points, area: false })),
    g,
    ROAD_COVER_REACH,
  );
  const national = (r: SourceRoad) => /^(motorway|trunk)(_link)?$/.test(r.tags.highway ?? '');
  // National roads yield only where the authoritative network has national
  // roads itself (a register built from the whole network, e.g. a city
  // delivered from OSM); a municipal register without them keeps the others'.
  // Otherwise both copies of a highway and its viaducts were drawn.
  const nationalCovered = authorityCoverage(
    authoritativeRoads.filter(national).map((r) => ({ points: r.points, area: false })),
    g,
    ROAD_COVER_REACH,
  );
  const yielding = features.roads.filter((r) => {
    if (r.authoritative) return false;
    const mid = r.points[Math.floor(r.points.length / 2)];
    return national(r) ? nationalCovered(mid) : roadCovered(mid);
  });
  const yieldingSet = new Set(yielding);
  const graded = transferGrades(authoritativeRoads, yielding.filter(isGraded));
  const sourceRoads = [
    ...graded.roads,
    ...features.roads.filter(
      (r) => !r.authoritative && (!yieldingSet.has(r) || (isGraded(r) && !graded.absorbed.has(r))),
    ),
  ];
  const roads = classifyRoads(sourceRoads);

  // Terrain on a grid aligned to the global frame, levelled under every street.
  const pad = src.frame ? 0 : 60;
  const align = (v: number, off: number, dir: 'down' | 'up') =>
    (dir === 'down' ? Math.floor((v + off) / cell) : Math.ceil((v + off) / cell)) * cell - off;
  const terrain = buildTerrain(
    src.terrain,
    proj,
    {
      minX: align(region.minX - pad, g[0], 'down'),
      minY: align(region.minY - pad, g[1], 'down'),
      maxX: align(region.maxX + pad, g[0], 'up'),
      maxY: align(region.maxY + pad, g[1], 'up'),
    },
    cell,
  );
  // Cliffs (mapped, and high coasts) stand as cliffs, not 30 m-DEM slopes;
  // streets are levelled onto the sharpened ground after.
  sharpenLandforms(
    terrain,
    features.lines.filter((l) => LANDFORM_LINES.has(l.tags.natural ?? '')),
  );
  // Land the elevation model puts under the sea (reclaimed shore) stays land —
  // before the streets are profiled: profiled first, a shore street kept the
  // DEM's 0 m while the land around it rose to the floor, and the sea plane
  // lay over it (Izmir, 2026-10-12).
  raiseLandAboveSea(terrain, {
    segments: roads.flatMap((r) =>
      r.centerline.slice(1).map((b, k) => [r.centerline[k], b] as [Vec2, Vec2]),
    ),
    polygons: [
      ...features.buildings.flatMap((b) => b.polygons),
      ...features.areas.filter((a) => a.kind !== 'water').flatMap((a) => a.polygons),
    ],
  });
  // Street surface: terrain levelled to it; each conformed road keeps its
  // centreline profile (the viewer drapes the road surfaces on it).
  const conformed = roads.filter(
    (r) => r.grade === 'ground' && (isVehicular(r.cls) || r.cls === 'pedestrian'),
  );
  const profiles = conformTerrainToRoads(
    terrain,
    conformed.map((r) => ({
      points: r.centerline,
      halfWidth: r.width / 2 + r.sidewalk,
      carriage: r.width / 2,
    })),
  );
  conformed.forEach((r, k) => (r.profile = profiles[k].map((z) => Math.round(z * 100) / 100)));
  // Underpass ramps and tunnel mouths: where they cut the levelled terrain.
  // Metro entrances open the ground: their stair pits are trenches too.
  const entrancePits = features.points
    .filter((pt) => pt.tags.railway === 'subway_entrance')
    .map((pt) => ({ at: pt.p, heading: entranceHeading(roads, pt.p, undergroundSources) }));
  const { cuttings, portals, tunnels, cut } = buildCuttings(roads, terrain, entrancePits);
  const cutGround = new CutGround(terrain, cut);

  // Road network.
  const signals = features.points.filter((p) => p.tags.highway === 'traffic_signals');
  const junctions = findJunctions(sourceRoads, roads, signals, g);
  // Where each junction ends on its arms, and the turns of the lanes driving in.
  layoutJunctions(junctions, roads);
  inferTurns(junctions, roads);
  const net = buildSurfaces(roads, [regionPoly]);
  // A ramp road's round end cap reaches past the portal over the tube (and
  // would lie on its lid): surfaces stop at the portal plane. Kept short of
  // the tunnel's middle so a street crossing over a short underpass stays.
  const tubeLength = new Map(
    tunnels.map((tn) => [tn.roadId, polylineLength(tn.path.map((q): Vec2 => [q[0], q[1]]))]),
  );
  // Underpass mouths need no cut: the trench draws its own road, and a short
  // underpass's tube lies right under the crossing street (cutting there
  // opened holes in that street's surface).
  const mouths: Polygon[] = portals
    .filter((p) => p.hill)
    .map((p) => {
      const n: Vec2 = [-p.facing[1], p.facing[0]];
      const w = p.width / 2 + 3;
      const len = Math.min(7, 0.3 * (tubeLength.get(p.roadId) ?? 0));
      const q = (along: number, across: number): Vec2 => [
        p.at[0] - p.facing[0] * along + n[0] * across,
        p.at[1] - p.facing[1] * along + n[1] * across,
      ];
      return { outer: [q(0, -w), q(0, w), q(len, w), q(len, -w)], holes: [] };
    });
  // No zebra in an underpass trench or on a tunnel mouth's lid (crossing.in-cut):
  // there is no street to walk across there.
  const crossings = buildCrossings(roads, junctions, features.points).filter(
    (c) =>
      inRegion(c.center) &&
      !cutGround.inTrench(c.center[0], c.center[1]) &&
      !cutGround.inLid(c.center[0], c.center[1]),
  );
  // Traffic stops behind the crossings; lane lines end there; stop / give-way
  // lines and turn arrows at the junctions (D-012).
  setStops(junctions, roads, crossings);
  connectJunctions(junctions, roads);
  const markings = clipLines(
    [...buildMarkings(roads, junctions), ...junctionMarkings(junctions, roads, crossings)],
    inRegion,
  );
  const roadIndex = new RoadIndex(roads);
  // Uyum motoru: rails and the network are fixed; everything after gives way
  // to them by the rule catalogue (harmony/rules.ts), leaving corrections.
  const harmony = new Harmonizer(guide.rails, roadIndex);

  const areas: Area[] = distinctAreas(features.areas).flatMap((a) =>
    intersection(a.polygons, [regionPoly]).map((polygon, i) => ({
      id: `a:${a.ref}${i ? `-${i}` : ''}`,
      kind: a.kind,
      ...(a.tags[ENTITY_TAG] ? { entity: a.tags[ENTITY_TAG] } : {}),
      polygon,
      provenance: 'observed' as const,
    })),
  );

  // Authoritative register (e.g. MAKS): around its buildings it is the only building source.
  const covered = authorityCoverage(
    features.buildings
      .filter((b) => b.authoritative)
      .flatMap((b) => b.polygons.map((p) => ({ points: p.outer, area: true }))),
    g,
    BUILDING_COVER_REACH,
  );
  const outranked = features.buildings.filter(
    (b) => !b.authoritative && b.polygons.some((p) => covered(ringCentroid(p.outer))),
  );
  const dropped = new Set(outranked);
  // A stadium's footprint mapped over the whole bowl: its stands are what is
  // left around the pitch and track (they are areas of their own).
  const field = [
    ...areas.filter((a) => a.kind === 'pitch').map((a) => a.polygon),
    ...trackGrounds(areas),
  ];
  // A plain building on a school / hospital campus is one of its blocks: it
  // takes the campus's purpose (public facades, no balconies).
  const campuses = features.areas
    .filter((a) => a.kind === 'school')
    .map((a) => ({ a, purpose: a.tags.amenity ?? a.tags.building ?? 'school' }))
    .filter((c) => CAMPUS_TYPES.has(c.purpose));
  const inCampus = (b: SourceBuilding): SourceBuilding => {
    if (!campuses.length || b.tags.amenity) return b;
    if (!['yes', 'residential', 'apartments', ''].includes(b.tags.building ?? '')) return b;
    const c = ringCentroid(b.polygons[0].outer);
    const campus = campuses.find((k) =>
      k.a.polygons.some((p) => pointInRing(c, p.outer) && !p.holes.some((h) => pointInRing(c, h))),
    );
    return campus ? { ...b, tags: { ...b.tags, amenity: campus.purpose } } : b;
  };
  const candidates = features.buildings
    .filter((b) => !dropped.has(b))
    .flatMap((b) => {
      // A roof over a pitch (covered halı saha, sports hall) is a hall, not a house.
      const generic =
        !b.tags.building || ['yes', 'roof', 'sports_centre'].includes(b.tags.building);
      if (
        generic &&
        field.some((f) =>
          b.polygons.some((p) => {
            const c = ringCentroid(p.outer);
            return pointInRing(c, f.outer) && !f.holes.some((h) => pointInRing(c, h));
          }),
        )
      )
        return [{ ...b, tags: { ...b.tags, building: 'sports_hall' } }];
      if (!STADIUM_BUILDINGS.has(b.tags.building ?? '') || !field.length) return [inCampus(b)];
      const polygons = difference(b.polygons, field).filter((p) => polygonArea(p) > 30);
      return polygons.length ? [{ ...b, polygons }] : [];
    });

  // Fuel stations: the data's canopy, or one laid for a station mapped as a point.
  const stations = fuelStations(features.points, features.areas);
  candidates.push(...stationCanopies(stations, features.buildings, roadIndex));

  // Observed buildings (highest-priority source first), corrected against roads and each other.
  const bctx = { terrain, roads: roadIndex };
  const placedObserved = placeObservedBuildings(candidates, bctx, [regionPoly]);
  const fixes = placedObserved.fixes;
  // Buildings against rail beds (cut back; raised halls and canopies stay).
  const observed = harmony.structures(placedObserved.buildings);
  const superseded = [
    ...placedObserved.superseded,
    ...outranked.map((b) => ringCentroid(b.polygons[0].outer)),
  ];

  // City blocks and infill.
  const blocked = buildBlocks(regionPoly, net.corridor, roadIndex, g);
  const { blocks, islands } = blocked;
  // Street fill: gaps between sidewalks and kerb-width tapers.
  const slivers = [...blocked.slivers, ...net.tapers];
  // Gaps between sidewalks become sidewalk, levelled to the street surface.
  if (slivers.length) {
    const sidewalk = net.surfaces.find((sf) => sf.kind === 'sidewalk');
    // Never over a carriageway or paving: a kerb taper spans the narrower
    // road's full width, and a sliver beside a service road (not a block
    // edge) lies on its asphalt — as sidewalk they covered the road.
    const taken = net.surfaces
      .filter((sf) => sf.kind === 'asphalt' || sf.kind === 'paving')
      .flatMap((sf) => sf.polygons);
    if (sidewalk) sidewalk.polygons = difference(union(sidewalk.polygons, slivers), taken);
    net.corridor = union(net.corridor, slivers);
    conformTerrainToFill(
      terrain,
      new RoadSurface(
        conformed.map((r) => ({
          points: r.centerline,
          profile: r.profile ?? [],
          halfWidth: r.width / 2 + r.sidewalk,
          carriage: r.width / 2,
        })),
        4,
        new PolygonSet(slivers),
      ),
      slivers,
    );
  }
  // Path edge lines from the final path outline (sidewalk now holds the fill).
  const markedPaths = roads
    .filter(
      (r) =>
        (r.cls === 'footway' || r.cls === 'cycleway') && r.grade === 'ground' && r.width >= 1.5,
    )
    .flatMap((r) => bufferPolyline(r.centerline, r.width / 2));
  if (markedPaths.length) {
    const surface = (kind: string) =>
      net.surfaces.filter((sf) => sf.kind === kind).flatMap((sf) => sf.polygons);
    markings.push(
      ...clipLines(
        pathEdgeMarkings(intersection(surface('path'), union(markedPaths)), [
          ...surface('asphalt'),
          ...surface('paving'),
          ...surface('sidewalk'),
        ]),
        inRegion,
      ),
    );
  }
  // The street surface (what the viewer drapes the street on): trench wall
  // tops and bridge ends meet it.
  const streetSurface = new RoadSurface(
    conformed.map((r) => ({
      points: r.centerline,
      profile: r.profile ?? [],
      halfWidth: r.width / 2 + r.sidewalk,
      carriage: r.width / 2,
    })),
    4,
    slivers.length ? new PolygonSet(slivers) : undefined,
  );
  const streetAt = (x: number, y: number) => streetSurface.heightAt(x, y);
  // One ground for drawing and placing: the terrain lowered under the streets
  // (as the viewer draws it) before anything takes its height from it. Props
  // and fences on a verge stood on the terrain before that lowering, up to
  // 2 m above the drawn ground on sloping streets (2026-10-15). Over the
  // whole region, before the tile is cut out: neighbours agree on the seam.
  const lowered = conformTerrainToStreets(terrain, streetSurface, {
    carriage: SURFACE_LIFT.asphalt,
    side: SURFACE_LIFT.sidewalk,
  });
  for (let i = 0; i < terrain.heights.length; i++) terrain.heights[i] = lowered.heights[i];
  // Trench wall tops from the street beside them; the ground there kept below.
  settleTrenchRims(cuttings, terrain, streetAt, SURFACE_LIFT.sidewalk);
  // The data's buildings took their base from the terrain before that
  // lowering: their walls reach down to the land cut to a street beside them
  // (they hung up to 0.5 m over it, Ankara 2026-10-16: building.float).
  for (const b of observed)
    b.baseZ = Math.min(b.baseZ, lowestGroundAround(b.footprint.outer, terrain) - 0.3);
  const pathSurface = net.surfaces.find((sf) => sf.kind === 'path')?.polygons ?? [];
  const serviceRoads = roads
    .filter((r) => r.cls === 'service' || r.cls === 'track')
    .flatMap((r) => bufferPolyline(r.centerline, r.width / 2 + 1));
  const noBuild = union(
    offset(
      observed.map((b) => b.footprint),
      2.5,
    ),
    areas.filter((a) => NO_BUILD.includes(a.kind)).map((a) => a.polygon),
    guide.footprint,
    offset(pathSurface, 1),
    serviceRoads,
  );

  // Nothing is built over a buried main: its easement (1 m beyond the pipe
  // wall) stays clear of generated buildings.
  const easements = features.lines
    .filter((l) => utilityKindOf(l.tags) && !isServiceLine(l.tags))
    .flatMap((l) => bufferPolyline(l.points, 1.5));
  for (const block of blocks) block.observedCoverage = observedCoverage(block, observed);
  const synthetic: Building[] = [];
  if (infill) {
    const roundabouts = roads.filter((r) => r.roundabout);
    const lots = infillAlongRoads(
      blocks.filter((bl) => !isRoundaboutIsland(bl, roundabouts)),
      roads,
      {
        terrain,
        blocked: easements.length ? union(noBuild, easements) : noBuild,
        globalOffset: g,
        region,
      },
    );
    const perBlock = new Map<string, number>();
    for (const lot of lots) {
      if (covered(ringCentroid(lot.footprint.outer))) continue;
      if (lot.blockId) perBlock.set(lot.blockId, (perBlock.get(lot.blockId) ?? 0) + 1);
      synthetic.push(
        makeBuilding(
          lot.id,
          lot.footprint,
          { building: 'apartments' },
          'synthetic',
          bctx,
          undefined,
          lot.levels,
        ),
      );
    }
    for (const block of blocks) block.syntheticBuildings = perBlock.get(block.id) ?? 0;
  }
  let buildings = [...observed, ...synthetic];
  const buildingIndex = new PolygonIndex<Building>();
  for (const b of buildings) buildingIndex.add(b, b.footprint);
  layoutFacades(buildings, buildingIndex, roadIndex);
  // Fuel stations dressed: pumps, price sign, forecourt (an area the hard ground draws).
  const stationDress = dressStations(stations, buildings, roadIndex);
  areas.push(...stationDress.areas);
  // A mosque whose minarets the data maps as buildings of their own gets no
  // generated ones (it would have two minarets side by side).
  const minarets = buildings
    .filter((b) => b.form === 'minaret')
    .map((b) => ringCentroid(b.footprint.outer));
  if (minarets.length)
    for (const b of buildings) {
      if (b.form !== 'mosque') continue;
      const c = ringCentroid(b.footprint.outer);
      const reach = Math.sqrt(b.area) + 25;
      if (minarets.some((m) => Math.hypot(m[0] - c[0], m[1] - c[1]) < reach)) b.minarets = 0;
    }

  // Hard ground (car parks, playgrounds, plazas, yards of institutions, dense blocks).
  // Kept off the street corridors, and off the carriageways that are not
  // block edges (a service road through a square: the plaza's paving covered
  // it). Those are cut once, road by road — the network's asphalt as one
  // polygon made every area's cut ten times slower.
  const looseCarriage = roads
    .filter((r) => r.grade === 'ground' && !r.formsBlocks && isVehicular(r.cls))
    .flatMap((r) => bufferPolyline(r.centerline, r.width / 2));
  const hard = groundSurfaces(areas, blocks, buildings, net.corridor)
    .map((sf) =>
      sf.kind === 'airfield' && guide.airfield.length
        ? { ...sf, polygons: union([...sf.polygons, ...guide.airfield]) }
        : sf,
    )
    .map((sf) =>
      looseCarriage.length ? { ...sf, polygons: difference(sf.polygons, looseCarriage) } : sf,
    );
  const noTrees = hard
    .filter((sf) =>
      [
        'parking',
        'playground',
        'paving',
        'pitch',
        'track',
        'cemetery',
        'earth',
        'quarry',
        'gravel',
        'airfield',
      ].includes(sf.kind),
    )
    .flatMap((sf) => sf.polygons)
    .concat(guide.footprint)
    // Stadium and bus station grounds (an open concourse / apron), cemeteries
    // (their own cypresses), building sites, quarries, ports, markets: no
    // garden trees scattered over them.
    .concat(
      areas
        .filter((a) =>
          [
            'stadium',
            'bus_station',
            'cemetery',
            'construction',
            'quarry',
            'harbour',
            'marketplace',
            'substation',
            'power_plant',
            'airport',
            'apron',
            'runway',
            'taxiway',
          ].includes(a.kind),
        )
        .map((a) => a.polygon),
    );

  // Props.
  const pctx = { terrain, roads, roadIndex, buildings: buildingIndex, junctions, crossings };
  let props: Prop[] = [...observedProps(features.points, pctx), ...stationDress.props].filter((p) =>
    inRegion([p.position[0], p.position[1]]),
  );
  if (decorate) {
    props.push(
      ...decorateStreets(pctx, props).filter((p) => inRegion([p.position[0], p.position[1]])),
    );
    props.push(
      ...greenTrees(
        areas,
        blocks.map((b) => b.polygon),
        buildingIndex,
        roadIndex,
        noBuild,
        terrain,
        g,
        noTrees,
      ),
    );
  }
  // Car parks, playgrounds and garden walls (gates are props), placed with the rest.
  const parking = parkingLayout(areas, buildings, roadIndex, terrain);
  const campus = campusWalls(areas, buildings, terrain, roadIndex);
  const lots = gardenWalls(blocks, buildings, terrain, roadIndex, campus.inside);
  const walls = {
    fences: [...campus.fences, ...lots.fences],
    gates: [...campus.gates, ...lots.gates],
  };
  // Cemeteries, building sites, harbours, military grounds, markets.
  const grounds = furnishGrounds(areas, buildingIndex, terrain, roadIndex, inRegion);
  walls.fences.push(...grounds.fences);
  props.push(...parking.props, ...playgroundLayout(areas, terrain), ...walls.gates);
  if (suggest) props.push(...suggestBusStops(pctx, props, inRegion));
  // Nothing generated may stand on a carriageway (e.g. a lamp of one street
  // landing on a crossing street); observed props there were moved to the kerb.
  props = props.filter(
    (p) =>
      p.provenance === 'observed' ||
      roadIndex.covering([p.position[0], p.position[1]], carriageReach) === null,
  );
  // Nothing may intersect a building or another prop (trees shrink to fit a wall).
  const placement = resolvePropPlacement(props, buildingIndex);
  props = placement.props;
  props.push(...buildingDetails(buildings));
  // Laid out clear of buildings and roads by their own rules (rows of graves, stalls …).
  props.push(...grounds.props.filter((p) => inRegion([p.position[0], p.position[1]])));
  // Windsocks beside the runway ends, on the ground.
  for (const p of guide.props)
    if (inRegion([p.position[0], p.position[1]]))
      props.push({
        ...p,
        position: [
          p.position[0],
          p.position[1],
          terrainHeightAt(terrain, p.position[0], p.position[1]),
        ],
      });

  let bridges = buildBridges(
    [...roads, ...guide.decks],
    terrain,
    roadIndex,
    cutGround,
    streetAt,
    harmony,
  );
  // Rail on its bridges: the deck-top height along each line on a deck.
  const railDecks = bridges.filter((b) => b.roadId.startsWith(RAIL_DECK));
  const onDeck = (r: RailLine): RailLine => {
    if (r.grade !== 'bridge' || !railDecks.length) return r;
    // Points every 5 m: the deck rises and falls between the line's own vertices.
    const points = densify(r.points, 5);
    const profile = points.map((p) => {
      let best = { d: Infinity, z: 0 };
      for (const b of railDecks)
        for (let k = 1; k < b.path.length; k++) {
          const c = closestOnSegment(
            p,
            [b.path[k - 1][0], b.path[k - 1][1]],
            [b.path[k][0], b.path[k][1]],
          );
          if (c.d < best.d)
            best = { d: c.d, z: b.path[k - 1][2] + (b.path[k][2] - b.path[k - 1][2]) * c.t };
        }
      return best.z;
    });
    return { ...r, points, profile };
  };
  props = clearOfCuts(clearOfBridges(props, bridges), cut);
  // Nothing stands on a rail bed; walls and fences do not cross the line.
  {
    const kept = harmony.furniture(props, walls.fences);
    props = kept.props;
    walls.fences = kept.fences;
  }
  // Overhead lines between the pylons (turned to face along their line).
  const overhead = overheadSpans(props.filter((p) => p.kind === 'pylon'));
  // Paved / gravel yards around buildings (outside the hard ground above); the
  // rest of each block stays green.
  const yards0 = difference(
    intersection(
      blocks.map((b) => b.polygon),
      offset(
        buildings.map((b) => b.footprint),
        3.5,
        // Mitred: round joins multiplied yard vertices (and draped triangles) several times.
        'miter',
      ),
    ),
    areas
      .filter((a) => a.kind === 'park' || a.kind === 'grass' || a.kind === 'forest')
      .map((a) => a.polygon),
  );
  const yards = difference(
    yards0,
    hard.flatMap((sf) => sf.polygons),
  );

  // Lamps and the like along an underpass ramp stand on the trench floor.
  for (const p of props) {
    if (cutGround.inTrench(p.position[0], p.position[1]))
      p.position[2] = terrainHeightAt(cutGround.floor, p.position[0], p.position[1]);
  }

  let outTerrain = terrain;
  let outFill = slivers;
  let outCut = cut;
  // Trench rim: street surfaces stop at the outer face of the retaining walls
  // (trench footprint + 0.4 m, square at the open end where the ramp road
  // carries on), so a sidewalk never runs into a wall.
  const wallBands = cuttings.flatMap((c) =>
    bufferPolyline(
      c.path.map((q) => [q[0], q[1]] as Vec2),
      c.width / 2 + 0.4,
      false,
    ),
  );
  const cutStreet = (kind: SurfaceKind, polys: Polygon[]) =>
    wallBands.length && ['asphalt', 'sidewalk', 'island', 'paving'].includes(kind)
      ? difference(polys, wallBands)
      : polys;
  let outSurfaces = [
    ...net.surfaces.map((sf) => ({
      kind: sf.kind,
      polygons: dropHairlines(cutStreet(sf.kind, difference(sf.polygons, mouths))),
    })),
    { kind: 'island' as const, polygons: dropHairlines(cutStreet('island', islands)) },
    { kind: 'yard' as const, polygons: yards },
    ...hard,
  ];
  // One surface per spot: nothing else under a rail bed (surface.rail).
  outSurfaces = harmony.surfaces(outSurfaces);
  // Where a deck runs low over the ground (its landing in a junction) the deck
  // is the surface: the streets' surfaces stop at its edge and the land under
  // it lies below it. Other roads' asphalt and sidewalks rose through a deck
  // easing into its landing (bridge.ground-through, 2026-10-16).
  const lowDecks = lowDeckPrints(
    bridges,
    (x, y) => streetAt(x, y) ?? terrainHeightAt(terrain, x, y),
    terrain.cellSize,
  );
  if (lowDecks.prints.length) {
    outSurfaces = outSurfaces.map((sf) => ({
      ...sf,
      polygons: dropHairlines(difference(sf.polygons, lowDecks.prints)),
    }));
    sinkUnderDecks(terrain, lowDecks);
  }
  const allMarkings = harmony.paint([
    ...markings,
    ...parking.markings,
    ...pitchMarkings(areas),
    ...runwayMarkings(areas),
    ...guide.markings,
  ]);
  let outMarkings = allMarkings;
  let outFences = walls.fences;
  let outOverhead = overhead;
  let outRails = guide.rails.map(onDeck);
  let outCrossings = crossings;
  let outJunctions = junctions;
  let outAreas = areas;
  let outBlocks = blocks;
  let outRoads = roads;
  let outFixes = [...fixes, ...harmony.corrections];

  if (src.frame) {
    // Ownership: everything is cut to the tile so neighbours never overlap.
    const corePoly = regionRect(core);
    buildings = buildings.filter((b) => inCore(ringCentroid(b.footprint.outer)));
    const kept = new Set(buildings.map((b) => b.id));
    props = props.filter((p) =>
      p.buildingId ? kept.has(p.buildingId) : inCore([p.position[0], p.position[1]]),
    );
    outFixes = [
      ...fixes.filter((f) => kept.has(f.targetId)),
      // The engine's corrections: a building's with the building, the others
      // by where they happened.
      ...harmony.corrections.filter((f) =>
        f.targetId.startsWith('b:')
          ? kept.has(f.targetId)
          : inCore(f.at ?? (f.removed[0] ? ringCentroid(f.removed[0].outer) : [Infinity, 0])),
      ),
    ];
    outSurfaces = outSurfaces.map((sf) => ({
      kind: sf.kind,
      polygons: dropHairlines(intersection(sf.polygons, [corePoly])),
    }));
    outMarkings = clipLines(allMarkings, inCore);
    // A rail line crossing tiles: each tile lays the stretches over its core.
    outRails = guide.rails.flatMap((r) =>
      linePieces(r.points, inCore).map((points, i) =>
        onDeck({ ...r, id: i ? `${r.id}~${i}` : r.id, points }),
      ),
    );
    // Walls cut at the core's edge, each part drawn by the tile it stands in,
    // on that tile's terrain: a piece kept whole past the edge stood on the
    // cropped grid's edge heights carried flat over the neighbour's slope
    // (fences floating at tile edges, 2026-10-16). Long ones in short pieces.
    outFences = clipLines(walls.fences, inCore).flatMap((f) => fencePieces(f, 40));
    outOverhead = overhead.filter((sp) =>
      inCore([(sp.a[0] + sp.b[0]) / 2, (sp.a[1] + sp.b[1]) / 2]),
    );
    outCrossings = crossings.filter((c) => inCore(c.center));
    outJunctions = junctions.filter((j) => inCore(j.center));
    outAreas = areas.flatMap((a) =>
      intersection([a.polygon], [corePoly]).map((polygon, i) => ({
        ...a,
        id: i ? `${a.id}~${i}` : a.id,
        polygon,
      })),
    );
    outBlocks = blocks.filter((b) => inCore(ringCentroid(b.polygon.outer)));
    outRoads = roads.filter((r) => r.centerline.some(inCore));
    // A viaduct crossing tiles: each tile draws the part over its core, split
    // at deck vertices so the neighbour's part starts exactly where this ends.
    bridges = bridges.flatMap((br) => clipBridgeToCore(br, inCore));
    outTerrain = cropTerrain(terrain, core);
    outFill = intersection(slivers, [
      regionRect({
        minX: core.minX - 8,
        minY: core.minY - 8,
        maxX: core.maxX + 8,
        maxY: core.maxY + 8,
      }),
    ]);
    const onGrid = (q: Vec3) =>
      q[0] >= core.minX - 0.01 &&
      q[0] <= core.maxX + 0.01 &&
      q[1] >= core.minY - 0.01 &&
      q[1] <= core.maxY + 0.01;
    // Footprints a little past the core: the viewer keeps its tile-edge
    // skirts off a trench or lid of the neighbouring tile next to the edge.
    const reach = regionRect({
      minX: core.minX - 8,
      minY: core.minY - 8,
      maxX: core.maxX + 8,
      maxY: core.maxY + 8,
    });
    outCut = {
      trenches: intersection(cut.trenches, [reach]),
      lids: intersection(cut.lids, [reach]),
      floor: cut.floor.filter(onGrid),
      lid: cut.lid.filter(onGrid),
    };
  }

  // Everything standing on the ground takes its height from the one ground
  // model the viewer draws with (sidewalk at kerb height, trench floor, lid …).
  // (The terrain was lowered under the streets above, as drawn.)
  const groundModel = new GroundModel({
    streetFill: outFill,
    terrain: outTerrain,
    terrainCut: outCut,
    roads: outRoads,
    surfaces: outSurfaces,
    areas: outAreas,
  });
  // Generated props keep to their class's supports (a car on a lot's corner
  // under the sidewalk, a tree on a pond …): those that do not are left out.
  const fenceSegs = fenceIndex(outFences);
  props = props.filter((p) => {
    if (p.buildingId) return true;
    if (p.provenance !== 'observed' && inFence(p, fenceSegs)) return false;
    const s = groundModel.surfaceAt(p.position[0], p.position[1]);
    p.position[2] = s.z;
    const allowed = SUPPORTS[p.kind];
    return p.provenance === 'observed' || !allowed || allowed.has(s.support);
  });

  // Buried networks, on the final ground; clipped to the core like tunnels.
  const network = buildUtilities(
    features.lines,
    features.points,
    (x, y) => groundModel.surfaceAt(x, y).z,
    props
      .filter((p) => p.kind === 'street-cabinet' && p.network)
      .map((p) => ({ ref: p.id, p: [p.position[0], p.position[1]] as Vec2, kind: p.network! })),
  );
  const outUtilities = network.utilities.flatMap((u) =>
    corePathRuns(u.path, inCore).map((path, k) => ({ ...u, id: k ? `${u.id}~${k}` : u.id, path })),
  );
  const outNodes = network.nodes.filter((n) => inCore([n.position[0], n.position[1]]));
  // Points of interest (tag `poi`, from the city model's poi theme), on the final ground.
  const outPois: Poi[] = features.points
    .filter((pt) => pt.tags.poi && inCore(pt.p))
    .map((pt) => ({
      id: `poi:${pt.ref}`,
      ref: pt.ref,
      ...(pt.tags[ENTITY_TAG] ? { entity: pt.tags[ENTITY_TAG] } : {}),
      kind: pt.tags.poi,
      ...(pt.tags.name ? { name: pt.tags.name } : {}),
      ...(pt.tags.brand ? { brand: pt.tags.brand } : {}),
      position: [pt.p[0], pt.p[1], groundModel.surfaceAt(pt.p[0], pt.p[1]).z],
    }));
  const outLights = guide.lights.filter((l) => inCore(l.at));

  // Under the ground: structures (kept whole, by the tile holding their middle)
  // and the metro entrances down to them, on the final ground.
  const structures: UndergroundStructure[] = undergroundSources.flatMap((b) =>
    b.polygons.map((footprint, k) => {
      const c = ringCentroid(footprint.outer);
      return {
        id: `ug:${b.ref}${k ? `~${k}` : ''}`,
        ref: b.ref,
        ...(b.tags[ENTITY_TAG] ? { entity: b.tags[ENTITY_TAG] } : {}),
        ...(b.tags.name ? { name: b.tags.name } : {}),
        kind: b.tags.building ?? 'yes',
        layer: Number.parseInt(b.tags.layer ?? '-1', 10),
        footprint,
        groundZ: groundModel.surfaceAt(c[0], c[1]).z,
        floorZ:
          groundModel.surfaceAt(c[0], c[1]).z -
          STATION_CONCOURSE * Math.max(1, -Number.parseInt(b.tags.layer ?? '-1', 10)),
      };
    }),
  );
  // Every entrance of the region (a passage may reach a station in this tile
  // from an entrance in the next one); the tile keeps its own.
  const allEntrances: StationEntrance[] = features.points
    .filter((pt) => pt.tags.railway === 'subway_entrance')
    .map((pt) => {
      let station: UndergroundStructure | undefined;
      let best = ENTRANCE_REACH;
      for (const s of structures) {
        const c = ringCentroid(s.footprint.outer);
        const d = Math.hypot(c[0] - pt.p[0], c[1] - pt.p[1]);
        if (d < best) [best, station] = [d, s];
      }
      const heading = entranceHeading(roads, pt.p, undergroundSources);
      const top = groundModel.surfaceAt(pt.p[0], pt.p[1]).z;
      return {
        id: `se:${pt.ref}`,
        ref: pt.ref,
        ...(pt.tags[ENTITY_TAG] ? { entity: pt.tags[ENTITY_TAG] } : {}),
        ...(pt.tags.name ? { name: pt.tags.name } : {}),
        position: [pt.p[0], pt.p[1], top],
        heading,
        ...(station
          ? {
              station: station.ref,
              passage: stationPassage(pt.p, heading, top, station),
            }
          : {}),
      };
    });
  const entrances = allEntrances.filter((e) => inCore([e.position[0], e.position[1]]));
  for (const s of structures) {
    // A passage with a point on the outline (it starts outside) comes through there.
    const doors = allEntrances
      .filter((e) => e.station === s.ref && e.passage && e.passage.length > 2)
      .map((e): Vec2 => [e.passage![1][0], e.passage![1][1]]);
    if (doors.length) s.doors = doors;
  }
  // Platforms reach their concourse by stairs along their long side, from
  // its floor down to theirs; the concourse floor is open over them.
  for (const p of structures) {
    if (p.kind !== 'platform') continue;
    const c = ringCentroid(p.footprint.outer);
    const above = structures
      .filter((s) => s.kind !== 'platform' && s.layer > p.layer)
      .map((s) => ({ s, d: Math.hypot(...sub(ringCentroid(s.footprint.outer), c)) }))
      .filter((o) => o.d < PLATFORM_REACH || pointInRing(c, o.s.footprint.outer))
      .sort((a, b) => a.d - b.d)[0]?.s;
    if (!above) continue;
    const drop = above.floorZ - p.floorZ;
    if (drop <= 0.5) continue;
    const axis = longAxis(p.footprint.outer);
    const half = drop / Math.tan(Math.PI / 6) / 2;
    const a: Vec2 = [c[0] - axis[0] * half, c[1] - axis[1] * half];
    const b: Vec2 = [c[0] + axis[0] * half, c[1] + axis[1] * half];
    p.stairs = {
      from: [a[0], a[1], above.floorZ],
      to: [b[0], b[1], p.floorZ],
      width: PLATFORM_STAIRS,
    };
    const w: Vec2 = [-axis[1] * (PLATFORM_STAIRS / 2), axis[0] * (PLATFORM_STAIRS / 2)];
    (above.openings ??= []).push([
      [a[0] - w[0], a[1] - w[1]],
      [b[0] - w[0], b[1] - w[1]],
      [b[0] + w[0], b[1] + w[1]],
      [a[0] + w[0], a[1] + w[1]],
    ]);
  }
  // Metro lines in their tunnels: rail level a level down per layer under the
  // street, a platform's height below its floor.
  const tracks: UndergroundTrack[] = features.roads
    .filter(
      (r) =>
        (r.tags.highway === 'subway' || r.tags.highway === 'rail') &&
        !!r.tags.tunnel &&
        r.tags.tunnel !== 'no' &&
        r.points.length >= 2,
    )
    .flatMap((r) => {
      const layer = Number.parseInt(r.tags.layer ?? '-1', 10);
      const depth = STATION_CONCOURSE * Math.max(1, -layer) + PLATFORM_HEIGHT;
      const path: Vec3[] = densify(r.points, TRACK_STEP).map((q) => [
        q[0],
        q[1],
        groundModel.surfaceAt(q[0], q[1]).z - depth,
      ]);
      return corePathRuns(path, inCore).map((run, k) => ({
        id: k ? `ut:${r.ref}~${k}` : `ut:${r.ref}`,
        ref: r.ref,
        ...(r.tags.name ? { name: r.tags.name } : {}),
        layer,
        path: run,
      }));
    });
  const coreStructures = structures.filter((s) => inCore(ringCentroid(s.footprint.outer)));
  const outUnderground =
    coreStructures.length || entrances.length || tracks.length
      ? { structures: coreStructures, entrances, ...(tracks.length ? { tracks } : {}) }
      : null;

  const observedOut = buildings.filter((b) => b.source !== 'synthetic');
  const count = (pred: (p: Prop) => boolean) => props.filter(pred).length;
  return {
    version: 1,
    name: src.name,
    origin,
    bounds: core,
    frame: src.frame,
    attribution: src.attribution,
    terrain: outTerrain,
    terrainConformed: true,
    roads: outRoads,
    surfaces: outSurfaces,
    markings: outMarkings,
    fences: outFences,
    ...(outOverhead.length ? { overhead: outOverhead } : {}),
    ...(outRails.length ? { rails: outRails } : {}),
    ...(outLights.length ? { airfieldLights: outLights } : {}),
    ...(outUtilities.length ? { utilities: outUtilities } : {}),
    ...(outNodes.length ? { utilityNodes: outNodes } : {}),
    ...(outPois.length ? { pois: outPois } : {}),
    ...(outUnderground ? { underground: outUnderground } : {}),
    ...(outFill.length ? { streetFill: outFill } : {}),
    crossings: outCrossings,
    junctions: outJunctions,
    bridges,
    cuttings: cuttings.filter((c) => inCore([c.path[0][0], c.path[0][1]])),
    portals: portals.filter((p) => inCore([p.at[0], p.at[1]])),
    tunnels: tunnels.flatMap((tn) =>
      corePathRuns(tn.path, inCore).map((path, k) => ({
        ...tn,
        id: k ? `${tn.id}~${k}` : tn.id,
        path,
      })),
    ),
    ...(outCut.trenches.length || outCut.lids.length ? { terrainCut: outCut } : {}),
    areas: outAreas,
    blocks: outBlocks,
    buildings,
    props,
    fixes: outFixes,
    stats: {
      compileMs: Date.now() - started,
      roads: outRoads.length,
      roadKm: Math.round(outRoads.reduce((sum, r) => sum + polylineLength(r.centerline), 0)) / 1000,
      junctions: outJunctions.length,
      blocks: outBlocks.length,
      buildingsObserved: observedOut.length,
      buildingsUnderground: outUnderground?.structures.length ?? 0,
      buildingsSynthetic: buildings.length - observedOut.length,
      buildingsSuperseded: superseded.filter((c) => inCore(c)).length,
      ...Object.fromEntries(
        [...new Set(observedOut.map((b) => b.source))].map((src) => [
          `buildings:${src}`,
          observedOut.filter((b) => b.source === src).length,
        ]),
      ),
      levelsObserved: buildings.filter((b) => b.provenance.levels === 'observed').length,
      fixes: outFixes.length,
      propsObserved: count((p) => p.provenance === 'observed'),
      propsSynthetic: count((p) => p.provenance === 'synthetic' && !p.buildingId),
      propsSuggested: count((p) => p.provenance === 'suggested'),
      propsShrunk: placement.shrunk.filter((q) => inCore(q)).length,
      propsDropped: placement.dropped.filter((q) => inCore(q)).length,
    },
  };
}

/** Sub-grid of the terrain covering exactly `b` (grid is aligned so `b` edges are nodes). */
function cropTerrain(t: TerrainGrid, b: Bounds): TerrainGrid {
  const i0 = Math.round((b.minX - t.minX) / t.cellSize);
  const j0 = Math.round((b.minY - t.minY) / t.cellSize);
  const cols = Math.round((b.maxX - b.minX) / t.cellSize) + 1;
  const rows = Math.round((b.maxY - b.minY) / t.cellSize) + 1;
  const heights: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) heights.push(t.heights[(j0 + j) * t.cols + (i0 + i)]);
  }
  return {
    ...t,
    minX: t.minX + i0 * t.cellSize,
    minY: t.minY + j0 * t.cellSize,
    cols,
    rows,
    heights,
  };
}

/** Lines (markings, walls) cut where they cross the core's edge: each tile draws its own part. */
function clipLines<T extends { points: Vec2[] }>(markings: T[], inside: (p: Vec2) => boolean): T[] {
  const out: T[] = [];
  // Where a segment leaves (or enters) the core: found by halving, so paint
  // runs on to the tile edge and the neighbour's starts right there.
  const edge = (a: Vec2, b: Vec2): Vec2 => {
    let lo = a;
    let hi = b;
    for (let k = 0; k < 16; k++) {
      const mid: Vec2 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
      if (inside(mid) === inside(a)) lo = mid;
      else hi = mid;
    }
    return inside(a) ? lo : hi;
  };
  const emit = (m: T, points: Vec2[]) => {
    if (points.length >= 2) out.push({ ...m, points });
  };
  for (const m of markings) {
    let run: Vec2[] = [];
    m.points.forEach((p, k) => {
      const prev = m.points[k - 1];
      if (inside(p)) {
        if (!run.length && prev) run.push(edge(prev, p));
        run.push(p);
      } else {
        if (run.length && prev) run.push(edge(prev, p));
        emit(m, run);
        run = [];
      }
    });
    emit(m, run);
  }
  return out;
}

/** Trees in parks / woods and in the back gardens of city blocks. */
function greenTrees(
  areas: Area[],
  blocks: Polygon[],
  buildings: PolygonIndex<Building>,
  roads: RoadIndex,
  noBuild: Polygon[],
  terrain: CityModel['terrain'],
  globalOffset: Vec2,
  /** Car parks, playgrounds, plazas: no tree scattered over them. */
  hard: Polygon[] = [],
): Prop[] {
  const out: Prop[] = [];
  const onHard = (q: Vec2) =>
    hard.some((h) => pointInRing(q, h.outer) && !h.holes.some((r) => pointInRing(q, r)));
  // Park / grass polygons often run under streets in the data: no tree in the
  // street corridor (carriageway, sidewalks, footpaths).
  const land = (q: Vec2) =>
    terrainHeightAt(terrain, q[0], q[1]) > terrain.seaLevel + 0.8 &&
    roads.covering(q, corridorReach) === null;
  const place = (points: Vec2[], prefix: string, scaleRange: [number, number]) => {
    const rng = new Rng(prefix);
    points.forEach((q, i) => {
      out.push({
        id: `${prefix}-${i}`,
        kind: 'tree',
        position: [q[0], q[1], terrainHeightAt(terrain, q[0], q[1])],
        heading: rng.range(0, Math.PI * 2),
        scale: rng.range(...scaleRange),
        provenance: 'synthetic',
      });
    });
  };
  for (const a of areas) {
    if (a.kind !== 'park' && a.kind !== 'forest' && a.kind !== 'grass') continue;
    const spacing = a.kind === 'forest' ? 7 : a.kind === 'park' ? 10 : 18;
    place(
      scatter(a.polygon, spacing, a.id, (q) => buildings.at(q) !== null || !land(q) || onHard(q)),
      `g${a.id}`,
      [0.8, 1.3],
    );
  }
  // Back gardens: land inside blocks that stays free of buildings.
  const gardens = intersection(blocks, offset(noBuild, -1.5));
  for (const g of gardens) {
    // Seeded by global position so a garden spanning two tiles grows the same trees in both.
    const c = ringCentroid(g.outer);
    const key = `${Math.round(c[0] + globalOffset[0])}_${Math.round(c[1] + globalOffset[1])}`;
    place(
      scatter(g, 14, `garden-${key}`, (q) => buildings.at(q) !== null || !land(q) || onHard(q)),
      `yard${key}`,
      [0.7, 1.1],
    );
  }
  return out;
}

/** Bridge decks: straight grade between the ends, lifted over the terrain in between. */
/** Spacing of bridge piers along the deck (m). */
const PIER_SPACING = 26;
/** Deck structure depth below the running surface (m). */
const DECK_DEPTH = 1.4;

/**
 * Bridge ways joined end to end into one continuous structure: OSM splits a
 * viaduct wherever a tag changes, and drawing each piece separately leaves
 * butt joints, gaps at bends and barrier breaks. Pieces merge at a node where
 * exactly two bridge ends of the same layer meet and the line carries on.
 */
function bridgeChains(bridges: Road[]): Road[][] {
  const key = (p: Vec2) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;
  const at = new Map<string, Road[]>();
  for (const r of bridges) {
    for (const p of [r.centerline[0], r.centerline[r.centerline.length - 1]]) {
      const k = key(p);
      at.set(k, [...(at.get(k) ?? []), r]);
    }
  }
  const used = new Set<Road>();
  const chains: Road[][] = [];
  const dirAt = (pts: Vec2[], fromEnd: boolean): Vec2 =>
    fromEnd
      ? normalize(sub(pts[pts.length - 1], pts[pts.length - 2]))
      : normalize(sub(pts[0], pts[1]));
  // The piece continuing `road` through its end (start when !fromEnd), if any.
  const next = (road: Road, pts: Vec2[], fromEnd: boolean): Road | null => {
    const p = fromEnd ? pts[pts.length - 1] : pts[0];
    const there = at.get(key(p)) ?? [];
    if (there.length !== 2) return null;
    const other = there[0] === road ? there[1] : there[0];
    if (used.has(other) || other.layer !== road.layer) return null;
    const c = other.centerline;
    const otherAway = dist(c[0], p) < dist(c[c.length - 1], p) ? dirAt(c, false) : dirAt(c, true);
    // `otherAway` points from the joint back into the other piece: opposite to our heading out.
    const out = dirAt(pts, fromEnd);
    return out[0] * otherAway[0] + out[1] * otherAway[1] < -0.5 ? other : null;
  };
  for (const r of bridges) {
    if (used.has(r)) continue;
    used.add(r);
    const chain: { road: Road; pts: Vec2[] }[] = [{ road: r, pts: r.centerline }];
    // Forward.
    for (;;) {
      const last = chain[chain.length - 1];
      const o = next(last.road, last.pts, true);
      if (!o) break;
      used.add(o);
      const end = last.pts[last.pts.length - 1];
      const c = o.centerline;
      chain.push({
        road: o,
        pts: dist(c[0], end) <= dist(c[c.length - 1], end) ? c : [...c].reverse(),
      });
    }
    // Backward.
    for (;;) {
      const first = chain[0];
      const o = next(first.road, first.pts, false);
      if (!o) break;
      used.add(o);
      const start = first.pts[0];
      const c = o.centerline;
      chain.unshift({
        road: o,
        pts: dist(c[c.length - 1], start) <= dist(c[0], start) ? c : [...c].reverse(),
      });
    }
    chains.push(
      chain.map(({ road, pts }) => (pts === road.centerline ? road : { ...road, centerline: pts })),
    );
  }
  return chains;
}

function buildBridges(
  roads: Road[],
  terrain: CityModel['terrain'],
  roadIndex: RoadIndex,
  ground: CutGround,
  /** Street surface height (null off the street corridors). */
  streetAt: (x: number, y: number) => number | null,
  /** Uyum motoru: what each deck crosses and the clearance it needs. */
  harmony?: Harmonizer,
): Bridge[] {
  const bridges = roads.filter((r) => r.grade === 'bridge');
  // A deck lands on the street surface (levelled across the carriageway) at
  // its asphalt's height, not on the terrain under it: flush where the street
  // stops at the deck.
  const landAt = (p: Vec2) => {
    const z = streetAt(p[0], p[1]);
    return z !== null ? z + SURFACE_LIFT.asphalt : terrainHeightAt(terrain, p[0], p[1]);
  };
  // Chain ends where other bridges meet (a Y split) stay up; ends on the ground road ramp down.
  const key = (p: Vec2) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;
  const ends = new Map<string, number>();
  for (const r of bridges) {
    for (const p of [r.centerline[0], r.centerline[r.centerline.length - 1]])
      ends.set(key(p), (ends.get(key(p)) ?? 0) + 1);
  }
  // A slip road may join a viaduct at one of its inner vertices: that end is
  // up on the deck too, not on the ground.
  const onOtherDeck = (p: Vec2, self: Road[]) =>
    bridges.some(
      (r) =>
        !self.includes(r) &&
        r.centerline.some((q, k) => k > 0 && closestOnSegment(p, r.centerline[k - 1], q).d < 1),
    );
  const decks = bridgeChains(bridges).map((chain) => {
    const first = chain[0];
    const pts: Vec2[] = [];
    for (const r of chain) {
      for (const p of r.centerline) {
        const last = pts[pts.length - 1];
        if (!last || dist(last, p) <= 0.05) {
          if (!last) pts.push(p);
          continue;
        }
        // Vertices at most 8 m apart: deck heights (ramps, joins) are set per vertex.
        const n = Math.ceil(dist(last, p) / 8);
        for (let i = 1; i < n; i++) pts.push(lerp2(last, p, i / n));
        pts.push(p);
      }
    }
    const layer = first.layer;
    const total = polylineLength(pts);
    const clearance = 5.5 * Math.max(1, layer);
    const inner = (p: Vec2) => (ends.get(key(p)) ?? 0) > 1 || onOtherDeck(p, chain);
    const startInner = inner(pts[0]);
    const endInner = inner(pts[pts.length - 1]);
    const endZ = (p: Vec2, isInner: boolean) =>
      isInner ? terrainHeightAt(terrain, p[0], p[1]) + clearance : landAt(p);
    const za = endZ(pts[0], startInner);
    const zb = endZ(pts[pts.length - 1], endInner);
    const at: number[] = [0];
    for (let k = 1; k < pts.length; k++) at.push(at[k - 1] + dist(pts[k - 1], pts[k]));
    // Ground under each vertex; within the ramps, the street surface the deck lands on.
    const grounds = pts.map((p, k) =>
      (!startInner && at[k] < 25) || (!endInner && total - at[k] < 25)
        ? landAt(p)
        : terrainHeightAt(terrain, p[0], p[1]),
    );
    // Ground across a short deck's width (its edges and middle): on a cross
    // slope the higher edge rose through a deck held only over its centreline.
    const half = Math.max(...chain.map((r) => deckHalf(r)));
    const across = pts.map((p, k) => {
      const a = pts[Math.max(0, k - 1)];
      const b = pts[Math.min(pts.length - 1, k + 1)];
      const l = dist(a, b) || 1;
      const n: Vec2 = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
      return Math.max(
        grounds[k],
        landAt([p[0] + n[0] * half, p[1] + n[1] * half]),
        landAt([p[0] - n[0] * half, p[1] - n[1] * half]),
      );
    });
    // A short bridge spans straight between its ground ends, rising from each
    // at most DECK_RISE above the ground's own grade to its clearance, as one
    // vertical curve. Its clearance came within the 25 m ramps: down a
    // hillside the deck went in steps, flat then steep, and dropped 19 % into
    // its landing (Ankara 2026-10-16). A long viaduct
    // follows the ground (averaged over ±60 m) at clearance height: that depends
    // only on nearby terrain, so neighbouring tiles compute the same deck.
    const straight = !startInner && !endInner && total < 400;
    const path: Vec3[] = pts.map((p, k) => {
      const s = at[k];
      // Ramps only at ends that meet the ground road.
      const fromStart = startInner ? Infinity : s;
      const fromEnd = endInner ? Infinity : total - s;
      const ramp = Math.min(1, Math.min(fromStart, fromEnd) / 25 || 0);
      let base: number;
      // A ground end lies on the street it lands on, whatever the ground beside it.
      if (straight && k === 0) return [p[0], p[1], za];
      if (straight && k === pts.length - 1) return [p[0], p[1], zb];
      if (straight) {
        base = Math.max(
          za + (zb - za) * (total > 0 ? s / total : 0),
          across[k] +
            Math.max(DECK_SKIN, Math.min(clearance, DECK_RISE * Math.min(fromStart, fromEnd))),
        );
      } else {
        let sum = 0;
        let n = 0;
        for (let m = 0; m < pts.length; m++) {
          if (Math.abs(at[m] - s) <= 60) {
            sum += grounds[m];
            n++;
          }
        }
        // Ramp ends sit exactly on the ground at this point; full height beyond 25 m.
        base = grounds[k] + (sum / n + clearance - grounds[k]) * ramp;
        base = Math.max(base, grounds[k] + 2 * ramp);
      }
      return [p[0], p[1], base];
    });
    if (straight) concaveMajorant(at, path);
    // Where the deck meets the ground road it runs on under the road surface,
    // so no seam opens between the two. Where it meets another deck it runs
    // 1 m into it: decks meeting end to end at an angle (a Y split) overlap
    // instead of leaving a wedge, and the overlap is drawn as one surface.
    const extend = (end: Vec3, toward: Vec3, by: number): Vec3 => {
      const dx = end[0] - toward[0];
      const dy = end[1] - toward[1];
      const l = Math.hypot(dx, dy) || 1;
      return [end[0] + (dx / l) * by, end[1] + (dy / l) * by, end[2]];
    };
    if (path.length >= 2) {
      const head = extend(path[0], path[1], startInner ? 1 : 1.5);
      const tail = extend(path[path.length - 1], path[path.length - 2], endInner ? 1 : 1.5);
      // Run on under the road surface at its own height there.
      // Just under the street asphalt there (coplanar, the two z-fought).
      if (!startInner) head[2] = landAt([head[0], head[1]]) - 0.03;
      if (!endInner) tail[2] = landAt([tail[0], tail[1]]) - 0.03;
      path.unshift(head);
      path.push(tail);
    }
    const widthOf = (r: Road) => 2 * deckHalf(r);
    const bridge: Bridge = {
      id: `br${first.id}`,
      roadId: first.id,
      path,
      width: Math.max(...chain.map(widthOf)),
      carriageway: Math.max(...chain.map((r) => r.width)),
      lanes: Math.max(...chain.map((r) => r.lanes)),
      oneway: chain.every((r) => r.oneway),
      edgeLines: chain.some((r) => ['motorway', 'trunk', 'primary'].includes(r.cls)),
      piers: [],
    };
    // A short bridge's ends that land on a street (one ends there): their
    // heights, kept for after the joint passes.
    const n = path.length;
    const lands = (p: Vec2) =>
      roadIndex.nearest(
        p,
        2,
        (r) =>
          r.grade === 'ground' &&
          [r.centerline[0], r.centerline[r.centerline.length - 1]].some((q) => dist(q, p) < 2),
      ) !== null;
    const landing =
      straight && n >= 4
        ? {
            start: lands(pts[0]) ? [path[0][2], path[1][2]] : null,
            end: lands(pts[pts.length - 1]) ? [path[n - 2][2], path[n - 1][2]] : null,
          }
        : null;
    return { bridge, pts, layer, chain, startInner, endInner, straight, landing };
  });
  settleJoinedDecks(decks);
  matchDeckEnds(decks);
  spreadSplitDecks(decks);
  if (harmony) for (const d of decks) raiseOverEnvelope(d, harmony, roads, terrain);
  // Raised over what it crosses, a short bridge is one vertical curve again
  // (the raise left a hump with flats either side).
  for (const d of decks) {
    if (!d.landing || d.bridge.path.length < 4) continue;
    // Its ends stay on the street they land on: joining a twin deck's end
    // there (matchDeckEnds) lifted them up to 1.7 m over it.
    const all = d.bridge.path;
    const last = all.length - 1;
    if (d.landing.start) [all[0][2], all[1][2]] = d.landing.start;
    if (d.landing.end) [all[last - 1][2], all[last][2]] = d.landing.end;
    // Not the two end points run on under the street (they sit 3 cm under its asphalt).
    const p = all.slice(1, -1);
    const at = [0];
    for (let k = 1; k < p.length; k++)
      at.push(at[k - 1] + Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]));
    concaveMajorant(at, p);
  }
  // Deck segments in a 20 m grid (a column checks only the decks around it).
  const deckSegs = new GridIndex<{ bridge: Bridge; a: Vec3; b: Vec3 }>(20);
  for (const { bridge } of decks) {
    const r = bridge.width / 2 + 1;
    for (let k = 1; k < bridge.path.length; k++) {
      const a = bridge.path[k - 1];
      const b = bridge.path[k];
      deckSegs.insert(
        { bridge, a, b },
        Math.min(a[0], b[0]) - r,
        Math.min(a[1], b[1]) - r,
        Math.max(a[0], b[0]) + r,
        Math.max(a[1], b[1]) + r,
      );
    }
  }
  const ctx = {
    terrain,
    roadIndex,
    ground,
    deckSegs,
    blocked: harmony && ((q: Vec2) => harmony.blocksPier(q)),
  };
  for (const { bridge, pts } of decks) bridge.piers = placePiers(bridge, pts, ctx);
  return decks.map((d) => d.bridge);
}

/** A deck this close (m) over the ground under its middle is low: the ground there yields to it. */
const LOW_OVER_GROUND = 1;

/**
 * The low stretches of every deck (top within LOW_OVER_GROUND of the ground
 * under its middle), as footprints, with the decks to read heights from. The
 * run-on at each end (under the street it lands on) is left out.
 */
function lowDeckPrints(
  bridges: Bridge[],
  groundAt: (x: number, y: number) => number,
  /** Extra reach of the land sunk under them (a grid cell: its triangles reach the deck edge). */
  landReach: number,
): { prints: Polygon[]; land: Polygon[]; decks: Bridge[] } {
  const prints: Polygon[] = [];
  const land: Polygon[] = [];
  const decks: Bridge[] = [];
  for (const br of bridges) {
    const before = prints.length;
    const p = br.path.slice(1, -1);
    let run: Vec2[] = [];
    const flush = () => {
      if (run.length >= 2) {
        prints.push(...bufferPolyline(run, br.width / 2 + 0.1, false));
        land.push(...bufferPolyline(run, br.width / 2 + landReach, false));
      }
      run = [];
    };
    for (const q of p) {
      if (q[2] - groundAt(q[0], q[1]) < LOW_OVER_GROUND) run.push([q[0], q[1]]);
      else {
        if (run.length) run.push([q[0], q[1]]);
        flush();
      }
    }
    flush();
    if (prints.length > before) decks.push(br);
  }
  return { prints, land, decks };
}

/** Terrain nodes under (and a cell beside) a low deck stretch, DECK_SKIN below the deck there. */
function sinkUnderDecks(t: TerrainGrid, low: { land: Polygon[]; decks: Bridge[] }): void {
  const set = new PolygonSet(low.land);
  for (let j = 0; j < t.rows; j++)
    for (let i = 0; i < t.cols; i++) {
      const x = t.minX + i * t.cellSize;
      const y = t.minY + j * t.cellSize;
      if (!set.contains(x, y)) continue;
      let best = { d: Infinity, z: 0 };
      for (const br of low.decks)
        for (let k = 1; k < br.path.length; k++) {
          const a = br.path[k - 1];
          const b = br.path[k];
          const c = closestOnSegment([x, y], [a[0], a[1]], [b[0], b[1]]);
          if (c.d < best.d) best = { d: c.d, z: a[2] + (b[2] - a[2]) * c.t };
        }
      const idx = j * t.cols + i;
      t.heights[idx] = Math.min(t.heights[idx], best.z - DECK_SKIN);
    }
}

/** Steepest a short bridge's deck rises from a ground end, over the ground's own grade. */
const DECK_RISE = 0.06;
/** Least height (m) of a short deck's top over the ground across it, its ends apart. */
const DECK_SKIN = 0.15;

/**
 * Raises a profile (heights `path[k][2]` at distances `at[k]`) to its least
 * concave majorant: straight runs between the points it must clear, its grade
 * only ever falling — a deck's vertical curve, no flats and steps.
 */
function concaveMajorant(at: number[], path: Vec3[]): void {
  const hull: number[] = [];
  for (let k = 0; k < path.length; k++) {
    while (hull.length >= 2) {
      const a = hull[hull.length - 2];
      const b = hull[hull.length - 1];
      // b lies on or under the chord a–k: not a vertex of the upper hull.
      const cross =
        (at[b] - at[a]) * (path[k][2] - path[a][2]) - (path[b][2] - path[a][2]) * (at[k] - at[a]);
      if (cross >= 0) hull.pop();
      else break;
    }
    hull.push(k);
  }
  for (let h = 1; h < hull.length; h++) {
    const a = hull[h - 1];
    const b = hull[h];
    for (let k = a + 1; k < b; k++) {
      const t = (at[k] - at[a]) / (at[b] - at[a] || 1);
      path[k][2] = path[a][2] + (path[b][2] - path[a][2]) * t;
    }
  }
}

/** Steepest grade a deck may be raised with: a footbridge takes stairs, a road a ramp. */
const RAISE_GRADE = { path: 0.25, road: 0.07 };
const RAISE_LANDING = { path: 0.5, road: 0.12 };

/**
 * Clearance rules (clearance.bridge-*): wherever a deck passes over a rail
 * bed, a ground carriageway or a path, its underside keeps that class's free
 * height (classes.ts). A deck too low is raised there, eased back over a
 * ramp at the class's grade; at an end that lands on the ground it may climb
 * no steeper than stairs (path) / a steep ramp (road). What still does not
 * clear is flagged for review. Roads the deck lands on are not "under" it.
 */
function raiseOverEnvelope(
  deck: { bridge: Bridge; chain: Road[]; startInner: boolean; endInner: boolean },
  harmony: Harmonizer,
  roads: Road[],
  terrain: TerrainGrid,
): void {
  const { bridge, chain } = deck;
  const path = bridge.path;
  if (path.length < 2) return;
  const own = new Set(chain.map((r) => r.id));
  // Ground roads touching the deck's ends (the streets its ramps land on).
  const ends = [path[0], path[path.length - 1]].map((q) => [q[0], q[1]] as Vec2);
  const landing = new Set(
    roads
      .filter(
        (r) =>
          r.grade === 'ground' &&
          [r.centerline[0], r.centerline[r.centerline.length - 1]].some((p) =>
            ends.some((e) => dist(p, e) < 6),
          ),
      )
      .map((r) => r.id),
  );
  const skip = (id: string) => own.has(id) || landing.has(id);
  const isPath = chain.every((r) => !isVehicular(r.cls));
  const grade = isPath ? RAISE_GRADE.path : RAISE_GRADE.road;
  const steep = isPath ? RAISE_LANDING.path : RAISE_LANDING.road;
  // Arc length of each vertex.
  const at: number[] = [0];
  for (let k = 1; k < path.length; k++)
    at.push(at[k - 1] + Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]));
  const total = at[at.length - 1];
  const zAt = (s: number) => {
    let k = 1;
    while (k < at.length - 1 && at[k] < s) k++;
    const t = at[k] > at[k - 1] ? (s - at[k - 1]) / (at[k] - at[k - 1]) : 0;
    return path[k - 1][2] + (path[k][2] - path[k - 1][2]) * Math.min(1, Math.max(0, t));
  };
  const pointAt = (s: number): Vec2 => {
    let k = 1;
    while (k < at.length - 1 && at[k] < s) k++;
    const t = at[k] > at[k - 1] ? (s - at[k - 1]) / (at[k] - at[k - 1]) : 0;
    return [
      path[k - 1][0] + (path[k][0] - path[k - 1][0]) * t,
      path[k - 1][1] + (path[k][1] - path[k - 1][1]) * t,
    ];
  };
  // Needs, sampled every metre along the deck.
  const needs: { s: number; lift: number; e: Envelope; under: number; p: Vec2 }[] = [];
  for (let s = 0; s <= total; s += 1) {
    const p = pointAt(s);
    const e = harmony.envelopeAt(p, skip);
    if (!e) continue;
    const under = zAt(s) - DECK_DEPTH - terrainHeightAt(terrain, p[0], p[1]);
    const lift = e.clearance - under;
    if (lift > 0.05) needs.push({ s, lift, e, under, p });
  }
  if (!needs.length) return;
  // A deck end on the ground stays there: within reach of it the deck climbs at most `steep`.
  const cap = (s: number) =>
    Math.min(
      deck.startInner ? Infinity : s * steep,
      deck.endInner ? Infinity : (total - s) * steep,
    );
  const PLATEAU = 4;
  const liftAt = (s: number) => {
    let l = 0;
    for (const n of needs)
      l = Math.max(l, n.lift - grade * Math.max(0, Math.abs(s - n.s) - PLATEAU));
    return Math.max(0, Math.min(l, cap(s)));
  };
  // Vertices at most 4 m apart where the deck moves, so the raised span is not cut short.
  const dense: Vec3[] = [path[0]];
  const denseAt: number[] = [0];
  for (let k = 1; k < path.length; k++) {
    const n = liftAt(at[k]) > 0 || liftAt(at[k - 1]) > 0 ? Math.ceil((at[k] - at[k - 1]) / 4) : 1;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      dense.push([
        path[k - 1][0] + (path[k][0] - path[k - 1][0]) * t,
        path[k - 1][1] + (path[k][1] - path[k - 1][1]) * t,
        path[k - 1][2] + (path[k][2] - path[k - 1][2]) * t,
      ]);
      denseAt.push(at[k - 1] + (at[k] - at[k - 1]) * t);
    }
  }
  bridge.path = dense.map((q, k) => [q[0], q[1], q[2] + liftAt(denseAt[k])]);
  // One correction per thing crossed: the worst point of each.
  const worst = new Map<string, (typeof needs)[number]>();
  for (const n of needs) {
    const prev = worst.get(n.e.ref);
    if (!prev || n.lift > prev.lift) worst.set(n.e.ref, n);
  }
  for (const n of worst.values()) {
    const after = n.under + liftAt(n.s);
    harmony.deckRaised(bridge.roadId, n.p, n.e, n.under, after, after >= n.e.clearance - 0.05);
  }
}

/** Order in which decks own a shared surface: widest (main carriageway) first. */
export function deckPriority(a: Bridge, b: Bridge): number {
  return b.width - a.width || b.lanes - a.lanes || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Decks that join (Y split, slip road onto a viaduct, two ways merging) share
 * one surface, so they must have one height there: decks are settled widest
 * first, and where a deck overlaps an already settled one at about the same
 * level it takes that deck's height, eased back to its own over up to 120 m
 * either side. Decks crossing over or under each other are left alone.
 */
function settleJoinedDecks(decks: { bridge: Bridge }[]): void {
  const order = [...decks].sort((a, b) => deckPriority(a.bridge, b.bridge));
  const settled: Bridge[] = [];
  const ease = (x: number) => {
    const c = Math.min(1, Math.max(0, x));
    return 1 - c * c * (3 - 2 * c);
  };
  const boxOf = (b: Bridge) => {
    let bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const q of b.path)
      bb = [
        Math.min(bb[0], q[0]),
        Math.min(bb[1], q[1]),
        Math.max(bb[2], q[0]),
        Math.max(bb[3], q[1]),
      ];
    const r = b.width / 2;
    return [bb[0] - r, bb[1] - r, bb[2] + r, bb[3] + r];
  };
  const boxes = new Map(decks.map((d) => [d.bridge, boxOf(d.bridge)]));
  for (const { bridge } of order) {
    const path = bridge.path;
    const own = boxes.get(bridge)!;
    const at = [0];
    for (let k = 1; k < path.length; k++)
      at.push(at[k - 1] + Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]));
    const span = Math.min(120, at[at.length - 1] * 0.6);
    for (const other of settled) {
      const ob = boxes.get(other)!;
      if (ob[0] > own[2] || ob[2] < own[0] || ob[1] > own[3] || ob[3] < own[1]) continue;
      // Height of `other` under each vertex where the two decks overlap.
      const target = path.map((q) => {
        let best = { d: Infinity, z: 0 };
        for (let k = 1; k < other.path.length; k++) {
          const a = other.path[k - 1];
          const b = other.path[k];
          const c = closestOnSegment([q[0], q[1]], [a[0], a[1]], [b[0], b[1]]);
          if (c.d < best.d) best = { d: c.d, z: a[2] + (b[2] - a[2]) * c.t };
        }
        const overlap = best.d < (other.width + bridge.width) / 2 - 0.5;
        return overlap && Math.abs(best.z - q[2]) < 3.5 ? best.z : null;
      });
      const joined = target.flatMap((z, k) => (z === null ? [] : [k]));
      if (!joined.length) continue;
      const delta = path.map((q, k) => {
        if (target[k] !== null) return target[k]! - q[2];
        // Nearest joined vertex along the deck.
        let near = joined[0];
        for (const m of joined) if (Math.abs(at[m] - at[k]) < Math.abs(at[near] - at[k])) near = m;
        return span > 0
          ? (target[near]! - path[near][2]) * ease(Math.abs(at[near] - at[k]) / span)
          : 0;
      });
      path.forEach((q, k) => (q[2] += delta[k]));
    }
    settled.push(bridge);
  }
}

/**
 * Decks meeting end to end without being chained into one (a layer change at
 * the node, steps up to a footbridge at an angle, footbridge pieces drawn a
 * metre or two apart in the source) each got their own height there: a ramp
 * ended 5 m above the viaduct it joins, steps 4 m below their footbridge
 * (İzmir, 2026-10-09). Ends at one node, or of the same layer within END_GAP
 * of each other, form a joint and are brought to the highest of them; each
 * lifted deck eases back to its own height over up to 60 m (at most 60 % of
 * its length, so a far end that lands on the ground stays there).
 */
const END_GAP = 3;
function matchDeckEnds(decks: { bridge: Bridge; pts: Vec2[]; layer: number }[]): void {
  // `path` runs from the joint (index 0: the 1 m run-on, 1: the joint vertex).
  const ends: { deck: number; at: Vec2; layer: number; path: Vec3[] }[] = [];
  decks.forEach(({ bridge, pts, layer }, deck) => {
    if (bridge.path.length < 4 || pts.length < 2) return;
    ends.push({ deck, at: pts[0], layer, path: bridge.path });
    ends.push({ deck, at: pts[pts.length - 1], layer, path: [...bridge.path].reverse() });
  });
  // Joints: ends linked through any chain of close pairs (union-find).
  const root = ends.map((_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      if (ends[i].deck === ends[j].deck) continue;
      const d = dist(ends[i].at, ends[j].at);
      if (d < 0.75 || (d < END_GAP && ends[i].layer === ends[j].layer)) root[find(i)] = find(j);
    }
  }
  const joints = new Map<number, Vec3[][]>();
  ends.forEach((e, i) => joints.set(find(i), [...(joints.get(find(i)) ?? []), e.path]));
  const ease = (x: number) => {
    const c = Math.min(1, Math.max(0, x));
    return 1 - c * c * (3 - 2 * c);
  };
  for (const paths of joints.values()) {
    if (paths.length < 2) continue;
    const target = Math.max(...paths.map((path) => path[1][2]));
    for (const path of paths) {
      const delta = target - path[1][2];
      if (delta < 0.05) continue;
      let walked = 0;
      const at = path.map((q, k) => {
        if (k > 1) walked += Math.hypot(q[0] - path[k - 1][0], q[1] - path[k - 1][1]);
        return walked;
      });
      const span = Math.min(60, at[at.length - 1] * 0.6);
      // Vec3s are shared with the deck's own path: lifting them lifts the deck.
      path.forEach((q, k) => (q[2] += span > 0 ? delta * ease(at[k] / span) : 0));
    }
  }
}

/**
 * At a split (a wide deck ending where narrower ones begin, all centrelines
 * meeting in one point) each narrower deck starts against the wide deck's
 * edge on its own side and eases back onto its centreline over up to 60 m:
 * the wide deck narrows into its branches instead of ending with open
 * corners beside them.
 */
function spreadSplitDecks(decks: { bridge: Bridge }[]): void {
  const ease = (x: number) => {
    const c = Math.min(1, Math.max(0, x));
    return 1 - c * c * (3 - 2 * c);
  };
  const ends = decks.flatMap(({ bridge }) => {
    const p = bridge.path;
    return [0, p.length - 1].map((idx) => {
      const q = p[idx];
      const r = p[idx === 0 ? 1 : p.length - 2];
      const l = Math.hypot(q[0] - r[0], q[1] - r[1]) || 1;
      // Unit vector pointing out of the deck at this end.
      return { bridge, idx, at: [q[0], q[1]] as Vec2, out: [(q[0] - r[0]) / l, (q[1] - r[1]) / l] };
    });
  });
  type Match = { child: (typeof ends)[number]; parent: (typeof ends)[number]; lateral: number };
  const groups = new Map<(typeof ends)[number], Match[]>();
  for (const child of ends) {
    const parent = ends
      .filter(
        (e) =>
          e.bridge !== child.bridge &&
          e.bridge.width > child.bridge.width + 0.5 &&
          dist(e.at, child.at) < 3,
      )
      .sort((a, b) => b.bridge.width - a.bridge.width)[0];
    if (!parent || child.bridge.path.length < 2) continue;
    // Where the branch heads, relative to the wide deck's axis: its point
    // about 60 m along (branches often run side by side at first).
    const path = child.bridge.path;
    let walked = 0;
    let ahead = path[child.idx];
    for (let i = 1; i < path.length; i++) {
      const k = child.idx === 0 ? i : path.length - 1 - i;
      const prev = child.idx === 0 ? k - 1 : k + 1;
      walked += Math.hypot(path[k][0] - path[prev][0], path[k][1] - path[prev][1]);
      ahead = path[k];
      if (walked >= 60) break;
    }
    const axis: Vec2 = [-parent.out[0], -parent.out[1]];
    const rel: Vec2 = [ahead[0] - parent.at[0], ahead[1] - parent.at[1]];
    const list = groups.get(parent) ?? [];
    list.push({ child, parent, lateral: axis[0] * rel[1] - axis[1] * rel[0] });
    groups.set(parent, list);
  }
  for (const list of groups.values()) {
    // Branches take the sides by their order across the wide deck: the
    // leftmost against its left edge, the rightmost against its right edge.
    list.sort((a, b) => a.lateral - b.lateral);
    list.forEach((m, rank) => {
      const side =
        list.length === 1
          ? Math.abs(m.lateral) < 0.05
            ? 0
            : Math.sign(m.lateral)
          : rank === 0
            ? -1
            : rank === list.length - 1
              ? 1
              : 0;
      if (!side) return;
      const { child, parent } = m;
      const path = child.bridge.path;
      const shift = (side * (parent.bridge.width - child.bridge.width)) / 2;
      const at = [0];
      for (let k = 1; k < path.length; k++)
        at.push(at[k - 1] + Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]));
      const total = at[at.length - 1];
      const span = Math.min(60, total * 0.5);
      // Offsets along the wide deck's own left normal, so the branch's edge meets its edge.
      const axis: Vec2 = [-parent.out[0], -parent.out[1]];
      const n: Vec2 = [-axis[1], axis[0]];
      for (let k = 0; k < path.length; k++) {
        const s = child.idx === 0 ? at[k] : total - at[k];
        const w = ease(s / span);
        if (w <= 0) continue;
        path[k][0] += n[0] * shift * w;
        path[k][1] += n[1] * shift * w;
      }
    });
  }
}

/**
 * Piers about every PIER_SPACING m where the deck stands clear of the ground.
 * A column never stands on a carriageway, on a lower deck or in an underpass
 * trench: the pier moves along the deck (up to ±12 m) to the nearest clear
 * spot, or is left out (the span is longer there, as over a wide road).
 */
function placePiers(
  bridge: Bridge,
  pts: Vec2[],
  ctx: {
    terrain: TerrainGrid;
    roadIndex: RoadIndex;
    ground: CutGround;
    deckSegs: GridIndex<{ bridge: Bridge; a: Vec3; b: Vec3 }>;
    /** Ground a column may not stand on (a rail bed and its margin). */
    blocked?: (q: Vec2) => boolean;
  },
): Bridge['piers'] {
  const girder = Math.max(1.5, (bridge.width / 2) * 0.62);
  const columns = bridge.width > 13 ? [-girder * 0.6, girder * 0.6] : [0];
  // Column half size 0.6 m, plus a clearance to the kerb.
  const COLUMN = 0.9;
  const onRoad = (r: Road) => (carriageReach(r) > 0 ? carriageReach(r) + COLUMN : 0);
  const clear = (q: Vec2, top: number) => {
    if (ctx.roadIndex.covering(q, onRoad)) return false;
    if (ctx.ground.inTrench(q[0], q[1])) return false;
    if (ctx.blocked?.(q)) return false;
    for (const s of ctx.deckSegs.query(q[0], q[1], q[0], q[1])) {
      if (s.bridge === bridge) continue;
      const c = closestOnSegment(q, [s.a[0], s.a[1]], [s.b[0], s.b[1]]);
      // A lower deck the column would pass through.
      if (c.d < s.bridge.width / 2 + COLUMN && s.a[2] + (s.b[2] - s.a[2]) * c.t < top - 1)
        return false;
    }
    return true;
  };
  const total = polylineLength(pts);
  const piers: Bridge['piers'] = [];
  let last = -Infinity;
  for (let s0 = PIER_SPACING / 2; s0 < total; s0 += PIER_SPACING) {
    for (const shift of [0, 2, -2, 4, -4, 6, -6, 8, -8, 10, -10, 12, -12]) {
      const s = s0 + shift;
      if (s <= 0 || s >= total || s - last < PIER_SPACING / 2) continue;
      const smp = samplePolyline(pts, Infinity, s)[0];
      if (!smp) break;
      const deck = deckAt(bridge.path, smp.point);
      const base = terrainHeightAt(ctx.terrain, smp.point[0], smp.point[1]);
      const top = deck - DECK_DEPTH;
      if (top - base <= 2.5) break;
      const n: Vec2 = [-smp.dir[1], smp.dir[0]];
      const ok = columns.every((o) =>
        clear([smp.point[0] + n[0] * o, smp.point[1] + n[1] * o], top),
      );
      if (!ok) continue;
      piers.push({ at: smp.point, dir: smp.dir, base: base - 0.5, top, columns });
      last = s;
      break;
    }
  }
  return piers;
}

/** Runs of a path whose segments lie over the tile core (midpoint test), split at vertices. */
function corePathRuns(path: Vec3[], inCore: (p: Vec2) => boolean): Vec3[][] {
  const runs: Vec3[][] = [];
  let run: Vec3[] = [];
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1];
    const b = path[k];
    if (inCore([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])) {
      if (!run.length) run.push(a);
      run.push(b);
    } else {
      if (run.length >= 2) runs.push(run);
      run = [];
    }
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

/** The runs of a bridge whose segments lie over the tile core (midpoint test). */
function clipBridgeToCore(br: Bridge, inCore: (p: Vec2) => boolean): Bridge[] {
  const out: Bridge[] = [];
  let run: Vec3[] = [];
  const flush = () => {
    if (run.length >= 2) {
      out.push({
        ...br,
        id: out.length ? `${br.id}~${out.length}` : br.id,
        path: run,
        piers: br.piers.filter((p) => inCore(p.at)),
      });
    }
    run = [];
  };
  for (let k = 1; k < br.path.length; k++) {
    const a = br.path[k - 1];
    const b = br.path[k];
    if (inCore([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])) {
      if (!run.length) run.push(a);
      run.push(b);
    } else flush();
  }
  flush();
  // Piers belong to the first run only (the list is the whole bridge's).
  out.slice(1).forEach((b) => (b.piers = []));
  return out;
}

/** Deck height at arc length `s` along a bridge path. */
/** Deck height over the closest point of its path. */
function deckAt(path: Vec3[], q: Vec2): number {
  let best = { d: Infinity, z: path[0][2] };
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1];
    const b = path[k];
    const c = closestOnSegment(q, [a[0], a[1]], [b[0], b[1]]);
    if (c.d < best.d) best = { d: c.d, z: a[2] + (b[2] - a[2]) * c.t };
  }
  return best.z;
}

/** Coverage cell size (metres) of authoritative sources. */
const COVER_CELL = 50;
/** Reach around each authoritative building / road within which other sources yield. */
const BUILDING_COVER_REACH = 100;
const ROAD_COVER_REACH = 40;

/**
 * Where an authoritative source has data: grid cells (aligned to the global
 * frame, so neighbouring tiles agree) within `reach` of its shapes. Polygons
 * mark their whole bounding box, lines each segment's — a long road must not
 * claim the rectangle around it. Tiles carry a 250 m margin, so every decision
 * about a point inside a tile sees all source shapes that could cover it.
 */
function authorityCoverage(
  shapes: { points: Vec2[]; area: boolean }[],
  globalOffset: Vec2,
  reach: number,
): (p: Vec2) => boolean {
  if (!shapes.length) return () => false;
  const cells = new Set<string>();
  const cellOf = (v: number, off: number) => Math.floor((v + off) / COVER_CELL);
  const mark = (minX: number, minY: number, maxX: number, maxY: number) => {
    for (
      let i = cellOf(minX - reach, globalOffset[0]);
      i <= cellOf(maxX + reach, globalOffset[0]);
      i++
    ) {
      for (
        let j = cellOf(minY - reach, globalOffset[1]);
        j <= cellOf(maxY + reach, globalOffset[1]);
        j++
      ) {
        cells.add(`${i},${j}`);
      }
    }
  };
  for (const { points, area } of shapes) {
    if (area) {
      const xs = points.map((q) => q[0]);
      const ys = points.map((q) => q[1]);
      mark(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    } else {
      for (let k = 1; k < points.length; k++) {
        const [a, b] = [points[k - 1], points[k]];
        mark(
          Math.min(a[0], b[0]),
          Math.min(a[1], b[1]),
          Math.max(a[0], b[0]),
          Math.max(a[1], b[1]),
        );
      }
    }
  }
  return (p) => cells.has(`${cellOf(p[0], globalOffset[0])},${cellOf(p[1], globalOffset[1])}`);
}
