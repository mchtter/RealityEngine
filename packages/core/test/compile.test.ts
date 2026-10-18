import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runwayMarkings } from '../src/amenities';
import { compileCity } from '../src/compile';
import { CutGround, STATION_PIT, STATION_PIT_LENGTH } from '../src/cuttings';
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
import { RoadIndex } from '../src/spatial';
import { LAND_FLOOR, terrainHeightAt } from '../src/terrain';
import type { CityModel, CitySource, OsmElement, Polygon, TerrainGrid } from '../src/types';
import { validateCity } from '../src/validate';

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
  it('keeps a building under the ground off the surface, with its entrances', () => {
    const src = gridSource();
    const square = (x: number, y: number, r: number) => [
      ll(x - r, y - r),
      ll(x + r, y - r),
      ll(x + r, y + r),
      ll(x - r, y + r),
      ll(x - r, y - r),
    ];
    src.features = [
      ...(src.features ?? []),
      {
        ref: 'osm:w-station',
        source: 'osm',
        priority: 0,
        kind: 'building' as const,
        geometry: { type: 'Polygon' as const, coordinates: [square(30, 35, 12)] },
        tags: { building: 'train_station', layer: '-1' },
      },
    ];
    src.features.push({
      ref: 'osm:n-exit',
      source: 'osm',
      priority: 0,
      kind: 'point' as const,
      geometry: { type: 'Point' as const, coordinates: ll(60, 35) },
      tags: { railway: 'subway_entrance', name: 'Çıkış' },
    });
    const m = compileCity(src);
    expect(m.buildings.some((b) => b.ref === 'osm:w-station')).toBe(false);
    expect(m.stats.buildingsUnderground).toBe(1);
    // It is kept as an underground structure, and the entrance leads into it.
    expect(m.underground?.structures.map((s) => [s.ref, s.layer])).toEqual([['osm:w-station', -1]]);
    expect(m.underground?.entrances).toMatchObject([
      { ref: 'osm:n-exit', name: 'Çıkış', station: 'osm:w-station' },
    ]);
    // Its stair pit opens the ground: inside it the ground falls to the concourse.
    const e = m.underground!.entrances[0];
    const ground = new CutGround(m.terrain, m.terrainCut);
    const into = (d: number): [number, number] => [
      e.position[0] + Math.cos(e.heading) * d,
      e.position[1] + Math.sin(e.heading) * d,
    ];
    expect(ground.inTrench(...into(STATION_PIT_LENGTH - 1))).toBe(true);
    expect(e.position[2] - ground.heightAt(...into(STATION_PIT_LENGTH - 1))).toBeGreaterThan(
      STATION_PIT.depth - 1,
    );
    // The stairs never run away from the station (here it lies abeam of the street: either way).
    const st = ringCentroid(m.underground!.structures[0].footprint.outer);
    expect(
      (st[0] - e.position[0]) * Math.cos(e.heading) + (st[1] - e.position[1]) * Math.sin(e.heading),
    ).toBeGreaterThan(-1e-6);

    // A passage from the pit's door into the station, ending inside it at its concourse.
    const s = m.underground!.structures[0];
    const end = e.passage![e.passage!.length - 1];
    expect(e.passage![0][2]).toBeCloseTo(e.position[2] - STATION_PIT.depth, 1);
    expect(end[2]).toBeCloseTo(s.floorZ, 5);
    expect(pointInRing([end[0], end[1]], s.footprint.outer)).toBe(true);
    // The station's wall is left open where the passage comes through.
    expect(s.doors).toHaveLength(1);
    expect(Math.hypot(s.doors![0][0] - e.passage![1][0], s.doors![0][1] - e.passage![1][1])).toBe(
      0,
    );
  });

  it('opens every surface over a stair pit dug in the sidewalk', () => {
    const src = gridSource();
    const square = (x: number, y: number, r: number) => [
      ll(x - r, y - r),
      ll(x + r, y - r),
      ll(x + r, y + r),
      ll(x - r, y + r),
      ll(x - r, y - r),
    ];
    src.features = [
      ...(src.features ?? []),
      {
        ref: 'osm:w-station',
        source: 'osm',
        priority: 0,
        kind: 'building' as const,
        geometry: { type: 'Polygon' as const, coordinates: [square(60, 35, 12)] },
        tags: { building: 'train_station', layer: '-1' },
      },
      // A park's lawn round the entrance.
      {
        ref: 'osm:w-park',
        source: 'osm',
        priority: 0,
        kind: 'area' as const,
        geometry: {
          type: 'Polygon' as const,
          coordinates: [[ll(20, 30), ll(80, 30), ll(80, 58), ll(20, 58), ll(20, 30)]],
        },
        tags: { leisure: 'park' },
      },
      // On the street's edge: the pit runs along it, in its sidewalk.
      {
        ref: 'osm:n-exit',
        source: 'osm',
        priority: 0,
        kind: 'point' as const,
        geometry: { type: 'Point' as const, coordinates: ll(40, 56) },
        tags: { railway: 'subway_entrance' },
      },
    ];
    const m = compileCity(src);
    const e = m.underground!.entrances[0];
    // No surface of any kind (sidewalk, footway, a square's paving) over the pit.
    const street = m.surfaces;
    for (const d of [2, STATION_PIT_LENGTH / 2, STATION_PIT_LENGTH - 1]) {
      const q: [number, number] = [
        e.position[0] + Math.cos(e.heading) * d,
        e.position[1] + Math.sin(e.heading) * d,
      ];
      const lid = street.filter((sf) =>
        sf.polygons.some((p) => pointInRing(q, p.outer) && !p.holes.some((h) => pointInRing(q, h))),
      );
      expect(lid.map((sf) => sf.kind)).toEqual([]);
      const lawn = m.areas.filter(
        (a) => pointInRing(q, a.polygon.outer) && !a.polygon.holes.some((h) => pointInRing(q, h)),
      );
      expect(lawn.map((a) => a.kind)).toEqual([]);
    }
  });

  it('takes a platform under its concourse by stairs, and keeps the metro line in its tunnel', () => {
    const src = gridSource();
    const square = (x: number, y: number, rx: number, ry: number) => [
      ll(x - rx, y - ry),
      ll(x + rx, y - ry),
      ll(x + rx, y + ry),
      ll(x - rx, y + ry),
      ll(x - rx, y - ry),
    ];
    src.features = [
      ...(src.features ?? []),
      {
        ref: 'osm:w-hall',
        source: 'osm',
        priority: 0,
        kind: 'building' as const,
        geometry: { type: 'Polygon' as const, coordinates: [square(0, 30, 40, 20)] },
        tags: { building: 'train_station', layer: '-1' },
      },
      {
        ref: 'osm:w-platform',
        source: 'osm',
        priority: 0,
        kind: 'building' as const,
        geometry: { type: 'Polygon' as const, coordinates: [square(0, 30, 50, 4)] },
        tags: { building: 'platform', layer: '-2' },
      },
      {
        ref: 'osm:w-metro',
        source: 'osm',
        priority: 0,
        kind: 'road' as const,
        geometry: {
          type: 'LineString' as const,
          coordinates: [ll(-150, 36), ll(150, 36)],
        },
        tags: { highway: 'subway', tunnel: 'yes', layer: '-2' },
      },
      // The other side's track tagged a layer lower than its platform (as at Kızılay).
      {
        ref: 'osm:w-metro-low',
        source: 'osm',
        priority: 0,
        kind: 'road' as const,
        geometry: { type: 'LineString' as const, coordinates: [ll(-150, 24), ll(150, 24)] },
        tags: { highway: 'subway', tunnel: 'yes', layer: '-3' },
      },
    ];
    const m = compileCity(src);
    const hall = m.underground!.structures.find((s) => s.ref === 'osm:w-hall')!;
    const platform = m.underground!.structures.find((s) => s.ref === 'osm:w-platform')!;
    // A level per layer: the platform 6 m under the concourse.
    expect(hall.floorZ - platform.floorZ).toBeCloseTo(6, 0);
    // Stairs from the concourse floor down to the platform, the floor open over them.
    expect(platform.stairs!.from[2]).toBeCloseTo(hall.floorZ, 5);
    expect(platform.stairs!.to[2]).toBeCloseTo(platform.floorZ, 5);
    expect(hall.openings).toHaveLength(1);
    // The metro line kept under the ground, at rail level below the platform.
    const track = m.underground!.tracks!.find((t) => t.ref === 'osm:w-metro')!;
    const mid = track.path.reduce((a, q) => (Math.abs(q[0]) < Math.abs(a[0]) ? q : a));
    expect(platform.floorZ - mid[2]).toBeGreaterThan(0.5);
    expect(platform.floorZ - mid[2]).toBeLessThan(2);
    // Beside the platform the lower-tagged track runs at its level, and the mismatch is reported.
    const low = m.underground!.tracks!.find((t) => t.ref === 'osm:w-metro-low')!;
    const lowMid = low.path.reduce((a, q) => (Math.abs(q[0]) < Math.abs(a[0]) ? q : a));
    expect(platform.floorZ - lowMid[2]).toBeCloseTo(1.1, 5);
    expect(validateCity(m).counts['underground.level'] ?? 0).toBe(1);
  });

  it('digs a platform a level under its concourse on a slope too', () => {
    const square = (x: number, y: number, rx: number, ry: number) => [
      ll(x - rx, y - ry),
      ll(x + rx, y - ry),
      ll(x + rx, y + ry),
      ll(x - rx, y + ry),
      ll(x - rx, y - ry),
    ];
    // Ground rising 10 cm a metre: the platform's middle lies 3 m higher than the concourse's.
    const [west, south] = ll(-400, -400);
    const [east, north] = ll(400, 400);
    const heights = Array.from({ length: 81 * 81 }, (_, k) => 50 + Math.floor(k / 81));
    const terrain = { source: 'test', west, east, north, south, cols: 81, rows: 81, heights };
    const building = (ref: string, ring: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'building' as const,
      geometry: { type: 'Polygon' as const, coordinates: [ring] },
      tags,
    });
    const m = compileCity({
      ...gridSource(),
      osm: [],
      terrain,
      features: [
        building('osm:w-hall', square(0, 0, 40, 20), { building: 'train_station', layer: '-1' }),
        building('osm:w-platform', square(0, 30, 50, 4), { building: 'platform', layer: '-2' }),
      ],
    });
    const ug = m.underground!;
    const hall = ug.structures.find((s) => s.ref === 'osm:w-hall')!;
    const platform = ug.structures.find((s) => s.ref === 'osm:w-platform')!;
    expect(hall.floorZ - platform.floorZ).toBeCloseTo(6, 5);
  });

  it('leads an entrance into the concourse, not onto the platform whose middle is nearer', () => {
    const square = (x: number, y: number, rx: number, ry: number) => [
      ll(x - rx, y - ry),
      ll(x + rx, y - ry),
      ll(x + rx, y + ry),
      ll(x - rx, y + ry),
      ll(x - rx, y - ry),
    ];
    const building = (ref: string, ring: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'building' as const,
      geometry: { type: 'Polygon' as const, coordinates: [ring] },
      tags,
    });
    const src = gridSource();
    src.features = [
      ...(src.features ?? []),
      building('osm:w-hall', square(0, 30, 60, 20), { building: 'train_station', layer: '-1' }),
      building('osm:w-platform', square(0, 15, 50, 4), { building: 'platform', layer: '-2' }),
      {
        ref: 'osm:n-entrance',
        source: 'osm',
        priority: 0,
        kind: 'point' as const,
        geometry: { type: 'Point' as const, coordinates: ll(56, 12) },
        tags: { railway: 'subway_entrance' },
      },
    ];
    const m = compileCity(src);
    const ug = m.underground!;
    const hall = ug.structures.find((s) => s.ref === 'osm:w-hall')!;
    const e = ug.entrances.find((x) => x.ref === 'osm:n-entrance')!;
    expect(e.station).toBe('osm:w-hall');
    expect(e.passage!.at(-1)![2]).toBeCloseTo(hall.floorZ, 5);
  });

  it("keeps a mall's name for its signs, not an apartment block's", () => {
    const square = (x: number, y: number, rx: number, ry: number) => [
      ll(x - rx, y - ry),
      ll(x + rx, y - ry),
      ll(x + rx, y + ry),
      ll(x - rx, y + ry),
      ll(x - rx, y - ry),
    ];
    const building = (ref: string, ring: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'building' as const,
      geometry: { type: 'Polygon' as const, coordinates: [ring] },
      tags,
    });
    const src = gridSource();
    src.features = [
      ...(src.features ?? []),
      building('osm:w-mall', square(100, 0, 40, 25), {
        building: 'retail',
        shop: 'mall',
        'building:levels': '6',
        name: 'Kent AVM',
      }),
      building('osm:w-flats', square(-100, 0, 10, 8), {
        building: 'apartments',
        'building:levels': '5',
        name: 'Gül Apartmanı',
      }),
    ];
    const m = compileCity(src);
    const mall = m.buildings.find((b) => b.ref === 'osm:w-mall')!;
    const flats = m.buildings.find((b) => b.ref === 'osm:w-flats')!;
    expect(mall.form).toBe('box');
    expect(mall.name).toBe('Kent AVM');
    expect(flats.name).toBeUndefined();
  });

  it('moves the platform stairs clear of a fare gate mapped over them', () => {
    const square = (x: number, y: number, rx: number, ry: number) => [
      ll(x - rx, y - ry),
      ll(x + rx, y - ry),
      ll(x + rx, y + ry),
      ll(x - rx, y + ry),
      ll(x - rx, y - ry),
    ];
    const building = (ref: string, ring: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'building' as const,
      geometry: { type: 'Polygon' as const, coordinates: [ring] },
      tags,
    });
    const src = gridSource();
    src.features = [
      ...(src.features ?? []),
      building('osm:w-hall', square(0, 30, 40, 20), { building: 'train_station', layer: '-1' }),
      building('osm:w-platform', square(0, 30, 50, 4), { building: 'platform', layer: '-2' }),
      // Right over the platform's middle, where the stairs would go.
      {
        ref: 'osm:n-gate',
        source: 'osm',
        priority: 0,
        kind: 'point' as const,
        geometry: { type: 'Point' as const, coordinates: ll(0, 30) },
        tags: { barrier: 'turnstile' },
      },
    ];
    const m = compileCity(src);
    const platform = m.underground!.structures.find((s) => s.ref === 'osm:w-platform')!;
    const gate = m.underground!.fittings!.find((f) => f.ref === 'osm:n-gate')!;
    const { from, to } = platform.stairs!;
    // The gate line (≈ 2 m to each side) is clear of the stairs (1.5 m to each side of their axis).
    const along = (q: number[]) => q[0] - gate.position[0];
    const nearest = Math.min(Math.abs(along(from)), Math.abs(along(to)));
    const crosses = along(from) * along(to) < 0;
    expect(crosses).toBe(false);
    expect(nearest).toBeGreaterThan(4);
  });

  it('stands fare gates on the concourse and runs lifts between the floors they serve', () => {
    const src = gridSource();
    const square = (x: number, y: number, rx: number, ry: number) => [
      ll(x - rx, y - ry),
      ll(x + rx, y - ry),
      ll(x + rx, y + ry),
      ll(x - rx, y + ry),
      ll(x - rx, y - ry),
    ];
    const point = (ref: string, x: number, y: number, tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'point' as const,
      geometry: { type: 'Point' as const, coordinates: ll(x, y) },
      tags,
    });
    src.features = [
      ...(src.features ?? []),
      {
        ref: 'osm:w-hall',
        source: 'osm',
        priority: 0,
        kind: 'building' as const,
        geometry: { type: 'Polygon' as const, coordinates: [square(0, 30, 40, 20)] },
        tags: { building: 'train_station', layer: '-1' },
      },
      {
        ref: 'osm:w-platform',
        source: 'osm',
        priority: 0,
        kind: 'building' as const,
        geometry: { type: 'Polygon' as const, coordinates: [square(0, 30, 50, 4)] },
        tags: { building: 'platform', layer: '-2' },
      },
      // Over the platform too: the gate stands on the concourse, not down there.
      point('osm:n-gate', -20, 31, { barrier: 'turnstile' }),
      point('osm:n-lift', 10, 30, { highway: 'elevator' }),
      point('osm:n-street-lift', 0, 15, { highway: 'elevator' }),
      // Somewhere else (a park gate): not a station's.
      point('osm:n-park-gate', 120, 120, { barrier: 'turnstile' }),
    ];
    const m = compileCity(src);
    const ug = m.underground!;
    const hall = ug.structures.find((s) => s.ref === 'osm:w-hall')!;
    const platform = ug.structures.find((s) => s.ref === 'osm:w-platform')!;
    const byRef = (ref: string) => ug.fittings?.find((f) => f.ref === ref);
    const gate = byRef('osm:n-gate')!;
    expect(gate.kind).toBe('gate');
    expect(gate.position[2]).toBeCloseTo(hall.floorZ, 5);
    // Walked through towards the platform stairs (they start west of the middle).
    const stair = platform.stairs!.from;
    const to = [stair[0] - gate.position[0], stair[1] - gate.position[1]];
    expect(gate.facing[0] * to[0] + gate.facing[1] * to[1]).toBeGreaterThan(0);
    // Over both floors: platform up to the concourse.
    const lift = byRef('osm:n-lift')!;
    expect(lift.position[2]).toBeCloseTo(platform.floorZ, 5);
    expect(lift.top).toBeCloseTo(hall.floorZ, 5);
    expect(lift.surface).toBeUndefined();
    // Over the concourse only: up to the street.
    const street = byRef('osm:n-street-lift')!;
    expect(street.surface).toBe(true);
    expect(street.top! - street.position[2]).toBeCloseTo(6, 0);
    expect(byRef('osm:n-park-gate')).toBeUndefined();
  });

  it('places points of interest on the ground with their kind and name', () => {
    const src = gridSource();
    src.features = [
      ...(src.features ?? []),
      {
        ref: 'osm:n-cafe',
        source: 'osm',
        priority: 0,
        kind: 'point' as const,
        geometry: { type: 'Point' as const, coordinates: ll(30, 35) },
        tags: { poi: 'cafe', name: 'Köşe Kahvesi' },
      },
    ];
    const m = compileCity(src);
    expect(m.pois).toHaveLength(1);
    const p = m.pois![0];
    expect(p).toMatchObject({ kind: 'cafe', name: 'Köşe Kahvesi', ref: 'osm:n-cafe' });
    expect(p.position[0]).toBeCloseTo(30, 0);
    expect(p.position[1]).toBeCloseTo(35, 0);
    // A furniture rule does not take it: no prop came from the point.
    expect(m.props.some((q) => q.id.includes('n-cafe'))).toBe(false);
  });

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

  it('lets national roads yield only to a network that has national roads itself', () => {
    const trunk = (ref: string, y: number, authoritative: boolean, highway = 'trunk') => ({
      ref,
      source: ref.split(':')[0],
      priority: authoritative ? 10 : 0,
      authoritative,
      kind: 'road' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: (
          [
            [-200, y],
            [0, y],
            [200, y],
          ] as [number, number][]
        ).map(([x, yy]) => ll(x, yy)),
      },
      tags: { highway, bridge: 'yes', layer: '1' },
    });
    const along = (m: CityModel) =>
      m.roads.filter((r) => r.centerline.every(([, py]) => Math.abs(py - 141) < 6));
    // Pieces of one road keep its ref with a ~n suffix.
    const sources = (m: CityModel) =>
      [...new Set(along(m).map((r) => r.ref?.split('~')[0]))].sort();
    // A network delivered with its highways (e.g. built from OSM): the other copy goes.
    const full = compileCity(
      {
        ...gridSource(),
        osm: [],
        features: [trunk('kurum:t', 140, true), trunk('osm:t', 142, false)],
      },
      { infill: false, decorate: false },
    );
    expect(sources(full)).toEqual(['kurum:t']);
    // A municipal register without highways keeps the national road of the other source.
    const municipal = compileCity(
      {
        ...gridSource(),
        osm: [],
        features: [trunk('kurum:s', 140, true, 'residential'), trunk('osm:t', 142, false)],
      },
      { infill: false, decorate: false },
    );
    expect(
      along(municipal)
        .map((r) => r.ref)
        .sort(),
    ).toEqual(['kurum:s', 'osm:t']);
  });

  it('gives an authoritative road the grade of a bridge along it and keeps crossings', () => {
    const road = (
      ref: string,
      pts: [number, number][],
      tags: Record<string, string>,
      authoritative = false,
    ) => ({
      ref,
      source: ref.split(':')[0],
      priority: authoritative ? 10 : 0,
      authoritative,
      kind: 'road' as const,
      geometry: { type: 'LineString' as const, coordinates: pts.map(([x, y]) => ll(x, y)) },
      tags,
    });
    const src: CitySource = {
      ...gridSource(),
      osm: [],
      features: [
        // Municipal centreline without grade information.
        road(
          'belediye:1',
          [
            [-150, 0],
            [0, 0],
            [150, 0],
          ],
          { highway: 'tertiary' },
          true,
        ),
        // OSM viaduct along the middle of it, 1.5 m off.
        road(
          'osm:w1',
          [
            [-40, 1.5],
            [40, 1.5],
          ],
          { highway: 'tertiary', bridge: 'yes', layer: '1' },
        ),
        // OSM overpass crossing over it.
        road(
          'osm:w2',
          [
            [0, -30],
            [0, 30],
          ],
          { highway: 'secondary', bridge: 'yes', layer: '1' },
        ),
        // A motorway ramp next to it, not in the register.
        road(
          'osm:w3',
          [
            [-100, 25],
            [100, 25],
          ],
          { highway: 'motorway_link' },
        ),
      ],
    };
    const m = compileCity(src, { infill: false, decorate: false });
    const pieces = m.roads.filter((r) => r.ref?.startsWith('belediye:1'));
    expect(pieces.map((r) => r.grade)).toEqual(['ground', 'bridge', 'ground']);
    expect(pieces[1].layer).toBe(1);
    const refs = m.roads.map((r) => r.ref);
    expect(refs).not.toContain('osm:w1');
    expect(refs).toContain('osm:w2');
    expect(refs).toContain('osm:w3');
  });

  it('leaves the island of a roundabout empty when it infills blocks', () => {
    const R = 30;
    const ring: [number, number][] = [];
    for (let k = 0; k <= 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      ring.push([Math.cos(a) * R, Math.sin(a) * R]);
    }
    const road = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'road' as const,
      geometry: { type: 'LineString' as const, coordinates: pts.map(([x, y]) => ll(x, y)) },
      tags,
    });
    const src: CitySource = {
      ...gridSource(),
      osm: [],
      features: [
        road('osm:rb', ring, { highway: 'secondary', junction: 'roundabout', oneway: 'yes' }),
        road(
          'osm:e',
          [
            [R, 0],
            [200, 0],
          ],
          { highway: 'secondary' },
        ),
        road(
          'osm:w',
          [
            [-R, 0],
            [-200, 0],
          ],
          { highway: 'secondary' },
        ),
        road(
          'osm:n',
          [
            [0, R],
            [0, 200],
          ],
          { highway: 'secondary' },
        ),
        road(
          'osm:s',
          [
            [0, -R],
            [0, -200],
          ],
          { highway: 'secondary' },
        ),
      ],
    };
    const m = compileCity(src, { infill: true, decorate: false });
    const inside = m.buildings.filter((b) => {
      const c = ringCentroid(b.footprint.outer);
      return Math.hypot(c[0], c[1]) < R;
    });
    expect(inside).toHaveLength(0);
    // Blocks around it are still filled.
    expect(m.buildings.filter((b) => b.source === 'synthetic').length).toBeGreaterThan(0);
  });

  it('dresses a fuel station: brand canopy, pumps under it, a sign by the road, a forecourt', () => {
    const feature = (
      ref: string,
      kind: 'point' | 'building',
      geometry:
        | { type: 'Point'; coordinates: [number, number] }
        | { type: 'Polygon'; coordinates: [number, number][][] },
      tags: Record<string, string>,
    ) => ({ ref, source: 'osm', priority: 0, kind, geometry, tags });
    const ring = (pts: [number, number][]) => [[...pts, pts[0]].map(([x, y]) => ll(x, y))];
    // A Shell station on the north side of the E-W street at y = -60: its canopy in the data.
    const withCanopy = compileCity(
      {
        ...gridSource(),
        features: [
          feature(
            'osm:n1',
            'point',
            { type: 'Point', coordinates: ll(-120, -35) },
            { amenity: 'fuel', brand: 'Shell' },
          ),
          feature(
            'osm:w9',
            'building',
            {
              type: 'Polygon',
              coordinates: ring([
                [-130, -40],
                [-110, -40],
                [-110, -30],
                [-130, -30],
              ]),
            },
            { building: 'roof' },
          ),
        ],
      },
      { infill: false, decorate: false },
    );
    const canopy = withCanopy.buildings.find((b) => b.ref === 'osm:w9')!;
    expect(canopy.form).toBe('canopy');
    expect(canopy.palette.wall).toBe('#dd1d21');
    const pumps = withCanopy.props.filter((p) => p.kind === 'fuel-pump');
    expect(pumps.length).toBeGreaterThan(0);
    for (const p of pumps) {
      expect(p.brand).toBe('shell');
      expect(p.position[0]).toBeGreaterThan(-130);
      expect(p.position[0]).toBeLessThan(-110);
      expect(p.position[1]).toBeGreaterThan(-40);
      expect(p.position[1]).toBeLessThan(-30);
    }
    const sign = withCanopy.props.find((p) => p.kind === 'fuel-totem')!;
    // By the street (centreline y = -60), on the station's side.
    expect(sign.position[1]).toBeGreaterThan(-60);
    expect(sign.position[1]).toBeLessThan(-40);
    const concrete = withCanopy.surfaces.find((s) => s.kind === 'concrete')!;
    expect(concrete.polygons.some((p) => pointInRing([-120, -42], p.outer))).toBe(true);

    // A station mapped as a point only: a canopy is laid for it, clear of the street.
    const pointOnly = compileCity(
      {
        ...gridSource(),
        features: [
          feature(
            'osm:n2',
            'point',
            { type: 'Point', coordinates: ll(120, -35) },
            { amenity: 'fuel', brand: 'Opet' },
          ),
        ],
      },
      { infill: false, decorate: false },
    );
    const laid = pointOnly.buildings.find((b) => b.ref === 'fuel:osm:n2')!;
    expect(laid.form).toBe('canopy');
    expect(laid.palette.wall).toBe('#1d3c8f');
    expect(pointOnly.props.filter((p) => p.kind === 'fuel-pump').length).toBeGreaterThan(0);
    const roads = new RoadIndex(pointOnly.roads);
    for (const q of laid.footprint.outer)
      expect(roads.covering(q, (r) => (isVehicular(r.cls) ? r.width / 2 : 0))).toBeNull();

    // A canopy reaching the kerb: the sign stands past its end, not under it.
    const toKerb = compileCity(
      {
        ...gridSource(),
        features: [
          feature(
            'osm:n3',
            'point',
            { type: 'Point', coordinates: ll(-120, -45) },
            { amenity: 'fuel', brand: 'BP' },
          ),
          feature(
            'osm:w8',
            'building',
            {
              type: 'Polygon',
              coordinates: ring([
                [-130, -55],
                [-110, -55],
                [-110, -38],
                [-130, -38],
              ]),
            },
            { building: 'roof' },
          ),
        ],
      },
      { infill: false, decorate: false },
    );
    const roof = toKerb.buildings.find((b) => b.ref === 'osm:w8')!;
    const totem = toKerb.props.find((p) => p.kind === 'fuel-totem')!;
    expect(pointInRing([totem.position[0], totem.position[1]], roof.footprint.outer)).toBe(false);
    const [tx, ty] = totem.position;
    const r = roof.footprint.outer;
    const gap = Math.min(
      ...r.map((a, k) => {
        const b = r[(k + 1) % r.length];
        const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
        const t = Math.max(
          0,
          Math.min(1, ((tx - a[0]) * dx + (ty - a[1]) * dy) / (dx * dx + dy * dy)),
        );
        return Math.hypot(a[0] + dx * t - tx, a[1] + dy * t - ty);
      }),
    );
    expect(gap).toBeGreaterThan(1.9);
  });

  it('draws a stadium as stands round a lined pitch, with no trees on it', () => {
    const area = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'area' as const,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[...pts, pts[0]].map(([x, y]) => ll(x, y))],
      },
      tags,
    });
    const building = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ...area(ref, pts, tags),
      kind: 'building' as const,
    });
    const box = (x: number, y: number): [number, number][] => [
      [-x, -y],
      [x, -y],
      [x, y],
      [-x, y],
    ];
    const m = compileCity(
      {
        ...gridSource(),
        osm: [],
        features: [
          // The stadium footprint mapped over the whole bowl, and its pitch.
          building('osm:stadium', box(80, 60), { building: 'stadium' }),
          area('osm:pitch', box(52, 34), { leisure: 'pitch', sport: 'soccer' }),
          area('osm:grounds', box(110, 90), { leisure: 'stadium' }),
        ],
      },
      { infill: false, decorate: true },
    );
    const stands = m.buildings.filter((b) => b.ref === 'osm:stadium' || b.use === 'stadium');
    expect(stands.length).toBeGreaterThan(0);
    for (const b of stands) {
      expect(b.use).toBe('stadium');
      // No stand over the pitch, and no windows.
      expect(
        b.footprint.holes.length + (pointInRing([0, 0], b.footprint.outer) ? 0 : 1),
      ).toBeGreaterThan(0);
      expect(b.facades.every((f) => f.bays.length === 0)).toBe(true);
    }
    expect(m.surfaces.find((sf) => sf.kind === 'pitch')?.polygons.length).toBeGreaterThan(0);
    expect(m.markings.filter((mk) => mk.kind === 'pitch').length).toBeGreaterThanOrEqual(5);
    const onPitch = m.props.filter(
      (p) => p.kind === 'tree' && Math.abs(p.position[0]) < 108 && Math.abs(p.position[1]) < 88,
    );
    expect(onPitch).toHaveLength(0);
  });

  it('draws a jogging loop round a park as a band, not the park under it', () => {
    const area = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'area' as const,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[...pts, pts[0]].map(([x, y]) => ll(x, y))],
      },
      tags,
    });
    const box = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    const m = compileCity(
      {
        ...gridSource(),
        osm: [],
        features: [
          area('osm:park', box(-90, -90, 90, 90), { leisure: 'park' }),
          // The loop: a closed way with no pitch inside (OSM exports it as a polygon too).
          area('osm:loop', box(-80, -80, 80, 80), { leisure: 'track', sport: 'running' }),
          // A halı saha in the park, inside the loop: the loop is still no stadium track.
          area('osm:halisaha', box(20, 20, 50, 40), { leisure: 'pitch', sport: 'soccer' }),
          { ...area('osm:pavilion', box(-10, -10, 10, 10), { building: 'yes' }), kind: 'building' },
        ],
      },
      { infill: false, decorate: false },
    );
    const track = m.surfaces.find((sf) => sf.kind === 'track');
    const a = totalArea(track?.polygons ?? []);
    // A 6 m band along a 640 m loop, not the 160 × 160 m it encloses.
    expect(a).toBeGreaterThan(2500);
    expect(a).toBeLessThan(5000);
    // The pavilion inside stays a building of the park, not a sports hall.
    const pavilion = m.buildings.find((b) => b.ref === 'osm:pavilion');
    expect(pavilion?.form).not.toBe('shed');
  });

  it('furnishes cemeteries, building sites, markets, harbours and military grounds', () => {
    const area = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'area' as const,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[...pts, pts[0]].map(([x, y]) => ll(x, y))],
      },
      tags,
    });
    const box = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    const m = compileCity(
      {
        ...gridSource(),
        features: [
          area('osm:cemetery', box(-195, -195, -65, -65), { landuse: 'cemetery' }),
          // A morgue / mosque inside the cemetery: graves keep off it.
          {
            ...area('osm:morgue', box(-140, -140, -125, -125), { building: 'yes' }),
            kind: 'building',
          },
          area('osm:site', box(65, -195, 195, -65), { landuse: 'construction' }),
          area('osm:market', box(-195, 65, -65, 195), { amenity: 'marketplace' }),
          area('osm:port', box(65, 65, 195, 195), { landuse: 'harbour' }),
          area('osm:base', box(-50, -35, 50, 50), { landuse: 'military' }),
        ],
      },
      { infill: true, decorate: true },
    );
    const of = (k: string) => m.props.filter((p) => p.kind === k);
    expect(of('grave').length).toBeGreaterThan(300);
    expect(of('cypress').length).toBeGreaterThan(5);
    expect(of('crane').length).toBeGreaterThanOrEqual(1);
    expect(of('stall').length).toBeGreaterThan(20);
    expect(of('container').length).toBeGreaterThan(50);
    const fenceHeights = new Set((m.fences ?? []).map((f) => f.height));
    for (const h of [1.6, 2.2, 2.8]) expect(fenceHeights.has(h)).toBe(true);
    for (const k of ['cemetery', 'earth'])
      expect(totalArea(m.surfaces.find((sf) => sf.kind === k)?.polygons ?? [])).toBeGreaterThan(
        5000,
      );
    // No synthetic infill on these grounds.
    const synthetic = m.buildings.filter((b) => b.provenance.footprint !== 'observed');
    const grounds = [
      box(-195, -195, -65, -65),
      box(65, -195, 195, -65),
      box(-195, 65, -65, 195),
      box(65, 65, 195, 195),
      box(-50, -35, 50, 50),
    ];
    for (const b of synthetic) {
      const c = ringCentroid(b.footprint.outer);
      expect(grounds.some((g) => pointInRing(c, g))).toBe(false);
    }
    // No garden trees on the site, the market or the port (a cemetery has its own trees).
    const civil = grounds.slice(1, 4);
    const trees = m.props.filter((p) => p.kind === 'tree');
    expect(
      trees.filter((p) => civil.some((g) => pointInRing([p.position[0], p.position[1]], g))),
    ).toEqual([]);
    // Nothing laid out stands in a building or on a carriageway.
    const road = carriageway(m);
    for (const p of m.props.filter((q) =>
      ['grave', 'cypress', 'crane', 'stall', 'container'].includes(q.kind),
    )) {
      const at: [number, number] = [p.position[0], p.position[1]];
      expect(m.buildings.some((b) => pointInRing(at, b.footprint.outer))).toBe(false);
      expect(road.some((r) => pointInRing(at, r.outer))).toBe(false);
    }
  });

  it('draws an area given by two sources once', () => {
    const area = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'area' as const,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[...pts, pts[0]].map(([x, y]) => ll(x, y))],
      },
      tags,
    });
    const site: [number, number][] = [
      [-160, -160],
      [-70, -160],
      [-70, -70],
      [-160, -70],
    ];
    const m = compileCity(
      {
        ...gridSource(),
        features: [
          // A city layer's building site and the same site from a raw OSM extract.
          area('osm:osm:w1', site, { landuse: 'construction' }),
          area(
            'osm:w1',
            site.map(([x, y]) => [x + 0.4, y - 0.3] as [number, number]),
            {
              landuse: 'construction',
            },
          ),
          // A different area of the same kind beside it stays.
          area(
            'osm:w2',
            [
              [70, -160],
              [160, -160],
              [160, -70],
              [70, -70],
            ],
            { landuse: 'construction' },
          ),
        ],
      },
      { infill: false, decorate: true },
    );
    expect(m.areas.filter((a) => a.kind === 'construction')).toHaveLength(2);
    expect(m.props.filter((p) => p.kind === 'crane')).toHaveLength(2);
  });

  it('builds towers, minarets and substations from the data', () => {
    const area = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'area' as const,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[...pts, pts[0]].map(([x, y]) => ll(x, y))],
      },
      tags,
    });
    const building = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ...area(ref, pts, tags),
      kind: 'building' as const,
    });
    const box = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    const m = compileCity(
      {
        ...gridSource(),
        features: [
          building('osm:mosque', box(-150, -150, -120, -120), {
            building: 'mosque',
            amenity: 'place_of_worship',
          }),
          building('osm:minaret', box(-116, -126, -113, -123), {
            building: 'yes',
            man_made: 'tower',
            'tower:type': 'minaret',
            height: '18',
          }),
          building('osm:works', box(-180, 100, -120, 140), {
            building: 'industrial',
            height: '10',
          }),
          building('osm:clock', box(-30, 20, -24, 26), {
            building: 'yes',
            man_made: 'tower',
            'tower:type': 'clock_tower',
          }),
          building('osm:trt', box(100, 100, 112, 112), {
            building: 'yes',
            man_made: 'tower',
            'tower:type': 'communication',
            height: '120',
          }),
          area('osm:substation', box(80, -150, 150, -100), { power: 'substation' }),
          area('osm:plant', box(80, 140, 170, 195), { power: 'plant', 'plant:source': 'gas' }),
        ],
      },
      { infill: false, decorate: true },
    );
    const b = (ref: string) => m.buildings.find((x) => x.ref === ref)!;
    const tall = (x: ReturnType<typeof b>) => x.topZ - x.floorZ;
    expect(b('osm:minaret').form).toBe('minaret');
    expect(tall(b('osm:minaret'))).toBeCloseTo(18, 0);
    // The mosque does not get a second, generated minaret.
    expect(b('osm:mosque').minarets).toBe(0);
    // A tagged height is the height, whatever the form's usual storeys.
    expect(tall(b('osm:works'))).toBeCloseTo(10, 0);
    expect(b('osm:clock').form).toBe('clock');
    expect(b('osm:trt').form).toBe('telecom');
    expect(b('osm:trt').towerHeight).toBe(120);
    expect(tall(b('osm:trt'))).toBeLessThan(10);
    const of = (k: string) => m.props.filter((p) => p.kind === k);
    expect(of('transformer').length).toBeGreaterThan(0);
    expect(of('gantry').length).toBeGreaterThan(0);
    expect(of('stack')).toHaveLength(1);
    expect((m.fences ?? []).some((f) => f.style === 'mesh' && f.height === 2.4)).toBe(true);
    expect(
      totalArea(m.surfaces.find((sf) => sf.kind === 'gravel')?.polygons ?? []),
    ).toBeGreaterThan(1500);
  });

  it('reads a school building with buildings inside it as the school grounds', () => {
    const building = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'building' as const,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[...pts, pts[0]].map(([x, y]) => ll(x, y))],
      },
      tags,
    });
    const box = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    const m = compileCity(
      {
        ...gridSource(),
        features: [
          // The whole lise campus mapped as one "building", its two blocks inside it.
          building('osm:campus', box(-190, -190, -70, -70), { building: 'school' }),
          building('osm:block1', box(-170, -170, -130, -140), { building: 'yes' }),
          building('osm:block2', box(-120, -120, -90, -80), { building: 'yes' }),
        ],
      },
      { infill: false, decorate: true },
    );
    expect(m.buildings.find((b) => b.ref === 'osm:campus')).toBeUndefined();
    const blocks = m.buildings.filter((b) => b.ref.startsWith('osm:block'));
    expect(blocks).toHaveLength(2);
    expect(m.areas.some((a) => a.kind === 'school')).toBe(true);
    // Its blocks are school buildings: public, no balconies.
    for (const b of blocks) {
      expect(b.use).toBe('public');
      for (const f of b.facades)
        expect(f.bays.filter((k) => k === 'balcony' || k === 'glazed-balcony')).toEqual([]);
    }
  });

  it('lays out an airfield: runway paint, taxiway and apron, a fence, no infill', () => {
    const area = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'area' as const,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[...pts, pts[0]].map(([x, y]) => ll(x, y))],
      },
      tags,
    });
    const box = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    const m = compileCity(
      {
        ...gridSource(),
        osm: [],
        features: [
          area('osm:airport', box(-198, -198, 198, 198), { aeroway: 'aerodrome' }),
          // The fixture is too small for a runway's paint (≥ 600 m): that is checked below.
          area('osm:taxiway', box(-180, -60, 180, -37), { aeroway: 'taxiway' }),
          area('osm:apron', box(-150, 40, 150, 150), { aeroway: 'apron' }),
        ],
      },
      { infill: true, decorate: true },
    );
    expect(
      totalArea(m.surfaces.find((sf) => sf.kind === 'airfield')?.polygons ?? []),
    ).toBeGreaterThan(7000);
    expect(
      totalArea(m.surfaces.find((sf) => sf.kind === 'concrete')?.polygons ?? []),
    ).toBeGreaterThan(25000);
    expect(m.buildings.filter((b) => b.provenance.footprint !== 'observed')).toEqual([]);
    expect((m.fences ?? []).some((f) => f.style === 'mesh' && f.height === 2.8)).toBe(true);
    // Runway paint on a full-size runway (3000 × 45 m).
    const runway = runwayMarkings([
      {
        id: 'r',
        kind: 'runway',
        polygon: {
          outer: [
            [-1500, -22.5],
            [1500, -22.5],
            [1500, 22.5],
            [-1500, 22.5],
          ],
          holes: [],
        },
        provenance: 'observed',
      },
    ]);
    expect(runway.filter((k) => k.kind === 'runway-center')).toHaveLength(1);
    expect(runway.filter((k) => k.kind === 'runway-edge')).toHaveLength(2);
    expect(runway.filter((k) => k.kind === 'runway-bar').length).toBeGreaterThan(20);
  });

  it('lays a tram line through a square, the paving giving way to its bed', () => {
    const feature = (
      ref: string,
      kind: 'area' | 'road',
      geometry: { type: 'Polygon' | 'LineString'; coordinates: unknown },
      tags: Record<string, string>,
    ) => ({ ref, source: 'osm', priority: 0, kind, geometry, tags }) as never;
    const m = compileCity(
      {
        ...gridSource(),
        features: [
          feature(
            'osm:square',
            'area',
            {
              type: 'Polygon',
              coordinates: [
                [
                  [-50, -50],
                  [50, -50],
                  [50, 50],
                  [-50, 50],
                  [-50, -50],
                ].map(([x, y]) => ll(x, y)),
              ],
            },
            { place: 'square' },
          ),
          feature(
            'izbb:tram',
            'road',
            { type: 'LineString', coordinates: [ll(-50, 0), ll(50, 0)] },
            { highway: 'tram' },
          ),
        ],
      },
      { infill: false, decorate: false },
    );
    expect(m.rails?.map((r) => r.kind)).toEqual(['tram']);
    const paving = m.surfaces.filter((sf) => sf.kind === 'paving').flatMap((sf) => sf.polygons);
    expect(paving.some((p) => pointInRing([0, 0], p.outer))).toBe(false);
    expect(paving.some((p) => pointInRing([0, 20], p.outer))).toBe(true);
  });

  it('makes everything give way to a rail line, and records each correction', () => {
    const feature = (
      ref: string,
      kind: 'road' | 'building' | 'point',
      geometry: unknown,
      tags: Record<string, string>,
    ) => ({ ref, source: 'osm', priority: 0, kind, geometry, tags }) as never;
    const line = (pts: [number, number][]) => ({
      type: 'LineString',
      coordinates: pts.map(([x, y]) => ll(x, y)),
    });
    const box = (x0: number, y0: number, x1: number, y1: number) => ({
      type: 'Polygon',
      coordinates: [
        [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
          [x0, y0],
        ].map(([x, y]) => ll(x, y)),
      ],
    });
    const m = compileCity(
      {
        ...gridSource(),
        features: [
          feature(
            'osm:rail',
            'road',
            line([
              [-200, 0],
              [200, 0],
            ]),
            { highway: 'rail', lanes: '2' },
          ),
          // A footbridge over the tracks, ramps / stairs landing 30 m either side.
          feature(
            'osm:footbridge',
            'road',
            line([
              [0, -30],
              [0, 30],
            ]),
            {
              highway: 'footway',
              bridge: 'yes',
              layer: '1',
            },
          ),
          // A house the line's data runs into, and the station hall over the tracks.
          feature('osm:house', 'building', box(-40, -2, -20, 12), { building: 'house' }),
          feature('osm:hall', 'building', box(15, -8, 35, 8), {
            building: 'train_station',
            layer: '2',
          }),
          // A pole mapped on the bed.
          feature(
            'osm:pole',
            'point',
            { type: 'Point', coordinates: ll(-150, 1) },
            { power: 'pole' },
          ),
        ],
      },
      { infill: false, decorate: true },
    );
    const fixes = m.fixes;
    const rules = new Set(fixes.map((f) => f.rule));
    // The footbridge clears the catenary envelope over the bed.
    const deck = m.bridges.find((b) => b.roadId.includes('footbridge'))!;
    const over = deck.path.filter((q) => Math.abs(q[1]) < 3);
    expect(over.length).toBeGreaterThan(0);
    for (const q of over)
      expect(q[2] - 1.4 - terrainHeightAt(m.terrain, q[0], q[1])).toBeGreaterThan(6.4);
    expect(rules.has('clearance.bridge-rail')).toBe(true);
    // No pier on the bed.
    for (const pier of deck.piers)
      expect(Math.abs(pier.at[1])).toBeGreaterThan(m.rails![0].width / 2);
    // The house is cut back off the bed; the hall over the tracks stays whole.
    const house = m.buildings.find((b) => b.ref === 'osm:house')!;
    expect(house.footprint.outer.every((p) => p[1] > m.rails![0].width / 2)).toBe(true);
    expect(rules.has('building.rail')).toBe(true);
    const hall = m.buildings.find((b) => b.ref === 'osm:hall')!;
    expect(hall.area).toBeCloseTo(20 * 16, 0);
    // … raised on columns, clear of the catenary envelope, none on the bed.
    expect(hall.underside! - terrainHeightAt(m.terrain, 25, 0)).toBeGreaterThan(6.5);
    expect(hall.columns!.length).toBeGreaterThan(0);
    for (const c of hall.columns!)
      expect(Math.abs(c[1])).toBeGreaterThan(m.rails![0].width / 2 + 1);
    expect(rules.has('building.raised')).toBe(true);
    // The pole stands beside the bed now.
    const pole = m.props.find((p) => p.id.includes('pole'))!;
    expect(Math.abs(pole.position[1])).toBeGreaterThan(m.rails![0].width / 2);
    // Every correction says why.
    for (const f of fixes.filter((x) => x.rule)) expect(f.note.length).toBeGreaterThan(10);
  });

  it('lays a rail bridge on its own deck, clear of the street under it', () => {
    const feature = (ref: string, pts: [number, number][], tags: Record<string, string>) =>
      ({
        ref,
        source: 'osm',
        priority: 0,
        kind: 'road',
        geometry: { type: 'LineString', coordinates: pts.map(([x, y]) => ll(x, y)) },
        tags,
      }) as never;
    // Track at grade, then on a bridge over the N–S street at x = 60, then at grade again.
    const m = compileCity(
      {
        ...gridSource(),
        features: [
          feature(
            'osm:t1',
            [
              [-190, 0],
              [20, 0],
            ],
            { highway: 'rail' },
          ),
          feature(
            'osm:t2',
            [
              [20, 0],
              [100, 0],
            ],
            { highway: 'rail', bridge: 'yes', layer: '1' },
          ),
          feature(
            'osm:t3',
            [
              [100, 0],
              [190, 0],
            ],
            { highway: 'rail' },
          ),
        ],
      },
      { infill: false, decorate: false },
    );
    const onBridge = m.rails!.find((r) => r.grade === 'bridge')!;
    expect(onBridge.profile?.length).toBe(onBridge.points.length);
    expect(m.bridges.some((b) => b.roadId.startsWith('rl-deck:'))).toBe(true);
    // Over the street the track is high enough for traffic under it (4.8 m + deck).
    const k = onBridge.points.findIndex((p) => Math.abs(p[0] - 60) < 4);
    const q = onBridge.points[k];
    expect(onBridge.profile![k] - 1.4 - terrainHeightAt(m.terrain, q[0], q[1])).toBeGreaterThan(
      4.7,
    );
  });

  it('keeps a shore street and the ground under it at the land floor, above the sea', () => {
    const road = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'road' as const,
      geometry: { type: 'LineString' as const, coordinates: pts.map(([x, y]) => ll(x, y)) },
      tags,
    });
    const [west, south] = ll(-400, -400);
    const [east, north] = ll(400, 400);
    // The elevation model puts the whole shore at sea level (0 m).
    const m = compileCity(
      {
        ...gridSource(),
        osm: [],
        terrain: {
          source: 'test',
          west,
          east,
          north,
          south,
          cols: 9,
          rows: 9,
          heights: new Array(81).fill(0),
        },
        features: [
          road(
            'osm:shore',
            [
              [-200, 0],
              [200, 0],
            ],
            { highway: 'secondary' },
          ),
        ],
      },
      { infill: false, decorate: false },
    );
    const shore = m.roads.find((r) => r.ref === 'osm:shore')!;
    expect(Math.min(...shore.profile!)).toBeGreaterThanOrEqual(LAND_FLOOR - 0.01);
    expect(terrainHeightAt(m.terrain, 0, 0)).toBeGreaterThanOrEqual(LAND_FLOOR - 0.01);
  });

  it('builds a tunnel network: one level at joints, mouths only at its ends, a deeper branch dipping away', () => {
    const road = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'road' as const,
      geometry: { type: 'LineString' as const, coordinates: pts.map(([x, y]) => ll(x, y)) },
      tags,
    });
    const [west, south] = ll(-400, -400);
    const [east, north] = ll(400, 400);
    const src: CitySource = {
      ...gridSource(),
      osm: [],
      terrain: {
        source: 'test',
        west,
        east,
        north,
        south,
        cols: 9,
        rows: 9,
        heights: new Array(81).fill(50),
      },
      features: [
        road(
          'osm:in',
          [
            [-300, 0],
            [-120, 0],
          ],
          { highway: 'primary' },
        ),
        // A (−1) from the west mouth to the joint J at (0, 0); B (−1) on to the east mouth.
        road(
          'osm:a',
          [
            [-120, 0],
            [0, 0],
          ],
          { highway: 'primary', tunnel: 'yes', layer: '-1' },
        ),
        road(
          'osm:b',
          [
            [0, 0],
            [120, 0],
          ],
          { highway: 'primary', tunnel: 'yes', layer: '-1' },
        ),
        road(
          'osm:out',
          [
            [120, 0],
            [300, 0],
          ],
          { highway: 'primary' },
        ),
        // C (−2) branches off at J, going south under the street, up to its own mouth.
        road(
          'osm:c',
          [
            [0, 0],
            [0, -200],
          ],
          { highway: 'primary_link', tunnel: 'yes', layer: '-2' },
        ),
        road(
          'osm:c-out',
          [
            [0, -200],
            [0, -350],
          ],
          { highway: 'primary_link' },
        ),
      ],
    };
    const m = compileCity(src, { infill: false, decorate: false });
    const tube = (id: string) => m.tunnels.find((t) => t.roadId.includes(id))!;
    const zAt = (t: { path: number[][] }, x: number, y: number) =>
      t.path.find((q) => Math.hypot(q[0] - x, q[1] - y) < 0.5)![2];
    // One level at the joint for all three tubes.
    const j = zAt(tube('osm:a'), 0, 0);
    expect(Math.abs(zAt(tube('osm:b'), 0, 0) - j)).toBeLessThan(0.01);
    expect(Math.abs(zAt(tube('osm:c'), 0, 0) - j)).toBeLessThan(0.01);
    // Mouths at the network's three ends only — none at the joint.
    expect(m.portals.some((p) => Math.hypot(p.at[0], p.at[1]) < 1)).toBe(false);
    expect(m.portals).toHaveLength(3);
    // The −2 branch dips away from the joint, no steeper than the tube grade.
    const c = tube('osm:c').path;
    const deepest = Math.min(...c.map((q) => q[2]));
    expect(deepest).toBeLessThan(j - 4);
    for (let k = 1; k < c.length; k++) {
      const run = Math.hypot(c[k][0] - c[k - 1][0], c[k][1] - c[k - 1][1]);
      expect(Math.abs(c[k][2] - c[k - 1][2]) / run).toBeLessThan(0.0701);
    }
  });

  it('flags tubes crossing without a tube height between them, not a −1 over a −2', () => {
    const road = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'road' as const,
      geometry: { type: 'LineString' as const, coordinates: pts.map(([x, y]) => ll(x, y)) },
      tags,
    });
    const [west, south] = ll(-400, -400);
    const [east, north] = ll(400, 400);
    const crossingTubes = (lower: string) => ({
      ...gridSource(),
      osm: [],
      terrain: {
        source: 'test',
        west,
        east,
        north,
        south,
        cols: 9,
        rows: 9,
        heights: new Array(81).fill(50),
      },
      features: [
        road(
          'osm:w',
          [
            [-350, 0],
            [-150, 0],
          ],
          { highway: 'primary' },
        ),
        road(
          'osm:x',
          [
            [-150, 0],
            [150, 0],
          ],
          { highway: 'primary', tunnel: 'yes', layer: '-1' },
        ),
        road(
          'osm:e',
          [
            [150, 0],
            [350, 0],
          ],
          { highway: 'primary' },
        ),
        road(
          'osm:s',
          [
            [0, -350],
            [0, -150],
          ],
          { highway: 'primary' },
        ),
        road(
          'osm:y',
          [
            [0, -150],
            [0, 150],
          ],
          { highway: 'primary', tunnel: 'yes', layer: lower },
        ),
        road(
          'osm:n',
          [
            [0, 150],
            [0, 350],
          ],
          { highway: 'primary' },
        ),
      ],
    });
    const clash = (lower: string) =>
      validateCity(compileCity(crossingTubes(lower), { infill: false, decorate: false })).counts[
        'tunnel.clash'
      ] ?? 0;
    expect(clash('-1')).toBe(1);
    expect(clash('-2')).toBe(0);
  });

  it('cuts an underpass trench with walls and portals, and only portals into a hill', () => {
    const road = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'road' as const,
      geometry: { type: 'LineString' as const, coordinates: pts.map(([x, y]) => ll(x, y)) },
      tags,
    });
    const [west, south] = ll(-400, -400);
    const [east, north] = ll(400, 400);
    const flat = (h: number) => ({
      source: 'test',
      west,
      east,
      north,
      south,
      cols: 9,
      rows: 9,
      heights: new Array(81).fill(h),
    });
    const src: CitySource = {
      ...gridSource(),
      osm: [],
      terrain: flat(50),
      features: [
        road(
          'osm:a',
          [
            [-250, 0],
            [-40, 0],
          ],
          { highway: 'primary' },
        ),
        road(
          'osm:t',
          [
            [-40, 0],
            [40, 0],
          ],
          { highway: 'primary', tunnel: 'yes', layer: '-1' },
        ),
        road(
          'osm:b',
          [
            [40, 0],
            [250, 0],
          ],
          { highway: 'primary' },
        ),
        road(
          'osm:x',
          [
            [0, -250],
            [0, 250],
          ],
          { highway: 'secondary' },
        ),
        // A zebra mapped on the ramp road, down in the trench: none is drawn there.
        {
          ref: 'osm:n-zebra',
          source: 'osm',
          priority: 0,
          kind: 'point' as const,
          geometry: { type: 'Point' as const, coordinates: ll(-60, 0) },
          tags: { highway: 'crossing', crossing: 'zebra' },
        },
      ],
    };
    const m = compileCity(src, { infill: false, decorate: false });
    expect(m.cuttings).toHaveLength(2);
    expect(validateCity(m).counts['crossing.in-cut'] ?? 0).toBe(0);
    expect(m.portals).toHaveLength(2);
    // The terrain keeps street level; the trench is a footprint with a floor of its own.
    expect(terrainHeightAt(m.terrain, -42, 0)).toBeGreaterThan(49.5);
    const ground = new CutGround(m.terrain, m.terrainCut);
    expect(ground.inTrench(-42, 0)).toBe(true);
    // Trench floor at the portal ≈ 6.5 m below the street; back to street level up the ramp.
    expect(ground.heightAt(-42, 0)).toBeLessThan(45);
    expect(ground.heightAt(-200, 0)).toBeGreaterThan(49.5);
    // The crossing street above stays at street level.
    expect(ground.heightAt(0, 20)).toBeGreaterThan(49.5);
    // Flat trench floor wall to wall: no floor triangle rises inside the walls.
    const cut = m.cuttings.find((c) => c.path[0][0] < 0)!;
    const half = cut.width / 2;
    expect(ground.inTrench(-70, half + 0.5)).toBe(false);
    for (const x of [-41, -48, -70, -100]) {
      const floor = ground.heightAt(x, 0);
      for (const y of [-half + 0.3, -half / 2, half / 2, half - 0.3])
        expect(Math.abs(ground.heightAt(x, y) - floor)).toBeLessThan(0.05);
    }
    // The tube's road continues the trench floor at the mouth.
    expect(m.tunnels).toHaveLength(1);
    const mouth = m.tunnels[0].path[0][2];
    expect(Math.abs(mouth - cut.path[0][2])).toBeLessThan(0.05);

    // The same tunnel under a hill: portals only, no trench.
    const hill = flat(50);
    for (let j = 3; j <= 5; j++) for (let i = 3; i <= 5; i++) hill.heights[j * 9 + i] = 110;
    const h = compileCity(
      {
        ...src,
        terrain: hill,
        // Portals at the foot of the hill, 190 m either side of its top.
        features: [
          road(
            'osm:a',
            [
              [-350, 0],
              [-190, 0],
            ],
            { highway: 'primary' },
          ),
          road(
            'osm:t',
            [
              [-190, 0],
              [190, 0],
            ],
            { highway: 'primary', tunnel: 'yes' },
          ),
          road(
            'osm:b',
            [
              [190, 0],
              [350, 0],
            ],
            { highway: 'primary' },
          ),
        ],
      },
      { infill: false, decorate: false },
    );
    expect(h.cuttings).toHaveLength(0);
    expect(h.portals).toHaveLength(2);
    // The shallow first metres into the hill are under a lid clear of the tube.
    const hg = new CutGround(h.terrain, h.terrainCut);
    const road0 = h.tunnels[0].path[0][2];
    expect(hg.inLid(-186, 0)).toBe(true);
    for (const y of [-3, 0, 3]) expect(hg.heightAt(-186, y)).toBeGreaterThan(road0 + 5.4);
  });

  it('keeps a viaduct of several bridge ways at height, on piers, with no ground markings', () => {
    const road = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'road' as const,
      geometry: { type: 'LineString' as const, coordinates: pts.map(([x, y]) => ll(x, y)) },
      tags,
    });
    const viaduct = { highway: 'trunk', bridge: 'viaduct', layer: '1', lanes: '4' };
    const m = compileCity(
      {
        ...gridSource(),
        osm: [],
        features: [
          road(
            'osm:in',
            [
              [-195, 0],
              [-150, 0],
            ],
            { highway: 'trunk', lanes: '4' },
          ),
          road(
            'osm:v1',
            [
              [-150, 0],
              [0, 0],
            ],
            viaduct,
          ),
          road(
            'osm:v2',
            [
              [0, 0],
              [150, 0],
            ],
            viaduct,
          ),
          road(
            'osm:out',
            [
              [150, 0],
              [195, 0],
            ],
            { highway: 'trunk', lanes: '4' },
          ),
        ],
      },
      { infill: false, decorate: false },
    );
    const ground = terrainHeightAt(m.terrain, 0, 0);
    const deckAt = (x: number) => {
      for (const br of m.bridges)
        for (let k = 1; k < br.path.length; k++) {
          const [a, b] = [br.path[k - 1], br.path[k]];
          if (Math.min(a[0], b[0]) <= x && x <= Math.max(a[0], b[0]) && Math.abs(a[1]) < 1)
            return a[2] + ((b[2] - a[2]) * (x - a[0])) / (b[0] - a[0] || 1);
        }
      return NaN;
    };
    // At the joint of the two ways the deck stays up; it comes down only at the outer ends.
    expect(deckAt(0) - ground).toBeGreaterThan(5);
    expect(deckAt(-148) - ground).toBeLessThan(1);
    // On piers: wherever the deck stands over 4 m up, a column within 20 m.
    const piers = m.bridges.flatMap((b) => b.piers);
    let high = 0;
    for (let x = -140; x <= 140; x += 10) {
      if (deckAt(x) - ground <= 4) continue;
      high++;
      expect(Math.min(...piers.map((p) => Math.hypot(p.at[0] - x, p.at[1])))).toBeLessThan(20);
    }
    expect(high).toBeGreaterThan(15);
    // The two ways form one continuous structure (no joint in the deck).
    expect(m.bridges).toHaveLength(1);
    // No lane markings painted on the ground under the deck.
    const under = m.markings.filter((mk) =>
      mk.points.some(([x, y]) => Math.abs(x) < 120 && Math.abs(y) < 6),
    );
    expect(under).toHaveLength(0);
  });

  it('joins deck ends a metre or two apart in the source at one height', () => {
    const road = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'road' as const,
      geometry: { type: 'LineString' as const, coordinates: pts.map(([x, y]) => ll(x, y)) },
      tags,
    });
    const bridge = { highway: 'footway', bridge: 'yes', layer: '1' };
    const m = compileCity(
      {
        ...gridSource(),
        osm: [],
        features: [
          road(
            'osm:a',
            [
              [-60, 0],
              [-1, 0],
            ],
            bridge,
          ),
          // Drawn 1.5 m on from where the first piece stops (no shared node).
          road(
            'osm:b',
            [
              [0.5, 0],
              [8, 0],
            ],
            bridge,
          ),
          // Steps up to the first piece's end at an angle: that end stays up.
          road(
            'osm:s',
            [
              [-1, 0],
              [-1, -6],
            ],
            { highway: 'steps', bridge: 'yes', layer: '1' },
          ),
        ],
      },
      { infill: false, decorate: false },
    );
    const vertex = (x: number) =>
      m.bridges
        .flatMap((br) => br.path)
        .reduce((a, b) =>
          Math.abs(b[0] - x) + Math.abs(b[1]) < Math.abs(a[0] - x) + Math.abs(a[1]) ? b : a,
        );
    expect(Math.abs(vertex(-1)[2] - vertex(0.5)[2])).toBeLessThan(0.05);
  });

  it('meets at one height where decks of different layers join end to end', () => {
    const road = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'road' as const,
      geometry: { type: 'LineString' as const, coordinates: pts.map(([x, y]) => ll(x, y)) },
      tags,
    });
    const m = compileCity(
      {
        ...gridSource(),
        osm: [],
        features: [
          road(
            'osm:in',
            [
              [-195, 0],
              [-150, 0],
            ],
            { highway: 'trunk' },
          ),
          // The layer tag changes at the shared node (x = 0): not one chain.
          road(
            'osm:v1',
            [
              [-150, 0],
              [0, 0],
            ],
            { highway: 'trunk', bridge: 'yes', layer: '1' },
          ),
          road(
            'osm:v2',
            [
              [0, 0],
              [150, 0],
            ],
            { highway: 'trunk', bridge: 'yes', layer: '2' },
          ),
          road(
            'osm:out',
            [
              [150, 0],
              [195, 0],
            ],
            { highway: 'trunk' },
          ),
        ],
      },
      { infill: false, decorate: false },
    );
    expect(m.bridges).toHaveLength(2);
    // Height of each deck at its vertex on the joint.
    const atJoint = m.bridges.map((br) => {
      const q = br.path.reduce((a, b) => (Math.hypot(b[0], b[1]) < Math.hypot(a[0], a[1]) ? b : a));
      return q[2];
    });
    expect(Math.abs(atJoint[0] - atJoint[1])).toBeLessThan(0.05);
    // Both still come down to the ground road at their outer ends.
    const ground = terrainHeightAt(m.terrain, -150, 0);
    for (const br of m.bridges) {
      const outer = br.path.reduce((a, b) =>
        Math.hypot(b[0], b[1]) > Math.hypot(a[0], a[1]) ? b : a,
      );
      expect(outer[2] - ground).toBeLessThan(1);
    }
  });

  it('keeps piers off the road underneath, props out of the deck, and meets a slip road at deck height', () => {
    const road = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'road' as const,
      geometry: { type: 'LineString' as const, coordinates: pts.map(([x, y]) => ll(x, y)) },
      tags,
    });
    const viaduct = { highway: 'trunk', bridge: 'viaduct', layer: '1', lanes: '4' };
    // 10 m terrain grid with a 2.5 m knoll where the slip road meets the
    // viaduct: the viaduct follows the averaged ground, the slip road's end
    // alone would sit 2 m higher.
    const [west, south] = ll(-400, -400);
    const [east, north] = ll(400, 400);
    const heights = new Array(81 * 81).fill(50);
    for (let j2 = 0; j2 < 81; j2++)
      for (let i2 = 0; i2 < 81; i2++) {
        const d = Math.hypot(-400 + i2 * 10 - 60, -400 + j2 * 10);
        if (d < 20) heights[j2 * 81 + i2] = 50 + 2.5 * (1 - d / 20);
      }
    const terrain = { source: 'test', west, east, north, south, cols: 81, rows: 81, heights };
    const m = compileCity(
      {
        ...gridSource(),
        osm: [],
        terrain,
        features: [
          road(
            'osm:in',
            [
              [-195, 0],
              [-150, 0],
            ],
            { highway: 'trunk', lanes: '4' },
          ),
          road(
            'osm:v1',
            [
              [-150, 0],
              [0, 0],
            ],
            viaduct,
          ),
          road(
            'osm:v2',
            [
              [0, 0],
              [150, 0],
            ],
            viaduct,
          ),
          road(
            'osm:out',
            [
              [150, 0],
              [195, 0],
            ],
            { highway: 'trunk', lanes: '4' },
          ),
          // A street under the viaduct, right where a pier would stand every 26 m.
          road(
            'osm:under',
            [
              [-7, -150],
              [-7, 150],
            ],
            { highway: 'primary' },
          ),
          // A slip road climbing onto the viaduct, joining it mid-span.
          road(
            'osm:sg',
            [
              [20, -150],
              [40, -90],
            ],
            { highway: 'trunk_link' },
          ),
          road(
            'osm:slip',
            [
              [40, -90],
              [60, 0],
            ],
            { highway: 'trunk_link', bridge: 'yes', layer: '1' },
          ),
        ],
      },
      { infill: false, decorate: true },
    );
    const under = m.roads.find((r) => r.id.includes('osm:under'))!;
    for (const br of m.bridges)
      for (const pier of br.piers)
        for (const o of pier.columns) {
          const x = pier.at[0] - pier.dir[1] * o;
          expect(Math.abs(x + 7)).toBeGreaterThan(under.width / 2 + 0.5);
        }
    const main = m.bridges.reduce((a, b) => (a.width >= b.width ? a : b));
    const deckZ = (br: typeof main, q: [number, number]) => {
      let best = { d: Infinity, z: 0 };
      for (let k = 1; k < br.path.length; k++) {
        const [a, b] = [br.path[k - 1], br.path[k]];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const t = Math.max(
          0,
          Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
        );
        const d = Math.hypot(q[0] - a[0] - dx * t, q[1] - a[1] - dy * t);
        if (d < best.d) best = { d, z: a[2] + (b[2] - a[2]) * t };
      }
      return best;
    };
    // Nothing generated grows into the deck or stands at a column.
    for (const p of m.props) {
      if (p.provenance === 'observed' || p.buildingId) continue;
      if (p.kind !== 'tree' && p.kind !== 'street-lamp') continue;
      const d = deckZ(main, [p.position[0], p.position[1]]);
      if (d.d < main.width / 2 + 2) expect(p.position[2] + 6).toBeLessThan(d.z - 2.2);
    }
    // The slip road's upper end sits on the viaduct at the viaduct's height.
    const slip = m.bridges.find(
      (b) => b !== main && b.path.some((q) => Math.hypot(q[0] - 60, q[1]) < 1),
    )!;
    const end = slip.path.reduce((a, q) =>
      Math.hypot(q[0] - 60, q[1]) < Math.hypot(a[0] - 60, a[1]) ? q : a,
    );
    expect(Math.abs(end[2] - deckZ(main, [60, 0]).z)).toBeLessThan(0.3);
    expect(end[2] - terrainHeightAt(m.terrain, 60, 0)).toBeGreaterThan(2.5);
  });

  it('stops the lane lines of a merging road inside the carriageway it joins', () => {
    const road = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'road' as const,
      geometry: { type: 'LineString' as const, coordinates: pts.map(([x, y]) => ll(x, y)) },
      tags,
    });
    const m = compileCity(
      {
        ...gridSource(),
        osm: [],
        features: [
          road(
            'osm:main',
            [
              [-250, 0],
              [0, 0],
              [250, 0],
            ],
            { highway: 'trunk', lanes: '4' },
          ),
          // Joins at a shallow angle: it runs inside the trunk for some 40 m.
          road(
            'osm:link',
            [
              [-200, -30],
              [0, 0],
            ],
            {
              highway: 'trunk_link',
              oneway: 'yes',
              lanes: '2',
            },
          ),
        ],
      },
      { infill: false, decorate: false },
    );
    const main = m.roads.find((r) => r.id.includes('osm:main'))!;
    // The link's lines run at its slope (≈ 0.15); the trunk's are level.
    const linkLines = m.markings.filter((mk) => {
      const [a, b] = [mk.points[0], mk.points[mk.points.length - 1]];
      return Math.abs((b[1] - a[1]) / (b[0] - a[0] || 1)) > 0.05;
    });
    expect(linkLines.length).toBeGreaterThan(0);
    for (const mk of linkLines)
      for (const [, y] of mk.points) expect(Math.abs(y)).toBeGreaterThan(main.width / 2 - 0.5);
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

