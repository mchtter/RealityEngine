// =============================================================================
// City ontology — every kind of object a live city holds, from a flat to the
// region around the city
//
// One class per kind of thing ("transit.metro_station", "mobility.pedestrian_button").
// A class says what the thing is, at which scale it lives, what it can report
// (telemetry, live position, video) and what can be done to it (commands).
// Data (canonical city records, plugin twin entities, devices) points at a
// class; live feeds, simulations and the city operator (people and the AI)
// work on classes, not on source-specific names.
//
// Classes are data, not TypeScript classes: plugins and institutions add
// records of these kinds at run time, and the same definitions drive ingest,
// the 2D / DT views, search and command authorisation.
//
// `theme` binds a class to today's canonical city model (city-model.ts):
// a record of that theme whose attributes match belongs to the class.
// Classes without `theme` have no intake yet (planned; plugins / feeds).
// Design: docs/architecture/kentos-live-city-engine.md
// =============================================================================

import type { CityTheme } from './city-model';

/** Where an object lives in the containment hierarchy (flat → region). */
export type CityScale =
  | 'unit'
  | 'floor'
  | 'building'
  | 'site'
  | 'street'
  | 'block'
  | 'neighbourhood'
  | 'district'
  | 'city'
  | 'region';

/** Containment order: an object sits inside objects of a larger scale. */
export const CITY_SCALES: readonly CityScale[] = [
  'unit',
  'floor',
  'building',
  'site',
  'street',
  'block',
  'neighbourhood',
  'district',
  'city',
  'region',
];

export const CITY_SCALE_LABEL: Record<CityScale, string> = {
  unit: 'Bağımsız bölüm / daire',
  floor: 'Kat',
  building: 'Yapı',
  site: 'Parsel / site / kampüs',
  street: 'Sokak / cadde',
  block: 'Ada',
  neighbourhood: 'Mahalle',
  district: 'İlçe',
  city: 'Şehir',
  region: 'Bölge (il, hava sahası, deniz)',
};

export type CityDomain =
  | 'admin'
  | 'land'
  | 'building'
  | 'resident'
  | 'mobility'
  | 'transit'
  | 'aviation'
  | 'maritime'
  | 'civil'
  | 'energy'
  | 'water'
  | 'telecom'
  | 'waste'
  | 'environment'
  | 'safety'
  | 'operations'
  | 'health'
  | 'education'
  | 'social'
  | 'commerce'
  | 'furniture'
  | 'iot'
  | 'construction'
  | 'industry'
  | 'hazard';

export const CITY_DOMAIN_LABEL: Record<CityDomain, string> = {
  admin: 'İdari sınırlar ve adres',
  land: 'Arazi, mülkiyet ve kamusal alan',
  building: 'Yapılar ve iç mekân',
  resident: 'Bina ve sakin hizmetleri',
  mobility: 'Karayolu ve trafik',
  transit: 'Toplu taşıma',
  aviation: 'Havacılık',
  maritime: 'Denizcilik ve liman',
  civil: 'Üstyapı ve mühendislik yapıları',
  energy: 'Enerji (elektrik, doğalgaz, ısı, yenilenebilir, depolama)',
  water: 'Su, kanalizasyon ve yağmur suyu',
  telecom: 'Haberleşme',
  waste: 'Atık',
  environment: 'Çevre, doğa ve ölçüm',
  safety: 'Kamu güvenliği ve acil durum',
  operations: 'Operasyon (ihbar, iş emri, ekip)',
  health: 'Sağlık',
  education: 'Eğitim',
  social: 'Kültür, spor ve inanç',
  commerce: 'Ticaret ve hizmet',
  furniture: 'Kent donatısı',
  iot: 'Sensör ve saha cihazı',
  construction: 'İnşaat ve kazı',
  industry: 'Sanayi ve üretim',
  hazard: 'Afet ve tehlike',
};

export type CityGeometryKind = 'point' | 'line' | 'polygon' | 'volume' | 'none';

/**
 * What a live object can do.
 * telemetry: sends measurements · state: has an operational state ·
 * command: can be controlled · video: has a camera stream ·
 * position: moves (live location) · schedule: runs on a timetable ·
 * alarm: raises alarms · metering: billable consumption · booking: can be reserved ·
 * simulation: produced by a simulation as well as by live data.
 */
export type CityCapability =
  | 'telemetry'
  | 'state'
  | 'command'
  | 'video'
  | 'position'
  | 'schedule'
  | 'alarm'
  | 'metering'
  | 'booking'
  | 'simulation';

/** Same values as DEVICE_TYPES (index.ts): the device kind that carries the object's feed. */
export type CityDeviceKind =
  | 'sensor'
  | 'vehicle'
  | 'meter'
  | 'camera'
  | 'drone'
  | 'plc'
  | 'gateway'
  | 'other';

/** Binding to the canonical city model: a record of `theme` whose attrs match. */
export interface CityThemeBinding {
  theme: CityTheme;
  attrs?: Record<string, string>;
}

export interface CityClassDef {
  /** `<domain>.<name>`; stable, stored with records and commands. */
  id: string;
  label: string;
  domain: CityDomain;
  scale: CityScale;
  geometry: CityGeometryKind;
  description?: string;
  /** Classes this one is structurally part of (a platform of a station). */
  parents?: string[];
  capabilities?: CityCapability[];
  /** Commands (CITY_COMMANDS ids) the object accepts. */
  commands?: string[];
  deviceKind?: CityDeviceKind;
  /** Open standards / protocols its data and control arrive by. */
  standards?: string[];
  theme?: CityThemeBinding;
  /** Records of the class in further themes (a hospital's building and its point of interest). */
  also?: CityThemeBinding[];
}

// ─── Commands ───────────────────────────────────────────────────────────────

/**
 * How dangerous a command is; sets who may run it (CITY_COMMAND_POLICY).
 * A command changes the physical city, so it is never sent without a policy.
 */
export type CityCommandRisk = 'low' | 'medium' | 'high' | 'critical';

export interface CityCommandDef {
  id: string;
  label: string;
  risk: CityCommandRisk;
  /** The effect ends by itself or is undone by a reverse command. */
  reversible: boolean;
}

export const CITY_COMMANDS: readonly CityCommandDef[] = [
  {
    id: 'signal.request_crossing',
    label: 'Yaya geçiş isteği (buton)',
    risk: 'low',
    reversible: true,
  },
  { id: 'signal.set_plan', label: 'Sinyal planını değiştir', risk: 'high', reversible: true },
  {
    id: 'signal.preempt',
    label: 'Acil araç önceliği (yeşil dalga)',
    risk: 'high',
    reversible: true,
  },
  {
    id: 'signal.flash',
    label: 'Flaşör (sarı yanıp söner) moduna al',
    risk: 'high',
    reversible: true,
  },
  { id: 'lighting.switch', label: 'Aydınlatmayı aç / kapat', risk: 'low', reversible: true },
  { id: 'lighting.dim', label: 'Aydınlatma seviyesini ayarla', risk: 'low', reversible: true },
  { id: 'camera.ptz', label: 'Kamerayı çevir / yakınlaştır', risk: 'low', reversible: true },
  { id: 'camera.record', label: 'Kayıt başlat / durdur', risk: 'medium', reversible: true },
  { id: 'display.message', label: 'Ekranda mesaj göster', risk: 'medium', reversible: true },
  { id: 'gate.open', label: 'Kapı / bariyer aç', risk: 'medium', reversible: true },
  { id: 'gate.lock', label: 'Kapı / bariyer kilitle', risk: 'medium', reversible: true },
  { id: 'valve.operate', label: 'Vana aç / kapat', risk: 'high', reversible: true },
  { id: 'pump.operate', label: 'Pompa başlat / durdur', risk: 'high', reversible: true },
  { id: 'floodgate.operate', label: 'Taşkın kapağını işlet', risk: 'critical', reversible: true },
  { id: 'breaker.operate', label: 'Şalter / fider aç-kapat', risk: 'critical', reversible: true },
  { id: 'generation.curtail', label: 'Üretimi kıs (türbin / GES)', risk: 'high', reversible: true },
  { id: 'storage.set_mode', label: 'Depolama şarj / deşarj modu', risk: 'high', reversible: true },
  { id: 'charger.set_power', label: 'Şarj gücünü sınırla', risk: 'medium', reversible: true },
  { id: 'hvac.setpoint', label: 'Isıtma / soğutma ayarı', risk: 'low', reversible: true },
  {
    id: 'ventilation.mode',
    label: 'Tünel / bina havalandırma modu',
    risk: 'high',
    reversible: true,
  },
  { id: 'siren.activate', label: 'Uyarı sirenini çalıştır', risk: 'critical', reversible: false },
  {
    id: 'alert.broadcast',
    label: 'Bölgeye acil uyarı yayınla',
    risk: 'critical',
    reversible: false,
  },
  { id: 'road.close', label: 'Yolu / şeridi trafiğe kapat', risk: 'high', reversible: true },
  {
    id: 'dispatch.assign',
    label: 'Ekibi / aracı olaya yönlendir',
    risk: 'medium',
    reversible: true,
  },
  { id: 'drone.mission', label: 'İHA görev uçuşu', risk: 'high', reversible: true },
];

