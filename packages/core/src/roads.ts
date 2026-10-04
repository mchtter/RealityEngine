import { add, closestOnSegment, dist, normalize, perp, polylineLength, scale, sub } from './geo';
import type { SourcePoint, SourceRoad } from './osm';
import { bufferPolylinePaths, clean, difference, intersection, union, unionPaths } from './poly';
import { RoadIndex } from './spatial';
import type {
  Crossing,
  Grade,
  Junction,
  Marking,
  Polygon,
  Provenance,
  Road,
  RoadClass,
  Surface,
  Vec2,
} from './types';

interface ClassSpec {
  /** Default total lanes for a two-way road. */
  lanes: number;
  laneWidth: number;
  sidewalk: number;
  formsBlocks: boolean;
  vehicular: boolean;
}

const SPECS: Record<RoadClass, ClassSpec> = {
  motorway: { lanes: 4, laneWidth: 3.5, sidewalk: 0, formsBlocks: true, vehicular: true },
  trunk: { lanes: 4, laneWidth: 3.3, sidewalk: 2.2, formsBlocks: true, vehicular: true },
  primary: { lanes: 2, laneWidth: 3.3, sidewalk: 2.2, formsBlocks: true, vehicular: true },
  secondary: { lanes: 2, laneWidth: 3.2, sidewalk: 2, formsBlocks: true, vehicular: true },
  tertiary: { lanes: 2, laneWidth: 3.1, sidewalk: 1.8, formsBlocks: true, vehicular: true },
  residential: { lanes: 2, laneWidth: 2.9, sidewalk: 1.5, formsBlocks: true, vehicular: true },
  unclassified: { lanes: 2, laneWidth: 2.9, sidewalk: 1.2, formsBlocks: true, vehicular: true },
  living_street: { lanes: 1, laneWidth: 4.5, sidewalk: 0, formsBlocks: true, vehicular: true },
  pedestrian: { lanes: 1, laneWidth: 6, sidewalk: 0, formsBlocks: true, vehicular: false },
  service: { lanes: 1, laneWidth: 3.6, sidewalk: 0, formsBlocks: false, vehicular: true },
  track: { lanes: 1, laneWidth: 3, sidewalk: 0, formsBlocks: false, vehicular: true },
  footway: { lanes: 1, laneWidth: 2, sidewalk: 0, formsBlocks: false, vehicular: false },
  steps: { lanes: 1, laneWidth: 2, sidewalk: 0, formsBlocks: false, vehicular: false },
  cycleway: { lanes: 1, laneWidth: 2, sidewalk: 0, formsBlocks: false, vehicular: false },
};

export function roadClassOf(highway: string): RoadClass | null {
  const base = highway.replace(/_link$/, '');
  if (base in SPECS) return base as RoadClass;
  if (highway === 'path' || highway === 'bridleway' || highway === 'corridor') return 'footway';
  if (highway === 'road') return 'unclassified';
  if (highway === 'busway') return 'service';
  return null;
}

export const isVehicular = (cls: RoadClass) => SPECS[cls].vehicular;

/** Inserts vertices so no segment is longer than `maxStep` metres. */
export function densify(points: Vec2[], maxStep: number): Vec2[] {
  const out: Vec2[] = [points[0]];
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1];
    const b = points[k];
    const n = Math.ceil(dist(a, b) / maxStep);
    for (let s = 1; s <= n; s++)
      out.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
  }
  return out;
}

