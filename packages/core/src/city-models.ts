// =============================================================================
// City models — placed 3D models and facility twins (a twin inside the twin)
//
// The DT compiles the city from data: every building is generated. A placement
// puts a chosen model at a place instead: a built-in procedural model (prefab:
// wind turbine, solar farm, factory, airport terminal …) or a model the tenant
// uploaded (GLB, kept in object storage). A placement may replace a generated
// building (`replaces`): the DT then hides that building and draws the
// model in its place.
//
// A placement can carry a facility interior: levels → spaces → equipment, in
// metres in the placement's own frame. The DT shows it floor by floor; every
// space and piece of equipment is a city object of an ontology class and can be
// bound to a device for live data.
// Design: docs/architecture/cityos-live-city-engine.md §10
// =============================================================================

import { cityClass } from './city-ontology';

/** Built-in procedural models (drawn by the DT from parameters; no file). */
export type CityPrefabId =
  | 'wind_turbine'
  | 'solar_farm'
  | 'battery_storage'
  | 'substation'
  | 'factory'
  | 'warehouse'
  | 'airport_terminal'
  | 'control_tower'
  | 'hangar'
  | 'runway'
  | 'metro_entrance'
  | 'stadium'
  | 'civic_building'
  | 'water_tank'
  | 'port_crane'
  | 'cell_tower'
  | 'hospital'
  | 'school'
  | 'mosque'
  | 'apartment_block'
  | 'office_tower'
  | 'shopping_mall'
  | 'metro_station'
  | 'bus_shelter'
  | 'traffic_light'
  | 'street_lamp'
  | 'bench'
  | 'pedestrian_bridge'
  | 'fuel_station'
  | 'ev_charger'
  | 'fire_station'
  | 'police_station'
  | 'treatment_plant'
  | 'lighthouse'
  | 'ferry_pier'
  | 'container_stack'
  | 'ship'
  | 'aircraft'
  | 'metro_train'
  | 'bus_terminal'
  | 'city_bus'
  | 'tent_camp'
  | 'tower_crane';

/** Shelves of the model library. */
export type CityModelCategory =
  | 'buildings'
  | 'public'
  | 'transport'
  | 'aviation'
  | 'maritime'
  | 'energy'
  | 'infrastructure'
  | 'street'
  | 'vehicles'
  | 'emergency';

export const CITY_MODEL_CATEGORY_LABEL: Record<CityModelCategory, string> = {
  buildings: 'Yapılar',
  public: 'Kamu ve sosyal',
  transport: 'Ulaşım',
  aviation: 'Havacılık',
  maritime: 'Liman ve deniz',
  energy: 'Enerji',
  infrastructure: 'Altyapı',
  street: 'Sokak donatısı',
  vehicles: 'Araçlar',
  emergency: 'Afet ve inşaat',
};

export interface CityPrefabParam {
  key: string;
  label: string;
  unit?: string;
  default: number;
  min: number;
  max: number;
  /** Whole numbers only (counts, levels). */
  integer?: boolean;
}

export interface CityPrefabDef {
  id: CityPrefabId;
  label: string;
  /** Ontology class of the placed object (city-ontology.ts). */
  classId: string;
  category: CityModelCategory;
  params: CityPrefabParam[];
  /** The prefab comes with a default facility interior (levels, equipment). */
  interior?: boolean;
}

const P = (
  key: string,
  label: string,
  def: number,
  min: number,
  max: number,
  unit?: string,
  integer?: boolean,
): CityPrefabParam => ({ key, label, default: def, min, max, unit, integer });