describe('junctions', () => {
  const road = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
    ref,
    source: 'osm',
    priority: 0,
    kind: 'road' as const,
    geometry: { type: 'LineString' as const, coordinates: pts.map(([x, y]) => ll(x, y)) },
    tags,
  });
  const compile = (features: ReturnType<typeof road>[]) =>
    compileCity({ ...gridSource(), osm: [], features }, { infill: false, decorate: false });

  it('ends a crossroads where the arms clear each other, with turns for the lanes driving in', () => {
    const m = compile([
      road(
        'osm:ew',
        [
          [-150, 0],
          [0, 0],
          [150, 0],
        ],
        { highway: 'secondary' },
      ),
      road(
        'osm:ns',
        [
          [0, -150],
          [0, 0],
          [0, 150],
        ],
        { highway: 'tertiary' },
      ),
    ]);
    const j = m.junctions.find((x) => Math.hypot(x.center[0], x.center[1]) < 0.1)!;
    expect(j.arms).toHaveLength(4);
    const ew = m.roads.find((r) => r.ref === 'osm:osm:ew' || r.ref.endsWith(':ew'))!;
    const ns = m.roads.find((r) => r.ref.endsWith(':ns'))!;
    for (const arm of j.arms!) {
      const other = arm.roadId === ew.id ? ns : ew;
      // Out past the crossing carriageway's edge, not far beyond it.
      expect(arm.edge).toBeGreaterThanOrEqual(other.width / 2);
      expect(arm.edge).toBeLessThan(other.width / 2 + 2);
    }
    expect(pointInRing([0, 0], j.polygon!.outer)).toBe(true);
    // Lane to lane through the junction: one lane in per arm, three turns each.
    expect(j.connectors).toHaveLength(12);
    for (const c of j.connectors!) {
      const [from, to] = [j.arms![c.from[0]], j.arms![c.to[0]]];
      const start = c.path[0];
      const end = c.path[c.path.length - 1];
      // Leaves its own arm at the stop point, reaches the exit arm at the junction's edge.
      expect(Math.hypot(start[0], start[1])).toBeGreaterThan(from.stop! - 3);
      expect(Math.hypot(end[0], end[1])).toBeGreaterThan(to.edge - 3);
      expect(end[0] * to.dir[0] + end[1] * to.dir[1]).toBeGreaterThan(to.edge - 0.5);
    }
    // Every lane driving in (one per arm here) may go left, ahead or right.
    for (const arm of j.arms!) {
      expect(arm.turns).toHaveLength(1);
      expect(arm.turns![0].sort()).toEqual(['left', 'right', 'through']);
      expect(arm.turnsProvenance).toBe('inferred');
    }
  });

  it("takes a road's own turn lanes for the junction it ends at", () => {
    const m = compile([
      road(
        'osm:main',
        [
          [-150, 0],
          [0, 0],
          [150, 0],
        ],
        { highway: 'secondary' },
      ),
      // One way, drawn into the junction: its turn:lanes are for this junction.
      road(
        'osm:in',
        [
          [0, 150],
          [0, 0],
        ],
        {
          highway: 'secondary',
          oneway: 'yes',
          lanes: '2',
          'turn:lanes': 'left|right',
        },
      ),
    ]);
    const into = m.roads.find((r) => r.ref.endsWith(':in'))!;
    const j = m.junctions.find((x) => Math.hypot(x.center[0], x.center[1]) < 0.1)!;
    const arm = j.arms!.find((a) => a.roadId === into.id)!;
    expect(arm.turns).toEqual([['left'], ['right']]);
    expect(arm.turnsProvenance).toBe('observed');
  });

  it('paints stop lines at a signalised crossroads, behind its crossings, with lane lines ending there', () => {
    const m = compileCity(
      {
        ...gridSource(),
        osm: [],
        features: [
          road(
            'osm:ew',
            [
              [-150, 0],
              [0, 0],
              [150, 0],
            ],
            { highway: 'secondary', lanes: '4' },
          ),
          road(
            'osm:ns',
            [
              [0, -150],
              [0, 0],
              [0, 150],
            ],
            { highway: 'secondary', lanes: '4' },
          ),
          {
            ref: 'osm:n-signals',
            source: 'osm',
            priority: 0,
            kind: 'point' as const,
            geometry: { type: 'Point' as const, coordinates: ll(5, 5) },
            tags: { highway: 'traffic_signals' },
          },
        ],
      },
      { infill: false, decorate: false },
    );
    const j = m.junctions.find((x) => Math.hypot(x.center[0], x.center[1]) < 0.1)!;
    expect(j.signalised).toBe(true);
    const stops = m.markings.filter((mk) => mk.kind === 'stop');
    expect(stops).toHaveLength(4);
    // Each behind its arm's crossing (crossing 3 m wide just outside the junction).
    for (const arm of j.arms!) expect(arm.stop!).toBeGreaterThan(arm.edge + 3);
    const crossings = m.crossings.filter((c) => Math.hypot(c.center[0], c.center[1]) < 30);
    expect(crossings).toHaveLength(4);
    // Two-lane approaches get an arrow per lane.
    expect(m.markings.filter((mk) => mk.kind === 'arrow')).toHaveLength(8);
    const rules = validateCity(m).counts;
    expect(rules['junction.paint-inside'] ?? 0).toBe(0);
    expect(rules['junction.stop-on-crossing'] ?? 0).toBe(0);
    // No lane line reaches in past a stop line.
    const minStop = Math.min(...j.arms!.map((a) => a.stop!));
    for (const mk of m.markings)
      if (mk.kind === 'lane-dashed' || mk.kind === 'center-solid')
        for (const [x, y] of mk.points)
          expect(Math.max(Math.abs(x), Math.abs(y))).toBeGreaterThan(minStop - 0.5);
  });

  it('paints a give-way line where a lower road meets a higher one', () => {
    const m = compile([
      road(
        'osm:main',
        [
          [-150, 0],
          [0, 0],
          [150, 0],
        ],
        { highway: 'secondary' },
      ),
      road(
        'osm:side',
        [
          [0, 0],
          [0, 150],
        ],
        { highway: 'residential' },
      ),
    ]);
    const gw = m.markings.filter((mk) => mk.kind === 'give-way');
    expect(gw).toHaveLength(1);
    // Across the side road's lane driving in (its west half), north of the main road.
    for (const [, y] of gw[0].points) expect(y).toBeGreaterThan(3);
    expect(m.markings.filter((mk) => mk.kind === 'stop')).toHaveLength(0);
  });

  it('draws a sidewalk on its one side only, and widens a road for its cycle lanes', () => {
    const m = compile([
      road(
        'osm:one',
        [
          [-150, 0],
          [150, 0],
        ],
        {
          highway: 'tertiary',
          sidewalk: 'left',
          cycleway: 'lane',
        },
      ),
    ]);
    const r = m.roads.find((x) => x.ref.endsWith(':one'))!;
    expect(r.sidewalkSide).toBe('left');
    expect(r.laneLayout!.map((l) => l.kind)).toEqual(['cycle', 'drive', 'drive', 'cycle']);
    const sidewalk = m.surfaces.find((sf) => sf.kind === 'sidewalk')!.polygons;
    const on = (y: number) => sidewalk.some((p) => pointInRing([0, y], p.outer));
    // Left of the drawing direction (east) is north.
    expect(on(r.width / 2 + r.sidewalk / 2)).toBe(true);
    expect(on(-(r.width / 2 + r.sidewalk / 2))).toBe(false);
    // A solid line along each cycle lane.
    expect(m.markings.filter((mk) => mk.kind === 'edge').length).toBeGreaterThanOrEqual(2);
  });

  it('gives the side road of a T junction left and right turns only', () => {
    const m = compile([
      road(
        'osm:main',
        [
          [-150, 0],
          [0, 0],
          [150, 0],
        ],
        { highway: 'secondary' },
      ),
      road(
        'osm:side',
        [
          [0, 0],
          [0, 150],
        ],
        { highway: 'residential' },
      ),
    ]);
    const side = m.roads.find((r) => r.ref.endsWith(':side'))!;
    const j = m.junctions.find((x) => Math.hypot(x.center[0], x.center[1]) < 0.1)!;
    const arm = j.arms!.find((a) => a.roadId === side.id)!;
    expect(arm.turns).toHaveLength(1);
    expect(arm.turns![0].sort()).toEqual(['left', 'right']);
    expect(arm.turnsProvenance).toBe('inferred');
    // A two-way main road: ahead or right from the west, ahead or left from the east.
    const main = j.arms!.filter((a) => a.roadId !== side.id);
    expect(main.map((a) => a.turns![0].sort().join(',')).sort()).toEqual([
      'left,through',
      'right,through',
    ]);
  });
});

