/**
 *   npx tsx --test tools/city/osm/osm-package.test.ts
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readDistricts, selectArea } from '../osm-city';
import {
  aerodromeReaches,
  anchor,
  areaKind,
  buildingUse,
  cyclewayOf,
  districtLocator,
  type Geometry,
  inOsmArea,
  inPolygon,
  osmRow,
  osmTheme,
  PackageWriter,
  parkingOf,
  poiKind,
  polygonTester,
  readOsm,
  type Ring,
  sidewalkSide,
} from './osm-package';

const square = (x0: number, y0: number, x1: number, y1: number): Ring => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];
const poly = (ring: Ring, ...holes: Ring[]): Geometry => ({
  type: 'Polygon',
  coordinates: [ring, ...holes],
});
const pt = (x: number, y: number): Geometry => ({ type: 'Point', coordinates: [x, y] });
const line = (...c: [number, number][]): Geometry => ({ type: 'LineString', coordinates: c });

/** The area of the tests: the unit square. */
const AREA = poly(square(0, 0, 1, 1));
const inside = (p: [number, number]) => inPolygon(p, AREA);

describe('areaKind', () => {
  it('maps tags to contract kinds, first rule wins', () => {
    assert.equal(areaKind({ leisure: 'park' }), 'park');
    assert.equal(areaKind({ leisure: 'garden' }), 'park');
    assert.equal(areaKind({ leisure: 'sports_centre' }), 'stadium');
    assert.equal(areaKind({ landuse: 'cemetery' }), 'cemetery');
    assert.equal(areaKind({ amenity: 'grave_yard' }), 'cemetery');
    assert.equal(areaKind({ military: 'barracks' }), 'military');
    assert.equal(areaKind({ military: 'bunker' }), null);
    assert.equal(areaKind({ amenity: 'parking' }), 'parking');
    assert.equal(areaKind({ amenity: 'parking', parking: 'multi-storey' }), null);
    assert.equal(areaKind({ amenity: 'hospital' }), 'school');
    assert.equal(areaKind({ aeroway: 'aerodrome' }), 'airport');
    assert.equal(areaKind({ aeroway: 'stopway' }), 'taxiway');
    assert.equal(areaKind({ power: 'substation' }), 'substation');
    assert.equal(areaKind({ power: 'substation', building: 'yes' }), null);
    assert.equal(areaKind({ natural: 'water' }), 'water');
    assert.equal(areaKind({ leisure: 'swimming_pool' }), 'water');
    assert.equal(areaKind({ landuse: 'railway' }), 'industrial');
    assert.equal(areaKind({ landuse: 'retail' }), 'residential');
    assert.equal(areaKind({ landuse: 'farmland' }), null);
    assert.equal(areaKind({ amenity: 'fuel', landuse: 'retail' }), 'fuel');
    // Order: a park in a residential landuse polygon is a park.
    assert.equal(areaKind({ leisure: 'park', landuse: 'residential' }), 'park');
  });
});