export const CITY_PREFABS: readonly CityPrefabDef[] = [
  {
    id: 'wind_turbine',
    label: 'Rüzgâr türbini',
    classId: 'energy.wind_turbine',
    category: 'energy',
    params: [
      P('hubHeight', 'Göbek yüksekliği', 90, 30, 160, 'm'),
      P('rotor', 'Rotor çapı', 100, 20, 180, 'm'),
    ],
  },
  {
    id: 'solar_farm',
    label: 'Güneş santrali (GES)',
    classId: 'energy.solar_farm',
    category: 'energy',
    params: [
      P('width', 'Genişlik', 240, 20, 2000, 'm'),
      P('depth', 'Derinlik', 160, 20, 2000, 'm'),
      P('rowGap', 'Sıra aralığı', 9, 4, 20, 'm'),
      P('tilt', 'Panel eğimi', 25, 0, 45, '°'),
    ],
    interior: true,
  },
  {
    id: 'battery_storage',
    label: 'Enerji depolama (batarya)',
    classId: 'energy.battery_storage',
    category: 'energy',
    params: [P('containers', 'Konteyner sayısı', 8, 1, 60, undefined, true)],
  },
  {
    id: 'substation',
    label: 'Trafo merkezi',
    classId: 'energy.substation',
    category: 'energy',
    params: [P('width', 'Genişlik', 60, 15, 300, 'm'), P('depth', 'Derinlik', 40, 15, 300, 'm')],
    interior: true,
  },
  {
    id: 'factory',
    label: 'Fabrika',
    classId: 'building.industrial',
    category: 'buildings',
    params: [
      P('width', 'Genişlik', 90, 20, 600, 'm'),
      P('depth', 'Derinlik', 60, 15, 400, 'm'),
      P('height', 'Yükseklik', 12, 5, 40, 'm'),
      P('levels', 'Kat', 2, 1, 6, undefined, true),
      P('chimney', 'Baca', 1, 0, 4, undefined, true),
    ],
    interior: true,
  },
  {
    id: 'warehouse',
    label: 'Depo / lojistik',
    classId: 'building.warehouse',
    category: 'buildings',
    params: [
      P('width', 'Genişlik', 80, 15, 500, 'm'),
      P('depth', 'Derinlik', 50, 15, 300, 'm'),
      P('height', 'Yükseklik', 11, 5, 30, 'm'),
    ],
    interior: true,
  },
  {
    id: 'airport_terminal',
    label: 'Havalimanı terminali',
    classId: 'aviation.terminal',
    category: 'aviation',
    params: [
      P('length', 'Uzunluk', 320, 60, 1500, 'm'),
      P('depth', 'Derinlik', 90, 30, 300, 'm'),
      P('levels', 'Kat', 3, 1, 6, undefined, true),
      P('gates', 'Köprü (kapı)', 8, 0, 40, undefined, true),
    ],
    interior: true,
  },
  {
    id: 'control_tower',
    label: 'Kontrol kulesi',
    classId: 'aviation.airport',
    category: 'aviation',
    params: [P('height', 'Yükseklik', 45, 15, 120, 'm')],
  },
  {
    id: 'hangar',
    label: 'Hangar',
    classId: 'aviation.apron',
    category: 'aviation',
    params: [P('width', 'Genişlik', 70, 20, 200, 'm'), P('depth', 'Derinlik', 60, 20, 200, 'm')],
  },
  {
    id: 'runway',
    label: 'Pist',
    classId: 'aviation.runway',
    category: 'aviation',
    params: [P('length', 'Uzunluk', 3000, 400, 4500, 'm'), P('width', 'Genişlik', 45, 15, 75, 'm')],
  },
  {
    id: 'metro_entrance',
    label: 'Metro istasyonu girişi',
    classId: 'transit.station_entrance',
    category: 'transport',
    params: [P('width', 'Genişlik', 8, 4, 20, 'm')],
  },
  {
    id: 'stadium',
    label: 'Stadyum',
    classId: 'social.stadium',
    category: 'public',
    params: [
      P('length', 'Uzunluk', 230, 120, 320, 'm'),
      P('width', 'Genişlik', 180, 90, 260, 'm'),
      P('height', 'Yükseklik', 32, 12, 60, 'm'),
    ],
    interior: true,
  },
  {
    id: 'civic_building',
    label: 'Kamu binası (belediye, valilik)',
    classId: 'building.public',
    category: 'public',
    params: [
      P('width', 'Genişlik', 60, 15, 200, 'm'),
      P('depth', 'Derinlik', 30, 10, 120, 'm'),
      P('levels', 'Kat', 4, 1, 12, undefined, true),
    ],
    interior: true,
  },
  {
    id: 'water_tank',
    label: 'Su deposu',
    classId: 'water.reservoir',
    category: 'infrastructure',
    params: [P('diameter', 'Çap', 24, 4, 80, 'm'), P('height', 'Yükseklik', 12, 3, 40, 'm')],
  },
  {
    id: 'port_crane',
    label: 'Liman vinci',
    classId: 'maritime.crane',
    category: 'maritime',
    params: [P('height', 'Yükseklik', 50, 20, 90, 'm')],
  },
  {
    id: 'cell_tower',
    label: 'Baz istasyonu direği',
    classId: 'telecom.cell_tower',
    category: 'infrastructure',
    params: [P('height', 'Yükseklik', 35, 10, 80, 'm')],
  },
  {
    id: 'hospital',
    label: 'Hastane',
    classId: 'health.hospital',
    category: 'public',
    params: [
      P('width', 'Genişlik', 90, 30, 300, 'm'),
      P('depth', 'Derinlik', 50, 20, 200, 'm'),
      P('levels', 'Kat', 6, 2, 20, undefined, true),
    ],
    interior: true,
  },
  {
    id: 'school',
    label: 'Okul',
    classId: 'education.school',
    category: 'public',
    params: [
      P('width', 'Genişlik', 60, 20, 150, 'm'),
      P('depth', 'Derinlik', 18, 10, 60, 'm'),
      P('levels', 'Kat', 3, 1, 6, undefined, true),
    ],
    interior: true,
  },
  {
    id: 'mosque',
    label: 'Cami',
    classId: 'social.mosque',
    category: 'public',
    params: [
      P('size', 'Harim genişliği', 24, 8, 70, 'm'),
      P('minarets', 'Minare', 2, 0, 4, undefined, true),
    ],
  },
  {
    id: 'apartment_block',
    label: 'Apartman bloğu',
    classId: 'building.apartment',
    category: 'buildings',
    params: [
      P('width', 'Genişlik', 24, 10, 80, 'm'),
      P('depth', 'Derinlik', 14, 8, 40, 'm'),
      P('levels', 'Kat', 8, 2, 40, undefined, true),
      P('unitsPerFloor', 'Kat başına daire', 4, 1, 12, undefined, true),
    ],
    interior: true,
  },
  {
    id: 'office_tower',
    label: 'Ofis kulesi',
    classId: 'building.office',
    category: 'buildings',
    params: [
      P('width', 'Genişlik', 36, 15, 80, 'm'),
      P('depth', 'Derinlik', 36, 15, 80, 'm'),
      P('levels', 'Kat', 30, 5, 80, undefined, true),
    ],
    interior: true,
  },
  {
    id: 'shopping_mall',
    label: 'Alışveriş merkezi',
    classId: 'building.mall',
    category: 'buildings',
    params: [
      P('width', 'Genişlik', 160, 60, 400, 'm'),
      P('depth', 'Derinlik', 90, 40, 250, 'm'),
      P('levels', 'Kat', 3, 1, 6, undefined, true),
    ],
    interior: true,
  },
  {
    id: 'metro_station',
    label: 'Metro istasyonu (yeraltı)',
    classId: 'transit.metro_station',
    category: 'transport',
    params: [
      P('length', 'Peron uzunluğu', 120, 60, 220, 'm'),
      P('depth', 'Derinlik (yerin altında)', 18, 8, 40, 'm'),
    ],
    interior: true,
  },
  {
    id: 'bus_terminal',
    label: 'Şehirlerarası otobüs terminali (otogar)',
    classId: 'transit.bus_terminal',
    category: 'transport',
    params: [
      P('length', 'Uzunluk', 160, 60, 400, 'm'),
      P('depth', 'Bina derinliği', 32, 18, 70, 'm'),
      P('levels', 'Kat', 2, 1, 4, undefined, true),
      P('bays', 'Peron', 30, 6, 120, undefined, true),
    ],
    interior: true,
  },
  {
    id: 'bus_shelter',
    label: 'Otobüs durağı',
    classId: 'transit.bus_stop',
    category: 'street',
    params: [P('width', 'Genişlik', 6, 3, 12, 'm')],
  },
  {
    id: 'traffic_light',
    label: 'Trafik ışığı',
    classId: 'mobility.traffic_signal',
    category: 'street',
    params: [P('arm', 'Kol uzunluğu', 4, 0, 10, 'm')],
  },
  {
    id: 'street_lamp',
    label: 'Sokak lambası',
    classId: 'furniture.street_lamp',
    category: 'street',
    params: [P('height', 'Yükseklik', 8, 4, 14, 'm')],
  },
  {
    id: 'bench',
    label: 'Bank',
    classId: 'furniture.bench',
    category: 'street',
    params: [P('length', 'Uzunluk', 1.8, 1, 4, 'm')],
  },
  {
    id: 'pedestrian_bridge',
    label: 'Yaya üst geçidi',
    classId: 'civil.pedestrian_bridge',
    category: 'transport',
    params: [P('span', 'Açıklık', 30, 12, 80, 'm'), P('height', 'Yükseklik', 6, 5, 9, 'm')],
  },
  {
    id: 'fuel_station',
    label: 'Akaryakıt istasyonu',
    classId: 'mobility.fuel_station',
    category: 'transport',
    params: [P('pumps', 'Pompa adası', 4, 1, 10, undefined, true)],
  },
  {
    id: 'ev_charger',
    label: 'Şarj istasyonu',
    classId: 'mobility.ev_charger',
    category: 'transport',
    params: [P('chargers', 'Şarj ünitesi', 4, 1, 20, undefined, true)],
  },
  {
    id: 'fire_station',
    label: 'İtfaiye istasyonu',
    classId: 'safety.fire_station',
    category: 'public',
    params: [P('bays', 'Araç kapısı', 4, 1, 10, undefined, true)],
  },
  {
    id: 'police_station',
    label: 'Emniyet / karakol',
    classId: 'safety.police_station',
    category: 'public',
    params: [P('levels', 'Kat', 3, 1, 8, undefined, true)],
  },
  {
    id: 'treatment_plant',
    label: 'Arıtma tesisi',
    classId: 'water.treatment_plant',
    category: 'infrastructure',
    params: [P('tanks', 'Havuz', 6, 2, 16, undefined, true)],
  },
  {
    id: 'lighthouse',
    label: 'Deniz feneri',
    classId: 'maritime.lighthouse',
    category: 'maritime',
    params: [P('height', 'Yükseklik', 22, 8, 60, 'm')],
  },
  {
    id: 'ferry_pier',
    label: 'Vapur iskelesi',
    classId: 'maritime.pier',
    category: 'maritime',
    params: [P('length', 'Uzunluk', 40, 15, 120, 'm')],
  },
  {
    id: 'container_stack',
    label: 'Konteyner istifi',
    classId: 'maritime.container_yard',
    category: 'maritime',
    params: [
      P('rows', 'Sıra', 6, 1, 30, undefined, true),
      P('bays', 'Bölme', 10, 1, 40, undefined, true),
      P('tiers', 'Kat', 3, 1, 6, undefined, true),
    ],
  },
  {
    id: 'ship',
    label: 'Gemi',
    classId: 'maritime.vessel',
    category: 'vehicles',
    params: [P('length', 'Boy', 180, 30, 400, 'm')],
  },
  {
    id: 'aircraft',
    label: 'Yolcu uçağı',
    classId: 'aviation.aircraft',
    category: 'vehicles',
    params: [P('length', 'Boy', 40, 20, 75, 'm')],
  },
  {
    id: 'metro_train',
    label: 'Metro treni',
    classId: 'transit.metro_train',
    category: 'vehicles',
    params: [P('cars', 'Vagon', 4, 1, 10, undefined, true)],
  },
  {
    id: 'city_bus',
    label: 'Belediye otobüsü',
    classId: 'transit.bus',
    category: 'vehicles',
    params: [P('length', 'Boy', 12, 9, 18, 'm')],
  },
  {
    id: 'tent_camp',
    label: 'Afet çadır kenti',
    classId: 'safety.temporary_shelter',
    category: 'emergency',
    params: [
      P('rows', 'Sıra', 6, 1, 30, undefined, true),
      P('cols', 'Sütun', 10, 1, 40, undefined, true),
    ],
    interior: true,
  },
  {
    id: 'tower_crane',
    label: 'Kule vinç (inşaat)',
    classId: 'construction.tower_crane',
    category: 'emergency',
    params: [P('height', 'Yükseklik', 45, 20, 80, 'm'), P('jib', 'Bom', 50, 20, 80, 'm')],
  },
];

