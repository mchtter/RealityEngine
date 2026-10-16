/**
 * City delivery package from OpenStreetMap — the part of a city's package
 * (docs/data-spec/veri-teslim-sartnamesi.md) that any city gets from an
 * osmium export: buildings, roads (with airfield and rail lines), crossings,
 * trees, areas and street furniture, mapped onto the theme contracts
 * (CITY_CONTRACTS — column names are never written here), plus the district
 * boundary layer and the report (RAPOR.json).
 *
 * No side effects: tools/city/osm-city.ts (any city, OSM only) and
 * tools/city/izmir/build-package.ts (OSM + İzmir's open data) compose it.
 * City-specific steps plug into osmLayers() through its hooks.
 */
import {
  closeSync,
  createReadStream,
  mkdirSync,
  openSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { type CityTheme, CITY_CONTRACTS } from '@opentwin/shared';

export type Ring = [number, number][];
export type Geometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'LineString'; coordinates: Ring }
  | { type: 'MultiLineString'; coordinates: Ring[] }
  | { type: 'Polygon'; coordinates: Ring[] }
  | { type: 'MultiPolygon'; coordinates: Ring[][] };

export interface Row {
  id: string;
  geometry: Geometry;
  /** Canonical attribute keys of the theme contract (`kind`, `name` …). */
  attrs: Record<string, string | number | boolean | null | undefined>;
  /** Columns outside the contract, kept as source attributes. */
  extra?: Record<string, string | number | null>;
}

export interface Report {
  layer: string;
  theme: CityTheme;
  source: string;
  read: number;
  written: number;
  dropped: Record<string, number>;
}

// ─── Package writer ─────────────────────────────────────────────────────────

/** Contract column of an attribute key (throws on a key the contract lacks). */
export function columnOf(theme: CityTheme, key: string): string {
  const attr = CITY_CONTRACTS[theme]?.attributes.find((a) => a.key === key);
  if (!attr?.column) throw new Error(`${theme}.${key}: no delivery column in the contract`);
  return attr.column;
}

/**
 * Writes a package's layers (GeoJSON, contract columns, KIMLIK + KAYNAK) into
 * `outDir` and collects their reports for RAPOR.json.
 */
export class PackageWriter {
  readonly reports: Report[] = [];

  constructor(
    readonly outDir: string,
    readonly attribution: string,
  ) {
    mkdirSync(outDir, { recursive: true });
  }

  /**
   * `<contract file>_<name>.geojson` (`DEMO_` first when synthetic). Streamed
   * feature by feature — the same bytes as JSON.stringify of the whole
   * collection, without its string (a large city's buildings outgrow one).
   */
  writeLayer(
    theme: CityTheme,
    name: string,
    rows: Row[],
    report: Omit<Report, 'layer' | 'theme' | 'written'>,
    synthetic = false,
  ): string {
    const contract = CITY_CONTRACTS[theme];
    if (!contract?.file) throw new Error(`${theme}: no contract file name`);
    const file = `${synthetic ? 'DEMO_' : ''}${contract.file}${name ? `_${name}` : ''}.geojson`;
    const head = JSON.stringify({
      type: 'FeatureCollection',
      name: file.replace('.geojson', ''),
      attribution: this.attribution,
      features: [],
    });
    const fd = openSync(join(this.outDir, file), 'w');
    try {
      let buf = head.slice(0, -2); // …"features":[
      rows.forEach((r, i) => {
        const properties: Record<string, unknown> = { KIMLIK: r.id };
        for (const [k, v] of Object.entries(r.attrs))
          if (v !== undefined && v !== null) properties[columnOf(theme, k)] = v;
        Object.assign(properties, r.extra ?? {}, { KAYNAK: synthetic ? 'sentetik' : 'gerçek' });
        buf +=
          (i ? ',' : '') + JSON.stringify({ type: 'Feature', geometry: r.geometry, properties });
        if (buf.length > 1 << 20) {
          writeSync(fd, buf);
          buf = '';
        }
      });
      writeSync(fd, `${buf}]}`);
    } finally {
      closeSync(fd);
    }
    this.reports.push({ layer: file, theme, written: rows.length, ...report });
    return file;
  }

  /** RAPOR.json: build time, the area (district names) and every layer's report. */
  writeReport(area: string[]) {
    writeFileSync(
      join(this.outDir, 'RAPOR.json'),
      JSON.stringify({ built: new Date().toISOString(), area, reports: this.reports }, null, 2),
    );
  }

