// =============================================================================
// Canonical city model — theme contracts and API shapes
//
// A record belongs to a theme ("is a building") only when it satisfies that
// theme's versioned contract. The contract is the single definition used by
// the ingest rule checks (gis-service), the source screens, the data health
// report and the data delivery specification handed to institutions.
// Design: docs/architecture/city-data-onboarding.md
// =============================================================================

import type { CityLocation, CityObjectStateKind, CitySearchHit } from '@opentwin/plugin-sdk';

/** Themes of the canonical city model (one per delivered layer; see CITY_DELIVERY_SPEC). */
export type CityTheme =
  | 'boundary'
  | 'parcel'
  | 'building'
  | 'address'
  | 'road'
  | 'area'
  | 'asset'
  | 'poi'
  | 'crossing'
  | 'tree'
  | 'utility'
  | 'utility_node'
  | 'landform'
  | 'terrain';

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
  /** Column name an institution delivers (at most 10 characters: Shapefile-safe). */
  column?: string;
  /** Must be filled in every record (the record is rejected without it). */
  required?: boolean;
  /** Unit of a number ("m", "mm"). */
  unit?: string;
  /** Meaning of each `values` entry, for the delivery specification. */
  valueLabels?: Record<string, string>;
  /** The DT compiler uses it (false: kept for records and applications only). */
  dt?: boolean;
}

/** Sections of the delivery specification. */
export type CityThemeGroup =
  | 'base'
  | 'buildings'
  | 'transport'
  | 'nature'
  | 'furniture'
  | 'places'
  | 'utilities';

export const CITY_THEME_GROUP_LABEL: Record<CityThemeGroup, string> = {
  base: 'Temel katmanlar',
  buildings: 'Yapılar',
  transport: 'Ulaşım',
  nature: 'Arazi, doğa ve açık alanlar',
  furniture: 'Kent donatısı',
  places: 'İlgi noktaları',
  utilities: 'Altyapı ağları',
};

export interface CityThemeContract {
  theme: CityTheme;
  version: string;
  label: string;
  geometry: CityGeometryType[];
  attributes: CityAttributeDef[];
  rules: CityRuleDef[];
  /**
   * active: sources can be bound (CITY_CONTRACTS); draft: in the delivery
   * specification only, no intake yet. Default active.
   */
  status?: 'active' | 'draft';
  group?: CityThemeGroup;
  /** Delivered file name without extension (`yapi` → yapi.zip / yapi.geojson). */
  file?: string;
  /** What the layer holds (delivery specification). */
  description?: string;
  /** What the city (2D / DT) makes of it. */
  dtUse?: string;
  /** Raster themes: delivery requirements in place of geometry / attributes. */
  raster?: string[];
  /** One record as delivered (column → value). */
  example?: Record<string, string | number>;
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
  // Not roads, but lines with a width the city model lays the same way: rail
  // (lanes = tracks) and airfield ways.
  'rail',
  'subway',
  'tram',
  'runway',
  'taxiway',
  'stopway',
  'stand',
] as const;
export type CityRoadClass = (typeof CITY_ROAD_CLASSES)[number];

