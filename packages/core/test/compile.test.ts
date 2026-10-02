import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileCity } from '../src/compile';
import {
  LocalProjection,
  closestOnSegment,
  pointInRing,
  ringCentroid,
  simplifyRing,
} from '../src/geo';
import { bufferPolyline, intersection, totalArea, union } from '../src/poly';
import { PROP_RADIUS } from '../src/props';
import { isVehicular } from '../src/roads';
import { terrainHeightAt } from '../src/terrain';
import type { CityModel, CitySource, OsmElement, Polygon, TerrainGrid } from '../src/types';

const ORIGIN = { lon: 31.79, lat: 41.45 };
const proj = new LocalProjection(ORIGIN);
const ll = (x: number, y: number): [number, number] => {
  const p = proj.inverse(x, y);
  return [p.lon, p.lat];
};

/** 400 m × 400 m: a street grid (two E–W, two N–S residential streets) and one building on a street. */
function gridSource(): CitySource {
  const way = (
    id: number,
    pts: [number, number][],
    tags: Record<string, string>,
    nodes: number[],
  ): OsmElement => ({
    type: 'way',
    id,
    tags,
    nodes,
    geometry: pts.map(([x, y]) => ll(x, y)),
  });
  const res = { highway: 'residential' };
  const osm: OsmElement[] = [
    way(
      1,
      [
        [-200, -60],
        [0, -60],
        [200, -60],
      ],
      res,
      [10, 11, 12],
    ),
    way(
      2,
      [
        [-200, 60],
        [0, 60],
        [200, 60],
      ],
      res,
      [20, 21, 22],
    ),
    way(
      3,
      [
        [-60, -200],
        [-60, -60],
        [-60, 60],
        [-60, 200],
      ],
      res,
      [30, 31, 32, 33],
    ),
    way(
      4,
      [
        [60, -200],
        [60, -60],
        [60, 60],
        [60, 200],
      ],
      res,
      [40, 41, 42, 43],
    ),
    // Building whose south edge sits 3 m into the carriageway of street 1.
    way(
      100,
      [
        [-20, -63],
        [10, -63],
        [10, -45],
        [-20, -45],
        [-20, -63],
      ],
      { building: 'apartments' },
      [1, 2, 3, 4, 1],
    ),
  ];
  const [w, s] = ll(-200, -200);
  const [e, n] = ll(200, 200);
  return { name: 'test grid', bbox: [w, s, e, n], attribution: [], osm };
}

const carriageway = (m: CityModel) =>
  union(
    ...m.roads
      .filter((r) => r.formsBlocks && r.cls !== 'pedestrian')
      .map((r) => bufferPolyline(r.centerline, r.width / 2)),
  );

