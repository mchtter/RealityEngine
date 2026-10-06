import {
  add,
  closestOnSegment,
  dist,
  normalize,
  orientedBox,
  perp,
  pointInRing,
  scale,
  simplifyLine,
  sub,
} from './geo';
import { difference, intersection, offset, polygonArea } from './poly';
import { Rng } from './random';
import { offsetPolyline } from './roads';
import type { RoadIndex } from './spatial';
import { terrainHeightAt } from './terrain';
import type {
  Area,
  Building,
  CityBlock,
  Fence,
  FenceStyle,
  Marking,
  Polygon,
  Prop,
  PropKind,
  Surface,
  TerrainGrid,
  Vec2,
} from './types';
import { FENCE_WIDTH } from './validate';

/**
 * Ground use the source data describes but nothing drew: car parks (stall
 * lines, parked cars, an attendant booth), playgrounds (play equipment),
 * plazas and institutional yards (hard ground), the hard ground of dense
 * city blocks, and garden walls along the lots of houses and apartments.
 */

const inPoly = (p: Vec2, poly: Polygon) =>
  pointInRing(p, poly.outer) && !poly.holes.some((h) => pointInRing(p, h));
const inAny = (p: Vec2, polys: Polygon[]) => polys.some((q) => inPoly(p, q));

/**
 * Hard ground: plazas (paving), school / mosque / works yards and the interior
 * of dense blocks (concrete), surface car parks and playgrounds. Dense blocks
 * (a third built over) are hard throughout; half as dense, within 7 m of the
 * buildings. Parks, grass and woods stay green.
 */
type Box = [number, number, number, number];
const boxOf = (p: Polygon): Box => {
  let b: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const q of p.outer)
    b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[0]), Math.max(b[3], q[1])];
  return b;
};
const meets = (a: Box, b: Box, pad = 0) =>
  a[0] <= b[2] + pad && a[2] >= b[0] - pad && a[1] <= b[3] + pad && a[3] >= b[1] - pad;

export function groundSurfaces(
  areas: Area[],
  blocks: CityBlock[],
  buildings: Building[],
  corridor: Polygon[],
): Surface[] {
  // Polygon operations only ever see the footprints / corridor pieces / areas
  // near the polygon at hand (all of them made a tile compile seconds slower).
  const fps = buildings.map((b) => ({ b, poly: b.footprint, box: boxOf(b.footprint) }));
  const cor = corridor.map((poly) => ({ poly, box: boxOf(poly) }));
  const near = <T extends { box: Box }>(list: T[], box: Box, pad = 0) =>
    list.filter((x) => meets(x.box, box, pad));
  const greens = areas
    .filter((a) => a.kind === 'park' || a.kind === 'grass' || a.kind === 'forest')
    .map((a) => ({ poly: a.polygon, box: boxOf(a.polygon) }));
  const minus = (poly: Polygon, extra: { poly: Polygon; box: Box }[] = []) => {
    const box = boxOf(poly);
    const cut = [
      ...near(fps, box).map((f) => f.poly),
      ...near(cor, box).map((c) => c.poly),
      ...near(extra, box).map((e) => e.poly),
    ];
    return cut.length ? difference([poly], cut) : [poly];
  };
  const of = (kind: Area['kind']) =>
    areas.filter((a) => a.kind === kind).flatMap((a) => minus(a.polygon));
  const parking = of('parking');
  const playground = of('playground');
  const plaza = of('plaza');

  // Institutional grounds: a school yard is hard throughout, a large campus
  // (university, hospital grounds) only around its buildings; works yards hard.
  const yards: Polygon[] = [];
  for (const a of areas) {
    if (a.kind !== 'school' && a.kind !== 'religious' && a.kind !== 'industrial') continue;
    const box = boxOf(a.polygon);
    let hard: Polygon[] = [a.polygon];
    if (a.kind !== 'industrial' && polygonArea(a.polygon) > 3000) {
      const own = near(fps, box)
        .filter((f) => inPoly(f.poly.outer[0], a.polygon))
        .map((f) => f.poly);
      hard = own.length ? intersection([a.polygon], offset(own, 12, 'miter')) : [];
    }
    for (const h of hard) yards.push(...minus(h, greens));
  }

  // Dense blocks: hard throughout (a third built over) or within 7 m of the buildings.
  const special = [...parking, ...playground, ...plaza].map((poly) => ({ poly, box: boxOf(poly) }));
  const dense: Polygon[] = [];
  for (const block of blocks) {
    const box = boxOf(block.polygon);
    const inside = near(fps, box)
      .filter((f) => inPoly(f.poly.outer[0], block.polygon))
      .map((f) => f.b);
    if (!inside.length || block.area <= 0) continue;
    const built = inside.reduce((s, b) => s + b.area, 0) / block.area;
    if (built < 0.16) continue;
    const hard =
      built >= 0.33
        ? [block.polygon]
        : intersection(
            [block.polygon],
            offset(
              inside.map((b) => b.footprint),
              7,
              'miter',
            ),
          );
    const cut = [
      ...inside.map((b) => b.footprint),
      ...near(greens, box).map((g) => g.poly),
      ...near(special, box).map((g) => g.poly),
    ];
    dense.push(...(cut.length ? difference(hard, cut) : hard));
  }
  const yardBoxes = yards.map((poly) => ({ poly, box: boxOf(poly) }));
  const concrete = [
    ...yards,
    ...dense.flatMap((d) => {
      const others = near(yardBoxes, boxOf(d)).map((y) => y.poly);
      return others.length ? difference([d], others) : [d];
    }),
  ];
  return [
    { kind: 'concrete', polygons: concrete },
    { kind: 'parking', polygons: parking },
    { kind: 'playground', polygons: playground },
    { kind: 'paving', polygons: plaza },
  ];
}