describe('bridges', () => {
  it('a short bridge down a slope is one vertical curve, not steps over the ground', () => {
    const [west, south] = ll(-400, -400);
    const [east, north] = ll(400, 400);
    const road = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'road' as const,
      geometry: { type: 'LineString' as const, coordinates: pts.map(([x, y]) => ll(x, y)) },
      tags,
    });
    // Falling 8 % to the north; the bridge runs straight down it.
    const m = compileCity(
      {
        ...gridSource(),
        osm: [],
        terrain: {
          source: 'test',
          west,
          east,
          north,
          south,
          cols: 9,
          rows: 9,
          heights: Array.from(
            { length: 81 },
            (_, k) => 200 - 0.08 * (400 - Math.floor(k / 9) * 100),
          ),
        },
        features: [
          road(
            'osm:a',
            [
              [0, -200],
              [0, -80],
            ],
            { highway: 'secondary' },
          ),
          road(
            'osm:b',
            [
              [0, -80],
              [0, 80],
            ],
            { highway: 'secondary', bridge: 'yes', layer: '1' },
          ),
          road(
            'osm:c',
            [
              [0, 80],
              [0, 200],
            ],
            { highway: 'secondary' },
          ),
        ],
      },
      { infill: false, decorate: false },
    );
    const deck = m.bridges.find((b) => b.roadId.includes('osm:b'))!;
    const p = deck.path.slice(1, -1);
    const grades: number[] = [];
    for (let k = 1; k < p.length; k++) {
      const run = Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]);
      if (run > 0.5) grades.push((p[k][2] - p[k - 1][2]) / run);
    }
    // One vertical curve: the grade only ever falls (no flat, then steep, then flat).
    for (let k = 1; k < grades.length; k++)
      expect(grades[k]).toBeLessThanOrEqual(grades[k - 1] + 1e-6);
    // Rising at most 6 % over the 8 % slope: ~14 % at the low end (5.5 m in 25 m: ~30 %).
    expect(Math.max(...grades.map(Math.abs))).toBeLessThan(0.16);
  });
});