describe('compileCity', () => {
  it('is deterministic', () => {
    const a = compileCity(gridSource());
    const b = compileCity(gridSource());
    const strip = (m: CityModel) => JSON.stringify({ ...m, stats: { ...m.stats, compileMs: 0 } });
    expect(strip(a)).toBe(strip(b));
  });

  it('clips a building off the carriageway and records the fix', () => {
    const m = compileCity(gridSource(), { infill: false, decorate: false, suggest: false });
    const b = m.buildings.find((x) => x.osmId === 100);
    expect(b).toBeDefined();
    const fix = m.fixes.find((f) => f.targetId === b!.id && f.kind === 'road-overlap');
    expect(fix).toBeDefined();
    expect(fix!.removedArea).toBeGreaterThan(20);
    expect(totalArea(intersection([b!.footprint], carriageway(m)))).toBeLessThan(0.5);
  });

  it('forms city blocks between the streets and fills them without overlaps', () => {
    const m = compileCity(gridSource());
    // The central block (between the four streets) exists.
    expect(
      m.blocks.some((k) => k.polygon.outer.some(([x, y]) => Math.abs(x) < 60 && Math.abs(y) < 60)),
    ).toBe(true);
    const synthetic = m.buildings.filter((b) => b.source === 'synthetic');
    expect(synthetic.length).toBeGreaterThan(10);
    const road = carriageway(m);
    const observed = m.buildings.filter((b) => b.source === 'osm').map((b) => b.footprint);
    for (const b of synthetic) {
      expect(totalArea(intersection([b.footprint], road))).toBeLessThan(0.05);
      expect(totalArea(intersection([b.footprint], observed))).toBeLessThan(0.05);
    }
    // Synthetic buildings do not overlap each other.
    const sum = synthetic.reduce((s, b) => s + totalArea([b.footprint]), 0);
    expect(Math.abs(totalArea(union(synthetic.map((b) => b.footprint))) - sum)).toBeLessThan(1);
  });

  it('lets an authoritative register be the only building source around its buildings', () => {
    const ring = (
      [
        [-30, -30],
        [-10, -30],
        [-10, -10],
        [-30, -10],
        [-30, -30],
      ] as [number, number][]
    ).map(([x, y]) => ll(x, y));
    const withRegister = (authoritative: boolean): CitySource => ({
      ...gridSource(),
      features: [
        {
          ref: 'maks:1',
          source: 'maks',
          priority: 10,
          authoritative,
          kind: 'building',
          geometry: { type: 'Polygon', coordinates: [ring] },
          tags: { 'building:levels': 4 },
        },
      ],
    });
    // Well inside the 100 m reach of the register building.
    const near = (m: CityModel) =>
      m.buildings.filter((b) => {
        const [x, y] = ringCentroid(b.footprint.outer);
        return Math.abs(x + 20) < 90 && Math.abs(y + 20) < 90;
      });
    const ruled = compileCity(withRegister(true));
    expect(near(ruled).map((b) => b.source)).toEqual(['maks']);
    expect(ruled.stats.buildingsSuperseded).toBeGreaterThan(0);
    // Without the flag OSM and procedural buildings fill the same area.
    const open = compileCity(withRegister(false));
    expect(near(open).filter((b) => b.source !== 'maks').length).toBeGreaterThan(5);
  });

  it('lets an authoritative road network replace other sources where it has data', () => {
    // The municipality's copy of street 1 (y = -60), drawn 2 m off the OSM line.
    const line = (
      [
        [-200, -58],
        [0, -58],
        [200, -58],
      ] as [number, number][]
    ).map(([x, y]) => ll(x, y));
    const withNetwork = (authoritative: boolean): CitySource => ({
      ...gridSource(),
      features: [
        {
          ref: 'belediye:1',
          source: 'belediye',
          priority: 10,
          authoritative,
          kind: 'road',
          geometry: { type: 'LineString', coordinates: line },
          tags: { highway: 'residential', name: 'Kurum sokağı' },
        },
      ],
    });
    const along = (m: CityModel, y: number) =>
      m.roads.filter((r) => r.centerline.every(([, py]) => Math.abs(py - y) < 5));
    const ruled = compileCity(withNetwork(true), { infill: false, decorate: false });
    expect(along(ruled, -59).map((r) => r.ref)).toEqual(['belediye:1']);
    // Streets the network does not cover stay.
    expect(along(ruled, 60)).toHaveLength(1);
    const open = compileCity(withNetwork(false), { infill: false, decorate: false });
    expect(along(open, -59)).toHaveLength(2);
  });

  it('marks every synthetic building and inferred level as such', () => {
    const m = compileCity(gridSource());
    for (const b of m.buildings) {
      if (b.source === 'synthetic') expect(b.provenance.footprint).toBe('synthetic');
      else expect(b.provenance.footprint).toBe('observed');
    }
    expect(m.buildings.find((b) => b.osmId === 100)!.provenance.levels).toBe('inferred');
  });
});

describe('terrainHeightAt', () => {
  it('reproduces grid heights at vertices and is linear inside a triangle', () => {
    const t: TerrainGrid = {
      minX: 0,
      minY: 0,
      cellSize: 10,
      cols: 2,
      rows: 2,
      heights: [0, 10, 20, 40],
      seaLevel: 0,
    };
    expect(terrainHeightAt(t, 0, 0)).toBeCloseTo(0);
    expect(terrainHeightAt(t, 10, 0)).toBeCloseTo(10, 2);
    expect(terrainHeightAt(t, 0, 10)).toBeCloseTo(20, 2);
    // Lower-right triangle (u >= v): h = h00 + (h10 - h00) u + (h11 - h10) v
    expect(terrainHeightAt(t, 6, 2)).toBeCloseTo(0 + 10 * 0.6 + 30 * 0.2, 2);
  });
});

describe('simplifyRing', () => {
  it('drops near-collinear vertices of a curved block edge but keeps corners', () => {
    const ring: [number, number][] = [];
    for (let x = 0; x <= 50; x += 2) ring.push([x, Math.sin(x / 50) * 0.3]);
    ring.push([50, 40], [0, 40]);
    const out = simplifyRing(ring, 1);
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out).toContainEqual([50, 40]);
    expect(out).toContainEqual([0, 40]);
  });
});

const FIXTURE = resolve(__dirname, 'fixtures/zonguldak-merkez.json');