/**
 * Who may run a command of each risk. The AI operator proposes; it runs a
 * command alone only where `ai` is 'auto'. Every command is audited.
 * auto: runs at once · approve: one authorised operator confirms ·
 * two_person: two operators of different roles confirm.
 */
export const CITY_COMMAND_POLICY: Record<
  CityCommandRisk,
  { ai: 'auto' | 'propose'; approval: 'none' | 'approve' | 'two_person' }
> = {
  low: { ai: 'auto', approval: 'none' },
  medium: { ai: 'propose', approval: 'approve' },
  high: { ai: 'propose', approval: 'approve' },
  critical: { ai: 'propose', approval: 'two_person' },
};

// ─── Relations ──────────────────────────────────────────────────────────────

/** Relation kinds between city objects (twin_relationships.relationship). */
export const CITY_RELATIONS = {
  contains: 'İçerir (bina → kat → daire)',
  part_of: 'Parçasıdır (hat kesimi → hat)',
  connects_to: 'Bağlıdır (ağ topolojisi: boru, kablo, yol)',
  feeds: 'Besler (trafo → bina, depo → şebeke)',
  serves: 'Hizmet verir (hastane → mahalle, durak → hat)',
  stops_at: 'Durur (hat → istasyon / durak)',
  controls: 'Kontrol eder (sinyal cihazı → trafik ışığı)',
  monitors: 'İzler (kamera / sensör → nesne)',
  located_on: 'Üzerindedir (lamba → kaldırım kesimi)',
  adjacent_to: 'Komşudur',
  assigned_to: 'Atanmıştır (ekip → olay / iş emri)',
  affects: 'Etkiler (olay / afet → nesne)',
} as const;

export type CityRelation = keyof typeof CITY_RELATIONS;

// ─── Classes ────────────────────────────────────────────────────────────────

type Opts = Omit<CityClassDef, 'id' | 'label' | 'domain' | 'scale' | 'geometry'>;

const c = (
  id: string,
  label: string,
  scale: CityScale,
  geometry: CityGeometryKind,
  opts: Opts = {},
): CityClassDef => {
  const def: CityClassDef = {
    id,
    label,
    domain: id.slice(0, id.indexOf('.')) as CityDomain,
    scale,
    geometry,
    ...opts,
  };
  // An object that accepts commands is controllable by definition.
  const caps = def.capabilities ?? [];
  if (def.commands?.length && !caps.includes('command')) def.capabilities = [...caps, 'command'];
  return def;
};

const t = (theme: CityTheme, attrs?: Record<string, string>): CityThemeBinding =>
  attrs ? { theme, attrs } : { theme };

/**
 * The class of each point-of-interest kind (POI_KINDS): bound as a further
 * binding, so a hospital is one class whether it comes as a building or as
 * its point.
 */
const POI_CLASS: Record<string, string> = {
  restaurant: 'commerce.food',
  fast_food: 'commerce.food',
  cafe: 'commerce.food',
  bar: 'commerce.food',
  bakery: 'commerce.food',
  supermarket: 'commerce.shop',
  mall: 'commerce.shop',
  shop: 'commerce.shop',
  pharmacy: 'health.pharmacy',
  hospital: 'health.hospital',
  clinic: 'health.clinic',
  school: 'education.school',
  university: 'education.university',
  kindergarten: 'education.kindergarten',
  library: 'education.library',
  place_of_worship: 'social.mosque',
  museum: 'social.museum',
  culture: 'social.cultural_center',
  hotel: 'commerce.hotel',
  attraction: 'social.attraction',
  bank: 'commerce.bank_atm',
  atm: 'commerce.bank_atm',
  post_office: 'commerce.post_office',
  police: 'safety.police_station',
  fire_station: 'safety.fire_station',
  public_office: 'admin.public_office',
  bus_station: 'transit.bus_terminal',
  parking: 'mobility.parking_lot',
};

function withPoiBindings(classes: CityClassDef[]): CityClassDef[] {
  for (const [kind, id] of Object.entries(POI_CLASS)) {
    const d = classes.find((x) => x.id === id);
    if (!d) throw new Error(`POI kind ${kind}: no class ${id}`);
    d.also = [...(d.also ?? []), t('poi', { kind })];
  }
  return classes;
}

const LIVE_VEHICLE: Opts = { capabilities: ['position', 'state'], deviceKind: 'vehicle' };
const ROAD = (cls: string): Opts => ({ theme: t('road', { class: cls }) });

