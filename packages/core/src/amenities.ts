import { add, dist, normalize, orientedBox, perp, pointInRing, scale, sub } from './geo';
import { difference, intersection, offset, polygonArea } from './poly';
import { Rng } from './random';
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
  const styleOf = (b: Building): { style: FenceStyle; height: number; color: string } | null => {
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

  for (const block of blocks) {
    const ring = block.polygon.outer;
    const bbox = boxOf(block.polygon);
    // Walls keep out of every footprint near the block; lots belong to the
    // buildings standing in it (by centroid: a footprint on the block edge
    // may start just outside it).
    const nearby = buildings.filter((b) => meets(boxes.get(b)!, bbox, 2));
    const footprints = nearby.map((b) => b.footprint);
    const inside = nearby.filter((b) => {
      const r = b.footprint.outer;
      const c: Vec2 = [
        r.reduce((s, q) => s + q[0], 0) / r.length,
        r.reduce((s, q) => s + q[1], 0) / r.length,
      ];
      return inPoly(c, block.polygon);
    });
    if (!inside.length) continue;
    // Inside of the block is left of its edges when the ring runs counter-clockwise.
    let signed = 0;
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const c = ring[(k + 1) % ring.length];
      signed += a[0] * c[1] - c[0] * a[1];
    }
    const ccw = signed > 0;
    // Samples every metre along the block edge, 0.15 m inside it, with their lot.
    type Sample = { p: Vec2; b: Building | null; inward: Vec2 };
    const samples: Sample[] = [];
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const c = ring[(k + 1) % ring.length];
      const len = dist(a, c);
      if (len < 0.5) continue;
      const dir = normalize(sub(c, a));
      const inward = ccw ? perp(dir) : scale(perp(dir), -1);
      const n = Math.max(1, Math.round(len));
      for (let i = 0; i < n; i++) {
        const p = add(add(a, scale(dir, ((i + 0.5) * len) / n)), scale(inward, 0.15));
        const hit = near(p, inside);
        // A lot is the strip of block edge facing a building (to 3 m past its
        // corners) within 12 m of it: open ground and empty plots get no wall.
        // A building on (or within 1.5 m of) the edge needs no front wall.
        const owner =
          hit && hit.d > 1.5 && hit.d <= 12 && hit.past <= 3 && !inAny(p, footprints) && !onRoad(p)
            ? hit.b
            : null;
        samples.push({ p, b: owner, inward });
      }
      samples.push({ p: add(c, scale(inward, 0.15)), b: null, inward });
    }
    // Runs of samples with one lot owner → walls; gate opposite the owner's front.
    let run: Sample[] = [];
    const flush = () => {
      if (run.length >= 3 && run[0].b) {
        const b = run[0].b;
        const st = styleOf(b);
        if (st) {
          const pts = run.map((s) => s.p);
          // Gate: the run point nearest the building's front edge midpoint.
          const front = b.facades.find((f) => f.front);
          const fr = b.footprint.outer;
          const fe = front ? front.edge : 0;
          const mid: Vec2 = [
            (fr[fe][0] + fr[(fe + 1) % fr.length][0]) / 2,
            (fr[fe][1] + fr[(fe + 1) % fr.length][1]) / 2,
          ];
          let gi = 0;
          for (let i = 0; i < pts.length; i++) if (dist(pts[i], mid) < dist(pts[gi], mid)) gi = i;
          // A 3 m gap (one metre sample either side) for a double gate.
          const gateOk = gi >= 2 && gi < pts.length - 3;
          if (gateOk) {
            fences.push({ points: pts.slice(0, gi), ...st });
            fences.push({ points: pts.slice(gi + 2), ...st });
            const g: Vec2 = [(pts[gi][0] + pts[gi + 1][0]) / 2, (pts[gi][1] + pts[gi + 1][1]) / 2];
            gates.push({
              id: `${b.id}-gate`,
              kind: 'gate',
              position: [g[0], g[1], terrainHeightAt(terrain, g[0], g[1])],
              // Gate faces the street (out of the lot).
              heading: Math.atan2(-run[gi].inward[1], -run[gi].inward[0]),
              scale: 1,
              provenance: 'synthetic',
            });
          } else fences.push({ points: pts, ...st });
          // Side wall where the next lot begins: inward, up to 1 m short of the building.
          const end = run[run.length - 1];
          const hit = near(end.p, [b]);
          const len = Math.min(6, Math.max(0, (hit?.d ?? 0) - 1));
          // Not every lot is walled off from its neighbour.
          if (len > 1.5 && run.length >= 6 && new Rng(`${b.id}-side`).chance(0.5)) {
            // Stops before any building it would run into (the neighbour's too).
            let reach = 0;
            for (let d = 0.5; d <= len; d += 0.5) {
              if (inAny(add(end.p, scale(end.inward, d)), footprints)) break;
              reach = d;
            }
            if (reach > 1.5)
              fences.push({ points: [end.p, add(end.p, scale(end.inward, reach - 0.3))], ...st });
          }
        }
      }
      run = [];
    };
    for (const s of samples) {
      if (run.length && s.b !== run[0].b) flush();
      run.push(s);
    }
    flush();
  }
  return { fences, gates };
}
