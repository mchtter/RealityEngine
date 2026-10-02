import {
  add,
  dist,
  lerp2,
  normalize,
  orientedBox,
  perp,
  polylineLength,
  samplePolyline,
  scale,
  sub,
} from './geo';
import type { SourcePoint } from './osm';
import { Rng } from './random';
import { isVehicular } from './roads';
import { GridIndex, type PolygonIndex, type RoadIndex } from './spatial';
import { terrainHeightAt } from './terrain';
import type {
  Building,
  Crossing,
  Junction,
  Prop,
  PropKind,
  Provenance,
  Road,
  TerrainGrid,
  Vec2,
} from './types';

export interface PropContext {
  terrain: TerrainGrid;
  roads: Road[];
  roadIndex: RoadIndex;
  buildings: PolygonIndex<Building>;
  junctions: Junction[];
  crossings: Crossing[];
}

const OBSERVED_KINDS: [(t: Record<string, string>) => boolean, PropKind][] = [
  [(t) => t.natural === 'tree', 'tree'],
  [(t) => t.highway === 'street_lamp', 'street-lamp'],
  [(t) => t.highway === 'traffic_signals', 'traffic-signal'],
  [(t) => t.highway === 'bus_stop' || t.public_transport === 'platform', 'bus-stop'],
  [(t) => t.amenity === 'bench', 'bench'],
  [(t) => t.amenity === 'waste_basket', 'waste-basket'],
  [(t) => t.power === 'pole' || t.power === 'tower', 'power-pole'],
];

/** Band around a ground-level vehicular centreline where nothing may stand (RoadIndex.covering). */
export const carriageReach = (r: Road): number =>
  r.grade === 'ground' && isVehicular(r.cls) ? r.width / 2 + 0.3 : 0;

/** Whole street corridor of a ground-level road: carriageway, sidewalks, paths. */
export const corridorReach = (r: Road): number =>
  r.grade === 'ground' ? r.width / 2 + r.sidewalk + 0.5 : 0;

/**
 * Horizontal radius (m) a ground prop occupies at scale 1 — the extent of the
 * renderer's models (apps/web …/dt/engine/props.ts): tree crowns ~2.3 m (pine
 * 2.4 m), bench 1.8 m. The 4 × 1.6 m bus shelter stands parallel to the kerb
 * (and so to the facades), so its half depth is what must clear a wall.
 * Building-mounted kinds are not resolved here (they belong to their building).
 */
export const PROP_RADIUS: Record<PropKind, number> = {
  tree: 2.4,
  'street-lamp': 0.25,
  'traffic-signal': 0.25,
  'bus-stop': 0.85,
  bench: 0.95,
  'waste-basket': 0.25,
  'power-pole': 0.3,
  chimney: 0,
  'solar-heater': 0,
  'satellite-dish': 0,
  'ac-unit': 0,
};

/** Trees are shrunk down to this scale to fit next to a wall before being dropped. */
const MIN_TREE_SCALE = 0.55;
/** Neighbouring tree crowns may interlock this much (share of the summed radii). */
const TREE_PAIR_FACTOR = 0.75;

const PLACEMENT_ORDER: Record<Provenance, number> = {
  observed: 0,
  suggested: 1,
  inferred: 2,
  synthetic: 3,
};

/**
 * Final placement pass: no ground prop may intersect a building or another
 * prop. Observed props are placed first, then suggestions, then generated
 * furniture, trees last. A tree that clips a wall is shrunk to fit (down to
 * MIN_TREE_SCALE). Generated props that still collide are dropped. Observed
 * props are kept where the data puts them unless they stand inside a
 * building (a data error), which drops them; both are counted.
 * Order is by a global key (provenance, kind, id), so neighbouring tiles make
 * the same choices for props in their shared margin.
 */