describe('osmTheme', () => {
  const a = poly(square(0, 0, 1, 1));
  it('selects the contract theme by tags and geometry', () => {
    assert.equal(osmTheme({ building: 'yes' }, a), 'building');
    assert.equal(osmTheme({ building: 'no', leisure: 'park' }, a), 'area');
    assert.equal(osmTheme({ man_made: 'silo' }, a), 'building');
    assert.equal(osmTheme({ building: 'yes' }, pt(0, 0)), null);
    assert.equal(osmTheme({ highway: 'residential' }, line([0, 0], [1, 1])), 'road');
    assert.equal(osmTheme({ aeroway: 'runway' }, line([0, 0], [1, 1])), 'road');
    assert.equal(osmTheme({ aeroway: 'runway' }, a), 'area');
    assert.equal(osmTheme({ railway: 'tram' }, line([0, 0], [1, 1])), 'road');
    assert.equal(osmTheme({ railway: 'abandoned' }, line([0, 0], [1, 1])), null);
    assert.equal(osmTheme({ highway: 'crossing' }, pt(0, 0)), 'crossing');
    assert.equal(osmTheme({ crossing: 'zebra' }, pt(0, 0)), 'crossing');
    assert.equal(osmTheme({ natural: 'tree' }, pt(0, 0)), 'tree');
    assert.equal(osmTheme({ highway: 'street_lamp' }, pt(0, 0)), 'asset');
    assert.equal(osmTheme({ power: 'pole' }, pt(0, 0)), 'asset');
    assert.equal(osmTheme({ railway: 'subway_entrance' }, pt(0, 0)), 'asset');
    assert.equal(osmTheme({ amenity: 'cafe' }, pt(0, 0)), 'poi');
    assert.equal(osmTheme({ shop: 'hairdresser' }, pt(0, 0)), 'poi');
    // Street furniture stays the asset theme's; amenities without a map icon are left out.
    assert.equal(osmTheme({ amenity: 'bench' }, pt(0, 0)), 'asset');
    assert.equal(osmTheme({ amenity: 'shelter' }, pt(0, 0)), null);
    assert.equal(osmTheme({ landuse: 'farmland' }, a), null);
  });

  it('builds rows with contract values', () => {
    assert.equal(buildingUse({ building: 'yes', amenity: 'school' }), 'school');
    assert.equal(buildingUse({ building: 'yes', shop: 'mall' }), 'retail');
    assert.equal(
      buildingUse({ building: 'yes', man_made: 'tower', 'tower:type': 'minaret' }),
      'minaret',
    );
    assert.equal(buildingUse({ building: 'yes', amenity: 'place_of_worship' }), 'mosque');
    assert.equal(buildingUse({ building: 'apartments' }), 'residential');
    // A platform under the ground is carried as a building (with its layer), one on the surface is not.
    assert.equal(osmTheme({ railway: 'platform', layer: '-2' }, a), 'building');
    assert.equal(buildingUse({ railway: 'platform', layer: '-2' }), 'platform');
    assert.equal(osmTheme({ railway: 'platform' }, a), null);
    const road = osmRow('road', 'r', line([0, 0], [1, 1]), { highway: 'path', oneway: 'yes' });
    assert.ok(!('drop' in road));
    assert.equal(road.attrs.class, 'footway');
    assert.equal(road.attrs.oneway, true);
    const rail = osmRow('road', 'r', line([0, 0], [1, 1]), { railway: 'subway', lanes: '4' });
    assert.ok(!('drop' in rail) && rail.attrs.class === 'subway' && rail.attrs.lanes === 1);
    assert.deepEqual(osmRow('road', 'r', line([0, 0], [1, 1]), { highway: 'proposed' }), {
      drop: 'sınıf dışı (proposed)',
    });
    const crossing = osmRow('crossing', 'c', pt(0, 0), { crossing: 'unmarked' });
    assert.ok(!('drop' in crossing) && crossing.attrs.type === 'uncontrolled');
    const mast = osmRow('asset', 'm', pt(0, 0), { man_made: 'mast', 'tower:type': 'lighting' });
    assert.ok(!('drop' in mast) && mast.attrs.kind === 'floodlight');
    const entrance = osmRow('asset', 'e', pt(0, 0), { railway: 'subway_entrance', name: 'Çıkış' });
    assert.ok(!('drop' in entrance) && entrance.attrs.kind === 'subway_entrance');
    const poi = osmRow('poi', 'p', pt(0, 0), { shop: 'pastry', name: 'Fırın', brand: 'X' });
    assert.ok(!('drop' in poi));
    assert.deepEqual(poi.attrs, { kind: 'bakery', name: 'Fırın', brand: 'X' });
    assert.equal(poiKind({ tourism: 'guest_house' }), 'hotel');
    assert.equal(poiKind({ shop: 'vacant' }), null);
  });

  it('carries lane detail; a way one way against its drawing is drawn the way traffic goes', () => {
    const r = osmRow('road', 'r', line([0, 0], [1, 1]), {
      highway: 'primary',
      lanes: '3',
      'lanes:forward': '2',
      'lanes:backward': '1',
      'turn:lanes:forward': 'left|through;right',
      'width:lanes': '3.5|3.25|3.25',
      'sidewalk:left': 'yes',
      'sidewalk:right': 'no',
      'cycleway:right': 'lane',
      'parking:both': 'lane',
    });
    assert.ok(!('drop' in r));
    assert.equal(r.attrs.lanesForward, 2);
    assert.equal(r.attrs.lanesBackward, 1);
    assert.equal(r.attrs.turnLanesForward, 'left|through;right');
    assert.equal(r.attrs.widthLanes, '3.5|3.25|3.25');
    assert.equal(r.attrs.sidewalkSide, 'left');
    assert.equal(r.attrs.cycleway, 'lane');
    assert.equal(r.attrs.parking, 'both');
    const back = osmRow('road', 'b', line([0, 0], [1, 1]), {
      highway: 'secondary',
      oneway: '-1',
      'lanes:backward': '2',
      sidewalk: 'left',
    });
    assert.ok(!('drop' in back));
    assert.deepEqual((back.geometry as { coordinates: unknown }).coordinates, [
      [1, 1],
      [0, 0],
    ]);
    assert.equal(back.attrs.oneway, true);
    assert.equal(back.attrs.lanesForward, 2);
    assert.equal(back.attrs.sidewalkSide, 'right');
    assert.equal(sidewalkSide({ sidewalk: 'separate' }), 'separate');
    assert.equal(cyclewayOf({ cycleway: 'no' }), 'no');
    assert.equal(parkingOf({ 'parking:lane:right': 'parallel' }), 'right');
  });

  it('carries fuel stations as assets (points) and areas (grounds) with name and brand', () => {
    const tags = { amenity: 'fuel', name: 'Merkez', operator: 'Opet' };
    assert.equal(osmTheme(tags, pt(0, 0)), 'asset');
    assert.equal(osmTheme(tags, poly(square(0, 0, 1, 1))), 'area');
    const station = osmRow('asset', 's', pt(0, 0), tags);
    assert.ok(!('drop' in station));
    assert.deepEqual(
      [station.attrs.kind, station.attrs.name, station.attrs.brand],
      ['fuel_station', 'Merkez', 'Opet'],
    );
    const grounds = osmRow('area', 'g', poly(square(0, 0, 1, 1)), { ...tags, brand: 'Shell' });
    assert.ok(!('drop' in grounds));
    assert.deepEqual([grounds.attrs.kind, grounds.attrs.brand], ['fuel', 'Shell']);
    const dir = mkdtempSync(join(tmpdir(), 'osm-package-'));
    try {
      const file = new PackageWriter(dir, 'Test (ODbL)').writeLayer('asset', 'osm', [station], {
        source: 's',
        read: 1,
        dropped: {},
      });
      const props = JSON.parse(readFileSync(join(dir, file), 'utf8')).features[0].properties;
      assert.deepEqual([props.TUR, props.AD, props.MARKA], ['fuel_station', 'Merkez', 'Opet']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('area filtering', () => {
  it('anchors: point, middle vertex, vertex mean of the outer ring', () => {
    assert.deepEqual(anchor(pt(3, 4)), [3, 4]);
    assert.deepEqual(anchor(line([0, 0], [5, 5], [9, 9])), [5, 5]);
    assert.deepEqual(
      anchor(
        poly([
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
        ]),
      ),
      [1, 1],
    );
  });

  it('keeps a feature by its anchor', () => {
    assert.equal(inOsmArea('building', {}, poly(square(0.4, 0.4, 0.6, 0.6)), inside, []), true);
    // A road whose middle vertex is outside is left out, though it starts inside.
    const road = line([0.5, 0.5], [2, 2], [3, 3]);
    assert.equal(inOsmArea('road', { highway: 'primary' }, road, inside, []), false);
    assert.equal(inOsmArea('tree', {}, pt(1.5, 0.5), inside, []), false);
    // Holes are outside.
    const holed = poly(square(0, 0, 1, 1), square(0.25, 0.25, 0.75, 0.75));
    assert.equal(inPolygon([0.5, 0.5], holed), false);
    assert.equal(inPolygon([0.1, 0.1], holed), true);
  });

  it('keeps an airfield way whole when any vertex is in the area', () => {
    const runway = line([0.9, 0.5], [2, 0.5], [3, 0.5]); // anchor outside
    assert.equal(inOsmArea('road', { aeroway: 'runway' }, runway, inside, []), true);
    // …or in an aerodrome that reaches the area.
    const farTaxiway = line([5, 0.5], [6, 0.5], [7, 0.5]);
    assert.equal(inOsmArea('road', { aeroway: 'taxiway' }, farTaxiway, inside, []), false);
    const aerodrome = poly(square(0.8, 0, 8, 1));
    assert.equal(aerodromeReaches(aerodrome, inside), true);
    assert.equal(aerodromeReaches(poly(square(4, 0, 8, 1)), inside), false);
    assert.equal(inOsmArea('road', { aeroway: 'taxiway' }, farTaxiway, inside, [aerodrome]), true);
    // A road way in the aerodrome is not an airfield way: by its anchor.
    assert.equal(inOsmArea('road', { highway: 'service' }, farTaxiway, inside, [aerodrome]), false);
  });

  it('polygonTester answers as inPolygon', () => {
    // A jagged polygon with a hole, many vertices.
    const outer: Ring = [];
    for (let i = 0; i < 400; i++) {
      const a = (i / 400) * 2 * Math.PI;
      const r = 1 + 0.3 * Math.sin(7 * a) + 0.1 * Math.sin(31 * a);
      outer.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    outer.push(outer[0]);
    const g: Geometry = {
      type: 'MultiPolygon',
      coordinates: [[outer, square(-0.2, -0.2, 0.2, 0.2)], [square(3, 3, 4, 4)]],
    };
    const test = polygonTester(g);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 10 - 3;
    for (let k = 0; k < 20000; k++) {
      const p: [number, number] = [rnd() / 2, rnd() / 2];
      assert.equal(test(p), inPolygon(p, g), `at ${p}`);
    }
    for (const p of outer) assert.equal(test(p), inPolygon(p, g));
  });

  it('districtLocator returns the first district of the area containing the point', () => {
    const a = { key: 'A', name: 'A', geometry: poly(square(0, 0, 1, 1)) };
    const b = { key: 'B', name: 'B', geometry: poly(square(1, 0, 2, 1)) };
    const at = districtLocator([a, b]);
    assert.equal(at([0.5, 0.5])?.key, 'A');
    assert.equal(at([1.5, 0.5])?.key, 'B');
    assert.equal(at([5, 5]), undefined);
  });
});

describe('readOsm + PackageWriter', () => {
  it('gives tagged outlines their point of interest unless also mapped as a point', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osm-package-'));
    try {
      const f = (id: number, type: string, g: Geometry, tags: Record<string, string>) =>
        `\x1e${JSON.stringify({ type: 'Feature', geometry: g, properties: { '@type': type, '@id': id, ...tags } })}`;
      const seq = [
        // A school building with its node inside: one school.
        f(1, 'way', poly(square(0.1, 0.1, 0.101, 0.101)), {
          building: 'school',
          amenity: 'school',
          name: 'Okul',
        }),
        f(2, 'node', pt(0.1002, 0.1002), { amenity: 'school', name: 'Okul' }),
        // A hospital's grounds alone: its point at the middle.
        f(3, 'way', poly(square(0.3, 0.3, 0.302, 0.302)), { amenity: 'hospital', name: 'Hastane' }),
        '',
      ].join('\n');
      writeFileSync(join(dir, 'x.geojsonseq'), seq);
      const osm = await readOsm([join(dir, 'x.geojsonseq')], inside);
      assert.deepEqual(
        osm.rows.poi.map((r) => [r.id, r.attrs.kind]),
        [
          ['osm:n2', 'school'],
          ['osm:w3', 'hospital'],
        ],
      );
      const [hx, hy] = osm.rows.poi[1].geometry.coordinates as [number, number];
      assert.ok(Math.abs(hx - 0.301) < 1e-9 && Math.abs(hy - 0.301) < 1e-9);
      assert.deepEqual(osm.dropped.poi, { 'noktası da var': 1 });
      // The school building stays a building.
      assert.equal(osm.rows.building.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads an osmium export once per element and writes JSON.stringify bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osm-package-'));
    try {
      const f = (id: number, type: string, g: Geometry, tags: Record<string, string>) =>
        `\x1e${JSON.stringify({ type: 'Feature', geometry: g, properties: { '@type': type, '@id': id, ...tags } })}`;
      const seq = [
        f(1, 'way', poly(square(0.1, 0.1, 0.2, 0.2)), { building: 'yes', 'building:levels': '4' }),
        f(1, 'way', poly(square(0.1, 0.1, 0.2, 0.2)), { building: 'yes' }), // duplicate
        f(2, 'way', poly(square(5, 5, 6, 6)), { building: 'yes' }), // outside
        f(3, 'way', line([0.5, 0.5], [9, 0.5], [10, 0.5]), { aeroway: 'runway' }),
        f(4, 'way', line([0.5, 0.5], [0.6, 0.6]), { highway: 'construction' }),
        f(5, 'node', pt(0.5, 0.5), { natural: 'tree', species: 'Pinus' }),
        '',
      ].join('\n');
      writeFileSync(join(dir, 'x.geojsonseq'), seq);
      const osm = await readOsm([join(dir, 'x.geojsonseq')], inside);
      assert.equal(osm.read, 5);
      assert.deepEqual(
        osm.rows.building.map((r) => [r.id, r.attrs.levels]),
        [['osm:w1', 4]],
      );
      assert.deepEqual(osm.dropped.building, { 'demo alanı dışında': 1 });
      assert.deepEqual(
        osm.rows.road.map((r) => r.id),
        ['osm:w3'],
      );
      assert.deepEqual(osm.dropped.road, { 'sınıf dışı (construction)': 1 });
      assert.equal(osm.rows.tree[0].attrs.species, 'Pinus');

      const w = new PackageWriter(join(dir, 'pkg'), 'Test (ODbL)');
      const rows = [...osm.rows.building, { ...osm.rows.building[0], id: 'b2', extra: { X: 1 } }];
      const file = w.writeLayer('building', 'osm', rows, { source: 's', read: 1, dropped: {} });
      assert.equal(file, 'yapi_osm.geojson');
      const written = readFileSync(join(dir, 'pkg', file), 'utf8');
      const parsed = JSON.parse(written);
      assert.equal(written, JSON.stringify(parsed)); // compact, one JSON document
      assert.equal(parsed.attribution, 'Test (ODbL)');
      assert.equal(parsed.features.length, 2);
      assert.equal(parsed.features[0].properties.KIMLIK, 'osm:w1');
      assert.equal(parsed.features[0].properties.KAYNAK, 'gerçek');
      assert.equal(parsed.features[1].properties.X, 1);
      const empty = w.writeLayer('tree', 'osm', [], { source: 's', read: 0, dropped: {} });
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'pkg', empty), 'utf8')).features, []);
      assert.deepEqual(
        w.reports.map((r) => [r.layer, r.written]),
        [
          ['yapi_osm.geojson', 2],
          ['agac_osm.geojson', 0],
        ],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('osm-city districts', () => {
  const fc = {
    features: [
      { properties: { name: 'Keçiören', admin_level: '6' }, geometry: poly(square(0, 0, 1, 1)) },
      { properties: { name: 'Çankaya', admin_level: 6 }, geometry: poly(square(1, 0, 2, 1)) },
      { properties: { name: 'Ankara', admin_level: '4' }, geometry: poly(square(0, 0, 2, 1)) },
      { properties: { name: 'Çankaya', admin_level: '6' }, geometry: poly(square(1, 0, 2, 1)) },
      { properties: { name: 'Altındağ' }, geometry: line([0, 0], [1, 1]) },
      { properties: {}, geometry: poly(square(0, 0, 1, 1)) },
    ],
  };
  it('keeps admin_level 6 polygons with a name, one per name, sorted by name', () => {
    const { districts, dropped } = readDistricts(fc);
    assert.deepEqual(
      districts.map((d) => d.name),
      ['Çankaya', 'Keçiören'],
    );
    assert.deepEqual(dropped, {
      'admin_level ≠ 6': 1,
      'aynı ad (ilki alındı)': 1,
      'poligon değil': 1,
      'adı yok': 1,
    });
  });
  it('selects the named districts (Turkish case-insensitive) or all', () => {
    const { districts } = readDistricts(fc);
    assert.deepEqual(
      selectArea(districts, ['KEÇİÖREN']).map((d) => d.name),
      ['Keçiören'],
    );
    assert.equal(selectArea(districts).length, 2);
    assert.throws(() => selectArea(districts, ['Mamak']), /Mamak/);
  });
});
