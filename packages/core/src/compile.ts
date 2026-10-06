import { gardenWalls, groundSurfaces, parkingLayout, playgroundLayout } from './amenities';
import {
  buildBlocks,
  infillAlongRoads,
  isRoundaboutIsland,
  observedCoverage,
  regionRect,
  scatter,
} from './blocks';
import { layoutFacades, makeBuilding, placeObservedBuildings } from './buildings';
import { CutGround, buildCuttings, settleTrenchRims } from './cuttings';
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
import {
  ENTITY_TAG,
  LANDFORM_LINES,
  type SourceFeatures,
  type SourceRoad,
  mergeFeatures,
  readFeatures,
  readOsm,
} from './osm';
import { bufferPolyline, difference, dropHairlines, intersection, offset, union } from './poly';
import {
  buildingDetails,
  carriageReach,
  clearOfBridges,
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
  findJunctions,
  isVehicular,
} from './roads';
import { GridIndex, PolygonIndex, PolygonSet, RoadIndex } from './spatial';
import {
  RoadSurface,
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
  Marking,
  Polygon,
  Prop,
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
export const COMPILER_VERSION = '61';

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

  const features = mergeFeatures(
    src.osm ? readOsm(src.osm, proj) : EMPTY,
    src.features ? readFeatures(src.features, proj) : EMPTY,
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
  const yielding = features.roads.filter(
    (r) =>
      !r.authoritative && !national(r) && roadCovered(r.points[Math.floor(r.points.length / 2)]),
  );
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
  // Land the elevation model puts under the sea (reclaimed shore) stays land.
  raiseLandAboveSea(terrain, {
    segments: roads.flatMap((r) =>
      r.centerline.slice(1).map((b, k) => [r.centerline[k], b] as [Vec2, Vec2]),
    ),
    polygons: [
      ...features.buildings.flatMap((b) => b.polygons),
      ...features.areas.filter((a) => a.kind !== 'water').flatMap((a) => a.polygons),
    ],
  });
  // Underpass ramps and tunnel mouths: where they cut the levelled terrain.
  const { cuttings, portals, tunnels, cut } = buildCuttings(roads, terrain);
  const cutGround = new CutGround(terrain, cut);

  // Road network.
  const signals = features.points.filter((p) => p.tags.highway === 'traffic_signals');
  const junctions = findJunctions(sourceRoads, roads, signals, g);
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
  const markings = clipMarkings(buildMarkings(roads, junctions), inRegion);
  const crossings = buildCrossings(roads, junctions, features.points).filter((c) =>
    inRegion(c.center),
  );
  const roadIndex = new RoadIndex(roads);

  const areas: Area[] = features.areas.flatMap((a) =>
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
  const candidates = features.buildings.filter((b) => !dropped.has(b));

  // Observed buildings (highest-priority source first), corrected against roads and each other.
  const bctx = { terrain, roads: roadIndex };
  const placedObserved = placeObservedBuildings(candidates, bctx, [regionPoly]);
  const { buildings: observed, fixes } = placedObserved;
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
      ...clipMarkings(
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
  // Trench wall tops from the street beside them; the ground there kept below.
  settleTrenchRims(cuttings, terrain, streetAt, SURFACE_LIFT.sidewalk);
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
  layoutFacades(buildings, buildingIndex);

  // Hard ground (car parks, playgrounds, plazas, yards of institutions, dense blocks).
  // Kept off the street corridors, and off the carriageways that are not
  // block edges (a service road through a square: the plaza's paving covered
  // it). Those are cut once, road by road — the network's asphalt as one
  // polygon made every area's cut ten times slower.
  const looseCarriage = roads
    .filter((r) => r.grade === 'ground' && !r.formsBlocks && isVehicular(r.cls))
    .flatMap((r) => bufferPolyline(r.centerline, r.width / 2));
  const hard = groundSurfaces(areas, blocks, buildings, net.corridor).map((sf) =>
    looseCarriage.length ? { ...sf, polygons: difference(sf.polygons, looseCarriage) } : sf,
  );
  const noTrees = hard
    .filter((sf) => sf.kind === 'parking' || sf.kind === 'playground' || sf.kind === 'paving')
    .flatMap((sf) => sf.polygons);

  // Props.
  const pctx = { terrain, roads, roadIndex, buildings: buildingIndex, junctions, crossings };
  let props: Prop[] = observedProps(features.points, pctx).filter((p) =>
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
  const walls = gardenWalls(blocks, buildings, terrain, roadIndex);
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

  let bridges = buildBridges(roads, terrain, roadIndex, cutGround, streetAt);
  props = clearOfBridges(props, bridges);
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
  const allMarkings = [...markings, ...parking.markings];
  let outMarkings = allMarkings;
  let outFences = walls.fences;
  let outCrossings = crossings;
  let outJunctions = junctions;
  let outAreas = areas;
  let outBlocks = blocks;
  let outRoads = roads;
  let outFixes = fixes;

  if (src.frame) {
    // Ownership: everything is cut to the tile so neighbours never overlap.
    const corePoly = regionRect(core);
    buildings = buildings.filter((b) => inCore(ringCentroid(b.footprint.outer)));
    const kept = new Set(buildings.map((b) => b.id));
    props = props.filter((p) =>
      p.buildingId ? kept.has(p.buildingId) : inCore([p.position[0], p.position[1]]),
    );
    outFixes = fixes.filter((f) => kept.has(f.targetId));
    outSurfaces = outSurfaces.map((sf) => ({
      kind: sf.kind,
      polygons: dropHairlines(intersection(sf.polygons, [corePoly])),
    }));
    outMarkings = clipMarkings(allMarkings, inCore);
    outFences = walls.fences.filter((f) => {
      const a = f.points[0];
      const b = f.points[f.points.length - 1];
      return inCore([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    });
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
    roads: outRoads,
    surfaces: outSurfaces,
    markings: outMarkings,
    fences: outFences,
    ...(outUtilities.length ? { utilities: outUtilities } : {}),
    ...(outNodes.length ? { utilityNodes: outNodes } : {}),
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

function clipMarkings(markings: Marking[], inside: (p: Vec2) => boolean): Marking[] {
  const out: Marking[] = [];
  for (const m of markings) {
    let run: Vec2[] = [];
    for (const p of m.points) {
      if (inside(p)) run.push(p);
      else {
        if (run.length >= 2) out.push({ kind: m.kind, points: run });
        run = [];
      }
    }
    if (run.length >= 2) out.push({ kind: m.kind, points: run });
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
    // A short bridge spans straight between its ground ends. A long viaduct
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
      if (straight) {
        base = Math.max(
          za + (zb - za) * (total > 0 ? s / total : 0),
          grounds[k] + clearance * ramp,
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
    return { bridge, pts };
  });
  settleJoinedDecks(decks);
  spreadSplitDecks(decks);
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
  const ctx = { terrain, roadIndex, ground, deckSegs };
  for (const { bridge, pts } of decks) bridge.piers = placePiers(bridge, pts, ctx);
  return decks.map((d) => d.bridge);
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