export function cityPrefab(id: string): CityPrefabDef | undefined {
  return CITY_PREFABS.find((p) => p.id === id);
}

/** Parameters with defaults filled in and values clamped to the prefab's ranges. */
export function prefabParams(
  id: CityPrefabId,
  given: Record<string, number> = {},
): Record<string, number> {
  const def = cityPrefab(id);
  const out: Record<string, number> = {};
  for (const p of def?.params ?? []) {
    const raw = Number.isFinite(given[p.key]) ? given[p.key] : p.default;
    const v = Math.min(p.max, Math.max(p.min, raw));
    out[p.key] = p.integer ? Math.round(v) : v;
  }
  return out;
}

// ─── Uploaded models ────────────────────────────────────────────────────────

export const CITY_MODEL_FORMATS = ['glb'] as const;
export type CityModelFormat = (typeof CITY_MODEL_FORMATS)[number];

/** Upload limit of one model file. */
export const CITY_MODEL_MAX_BYTES = 100 * 1024 * 1024;

/**
 * What one uploaded model may cost the viewer: checked at upload (a model over
 * them is refused with the reason), so any accepted model can be drawn.
 */
export const CITY_MODEL_RENDER_LIMITS = {
  /** Triangles drawn (mesh instances counted). */
  triangles: 2_000_000,
  /** Draw calls (mesh primitives × instances). */
  primitives: 4_000,
  /** Longest side of one texture (px). */
  textureSide: 8192,
  /** All texture pixels together (~256 MB of GPU memory at 4 bytes / px). */
  texturePixels: 64 * 1024 * 1024,
};

