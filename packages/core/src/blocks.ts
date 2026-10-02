import {
  add,
  dist,
  normalize,
  perp,
  polylineLength,
  ringArea,
  ringCentroid,
  scale,
  sub,
} from './geo';
import { Occupancy } from './occupancy';
import { difference, intersection, offset, polygonArea, rect, totalArea, union } from './poly';
import { Rng } from './random';
import { PolygonIndex, type RoadIndex, ringBounds } from './spatial';
import { terrainHeightAt } from './terrain';
import type { Building, CityBlock, Polygon, Road, RoadClass, TerrainGrid, Vec2 } from './types';

const CLASS_RANK: RoadClass[] = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'pedestrian',
  'residential',
  'unclassified',
  'living_street',
];

/**
 * City blocks are the land left between block-forming roads (carriageway +
 * sidewalks). Thin leftovers (medians, slivers between parallel carriageways)
 * are returned separately as traffic islands.
 */
export function buildBlocks(
  region: Polygon,
  corridor: Polygon[],
  roads: RoadIndex,
  globalOffset: Vec2 = [0, 0],
): { blocks: CityBlock[]; islands: Polygon[] } {
  const pieces = difference([region], corridor);
  const blocks: CityBlock[] = [];
  const islands: Polygon[] = [];
  for (const p of pieces) {
    const area = polygonArea(p);
    const perimeter = p.outer.reduce(
      (s, q, k) => s + dist(q, p.outer[(k + 1) % p.outer.length]),
      0,
    );
    if (area < 40 || area / perimeter < 2) {
      if (area > 2) islands.push(p);
      continue;
    }
    const frontage = new Set<RoadClass>();
    for (const q of p.outer) {
      const hit = roads.nearest(q, 20, (r: Road) => r.formsBlocks);
      if (hit) frontage.add(hit.road.cls);
    }
    const c = ringCentroid(p.outer);
    blocks.push({
      // Global coordinates: the same block gets the same id (and seed) in every tile.
      id: `k${Math.round(c[0] + globalOffset[0])}_${Math.round(c[1] + globalOffset[1])}`,
      polygon: p,
      area,
      frontage: CLASS_RANK.filter((cls) => frontage.has(cls)),
      observedCoverage: 0,
      syntheticBuildings: 0,
    });
  }
  return { blocks, islands };
}