export function classifyRoads(source: SourceRoad[]): Road[] {
  const roads: Road[] = [];
  for (const r of source) {
    const cls = roadClassOf(r.tags.highway);
    if (!cls || r.points.length < 2) continue;
    const spec = SPECS[cls];
    const oneway =
      r.tags.oneway === 'yes' ||
      r.tags.oneway === '1' ||
      r.tags.junction === 'roundabout' ||
      cls === 'motorway';
    const tagLanes = Number.parseInt(r.tags.lanes ?? '', 10);
    const lanes =
      Number.isFinite(tagLanes) && tagLanes > 0
        ? tagLanes
        : oneway
          ? Math.max(1, Math.ceil(spec.lanes / 2))
          : spec.lanes;
    const tagWidth = Number.parseFloat(r.tags.width ?? '');
    const width = Number.isFinite(tagWidth) && tagWidth > 1 ? tagWidth : lanes * spec.laneWidth;
    const sidewalkTag = r.tags.sidewalk;
    const sidewalk = sidewalkTag === 'no' || sidewalkTag === 'none' ? 0 : spec.sidewalk;
    const grade: Grade =
      r.tags.bridge && r.tags.bridge !== 'no'
        ? 'bridge'
        : r.tags.tunnel && r.tags.tunnel !== 'no'
          ? 'tunnel'
          : 'ground';
    const layer = Number.parseInt(r.tags.layer ?? '0', 10) || 0;
    roads.push({
      id: `r:${r.ref}`,
      osmId: r.osmId,
      ref: r.ref,
      name: r.tags.name,
      cls,
      grade,
      layer,
      centerline: densify(r.points, 8),
      width,
      sidewalk,
      lanes,
      oneway,
      formsBlocks: spec.formsBlocks && grade === 'ground' && r.tags.area !== 'yes',
      ...(r.tags.junction === 'roundabout' || r.tags.junction === 'circular'
        ? { roundabout: true }
        : {}),
      provenance: {
        width: Number.isFinite(tagWidth) ? 'observed' : 'inferred',
        lanes: Number.isFinite(tagLanes) ? 'observed' : 'inferred',
      },
    });
  }
  return roads;
}

// ─── Topology ────────────────────────────────────────────────────────────────

/**
 * Junctions are shared vertices where three or more at-grade road arms meet.
 * Vertices are matched by coordinate (to the centimetre), so this works for
 * OSM ways (shared nodes) and for sources without node ids (MAKS road axes).
 * The radius covers the widest arm so markings stop at the junction mouth.
 */
export function findJunctions(
  source: SourceRoad[],
  roads: Road[],
  signals: SourcePoint[],
  globalOffset: Vec2 = [0, 0],
): Junction[] {
  const byRef = new Map(roads.map((r) => [r.ref, r]));
  const keyOf = (p: Vec2) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
  const arms = new Map<string, { road: Road; p: Vec2 }[]>();
  for (const s of source) {
    const road = byRef.get(s.ref);
    if (!road || road.grade !== 'ground' || (!isVehicular(road.cls) && road.cls !== 'pedestrian'))
      continue;
    s.points.forEach((p, k) => {
      const count = k === 0 || k === s.points.length - 1 ? 1 : 2;
      const key = keyOf(p);
      const list = arms.get(key) ?? [];
      for (let c = 0; c < count; c++) list.push({ road, p });
      arms.set(key, list);
    });
  }
  const junctions: Junction[] = [];
  for (const list of arms.values()) {
    if (list.length < 3) continue;
    const roadsHere = [...new Set(list.map((a) => a.road))];
    const center = list[0].p;
    const radius = Math.max(...roadsHere.map((r) => r.width / 2)) + 1.5;
    junctions.push({
      id: `j${Math.round(center[0] + globalOffset[0])}_${Math.round(center[1] + globalOffset[1])}`,
      center,
      radius,
      roadIds: roadsHere.map((r) => r.id),
      signalised: signals.some((s) => dist(s.p, center) < radius + 12),
    });
  }
  return junctions;
}

// ─── Surfaces ────────────────────────────────────────────────────────────────

export interface RoadSurfaces {
  surfaces: Surface[];
  /** Carriageway of vehicular ground roads (hard constraint for buildings). */
  carriageway: Polygon[];
  /** Carriageway + sidewalks of block-forming roads (city block cutter). */
  corridor: Polygon[];
  /**
   * Where two corridor roads meet end to end with sidewalks of different
   * width, the narrower one widens to the other over its first metres (no
   * step in the kerb line); these pieces are street fill (see RoadSurface).
   */
  tapers: Polygon[];
}

/** Length (m) over which a sidewalk width step is eased. */
const TAPER = 12;