/** Measured cost of an uploaded model (stored with it, shown in the library). */
export interface CityModelStats {
  triangles: number;
  primitives: number;
  textures: number;
  maxTextureSide: number;
  texturePixels: number;
}

/** GET /dt/models — a model file the tenant uploaded. */
export interface CityModelAsset {
  id: string;
  name: string;
  format: CityModelFormat;
  sizeBytes: number;
  stats: CityModelStats | null;
  /** Browser URL of the file (tenant-checked storage route). */
  url: string;
  createdAt: string;
}

// ─── Placements ─────────────────────────────────────────────────────────────

export type CityModelSource =
  | { kind: 'prefab'; prefab: CityPrefabId; params?: Record<string, number> }
  | { kind: 'asset'; assetId: string };

/** A piece of equipment inside a facility (inverter, machine, gate, transformer …). */
export interface FacilityEquipment {
  id: string;
  name: string;
  classId: string;
  /** Metres in the placement frame: [x, y, z above the level floor] (see FacilitySpace). */
  position: [number, number, number];
  /** Size of its stand-in block in metres: [along x, along y, height]. */
  size: [number, number, number];
  heading?: number;
  /** Device key that carries its live data (devices.device_key). */
  deviceKey?: string;
}

/**
 * A room / hall / zone of a level, as a polygon in the placement frame: metres
 * from the placement point, x to the east and y to the north at heading 0; the
 * frame turns with the placement's heading.
 */
