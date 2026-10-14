import { boundaryRuns } from './amenities';
import { normalize, orientedBox, perp, pointInRing, simplifyLine, sub } from './geo';
import { offset, polygonArea } from './poly';
import { Rng } from './random';
import type { PolygonIndex, RoadIndex } from './spatial';
import { terrainHeightAt } from './terrain';
import type { Area, Building, Fence, FenceStyle, Polygon, Prop, TerrainGrid, Vec2 } from './types';

/** Most graves / stalls / containers one area gets (a huge cemetery keeps whole sections empty). */
const MAX_GRAVES = 6000;
const MAX_CYPRESSES = 900;
const MAX_STALLS = 600;
const MAX_CONTAINERS = 4000;

/** What a special ground adds to the city: its props and its boundary walls. */
export interface GroundFurnishing {
  props: Prop[];
  fences: Fence[];
}

const inPoly = (p: Vec2, poly: Polygon) =>
  pointInRing(p, poly.outer) && !poly.holes.some((h) => pointInRing(p, h));

/**
 * Cemeteries, building sites, harbours, military grounds and open-air
 * markets, from the area kinds in the data:
 *
 * - cemetery: rows of marble graves in sections along the ground's long axis,
 *   cypresses along its paths and walls, a low white wall with a gate;
 * - construction: the site hoarding round it, a tower crane on a large site;
 * - harbour: container stacks in blocks with lanes between;
 * - military: a high wall round the grounds, one gate;
 * - marketplace: stalls back to back in rows with aisles between;
 * - substation: a mesh fence, transformers in a row, the gantries in rows;
 * - power plant: a mesh fence and a stack.
 *
 * Their ground (gravel, bare soil, rock, concrete, paving) is a surface
 * (groundSurfaces); quarries have only that.
 */
