import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileCity } from '../src/compile';
import { CutGround } from '../src/cuttings';
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
      ],
    };
    const m = compileCity(src, { infill: false, decorate: false });
    expect(m.cuttings).toHaveLength(2);
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
    expect(m.bridges.flatMap((b) => b.piers).length).toBeGreaterThanOrEqual(8);
    // The two ways form one continuous structure (no joint in the deck).
    expect(m.bridges).toHaveLength(1);
    // No lane markings painted on the ground under the deck.
    const under = m.markings.filter((mk) =>
      mk.points.some(([x, y]) => Math.abs(x) < 120 && Math.abs(y) < 6),
    );
    expect(under).toHaveLength(0);
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
  it('keeps street layers off the carriageway (no sidewalk over a road)', () => {
    const m = compileCity(JSON.parse(readFileSync(FIXTURE, 'utf8')) as CitySource);
    expect(validateCity(m).counts['surface.over-carriageway'] ?? 0).toBe(0);
  }, 60_000);

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
    const m = compileCity(JSON.parse(readFileSync(FIXTURE, 'utf8')) as CitySource);
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
  }, 60_000);

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