export interface FacilitySpace {
  id: string;
  name: string;
  classId?: string;
  polygon: [number, number][];
  equipment?: FacilityEquipment[];
}

export interface FacilityLevel {
  id: string;
  name: string;
  /** Floor height above the placement base (m). */
  elevation: number;
  height: number;
  spaces: FacilitySpace[];
}

export interface FacilityInterior {
  levels: FacilityLevel[];
}

/** GET /dt/placements — one placed model. */
export interface CityPlacement {
  id: string;
  name: string;
  /** Ontology class (city-ontology.ts) of the placed object. */
  classId: string;
  source: CityModelSource;
  lon: number;
  lat: number;
  /** Base height above sea level (m); null: on the terrain. */
  altitude: number | null;
  /** Degrees clockwise from north. */
  heading: number;
  scale: number;
  /**
   * Key of the generated building this model replaces: its canonical entity id,
   * or its source ref ("osm:w123") when it has none. The DT tile drops it.
   */
  replaces: string | null;
  interior: FacilityInterior | null;
  attrs: Record<string, unknown>;
  updatedAt: string;
}

/** POST /dt/placements, PATCH /dt/placements/:id */
export interface CityPlacementInput {
  name: string;
  classId: string;
  source: CityModelSource;
  lon: number;
  lat: number;
  altitude?: number | null;
  heading?: number;
  scale?: number;
  replaces?: string | null;
  interior?: FacilityInterior | null;
  attrs?: Record<string, unknown>;
}

/** Limits a placement must satisfy (shared by the API check and the editor). */
export const CITY_PLACEMENT_LIMITS = {
  scale: [0.05, 20] as const,
  altitude: [-500, 9000] as const,
  levels: 100,
  spacesPerLevel: 400,
  equipmentPerSpace: 2000,
  nameLength: 200,
};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Unsigned area of a ring (m²). */
const ringArea = (ring: [number, number][]): number =>
  Math.abs(
    ring.reduce((a, [x, y], i) => {
      const [nx, ny] = ring[(i + 1) % ring.length];
      return a + x * ny - nx * y;
    }, 0) / 2,
  );

