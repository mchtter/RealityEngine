// =============================================================================
// Canonical city model — theme contracts and API shapes
//
// A record belongs to a theme ("is a building") only when it satisfies that
// theme's versioned contract. The contract is the single definition used by
// the ingest rule checks (gis-service), the source screens, the data health
// report and the data delivery specification handed to institutions.
// Design: docs/architecture/city-data-onboarding.md
// =============================================================================

export type CityTheme = 'boundary' | 'parcel' | 'building' | 'address' | 'road' | 'area' | 'asset';

export type CityGeometryType =
  | 'Point'
  | 'MultiPoint'
  | 'LineString'
  | 'MultiLineString'
  | 'Polygon'
  | 'MultiPolygon';

/** reject: the record does not enter the theme; warn: it enters, flagged. */
export type CityRuleSeverity = 'reject' | 'warn';

export interface CityRuleDef {
  /** Stable code stored with rejects / quality flags ("geom.area"). */
  code: string;
  severity: CityRuleSeverity;
  label: string;
  description: string;
  params?: Record<string, number>;
}

export interface CityAttributeDef {
  /** Key in the canonical record (`attrs.<key>`). */
  key: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'enum';
  label: string;
  description?: string;
  /** Inclusive numeric bounds; values outside are dropped with a warning. */
  range?: [number, number];
  /** Allowed values for `enum`. */
  values?: readonly string[];
}

export interface CityThemeContract {
  theme: CityTheme;
  version: string;
  label: string;
  geometry: CityGeometryType[];
  attributes: CityAttributeDef[];
  rules: CityRuleDef[];
}

/** Road classes the city compiler draws (same names as OSM `highway`). */
export const CITY_ROAD_CLASSES = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'unclassified',
  'living_street',
  'pedestrian',
  'service',
  'footway',
  'steps',
  'track',
  'cycleway',
] as const;
export type CityRoadClass = (typeof CITY_ROAD_CLASSES)[number];

const ID_RULES: CityRuleDef[] = [
  {
    code: 'id.present',
    severity: 'reject',
    label: 'Kimlik var',
    description: 'Kaynakta kayda ait boş olmayan bir kimlik (ör. KIMLIKNO) bulunmalı.',
  },
  {
    code: 'id.unique',
    severity: 'reject',
    label: 'Kimlik tekil',
    description: 'Aynı kimlik kaynakta birden fazla kayıtta geçmemeli.',
  },
];

const GEOMETRY_VALID: CityRuleDef = {
  code: 'geom.valid',
  severity: 'reject',
  label: 'Geçerli geometri',
  description:
    'Geometri boş olmamalı ve geçerli olmalı. Onarılabilen geometri onarılır ve "geom.repaired" uyarısı alır.',
};

const SCOPE_RULE: CityRuleDef = {
  code: 'scope.workArea',
  severity: 'reject',
  label: 'Çalışma alanında',
  description: 'Kayıt kurumun tanımlı çalışma alanıyla kesişmeli (çalışma alanı yoksa uygulanmaz).',
};

export const BUILDING_CONTRACT_V1: CityThemeContract = {
  theme: 'building',
  version: '1',
  label: 'Yapı',
  geometry: ['Polygon', 'MultiPolygon'],
  attributes: [
    { key: 'name', type: 'string', label: 'Ad' },
    {
      key: 'levels',
      type: 'integer',
      label: 'Zemin üstü kat sayısı',
      range: [0, 99],
      description: 'Yoksa DT kat sayısını tahmin eder ve tahmin olarak işaretler.',
    },
    { key: 'levelsUnderground', type: 'integer', label: 'Zemin altı kat sayısı', range: [0, 19] },
    { key: 'height', type: 'number', label: 'Yükseklik (m)', range: [1, 400] },
    { key: 'use', type: 'string', label: 'Kullanım' },
    {
      key: 'parcelId',
      type: 'string',
      label: 'Parsel kimliği',
      description:
        'Yapının üzerinde durduğu parselin kimliği (MAKS PARSELKIML). Parsel anahtarlı senaryolar binayı bununla bulur.',
    },
  ],
  rules: [
    {
      code: 'geom.type',
      severity: 'reject',
      label: 'Poligon',
      description: 'Yapı geometrisi Polygon ya da MultiPolygon olmalı.',
    },
    GEOMETRY_VALID,
    {
      code: 'geom.area',
      severity: 'reject',
      label: 'Taban alanı',
      description: 'Taban alanı 4 m² ile 50.000 m² arasında olmalı.',
      params: { min: 4, max: 50_000 },
    },
    ...ID_RULES,
    SCOPE_RULE,
    {
      code: 'levels.range',
      severity: 'warn',
      label: 'Kat sayısı',
      description: 'Zemin üstü kat sayısı verilmeli ve 0–99 aralığında olmalı.',
      params: { min: 0, max: 99 },
    },
    {
      code: 'overlap.sameTheme',
      severity: 'warn',
      label: 'Çakışma',
      description:
        "Aynı kaynaktaki başka bir yapıyla örtüşme, küçük yapının alanının %10'unu aşmamalı.",
      params: { maxShare: 0.1 },
    },
  ],
};