export interface InfillContext {
  terrain: TerrainGrid;
  /** Areas where nothing may be built (existing buildings buffered, parks, water, paths). */
  blocked: Polygon[];
  /** Model → frame-global offset for tile-independent lot ids. */
  globalOffset?: Vec2;
  /** Compile region; lots are generated inside it. */
  region: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface InfillLot {
  id: string;
  footprint: Polygon;
  levels: number;
  blockId: string | null;
}

const RANK = (cls: RoadClass) => {
  const i = CLASS_RANK.indexOf(cls);
  return i < 0 ? CLASS_RANK.length : i;
};

function ccw(p: Polygon): Polygon {
  return ringArea(p.outer) >= 0 ? p : { outer: [...p.outer].reverse(), holes: p.holes };
}

/**
 * Fills city blocks with perimeter buildings the way Turkish streets are
 * built: apartments along both sides of every street, a second row behind
 * a small courtyard where blocks are deep, gardens in between.
 *
 * Lots are generated per street side, seeded by the street's stable ref and
 * processed in a fixed global order, and tested against one occupancy raster
 * of the whole region. Because streets arrive with their full geometry in
 * every tile, two neighbouring tiles generate identical lots along their
 * common edge — no seams, no duplicates (block-ring based generation broke
 * this for blocks larger than the tile margin; seen 2026-10-01).
 */
export function infillAlongRoads(
  blocks: CityBlock[],
  roads: Road[],
  ctx: InfillContext,
): InfillLot[] {
  const { region } = ctx;
  const [gx, gy] = ctx.globalOffset ?? [0, 0];
  const occ = new Occupancy(region.minX, region.minY, region.maxX, region.maxY);
  // Free = inside a block (shrunk half a cell) and outside every obstacle.
  occ.fill(
    offset(
      blocks.map((b) => b.polygon),
      -0.35,
    ),
    1,
  );
  occ.fill(ctx.blocked, 0);

  const blockIndex = new PolygonIndex<CityBlock>();
  for (const b of blocks) blockIndex.add(b, b.polygon);
  const lots: InfillLot[] = [];
  const taken: { poly: Polygon; box: [number, number, number, number] }[] = [];

  const streets = roads
    .filter((r) => r.formsBlocks)
    .sort((a, b) => RANK(a.cls) - RANK(b.cls) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

  /**
   * Lot slots along one street side. Slot geometry is drawn from the street's
   * own seed *before* any occupancy test, so it is identical in every tile;
   * whether a slot is built then depends only on local occupancy.
   */
  interface Slot {
    at: number;
    width: number;
    depth: number;
    gap: number;
    courtyard: number;
    backDepth: number;
    levels: number;
  }
  const slotsFor = (road: Road, side: 1 | -1) => {
    const rng = new Rng(`${road.ref}:${side}`);
    const dense =
      ['trunk', 'primary', 'secondary', 'tertiary', 'pedestrian'].includes(road.cls) ||
      rng.chance(0.55);
    const setback = dense ? rng.range(0.3, 1.2) : rng.range(2, 4.5);
    const total = polylineLength(road.centerline);
    const slots: Slot[] = [];
    let at = rng.range(0.5, 3);
    while (at < total - 7) {
      const width = Math.min(rng.range(dense ? 11 : 9, dense ? 20 : 15), total - at);
      const depth = rng.range(dense ? 11 : 9, dense ? 17 : 13);
      const gap = dense && rng.chance(0.7) ? 0 : rng.range(2.5, 5);
      const slot = {
        at,
        width,
        depth,
        gap,
        courtyard: rng.range(6, 10),
        backDepth: rng.range(dense ? 11 : 9, dense ? 16 : 12),
        levels: dense ? rng.int(4, 8) : rng.int(2, 5),
      };
      if (width >= 7) slots.push(slot);
      at += width + gap;
    }
    return { slots, setback };
  };

  const tryLot = (
    road: Road,
    side: 1 | -1,
    at: number,
    width: number,
    depth: number,
    front: number,
  ) => {
    const hit = pointAt(road.centerline, at);
    if (!hit) return null;
    const along: Vec2 = side > 0 ? hit.dir : scale(hit.dir, -1);
    const inward = scale(perp(hit.dir), side);
    const base = add(hit.p, scale(inward, front));
    const p0 = side > 0 ? base : add(base, scale(along, -width));
    const lot = ccw({
      outer: [
        p0,
        add(p0, scale(along, width)),
        add(add(p0, scale(along, width)), scale(inward, depth)),
        add(p0, scale(inward, depth)),
      ],
      holes: [],
    });
    const lotArea = width * depth;
    const share = occ.freeShare(p0, along, inward, width, depth);
    let footprint: Polygon | null = null;
    if (share >= 0.995) {
      footprint = lot;
    } else if (share * lotArea >= 60 && share >= 0.72) {
      const block = blockIndex.at(ringCentroid(lot.outer));
      if (block) {
        const [lx0, ly0, lx1, ly1] = ringBounds(lot.outer);
        const hits = (b: [number, number, number, number]) =>
          b[2] >= lx0 && b[0] <= lx1 && b[3] >= ly0 && b[1] <= ly1;
        const obstacles = [
          ...ctx.blocked.filter((p) => hits(ringBounds(p.outer))),
          ...taken.filter((t) => hits(t.box)).map((t) => t.poly),
        ];
        const pieces = difference(intersection([lot], [block.polygon]), obstacles);
        const clipped = pieces.sort((x, y) => polygonArea(y) - polygonArea(x))[0];
        if (clipped && polygonArea(clipped) >= Math.max(60, lotArea * 0.72)) footprint = clipped;
      }
    }
    return footprint && onLand(footprint, ctx.terrain) ? { footprint, p0 } : null;
  };

  const place = (
    road: Road,
    side: 1 | -1,
    slot: Slot,
    row: number,
    front: number,
    depth: number,
  ) => {
    // Whole slot first, then two narrower deterministic variants (slot start / end).
    const variants: [number, number][] = [
      [slot.at, slot.width],
      [slot.at, slot.width * 0.6],
      [slot.at + slot.width * 0.4, slot.width * 0.6],
    ];
    for (const [at, width] of variants) {
      if (width < 7) continue;
      const got = tryLot(road, side, at, width, depth, front);
      if (!got) continue;
      const c = ringCentroid(got.footprint.outer);
      lots.push({
        id: `s${Math.round(got.p0[0] + gx)}_${Math.round(got.p0[1] + gy)}_${row}`,
        footprint: got.footprint,
        levels: slot.levels,
        blockId: blockIndex.at(c)?.id ?? null,
      });
      for (const poly of offset([got.footprint], slot.gap > 0 ? slot.gap : 0.05)) {
        taken.push({ poly, box: ringBounds(poly.outer) });
        occ.fill([poly], 2, 1);
      }
      return;
    }
  };

  for (const road of streets) {
    for (const side of [1, -1] as const) {
      const { slots, setback } = slotsFor(road, side);
      const front = road.width / 2 + road.sidewalk + setback;
      for (const slot of slots) place(road, side, slot, 0, front, slot.depth);
      // Deep blocks: a second row behind a small courtyard.
      for (const slot of slots)
        place(road, side, slot, 1, front + slot.depth + slot.courtyard, slot.backDepth);
    }
  }
  return lots;
}

/** Point and unit tangent `at` metres along a polyline. */
function pointAt(points: Vec2[], at: number): { p: Vec2; dir: Vec2 } | null {
  let walked = 0;
  for (let k = 1; k < points.length; k++) {
    const l = dist(points[k - 1], points[k]);
    if (l > 1e-6 && walked + l >= at) {
      const t = (at - walked) / l;
      return {
        p: add(points[k - 1], scale(sub(points[k], points[k - 1]), t)),
        dir: normalize(sub(points[k], points[k - 1])),
      };
    }
    walked += l;
  }
  return null;
}

/** Keeps synthetic lots out of the sea and off cliffs. */
function onLand(p: Polygon, t: TerrainGrid): boolean {
  const hs = p.outer.map((q) => terrainHeightAt(t, q[0], q[1]));
  return Math.min(...hs) > t.seaLevel + 1.2 && Math.max(...hs) - Math.min(...hs) < 14;
}

/** Share of the block covered by observed buildings. */
export function observedCoverage(block: CityBlock, observed: Building[]): number {
  const covered = totalArea(intersection([block.polygon], union(observed.map((b) => b.footprint))));
  return block.area > 0 ? covered / block.area : 0;
}

export function regionRect(bounds: {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}): Polygon {
  return rect(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
}

/** Random points inside a polygon (rejection sampling), deterministic by seed. */
export function scatter(
  p: Polygon,
  spacing: number,
  seed: string,
  keepOut: (q: Vec2) => boolean,
): Vec2[] {
  const rng = new Rng(seed);
  const area = polygonArea(p);
  const target = Math.floor(area / (spacing * spacing));
  if (target <= 0) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of p.outer) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const out: Vec2[] = [];
  const inside = (q: Vec2) => {
    const hit = (ring: Vec2[]) => {
      let c = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        if (
          ring[i][1] > q[1] !== ring[j][1] > q[1] &&
          q[0] <
            ((ring[j][0] - ring[i][0]) * (q[1] - ring[i][1])) / (ring[j][1] - ring[i][1]) +
              ring[i][0]
        )
          c = !c;
      }
      return c;
    };
    return hit(p.outer) && !p.holes.some(hit);
  };
  for (let tries = 0; tries < target * 12 && out.length < target; tries++) {
    const q: Vec2 = [rng.range(minX, maxX), rng.range(minY, maxY)];
    if (!inside(q) || keepOut(q)) continue;
    if (out.some((o) => dist(o, q) < spacing * 0.6)) continue;
    out.push(q);
  }
  return out;
}