function kerbTapers(roads: Road[]): Polygon[] {
  const key = (p: Vec2) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;
  const ends = new Map<string, { road: Road; start: boolean }[]>();
  for (const r of roads) {
    const c = r.centerline;
    for (const [p, start] of [
      [c[0], true],
      [c[c.length - 1], false],
    ] as [Vec2, boolean][]) {
      const k = key(p);
      ends.set(k, [...(ends.get(k) ?? []), { road: r, start }]);
    }
  }
  const out: Polygon[] = [];
  for (const list of ends.values()) {
    if (list.length !== 2) continue;
    const half = (r: Road) => r.width / 2 + r.sidewalk;
    const [a, b] = list;
    if (Math.abs(half(a.road) - half(b.road)) <= 0.3) continue;
    const [wide, narrow] = half(a.road) > half(b.road) ? [a, b] : [b, a];
    const c = narrow.start ? narrow.road.centerline : [...narrow.road.centerline].reverse();
    const len = Math.min(TAPER, polylineLength(c) / 2);
    if (len < 2) continue;
    const w0 = half(wide.road);
    const w1 = half(narrow.road);
    const left: Vec2[] = [];
    const right: Vec2[] = [];
    let walked = 0;
    for (let k = 0; k < c.length - 1 && walked <= len; k++) {
      const p0 = c[k];
      const p1 = c[k + 1];
      const seg = dist(p0, p1);
      if (seg < 1e-6) continue;
      const d = normalize(sub(p1, p0));
      const n = perp(d);
      for (let s = 0; s < seg && walked + s <= len; s += 1) {
        const x = (walked + s) / len;
        const h = w1 + (w0 - w1) * (1 - x * x * (3 - 2 * x));
        const p = add(p0, scale(d, s));
        left.push(add(p, scale(n, h)));
        right.push(add(p, scale(n, -h)));
      }
      walked += seg;
    }
    if (left.length < 2) continue;
    out.push({ outer: [...left, ...right.reverse()], holes: [] });
  }
  return out;
}

/** Widest walkway a bridge deck carries, each side (metres). */
export const BRIDGE_WALKWAY = 1.5;

/** Half width of a bridge deck: carriageway plus walkways. */
export function deckHalf(r: Road): number {
  return r.width / 2 + Math.min(r.sidewalk, BRIDGE_WALKWAY);
}

/**
 * Streets that run on onto a narrower bridge deck: their sidewalks narrow to
 * the deck's walkways over the last TAPER m and the round end cap is trimmed
 * to the deck's width (a 0.7 m kerb step stood beside the barrier). The part
 * of the cap under the deck stays corridor, so no block reaches under the
 * ramp. Returns the roads and the strips cut off their corridor.
 */
function bridgeLandings(
  ground: Road[],
  bridges: Road[],
  key: (p: Vec2) => string,
): { roads: Set<Road>; cut: Polygon[] } {
  const roads = new Set<Road>();
  const cut: Polygon[] = [];
  const decks = new Map<string, Road>();
  for (const b of bridges)
    for (const p of [b.centerline[0], b.centerline[b.centerline.length - 1]]) decks.set(key(p), b);
  if (!decks.size) return { roads, cut };
  const groundEnds = new Map<string, number>();
  for (const r of ground)
    for (const p of [r.centerline[0], r.centerline[r.centerline.length - 1]])
      groundEnds.set(key(p), (groundEnds.get(key(p)) ?? 0) + 1);
  for (const r of ground) {
    const half = r.width / 2 + r.sidewalk;
    for (const start of [true, false]) {
      const c = start ? r.centerline : [...r.centerline].reverse();
      const p = c[0];
      const deck = decks.get(key(p));
      // Only a street that alone runs on onto the deck (not a junction there).
      if (!deck || groundEnds.get(key(p)) !== 1) continue;
      const crossing = ground.some(
        (o) =>
          o !== r &&
          o.centerline.some(
            (q, k) => k > 0 && closestOnSegment(p, o.centerline[k - 1], q).d < half,
          ),
      );
      if (crossing) continue;
      const w1 = Math.max(r.width / 2 + 0.3, deckHalf(deck));
      if (half - w1 <= 0.3) continue;
      const len = Math.min(TAPER, polylineLength(c) / 2);
      if (len < 2) continue;
      roads.add(r);
      const d0 = normalize(sub(c[0], c[1]));
      for (const side of [1, -1]) {
        // The cap beyond the end, beside the deck.
        const n0 = scale(perp(d0), side);
        const reach = half + 0.5;
        cut.push({
          outer: [
            add(p, scale(n0, w1)),
            add(add(p, scale(n0, w1)), scale(d0, reach)),
            add(add(p, scale(n0, reach)), scale(d0, reach)),
            add(p, scale(n0, reach)),
          ],
          holes: [],
        });
        const inner: Vec2[] = [];
        const outer: Vec2[] = [];
        let walked = 0;
        for (let k = 0; k < c.length - 1 && walked <= len; k++) {
          const seg = dist(c[k], c[k + 1]);
          if (seg < 1e-6) continue;
          const d = normalize(sub(c[k + 1], c[k]));
          const n = scale(perp(d), side);
          for (let s = 0; s < seg && walked + s <= len; s += 1) {
            const x = (walked + s) / len;
            const h = w1 + (half - w1) * x * x * (3 - 2 * x);
            const q = add(c[k], scale(d, s));
            inner.push(add(q, scale(n, h)));
            outer.push(add(q, scale(n, half + 0.5)));
          }
          walked += seg;
        }
        if (inner.length >= 2) cut.push({ outer: [...inner, ...outer.reverse()], holes: [] });
      }
    }
  }
  return { roads, cut };
}