export const ROAD_CONTRACT_V1: CityThemeContract = {
  theme: 'road',
  version: '1',
  label: 'Yol',
  geometry: ['LineString', 'MultiLineString'],
  attributes: [
    { key: 'name', type: 'string', label: 'Ad' },
    {
      key: 'class',
      type: 'enum',
      label: 'Yol sınıfı',
      values: CITY_ROAD_CLASSES,
      description: 'Kaynaktaki sınıf / tip değeri eşleme tablosuyla bu listeye çevrilir.',
    },
    { key: 'width', type: 'number', label: 'Taşıt yolu genişliği (m)', range: [1, 60] },
    { key: 'lanes', type: 'integer', label: 'Şerit sayısı', range: [1, 12] },
    { key: 'oneway', type: 'boolean', label: 'Tek yön' },
    { key: 'bridge', type: 'boolean', label: 'Köprü' },
    { key: 'tunnel', type: 'boolean', label: 'Tünel' },
    { key: 'layer', type: 'integer', label: 'Kot katmanı', range: [-5, 5] },
  ],
  rules: [
    {
      code: 'geom.type',
      severity: 'reject',
      label: 'Çizgi',
      description: 'Yol geometrisi LineString ya da MultiLineString (orta hat) olmalı.',
    },
    GEOMETRY_VALID,
    {
      code: 'geom.length',
      severity: 'reject',
      label: 'Uzunluk',
      description: 'Yol uzunluğu 1 m ile 50 km arasında olmalı.',
      params: { min: 1, max: 50_000 },
    },
    ...ID_RULES,
    SCOPE_RULE,
    {
      code: 'class.known',
      severity: 'warn',
      label: 'Yol sınıfı',
      description:
        'Sınıf bilinen bir değere eşlenmeli; eşlenemeyen yol "unclassified" olarak alınır.',
    },
    {
      code: 'width.range',
      severity: 'warn',
      label: 'Genişlik',
      description: 'Verilen genişlik 1–60 m aralığında olmalı; dışındaysa yok sayılır.',
      params: { min: 1, max: 60 },
    },
  ],
};

/** Contracts in force, by theme. Themes without one cannot be bound yet. */
export const CITY_CONTRACTS: Partial<Record<CityTheme, CityThemeContract>> = {
  building: BUILDING_CONTRACT_V1,
  road: ROAD_CONTRACT_V1,
};

// ─── Identifier keys ────────────────────────────────────────────────────────

/**
 * Column names (normalised: lower case, Turkish letters folded, only a–z0–9)
 * that carry a parcel identifier: MAKS PARSELKIML (10-character shapefile
 * name), MEGSİS tapukimlik, revenue records' parselKodu / kadastroParselKodu.
 * Measured on Zonguldak 2026-10-01: these hold the same numbering.
 */
export const PARCEL_KEY_COLUMNS = [
  'parselkiml',
  'parselkimlik',
  'parselkimlikno',
  'parselkodu',
  'tapukimlik',
  'tapukimlikno',
  'kadastroparselkodu',
  'parcelid',
] as const;

/** Column name as compared against key lists ("PARSEL_KODU" → "parselkodu"). */
export function normalizeKeyColumn(name: string): string {
  return name
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9]/g, '');
}

/** True when a join column names a parcel identifier. */
export function isParcelKeyColumn(name: string): boolean {
  return (PARCEL_KEY_COLUMNS as readonly string[]).includes(normalizeKeyColumn(name));
}

// ─── Source binding ─────────────────────────────────────────────────────────

/**
 * Theme attribute → source column. `classMap` turns source class / type codes
 * into canonical values (e.g. MAKS yol TIP 1 → residential). `idScheme` names
 * the identifier system of the source id ("maks.yapi.kimlikno") for the
 * identifier crosswalk.
 */
export interface CitySourceMapping {
  id?: string;
  idScheme?: string;
  attrs?: Record<string, string>;
  classMap?: Record<string, CityRoadClass>;
}

/** Where a theme source reads from: an external table or a platform layer. */
export type CitySourceKind = 'extdb' | 'layer' | 'file' | 'plugin';

export interface CitySourceInput {
  theme: CityTheme;
  /** External database table: connection + `table` / `schema.table`. */
  connectionId?: string;
  table?: string;
  /** Platform layer (uploads, drawings, WFS imports …). */
  layerId?: string;
  name?: string;
  /** Short source label shown to users and in identifiers ("maks"). */
  label?: string;
  priority?: number;
  authoritative?: boolean;
  mapping?: CitySourceMapping;
  /** Only when a table's geometry has no SRID. */
  srid?: number;
}

export interface CitySourcePreview {
  kind: CitySourceKind;
  /** Table sources. */
  schema?: string;
  table?: string;
  geomColumn?: string;
  srid?: number;
  /** Layer sources. */
  layerId?: string;
  layerName?: string;
  layerType?: string;
  /** Column / property names available for mapping. */
  columns: string[];
  /** Mapping detected from the column names (MAKS, Turkish / English variants). */
  mapping: CitySourceMapping;
  contract: CityThemeContract;
  /**
   * Geometry comes from vector tiles (PMTiles): simplified at the archive's
   * maximum zoom and cut at tile edges — pieces are re-joined by id on sync.
   */
  lossyGeometry?: boolean;
  /** Columns look like an OpenStreetMap extract (osm_id, all_tags …): not institutional data. */
  osmDerived?: boolean;
}

export interface CitySourceSummary {
  id: string;
  theme: CityTheme;
  name: string;
  kind: CitySourceKind;
  ref: Record<string, unknown>;
  mapping: CitySourceMapping;
  priority: number;
  authoritative: boolean;
  status: 'pending' | 'syncing' | 'ready' | 'failed';
  version: number;
  contractVersion: string | null;
  acceptedCount: number;
  rejectedCount: number;
  warningCount: number;
  lastError: string | null;
  syncedAt: string | null;
}

export interface CityRejectRow {
  sourceRef: string | null;
  rules: string[];
  detail: Record<string, unknown>;
}

export interface CityCorrectionInput {
  entityId: string;
  kind: 'geometry' | 'attrs' | 'delete';
  /** GeoJSON geometry (EPSG:4326) for `geometry`. */
  geometry?: unknown;
  /** Attribute overrides for `attrs` (contract keys). */
  attrs?: Record<string, unknown>;
  note?: string;
}