const ID_RULES: CityRuleDef[] = [
  {
    code: 'id.present',
    severity: 'reject',
    label: 'Kimlik var',
    description:
      'Kaynakta kayda ait boş olmayan bir kimlik bulunmalı (şartnamede KIMLIK kolonu; MAKS’ta KIMLIKNO).',
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

// ─── The complete city (delivery specification) ─────────────────────────────
//
// Every layer a city is built from, in the form institutions deliver it.
// Attribute keys are canonical (English); `column` is the delivered column
// name. `dt: true` marks what the DT compiler reads today — the rest is kept
// with the record (applications, reports) and not drawn yet.

const geomType = (label: string, types: string): CityRuleDef => ({
  code: 'geom.type',
  severity: 'reject',
  label,
  description: `Geometri ${types} olmalı.`,
});

const REQUIRED_RULE: CityRuleDef = {
  code: 'attr.required',
  severity: 'reject',
  label: 'Zorunlu alanlar',
  description: 'Tablodaki zorunlu kolonlar dolu olmalı.',
};

const BASE_RULES = (label: string, types: string): CityRuleDef[] => [
  geomType(label, types),
  GEOMETRY_VALID,
  ...ID_RULES,
  SCOPE_RULE,
  REQUIRED_RULE,
];

const enumKnown = (code: string, label: string): CityRuleDef => ({
  code,
  severity: 'reject',
  label,
  description: `${label} tablodaki değerlerden biri olmalı.`,
});

const NAME: CityAttributeDef = { key: 'name', type: 'string', label: 'Ad', column: 'AD' };
const BRAND: CityAttributeDef = {
  key: 'brand',
  type: 'string',
  label: 'Marka',
  column: 'MARKA',
  dt: true,
  description: 'Akaryakıt istasyonlarında dağıtım şirketi (marka).',
};

/** Utility networks (same names as the compiler's UtilityKind). */
export const CITY_UTILITY_NETWORKS = ['gas', 'water', 'sewer', 'power', 'telecom', 'heat'] as const;
const NETWORK_LABELS: Record<(typeof CITY_UTILITY_NETWORKS)[number], string> = {
  gas: 'Doğalgaz',
  water: 'İçme suyu',
  sewer: 'Kanalizasyon / yağmur suyu',
  power: 'Elektrik (yeraltı kablosu)',
  telecom: 'Fiber / haberleşme',
  heat: 'Bölgesel ısıtma',
};

export const BOUNDARY_CONTRACT_V1: CityThemeContract = {
  theme: 'boundary',
  version: '1',
  group: 'base',
  file: 'idari_sinir',
  label: 'İdari sınır',
  description: 'İl, ilçe, mahalle ve köy sınırları.',
  dtUse: 'Çalışma alanını ve mahalle bazlı raporları belirler; DT’de çizilmez.',
  geometry: ['Polygon', 'MultiPolygon'],
  attributes: [
    {
      key: 'level',
      type: 'enum',
      label: 'Sınır düzeyi',
      column: 'DUZEY',
      required: true,
      values: ['province', 'district', 'neighbourhood', 'village'],
      valueLabels: { province: 'İl', district: 'İlçe', neighbourhood: 'Mahalle', village: 'Köy' },
    },
    { ...NAME, required: true },
    { key: 'code', type: 'string', label: 'Resmî kod (UAVT / TÜİK)', column: 'KOD' },
  ],
  rules: [
    ...BASE_RULES('Poligon', 'Polygon ya da MultiPolygon'),
    enumKnown('level.known', 'Sınır düzeyi'),
  ],
  example: { KIMLIK: '1203', DUZEY: 'neighbourhood', AD: 'Meşrutiyet', KOD: '40145' },
};

export const PARCEL_CONTRACT_V1: CityThemeContract = {
  theme: 'parcel',
  version: '1',
  group: 'base',
  file: 'parsel',
  label: 'Ada / parsel',
  description: 'Kadastro parselleri (MEGSİS / TKGM numaralandırması).',
  dtUse:
    'Yapı ile parseli ilişkilendirir (parsel anahtarlı senaryolar, gelir denetimi); DT’de çizilmez.',
  geometry: ['Polygon', 'MultiPolygon'],
  attributes: [
    {
      key: 'parcelId',
      type: 'string',
      label: 'Parsel kimliği (tapu kimlik no)',
      column: 'PARSELKIML',
      required: true,
      description: 'Yapı katmanındaki PARSELKIML ile aynı numaralandırma.',
    },
    { key: 'block', type: 'string', label: 'Ada no', column: 'ADA' },
    { key: 'parcel', type: 'string', label: 'Parsel no', column: 'PARSEL' },
    { key: 'neighbourhood', type: 'string', label: 'Mahalle', column: 'MAHALLE' },
  ],
  rules: [
    ...BASE_RULES('Poligon', 'Polygon ya da MultiPolygon'),
    {
      code: 'geom.area',
      severity: 'reject',
      label: 'Alan',
      description: 'Parsel alanı en az 1 m² olmalı.',
      params: { min: 1 },
    },
  ],
  example: { KIMLIK: '88231', PARSELKIML: '88231', ADA: '412', PARSEL: '7', MAHALLE: 'Meşrutiyet' },
};

export const ADDRESS_CONTRACT_V1: CityThemeContract = {
  theme: 'address',
  version: '1',
  group: 'base',
  file: 'adres',
  label: 'Adres / bağımsız bölüm',
  description: 'Kapı numaraları ve bağımsız bölümler (UAVT).',
  dtUse: 'Bina kartında adres ve bağımsız bölümler; aramada konum. DT’de çizilmez.',
  geometry: ['Point'],
  attributes: [
    { key: 'uavtCode', type: 'string', label: 'UAVT adres kodu', column: 'UAVT', required: true },
    { key: 'street', type: 'string', label: 'Cadde / sokak adı', column: 'YOL_ADI' },
    { key: 'doorNo', type: 'string', label: 'Dış kapı no', column: 'KAPI_NO' },
    { key: 'unitNo', type: 'string', label: 'İç kapı no', column: 'IC_KAPI' },
    {
      key: 'buildingId',
      type: 'string',
      label: 'Yapı kimliği',
      column: 'YAPI_KIML',
      description: 'Adresin bağlı olduğu yapının Yapı katmanındaki KIMLIK değeri.',
    },
  ],
  rules: [
    ...BASE_RULES('Nokta', 'Point'),
    {
      code: 'building.link',
      severity: 'warn',
      label: 'Yapıya bağlı',
      description: 'Nokta bir yapının içinde olmalı ya da YAPI_KIML ile bir yapıya bağlanmalı.',
    },
  ],
  example: { KIMLIK: '1029384756', UAVT: '1029384756', YOL_ADI: 'Gazipaşa Cd.', KAPI_NO: '12' },
};

/** Building uses the compiler understands (same names as OSM `building`). */
const BUILDING_USES: Record<string, string> = {
  residential: 'Konut (apartman)',
  house: 'Müstakil konut',
  commercial: 'Ticari',
  retail: 'Dükkân / perakende (zemin katı mağaza)',
  office: 'Ofis',
  public: 'Kamu binası',
  school: 'Okul',
  university: 'Üniversite',
  hospital: 'Hastane',
  mosque: 'Cami / ibadethane',
  industrial: 'Sanayi',
  warehouse: 'Depo',
  garage: 'Garaj (tek kat)',
  shed: 'Baraka / kulübe (tek kat)',
  kiosk: 'Büfe (tek kat)',
  stadium: 'Stadyum tribünü',
  church: 'Kilise',
  parking: 'Katlı otopark',
  silo: 'Silo',
  storage_tank: 'Depolama tankı',
  roof: 'Sundurma / üstü kapalı alan (duvarsız)',
  greenhouse: 'Sera',
  minaret: 'Minare',
  communication_tower: 'Verici / iletişim kulesi',
  clock_tower: 'Saat kulesi',
  tower: 'Kule (anıt, savunma, seyir)',
  substation: 'Trafo binası / köşkü',
  terminal: 'Terminal binası (havalimanı / otogar)',
  train_station: 'Tren / metro istasyonu',
};

export const BUILDING_CONTRACT_V2: CityThemeContract = {
  ...BUILDING_CONTRACT_V1,
  version: '2',
  group: 'buildings',
  file: 'yapi',
  description: 'Yapı taban alanları (MAKS yapı katmanı ya da belediye CBS).',
  dtUse:
    'Taban alanından, kat sayısı ve yükseklikten 3B bina; kullanım türüne göre cephe ve zemin katı (dükkân), çatı tipi ve renkler verilmişse onlar. Kat sayısı yoksa tahmin edilir ve tahmin olarak işaretlenir.',
  attributes: [
    { ...NAME, dt: false },
    {
      key: 'levels',
      type: 'integer',
      label: 'Zemin üstü kat sayısı',
      column: 'KAT',
      range: [0, 99],
      dt: true,
      description: 'Yoksa DT kat sayısını tahmin eder ve tahmin olarak işaretler.',
    },
    {
      key: 'levelsUnderground',
      type: 'integer',
      label: 'Zemin altı kat sayısı',
      column: 'BODRUM',
      range: [0, 19],
      dt: false,
    },
    {
      key: 'height',
      type: 'number',
      label: 'Yükseklik',
      unit: 'm',
      column: 'YUKSEKLIK',
      range: [1, 400],
      dt: true,
      description: 'Kat sayısı yoksa kat sayısı yükseklikten çıkarılır (3 m / kat).',
    },
    {
      key: 'layer',
      type: 'integer',
      label: 'Kot katmanı',
      column: 'KOT_KATMANI',
      range: [-5, 5],
      dt: true,
      description:
        '1 ve üstü: yolun / rayın üstünde duran yapı (istasyon holü, köprü bina); motor kolonlar üstüne kaldırır.',
    },
    {
      key: 'use',
      type: 'enum',
      label: 'Kullanım türü',
      column: 'KULLANIM',
      values: Object.keys(BUILDING_USES),
      valueLabels: BUILDING_USES,
      dt: true,
    },
    {
      key: 'parcelId',
      type: 'string',
      label: 'Parsel kimliği',
      column: 'PARSELKIML',
      dt: false,
      description:
        'Yapının üzerinde durduğu parselin kimliği (Ada / parsel katmanındaki PARSELKIML).',
    },
    {
      key: 'roofShape',
      type: 'enum',
      label: 'Çatı tipi',
      column: 'CATI_TIPI',
      values: ['flat', 'hipped', 'gabled'],
      valueLabels: { flat: 'Düz (teras)', hipped: 'Kırma', gabled: 'Beşik' },
      dt: true,
    },
    {
      key: 'roofColour',
      type: 'string',
      label: 'Çatı rengi',
      column: 'CATI_RENK',
      dt: true,
      description: '#rrggbb (ör. #b5523b) ya da red, brown, grey, white …',
    },
    {
      key: 'wallColour',
      type: 'string',
      label: 'Cephe rengi',
      column: 'CEPHE_RENK',
      dt: true,
      description: '#rrggbb (ör. #e8dcc4) ya da white, beige, cream, yellow …',
    },
  ],
  example: {
    KIMLIK: '4711',
    KAT: 5,
    BODRUM: 1,
    YUKSEKLIK: 16.5,
    KULLANIM: 'residential',
    PARSELKIML: '88231',
    CATI_TIPI: 'hipped',
  },
};

const ROAD_CLASS_LABELS: Record<CityRoadClass, string> = {
  motorway: 'Otoyol',
  trunk: 'Devlet yolu',
  primary: 'Bulvar / ana arter',
  secondary: 'İl yolu / toplayıcı',
  tertiary: 'Cadde',
  residential: 'Sokak',
  unclassified: 'Diğer taşıt yolu (köy yolu)',
  living_street: 'Yaşam sokağı (yaya öncelikli)',
  pedestrian: 'Yaya yolu / meydan (taşıt yok)',
  service: 'Servis yolu (otopark, site içi)',
  footway: 'Yürüyüş yolu',
  steps: 'Merdiven',
  track: 'Tarla / orman yolu',
  cycleway: 'Bisiklet yolu',
  rail: 'Demiryolu / banliyö (İZBAN) — şerit sayısı = hat sayısı',
  subway: 'Metro — şerit sayısı = hat sayısı',
  tram: 'Tramvay',
  runway: 'Pist (havalimanı)',
  taxiway: 'Taksi yolu (havalimanı)',
  stopway: 'Pist uzatması / durma alanı (stopway)',
  stand: 'Uçak park yeri çizgisi (apron)',
};

export const ROAD_CONTRACT_V2: CityThemeContract = {
  ...ROAD_CONTRACT_V1,
  version: '2',
  group: 'transport',
  file: 'yol',
  description: 'Yol orta hatları: taşıt yolları, yaya yolları, merdivenler, bisiklet yolları.',
  dtUse:
    'Orta hattan şerit genişliğinde asfalt, sınıfına göre kaldırım ve bordür, şerit çizgileri, kavşaklar, köprü ve tüneller. Yaya / bisiklet yolları kendi kaplamasıyla çizilir. Yollar arsa adalarını (bina bloklarını) oluşturur.',
  attributes: [
    { ...NAME, dt: true },
    {
      key: 'class',
      type: 'enum',
      label: 'Yol sınıfı',
      column: 'SINIF',
      required: true,
      values: CITY_ROAD_CLASSES,
      valueLabels: ROAD_CLASS_LABELS,
      dt: true,
      description:
        'Kurumun kendi tip kodları da kabul edilir (ör. MAKS TIP 1–5); eşleme tablosuyla bu listeye çevrilir.',
    },
    {
      key: 'width',
      type: 'number',
      label: 'Taşıt yolu genişliği (kaldırım hariç)',
      unit: 'm',
      column: 'GENISLIK',
      range: [1, 60],
      dt: true,
      description: 'Yoksa sınıfa göre varsayılan kullanılır (ör. sokak 5,8 m, cadde 6,2 m).',
    },
    {
      key: 'lanes',
      type: 'integer',
      label: 'Şerit sayısı',
      column: 'SERIT',
      range: [1, 12],
      dt: true,
    },
    { key: 'oneway', type: 'boolean', label: 'Tek yön', column: 'TEK_YON', dt: true },
    { key: 'bridge', type: 'boolean', label: 'Köprü / viyadük', column: 'KOPRU', dt: true },
    { key: 'tunnel', type: 'boolean', label: 'Tünel / alt geçit', column: 'TUNEL', dt: true },
    {
      key: 'layer',
      type: 'integer',
      label: 'Kot katmanı',
      column: 'KOT',
      range: [-5, 5],
      dt: true,
      description: 'Üst üste geçen yollarda: 0 zemin, 1 üst geçit, −1 alt geçit.',
    },
    { key: 'roundabout', type: 'boolean', label: 'Dönel kavşak', column: 'DONEL_KAV', dt: true },
    {
      key: 'ref',
      type: 'string',
      label: 'Numara / kod',
      column: 'KOD',
      dt: true,
      description:
        'Yol numarası; pistte iki ucun adı (ör. 16L/34R) — eşik rakamları buradan yazılır.',
    },
    {
      key: 'sidewalk',
      type: 'boolean',
      label: 'Kaldırım var',
      column: 'KALDIRIM',
      dt: true,
      description: 'Hayır verilirse kaldırım çizilmez; boşsa sınıfın kaldırımı kullanılır.',
    },
  ],
  example: {
    KIMLIK: 'Y-10442',
    AD: 'Gazipaşa Caddesi',
    SINIF: 'tertiary',
    GENISLIK: 7,
    SERIT: 2,
    TEK_YON: 0,
    KOPRU: 0,
    TUNEL: 0,
    KOT: 0,
  },
};

/** Lanes in OSM's `turn:lanes` syntax: per lane left to right, `|` between lanes. */
const TURN_LANES =
  'Soldan sağa şerit başına izinli yönler, şeritler "|" ile ayrılır, bir şeritte birden çok yön ";" ile (OSM turn:lanes): left | through | right | slight_left | slight_right | merge_to_left | merge_to_right | reverse | none. Ör. "left|through|through;right".';

/**
 * v3: lane-level detail (D-012) — lanes per direction, turn lanes, lane
 * widths, sidewalk sides, cycle and parking lanes. All optional: a road
 * without them is laid out by its class (as in v2).
 */
export const ROAD_CONTRACT_V3: CityThemeContract = {
  ...ROAD_CONTRACT_V2,
  version: '3',
  dtUse:
    'Orta hattan şerit düzeyinde yol: şerit başına genişlik ve yön, dönüş şeritleri ve okları, durma çizgileri, kaldırım ve bisiklet / park şeritleri; verilmeyen şerit bilgisi sınıfına ve kavşağına göre varsayılır. Köprü ve tüneller, kavşaklar. Yollar arsa adalarını (bina bloklarını) oluşturur.',
  attributes: [
    ...ROAD_CONTRACT_V2.attributes,
    {
      key: 'lanesForward',
      type: 'integer',
      label: 'Çizim yönündeki şerit sayısı',
      column: 'SERIT_ILERI',
      range: [0, 8],
      dt: true,
    },
    {
      key: 'lanesBackward',
      type: 'integer',
      label: 'Ters yöndeki şerit sayısı',
      column: 'SERIT_GERI',
      range: [0, 8],
      dt: true,
    },
    {
      key: 'turnLanes',
      type: 'string',
      label: 'Dönüş şeritleri (tek yönlü yol)',
      column: 'DONUS_SERIT',
      dt: true,
      description: TURN_LANES,
    },
    {
      key: 'turnLanesForward',
      type: 'string',
      label: 'Dönüş şeritleri, çizim yönü',
      column: 'DONUS_ILERI',
      dt: true,
      description: TURN_LANES,
    },
    {
      key: 'turnLanesBackward',
      type: 'string',
      label: 'Dönüş şeritleri, ters yön',
      column: 'DONUS_GERI',
      dt: true,
      description: TURN_LANES,
    },
    {
      key: 'widthLanes',
      type: 'string',
      label: 'Şerit genişlikleri (m)',
      column: 'SERIT_GENISLIK',
      dt: true,
      description:
        'Soldan sağa şerit başına genişlik, "|" ile ayrılır (OSM width:lanes). Ör. "3.5|3.25".',
    },
    {
      key: 'sidewalkSide',
      type: 'enum',
      label: 'Kaldırım tarafı',
      column: 'KALDIRIM_YON',
      values: ['both', 'left', 'right', 'no', 'separate'],
      dt: true,
      description:
        'Çizim yönüne göre. "separate": kaldırım ayrı yaya yolu olarak verildi (yol kendi kaldırımını çizmez).',
    },
    {
      key: 'cycleway',
      type: 'enum',
      label: 'Bisiklet yolu',
      column: 'BISIKLET',
      values: ['lane', 'track', 'shared', 'no'],
      dt: true,
    },
    {
      key: 'parking',
      type: 'enum',
      label: 'Yol kenarı park şeridi',
      column: 'PARK_SERIT',
      values: ['both', 'left', 'right', 'no'],
      dt: true,
    },
  ],
  example: {
    ...ROAD_CONTRACT_V2.example,
    SERIT: 3,
    SERIT_ILERI: 2,
    SERIT_GERI: 1,
    DONUS_ILERI: 'left|through;right',
    KALDIRIM_YON: 'both',
  },
};

export const CROSSING_CONTRACT_V1: CityThemeContract = {
  theme: 'crossing',
  version: '1',
  group: 'transport',
  file: 'yaya_gecidi',
  label: 'Yaya geçidi',
  description: 'Yaya geçitleri: yolun orta hattı üzerinde, geçidin ortasında bir nokta.',
  dtUse:
    'Yol genişliği boyunca zebra çizgileri; ışıklı kavşakta ışıkla birlikte. Yoksa DT ana kavşaklara kendi geçidini koyar.',
  geometry: ['Point'],
  attributes: [
    {
      key: 'type',
      type: 'enum',
      label: 'Geçit türü',
      column: 'TUR',
      values: ['zebra', 'signals', 'uncontrolled'],
      valueLabels: { zebra: 'Zebra', signals: 'Işıklı', uncontrolled: 'İşaretsiz' },
      dt: false,
    },
  ],
  rules: [
    ...BASE_RULES('Nokta', 'Point'),
    {
      code: 'road.near',
      severity: 'warn',
      label: 'Yol üzerinde',
      description: 'Nokta bir taşıt yolunun orta hattına 3 m’den yakın olmalı; uzaktaysa çizilmez.',
      params: { maxDistance: 3 },
    },
  ],
  example: { KIMLIK: 'YG-118', TUR: 'zebra' },
};

/** Area kinds the compiler understands (Area['kind']). */
const AREA_KINDS: Record<string, string> = {
  park: 'Park / bahçe',
  playground: 'Çocuk oyun alanı',
  grass: 'Çim / yeşil alan',
  forest: 'Orman / koruluk',
  water: 'Su yüzeyi (göl, gölet, havuz)',
  parking: 'Açık otopark',
  plaza: 'Meydan',
  school: 'Okul / hastane / kampüs bahçesi',
  religious: 'İbadethane avlusu',
  industrial: 'Sanayi / demiryolu alanı',
  residential: 'Konut / ticaret alanı',
  stadium: 'Stadyum alanı',
  pitch: 'Spor sahası (futbol, halı saha, kort)',
  track: 'Atletizm pisti',
  bus_station: 'Otobüs terminali / otogar alanı',
  cemetery: 'Mezarlık',
  construction: 'Şantiye / inşaat alanı',
  quarry: 'Taş ocağı / maden sahası',
  harbour: 'Liman / konteyner sahası',
  military: 'Askeri alan',
  marketplace: 'Pazar yeri',
  fuel: 'Akaryakıt istasyonu alanı',
  substation: 'Trafo merkezi / şalt sahası',
  power_plant: 'Enerji santrali',
  airport: 'Havalimanı / hava üssü alanı',
  apron: 'Apron (uçak park sahası)',
};

export const AREA_CONTRACT_V1: CityThemeContract = {
  theme: 'area',
  version: '1',
  group: 'nature',
  file: 'alan',
  label: 'Alan (arazi kullanımı)',
  description: 'Parklar, yeşil alanlar, su yüzeyleri, otoparklar, meydanlar, kampüs alanları.',
  dtUse:
    'Türüne göre çim, ağaçlık, su ya da sert zemin; otoparkta park yerleri ve araçlar, oyun alanında oyun aletleri. Bu alanlara DT kendiliğinden bina koymaz.',
  geometry: ['Polygon', 'MultiPolygon'],
  attributes: [
    {
      key: 'kind',
      type: 'enum',
      label: 'Alan türü',
      column: 'TUR',
      required: true,
      values: Object.keys(AREA_KINDS),
      valueLabels: AREA_KINDS,
      dt: true,
    },
    { ...NAME, dt: false },
    BRAND,
  ],
  rules: [
    ...BASE_RULES('Poligon', 'Polygon ya da MultiPolygon'),
    enumKnown('kind.known', 'Alan türü'),
    {
      code: 'geom.area',
      severity: 'reject',
      label: 'Alan',
      description: 'Alan en az 1 m² olmalı.',
      params: { min: 1 },
    },
  ],
  example: { KIMLIK: 'P-55', TUR: 'park', AD: 'Atatürk Parkı' },
};

export const TREE_CONTRACT_V1: CityThemeContract = {
  theme: 'tree',
  version: '1',
  group: 'nature',
  file: 'agac',
  label: 'Ağaç',
  description: 'Tek tek ağaçlar (park ve bahçeler müdürlüğü envanteri).',
  dtUse:
    'Konumunda ağaç. Verisi olmayan sokak ve parklara DT görsel amaçlı ağaç ekleyebilir; bunlar kayıt sayılmaz.',
  geometry: ['Point'],
  attributes: [
    { key: 'species', type: 'string', label: 'Tür', column: 'TUR', dt: false },
    {
      key: 'height',
      type: 'number',
      label: 'Boy',
      unit: 'm',
      column: 'BOY',
      range: [0.5, 60],
      dt: false,
    },
    {
      key: 'crown',
      type: 'number',
      label: 'Taç çapı',
      unit: 'm',
      column: 'TAC_CAPI',
      range: [0.5, 40],
      dt: false,
    },
  ],
  rules: BASE_RULES('Nokta', 'Point'),
  example: { KIMLIK: 'A-20931', TUR: 'Platanus orientalis', BOY: 14, TAC_CAPI: 9 },
};

export const LANDFORM_CONTRACT_V1: CityThemeContract = {
  theme: 'landform',
  version: '1',
  group: 'nature',
  file: 'falez_kiyi',
  label: 'Falez / kıyı çizgisi',
  description: 'Yüksek eğimli yüzeylerin üst kenarı (falez, şev) ve kıyı çizgisi.',
  dtUse: 'Arazi modelinde keskin uçurum; kıyıda kara ile deniz ayrımı.',
  geometry: ['LineString', 'MultiLineString'],
  attributes: [
    {
      key: 'kind',
      type: 'enum',
      label: 'Tür',
      column: 'TUR',
      required: true,
      values: ['cliff', 'coastline'],
      valueLabels: {
        cliff: 'Falez / şev (üst kenar)',
        coastline: 'Kıyı çizgisi',
      },
      dt: true,
      description:
        'Çizim yönü önemlidir: falezde yüksek taraf, kıyı çizgisinde kara çizim yönünün SOLUNDA kalmalıdır.',
    },
  ],
  rules: [
    ...BASE_RULES('Çizgi', 'LineString ya da MultiLineString'),
    enumKnown('kind.known', 'Tür'),
  ],
  example: { KIMLIK: 'F-3', TUR: 'cliff' },
};

export const TERRAIN_CONTRACT_V1: CityThemeContract = {
  theme: 'terrain',
  version: '1',
  status: 'draft',
  group: 'nature',
  file: 'yukseklik_modeli',
  label: 'Sayısal yükseklik modeli',
  description: 'Arazinin yükseklik modeli (DEM / DTM: bina ve ağaçsız zemin).',
  dtUse:
    'Arazinin şekli; yollar ve binalar bu zemine oturur. Verilmezse platform 30 m çözünürlüklü küresel modeli kullanır.',
  geometry: [],
  attributes: [],
  rules: [],
  raster: [
    'Biçim: GeoTIFF, tek bant, 32 bit ondalık (Float32).',
    'Değer: metre cinsinden ortometrik yükseklik (deniz seviyesinden); bina ve ağaçlar çıkarılmış zemin (DTM).',
    'Çözünürlük: 5 m ya da daha iyi (önerilen 1 m).',
    'Koordinat sistemi dosyada tanımlı olmalı (TUREF TM / ED50 UTM / WGS84).',
    'Boş hücreler için NoData değeri tanımlanmalı.',
    'Birden çok pafta teslim ediliyorsa paftalar arasında boşluk kalmamalı.',
  ],
};

/** Street furniture kinds (props of the DT compiler). */
const ASSET_KINDS: Record<string, string> = {
  street_lamp: 'Sokak lambası / aydınlatma direği',
  traffic_signals: 'Trafik ışığı',
  bus_stop: 'Otobüs durağı',
  bench: 'Bank',
  waste_basket: 'Çöp kutusu',
  power_pole: 'Elektrik direği (havai hat)',
  power_tower: 'Yüksek gerilim direği (pilon)',
  mast: 'Anten / verici direği',
  floodlight: 'Projektör direği (apron, stadyum, kavşak)',
  flagpole: 'Bayrak direği',
  fuel_station: 'Akaryakıt istasyonu',
  subway_entrance: 'Metro / raylı sistem istasyon girişi',
};

export const ASSET_CONTRACT_V1: CityThemeContract = {
  theme: 'asset',
  version: '1',
  group: 'furniture',
  file: 'kent_donatisi',
  label: 'Kent donatısı',
  description:
    'Sokak lambaları, trafik ışıkları, duraklar, banklar, çöp kutuları, elektrik ve yüksek gerilim direkleri, anten ve bayrak direkleri, akaryakıt istasyonları.',
  dtUse:
    'Konumunda 3B nesne; taşıt yolunun üstüne düşen nesne bordüre çekilir. Verisi olmayan sokaklara DT görsel amaçlı lamba ekleyebilir; bunlar kayıt sayılmaz.',
  geometry: ['Point'],
  attributes: [
    {
      key: 'kind',
      type: 'enum',
      label: 'Donatı türü',
      column: 'TUR',
      required: true,
      values: Object.keys(ASSET_KINDS),
      valueLabels: ASSET_KINDS,
      dt: true,
    },
    { ...NAME, dt: false, description: 'Duraklarda durak adı.' },
    BRAND,
    {
      key: 'country',
      type: 'string',
      label: 'Bayrak ülkesi',
      column: 'ULKE',
      dt: true,
      description:
        'Bayrak direklerinde bayrağın ülkesi (ISO kodu, Avrupa Birliği için EU); boşsa Türk bayrağı.',
    },
  ],
  rules: [...BASE_RULES('Nokta', 'Point'), enumKnown('kind.known', 'Donatı türü')],
  example: { KIMLIK: 'L-7781', TUR: 'street_lamp' },
};

/**
 * Point-of-interest kinds: the categories a map shows an icon for (the
 * source's own tag is not kept; OSM `amenity` / `shop` / `tourism` values
 * map onto these in the OSM package).
 */
export const POI_KINDS: Record<string, string> = {
  restaurant: 'Lokanta / restoran',
  fast_food: 'Hızlı yemek',
  cafe: 'Kafe / pastane',
  bar: 'Bar / birahane',
  bakery: 'Fırın / pastane (dükkân)',
  supermarket: 'Market / bakkal',
  mall: 'Alışveriş merkezi / mağaza zinciri',
  shop: 'Dükkân (diğer)',
  pharmacy: 'Eczane',
  hospital: 'Hastane',
  clinic: 'Sağlık merkezi / muayenehane',
  school: 'Okul',
  university: 'Üniversite / yüksekokul',
  kindergarten: 'Anaokulu / kreş',
  library: 'Kütüphane',
  place_of_worship: 'İbadethane',
  museum: 'Müze',
  culture: 'Tiyatro / sinema / kültür merkezi',
  hotel: 'Otel / konaklama',
  attraction: 'Gezilecek yer / seyir noktası',
  bank: 'Banka',
  atm: 'ATM',
  post_office: 'Postane',
  police: 'Emniyet / karakol',
  fire_station: 'İtfaiye',
  public_office: 'Kamu kurumu (belediye, adliye)',
  bus_station: 'Otogar / otobüs terminali',
  parking: 'Otopark',
};

export const POI_CONTRACT_V1: CityThemeContract = {
  theme: 'poi',
  version: '1',
  group: 'places',
  file: 'ilgi_noktasi',
  label: 'İlgi noktası',
  description:
    'İşletme ve hizmet noktaları: yeme-içme, alışveriş, sağlık, eğitim, ibadet, kültür, konaklama, banka, kamu kurumları, otogar ve otoparklar.',
  dtUse:
    'Harita görünümünde konumunda türünün simgesi ve adı (çakışan simgeler önceliğe göre seyrelir).',
  geometry: ['Point'],
  attributes: [
    {
      key: 'kind',
      type: 'enum',
      label: 'Nokta türü',
      column: 'TUR',
      required: true,
      values: Object.keys(POI_KINDS),
      valueLabels: POI_KINDS,
      dt: true,
    },
    { ...NAME, dt: true },
    { ...BRAND, description: 'Zincir işletmelerde marka.' },
  ],
  rules: [...BASE_RULES('Nokta', 'Point'), enumKnown('kind.known', 'Nokta türü')],
  example: { KIMLIK: 'P-1204', TUR: 'pharmacy', AD: 'Kızılay Eczanesi' },
};

export const UTILITY_CONTRACT_V1: CityThemeContract = {
  theme: 'utility',
  version: '1',
  group: 'utilities',
  file: 'altyapi_hat',
  label: 'Altyapı hattı',
  description:
    'Yeraltı boru ve kabloları: doğalgaz, içme suyu, kanalizasyon / yağmur suyu, elektrik, fiber, bölgesel ısıtma. Ana hatlar ve bina bağlantıları.',
  dtUse:
    'Yeraltı görünümünde hattın rengi ve çapında boru, verilen derinlikte. Farklı ağların hatları 0,3 m’den yakın kesişirse küçük olan yeterli örtü kalıyorsa üstten, kalmıyorsa alttan geçirilir (kanalizasyon hiç oynatılmaz). Bina bağlantıları ana hattın kotuna bağlanır. Ana hattın 1,5 m yakınına DT kendiliğinden bina koymaz.',
  geometry: ['LineString', 'MultiLineString'],
  attributes: [
    {
      key: 'network',
      type: 'enum',
      label: 'Ağ',
      column: 'AG',
      required: true,
      values: CITY_UTILITY_NETWORKS,
      valueLabels: NETWORK_LABELS,
      dt: true,
    },
    {
      key: 'role',
      type: 'enum',
      label: 'Hat türü',
      column: 'HAT_TURU',
      values: ['main', 'service'],
      valueLabels: { main: 'Ana / dağıtım hattı', service: 'Bina bağlantısı (servis hattı)' },
      dt: true,
      description: 'Boşsa ana hat sayılır.',
    },
    {
      key: 'diameter',
      type: 'number',
      label: 'Dış çap',
      unit: 'mm',
      column: 'CAP_MM',
      range: [10, 3000],
      dt: true,
      description:
        'Yoksa ağ ve hat türüne göre tipik çap kullanılır (ör. doğalgaz ana hat 125 mm).',
    },
    {
      key: 'depth',
      type: 'number',
      label: 'Derinlik (zeminden borunun üstüne)',
      unit: 'm',
      column: 'DERINLIK',
      range: [0.2, 15],
      dt: true,
      description:
        'Örtü kalınlığı. Yoksa tipik değer: doğalgaz 0,9, su 1,2, kanalizasyon 2,5, elektrik 0,8, fiber 0,6 m.',
    },
    {
      key: 'depthEnd',
      type: 'number',
      label: 'Bitiş derinliği',
      unit: 'm',
      column: 'DERIN_SON',
      range: [0.2, 15],
      dt: true,
      description:
        'Eğimli hatlarda (kanalizasyon) çizginin son noktasındaki derinlik; hat iki değer arasında doğrusal iner.',
    },
    {
      key: 'material',
      type: 'string',
      label: 'Malzeme',
      column: 'MALZEME',
      dt: true,
      description: 'PE, HDPE, PVC, beton, sfero döküm, çelik, bakır …',
    },
    {
      key: 'pressure',
      type: 'string',
      label: 'Basınç kademesi / gerilim',
      column: 'KADEME',
      dt: false,
    },
    {
      key: 'year',
      type: 'integer',
      label: 'Yapım yılı',
      column: 'YIL',
      range: [1850, 2100],
      dt: false,
    },
  ],
  rules: [
    ...BASE_RULES('Çizgi', 'LineString ya da MultiLineString'),
    enumKnown('network.known', 'Ağ'),
    {
      code: 'depth.range',
      severity: 'warn',
      label: 'Derinlik',
      description: 'Derinlik 0,2–15 m arasında olmalı; dışındaysa tipik değer kullanılır.',
      params: { min: 0.2, max: 15 },
    },
    {
      code: 'diameter.range',
      severity: 'warn',
      label: 'Çap',
      description: 'Çap 10–3000 mm arasında olmalı; dışındaysa tipik değer kullanılır.',
      params: { min: 10, max: 3000 },
    },
  ],
  example: {
    KIMLIK: 'DG-00412',
    AG: 'gas',
    HAT_TURU: 'main',
    CAP_MM: 125,
    DERINLIK: 0.9,
    MALZEME: 'PE',
    KADEME: '4 bar',
    YIL: 2014,
  },
};

export const UTILITY_NODE_CONTRACT_V1: CityThemeContract = {
  theme: 'utility_node',
  version: '1',
  group: 'utilities',
  file: 'altyapi_nokta',
  label: 'Altyapı noktası',
  description:
    'Rögar / baca kapakları, vanalar ve sokak dağıtım kutuları (fiber, elektrik kabinleri).',
  dtUse:
    'Rögar ve vana: yolda kapak, yeraltı görünümünde hattın tabanına inen baca. Dağıtım kutusu: kaldırımın arkasında, yüzü yola dönük kabin; en yakın aynı ağ hattına 12 m içinde bağlantı borusu çizilir.',
  geometry: ['Point'],
  attributes: [
    {
      key: 'type',
      type: 'enum',
      label: 'Nokta türü',
      column: 'TUR',
      required: true,
      values: ['manhole', 'valve', 'cabinet'],
      valueLabels: {
        manhole: 'Rögar / baca',
        valve: 'Vana',
        cabinet: 'Sokak dağıtım kutusu (kabin)',
      },
      dt: true,
    },
    {
      key: 'network',
      type: 'enum',
      label: 'Ağ',
      column: 'AG',
      required: true,
      values: CITY_UTILITY_NETWORKS,
      valueLabels: NETWORK_LABELS,
      dt: true,
    },
    {
      key: 'depth',
      type: 'number',
      label: 'Baca derinliği (kapaktan tabana)',
      unit: 'm',
      column: 'DERINLIK',
      range: [0.3, 20],
      dt: true,
      description: 'Yoksa bacanın altındaki hattın tabanına kadar inilir.',
    },
  ],
  rules: [
    ...BASE_RULES('Nokta', 'Point'),
    enumKnown('type.known', 'Nokta türü'),
    enumKnown('network.known', 'Ağ'),
  ],
  example: { KIMLIK: 'R-9921', TUR: 'manhole', AG: 'sewer', DERINLIK: 3.2 },
};

/**
 * Contracts in force, by theme: sources of these themes can be bound and
 * synced. The terrain model (raster) has its own intake.
 */
export const CITY_CONTRACTS: Partial<Record<CityTheme, CityThemeContract>> = {
  boundary: BOUNDARY_CONTRACT_V1,
  parcel: PARCEL_CONTRACT_V1,
  address: ADDRESS_CONTRACT_V1,
  building: BUILDING_CONTRACT_V2,
  road: ROAD_CONTRACT_V3,
  crossing: CROSSING_CONTRACT_V1,
  area: AREA_CONTRACT_V1,
  tree: TREE_CONTRACT_V1,
  asset: ASSET_CONTRACT_V1,
  poi: POI_CONTRACT_V1,
  landform: LANDFORM_CONTRACT_V1,
  utility: UTILITY_CONTRACT_V1,
  utility_node: UTILITY_NODE_CONTRACT_V1,
};

/** Themes the DT compiler builds the city from (the others are records only). */
export const CITY_DT_THEMES: readonly CityTheme[] = [
  'building',
  'road',
  'crossing',
  'area',
  'tree',
  'asset',
  'poi',
  'landform',
  'utility',
  'utility_node',
];

/**
 * The complete city as institutions deliver it: the latest contract of every
 * theme, in delivery-specification order (tools/city/delivery-spec.ts).
 */
export const CITY_DELIVERY_SPEC: CityThemeContract[] = [
  BOUNDARY_CONTRACT_V1,
  PARCEL_CONTRACT_V1,
  ADDRESS_CONTRACT_V1,
  BUILDING_CONTRACT_V2,
  ROAD_CONTRACT_V3,
  CROSSING_CONTRACT_V1,
  TERRAIN_CONTRACT_V1,
  LANDFORM_CONTRACT_V1,
  AREA_CONTRACT_V1,
  TREE_CONTRACT_V1,
  ASSET_CONTRACT_V1,
  POI_CONTRACT_V1,
  UTILITY_CONTRACT_V1,
  UTILITY_NODE_CONTRACT_V1,
];

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

/**
 * A join key value as compared everywhere (scenario overlay ↔ layer feature
 * ↔ DT building): "4711", 4711 and "4711.0" are the same key.
 */
export function normalizeJoinKey(v: unknown): string {
  const s = String(v).trim();
  return /^-?\d+\.0+$/.test(s) ? s.replace(/\.0+$/, '') : s;
}

/** POST /layers/:id/extent — where the features carrying some join keys lie. */
export interface LayerKeyExtentRequest {
  /** Feature property joined on (e.g. `KIMLIKNO`, `tapukimlik`). */
  key: string;
  /** Key values (compared with normalizeJoinKey). */
  values: Array<string | number>;
}

export interface LayerKeyExtentResponse {
  /** [minLon, minLat, maxLon, maxLat] of the matched features; null if none matched. */
  bbox: [number, number, number, number] | null;
  /** Requested keys found in the layer. */
  matched: number;
  /** Distinct keys requested. */
  requested: number;
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

// ─── Search ─────────────────────────────────────────────────────────────────

/**
 * City search hits, located objects and object states are plugin contracts too:
 * declared once in `@opentwin/plugin-sdk` (types/city.ts), used here.
 */

/** GET /city/search?q=&lon=&lat=&limit= */
export interface CitySearchResponse {
  query: string;
  hits: CitySearchHit[];
}

// ─── Special areas ──────────────────────────────────────────────────────────

/**
 * Area kinds that are places of their own — an airport, a harbour, a
 * cemetery — listed and pinned in the DT (parks, grass, pitches are not).
 */
export const SPECIAL_AREA_KINDS = [
  'airport',
  'harbour',
  'military',
  'power_plant',
  'substation',
  'bus_station',
  'stadium',
  'school',
  'marketplace',
  'cemetery',
  'quarry',
  'construction',
  'industrial',
] as const;
export type SpecialAreaKind = (typeof SPECIAL_AREA_KINDS)[number];

/** One special area: where to pin it (a point inside, its centre where that is inside) and its box. */
export interface CitySpecialArea {
  /** City entity id of the record. */
  ref: string;
  kind: SpecialAreaKind;
  name?: string;
  lon: number;
  lat: number;
  bbox: [number, number, number, number];
  /** Ground area (m²). */
  areaM2: number;
}

/** GET /city/special-areas */
export interface CitySpecialAreasResponse {
  areas: CitySpecialArea[];
}

// ─── Locate ─────────────────────────────────────────────────────────────────

/** The current record of a city object (GET /city/entities/:id → `current`). */
export interface CityEntityCurrent {
  entityId: string;
  theme: CityTheme;
  sourceId: string;
  /** Name of the source (institution's layer / table). */
  sourceName: string | null;
  /** The source's layer when the source is a map layer: the viewer shows and selects in it. */
  layerId: string | null;
  /** The object's key in its source. */
  sourceRef: string;
  /** GeoJSON geometry (WGS84). */
  geometry: { type: string; coordinates: unknown };
  attrs: Record<string, unknown>;
  /** The object's fields as the source has them. */
  sourceAttrs: Record<string, unknown>;
  qualityFlags: string[];
  validFrom: string;
}

/** GET /city/entities/:id */
export interface CityEntityDetail {
  current: CityEntityCurrent | null;
  versions: unknown[];
  identifiers: { scheme: string; value: string }[];
  corrections: unknown[];
}

/** GET /city/locate?lon=&lat= — the city object at a point, as the DT draws it. */
export type CityLocateResponse = CityLocation;

// ─── Object states ──────────────────────────────────────────────────────────

/** What is wrong with a city object (or a place): reported by field teams and plugins. */
export const CITY_OBJECT_STATES = [
  'damaged',
  'hazard',
  'closed',
  'under_repair',
  'inspected',
] as const satisfies readonly CityObjectStateKind[];