export const CITY_CLASSES: readonly CityClassDef[] = withPoiBindings([
  // ── İdari sınırlar ve adres
  c('admin.province', 'İl', 'region', 'polygon', { theme: t('boundary', { level: 'province' }) }),
  c('admin.district', 'İlçe', 'district', 'polygon', {
    theme: t('boundary', { level: 'district' }),
  }),
  c('admin.neighbourhood', 'Mahalle', 'neighbourhood', 'polygon', {
    theme: t('boundary', { level: 'neighbourhood' }),
  }),
  c('admin.village', 'Köy', 'neighbourhood', 'polygon', {
    theme: t('boundary', { level: 'village' }),
  }),
  c('admin.address', 'Adres (kapı numarası, UAVT)', 'building', 'point', { theme: t('address') }),
  c('admin.public_office', 'Kamu kurumu (belediye, adliye, valilik)', 'building', 'point'),

  // ── Arazi, mülkiyet ve kamusal alan
  c('land.block', 'Ada (yapı adası)', 'block', 'polygon'),
  c('land.parcel', 'Parsel', 'site', 'polygon', { theme: t('parcel') }),
  c('land.zoning_zone', 'İmar fonksiyon alanı', 'block', 'polygon'),
  c('land.site', 'Site / kapalı yerleşke', 'site', 'polygon', {
    description: 'Ortak yönetimli konut sitesi; sakin hizmetleri bu düzeyde çalışır.',
  }),
  c('land.residential_area', 'Konut / ticaret alanı', 'block', 'polygon', {
    theme: t('area', { kind: 'residential' }),
  }),
  c('land.industrial_area', 'Sanayi / liman / demiryolu alanı', 'district', 'polygon', {
    theme: t('area', { kind: 'industrial' }),
  }),
  c('land.plaza', 'Meydan', 'street', 'polygon', {
    theme: t('area', { kind: 'plaza' }),
  }),
  c('land.quarry', 'Taş ocağı / maden sahası', 'site', 'polygon', {
    theme: t('area', { kind: 'quarry' }),
  }),
  c('land.military', 'Askeri alan', 'district', 'polygon', {
    theme: t('area', { kind: 'military' }),
  }),

  // ── Yapılar ve iç mekân
  c('building.generic', 'Yapı (kullanımı bilinmiyor)', 'building', 'volume', {
    theme: t('building'),
  }),
  c('building.apartment', 'Apartman (konut)', 'building', 'volume', {
    theme: t('building', { use: 'residential' }),
  }),
  c('building.house', 'Müstakil konut', 'building', 'volume', {
    theme: t('building', { use: 'house' }),
  }),
  c('building.commercial', 'Ticari yapı', 'building', 'volume', {
    theme: t('building', { use: 'commercial' }),
  }),
  c('building.retail', 'Dükkân / mağaza binası', 'building', 'volume', {
    theme: t('building', { use: 'retail' }),
  }),
  c('building.office', 'Ofis binası', 'building', 'volume', {
    theme: t('building', { use: 'office' }),
  }),
  c('building.public', 'Kamu binası', 'building', 'volume', {
    theme: t('building', { use: 'public' }),
  }),
  c('building.industrial', 'Sanayi yapısı / fabrika', 'building', 'volume', {
    theme: t('building', { use: 'industrial' }),
  }),
  c('building.warehouse', 'Depo / lojistik binası', 'building', 'volume', {
    theme: t('building', { use: 'warehouse' }),
  }),
  c('building.garage', 'Garaj (tek kat)', 'building', 'volume', {
    theme: t('building', { use: 'garage' }),
  }),
  c('building.shed', 'Baraka / kulübe', 'building', 'volume', {
    theme: t('building', { use: 'shed' }),
  }),
  c('building.kiosk', 'Büfe', 'building', 'volume', { theme: t('building', { use: 'kiosk' }) }),
  c('building.mall', 'Alışveriş merkezi', 'building', 'volume'),
  c('building.hotel', 'Otel', 'building', 'volume'),
  c('building.parking_garage', 'Katlı / kapalı otopark', 'building', 'volume', {
    capabilities: ['telemetry'],
  }),
  c('building.floor', 'Kat', 'floor', 'volume', { parents: ['building.*'] }),
  c('building.unit', 'Bağımsız bölüm (daire, dükkân, ofis)', 'unit', 'volume', {
    parents: ['building.floor', 'building.*'],
    description: 'MAKS bağımsız bölümü; sayaç, kilit ve sakin hizmetleri buna bağlanır.',
  }),
  c('building.room', 'Oda / mahal', 'unit', 'volume', {
    parents: ['building.unit', 'building.floor'],
  }),
  c('building.hall', 'Salon / hol', 'floor', 'volume', {
    parents: ['building.floor', 'building.*'],
  }),
  c('building.service_desk', 'Hizmet masası (Beyaz Masa)', 'unit', 'point', {
    parents: ['building.hall', 'building.*'],
    capabilities: ['telemetry', 'state'],
    description: 'Sıra / bekleme süresi telemetri olarak gelir.',
  }),
  c('building.entrance', 'Bina girişi', 'building', 'point', { parents: ['building.*'] }),
  c('building.stairwell', 'Merdiven / kaçış yolu', 'building', 'volume', {
    parents: ['building.*'],
  }),
  c('building.elevator', 'Asansör', 'building', 'volume', {
    parents: ['building.*'],
    capabilities: ['telemetry', 'state', 'alarm'],
  }),
  c(
    'building.common_area',
    'Ortak alan (spor salonu, toplantı odası, otopark yeri)',
    'building',
    'volume',
    {
      parents: ['building.*', 'land.site'],
      capabilities: ['booking'],
    },
  ),
  c('building.shelter', 'Sığınak', 'building', 'volume', { parents: ['building.*'] }),
  c('building.boiler_room', 'Kazan dairesi / ısı merkezi', 'building', 'volume', {
    parents: ['building.*'],
    capabilities: ['telemetry', 'state', 'command', 'alarm'],
    commands: ['hvac.setpoint'],
  }),
  c('building.water_tank', 'Bina su deposu / hidrofor', 'building', 'volume', {
    parents: ['building.*'],
    capabilities: ['telemetry', 'alarm'],
  }),
  c('building.fire_system', 'Yangın algılama / söndürme sistemi', 'building', 'none', {
    parents: ['building.*'],
    capabilities: ['state', 'alarm'],
  }),

  // ── Bina ve sakin hizmetleri (cihazlar)
  c('resident.intercom', 'Görüntülü diyafon', 'building', 'point', {
    parents: ['building.entrance'],
    capabilities: ['video', 'command', 'state'],
    commands: ['gate.open'],
    deviceKind: 'camera',
    standards: ['SIP', 'ONVIF'],
  }),
  c('resident.video_doorbell', 'Görüntülü kapı zili', 'unit', 'point', {
    parents: ['building.unit'],
    capabilities: ['video', 'alarm'],
    deviceKind: 'camera',
  }),
  c('resident.smart_lock', 'Akıllı kilit', 'unit', 'point', {
    parents: ['building.unit', 'building.entrance'],
    capabilities: ['state', 'command'],
    commands: ['gate.open', 'gate.lock'],
    deviceKind: 'other',
  }),
  c('resident.access_gate', 'Site girişi / bariyer', 'site', 'point', {
    parents: ['land.site'],
    capabilities: ['state', 'command', 'video'],
    commands: ['gate.open', 'gate.lock'],
    deviceKind: 'plc',
  }),
  c('resident.smart_mailbox', 'Akıllı posta / kargo dolabı', 'building', 'point', {
    capabilities: ['state', 'command'],
    commands: ['gate.open'],
  }),
  c('resident.meter_electricity', 'Elektrik sayacı', 'unit', 'point', {
    parents: ['building.unit', 'building.*'],
    capabilities: ['metering', 'telemetry'],
    deviceKind: 'meter',
    standards: ['DLMS/COSEM', 'IEC 62056'],
  }),
  c('resident.meter_water', 'Su sayacı', 'unit', 'point', {
    parents: ['building.unit', 'building.*'],
    capabilities: ['metering', 'telemetry'],
    deviceKind: 'meter',
    standards: ['wM-Bus', 'LoRaWAN'],
  }),
  c('resident.meter_gas', 'Doğalgaz sayacı', 'unit', 'point', {
    parents: ['building.unit', 'building.*'],
    capabilities: ['metering', 'telemetry', 'alarm'],
    deviceKind: 'meter',
  }),
  c('resident.meter_heat', 'Isı pay ölçer / kalorimetre', 'unit', 'point', {
    parents: ['building.unit'],
    capabilities: ['metering', 'telemetry'],
    deviceKind: 'meter',
  }),

  // ── Karayolu ve trafik
  c('mobility.road_motorway', 'Otoyol', 'city', 'line', ROAD('motorway')),
  c('mobility.road_trunk', 'Devlet yolu / ekspres yol', 'city', 'line', ROAD('trunk')),
  c('mobility.road_primary', 'Ana arter', 'district', 'line', ROAD('primary')),
  c('mobility.road_secondary', 'Tali arter', 'district', 'line', ROAD('secondary')),
  c('mobility.road_tertiary', 'Toplayıcı yol', 'neighbourhood', 'line', ROAD('tertiary')),
  c('mobility.road_residential', 'Konut sokağı', 'street', 'line', ROAD('residential')),
  c('mobility.road_unclassified', 'Sınıflandırılmamış yol', 'street', 'line', ROAD('unclassified')),
  c('mobility.road_living_street', 'Yaşam sokağı', 'street', 'line', ROAD('living_street')),
  c('mobility.road_pedestrian', 'Yaya yolu / çarşı', 'street', 'line', ROAD('pedestrian')),
  c('mobility.road_service', 'Servis yolu', 'street', 'line', ROAD('service')),
  c('mobility.road_footway', 'Yaya patikası', 'street', 'line', ROAD('footway')),
  c('mobility.road_steps', 'Merdivenli yol', 'street', 'line', ROAD('steps')),
  c('mobility.road_track', 'Toprak / arazi yolu', 'street', 'line', ROAD('track')),
  c('mobility.road_cycleway', 'Bisiklet yolu', 'street', 'line', ROAD('cycleway')),
  c('mobility.carriageway_segment', 'Taşıt yolu kesimi (25 m)', 'street', 'polygon', {
    parents: ['mobility.road_*'],
    capabilities: ['state'],
    commands: ['road.close'],
    description: "Yolun 25 m'lik parçası; ihbar ve durum bu kesime bağlanır.",
  }),
  c('mobility.sidewalk_segment', 'Kaldırım kesimi (25 m)', 'street', 'polygon', {
    parents: ['mobility.road_*'],
    capabilities: ['state'],
  }),
  c('mobility.lane', 'Şerit', 'street', 'line', {
    parents: ['mobility.road_*'],
    capabilities: ['telemetry', 'state'],
    commands: ['road.close'],
  }),
  c('mobility.junction', 'Kavşak', 'street', 'point'),
  c('mobility.roundabout', 'Döner kavşak', 'street', 'polygon'),
  c('mobility.crossing_zebra', 'Yaya geçidi (çizgili)', 'street', 'line', {
    theme: t('crossing', { type: 'zebra' }),
  }),
  c('mobility.crossing_signals', 'Sinyalize yaya geçidi', 'street', 'line', {
    theme: t('crossing', { type: 'signals' }),
    capabilities: ['state'],
  }),
  c('mobility.crossing_uncontrolled', 'Kontrolsüz yaya geçişi', 'street', 'line', {
    theme: t('crossing', { type: 'uncontrolled' }),
  }),
  c('mobility.traffic_signal', 'Trafik ışığı (sinyal başı)', 'street', 'point', {
    theme: t('asset', { kind: 'traffic_signals' }),
    parents: ['mobility.signal_controller'],
    capabilities: ['state'],
  }),
  c('mobility.signal_controller', 'Kavşak sinyal kontrol cihazı', 'street', 'point', {
    parents: ['mobility.junction'],
    capabilities: ['telemetry', 'state', 'command', 'alarm', 'schedule'],
    commands: ['signal.set_plan', 'signal.preempt', 'signal.flash'],
    deviceKind: 'plc',
    standards: ['NTCIP 1202', 'UTMC', 'OCIT'],
  }),
  c('mobility.pedestrian_button', 'Yaya butonu', 'street', 'point', {
    parents: ['mobility.crossing_signals'],
    capabilities: ['state', 'command'],
    commands: ['signal.request_crossing'],
  }),
  c('mobility.parking_lot', 'Açık otopark', 'site', 'polygon', {
    theme: t('area', { kind: 'parking' }),
    capabilities: ['telemetry'],
  }),
  c('mobility.parking_space', 'Park yeri (doluluk sensörlü)', 'street', 'polygon', {
    parents: ['mobility.parking_lot', 'building.parking_garage'],
    capabilities: ['state', 'telemetry'],
    deviceKind: 'sensor',
  }),
  c('mobility.ev_charger', 'Elektrikli araç şarj istasyonu', 'street', 'point', {
    capabilities: ['state', 'telemetry', 'command', 'metering'],
    commands: ['charger.set_power'],
    standards: ['OCPP 2.0.1', 'OCPI'],
  }),
  c('mobility.fuel_station', 'Akaryakıt istasyonu', 'site', 'point', {
    theme: t('asset', { kind: 'fuel_station' }),
  }),
  c('mobility.fuel_station_area', 'Akaryakıt istasyonu alanı', 'site', 'polygon', {
    theme: t('area', { kind: 'fuel' }),
  }),
  c('mobility.variable_message_sign', 'Değişken mesaj levhası (VMS)', 'street', 'point', {
    capabilities: ['state', 'command'],
    commands: ['display.message'],
    standards: ['DATEX II', 'NTCIP 1203'],
  }),
  c('mobility.traffic_sensor', 'Trafik sayım sensörü / dedektör', 'street', 'point', {
    capabilities: ['telemetry'],
    deviceKind: 'sensor',
    standards: ['DATEX II'],
  }),
  c('mobility.enforcement_camera', 'Hız / EDS kamerası', 'street', 'point', {
    capabilities: ['video', 'telemetry'],
    deviceKind: 'camera',
  }),
  c('mobility.road_sign', 'Trafik levhası', 'street', 'point'),
  c('mobility.bike_station', 'Bisiklet / scooter istasyonu', 'street', 'point', {
    capabilities: ['state', 'telemetry'],
    standards: ['GBFS'],
  }),
  c('mobility.taxi_stand', 'Taksi durağı', 'street', 'point'),
  c('mobility.vehicle', 'Araç (canlı konum)', 'city', 'point', LIVE_VEHICLE),

  // ── Toplu taşıma
  c('transit.metro_line', 'Metro hattı', 'city', 'line', {
    capabilities: ['schedule', 'state'],
    standards: ['GTFS'],
  }),
  c('transit.metro_track', 'Metro ray hattı (tünel / viyadük kesimi)', 'district', 'line', {
    theme: t('road', { class: 'subway' }),
    parents: ['transit.metro_line'],
    capabilities: ['state'],
  }),
  c('transit.metro_station', 'Metro istasyonu', 'site', 'volume', {
    capabilities: ['state', 'telemetry', 'alarm'],
    standards: ['GTFS'],
  }),
  c('transit.metro_platform', 'Metro peronu', 'building', 'volume', {
    parents: ['transit.metro_station'],
  }),
  c('transit.station_entrance', 'İstasyon girişi', 'building', 'point', {
    parents: ['transit.metro_station', 'transit.rail_station'],
  }),
  c('transit.metro_train', 'Metro treni (canlı)', 'city', 'point', {
    ...LIVE_VEHICLE,
    standards: ['GTFS-RT', 'SIRI'],
  }),
  c('transit.tram_line', 'Tramvay hattı', 'city', 'line', {
    theme: t('road', { class: 'tram' }),
    capabilities: ['schedule'],
    standards: ['GTFS'],
  }),
  c('transit.tram_stop', 'Tramvay durağı', 'street', 'point', { standards: ['GTFS'] }),
  c('transit.tram', 'Tramvay (canlı)', 'city', 'point', {
    ...LIVE_VEHICLE,
    standards: ['GTFS-RT'],
  }),
  c('transit.rail_line', 'Banliyö / demiryolu hattı', 'region', 'line', {
    theme: t('road', { class: 'rail' }),
    capabilities: ['schedule'],
  }),
  c('transit.rail_station', 'Tren istasyonu', 'site', 'volume'),
  c('transit.train', 'Tren (canlı)', 'region', 'point', {
    ...LIVE_VEHICLE,
    standards: ['GTFS-RT'],
  }),
  c('transit.bus_line', 'Otobüs hattı', 'city', 'line', {
    capabilities: ['schedule'],
    standards: ['GTFS'],
  }),
  c('transit.bus_stop', 'Otobüs durağı', 'street', 'point', {
    theme: t('asset', { kind: 'bus_stop' }),
    standards: ['GTFS'],
  }),
  c('transit.bus', 'Otobüs (canlı)', 'city', 'point', {
    ...LIVE_VEHICLE,
    standards: ['GTFS-RT', 'SIRI'],
  }),
  c('transit.ferry_route', 'Vapur / deniz otobüsü hattı', 'region', 'line', {
    capabilities: ['schedule'],
  }),
  c('transit.cable_car', 'Teleferik / füniküler', 'district', 'line', { capabilities: ['state'] }),
  c('transit.depot', 'Toplu taşıma garajı / depo', 'site', 'polygon'),
  c('transit.bus_terminal', 'Şehirlerarası otobüs terminali (otogar)', 'site', 'volume', {
    theme: t('area', { kind: 'bus_station' }),
    capabilities: ['state', 'schedule'],
  }),
  c('transit.bus_bay', 'Otobüs peronu', 'unit', 'point', {
    parents: ['transit.bus_terminal'],
    capabilities: ['state', 'schedule'],
  }),
  c('transit.ticket_office', 'Bilet gişesi / yazıhane', 'unit', 'point', {
    parents: ['transit.bus_terminal', 'transit.rail_station'],
    capabilities: ['state'],
  }),
  c('transit.passenger_display', 'Yolcu bilgilendirme ekranı', 'street', 'point', {
    capabilities: ['state', 'command'],
    commands: ['display.message'],
  }),
  c('transit.fare_gate', 'Turnike', 'building', 'point', {
    parents: ['transit.station_entrance'],
    capabilities: ['telemetry', 'state'],
  }),

  // ── Havacılık
  c('aviation.airport', 'Havalimanı', 'region', 'polygon', {
    capabilities: ['state', 'schedule'],
    theme: t('area', { kind: 'airport' }),
  }),
  c('aviation.runway', 'Pist', 'district', 'polygon', {
    parents: ['aviation.airport'],
    capabilities: ['state'],
    theme: t('road', { class: 'runway' }),
  }),
  c('aviation.taxiway', 'Taksi yolu', 'district', 'polygon', {
    parents: ['aviation.airport'],
    theme: t('road', { class: 'taxiway' }),
  }),
  c('aviation.stopway', 'Pist uzatması / durma alanı', 'district', 'polygon', {
    parents: ['aviation.runway'],
    theme: t('road', { class: 'stopway' }),
  }),
  c('aviation.stand', 'Uçak park yeri', 'site', 'polygon', {
    parents: ['aviation.apron'],
    theme: t('road', { class: 'stand' }),
  }),
  c('aviation.apron', 'Apron', 'site', 'polygon', {
    parents: ['aviation.airport'],
    theme: t('area', { kind: 'apron' }),
  }),
  c('aviation.terminal', 'Terminal binası', 'building', 'volume', {
    parents: ['aviation.airport'],
    theme: t('building', { use: 'terminal' }),
  }),
  c('aviation.gate', 'Uçuş kapısı', 'building', 'point', { parents: ['aviation.terminal'] }),
  c('aviation.checkin_counter', 'Check-in bankosu', 'unit', 'point', {
    parents: ['aviation.terminal'],
    capabilities: ['state', 'telemetry'],
  }),
  c('aviation.security_checkpoint', 'Güvenlik kontrol noktası', 'unit', 'point', {
    parents: ['aviation.terminal'],
    capabilities: ['telemetry', 'state'],
    description: 'Kuyruk uzunluğu / bekleme süresi.',
  }),
  c('aviation.baggage_claim', 'Bagaj bandı', 'unit', 'point', {
    parents: ['aviation.terminal'],
    capabilities: ['state'],
  }),
  c('aviation.jet_bridge', 'Yolcu köprüsü', 'building', 'point', {
    parents: ['aviation.gate', 'aviation.terminal'],
    capabilities: ['state'],
  }),
  c('aviation.heliport', 'Helikopter pisti', 'site', 'polygon'),
  c('aviation.aircraft', 'Uçak (canlı)', 'region', 'point', {
    capabilities: ['position', 'state'],
    standards: ['ADS-B', 'Mode S', 'OpenSky / Flightradar24 API'],
  }),
  c('aviation.drone', 'İHA / drone', 'city', 'point', {
    capabilities: ['position', 'video', 'command'],
    commands: ['drone.mission'],
    deviceKind: 'drone',
  }),

  // ── Denizcilik ve liman
  c('maritime.port', 'Liman', 'district', 'polygon', {
    capabilities: ['state'],
    theme: t('area', { kind: 'harbour' }),
  }),
  c('maritime.berth', 'Rıhtım / yanaşma yeri', 'site', 'line', {
    parents: ['maritime.port'],
    capabilities: ['state'],
  }),
  c('maritime.pier', 'İskele', 'site', 'polygon'),
  c('maritime.marina', 'Marina', 'site', 'polygon'),
  c('maritime.breakwater', 'Dalgakıran', 'district', 'line'),
  c('maritime.lighthouse', 'Deniz feneri', 'site', 'point', { capabilities: ['state'] }),
  c('maritime.container_yard', 'Konteyner sahası', 'site', 'polygon', {
    parents: ['maritime.port'],
  }),
  c('maritime.crane', 'Liman vinci', 'site', 'point', {
    parents: ['maritime.port'],
    capabilities: ['telemetry', 'state'],
  }),
  c('maritime.vessel', 'Gemi (canlı)', 'region', 'point', {
    capabilities: ['position', 'state'],
    standards: ['AIS'],
  }),
  c('maritime.anchorage', 'Demir yeri / seyir yolu', 'region', 'polygon'),

  // ── Üstyapı ve mühendislik yapıları
  c('civil.bridge', 'Köprü / viyadük', 'street', 'polygon', {
    capabilities: ['telemetry', 'state'],
  }),
  c('civil.tunnel', 'Karayolu tüneli', 'street', 'volume', {
    capabilities: ['telemetry', 'state', 'command', 'alarm'],
    commands: ['ventilation.mode', 'road.close'],
  }),
  c('civil.pedestrian_bridge', 'Yaya üst geçidi', 'street', 'polygon'),
  c('civil.underpass', 'Alt geçit', 'street', 'polygon', { capabilities: ['state', 'alarm'] }),
  c('civil.retaining_wall', 'İstinat duvarı', 'street', 'line', { capabilities: ['telemetry'] }),
  c('civil.utility_gallery', 'Ortak altyapı galerisi', 'district', 'volume', {
    capabilities: ['telemetry', 'alarm'],
  }),
  c('civil.culvert', 'Menfez', 'street', 'line'),
  c('civil.valve', 'Altyapı vanası (diğer ağlar)', 'street', 'point', {
    theme: t('utility_node', { type: 'valve' }),
    capabilities: ['state'],
  }),
  c('civil.street_cabinet', 'Sokak dağıtım kutusu (diğer ağlar)', 'street', 'point', {
    theme: t('utility_node', { type: 'cabinet' }),
  }),
  c('civil.mine_gallery', 'Maden ocağı / galeri (yeraltı)', 'district', 'volume', {
    capabilities: ['telemetry', 'alarm'],
  }),

  // ── Enerji
  c('energy.power_line', 'Elektrik hattı (yeraltı / havai)', 'district', 'line', {
    theme: t('utility', { network: 'power' }),
    capabilities: ['state'],
  }),
  c('energy.power_pole', 'Elektrik direği (havai hat)', 'street', 'point', {
    theme: t('asset', { kind: 'power_pole' }),
  }),
  c('energy.transmission_tower', 'Enerji iletim direği (yüksek gerilim)', 'region', 'point', {
    theme: t('asset', { kind: 'power_tower' }),
  }),
  c('energy.substation', 'Trafo merkezi', 'site', 'polygon', {
    theme: t('area', { kind: 'substation' }),
    capabilities: ['telemetry', 'state', 'command', 'alarm'],
    commands: ['breaker.operate'],
    deviceKind: 'plc',
    standards: ['IEC 61850', 'IEC 60870-5-104'],
  }),
  c('energy.transformer', 'Dağıtım trafosu (köşk / direk tipi)', 'street', 'point', {
    capabilities: ['telemetry', 'state', 'alarm'],
  }),
  c('energy.power_cabinet', 'Elektrik dağıtım kutusu', 'street', 'point', {
    theme: t('utility_node', { type: 'cabinet', network: 'power' }),
  }),
  c(
    'energy.street_lighting_panel',
    'Aydınlatma panosu (sokak aydınlatma devresi)',
    'street',
    'point',
    {
      capabilities: ['state', 'command', 'telemetry'],
      commands: ['lighting.switch', 'lighting.dim'],
    },
  ),
  c('energy.gas_main', 'Doğalgaz hattı', 'district', 'line', {
    theme: t('utility', { network: 'gas' }),
  }),
  c('energy.gas_valve', 'Doğalgaz vanası', 'street', 'point', {
    theme: t('utility_node', { type: 'valve', network: 'gas' }),
    capabilities: ['state', 'command'],
    commands: ['valve.operate'],
  }),
  c('energy.gas_regulator', 'Doğalgaz basınç düşürme (RMS) istasyonu', 'site', 'point', {
    capabilities: ['telemetry', 'state', 'alarm'],
  }),
  c('energy.heat_line', 'Bölgesel ısıtma hattı', 'district', 'line', {
    theme: t('utility', { network: 'heat' }),
  }),
  c('energy.heat_plant', 'Isı merkezi / kojenerasyon', 'site', 'polygon', {
    capabilities: ['telemetry', 'state'],
  }),
  c('energy.power_plant', 'Santral (termik / hidroelektrik)', 'district', 'polygon', {
    theme: t('area', { kind: 'power_plant' }),
    capabilities: ['telemetry', 'state'],
  }),
  c('energy.wind_farm', 'Rüzgâr santrali (RES)', 'region', 'polygon', {
    capabilities: ['telemetry'],
  }),
  c('energy.wind_turbine', 'Rüzgâr türbini', 'site', 'point', {
    parents: ['energy.wind_farm'],
    capabilities: ['telemetry', 'state', 'command', 'alarm'],
    commands: ['generation.curtail'],
    standards: ['IEC 61400-25'],
  }),
  c('energy.solar_farm', 'Güneş santrali (GES)', 'site', 'polygon', {
    capabilities: ['telemetry', 'state', 'command'],
    commands: ['generation.curtail'],
  }),
  c('energy.rooftop_solar', 'Çatı GES paneli', 'building', 'polygon', {
    parents: ['building.*'],
    capabilities: ['telemetry'],
  }),
  c('energy.solar_array', 'Panel dizisi (blok)', 'site', 'polygon', {
    parents: ['energy.solar_farm'],
    capabilities: ['telemetry', 'alarm'],
  }),
  c('energy.inverter', 'İnvertör', 'site', 'point', {
    parents: ['energy.solar_farm', 'energy.solar_array', 'energy.rooftop_solar'],
    capabilities: ['telemetry', 'state', 'alarm', 'command'],
    commands: ['generation.curtail'],
    deviceKind: 'plc',
    standards: ['SunSpec Modbus', 'IEC 61850-7-420'],
  }),
  c('energy.power_transformer', 'Güç trafosu', 'site', 'point', {
    parents: ['energy.substation', 'energy.solar_farm', 'energy.wind_farm'],
    capabilities: ['telemetry', 'state', 'alarm'],
  }),
  c('energy.switchgear', 'Şalt hücresi / kesici', 'site', 'point', {
    parents: ['energy.substation', 'energy.solar_farm', 'building.*'],
    capabilities: ['state', 'alarm'],
    commands: ['breaker.operate'],
    standards: ['IEC 61850'],
  }),
  c('energy.battery_storage', 'Enerji depolama (batarya)', 'site', 'point', {
    capabilities: ['telemetry', 'state', 'command', 'alarm'],
    commands: ['storage.set_mode'],
  }),

  // ── Su, kanalizasyon ve yağmur suyu
  c('water.water_main', 'İçme suyu hattı', 'district', 'line', {
    theme: t('utility', { network: 'water' }),
    capabilities: ['telemetry'],
  }),
  c('water.water_valve', 'Su vanası', 'street', 'point', {
    theme: t('utility_node', { type: 'valve', network: 'water' }),
    capabilities: ['state', 'command'],
    commands: ['valve.operate'],
  }),
  c('water.sewer_main', 'Atık su (kanalizasyon) hattı', 'district', 'line', {
    theme: t('utility', { network: 'sewer' }),
  }),
  c('water.manhole', 'Rögar / baca kapağı', 'street', 'point', {
    theme: t('utility_node', { type: 'manhole' }),
    capabilities: ['state'],
  }),
  c('water.storm_drain', 'Yağmur suyu (drenaj) hattı', 'district', 'line', {
    description: 'Atık sudan ayrı şebeke; sel simülasyonunun drenaj kapasitesi buradan gelir.',
  }),
  c('water.storm_inlet', 'Yağmur suyu ızgarası / mazgal', 'street', 'point', {
    capabilities: ['state'],
  }),
  c('water.hydrant', 'Yangın hidrantı', 'street', 'point', {
    capabilities: ['state', 'telemetry'],
  }),
  c('water.pump_station', 'Pompa / terfi istasyonu', 'site', 'point', {
    capabilities: ['telemetry', 'state', 'command', 'alarm'],
    commands: ['pump.operate'],
    deviceKind: 'plc',
    standards: ['OPC UA', 'Modbus TCP'],
  }),
  c('water.reservoir', 'Su deposu / hazne', 'site', 'polygon', {
    capabilities: ['telemetry', 'alarm'],
  }),
  c('water.treatment_plant', 'İçme suyu arıtma tesisi', 'site', 'polygon', {
    capabilities: ['telemetry', 'state'],
  }),
  c('water.wastewater_plant', 'Atık su arıtma tesisi', 'site', 'polygon', {
    capabilities: ['telemetry', 'state'],
  }),
  c('water.dam', 'Baraj / gölet seti', 'region', 'polygon', {
    capabilities: ['telemetry', 'alarm'],
  }),
  c('water.river', 'Dere / nehir', 'region', 'line', { capabilities: ['telemetry', 'alarm'] }),
  c('water.flood_gate', 'Taşkın kapağı / seddesi', 'street', 'line', {
    capabilities: ['state', 'command'],
    commands: ['floodgate.operate'],
  }),
  c('water.irrigation_line', 'Park sulama hattı', 'street', 'line', {
    capabilities: ['state', 'command'],
    commands: ['valve.operate'],
  }),
  c('water.surface', 'Su yüzeyi (göl, gölet, havuz)', 'site', 'polygon', {
    theme: t('area', { kind: 'water' }),
  }),
  c('water.fountain', 'Çeşme / süs havuzu', 'street', 'point'),

  // ── Haberleşme
  c('telecom.fiber_line', 'Fiber / haberleşme hattı', 'district', 'line', {
    theme: t('utility', { network: 'telecom' }),
  }),
  c('telecom.fiber_cabinet', 'Fiber dağıtım kutusu', 'street', 'point', {
    theme: t('utility_node', { type: 'cabinet', network: 'telecom' }),
  }),
  c('telecom.cell_tower', 'Baz istasyonu', 'street', 'point'),
  c('telecom.mast', 'Anten / verici direği', 'site', 'point', {
    theme: t('asset', { kind: 'mast' }),
  }),
  c('telecom.wifi_hotspot', 'Kent Wi-Fi noktası', 'street', 'point', {
    capabilities: ['state', 'telemetry'],
  }),
  c('telecom.data_center', 'Veri merkezi', 'building', 'volume', {
    capabilities: ['state', 'alarm'],
  }),

  // ── Atık
  c('waste.container', 'Çöp konteyneri (doluluk sensörlü)', 'street', 'point', {
    capabilities: ['telemetry', 'state'],
    deviceKind: 'sensor',
  }),
  c('waste.underground_container', 'Yeraltı çöp konteyneri', 'street', 'point', {
    capabilities: ['telemetry', 'state'],
  }),
  c('waste.recycling_point', 'Geri dönüşüm kumbarası', 'street', 'point', {
    capabilities: ['telemetry'],
  }),
  c('waste.transfer_station', 'Atık aktarma istasyonu', 'site', 'polygon'),
  c('waste.landfill', 'Düzenli depolama alanı', 'region', 'polygon'),
  c('waste.collection_route', 'Atık toplama güzergâhı', 'district', 'line', {
    capabilities: ['schedule'],
  }),
  c('waste.collection_truck', 'Çöp kamyonu (canlı)', 'city', 'point', LIVE_VEHICLE),

  // ── Çevre, doğa ve ölçüm
  c('environment.tree', 'Ağaç', 'street', 'point', { theme: t('tree') }),
  c('environment.park', 'Park / bahçe', 'site', 'polygon', { theme: t('area', { kind: 'park' }) }),
  c('environment.grass', 'Çim / yeşil alan', 'site', 'polygon', {
    theme: t('area', { kind: 'grass' }),
  }),
  c('environment.forest', 'Orman / koruluk', 'district', 'polygon', {
    theme: t('area', { kind: 'forest' }),
  }),
  c('environment.cliff', 'Falez / şev', 'street', 'line', {
    theme: t('landform', { kind: 'cliff' }),
  }),
  c('environment.coastline', 'Kıyı çizgisi', 'city', 'line', {
    theme: t('landform', { kind: 'coastline' }),
  }),
  c('environment.air_quality_station', 'Hava kalitesi istasyonu', 'street', 'point', {
    capabilities: ['telemetry', 'alarm'],
    deviceKind: 'sensor',
    standards: ['OGC SensorThings'],
  }),
  c('environment.noise_sensor', 'Gürültü sensörü', 'street', 'point', {
    capabilities: ['telemetry'],
    deviceKind: 'sensor',
  }),
  c('environment.weather_station', 'Meteoroloji istasyonu', 'neighbourhood', 'point', {
    capabilities: ['telemetry', 'alarm'],
    deviceKind: 'sensor',
  }),
  c('environment.water_level_gauge', 'Dere / deniz seviye ölçer', 'street', 'point', {
    parents: ['water.river'],
    capabilities: ['telemetry', 'alarm'],
    deviceKind: 'sensor',
  }),
  c('environment.seismic_station', 'Deprem ivme ölçer istasyonu', 'neighbourhood', 'point', {
    capabilities: ['telemetry', 'alarm'],
    deviceKind: 'sensor',
  }),

  // ── Kamu güvenliği ve acil durum
  c('safety.police_station', 'Emniyet / karakol', 'site', 'polygon'),
  c('safety.fire_station', 'İtfaiye istasyonu', 'site', 'polygon', { capabilities: ['state'] }),
  c('safety.ambulance_station', '112 ambulans istasyonu', 'site', 'point', {
    capabilities: ['state'],
  }),
  c('safety.emergency_center', '112 acil çağrı merkezi', 'building', 'volume'),
  c('safety.cctv', 'MOBESE / şehir kamerası', 'street', 'point', {
    capabilities: ['video', 'state', 'command'],
    commands: ['camera.ptz', 'camera.record'],
    deviceKind: 'camera',
    standards: ['ONVIF', 'RTSP'],
  }),
  c('safety.siren', 'Afet / uyarı sireni', 'neighbourhood', 'point', {
    capabilities: ['state', 'command'],
    commands: ['siren.activate'],
  }),
  c('safety.assembly_area', 'Afet toplanma alanı', 'site', 'polygon', {
    capabilities: ['telemetry'],
  }),
  c('safety.temporary_shelter', 'Geçici barınma alanı', 'site', 'polygon', {
    capabilities: ['telemetry'],
  }),
  c('safety.police_vehicle', 'Devriye aracı (canlı)', 'city', 'point', LIVE_VEHICLE),
  c('safety.ambulance', 'Ambulans (canlı)', 'city', 'point', LIVE_VEHICLE),
  c('safety.fire_truck', 'İtfaiye aracı (canlı)', 'city', 'point', LIVE_VEHICLE),

  // ── Operasyon
  c('operations.incident', 'İhbar / olay', 'street', 'point', {
    capabilities: ['state'],
    commands: ['dispatch.assign'],
    standards: ['CAP 1.2', 'Open311'],
    description: 'Vatandaş, sensör ya da kurumdan gelen olay; nesneye ya da konuma bağlanır.',
  }),
  c('operations.work_order', 'İş emri', 'street', 'none', { capabilities: ['state', 'schedule'] }),
  c('operations.field_team', 'Saha ekibi', 'city', 'point', {
    capabilities: ['position', 'state'],
    commands: ['dispatch.assign'],
  }),
  c('operations.service_vehicle', 'Belediye hizmet aracı (canlı)', 'city', 'point', LIVE_VEHICLE),

  // ── Sağlık
  c('health.hospital', 'Hastane', 'site', 'volume', {
    theme: t('building', { use: 'hospital' }),
    capabilities: ['telemetry', 'state'],
    description: 'Yatak / acil doluluğu telemetri olarak gelir.',
  }),
  c('health.emergency_department', 'Acil servis', 'building', 'volume', {
    parents: ['health.hospital'],
    capabilities: ['telemetry', 'state'],
  }),
  c('health.clinic', 'Aile sağlığı merkezi / poliklinik', 'building', 'volume'),
  c('health.pharmacy', 'Eczane', 'building', 'point', { capabilities: ['schedule'] }),

  // ── Eğitim
  c('education.school', 'Okul', 'building', 'volume', { theme: t('building', { use: 'school' }) }),
  c('education.university', 'Üniversite binası', 'building', 'volume', {
    theme: t('building', { use: 'university' }),
  }),
  c('education.campus', 'Okul / hastane / kampüs bahçesi', 'site', 'polygon', {
    theme: t('area', { kind: 'school' }),
  }),
  c('education.kindergarten', 'Anaokulu / kreş', 'building', 'volume'),
  c('education.library', 'Kütüphane', 'building', 'volume'),

  // ── Kültür, spor ve inanç
  c('social.stadium', 'Stadyum', 'site', 'volume', {
    theme: t('area', { kind: 'stadium' }),
    capabilities: ['telemetry', 'state', 'schedule'],
    description: 'Etkinlik takvimi ve kalabalık yoğunluğu.',
  }),
  c('social.pitch', 'Saha (oyun alanı)', 'site', 'polygon', {
    parents: ['social.stadium'],
    theme: t('area', { kind: 'pitch' }),
  }),
  c('social.running_track', 'Atletizm pisti', 'site', 'polygon', {
    parents: ['social.stadium'],
    theme: t('area', { kind: 'track' }),
  }),
  c('social.stand_sector', 'Tribün sektörü', 'building', 'polygon', {
    parents: ['social.stadium'],
    theme: t('building', { use: 'stadium' }),
    capabilities: ['telemetry'],
    description: 'Doluluk telemetri olarak gelir.',
  }),
  c('social.turnstile', 'Stadyum turnikesi', 'building', 'point', {
    parents: ['social.stadium'],
    capabilities: ['telemetry', 'state'],
  }),
  c('social.sports_hall', 'Spor salonu', 'building', 'volume'),
  c('social.sports_field', 'Spor sahası', 'site', 'polygon'),
  c('social.mosque', 'Cami / ibadethane', 'building', 'volume', {
    theme: t('building', { use: 'mosque' }),
  }),
  c('social.religious_yard', 'İbadethane avlusu', 'site', 'polygon', {
    theme: t('area', { kind: 'religious' }),
  }),
  c('social.cultural_center', 'Kültür merkezi / tiyatro', 'building', 'volume'),
  c('social.museum', 'Müze', 'building', 'volume'),
  c('social.cemetery', 'Mezarlık', 'site', 'polygon', {
    theme: t('area', { kind: 'cemetery' }),
  }),
  c('social.playground', 'Çocuk oyun alanı', 'site', 'polygon', {
    theme: t('area', { kind: 'playground' }),
  }),

  // ── Ticaret ve hizmet
  c('commerce.shop', 'Mağaza / işletme', 'building', 'point'),
  c('commerce.market', 'Semt pazarı', 'street', 'polygon', {
    capabilities: ['schedule'],
    theme: t('area', { kind: 'marketplace' }),
  }),
  c('commerce.bank_atm', 'Banka / ATM', 'building', 'point'),
  c('commerce.food', 'Yeme-içme işletmesi (lokanta, kafe, bar, fırın)', 'building', 'point'),
  c('commerce.hotel', 'Otel / konaklama', 'building', 'point'),
  c('commerce.post_office', 'Postane', 'building', 'point'),
  c('social.attraction', 'Gezilecek yer / seyir noktası', 'site', 'point'),

  // ── Kent donatısı (sokaktaki sabit kamu eşyası)
  c('furniture.street_lamp', 'Sokak lambası / aydınlatma direği', 'street', 'point', {
    theme: t('asset', { kind: 'street_lamp' }),
    parents: ['energy.street_lighting_panel'],
    capabilities: ['state', 'command'],
    commands: ['lighting.switch', 'lighting.dim'],
  }),
  c('furniture.bench', 'Bank', 'street', 'point', { theme: t('asset', { kind: 'bench' }) }),
  c('furniture.waste_basket', 'Çöp kutusu (sokak)', 'street', 'point', {
    theme: t('asset', { kind: 'waste_basket' }),
  }),
  c('furniture.bollard', 'Babalık / dikme', 'street', 'point'),
  c('furniture.floodlight', 'Projektör direği', 'street', 'point', {
    theme: t('asset', { kind: 'floodlight' }),
  }),
  c('furniture.flagpole', 'Bayrak direği', 'street', 'point', {
    theme: t('asset', { kind: 'flagpole' }),
  }),
  c('furniture.bike_rack', 'Bisiklet park yeri', 'street', 'point'),
  c('furniture.billboard', 'Reklam panosu / dijital pano', 'street', 'point', {
    capabilities: ['state', 'command'],
    commands: ['display.message'],
  }),
  c('furniture.info_kiosk', 'Kent bilgi ekranı / totem', 'street', 'point', {
    capabilities: ['state', 'command'],
    commands: ['display.message'],
  }),
  c('furniture.public_toilet', 'Umumi tuvalet', 'street', 'point', { capabilities: ['state'] }),
  c('furniture.play_equipment', 'Oyun elemanı (salıncak, kaydırak …)', 'site', 'point', {
    parents: ['social.playground'],
  }),
  c('furniture.fence', 'Çit / bahçe duvarı', 'site', 'line'),
  c('furniture.planter', 'Saksı / çiçeklik', 'street', 'point'),

  // ── Sensör ve saha cihazı
  c('iot.sensor', 'Genel sensör', 'street', 'point', {
    capabilities: ['telemetry'],
    deviceKind: 'sensor',
  }),
  c('iot.gateway', 'IoT ağ geçidi (LoRaWAN, NB-IoT)', 'neighbourhood', 'point', {
    capabilities: ['state'],
    deviceKind: 'gateway',
    standards: ['LoRaWAN', 'MQTT'],
  }),
  c('iot.plc', 'Saha kontrolcüsü (SCADA / PLC)', 'site', 'point', {
    capabilities: ['telemetry', 'state', 'command'],
    deviceKind: 'plc',
    standards: ['OPC UA', 'Modbus TCP', 'IEC 62443'],
  }),
  c('iot.flood_sensor', 'Su baskını sensörü (alt geçit, bodrum)', 'street', 'point', {
    capabilities: ['telemetry', 'alarm'],
    deviceKind: 'sensor',
  }),
  c('iot.structural_sensor', 'Yapı sağlığı sensörü (köprü, bina)', 'building', 'point', {
    capabilities: ['telemetry', 'alarm'],
    deviceKind: 'sensor',
  }),

  // ── İnşaat ve kazı
  c('construction.site', 'İnşaat alanı', 'site', 'polygon', {
    capabilities: ['state'],
    theme: t('area', { kind: 'construction' }),
  }),
  c('construction.building', 'Yapım hâlindeki bina', 'building', 'volume', {
    parents: ['construction.site'],
    capabilities: ['state'],
  }),
  c('construction.road_works', 'Yol çalışması', 'street', 'polygon', { capabilities: ['state'] }),
  c('construction.excavation', 'Altyapı kazısı', 'street', 'polygon', { capabilities: ['state'] }),
  c('construction.tower_crane', 'Kule vinç', 'site', 'point', {
    parents: ['construction.site'],
    capabilities: ['telemetry', 'state'],
  }),

  // ── Sanayi ve üretim
  c('industry.production_hall', 'Üretim holü', 'floor', 'polygon', { parents: ['building.*'] }),
  c('industry.production_line', 'Üretim hattı', 'floor', 'line', {
    parents: ['industry.production_hall', 'building.*'],
    capabilities: ['telemetry', 'state', 'alarm'],
    standards: ['OPC UA', 'ISA-95'],
  }),
  c('industry.machine', 'Makine / tezgâh', 'unit', 'point', {
    parents: ['industry.production_line', 'industry.production_hall'],
    capabilities: ['telemetry', 'state', 'alarm'],
    deviceKind: 'plc',
    standards: ['OPC UA', 'MTConnect'],
  }),
  c('industry.storage_rack', 'Raf sistemi', 'unit', 'line', {
    parents: ['building.*', 'industry.production_hall'],
    capabilities: ['telemetry'],
  }),
  c('industry.loading_dock', 'Yükleme rampası', 'building', 'point', {
    parents: ['building.*'],
    capabilities: ['state'],
  }),

  // ── Afet ve tehlike (canlı olay ya da simülasyon)
  c('hazard.earthquake', 'Deprem', 'region', 'point', {
    capabilities: ['simulation', 'state'],
    description: 'Dış merkez, büyüklük, derinlik; yer hareketi alanı ve bina hasarı üretir.',
  }),
  c('hazard.fault_line', 'Fay hattı', 'region', 'line'),
  c('hazard.flood', 'Sel / taşkın', 'city', 'polygon', {
    capabilities: ['simulation', 'state'],
    description: 'Yağış ve arazi modelinden su yüksekliği alanı (zamanla değişir).',
  }),
  c('hazard.flood_zone', 'Taşkın riski alanı', 'district', 'polygon'),
  c('hazard.fire', 'Yangın (bina / orman)', 'neighbourhood', 'polygon', {
    capabilities: ['simulation', 'state'],
    description: 'Rüzgâr, eğim ve yakıta göre yayılan yangın cephesi ve duman.',
  }),
  c('hazard.landslide', 'Heyelan', 'neighbourhood', 'polygon', {
    capabilities: ['simulation', 'state'],
  }),
  c('hazard.subsidence', 'Tasman / göçük', 'neighbourhood', 'polygon', { capabilities: ['state'] }),
  c('hazard.hazmat', 'Tehlikeli madde sızıntısı', 'neighbourhood', 'polygon', {
    capabilities: ['simulation', 'state'],
  }),
  c('hazard.evacuation_route', 'Tahliye güzergâhı', 'district', 'line'),
]);