export function furnishGrounds(
  areas: Area[],
  buildings: PolygonIndex<Building>,
  terrain: TerrainGrid,
  roads: RoadIndex,
  /**
   * The part being compiled (a tile and its margin): graves, stalls and
   * containers are counted against their caps there, so a ground spanning
   * several tiles is filled in each (cranes and gates are picked over the
   * whole ground, the same in every tile).
   */
  inRegion: (p: Vec2) => boolean = () => true,
): GroundFurnishing {
  const props: Prop[] = [];
  const fences: Fence[] = [];
  const onRoad = (p: Vec2, margin = 0.5) =>
    roads.covering(p, (r) => (r.grade === 'ground' ? r.width / 2 + margin : 0)) !== null;
  /** Free ground: not in or right against a building, not on a road. */
  const free = (p: Vec2, clear: number) =>
    !onRoad(p) &&
    !buildings.at(p) &&
    !buildings.at([p[0] + clear, p[1]]) &&
    !buildings.at([p[0] - clear, p[1]]) &&
    !buildings.at([p[0], p[1] + clear]) &&
    !buildings.at([p[0], p[1] - clear]);
  const z = (p: Vec2) => terrainHeightAt(terrain, p[0], p[1]);
  const prop = (
    id: string,
    kind: Prop['kind'],
    p: Vec2,
    heading: number,
    scale = 1,
    lift = 0,
  ): Prop => ({
    id,
    kind,
    position: [p[0], p[1], z(p) + lift],
    heading,
    scale,
    provenance: 'synthetic',
  });

  /** A wall along the free parts of the boundary, with a gate in the longest run. */
  const wallRound = (a: Area, style: FenceStyle, height: number, color: string, gate: boolean) => {
    const ring = a.polygon.outer as Vec2[];
    const runs = boundaryRuns(
      ring,
      (p) =>
        onRoad(p, 1) ||
        !!buildings.at(p) ||
        !!buildings.at([p[0] + 1.2, p[1]]) ||
        !!buildings.at([p[0] - 1.2, p[1]]) ||
        !!buildings.at([p[0], p[1] + 1.2]) ||
        !!buildings.at([p[0], p[1] - 1.2]),
    );
    let longest = -1;
    runs.forEach((r, i) => {
      if (longest < 0 || r.length > runs[longest].length) longest = i;
    });
    runs.forEach((r, i) => {
      if (!gate || i !== longest || r.length < 10) {
        fences.push({ points: simplifyLine(r, 0.1), style, height, color });
        return;
      }
      const m = Math.floor(r.length / 2);
      fences.push({ points: simplifyLine(r.slice(0, m - 1), 0.1), style, height, color });
      fences.push({ points: simplifyLine(r.slice(m + 1), 0.1), style, height, color });
      const out = perp(normalize(sub(r[m + 1], r[m - 1])));
      props.push(prop(`${a.id}-gate`, 'gate', r[m], Math.atan2(out[1], out[0])));
    });
  };

  /** Points of a grid along the area's long axis, (u, v) indices and position. */
  const grid = (poly: Polygon, du: number, dv: number) => {
    const ob = orientedBox(poly.outer as Vec2[]);
    const ax = ob.axis;
    const nx: Vec2 = [-ax[1], ax[0]];
    const nu = Math.floor((2 * ob.halfLength) / du);
    const nv = Math.floor((2 * ob.halfWidth) / dv);
    const out: { i: number; j: number; p: Vec2 }[] = [];
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++) {
        const u = -ob.halfLength + (i + 0.5) * du;
        const v = -ob.halfWidth + (j + 0.5) * dv;
        out.push({
          i,
          j,
          p: [ob.center[0] + ax[0] * u + nx[0] * v, ob.center[1] + ax[1] * u + nx[1] * v],
        });
      }
    return { out, axis: ax, normal: nx, nu, nv };
  };
  /** The area pulled in by `d` (empty when it is narrower than that). */
  const inset = (a: Area, d: number) => offset([a.polygon], -d);
  const inAny = (p: Vec2, polys: Polygon[]) => polys.some((q) => inPoly(p, q));

  for (const a of areas) {
    const area = polygonArea(a.polygon);
    const rng = new Rng(`${a.id}-grounds`);
    switch (a.kind) {
      case 'cemetery': {
        if (area < 300) break;
        wallRound(a, 'wall', 1.6, '#e8e4da', true);
        const inner = inset(a, 1.8);
        // Graves 1.3 m apart in rows 2.6 m apart, across the long axis; every
        // 7th row and 16th column a path; sections of 6 × 15 graves.
        const g = grid(a.polygon, 1.3, 2.6);
        const heading = Math.atan2(g.normal[1], g.normal[0]);
        const estimate = (polygonArea(inner[0] ?? a.polygon) / (1.3 * 2.6)) * 0.75;
        const share = Math.min(1, MAX_GRAVES / Math.max(1, estimate));
        const section = new Map<string, boolean>();
        let graves = 0;
        let cypresses = 0;
        for (const { i, j, p } of g.out) {
          if (!inRegion(p)) continue;
          const pathRow = j % 7 === 6;
          const pathCol = i % 16 === 15;
          if (!inAny(p, inner)) continue;
          if (pathRow || pathCol) {
            // Cypresses along the paths, a few metres apart.
            if (
              pathRow &&
              i % 3 === 1 &&
              cypresses < MAX_CYPRESSES &&
              rng.chance(0.7) &&
              free(p, 1.5)
            ) {
              props.push(
                prop(`${a.id}-cy${i}-${j}`, 'cypress', p, rng.range(0, 6.28), rng.range(0.8, 1.15)),
              );
              cypresses++;
            }
            continue;
          }
          // Trees among the graves too: pines, planes, the odd cypress.
          if (rng.chance(0.035) && free(p, 1.5)) {
            props.push(
              prop(
                `${a.id}-t${i}-${j}`,
                rng.chance(0.3) ? 'cypress' : 'tree',
                p,
                rng.range(0, 6.28),
                rng.range(0.8, 1.2),
              ),
            );
            continue;
          }
          const key = `${Math.floor(i / 16)}:${Math.floor(j / 7)}`;
          if (!section.has(key)) section.set(key, rng.chance(share));
          if (!section.get(key) || graves >= MAX_GRAVES || rng.chance(0.12) || !free(p, 1))
            continue;
          props.push(
            prop(
              `${a.id}-g${i}-${j}`,
              'grave',
              p,
              heading + (rng.chance(0.5) ? 0 : Math.PI),
              rng.range(0.92, 1.08),
            ),
          );
          graves++;
        }
        break;
      }
      case 'construction': {
        if (area < 200) break;
        wallRound(a, 'wall', 2.2, rng.pick(['#2f5f8a', '#e8e6df', '#3d6b4a', '#c9c4b8']), false);
        if (area < 1500) break;
        // A tower crane (two on a large site), where its mast has free ground.
        const want = area > 12000 ? 2 : 1;
        const g = grid(a.polygon, 6, 6);
        const deep = inset(a, 6);
        // Near the middle of the site first.
        const spots = g.out
          .filter(({ p }) => inAny(p, deep) && free(p, 4))
          .map((s) => ({
            ...s,
            key: Math.abs(s.i - g.nu / 2) + Math.abs(s.j - g.nv / 2) + rng.next(),
          }))
          .sort((x, y) => x.key - y.key);
        const placed: Vec2[] = [];
        for (const { p } of spots) {
          if (placed.length >= want) break;
          if (placed.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 40)) continue;
          props.push(
            prop(
              `${a.id}-crane${placed.length}`,
              'crane',
              p,
              rng.range(0, 6.28),
              rng.range(0.85, 1.1),
            ),
          );
          placed.push(p);
        }
        break;
      }
      case 'military': {
        if (area < 500) break;
        wallRound(a, 'wall', 2.8, rng.pick(['#d8d2c4', '#cfc9bb']), true);
        break;
      }
      case 'harbour': {
        if (area < 8000) break;
        // Blocks of 4 × 6 containers (6.1 × 2.44 m) with 12 m lanes, 1–4 high.
        const inner = inset(a, 15);
        const g = grid(a.polygon, 6.4, 2.6);
        const heading = Math.atan2(g.axis[1], g.axis[0]);
        // A port is quays, sheds and open apron as well: container yards of
        // ~110 × 100 m here and there (about the cap's worth in a tile), filled
        // block by block — not one corner filled up, not blocks strewn about.
        const slots = (Math.min(area, 1.2e6) / (6.4 * 2.6)) * (24 / 48);
        const share = Math.min(0.6, MAX_CONTAINERS / 2.5 / slots);
        let n = 0;
        for (const { i, j, p } of g.out) {
          if (!inRegion(p)) continue;
          if (i % 6 >= 4 || j % 8 >= 6) continue;
          const yard = new Rng(`${a.id}-y${Math.floor(i / 18)}-${Math.floor(j / 40)}`);
          if (!yard.chance(share)) continue;
          if (n >= MAX_CONTAINERS || !inAny(p, inner) || !free(p, 3)) continue;
          const high = 1 + Math.floor(new Rng(`${a.id}-c${i}-${j}`).next() * 4);
          for (let k = 0; k < high && n < MAX_CONTAINERS; k++, n++)
            props.push(prop(`${a.id}-c${i}-${j}-${k}`, 'container', p, heading, 1, k * 2.6));
        }
        break;
      }
      case 'marketplace': {
        if (area < 150) break;
        // Stalls 3.1 m apart, back to back in pairs, 3.5 m aisles between the pairs.
        const inner = inset(a, 1.5);
        const g = grid(a.polygon, 3.1, 1);
        let n = 0;
        for (const { i, j, p } of g.out) {
          if (!inRegion(p)) continue;
          // Rows of the 8.5 m pattern: stall front at 0–2.5, back at 2.5–5, aisle 5–8.5.
          const v = j % 9;
          if (v !== 1 && v !== 4) continue;
          if (n >= MAX_STALLS || !inAny(p, inner) || !free(p, 1.5) || rng.chance(0.08)) continue;
          const face = v === 1 ? -1 : 1;
          props.push(
            prop(
              `${a.id}-s${i}-${j}`,
              'stall',
              p,
              Math.atan2(g.normal[1] * face, g.normal[0] * face),
              1,
            ),
          );
          n++;
        }
        break;
      }
      case 'substation': {
        if (area < 60) break;
        wallRound(a, 'mesh', 2.4, '#9aa0a5', area > 400);
        const center = orientedBox(a.polygon.outer as Vec2[]);
        const ax = center.axis;
        const nx: Vec2 = [-ax[1], ax[0]];
        const at = (u: number, v: number): Vec2 => [
          center.center[0] + ax[0] * u + nx[0] * v,
          center.center[1] + ax[1] * u + nx[1] * v,
        ];
        const along = Math.atan2(ax[1], ax[0]);
        const deep = inset(a, 3);
        const ok = (p: Vec2, clear: number) => inRegion(p) && inAny(p, deep) && free(p, clear);
        // A small (distribution) substation: one transformer.
        if (area < 400) {
          if (ok(center.center, 1.5))
            props.push(prop(`${a.id}-tr0`, 'transformer', center.center, along));
          break;
        }
        // Transformers in a row on one side, the gantries the lines come in on
        // in rows on the other, along the yard's long axis.
        const L = center.halfLength - 6;
        const W = center.halfWidth;
        let t = 0;
        for (let u = -L; u <= L && t < 12; u += 14) {
          const p = at(u, -W * 0.35);
          if (ok(p, 3)) props.push(prop(`${a.id}-tr${t++}`, 'transformer', p, along));
        }
        let n = 0;
        for (const v of W > 25 ? [W * 0.15, W * 0.5] : [W * 0.3]) {
          for (let u = -L; u <= L && n < 30; u += 9) {
            const p = at(u, v);
            if (ok(p, 2)) props.push(prop(`${a.id}-ga${n++}`, 'gantry', p, along + Math.PI / 2));
          }
        }
        break;
      }
      case 'airport': {
        // The security fence round the airfield (no gate: its gates are mapped
        // where the roads go in, and the fence stops at every road).
        if (area < 20000) break;
        wallRound(a, 'mesh', 2.8, '#9aa0a5', false);
        break;
      }
      case 'power_plant': {
        if (area < 500) break;
        wallRound(a, 'mesh', 2.4, '#9aa0a5', true);
        if (area < 3000) break;
        // One stack, where it has free ground nearest the middle.
        const g = grid(a.polygon, 8, 8);
        const deep = inset(a, 10);
        const spot = g.out
          .filter(({ p }) => inAny(p, deep) && free(p, 4))
          .map((s) => ({ ...s, key: Math.abs(s.i - g.nu / 2) + Math.abs(s.j - g.nv / 2) }))
          .sort((x, y) => x.key - y.key)[0];
        if (spot) props.push(prop(`${a.id}-stack`, 'stack', spot.p, 0));
        break;
      }
      default:
        break;
    }
  }
  return { props, fences };
}