describe('bridges across a slope', () => {
  it('keeps a short deck above the ground across its whole width', () => {
    const [west, south] = ll(-400, -400);
    const [east, north] = ll(400, 400);
    const road = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'road' as const,
      geometry: { type: 'LineString' as const, coordinates: pts.map(([x, y]) => ll(x, y)) },
      tags,
    });
    // Rising 15 % to the east, across a bridge that runs north along the contour.
    const m = compileCity(
      {
        ...gridSource(),
        osm: [],
        terrain: {
          source: 'test',
          west,
          east,
          north,
          south,
          cols: 9,
          rows: 9,
          heights: Array.from({ length: 81 }, (_, k) => 200 + 0.15 * ((k % 9) * 100 - 400)),
        },
        features: [
          road(
            'osm:a',
            [
              [0, -200],
              [0, -80],
            ],
            { highway: 'primary', lanes: '4' },
          ),
          road(
            'osm:b',
            [
              [0, -80],
              [0, 80],
            ],
            { highway: 'primary', lanes: '4', bridge: 'yes', layer: '1' },
          ),
          road(
            'osm:c',
            [
              [0, 80],
              [0, 200],
            ],
            { highway: 'primary', lanes: '4' },
          ),
        ],
      },
      { infill: false, decorate: false },
    );
    expect(m.bridges.length).toBeGreaterThan(0);
    expect(validateCity(m).counts['bridge.ground-through'] ?? 0).toBe(0);
  });
});