/**
 * What is wrong with a placement (empty: valid). The API rejects an input with
 * problems; the editor shows them. `partial` checks only the fields given (PATCH).
 */
export function placementProblems(input: Partial<CityPlacementInput>, partial = false): string[] {
  const out: string[] = [];
  const L = CITY_PLACEMENT_LIMITS;
  const has = (k: keyof CityPlacementInput) => !partial || input[k] !== undefined;

  if (
    has('name') &&
    (typeof input.name !== 'string' || !input.name.trim() || input.name.length > L.nameLength)
  )
    out.push(`name: 1–${L.nameLength} karakter olmalı`);
  if (has('classId') && (typeof input.classId !== 'string' || !cityClass(input.classId)))
    out.push('classId: ontolojide yok');
  if (has('lon') && !(finite(input.lon) && input.lon >= -180 && input.lon <= 180))
    out.push('lon: -180…180');
  if (has('lat') && !(finite(input.lat) && input.lat >= -90 && input.lat <= 90))
    out.push('lat: -90…90');
  if (
    input.altitude != null &&
    !(finite(input.altitude) && input.altitude >= L.altitude[0] && input.altitude <= L.altitude[1])
  )
    out.push(`altitude: ${L.altitude[0]}…${L.altitude[1]} m`);
  if (input.heading !== undefined && !finite(input.heading)) out.push('heading: sayı olmalı');
  if (
    input.scale !== undefined &&
    !(finite(input.scale) && input.scale >= L.scale[0] && input.scale <= L.scale[1])
  )
    out.push(`scale: ${L.scale[0]}…${L.scale[1]}`);
  if (
    input.replaces != null &&
    (typeof input.replaces !== 'string' || !input.replaces.trim() || input.replaces.length > 200)
  )
    out.push('replaces: 1–200 karakterlik bina anahtarı olmalı');

  if (has('source')) {
    const src = input.source as CityModelSource | undefined;
    if (!src || typeof src !== 'object') out.push('source: zorunlu');
    else if (src.kind === 'prefab') {
      if (!cityPrefab(src.prefab)) out.push('source.prefab: bilinmeyen hazır model');
      for (const [k, v] of Object.entries(src.params ?? {}))
        if (!finite(v)) out.push(`source.params.${k}: sayı olmalı`);
    } else if (src.kind === 'asset') {
      if (!/^[0-9a-f-]{36}$/i.test(String(src.assetId))) out.push('source.assetId: UUID olmalı');
    } else out.push('source.kind: prefab | asset');
  }

  const interior = input.interior;
  if (interior != null) {
    const levels = Array.isArray(interior.levels) ? interior.levels : null;
    if (!levels || levels.length > L.levels) out.push(`interior.levels: en çok ${L.levels} kat`);
    for (const lv of levels ?? []) {
      if (!finite(lv?.elevation) || !finite(lv?.height) || lv.height <= 0)
        out.push(`interior.${lv?.id}: kat yüksekliği geçersiz`);
      const spaces = Array.isArray(lv?.spaces) ? lv.spaces : [];
      if (spaces.length > L.spacesPerLevel)
        out.push(`interior.${lv.id}: en çok ${L.spacesPerLevel} alan`);
      for (const sp of spaces) {
        if (
          !Array.isArray(sp?.polygon) ||
          sp.polygon.length < 3 ||
          !sp.polygon.every((q) => finite(q?.[0]) && finite(q?.[1])) ||
          ringArea(sp.polygon) < 0.5
        )
          out.push(`interior.${lv.id}.${sp?.id}: poligon geçersiz`);
        if (sp?.classId && !cityClass(sp.classId))
          out.push(`interior.${lv.id}.${sp.id}: sınıf ontolojide yok`);
        const eqs = Array.isArray(sp?.equipment) ? sp.equipment : [];
        if (eqs.length > L.equipmentPerSpace)
          out.push(`interior.${lv.id}.${sp.id}: çok fazla ekipman`);
        for (const e of eqs) {
          if (!cityClass(e?.classId)) out.push(`interior.${sp.id}.${e?.id}: sınıf ontolojide yok`);
          if (!e?.position?.every?.(finite) || !e?.size?.every?.((v) => finite(v) && v > 0))
            out.push(`interior.${sp.id}.${e?.id}: konum / boyut geçersiz`);
        }
      }
    }
  }
  return out;
}