export function buildSurfaces(roads: Road[], clipTo: Polygon[]): RoadSurfaces {
  const ground = roads.filter((r) => r.grade === 'ground');
  // A road ending at a tunnel mouth stops square at the portal (a round end
  // reached past it, over the street above an underpass).
  const key = (p: Vec2) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;
  const mouths = new Set(
    roads
      .filter((r) => r.grade === 'tunnel')
      .flatMap((r) => [key(r.centerline[0]), key(r.centerline[r.centerline.length - 1])]),
  );
  const landings = bridgeLandings(
    ground.filter((r) => r.formsBlocks && isVehicular(r.cls)),
    roads.filter((r) => r.grade === 'bridge'),
    key,
  );
  const buffer = (r: Road, half: number) => {
    const c = r.centerline;
    const ends = [c[0], c[c.length - 1]];
    if (!mouths.size || !ends.some((p) => mouths.has(key(p)))) return bufferPolylinePaths(c, half);
    const caps = ends
      .filter((p) => !mouths.has(key(p)))
      .flatMap((p) => bufferPolylinePaths([p, [p[0] + 0.01, p[1]]], half));
    return [...bufferPolylinePaths(c, half, false), ...caps];
  };
  const asphaltPaths = ground
    .filter((r) => isVehicular(r.cls))
    .flatMap((r) => buffer(r, r.width / 2));
  const pavingPaths = ground
    .filter((r) => r.cls === 'pedestrian')
    .flatMap((r) => bufferPolylinePaths(r.centerline, r.width / 2));
  const pathPaths = ground
    .filter((r) => r.cls === 'footway' || r.cls === 'steps' || r.cls === 'cycleway')
    .flatMap((r) => bufferPolylinePaths(r.centerline, r.width / 2));
  const corridorOf = (r: Road) => buffer(r, r.width / 2 + r.sidewalk);
  const corridorPaths = ground.filter((r) => r.formsBlocks).flatMap(corridorOf);

  const carriageway = intersection(unionPaths(asphaltPaths), clipTo);
  const blockRoads = ground.filter((r) => r.formsBlocks && isVehicular(r.cls));
  const blockCarriage = intersection(
    unionPaths(blockRoads.flatMap((r) => buffer(r, r.width / 2))),
    clipTo,
  );
  const paving = difference(intersection(unionPaths(pavingPaths), clipTo), carriageway);
  const tapers = kerbTapers(ground.filter((r) => r.formsBlocks));
  // Cleaned: round end caps meeting at a node leave needle spikes (two
  // vertices a few cm apart) in the kerb line.
  // Bridge landings trim only their own street: another corridor under a
  // trimmed strip (a slip road alongside) stays.
  const kept = landings.cut.length
    ? union(
        difference(union(unionPaths(corridorPaths), tapers), landings.cut),
        intersection(
          unionPaths(
            ground.filter((r) => r.formsBlocks && !landings.roads.has(r)).flatMap(corridorOf),
          ),
          landings.cut,
        ),
      )
    : union(unionPaths(corridorPaths), tapers);
  const corridor = clean(intersection(kept, clipTo), 0.15);
  const sidewalks = difference(corridor, [...carriageway, ...paving]);
  const paths = difference(intersection(unionPaths(pathPaths), clipTo), [
    ...carriageway,
    ...paving,
    ...sidewalks,
  ]);

  return {
    surfaces: [
      { kind: 'asphalt', polygons: carriageway },
      { kind: 'paving', polygons: paving },
      { kind: 'sidewalk', polygons: sidewalks },
      { kind: 'path', polygons: paths },
    ],
    carriageway: blockCarriage,
    corridor,
    tapers: intersection(union(tapers), clipTo),
  };
}