export function resolvePropPlacement(
  props: Prop[],
  buildings: PolygonIndex<Building>,
): { props: Prop[]; shrunk: Vec2[]; dropped: Vec2[] } {
  const kindOrder = (p: Prop) => (p.kind === 'tree' ? 1 : 0);
  const ground = props
    .filter((p) => !p.buildingId && PROP_RADIUS[p.kind] > 0)
    .sort(
      (a, b) =>
        PLACEMENT_ORDER[a.provenance] - PLACEMENT_ORDER[b.provenance] ||
        kindOrder(a) - kindOrder(b) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const placed = new GridIndex<{ p: Vec2; r: number; tree: boolean }>(8);
  const out: Prop[] = props.filter((p) => p.buildingId || PROP_RADIUS[p.kind] === 0);
  const shrunk: Vec2[] = [];
  const dropped: Vec2[] = [];
  for (const prop of ground) {
    const p: Vec2 = [prop.position[0], prop.position[1]];
    const tree = prop.kind === 'tree';
    let size = prop.scale;
    let r = PROP_RADIUS[prop.kind] * size;
    const observed = prop.provenance === 'observed';
    const wall = buildings.distanceTo(p, r);
    if (wall < r) {
      const fit = wall / PROP_RADIUS[prop.kind];
      if (tree && fit >= MIN_TREE_SCALE) {
        size = fit * 0.98;
        r = PROP_RADIUS[prop.kind] * size;
      } else if (!observed || wall === 0) {
        dropped.push(p);
        continue;
      }
    }
    const reach = r + PROP_RADIUS.tree * 1.3;
    const clash =
      !observed &&
      placed
        .query(p[0] - reach, p[1] - reach, p[0] + reach, p[1] + reach)
        .some((o) => dist(o.p, p) < (tree && o.tree ? TREE_PAIR_FACTOR : 1) * (o.r + r));
    if (clash) {
      dropped.push(p);
      continue;
    }
    placed.insert({ p, r, tree }, p[0], p[1], p[0], p[1]);
    if (size !== prop.scale) shrunk.push(p);
    out.push(size === prop.scale ? prop : { ...prop, scale: size });
  }
  return { props: out, shrunk, dropped };
}

const at = (ctx: PropContext, p: Vec2) => terrainHeightAt(ctx.terrain, p[0], p[1]);
const headingOf = (d: Vec2) => Math.atan2(d[1], d[0]);

/** Moves a point that sits on a carriageway to the kerb on the right-hand side. */
function toKerb(ctx: PropContext, p: Vec2): { p: Vec2; heading: number } {
  const hit = ctx.roadIndex.nearest(p, 12, (r) => isVehicular(r.cls) && r.grade === 'ground');
  if (!hit) return { p, heading: 0 };
  const right = scale(perp(hit.dir), -1);
  const off = hit.road.width / 2 + Math.max(0.6, hit.road.sidewalk * 0.4);
  const side = hit.d < hit.road.width / 2 ? right : normalize(sub(p, hit.point));
  const q = add(hit.point, scale(side, off));
  // Face the road.
  return { p: q, heading: headingOf(scale(side, -1)) };
}

export function observedProps(points: SourcePoint[], ctx: PropContext): Prop[] {
  const out: Prop[] = [];
  for (const pt of points) {
    const kind = OBSERVED_KINDS.find(([test]) => test(pt.tags))?.[1];
    if (!kind) continue;
    let p = pt.p;
    let heading = 0;
    if (
      kind === 'bus-stop' ||
      kind === 'traffic-signal' ||
      kind === 'street-lamp' ||
      // Mapped trees, benches, poles … that sit on a carriageway (mapping
      // offset): moved to the kerb instead of standing in the traffic.
      ctx.roadIndex.covering(pt.p, carriageReach) !== null
    ) {
      const k = toKerb(ctx, pt.p);
      p = k.p;
      heading = k.heading;
    }
    out.push({
      id: `p:${pt.ref}`,
      kind,
      position: [p[0], p[1], at(ctx, p)],
      heading,
      scale: 1,
      provenance: 'observed',
    });
  }
  return out;
}

function nearJunction(ctx: PropContext, p: Vec2, extra: number): boolean {
  return ctx.junctions.some((j) => dist(j.center, p) < j.radius + extra);
}

/**
 * Street lamps every ~30 m along streets (both sides, staggered on wide
 * roads) and street trees on generous sidewalks — only where the data has
 * none nearby. Everything here is `synthetic`.
 */
export function decorateStreets(ctx: PropContext, existing: Prop[]): Prop[] {
  const out: Prop[] = [];
  const observedLamps = existing.filter((p) => p.kind === 'street-lamp');
  const blocked = (p: Vec2, clearance: number) =>
    ctx.buildings.at(p) !== null ||
    at(ctx, p) < ctx.terrain.seaLevel + 0.5 ||
    ctx.crossings.some((c) => dist(c.center, p) < clearance + c.length / 2);

  for (const road of ctx.roads) {
    if (!road.formsBlocks || !isVehicular(road.cls) || road.sidewalk <= 0) continue;
    const length = polylineLength(road.centerline);
    const rng = new Rng(`${road.id}-deco`);
    const both = road.width >= 9;
    const spacing = road.cls === 'residential' ? 34 : 30;
    for (const s of samplePolyline(road.centerline, spacing, rng.range(5, 15))) {
      if (s.at > length - 5) break;
      const sides = both ? [1, -1] : [s.at % (spacing * 2) < spacing ? 1 : -1];
      for (const side of sides) {
        const n = scale(perp(s.dir), side);
        const along = both && side < 0 ? spacing / 2 : 0;
        const base = add(s.point, scale(s.dir, along));
        const p = add(base, scale(n, road.width / 2 + 0.45));
        if (nearJunction(ctx, p, 3) || blocked(p, 2)) continue;
        if (observedLamps.some((l) => dist([l.position[0], l.position[1]], p) < 15)) continue;
        out.push({
          id: `l${road.id}_${Math.round(s.at)}_${side}`,
          kind: 'street-lamp',
          position: [p[0], p[1], at(ctx, p) + 0.15],
          heading: headingOf(scale(n, -1)),
          scale: 1,
          provenance: 'synthetic',
        });
      }
    }

    if (
      road.sidewalk >= 1.8 &&
      ['secondary', 'tertiary', 'residential', 'primary'].includes(road.cls)
    ) {
      for (const s of samplePolyline(road.centerline, 11, rng.range(3, 9))) {
        if (!rng.chance(0.7)) continue;
        for (const side of [1, -1]) {
          const n = scale(perp(s.dir), side);
          const p = add(s.point, scale(n, road.width / 2 + road.sidewalk * 0.62));
          if (nearJunction(ctx, p, 6) || blocked(p, 4)) continue;
          if (
            out.some((o) => o.kind === 'street-lamp' && dist([o.position[0], o.position[1]], p) < 4)
          )
            continue;
          out.push({
            id: `t${road.id}_${Math.round(s.at)}_${side}`,
            kind: 'tree',
            position: [p[0], p[1], at(ctx, p) + 0.15],
            heading: rng.range(0, Math.PI * 2),
            scale: rng.range(0.75, 1.15),
            provenance: 'synthetic',
          });
        }
      }
    }
  }
  return out;
}

/**
 * Bus stop coverage: along trunk / primary / secondary roads, every point
 * should be within `radius` metres of a stop. Uncovered stretches get a
 * greedy set of suggested stops, each with the distance to the nearest real one.
 */
export function suggestBusStops(
  ctx: PropContext,
  existing: Prop[],
  inArea: (p: Vec2) => boolean,
  radius = 300,
  maxSuggestions = 6,
): Prop[] {
  const stops = existing
    .filter((p) => p.kind === 'bus-stop')
    .map((p): Vec2 => [p.position[0], p.position[1]]);
  const samples: { p: Vec2; road: Road; dir: Vec2 }[] = [];
  for (const road of ctx.roads) {
    if (!['trunk', 'primary', 'secondary'].includes(road.cls) || road.grade !== 'ground') continue;
    for (const s of samplePolyline(road.centerline, 40, 20)) {
      if (!inArea(s.point) || at(ctx, s.point) < ctx.terrain.seaLevel + 0.5) continue;
      samples.push({ p: s.point, road, dir: s.dir });
    }
  }
  const covered = (p: Vec2, list: Vec2[]) => list.some((s) => dist(s, p) <= radius);
  let uncovered = samples.filter((s) => !covered(s.p, stops));
  const out: Prop[] = [];
  const chosen: Vec2[] = [];
  while (uncovered.length && out.length < maxSuggestions) {
    let best = { idx: -1, gain: 0 };
    uncovered.forEach((cand, idx) => {
      if (nearJunction(ctx, cand.p, 15)) return;
      const gain = uncovered.filter((u) => dist(u.p, cand.p) <= radius).length;
      if (gain > best.gain) best = { idx, gain };
    });
    if (best.idx < 0) break;
    const cand = uncovered[best.idx];
    const right = scale(perp(cand.dir), -1);
    const kerb = add(
      cand.p,
      scale(right, cand.road.width / 2 + Math.max(0.8, cand.road.sidewalk * 0.5)),
    );
    // Prefer the right-hand kerb; use the other side when the right one is not dry land.
    const other = add(
      cand.p,
      scale(right, -(cand.road.width / 2 + Math.max(0.8, cand.road.sidewalk * 0.5))),
    );
    const land = (q: Vec2) =>
      inArea(q) && at(ctx, q) > ctx.terrain.seaLevel + 0.8 && ctx.buildings.at(q) === null;
    const p = land(kerb) ? kerb : land(other) ? other : null;
    if (!p) {
      uncovered.splice(best.idx, 1);
      continue;
    }
    const facing = p === kerb ? right : scale(right, -1);
    const nearestReal = stops.length ? Math.min(...stops.map((s) => dist(s, cand.p))) : Infinity;
    chosen.push(cand.p);
    out.push({
      id: `sug-stop-${out.length + 1}`,
      kind: 'bus-stop',
      position: [p[0], p[1], at(ctx, p) + 0.15],
      heading: headingOf(scale(facing, -1)),
      scale: 1,
      provenance: 'suggested',
      reason: Number.isFinite(nearestReal)
        ? `${cand.road.name ?? 'Bu cadde'} üzerinde en yakın durak ${Math.round(nearestReal)} m uzakta; ${radius} m yürüme mesafesinde durak yok.`
        : `${cand.road.name ?? 'Bu cadde'} üzerinde ${radius} m yürüme mesafesinde hiç durak yok.`,
    });
    uncovered = uncovered.filter((u) => !covered(u.p, chosen));
  }
  return out;
}

/**
 * Roof and wall clutter that makes Anatolian buildings read right: chimneys
 * on pitched roofs, solar water heaters, satellite dishes, split-AC units on
 * the walls. Always synthetic; renderers draw them as part of the building.
 */
export function buildingDetails(buildings: Building[]): Prop[] {
  const out: Prop[] = [];
  for (const b of buildings) {
    if (b.area < 30) continue;
    const rng = new Rng(b.seed + 17);
    const box = orientedBox(b.footprint.outer);
    const nrm = perp(box.axis);
    const roofTop =
      b.topZ +
      (b.roof.shape === 'flat'
        ? 0
        : Math.tan((b.roof.pitchDeg * Math.PI) / 180) * box.halfWidth * 0.55);
    const onRoof = (u: number, v: number): Vec2 =>
      add(box.center, add(scale(box.axis, u * box.halfLength), scale(nrm, v * box.halfWidth)));
    const push = (kind: PropKind, p: Vec2, z: number, heading: number, s = 1) =>
      out.push({
        id: `${b.id}-${kind}-${out.length}`,
        kind,
        position: [p[0], p[1], z],
        heading,
        scale: s,
        provenance: 'synthetic',
        buildingId: b.id,
      });

    if (b.archetype !== 'modern' && b.archetype !== 'yuksek') {
      const chimneys = b.archetype === 'mustakil' ? rng.int(1, 2) : rng.int(2, 4);
      for (let k = 0; k < chimneys; k++) {
        push(
          'chimney',
          onRoof(rng.range(-0.7, 0.7), rng.range(-0.2, 0.2)),
          roofTop - 0.3,
          headingOf(box.axis),
        );
      }
    }
    if (rng.chance(b.archetype === 'yuksek' ? 0.2 : 0.45)) {
      const heaters = rng.int(1, Math.min(4, Math.max(1, b.levels - 1)));
      for (let k = 0; k < heaters; k++) {
        const u = -0.6 + (1.2 * (k + 0.5)) / heaters;
        push(
          'solar-heater',
          onRoof(u, rng.range(-0.4, 0.1)),
          b.roof.shape === 'flat' ? b.topZ : roofTop - 0.6,
          headingOf(nrm),
        );
      }
    }
    if (rng.chance(0.55)) {
      push(
        'satellite-dish',
        onRoof(rng.range(-0.6, 0.6), rng.range(0.2, 0.5)),
        b.roof.shape === 'flat' ? b.topZ : roofTop - 0.8,
        rng.range(0, Math.PI * 2),
      );
    }

    // Split AC units next to windows on non-front walls and some front bays.
    const ring = b.footprint.outer;
    for (const f of b.facades) {
      if (!f.bays.length || b.levels < 2) continue;
      const a = ring[f.edge];
      const c = ring[(f.edge + 1) % ring.length];
      const dir = normalize(sub(c, a));
      const out3 = scale(perp(dir), -1);
      for (let floor = 1; floor < b.levels; floor++) {
        for (let i = 0; i < f.bays.length; i++) {
          if (f.bays[i] !== 'window' || !rng.chance(f.front ? 0.12 : 0.2)) continue;
          const t = (i + 0.5) / f.bays.length + (b.windowWidth / 2 + 0.45) / f.length;
          if (t > 0.97) continue;
          const p = add(lerp2(a, c, t), scale(out3, 0.18));
          const z = b.floorZ + b.groundFloorHeight + (floor - 1) * b.floorHeight + 0.9;
          push('ac-unit', p, z, headingOf(out3));
        }
      }
    }
  }
  return out;
}