  printSummary() {
    for (const r of this.reports)
      console.log(
        `${r.layer.padEnd(34)} ${String(r.written).padStart(7)} / ${String(r.read).padEnd(7)} ${Object.entries(
          r.dropped,
        )
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ')}`,
      );
  }
}

// ─── Geometry helpers ───────────────────────────────────────────────────────

export function inRing([x, y]: [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function inPolygon(p: [number, number], g: Geometry): boolean {
  const polys =
    g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.some((rings) => inRing(p, rings[0]) && !rings.slice(1).some((h) => inRing(p, h)));
}

/**
 * inRing() over a ring's edges bucketed by latitude band: only the edges
 * that span the point's latitude are tested — the same edges, the same
 * test, the same answer as inRing(), fast on detailed boundaries.
 */
class RingIndex {
  private readonly minY: number;
  private readonly maxY: number;
  private readonly h: number;
  private readonly bands: number[][];

  constructor(private readonly ring: Ring) {
    const n = ring.length;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of ring) {
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    this.minY = minY;
    this.maxY = maxY;
    const count = maxY > minY ? Math.max(1, Math.ceil(n / 8)) : 1;
    this.h = count > 1 ? (maxY - minY) / count : 1;
    this.bands = Array.from({ length: count }, () => []);
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const lo = this.band(Math.min(ring[i][1], ring[j][1]));
      const hi = this.band(Math.max(ring[i][1], ring[j][1]));
      for (let b = lo; b <= hi; b++) this.bands[b].push(i);
    }
  }

  private band(y: number): number {
    return Math.max(0, Math.min(this.bands.length - 1, Math.floor((y - this.minY) / this.h)));
  }

  contains([x, y]: [number, number]): boolean {
    if (!(y >= this.minY && y <= this.maxY)) return false;
    const ring = this.ring;
    const n = ring.length;
    let inside = false;
    for (const i of this.bands[this.band(y)]) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[i === 0 ? n - 1 : i - 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
}

/** inPolygon() for one geometry, indexed (many points against one boundary). */
export function polygonTester(g: Geometry): (p: [number, number]) => boolean {
  const polys = (
    g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []
  ).map((rings) => rings.map((r) => new RingIndex(r)));
  return (p) =>
    polys.some(([outer, ...holes]) => outer.contains(p) && !holes.some((h) => h.contains(p)));
}

/** A representative point: the point itself, a line's middle vertex, a ring's vertex mean. */
export function anchor(g: Geometry): [number, number] | null {
  if (g.type === 'Point') return g.coordinates;
  if (g.type === 'LineString') return g.coordinates[Math.floor(g.coordinates.length / 2)] ?? null;
  const ring =
    g.type === 'Polygon'
      ? g.coordinates[0]
      : g.type === 'MultiPolygon'
        ? g.coordinates[0]?.[0]
        : g.coordinates[0];
  if (!ring?.length) return null;
  const n = ring.length;
  return [ring.reduce((a, p) => a + p[0], 0) / n, ring.reduce((a, p) => a + p[1], 0) / n];
}

// ─── Districts (the package's area) ─────────────────────────────────────────

export interface District {
  /** The source's own name (what a city's other data refers to). */
  key: string;
  /** The name written to the boundary layer. */
  name: string;
  geometry: Geometry;
}

/**
 * idari_sinir_ilce: every district, ids `<PREFIX>-ILCE-nn` in the given order.
 * `dropped`: the source's features that are not districts (counted as read too).
 */
export function writeDistricts(
  writer: PackageWriter,
  idPrefix: string,
  districts: District[],
  source: string,
  dropped: Record<string, number> = {},
) {
  writer.writeLayer(
    'boundary',
    'ilce',
    districts.map((d, i) => ({
      id: `${idPrefix}-ILCE-${String(i + 1).padStart(2, '0')}`,
      geometry: d.geometry,
      attrs: { level: 'district', name: d.name },
    })),
    {
      source,
      read: districts.length + Object.values(dropped).reduce((a, b) => a + b, 0),
      dropped,
    },
  );
}

/** The district of the area a point is in (the first, in the area's order), or undefined. */
export function districtLocator(area: District[]): (p: [number, number]) => District | undefined {
  const tests = area.map((d) => [d, polygonTester(d.geometry)] as const);
  return (p) => tests.find(([, inside]) => inside(p))?.[0];
}

// ─── OSM tags → contract values ─────────────────────────────────────────────

/** Contract values only: anything else is left out (and counted). */
export const ROAD_CLASS: Record<string, string> = {
  motorway: 'motorway',
  motorway_link: 'motorway',
  trunk: 'trunk',
  trunk_link: 'trunk',
  primary: 'primary',
  primary_link: 'primary',
  secondary: 'secondary',
  secondary_link: 'secondary',
  tertiary: 'tertiary',
  tertiary_link: 'tertiary',
  residential: 'residential',
  road: 'unclassified',
  unclassified: 'unclassified',
  living_street: 'living_street',
  pedestrian: 'pedestrian',
  service: 'service',
  footway: 'footway',
  path: 'footway',
  steps: 'steps',
  track: 'track',
  cycleway: 'cycleway',
};

/** `building=` values that say only "a building": its `amenity` / `shop` says what for. */
export const GENERIC_BUILDING = new Set(['yes', 'residential', 'apartments', 'commercial']);

/** Towers (man_made=tower) by `tower:type`: their own building uses (the compiler's forms). */
export const TOWER_USE: Record<string, string> = {
  minaret: 'minaret',
  communication: 'communication_tower',
  clock_tower: 'clock_tower',
};

export const BUILDING_USE: Record<string, string> = {
  residential: 'residential',
  apartments: 'residential',
  dormitory: 'residential',
  house: 'house',
  detached: 'house',
  semidetached_house: 'house',
  terrace: 'house',
  bungalow: 'house',
  commercial: 'commercial',
  hotel: 'commercial',
  retail: 'retail',
  supermarket: 'retail',
  office: 'office',
  public: 'public',
  government: 'public',
  civic: 'public',
  fire_station: 'public',
  train_station: 'train_station',
  school: 'school',
  kindergarten: 'school',
  university: 'university',
  college: 'university',
  hospital: 'hospital',
  mosque: 'mosque',
  church: 'church',
  cathedral: 'church',
  chapel: 'church',
  synagogue: 'public',
  industrial: 'industrial',
  factory: 'industrial',
  warehouse: 'warehouse',
  storage_tank: 'storage_tank',
  silo: 'silo',
  parking: 'parking',
  hangar: 'warehouse',
  garage: 'garage',
  garages: 'garage',
  shed: 'shed',
  hut: 'shed',
  cabin: 'shed',
  service: 'shed',
  toilets: 'shed',
  container: 'shed',
  kiosk: 'kiosk',
  roof: 'roof',
  carport: 'roof',
  greenhouse: 'greenhouse',
  stadium: 'stadium',
  grandstand: 'stadium',
};

export const ROOF: Record<string, string> = {
  flat: 'flat',
  hipped: 'hipped',
  pyramidal: 'hipped',
  gabled: 'gabled',
  saltbox: 'gabled',
};

/** `military=*` values that are grounds (not a building or a bunker on them). */
export const MILITARY_GROUNDS = new Set([
  'base',
  'barracks',
  'training_area',
  'airfield',
  'naval_base',
  'range',
]);

export function areaKind(t: Record<string, string>): string | null {
  if (t.leisure === 'park' || t.leisure === 'garden') return 'park';
  if (t.leisure === 'playground') return 'playground';
  // Sports grounds: the stadium / sports centre grounds, their pitches and tracks.
  if (t.leisure === 'stadium' || t.leisure === 'sports_centre') return 'stadium';
  if (t.leisure === 'pitch') return 'pitch';
  if (t.leisure === 'track') return 'track';
  if (t.amenity === 'bus_station') return 'bus_station';
  if (t.landuse === 'cemetery' || t.amenity === 'grave_yard') return 'cemetery';
  if (t.landuse === 'construction') return 'construction';
  if (t.landuse === 'quarry') return 'quarry';
  if (t.landuse === 'harbour' || t.landuse === 'port' || t.industrial === 'port') return 'harbour';
  if (t.landuse === 'military' || MILITARY_GROUNDS.has(t.military ?? '')) return 'military';
  if (t.amenity === 'marketplace') return 'marketplace';
  if (t.amenity === 'fuel') return 'fuel';
  // Surface car parks (a multi-storey / underground one is a building or nothing to see).
  if (
    t.amenity === 'parking' &&
    !['multi-storey', 'underground', 'rooftop'].includes(t.parking ?? '')
  )
    return 'parking';
  // School / university / hospital grounds (walled campus yards).
  if (
    ['school', 'kindergarten', 'college', 'university', 'hospital'].includes(t.amenity ?? '') ||
    t.landuse === 'education'
  )
    return 'school';
  if (t.aeroway === 'aerodrome') return 'airport';
  if (t.aeroway === 'apron') return 'apron';
  if (t.aeroway === 'runway') return 'runway';
  if (t.aeroway === 'taxiway' || t.aeroway === 'stopway') return 'taxiway';
  if (t.power === 'substation' && !t.building) return 'substation';
  if (t.power === 'plant' && !t.building) return 'power_plant';
  if (['grass', 'recreation_ground', 'meadow', 'village_green'].includes(t.landuse)) return 'grass';
  if (t.landuse === 'forest' || t.natural === 'wood') return 'forest';
  if (
    t.natural === 'water' ||
    t.landuse === 'reservoir' ||
    t.landuse === 'basin' ||
    t.leisure === 'swimming_pool'
  )
    return 'water';
  if (t.landuse === 'religious') return 'religious';
  if (['industrial', 'railway', 'brownfield'].includes(t.landuse)) return 'industrial';
  if (['residential', 'commercial', 'retail'].includes(t.landuse)) return 'residential';
  return null;
}

export const int = (v?: string) => {
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : undefined;
};
export const metres = (v?: string) => {
  const n = Number.parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
export const yes = (v?: string) =>
  v === undefined ? undefined : !['no', 'none', '0', 'false'].includes(v);

/** Airfield ways (centrelines) carried as road-theme lines of these classes. */
export const AIRFIELD_CLASS: Record<string, string> = {
  runway: 'runway',
  taxiway: 'taxiway',
  stopway: 'stopway',
  parking_position: 'stand',
};

/**
 * OSM rail lines carried as road-theme lines of these classes: one way per
 * track (`lanes` = 1), with their bridge / tunnel / layer. They line up with
 * OSM's buildings and platforms.
 */
export const RAIL_CLASS: Record<string, string> = {
  rail: 'rail',
  light_rail: 'rail',
  narrow_gauge: 'rail',
  subway: 'subway',
  tram: 'tram',
};

export const OSM_THEMES = ['building', 'road', 'crossing', 'tree', 'area', 'asset', 'poi'] as const;
export type OsmTheme = (typeof OSM_THEMES)[number];

/** The contract theme an OSM feature is carried in, or null (left out, not counted). */
export function osmTheme(t: Record<string, string>, g: Geometry): OsmTheme | null {
  // Silos and tanks are often mapped as man_made only: they are buildings here.
  const built =
    (t.building && t.building !== 'no') || t.man_made === 'silo' || t.man_made === 'storage_tank';
  return built && (g.type === 'Polygon' || g.type === 'MultiPolygon')
    ? 'building'
    : (t.highway || AIRFIELD_CLASS[t.aeroway ?? ''] || RAIL_CLASS[t.railway ?? '']) &&
        g.type === 'LineString'
      ? 'road'
      : g.type === 'Point' && (t.highway === 'crossing' || t.crossing)
        ? 'crossing'
        : g.type === 'Point' && t.natural === 'tree'
          ? 'tree'
          : g.type === 'Point' &&
              (t.highway === 'street_lamp' ||
                t.highway === 'traffic_signals' ||
                t.amenity === 'bench' ||
                t.amenity === 'waste_basket' ||
                t.amenity === 'fuel' ||
                t.power === 'pole' ||
                t.power === 'tower' ||
                t.man_made === 'mast' ||
                t.man_made === 'flagpole')
            ? 'asset'
            : g.type === 'Point' && poiKind(t)
              ? 'poi'
              : (g.type === 'Polygon' || g.type === 'MultiPolygon') && areaKind(t)
                ? 'area'
                : null;
}

/**
 * Whether a feature of `theme` belongs to the area. An airfield way is kept
 * whole when any of its vertices is in the area or in an aerodrome that
 * reaches the area (`airports`, from areaAerodromes): a runway cut at the
 * district line would put its threshold paint and lights short. Anything
 * else by its anchor().
 */
export function inOsmArea(
  theme: OsmTheme,
  t: Record<string, string>,
  g: Geometry,
  inside: (p: [number, number]) => boolean,
  airports: Geometry[],
): boolean {
  const airfield = theme === 'road' && !!AIRFIELD_CLASS[t.aeroway ?? ''];
  if (airfield)
    return (g as { coordinates: [number, number][] }).coordinates.some(
      (p) => inside(p) || airports.some((a) => inPolygon(p, a)),
    );
  const at = anchor(g);
  return !!at && inside(at);
}

/** building use (contract `use`) from a building's tags. */
export function buildingUse(t: Record<string, string>): string | undefined {
  return (
    (t.man_made === 'tower' ? (TOWER_USE[t['tower:type'] ?? ''] ?? 'tower') : undefined) ??
    (t.power === 'substation' ? 'substation' : undefined) ??
    (t.aeroway === 'terminal' ? 'terminal' : t.aeroway === 'hangar' ? 'warehouse' : undefined) ??
    // A generic building tagged with what it is for: a school, a hospital,
    // a mall (`building=yes` + `shop=mall` is how most malls are mapped).
    (GENERIC_BUILDING.has(t.building)
      ? (BUILDING_USE[t.amenity ?? ''] ??
        (t.shop === 'mall' || t.shop === 'supermarket' ? 'retail' : undefined))
      : undefined) ??
    BUILDING_USE[t.building] ??
    BUILDING_USE[t.man_made] ??
    (t.amenity === 'place_of_worship'
      ? t.religion === 'christian'
        ? 'church'
        : !t.religion || t.religion === 'muslim'
          ? 'mosque'
          : 'public'
      : undefined)
  );
}

const POI_AMENITY: Record<string, string> = {
  restaurant: 'restaurant',
  food_court: 'restaurant',
  fast_food: 'fast_food',
  cafe: 'cafe',
  ice_cream: 'cafe',
  bar: 'bar',
  pub: 'bar',
  biergarten: 'bar',
  pharmacy: 'pharmacy',
  hospital: 'hospital',
  clinic: 'clinic',
  doctors: 'clinic',
  dentist: 'clinic',
  school: 'school',
  university: 'university',
  college: 'university',
  kindergarten: 'kindergarten',
  childcare: 'kindergarten',
  library: 'library',
  place_of_worship: 'place_of_worship',
  theatre: 'culture',
  cinema: 'culture',
  arts_centre: 'culture',
  bank: 'bank',
  atm: 'atm',
  post_office: 'post_office',
  police: 'police',
  fire_station: 'fire_station',
  townhall: 'public_office',
  courthouse: 'public_office',
  bus_station: 'bus_station',
  parking: 'parking',
};
const POI_TOURISM: Record<string, string> = {
  hotel: 'hotel',
  hostel: 'hotel',
  guest_house: 'hotel',
  motel: 'hotel',
  museum: 'museum',
  gallery: 'museum',
  attraction: 'attraction',
  viewpoint: 'attraction',
};
const POI_SHOP: Record<string, string> = {
  bakery: 'bakery',
  pastry: 'bakery',
  confectionery: 'bakery',
  supermarket: 'supermarket',
  convenience: 'supermarket',
  greengrocer: 'supermarket',
  mall: 'mall',
  department_store: 'mall',
};

/**
 * The point-of-interest kind (contract POI_KINDS) of an OSM point, or null:
 * `amenity` / `tourism` values a map shows an icon for, and any `shop`
 * (street furniture — bench, waste basket, fuel — is the asset theme's).
 */
export function poiKind(t: Record<string, string>): string | null {
  const shop =
    t.shop && t.shop !== 'no' && t.shop !== 'vacant' ? (POI_SHOP[t.shop] ?? 'shop') : null;
  return POI_AMENITY[t.amenity ?? ''] ?? POI_TOURISM[t.tourism ?? ''] ?? shop;
}

/** A fuel station's brand: OSM `brand`, else its `operator` (many stations carry only one). */
const fuelBrand = (t: Record<string, string>) =>
  t.amenity === 'fuel' ? (t.brand ?? t.operator) : undefined;

/** The row of an OSM feature in its theme, or why it is left out. */
/** Which sides of a way have a sidewalk (contract `sidewalkSide`), from `sidewalk*` tags. */
export function sidewalkSide(t: Record<string, string>): string | undefined {
  const both = t['sidewalk:both'];
  const left = t['sidewalk:left'];
  const right = t['sidewalk:right'];
  const v = t.sidewalk;
  if (v === 'separate' || both === 'separate') return 'separate';
  if (v === 'both' || v === 'yes' || both === 'yes') return 'both';
  if (v === 'left' || v === 'right') return v;
  if (v === 'no' || v === 'none' || both === 'no') return 'no';
  const l = left === 'yes';
  const r = right === 'yes';
  if (l || r) return l && r ? 'both' : l ? 'left' : 'right';
  if (left === 'no' && right === 'no') return 'no';
  return undefined;
}

/** Cycle lane on a road (contract `cycleway`), from `cycleway*` tags. */
export function cyclewayOf(t: Record<string, string>): string | undefined {
  const vs = [t.cycleway, t['cycleway:both'], t['cycleway:left'], t['cycleway:right']].filter(
    Boolean,
  );
  if (!vs.length) return undefined;
  if (vs.some((v) => v === 'track' || v === 'opposite_track')) return 'track';
  if (vs.some((v) => v === 'lane' || v === 'opposite_lane')) return 'lane';
  if (vs.some((v) => v === 'shared_lane' || v === 'share_busway')) return 'shared';
  return vs.every((v) => v === 'no' || v === 'separate') ? 'no' : undefined;
}

/** Kerbside parking (contract `parking`), from `parking:<side>` / `parking:lane:<side>` tags. */
export function parkingOf(t: Record<string, string>): string | undefined {
  const side = (s: string) => {
    const v = t[`parking:${s}`] ?? t[`parking:lane:${s}`];
    return v === undefined
      ? undefined
      : !['no', 'no_parking', 'no_stopping', 'separate'].includes(v);
  };
  const both = side('both');
  const left = side('left') ?? both;
  const right = side('right') ?? both;
  if (left === undefined && right === undefined) return undefined;
  return left && right ? 'both' : left ? 'left' : right ? 'right' : 'no';
}

export function osmRow(
  theme: OsmTheme,
  id: string,
  g: Geometry,
  t: Record<string, string>,
): Row | { drop: string } {
  if (theme === 'building')
    return {
      id,
      geometry: g,
      attrs: {
        name: t.name,
        levels: int(t['building:levels']),
        levelsUnderground: int(t['building:levels:underground']),
        height: metres(t.height),
        layer: int(t.layer),
        use: buildingUse(t),
        roofShape: ROOF[t['roof:shape']],
        roofColour: t['roof:colour'],
        wallColour: t['building:colour'],
      },
    };
  if (theme === 'road') {
    const rail = t.highway ? undefined : RAIL_CLASS[t.railway ?? ''];
    const cls = ROAD_CLASS[t.highway] ?? AIRFIELD_CLASS[t.aeroway ?? ''] ?? rail;
    if (!cls) return { drop: `sınıf dışı (${t.highway})` };
    // oneway=-1: one way against the drawing — drawn the way traffic goes, so
    // what was "backward" (lanes, turns, the left sidewalk) is now forward.
    const reverse = t.oneway === '-1';
    const way = reverse
      ? {
          ...g,
          coordinates: [...(g as { coordinates: [number, number][] }).coordinates].reverse(),
        }
      : g;
    const fwd = reverse ? 'backward' : 'forward';
    const bwd = reverse ? 'forward' : 'backward';
    const side = sidewalkSide(t);
    return {
      id,
      geometry: way as Geometry,
      attrs: {
        name: t.name,
        class: cls,
        width: metres(t.width),
        lanes: rail ? 1 : int(t.lanes),
        lanesForward: int(t[`lanes:${fwd}`]),
        lanesBackward: int(t[`lanes:${bwd}`]),
        turnLanes: t['turn:lanes'],
        turnLanesForward: t[`turn:lanes:${fwd}`],
        turnLanesBackward: t[`turn:lanes:${bwd}`],
        widthLanes: t['width:lanes'],
        sidewalkSide:
          reverse && (side === 'left' || side === 'right')
            ? side === 'left'
              ? 'right'
              : 'left'
            : side,
        cycleway: cyclewayOf(t),
        parking: parkingOf(t),
        oneway: t.oneway ? ['yes', '1', '-1', 'true'].includes(t.oneway) : undefined,
        bridge: t.bridge ? yes(t.bridge) : undefined,
        tunnel: t.tunnel ? yes(t.tunnel) : undefined,
        layer: int(t.layer),
        roundabout: t.junction === 'roundabout' ? true : undefined,
        sidewalk: t.sidewalk ? yes(t.sidewalk) : undefined,
        ref: t.ref,
      },
    };
  }
  if (theme === 'crossing') {
    const c = t.crossing ?? '';
    const type =
      c === 'traffic_signals' || t.highway === 'traffic_signals'
        ? 'signals'
        : c === 'unmarked' || c === 'no'
          ? 'uncontrolled'
          : 'zebra';
    return { id, geometry: g, attrs: { type } };
  }
  if (theme === 'tree')
    return {
      id,
      geometry: g,
      attrs: { species: t.species ?? t.genus ?? t.taxon, height: metres(t.height) },
    };
  if (theme === 'asset') {
    const kind =
      t.highway === 'street_lamp'
        ? 'street_lamp'
        : t.highway === 'traffic_signals'
          ? 'traffic_signals'
          : t.amenity === 'bench'
            ? 'bench'
            : t.amenity === 'waste_basket'
              ? 'waste_basket'
              : t.amenity === 'fuel'
                ? 'fuel_station'
                : t.power === 'tower'
                  ? 'power_tower'
                  : t.man_made === 'mast'
                    ? t['tower:type'] === 'lighting'
                      ? 'floodlight'
                      : 'mast'
                    : t.man_made === 'flagpole'
                      ? 'flagpole'
                      : 'power_pole';
    return {
      id,
      geometry: g,
      attrs: { kind, name: t.name, brand: fuelBrand(t), country: t.country },
    };
  }
  if (theme === 'poi')
    return { id, geometry: g, attrs: { kind: poiKind(t), name: t.name, brand: t.brand } };
  return { id, geometry: g, attrs: { kind: areaKind(t), name: t.name, brand: fuelBrand(t) } };
}

// ─── Reading an osmium export ───────────────────────────────────────────────

interface OsmFeature {
  geometry: Geometry;
  properties: Record<string, string>;
}

/** The features of a GeoJSON text sequence (osmium export: RS-prefixed lines). */
export async function* readGeojsonseq(
  file: string,
  /** Lines without this text are skipped unparsed (a cheap pre-filter). */
  mustContain?: string,
): AsyncGenerator<OsmFeature> {
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const raw of lines) {
    if (mustContain && !raw.includes(mustContain)) continue;
    const line = raw.replace(/^\x1e/, '').trim();
    if (!line) continue;
    yield JSON.parse(line) as OsmFeature;
  }
}

/** Whether an aerodrome outline reaches the area (a vertex of an outer ring inside). */
export function aerodromeReaches(g: Geometry, inside: (p: [number, number]) => boolean): boolean {
  if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') return false;
  const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map((p) => p[0]);
  return rings.some((r) => r.some((p) => inside(p as [number, number])));
}

/**
 * Aerodromes that reach into the area: every airfield way inside them is
 * kept (İzmir: Adnan Menderes' runways run on into Menderes district).
 */
export async function areaAerodromes(
  files: string[],
  inside: (p: [number, number]) => boolean,
): Promise<Geometry[]> {
  const out: Geometry[] = [];
  for (const file of files)
    for await (const f of readGeojsonseq(file, 'aerodrome')) {
      if (f.properties.aeroway !== 'aerodrome') continue;
      if (aerodromeReaches(f.geometry, inside)) out.push(f.geometry);
    }
  return out;
}

export type OsmRows = Record<OsmTheme, Row[]>;

export interface OsmRead {
  rows: OsmRows;
  dropped: Record<OsmTheme, Record<string, number>>;
  /** Features read (each element once). */
  read: number;
}

/**
 * The contract rows of the OSM features in the area. `files` are read in
 * order; an element in more than one (by type, id and geometry type) is
 * taken once.
 */
export async function readOsm(
  files: string[],
  inside: (p: [number, number]) => boolean,
): Promise<OsmRead> {
  const seen = new Set<string>();
  const rows = Object.fromEntries(OSM_THEMES.map((k) => [k, []])) as unknown as OsmRows;
  const dropped = Object.fromEntries(OSM_THEMES.map((k) => [k, {}])) as OsmRead['dropped'];
  let read = 0;
  const bump = (t: OsmTheme, why: string) => (dropped[t][why] = (dropped[t][why] ?? 0) + 1);
  const airports = await areaAerodromes(files, inside);
  /** Points of interest from outlines (kept unless the same place is also mapped as a point). */
  const outlined: Row[] = [];
  for (const file of files)
    for await (const f of readGeojsonseq(file)) {
      const t = f.properties;
      const id = `osm:${String(t['@type'] ?? 'x').charAt(0)}${t['@id']}`;
      const dup = `${id}|${f.geometry.type}`;
      if (seen.has(dup)) continue;
      seen.add(dup);
      read++;
      const g = f.geometry;
      // A building or ground tagged as a point of interest (a school, a hospital's
      // grounds) also gives its point, inside the outline.
      if ((g.type === 'Polygon' || g.type === 'MultiPolygon') && poiKind(t)) {
        const at = interiorAnchor(g);
        if (!at) bump('poi', 'iç nokta bulunamadı');
        else if (inside(at)) {
          const row = osmRow('poi', id, { type: 'Point', coordinates: at }, t);
          if (!('drop' in row)) outlined.push(row);
        } else bump('poi', 'demo alanı dışında');
      }
      const theme = osmTheme(t, g);
      if (!theme) continue;
      if (!inOsmArea(theme, t, g, inside, airports)) {
        bump(theme, 'demo alanı dışında');
        continue;
      }
      const row = osmRow(theme, id, g, t);
      if ('drop' in row) bump(theme, row.drop);
      else rows[theme].push(row);
    }
  rows.poi.push(...dropMappedTwice(outlined, rows.poi, () => bump('poi', 'noktası da var')));
  return { rows, dropped, read };
}

/**
 * A point inside an outline for its point of interest: the vertex mean, else
 * its box's centre, if inside (null for a ring curled round both).
 */
export function interiorAnchor(g: Geometry): [number, number] | null {
  const ring =
    g.type === 'Polygon'
      ? g.coordinates[0]
      : g.type === 'MultiPolygon'
        ? g.coordinates[0]?.[0]
        : null;
  if (!ring || ring.length < 4) return null;
  // Without the closing vertex (it repeats the first).
  const open = ring.slice(0, -1);
  const mean: [number, number] = [
    open.reduce((a, p) => a + p[0], 0) / open.length,
    open.reduce((a, p) => a + p[1], 0) / open.length,
  ];
  if (inPolygon(mean, g)) return mean;
  const xs = open.map((p) => p[0]);
  const ys = open.map((p) => p[1]);
  const box: [number, number] = [
    (Math.min(...xs) + Math.max(...xs)) / 2,
    (Math.min(...ys) + Math.max(...ys)) / 2,
  ];
  return inPolygon(box, g) ? box : null;
}

/** Same kind and name within this distance (degrees, ~200 m): one place mapped twice. */
const TWICE = 0.002;

/** Outline points of interest that are not also mapped as a point nearby (same kind and name). */
function dropMappedTwice(outlined: Row[], points: Row[], dropped: () => void): Row[] {
  const byKey = new Map<string, [number, number][]>();
  for (const r of points) {
    if (!r.attrs.name || r.geometry.type !== 'Point') continue;
    const k = `${String(r.attrs.kind)}|${String(r.attrs.name)}`;
    const list = byKey.get(k) ?? [];
    list.push(r.geometry.coordinates);
    byKey.set(k, list);
  }
  return outlined.filter((r) => {
    if (!r.attrs.name || r.geometry.type !== 'Point') return true;
    const [x, y] = r.geometry.coordinates;
    const twin = byKey
      .get(`${String(r.attrs.kind)}|${String(r.attrs.name)}`)
      ?.some((q) => Math.abs(q[0] - x) < TWICE && Math.abs(q[1] - y) < TWICE);
    if (twin) dropped();
    return !twin;
  });
}

/** City-specific steps around the OSM layers. */
export interface OsmHooks {
  /** Adds attributes from the city's own data to the OSM buildings (the roads are OSM's). */
  enrichBuildings?: (buildings: Row[], roads: Row[], dropped: Record<string, number>) => void;
  /** Road-theme rows from the city's own data, appended after OSM's (e.g. rail lines). */
  extraRoads?: (roads: Row[]) => Row[];
}

export interface OsmLayersOptions {
  /** osmium exports (geojsonseq), read in order: the extract first, then additions. */
  files: string[];
  /** Whether a point is in the package's area. */
  inside: (p: [number, number]) => boolean;
  /** The layers' `source` in the report. */
  source: string;
  /** The building layer's `source` when enrichBuildings adds another (default `source`). */
  buildingSource?: string;
  hooks?: OsmHooks;
}

/** Reads the OSM features and writes the seven `*_osm` layers (after the city's hooks). */
export async function osmLayers(writer: PackageWriter, opts: OsmLayersOptions): Promise<OsmRead> {
  const osm = await readOsm(opts.files, opts.inside);
  const { rows: out, dropped: drop, read } = osm;
  const src = opts.source;
  opts.hooks?.enrichBuildings?.(out.building, out.road, drop.building);
  if (opts.hooks?.extraRoads) out.road.push(...opts.hooks.extraRoads(out.road));
  writer.writeLayer('building', 'osm', out.building, {
    source: opts.buildingSource ?? src,
    read,
    dropped: drop.building,
  });
  writer.writeLayer('road', 'osm', out.road, { source: src, read, dropped: drop.road });
  writer.writeLayer('crossing', 'osm', out.crossing, { source: src, read, dropped: drop.crossing });
  writer.writeLayer('tree', 'osm', out.tree, { source: src, read, dropped: drop.tree });
  writer.writeLayer('area', 'osm', out.area, { source: src, read, dropped: drop.area });
  writer.writeLayer('asset', 'osm', out.asset, { source: src, read, dropped: drop.asset });
  writer.writeLayer('poi', 'osm', out.poi, { source: src, read, dropped: drop.poi });
  return osm;
}