// ─── Markings & crossings ────────────────────────────────────────────────────

/** Offsets a polyline sideways (positive = left) with mitred vertices. */
export function offsetPolyline(points: Vec2[], d: number): Vec2[] {
  return points.map((p, k) => {
    const prev = points[Math.max(0, k - 1)];
    const next = points[Math.min(points.length - 1, k + 1)];
    const n0 = k > 0 ? perp(normalize(sub(p, prev))) : null;
    const n1 = k < points.length - 1 ? perp(normalize(sub(next, p))) : null;
    const n = n0 && n1 ? normalize(add(n0, n1)) : (n0 ?? n1)!;
    const cos = n0 && n1 ? Math.max(0.35, n[0] * n0[0] + n[1] * n0[1]) : 1;
    return add(p, scale(n, d / cos));
  });
}

/** Splits a polyline into runs that stay outside every junction circle. */
function runsOutside(
  points: Vec2[],
  junctions: Junction[],
  covered: (p: Vec2) => boolean = () => false,
): Vec2[][] {
  const runs: Vec2[][] = [];
  let current: Vec2[] = [];
  for (const p of points) {
    const inside = junctions.some((j) => dist(p, j.center) < j.radius) || covered(p);
    if (inside) {
      if (current.length >= 2) runs.push(current);
      current = [];
    } else {
      current.push(p);
    }
  }
  if (current.length >= 2) runs.push(current);
  return runs.filter((r) => polylineLength(r) > 4);
}

/** Which of two roads owns the surface where they merge: the wider, then more lanes. */
const roadPriority = (a: Road, b: Road) =>
  b.width - a.width || b.lanes - a.lanes || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function buildMarkings(roads: Road[], junctions: Junction[]): Marking[] {
  const out: Marking[] = [];
  // Where two roads merge or run into each other at a shallow angle (beyond
  // the junction circle) their carriageways overlap: the road that owns the
  // surface keeps its lane lines, the other one's stop there; edge lines stop
  // inside any other carriageway (the joining road opens into it).
  const carriageways = new RoadIndex(
    roads.filter((r) => r.grade === 'ground' && isVehicular(r.cls)),
  );
  for (const road of roads) {
    if (
      !isVehicular(road.cls) ||
      road.cls === 'service' ||
      road.cls === 'track' ||
      // Tunnels are not drawn; bridge decks get their markings on the deck (renderer).
      road.grade !== 'ground'
    )
      continue;
    if (road.lanes < 2 && !road.oneway) continue;
    const near = junctions.filter((j) => j.roadIds.includes(road.id));
    const line = densify(road.centerline, 2);
    const laneW = road.width / road.lanes;
    const inside = (edge: boolean) => (p: Vec2) =>
      carriageways.covering(p, (r) =>
        r !== road && (edge || roadPriority(r, road) < 0) ? r.width / 2 - 0.2 : 0,
      ) !== null;
    const add = (kind: Marking['kind'], d: number) => {
      for (const run of runsOutside(offsetPolyline(line, d), near, inside(kind === 'edge')))
        out.push({ kind, points: run });
    };
    if (road.oneway) {
      for (let k = 1; k < road.lanes; k++) add('lane-dashed', -road.width / 2 + k * laneW);
    } else {
      const perSide = Math.floor(road.lanes / 2);
      if (road.lanes >= 4) {
        add('center-solid', 0.12);
        add('center-solid', -0.12);
      } else {
        add('center-dashed', 0);
      }
      for (let k = 1; k < perSide; k++) {
        add('lane-dashed', k * laneW);
        add('lane-dashed', -k * laneW);
      }
    }
    if (['motorway', 'trunk', 'primary'].includes(road.cls)) {
      add('edge', road.width / 2 - 0.35);
      add('edge', -road.width / 2 + 0.35);
    }
  }
  return out;
}

