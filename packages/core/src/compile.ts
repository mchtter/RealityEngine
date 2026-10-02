import { buildBlocks, infillAlongRoads, observedCoverage, regionRect, scatter } from './blocks';
import { layoutFacades, makeBuilding, placeObservedBuildings } from './buildings';
import { LocalProjection, dist, polylineLength, ringCentroid } from './geo';
import { type SourceFeatures, mergeFeatures, readFeatures, readOsm } from './osm';
import { bufferPolyline, difference, intersection, offset, union } from './poly';
import {
  buildingDetails,
  carriageReach,
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
  buildSurfaces,
  classifyRoads,
  findJunctions,
  isVehicular,
} from './roads';
import { PolygonIndex, RoadIndex } from './spatial';
import { buildTerrain, conformTerrainToRoads, terrainHeightAt } from './terrain';
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
} from './types';

/**
 * Bump whenever compiled output changes for the same input: cached city tiles
 * carry this in their source version and are rebuilt on the next request.
 */
export const COMPILER_VERSION = '9';

/** Area kinds where no synthetic building may be placed. */
const NO_BUILD: AreaKind[] = [
  'park',
  'grass',
  'forest',
  'water',
  'parking',
  'school',
  'religious',
  'plaza',
];

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

const EMPTY: SourceFeatures = { roads: [], buildings: [], points: [], areas: [] };

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
  const roadCovered = authorityCoverage(
    features.roads.filter((r) => r.authoritative).map((r) => ({ points: r.points, area: false })),
    g,
    ROAD_COVER_REACH,
  );
  const sourceRoads = features.roads.filter(
    (r) => r.authoritative || !roadCovered(r.points[Math.floor(r.points.length / 2)]),
  );
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
  conformTerrainToRoads(
    terrain,
    roads
      .filter((r) => r.grade === 'ground' && (isVehicular(r.cls) || r.cls === 'pedestrian'))
      .map((r) => ({ points: r.centerline, halfWidth: r.width / 2 + r.sidewalk })),
  );

  // Road network.
  const signals = features.points.filter((p) => p.tags.highway === 'traffic_signals');
  const junctions = findJunctions(sourceRoads, roads, signals, g);
  const net = buildSurfaces(roads, [regionPoly]);
  const markings = clipMarkings(buildMarkings(roads, junctions), inRegion);
  const crossings = buildCrossings(roads, junctions, features.points).filter((c) =>
    inRegion(c.center),
  );
  const roadIndex = new RoadIndex(roads);

  const areas: Area[] = features.areas.flatMap((a) =>
    intersection(a.polygons, [regionPoly]).map((polygon, i) => ({
      id: `a:${a.ref}${i ? `-${i}` : ''}`,
      kind: a.kind,
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
  const { blocks, islands } = buildBlocks(regionPoly, net.corridor, roadIndex, g);
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

  for (const block of blocks) block.observedCoverage = observedCoverage(block, observed);
  const synthetic: Building[] = [];
  if (infill) {
    const lots = infillAlongRoads(blocks, roads, {
      terrain,
      blocked: noBuild,
      globalOffset: g,
      region,
    });
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
      ),
    );
  }
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

  let bridges = buildBridges(roads, terrain);
  // Paved / gravel yards around buildings; the rest of each block stays green.
  const yards = difference(
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

  let outTerrain = terrain;
  let outSurfaces = [
    ...net.surfaces,
    { kind: 'island' as const, polygons: islands },
    { kind: 'yard' as const, polygons: yards },
  ];
  let outMarkings = markings;
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
      polygons: intersection(sf.polygons, [corePoly]),
    }));
    outMarkings = clipMarkings(markings, inCore);
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
    bridges = bridges.filter((br) =>
      inCore([br.path[br.path.length >> 1][0], br.path[br.path.length >> 1][1]]),
    );
    outTerrain = cropTerrain(terrain, core);
  }

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
    crossings: outCrossings,
    junctions: outJunctions,
    bridges,
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
): Prop[] {
  const out: Prop[] = [];
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
      scatter(a.polygon, spacing, a.id, (q) => buildings.at(q) !== null || !land(q)),
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
      scatter(g, 14, `garden-${key}`, (q) => buildings.at(q) !== null || !land(q)),
      `yard${key}`,
      [0.7, 1.1],
    );
  }
  return out;
}

/** Bridge decks: straight grade between the ends, lifted over the terrain in between. */
function buildBridges(roads: Road[], terrain: CityModel['terrain']): Bridge[] {
  return roads
    .filter((r) => r.grade === 'bridge')
    .map((r) => {
      const pts = r.centerline;
      const total = polylineLength(pts);
      const za = terrainHeightAt(terrain, pts[0][0], pts[0][1]);
      const zb = terrainHeightAt(terrain, pts[pts.length - 1][0], pts[pts.length - 1][1]);
      const clearance = 5.5 * Math.max(1, r.layer);
      let walked = 0;
      const path: Vec3[] = pts.map((p, k) => {
        if (k > 0) walked += dist(pts[k - 1], p);
        const t = total > 0 ? walked / total : 0;
        const ramp = Math.min(1, Math.min(walked, total - walked) / 25 || 0);
        const ground = terrainHeightAt(terrain, p[0], p[1]);
        return [p[0], p[1], Math.max(za + (zb - za) * t, ground + clearance * ramp)];
      });
      return {
        id: `br${r.id}`,
        roadId: r.id,
        path,
        width: r.width + 2 * Math.min(r.sidewalk, 1.5),
      };
    });
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