/** Runs of the segment a→b (sampled every 0.4 m) inside `poly` and clear of `avoid`. */
function segmentRuns(a: Vec2, b: Vec2, poly: Polygon, avoid: Polygon[]): Vec2[][] {
  const n = Math.max(1, Math.ceil(dist(a, b) / 0.4));
  const runs: Vec2[][] = [];
  let run: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const p: Vec2 = [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n];
    if (inPoly(p, poly) && !inAny(p, avoid)) run.push(p);
    else {
      if (run.length >= 2) runs.push([run[0], run[run.length - 1]]);
      run = [];
    }
  }
  if (run.length >= 2) runs.push([run[0], run[run.length - 1]]);
  return runs;
}

/**
 * Surface car parks: rows of 2.5 × 5 m stalls along the lot's long axis with
 * 6 m aisles, white stall lines, cars in about two stalls of three; a booth and
 * a barrier arm at the entrance of larger lots (the edge nearest a street).
 */
export function parkingLayout(
  areas: Area[],
  buildings: Building[],
  roads: RoadIndex,
  terrain: TerrainGrid,
): { markings: Marking[]; props: Prop[] } {
  const markings: Marking[] = [];
  const props: Prop[] = [];
  const boxes = buildings.map((b) => ({ b, box: boxOf(b.footprint) }));
  const z = (p: Vec2) => terrainHeightAt(terrain, p[0], p[1]);
  for (const a of areas) {
    if (a.kind !== 'parking') continue;
    const area = polygonArea(a.polygon);
    if (area < 120) continue;
    // Buildings (0.5 m clear) next to this lot only.
    const lotBox = boxOf(a.polygon);
    const footprints = offset(
      boxes.filter((x) => meets(x.box, lotBox, 1)).map((x) => x.b.footprint),
      0.5,
    );
    const rng = new Rng(a.id);
    const box = orientedBox(a.polygon.outer);
    const u = box.axis;
    const v = perp(u);
    const at = (s: number, t: number): Vec2 => add(box.center, add(scale(u, s), scale(v, t)));
    const inner = offset([a.polygon], -0.6);
    if (!inner.length) continue;
    // Module across the lot: stall row (5) · aisle (6) · stall row (5).
    const W = box.halfWidth;
    const rows: { t0: number; t1: number; facing: 1 | -1 }[] = [];
    for (let t = -W + 0.6; t + 5 <= W - 0.6; ) {
      rows.push({ t0: t, t1: t + 5, facing: 1 });
      t += 5 + 6;
      if (t + 5 > W - 0.6) break;
      rows.push({ t0: t, t1: t + 5, facing: -1 });
      t += 5;
    }
    for (const row of rows) {
      // Back line of the row (along the axis) and the separators across it.
      const back = row.facing > 0 ? row.t0 : row.t1;
      for (const run of segmentRuns(
        at(-box.halfLength, back),
        at(box.halfLength, back),
        inner[0],
        footprints,
      ))
        markings.push({ kind: 'stall', points: run });
      for (let s = -box.halfLength + 0.6; s + 2.5 <= box.halfLength - 0.6; s += 2.5) {
        for (const run of segmentRuns(at(s, row.t0), at(s, row.t1), inner[0], footprints))
          markings.push({ kind: 'stall', points: run });
        const corners = [at(s, row.t0), at(s + 2.5, row.t0), at(s + 2.5, row.t1), at(s, row.t1)];
        const free = corners.every((c) => inPoly(c, inner[0]) && !inAny(c, footprints));
        if (!free) continue;
        // Last separator of the row.
        if (s + 5 > box.halfLength - 0.6)
          for (const run of segmentRuns(
            at(s + 2.5, row.t0),
            at(s + 2.5, row.t1),
            inner[0],
            footprints,
          ))
            markings.push({ kind: 'stall', points: run });
        if (!rng.chance(0.68)) continue;
        const c = at(s + 1.25, (row.t0 + row.t1) / 2);
        // Cars park nose in, facing the back line.
        const nose = scale(v, -row.facing);
        props.push({
          id: `${a.id}-car-${props.length}`,
          kind: 'car',
          position: [c[0], c[1], z(c)],
          heading: Math.atan2(nose[1], nose[0]) + rng.range(-0.04, 0.04),
          scale: 1,
          provenance: 'synthetic',
        });
      }
    }
    if (area < 500) continue;
    // Entrance: the lot boundary point nearest a street.
    let best: { p: Vec2; d: number; road: Vec2 } | null = null;
    const ring = a.polygon.outer;
    for (let k = 0; k < ring.length; k++) {
      const p0 = ring[k];
      const p1 = ring[(k + 1) % ring.length];
      for (let i = 0; i <= 4; i++) {
        const p: Vec2 = [p0[0] + ((p1[0] - p0[0]) * i) / 4, p0[1] + ((p1[1] - p0[1]) * i) / 4];
        const hit = roads.nearest(p, 20, (r) => r.grade === 'ground');
        if (hit && (!best || hit.d < best.d)) best = { p, d: hit.d, road: hit.point };
      }
    }
    if (!best) continue;
    const inward = normalize(sub(box.center, best.p));
    const side = perp(inward);
    const booth = add(best.p, add(scale(inward, 3), scale(side, 3)));
    const arm = add(best.p, scale(inward, 1.5));
    if (inPoly(booth, a.polygon) && !inAny(booth, footprints)) {
      props.push({
        id: `${a.id}-booth`,
        kind: 'booth',
        position: [booth[0], booth[1], z(booth)],
        heading: Math.atan2(-side[1], -side[0]),
        scale: 1,
        provenance: 'synthetic',
      });
      props.push({
        id: `${a.id}-arm`,
        kind: 'barrier-arm',
        position: [arm[0], arm[1], z(arm)],
        heading: Math.atan2(inward[1], inward[0]),
        scale: 1,
        provenance: 'synthetic',
      });
    }
  }
  return { markings, props };
}