describe('ground contact rules', () => {
  it('a compiled tile touches its ground; a raised building, a fence over a sunk street and a spike are caught', () => {
    const m = compileCity(gridSource());
    const clean = validateCity(m).counts;
    expect(clean['fence.float'] ?? 0).toBe(0);
    expect(clean['building.float'] ?? 0).toBe(0);
    expect(clean['terrain.spike'] ?? 0).toBe(0);

    const b = m.buildings.find((x) => x.form !== 'canopy' && x.underside === undefined)!;
    const raised = validateCity({
      ...m,
      buildings: [{ ...b, baseZ: b.baseZ + 1 }],
    }).counts;
    expect(raised['building.float']).toBe(1);

    // The land 1 m higher, the street (its own profile) where it was: a wall
    // crossing the street hangs over it.
    const t = m.terrain;
    const sunk = validateCity({
      ...m,
      terrain: { ...t, heights: t.heights.map((h) => h + 1) },
      buildings: [],
      fences: [
        {
          points: [
            [-130, -75],
            [-130, -45],
          ],
          style: 'wall',
          height: 1.5,
          color: '#ccc',
        },
      ],
    });
    expect(sunk.counts['fence.float']).toBe(1);
    const at = sunk.samples.find((v) => v.rule === 'fence.float')!.at;
    expect(Math.abs(at[1] + 60)).toBeLessThan(6);

    const heights = [...t.heights];
    const i = Math.floor(t.cols / 2);
    const j = Math.floor(t.rows / 2);
    heights[j * t.cols + i] += 3;
    const spiked = validateCity({ ...m, terrain: { ...t, heights } }).counts;
    expect(spiked['terrain.spike']).toBe(1);
  });

  it('a building above a street on a slope reaches down to the land lowered for the street', () => {
    const [west, south] = ll(-400, -400);
    const [east, north] = ll(400, 400);
    const feature = (ref: string, kind: 'road' | 'building', geometry: object, tags: object) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind,
      geometry,
      tags,
    });
    // Rising 30 % to the north; the street runs along the contour at y = 0.
    const m = compileCity(
      {
        ...gridSource(),
        osm: [],
        terrain: {
          source: 'test',
          west,
          east,
          north,
          south,
          cols: 9,
          rows: 9,
          heights: Array.from(
            { length: 81 },
            (_, k) => 200 + 0.3 * (400 - Math.floor(k / 9) * 100),
          ),
        },
        features: [
          feature(
            'osm:street',
            'road',
            {
              type: 'LineString',
              coordinates: [ll(-200, 0), ll(200, 0)],
            },
            { highway: 'residential' },
          ),
          feature(
            'osm:house',
            'building',
            {
              type: 'Polygon',
              coordinates: [[ll(-10, 9), ll(10, 9), ll(10, 21), ll(-10, 21), ll(-10, 9)]],
            },
            { building: 'yes' },
          ),
        ],
      },
      { infill: false, decorate: false },
    );
    expect(m.buildings.some((b) => b.ref === 'osm:house')).toBe(true);
    expect(validateCity(m).counts['building.float'] ?? 0).toBe(0);
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

let fixtureModel: ReturnType<typeof compileCity> | null = null;
/**
 * The Zonguldak fixture compiled once for the file: a compile takes 30–70 s on
 * CI, and five tests used to repeat it (one ran past its time limit there).
 * Tests only read the model.
 */
const compiledFixture = () =>
  (fixtureModel ??= compileCity(JSON.parse(readFileSync(FIXTURE, 'utf8')) as CitySource));

describe.skipIf(!existsSync(FIXTURE))('Zonguldak fixture', () => {
  it('keeps street layers off the carriageway (no sidewalk over a road)', () => {
    const m = compiledFixture();
    expect(validateCity(m).counts['surface.over-carriageway'] ?? 0).toBe(0);
  }, 180_000);

  it('keeps synthetic buildings off roads and observed buildings', () => {
    const m = compiledFixture();
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
  }, 180_000);

  it('lets no ground prop intersect a building or another generated prop', () => {
    const m = compiledFixture();
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
  }, 180_000);

  it('lays out a surface car park: stall lines, cars inside, a booth at the entrance', () => {
    const lot: [number, number][] = [
      [-40, 12],
      [40, 12],
      [40, 52],
      [-40, 52],
      [-40, 12],
    ];
    const m = compileCity(
      {
        ...gridSource(),
        osm: [],
        features: [
          {
            ref: 'osm:st',
            source: 'osm',
            priority: 0,
            kind: 'road' as const,
            geometry: {
              type: 'LineString' as const,
              coordinates: [ll(-120, 0), ll(120, 0)],
            },
            tags: { highway: 'residential' },
          },
          {
            ref: 'osm:lot',
            source: 'osm',
            priority: 0,
            kind: 'area' as const,
            geometry: { type: 'Polygon' as const, coordinates: [lot.map(([x, y]) => ll(x, y))] },
            tags: { amenity: 'parking' },
          },
        ],
      },
      { infill: false, decorate: false },
    );
    const ring = lot.slice(0, 4);
    const cars = m.props.filter((p) => p.kind === 'car');
    expect(cars.length).toBeGreaterThan(20);
    for (const c of cars) expect(pointInRing([c.position[0], c.position[1]], ring)).toBe(true);
    expect(m.markings.filter((mk) => mk.kind === 'stall').length).toBeGreaterThan(30);
    const booth = m.props.find((p) => p.kind === 'booth');
    expect(booth).toBeDefined();
    // At the side towards the street.
    expect(booth!.position[1]).toBeLessThan(25);
    expect(m.surfaces.find((sf) => sf.kind === 'parking')?.polygons.length).toBeGreaterThan(0);
  });

  it('narrows a wide deck into its branches, one against each edge', () => {
    const road = (ref: string, pts: [number, number][], tags: Record<string, string>) => ({
      ref,
      source: 'osm',
      priority: 0,
      kind: 'road' as const,
      geometry: { type: 'LineString' as const, coordinates: pts.map(([x, y]) => ll(x, y)) },
      tags,
    });
    const deck = { bridge: 'yes', layer: '1' };
    const m = compileCity(
      {
        ...gridSource(),
        osm: [],
        features: [
          road(
            'osm:in',
            [
              [-300, 0],
              [-200, 0],
            ],
            { highway: 'trunk', lanes: '3' },
          ),
          road(
            'osm:w',
            [
              [-200, 0],
              [0, 0],
            ],
            { highway: 'trunk', lanes: '3', ...deck },
          ),
          // Both branches leave on the same side at first, then part.
          road(
            'osm:a',
            [
              [0, 0],
              [100, 6],
              [200, 60],
            ],
            { highway: 'trunk', lanes: '2', ...deck },
          ),
          road(
            'osm:b',
            [
              [0, 0],
              [100, 3],
              [200, -60],
            ],
            { highway: 'trunk', lanes: '2', ...deck },
          ),
        ],
      },
      { infill: false, decorate: false },
    );
    const wide = m.bridges.reduce((a, b) => (a.width >= b.width ? a : b));
    const branches = m.bridges.filter(
      (b) => b !== wide && b.path.some((q) => Math.hypot(q[0], q[1]) < 2),
    );
    expect(branches).toHaveLength(2);
    // Lateral position of each branch where it leaves the wide deck.
    const ys = branches
      .map((b) =>
        b.path.reduce((a, q) => (Math.hypot(q[0], q[1]) < Math.hypot(a[0], a[1]) ? q : a)),
      )
      .map((q) => q[1])
      .sort((a, b) => a - b);
    const shift = (wide.width - branches[0].width) / 2;
    expect(ys[0]).toBeLessThan(-shift * 0.8);
    expect(ys[1]).toBeGreaterThan(shift * 0.8);
  });

  it('builds car parks, garden walls, hard ground and public facades from the data', () => {
    const m = compiledFixture();
    // Public buildings (schools, offices …) have no balconies.
    const pub = m.buildings.filter((b) => b.use === 'public');
    expect(pub.length).toBeGreaterThan(0);
    for (const b of pub)
      for (const f of b.facades)
        expect(f.bays.filter((k) => k === 'balcony' || k === 'glazed-balcony')).toEqual([]);
    // Garden walls exist and none runs through a building.
    const fences = m.fences ?? [];
    expect(fences.length).toBeGreaterThan(50);
    const boxes = m.buildings.map((b) => {
      const xs = b.footprint.outer.map((q) => q[0]);
      const ys = b.footprint.outer.map((q) => q[1]);
      return { b, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
    });
    const inside = (q: [number, number]) =>
      boxes.some(
        ({ b, box }) =>
          q[0] >= box[0] &&
          q[0] <= box[2] &&
          q[1] >= box[1] &&
          q[1] <= box[3] &&
          pointInRing(q, b.footprint.outer),
      );
    for (const f of fences.slice(0, 2000))
      for (const q of f.points) expect(inside(q as [number, number])).toBe(false);
    // Dense blocks get hard ground.
    const concrete = m.surfaces.find((sf) => sf.kind === 'concrete');
    expect(totalArea(concrete?.polygons ?? [])).toBeGreaterThan(1000);
  }, 180_000);

  it('hangs no balcony over a carriageway', () => {
    const m = compiledFixture();
    const roads = new RoadIndex(m.roads.filter((r) => r.grade === 'ground' && isVehicular(r.cls)));
    let balconies = 0;
    const over: string[] = [];
    for (const b of m.buildings) {
      const ring = b.footprint.outer;
      for (const f of b.facades) {
        const a = ring[f.edge];
        const c = ring[(f.edge + 1) % ring.length];
        const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
        const n: [number, number] = [-(c[1] - a[1]) / len, (c[0] - a[0]) / len];
        const kinds = new Set(f.bays.map((k, i) => [i, k] as const));
        for (const [, i, k] of f.cells ?? []) kinds.add([i, k]);
        kinds.forEach(([i, k]) => {
          if (k !== 'balcony' && k !== 'glazed-balcony') return;
          balconies++;
          const t = (i + 0.5) / f.bays.length;
          const mid: [number, number] = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t];
          // The balcony's outer edge, on whichever side of the wall is outdoors.
          const s = pointInRing([mid[0] + n[0] * 0.3, mid[1] + n[1] * 0.3], ring) ? -1 : 1;
          const tip: [number, number] = [mid[0] + s * n[0] * 1.3, mid[1] + s * n[1] * 1.3];
          const hit = roads.nearest(tip, 20);
          if (hit && hit.d < hit.road.width / 2) over.push(b.id);
        });
      }
    }
    expect(balconies).toBeGreaterThan(500);
    expect([...new Set(over)]).toEqual([]);
  }, 180_000);

  it('places no street furniture on a carriageway and no park tree in a street', () => {
    const m = compiledFixture();
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
  }, 180_000);
});