/** Tangent of a polyline at the vertex nearest to p. */
function tangentNear(points: Vec2[], p: Vec2): { dir: Vec2; d: number; point: Vec2 } {
  let best = { dir: [1, 0] as Vec2, d: Infinity, point: points[0] };
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1];
    const b = points[k];
    const ab = sub(b, a);
    const l2 = ab[0] * ab[0] + ab[1] * ab[1];
    const t =
      l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2)) : 0;
    const q: Vec2 = [a[0] + ab[0] * t, a[1] + ab[1] * t];
    const d = dist(p, q);
    if (d < best.d) best = { dir: normalize(ab), d, point: q };
  }
  return best;
}

/** Point `at` metres from the start of a polyline. */
function pointAlong(points: Vec2[], at: number): { p: Vec2; dir: Vec2 } | null {
  let walked = 0;
  for (let k = 1; k < points.length; k++) {
    const l = dist(points[k - 1], points[k]);
    if (walked + l >= at) {
      const t = (at - walked) / l;
      const dir = normalize(sub(points[k], points[k - 1]));
      return { p: add(points[k - 1], scale(sub(points[k], points[k - 1]), t)), dir };
    }
    walked += l;
  }
  return null;
}

export function buildCrossings(
  roads: Road[],
  junctions: Junction[],
  points: SourcePoint[],
): Crossing[] {
  const out: Crossing[] = [];
  const vehicular = roads.filter(
    (r) => isVehicular(r.cls) && r.grade === 'ground' && r.cls !== 'service' && r.cls !== 'track',
  );

  for (const node of points) {
    if (node.tags.highway !== 'crossing' && !node.tags.crossing) continue;
    let best: { road: Road; dir: Vec2; d: number; point: Vec2 } | null = null;
    for (const road of vehicular) {
      const t = tangentNear(road.centerline, node.p);
      if (t.d < 3 && (!best || t.d < best.d)) best = { road, ...t };
    }
    if (best) {
      out.push({
        id: `x:${node.ref}`,
        center: best.point,
        dir: best.dir,
        length: best.road.width,
        provenance: 'observed',
      });
    }
  }

  // Zebra crossings on the arms of junctions between major roads.
  const major: RoadClass[] = ['trunk', 'primary', 'secondary', 'tertiary'];
  for (const j of junctions) {
    const armRoads = vehicular.filter((r) => j.roadIds.includes(r.id));
    if (!armRoads.some((r) => major.includes(r.cls))) continue;
    const provenance: Provenance = j.signalised ? 'inferred' : 'synthetic';
    for (const road of armRoads) {
      const line = road.centerline;
      const total = polylineLength(line);
      const startsHere = dist(line[0], j.center) < 1;
      const endsHere = dist(line[line.length - 1], j.center) < 1;
      const offsets: number[] = [];
      if (startsHere) offsets.push(j.radius + 2);
      if (endsHere) offsets.push(total - j.radius - 2);
      if (!startsHere && !endsHere) {
        // Junction in the middle of this way: arms on both sides.
        const along = cumulativeAt(line, j.center);
        offsets.push(along - j.radius - 2, along + j.radius + 2);
      }
      for (const at of offsets) {
        if (at < 2 || at > total - 2) continue;
        const hit = pointAlong(line, at);
        if (!hit) continue;
        if (out.some((c) => dist(c.center, hit.p) < 12)) continue;
        out.push({
          id: `x${j.id}-${road.id}-${Math.round(at)}`,
          center: hit.p,
          dir: hit.dir,
          length: road.width,
          provenance,
        });
      }
    }
  }
  return out;
}

function cumulativeAt(points: Vec2[], p: Vec2): number {
  let walked = 0;
  let best = { d: Infinity, at: 0 };
  for (let k = 1; k < points.length; k++) {
    const l = dist(points[k - 1], points[k]);
    const d = dist(points[k], p);
    if (d < best.d) best = { d, at: walked + l };
    walked += l;
  }
  return dist(points[0], p) < best.d ? 0 : best.at;
}