const PLAY: PropKind[] = ['swing', 'slide', 'climber', 'seesaw', 'swing', 'slide'];

/** Play equipment on playgrounds: a few pieces 5 m apart, benches along the edge. */
export function playgroundLayout(areas: Area[], terrain: TerrainGrid): Prop[] {
  const out: Prop[] = [];
  const z = (p: Vec2) => terrainHeightAt(terrain, p[0], p[1]);
  for (const a of areas) {
    if (a.kind !== 'playground') continue;
    const area = polygonArea(a.polygon);
    if (area < 40) continue;
    const rng = new Rng(a.id);
    const inner = offset([a.polygon], -2);
    if (!inner.length) continue;
    const box = orientedBox(a.polygon.outer);
    const u = box.axis;
    const v = perp(u);
    const want = Math.min(6, Math.max(1, Math.floor(area / 60)));
    const placed: Vec2[] = [];
    for (let s = -box.halfLength; s <= box.halfLength && placed.length < want; s += 5) {
      for (let t = -box.halfWidth; t <= box.halfWidth && placed.length < want; t += 5) {
        const p = add(box.center, add(scale(u, s + rng.range(-0.6, 0.6)), scale(v, t)));
        if (!inAny(p, inner) || placed.some((q) => dist(p, q) < 4.6)) continue;
        placed.push(p);
        out.push({
          id: `${a.id}-play-${placed.length}`,
          kind: PLAY[(placed.length - 1) % PLAY.length],
          position: [p[0], p[1], z(p)],
          heading: Math.atan2(u[1], u[0]) + (rng.chance(0.5) ? 0 : Math.PI / 2),
          scale: 1,
          provenance: 'synthetic',
        });
      }
    }
    // Benches just inside the edge, facing in.
    const ring = offset([a.polygon], -0.9)[0]?.outer ?? [];
    for (let k = 0; k < ring.length && k < 6; k += 2) {
      const p0 = ring[k];
      const p1 = ring[(k + 1) % ring.length];
      if (dist(p0, p1) < 3) continue;
      const p: Vec2 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
      const into = normalize(sub(box.center, p));
      out.push({
        id: `${a.id}-bench-${k}`,
        kind: 'bench',
        position: [p[0], p[1], z(p)],
        heading: Math.atan2(into[1], into[0]),
        scale: 1,
        provenance: 'synthetic',
      });
    }
  }
  return out;
}