// ─── Lookups ────────────────────────────────────────────────────────────────

const BY_ID = new Map(CITY_CLASSES.map((d) => [d.id, d]));

export function cityClass(id: string): CityClassDef | undefined {
  return BY_ID.get(id);
}

/** A `parents` entry is a class id or a prefix pattern (`building.*`, `mobility.road_*`). */
export function matchesClassPattern(pattern: string, id: string): boolean {
  return pattern.endsWith('*') ? id.startsWith(pattern.slice(0, -1)) : pattern === id;
}

/** May an object of `childId` be structurally part of an object of `parentId`? */
export function canContain(parentId: string, childId: string): boolean {
  const child = BY_ID.get(childId);
  if (!child?.parents) return false;
  return child.parents.some((p) => matchesClassPattern(p, parentId));
}

/** Every theme binding of a class (its own and `also`). */
export function bindingsOf(d: CityClassDef): CityThemeBinding[] {
  return [...(d.theme ? [d.theme] : []), ...(d.also ?? [])];
}

/** The class a canonical city record belongs to (most specific binding wins). */
export function classOfRecord(
  theme: CityTheme,
  attrs: Record<string, unknown> = {},
): CityClassDef | undefined {
  let best: CityClassDef | undefined;
  let bestKeys = -1;
  for (const d of CITY_CLASSES)
    for (const b of bindingsOf(d)) {
      if (b.theme !== theme) continue;
      const want = b.attrs ?? {};
      const keys = Object.keys(want);
      if (keys.every((k) => attrs[k] === want[k]) && keys.length > bestKeys) {
        best = d;
        bestKeys = keys.length;
      }
    }
  return best;
}

export function commandOf(id: string): CityCommandDef | undefined {
  return CITY_COMMANDS.find((cmd) => cmd.id === id);
}