describe.skipIf(!existsSync(FIXTURE))('Zonguldak fixture', () => {
  it('keeps synthetic buildings off roads and observed buildings', () => {
    const m = compileCity(JSON.parse(readFileSync(FIXTURE, 'utf8')) as CitySource);
    // Bounding-box prefilter: checking each building against the whole network is quadratic.
    type Boxed = { poly: Polygon; box: [number, number, number, number] };
    const boxOf = (p: Polygon): [number, number, number, number] => [
      Math.min(...p.outer.map((q) => q[0])),
      Math.min(...p.outer.map((q) => q[1])),
      Math.max(...p.outer.map((q) => q[0])),
      Math.max(...p.outer.map((q) => q[1])),
    ];
    const boxed = (polys: Polygon[]): Boxed[] => polys.map((poly) => ({ poly, box: boxOf(poly) }));
    const roads = boxed(
      m.roads
        .filter((r) => r.formsBlocks && r.cls !== 'pedestrian' && r.grade === 'ground')
        .flatMap((r) => bufferPolyline(r.centerline, r.width / 2)),
    );
    const observed = boxed(
      m.buildings.filter((b) => b.source !== 'synthetic').map((b) => b.footprint),
    );
    const near = (list: Boxed[], b: [number, number, number, number]) =>
      list
        .filter((x) => x.box[2] >= b[0] && x.box[0] <= b[2] && x.box[3] >= b[1] && x.box[1] <= b[3])
        .map((x) => x.poly);
    const bad = m.buildings
      .filter((b) => b.source === 'synthetic')
      .filter((b) => {
        const bb = boxOf(b.footprint);
        const r = near(roads, bb);
        const o = near(observed, bb);
        return (
          (r.length > 0 && totalArea(intersection([b.footprint], union(r))) > 0.1) ||
          (o.length > 0 && totalArea(intersection([b.footprint], o)) > 0.1)
        );
      });
    expect(bad.map((b) => b.id)).toEqual([]);
    expect(m.stats.buildingsObserved).toBeGreaterThan(200);
  }, 60_000);

  it('lets no ground prop intersect a building or another generated prop', () => {
    const m = compileCity(JSON.parse(readFileSync(FIXTURE, 'utf8')) as CitySource);
    const ground = m.props.filter((p) => !p.buildingId && PROP_RADIUS[p.kind] > 0);
    const radius = (p: (typeof ground)[number]) => PROP_RADIUS[p.kind] * p.scale;
    // Brute-force distance to footprints (bounding-box prefilter only).
    const fps = m.buildings.map((b) => {
      const xs = b.footprint.outer.map((q) => q[0]);
      const ys = b.footprint.outer.map((q) => q[1]);
      return {
        f: b.footprint,
        box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      };
    });
    const wallDistance = (p: [number, number], r: number) => {
      let best = Infinity;
      for (const { f, box } of fps) {
        if (p[0] < box[0] - r || p[0] > box[2] + r || p[1] < box[1] - r || p[1] > box[3] + r)
          continue;
        if (pointInRing(p, f.outer)) return 0;
        for (const ring of [f.outer, ...f.holes]) {
          for (let k = 0; k < ring.length; k++) {
            best = Math.min(best, closestOnSegment(p, ring[k], ring[(k + 1) % ring.length]).d);
          }
        }
      }
      return best;
    };
    const intoBuilding = ground.filter((p) => {
      const at: [number, number] = [p.position[0], p.position[1]];
      const d = wallDistance(at, radius(p));
      // Observed furniture stays where the data puts it, unless that is inside a building.
      return p.provenance === 'observed' && p.kind !== 'tree' ? d === 0 : d < radius(p) - 1e-6;
    });
    expect(intoBuilding.map((p) => p.id)).toEqual([]);
    const generated = ground.filter((p) => p.provenance !== 'observed');
    const overlapping: string[] = [];
    for (let i = 0; i < generated.length; i++) {
      for (let j = i + 1; j < generated.length; j++) {
        const a = generated[i];
        const b = generated[j];
        const both = a.kind === 'tree' && b.kind === 'tree' ? 0.75 : 1;
        const d = Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1]);
        if (d < both * (radius(a) + radius(b)) - 1e-6) overlapping.push(`${a.id}|${b.id}`);
      }
    }
    expect(overlapping).toEqual([]);
    expect(m.stats.propsShrunk + m.stats.propsDropped).toBeGreaterThan(0);
  }, 120_000);

  it('places no street furniture on a carriageway and no park tree in a street', () => {
    const m = compileCity(JSON.parse(readFileSync(FIXTURE, 'utf8')) as CitySource);
    // Signed distance of a point to a road band (negative = inside), brute force.
    const segs = m.roads
      .filter((r) => r.grade === 'ground')
      .flatMap((r) => r.centerline.slice(1).map((b, k) => ({ r, a: r.centerline[k], b })));
    const inside = (p: [number, number], reach: (r: (typeof segs)[number]['r']) => number) =>
      segs.some((s) => {
        const w = reach(s.r);
        return w > 0 && closestOnSegment(p, s.a, s.b).d < w;
      });
    const ground = m.props.filter((p) => !p.buildingId);
    expect(ground.length).toBeGreaterThan(500);
    const onCarriageway = ground.filter(
      (p) =>
        p.provenance !== 'observed' &&
        inside([p.position[0], p.position[1]], (r) => (isVehicular(r.cls) ? r.width / 2 : 0)),
    );
    expect(onCarriageway.map((p) => p.id)).toEqual([]);
    // Park / garden trees (scattered over green areas) stay out of the whole street corridor.
    const greenTrees = ground.filter((p) => p.kind === 'tree' && /^(ga:|yard)/.test(p.id));
    expect(greenTrees.length).toBeGreaterThan(20);
    const inStreet = greenTrees.filter((p) =>
      inside([p.position[0], p.position[1]], (r) => r.width / 2 + r.sidewalk),
    );
    expect(inStreet.map((p) => p.id)).toEqual([]);
  }, 60_000);
});