/** Garden walls are straightened to this tolerance (metres). */
const WALL_STRAIGHTEN = 0.1;
const WALL_COLORS = ['#d8cfc0', '#e6e0d4', '#cbbfae', '#b9b2a6', '#e3d6bd', '#c9c2b4'];

/**
 * Garden walls along the street side of house and apartment lots. Each point
 * of a block's edge belongs to the nearest building's lot; where that building
 * stands back from the edge (a front garden), the lot gets a wall with a gate
 * opposite the building's front, and lots are split by a side wall. Style by
 * building: low wall with a railing, plain or stone wall, hedge, mesh.
 */
export function gardenWalls(
  blocks: CityBlock[],
  buildings: Building[],
  terrain: TerrainGrid,
  roads: RoadIndex,
): { fences: Fence[]; gates: Prop[] } {
  // Walls stop short of any carriageway (service roads and driveways cross lots).
  const onRoad = (p: Vec2) =>
    roads.covering(p, (r) => (r.grade === 'ground' ? r.width / 2 + 0.8 : 0)) !== null;
  const fences: Fence[] = [];
  const gates: Prop[] = [];
  const boxes = new Map(buildings.map((b) => [b, boxOf(b.footprint)]));
  const near = (p: Vec2, list: Building[]) => {
    // d: distance to the footprint; past: how far beyond the end of the
    // nearest wall the point lies along it (0 when it faces the wall).
    let best: { b: Building; d: number; past: number } | null = null;
    for (const b of list) {
      const bb = boxes.get(b)!;
      const lim = best ? best.d : 25;
      if (p[0] < bb[0] - lim || p[0] > bb[2] + lim || p[1] < bb[1] - lim || p[1] > bb[3] + lim)
        continue;
      const r = b.footprint.outer;
      for (let k = 0; k < r.length; k++) {
        const a = r[k];
        const c = r[(k + 1) % r.length];
        const ab = sub(c, a);
        const l2 = ab[0] * ab[0] + ab[1] * ab[1] || 1;
        const raw = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2;
        const t = Math.max(0, Math.min(1, raw));
        const d = dist(p, [a[0] + ab[0] * t, a[1] + ab[1] * t]);
        const past = Math.max(0, -raw, raw - 1) * Math.sqrt(l2);
        if (!best || d < best.d) best = { b, d, past };
      }
    }
    return best;
  };
  type FenceStyleOf = { style: FenceStyle; height: number; color: string };
  const styleOf = (b: Building): FenceStyleOf | null => {
    if (b.shopfront || b.use === 'commercial') return null;
    const rng = new Rng(`${b.id}-fence`);
    const color = rng.pick(WALL_COLORS);
    if (b.use === 'public') {
      const style = rng.weighted([
        ['wall-rail', 0.6],
        ['mesh', 0.4],
      ] as const);
      return { style, height: style === 'mesh' ? 1.8 : 1.6, color };
    }
    const style: FenceStyle =
      b.archetype === 'mustakil'
        ? rng.weighted([
            ['wall-rail', 0.32],
            ['wall', 0.22],
            ['stone', 0.16],
            ['hedge', 0.16],
            ['mesh', 0.14],
          ] as const)
        : rng.weighted([
            ['wall-rail', 0.5],
            ['wall', 0.18],
            ['hedge', 0.17],
            ['mesh', 0.15],
          ] as const);
    const height =
      style === 'wall'
        ? rng.range(1.2, 1.8)
        : style === 'stone'
          ? rng.range(0.8, 1.1)
          : style === 'hedge'
            ? rng.range(0.9, 1.3)
            : style === 'mesh'
              ? 1.5
              : rng.range(1.3, 1.6);
    return { style, height, color };
  };

  // Rules (each lot's wall is one piece of a street wall, not loose bits):
  // · a lot's frontage runs on round the block's corners, unbroken;
  // · no lot frontage shorter than MIN_LOT, no hole shorter than MIN_HOLE
  //   (corner arcs and sampling noise made 2 m stubs with 1 m gaps);
  // · the wall follows the block edge's own corners (straight courses);
  // · neighbouring lots meet at their boundary, with a side wall going in;
  // · a block keeps one wall character (style, height, colour) with a few
  //   lots of their own; one 3 m gate per lot, opposite the front door.
  const STEP = 0.5;
  const MIN_LOT = 3;
  const MIN_HOLE = 2.5;
  for (const block of blocks) {
    const ring = block.polygon.outer;
    const n = ring.length;
    if (n < 3) continue;
    const bbox = boxOf(block.polygon);
    // Walls keep out of every footprint near the block; lots belong to the
    // buildings standing in it (by centroid: a footprint on the block edge
    // may start just outside it).
    const nearby = buildings.filter((b) => meets(boxes.get(b)!, bbox, 2));
    const footprints = nearby.map((b) => b.footprint);
    const inside = nearby.filter((b) => {
      const r = b.footprint.outer;
      const c: Vec2 = [
        r.reduce((sum, q) => sum + q[0], 0) / r.length,
        r.reduce((sum, q) => sum + q[1], 0) / r.length,
      ];
      return inPoly(c, block.polygon);
    });
    if (!inside.length) continue;
    // Inside of the block is left of its edges when the ring runs counter-clockwise.
    let signed = 0;
    for (let k = 0; k < n; k++) {
      const a = ring[k];
      const c = ring[(k + 1) % n];
      signed += a[0] * c[1] - c[0] * a[1];
    }
    const side = signed > 0 ? 1 : -1;
    // Arc length round the ring.
    const cum = [0];
    for (let k = 0; k < n; k++) cum.push(cum[k] + dist(ring[k], ring[(k + 1) % n]));
    const total = cum[n];
    if (total < MIN_LOT) continue;
    const seg = (sIn: number) => {
      const s0 = ((sIn % total) + total) % total;
      let k = 0;
      while (k < n - 1 && cum[k + 1] <= s0) k++;
      const a = ring[k];
      const c = ring[(k + 1) % n];
      const len = cum[k + 1] - cum[k] || 1;
      const dir = normalize(sub(c, a));
      return { p: add(a, scale(dir, s0 - cum[k])), inward: scale(perp(dir), side), k, len };
    };
    // Lot owner of each 0.5 m of block edge.
    const count = Math.max(1, Math.floor(total / STEP));
    const owners: (Building | null)[] = [];
    for (let i = 0; i < count; i++) {
      const { p, inward } = seg((i + 0.5) * STEP);
      const q = add(p, scale(inward, 0.15));
      const hit = near(q, inside);
      // A lot is the strip of block edge facing a building (to 3 m past its
      // corners) within 12 m of it: open ground and empty plots get no wall.
      // A building on (or within 1.5 m of) the edge needs no front wall.
      owners.push(
        hit && hit.d > 1.5 && hit.d <= 12 && hit.past <= 3 && !inAny(q, footprints) && !onRoad(q)
          ? hit.b
          : null,
      );
    }
    // Runs round the ring (circular).
    type Run = { b: Building | null; i0: number; len: number };
    const runsOf = (): Run[] => {
      const start = owners.findIndex((o, i) => o !== owners[(i - 1 + count) % count]);
      if (start < 0) return [{ b: owners[0], i0: 0, len: count }];
      const out: Run[] = [];
      let i = start;
      do {
        const b = owners[i];
        let len = 0;
        while (len < count && owners[(i + len) % count] === b) len++;
        out.push({ b, i0: i, len });
        i = (i + len) % count;
      } while (i !== start);
      return out;
    };
    const fill = (r: Run, b: Building | null) => {
      for (let j = 0; j < r.len; j++) owners[(r.i0 + j) % count] = b;
    };
    // Short holes inside one lot close; short lots go.
    // (Between two lots the hole is shared out: the walls meet halfway.
    // Driveways are wider than MIN_HOLE and stay open.)
    for (const r of runsOf()) {
      if (r.b || r.len * STEP >= MIN_HOLE) continue;
      const prev = owners[(r.i0 - 1 + count) % count];
      const next = owners[(r.i0 + r.len) % count];
      if (!prev || !next) continue;
      const half = Math.floor(r.len / 2);
      for (let j = 0; j < r.len; j++) owners[(r.i0 + j) % count] = j < half ? prev : next;
    }
    for (const r of runsOf()) if (r.b && r.len * STEP < MIN_LOT) fill(r, null);
    const runs = runsOf();
    // Block character: the wall most lots share.
    const blockRng = new Rng(`${block.id}-walls`);
    const lead = inside.map(styleOf).find((st) => st !== null) ?? null;
    const character = lead && blockRng.chance(0.8) ? lead : null;
    const styleFor = (b: Building) => {
      const own = styleOf(b);
      if (!own || b.use === 'public' || !character) return own;
      return new Rng(`${b.id}-own`).chance(0.2) ? own : character;
    };
    // Ring path between arc lengths s0 < s1 (through its corners), moved
    // `off` m inwards and straightened.
    const path = (s0: number, s1: number, off: number): Vec2[] => {
      const pts: Vec2[] = [seg(s0).p];
      for (let s = s0, guard = 0; guard < n + 1; guard++) {
        const { k } = seg(s);
        const lap = Math.floor(s / total) * total;
        const corner = lap + cum[k + 1];
        if (corner >= s1 - 1e-6) break;
        pts.push(ring[(k + 1) % n]);
        s = corner + 1e-6;
      }
      pts.push(seg(s1).p);
      return simplifyLine(offsetPolyline(pts, side * off), WALL_STRAIGHTEN);
    };
    const pathLength = (pts: Vec2[]) => pts.slice(1).reduce((l, q, k) => l + dist(pts[k], q), 0);
    /** Part of a polyline between lengths a and b. */
    const cut = (pts: Vec2[], a: number, b: number): Vec2[] => {
      const out: Vec2[] = [];
      let walked = 0;
      for (let k = 1; k < pts.length; k++) {
        const l = dist(pts[k - 1], pts[k]);
        const d = normalize(sub(pts[k], pts[k - 1]));
        if (walked + l >= a && walked <= b) {
          if (!out.length) out.push(add(pts[k - 1], scale(d, Math.max(0, a - walked))));
          if (walked + l <= b) out.push(pts[k]);
          else {
            out.push(add(pts[k - 1], scale(d, b - walked)));
            break;
          }
        }
        walked += l;
      }
      return out;
    };
    const firstOfBlock = fences.length;
    type Side = { base: Vec2; inward: Vec2; st: FenceStyleOf; own: Fence[] };
    const sides: Side[] = [];
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r];
      const b = run.b;
      if (!b) continue;
      const st = styleFor(b);
      if (!st) continue;
      const firstOfRun = fences.length;
      const s0 = run.i0 * STEP;
      const s1 = (run.i0 + run.len) * STEP;
      // Fence centre line half its width (+5 cm, + the straightening's
      // tolerance) inside the block edge: the body stays off the sidewalk.
      const off = FENCE_WIDTH[st.style] / 2 + 0.05 + WALL_STRAIGHTEN;
      const pts = run.len === count ? path(0, total, off) : path(s0, s1, off);
      const L = pathLength(pts);
      // Gate: opposite the building's front edge midpoint, 3 m wide, on a
      // frontage long enough to keep 1.5 m of wall either side.
      const front = b.facades.find((f) => f.front);
      const fr = b.footprint.outer;
      const fe = front ? front.edge : 0;
      const mid: Vec2 = [
        (fr[fe][0] + fr[(fe + 1) % fr.length][0]) / 2,
        (fr[fe][1] + fr[(fe + 1) % fr.length][1]) / 2,
      ];
      let g = -1;
      let gd = Infinity;
      let walked = 0;
      for (let k = 1; k < pts.length; k++) {
        const c = closestOnSegment(mid, pts[k - 1], pts[k]);
        if (c.d < gd) {
          gd = c.d;
          g = walked + c.t * dist(pts[k - 1], pts[k]);
        }
        walked += dist(pts[k - 1], pts[k]);
      }
      // A wall piece is none or at least MIN_PIECE long: a gate near an end
      // moves to the end (no stub beside it); a short frontage has no gate.
      const MIN_PIECE = 2;
      g = Math.min(Math.max(g, 1.5), L - 1.5);
      if (g - 1.5 < MIN_PIECE) g = 1.5;
      if (L - (g + 1.5) < MIN_PIECE) g = L - 1.5;
      if (L >= 3 + MIN_PIECE && g - 1.5 >= 0 && L - (g + 1.5) >= 0) {
        if (g - 1.5 >= MIN_PIECE) fences.push({ points: cut(pts, 0, g - 1.5), ...st });
        if (L - (g + 1.5) >= MIN_PIECE) fences.push({ points: cut(pts, g + 1.5, L), ...st });
        const at = cut(pts, g - 0.01, g + 0.01);
        const gp = at[0] ?? pts[0];
        const dir = at.length > 1 ? normalize(sub(at[1], at[0])) : ([1, 0] as Vec2);
        const out = scale(perp(dir), -side);
        gates.push({
          id: `${b.id}-gate`,
          kind: 'gate',
          position: [gp[0], gp[1], terrainHeightAt(terrain, gp[0], gp[1])],
          // Gate faces the street (out of the lot).
          heading: Math.atan2(out[1], out[0]),
          scale: 1,
          provenance: 'synthetic',
        });
      } else fences.push({ points: pts, ...st });
      // Side wall where the lot meets the next one (open ground: the wall
      // just ends there), laid once every frontage of the block stands.
      if (run.len === count) continue;
      const next = runs[(r + 1) % runs.length];
      if (!next.b || next.b === b) continue;
      const a0 = seg(s1 - 0.25).inward;
      const a1 = seg(s1 + 0.25).inward;
      const inward = normalize(add(a0, a1));
      sides.push({ base: pts[pts.length - 1], inward, st, own: fences.slice(firstOfRun) });
    }
    // Joints: two frontage walls whose ends stop short of each other at a lot
    // boundary (< 1.2 m apart, no gate between) meet halfway.
    const frontage = fences.slice(firstOfBlock);
    const free = frontage.flatMap((f) => [
      { f, i: 0 },
      { f, i: f.points.length - 1 },
    ]);
    for (let x = 0; x < free.length; x++) {
      for (let y = x + 1; y < free.length; y++) {
        const A = free[x];
        const B = free[y];
        if (A.f === B.f) continue;
        const pa = A.f.points[A.i];
        const pb = B.f.points[B.i];
        const g = dist(pa, pb);
        if (g < 1e-3 || g > 1.2) continue;
        const mid: Vec2 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
        A.f.points[A.i] = mid;
        B.f.points[B.i] = mid;
      }
    }
    // Rule: no wall stands in another wall or a building, and none leaves
    // the block. A side wall walks in until it would come within 0.4 m of a
    // wall other than its own frontage, or 0.5 m of a footprint; it is laid
    // only if it reaches a building (one ending in the open yard is not a
    // lot boundary anyone would build).
    const blockWalls = fences.slice(firstOfBlock);
    for (const sd of sides) {
      const others = blockWalls.filter((f) => !sd.own.includes(f));
      const onWall = (q: Vec2) =>
        others.some((f) =>
          f.points.some((a, k) => k > 0 && closestOnSegment(q, f.points[k - 1], a).d < 0.4),
        );
      let reach = 0;
      let reached = false;
      for (let d = 0.5; d <= 10; d += 0.5) {
        const q = add(sd.base, scale(sd.inward, d));
        if (inAny(add(q, scale(sd.inward, 0.5)), footprints)) {
          reached = true;
          break;
        }
        if (onWall(q) || !inPoly(q, block.polygon)) break;
        reach = d;
      }
      if (reached && reach >= 2) {
        const wall = { points: [sd.base, add(sd.base, scale(sd.inward, reach))], ...sd.st };
        fences.push(wall);
        blockWalls.push(wall);
      }
    }
  }
  return { fences, gates };
}
