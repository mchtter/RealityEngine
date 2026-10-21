/**
 * Reality Engine uyum motoru — kural kataloğu.
 *
 * One table of rules between classes (classes.ts). A rule names the pair, the
 * relation it governs, the constraint, the stage it runs at and what the
 * object that gives way does. Rules with `apply` are enforced by the engine
 * (engine.ts) and leave a correction (Fix) behind; rules without it are the
 * catalogue's open items: they are checked by the validator (`checks`) or
 * planned (tasks/kavra-uyum-motoru.md), and listed here so the whole system
 * is in one place.
 *
 * Stages run in this order inside the compiler (§4.3 of the plan):
 *   data → network → elevation → structures → surfaces → paint → furniture → audit
 */
import type { CityClassId } from './classes';

export type Stage =
  | 'data'
  | 'network'
  | 'elevation'
  | 'structures'
  | 'surfaces'
  | 'paint'
  | 'furniture'
  | 'audit';

export type Relation =
  /** Footprints overlap at the same level. */
  | 'overlaps'
  /** One passes over the other (needs vertical clearance). */
  | 'over'
  /** One passes under the other. */
  | 'under'
  /** Closer than a margin. */
  | 'near'
  /** Ends must meet (snap). */
  | 'joins';

export interface RuleDef {
  id: string;
  stage: Stage;
  /** The class that gives way. */
  subject: CityClassId;
  /** The class it gives way to. */
  other: CityClassId;
  relation: Relation;
  /** The constraint, in words (Turkish, shown in the panel). */
  constraint: string;
  /** What the subject does when the constraint is broken. */
  action: 'cut' | 'remove' | 'move' | 'raise' | 'lower' | 'elevate' | 'snap' | 'flag';
  /** Validator rules (validate.ts) that check it, where one exists. */
  checks?: string[];
  /** Enforced by the engine (else: checked / planned only). */
  enforced: boolean;
}

/**
 * The catalogue. Order within a stage is the order of enforcement: a rule
 * sees what the rules before it left.
 */
export const RULES: readonly RuleDef[] = [
  // ── data: sources and geometry
  {
    id: 'data.duplicate-area',
    stage: 'data',
    subject: 'green',
    other: 'green',
    relation: 'overlaps',
    constraint: 'Aynı alan iki kaynaktan bir kez çizilir (öncelikli kaynak kalır).',
    action: 'remove',
    enforced: true,
  },
  {
    id: 'data.superseded-building',
    stage: 'data',
    subject: 'building',
    other: 'building',
    relation: 'overlaps',
    constraint:
      "%30'dan fazlası öncelikli kaynakça örtülen bina aynı binadır; düşük öncelikli kaynak kalkar.",
    action: 'remove',
    enforced: true,
  },
  {
    id: 'data.invalid-geometry',
    stage: 'data',
    subject: 'building',
    other: 'building',
    relation: 'overlaps',
    constraint: 'Kendini kesen poligon onarılır.',
    action: 'cut',
    enforced: true,
  },

  // ── network: roads, rails, airfields at their levels
  {
    id: 'network.grade-transfer',
    stage: 'network',
    subject: 'carriageway',
    other: 'bridge',
    relation: 'joins',
    constraint: 'Kurum yol ağı, üstünden geçen OSM köprüsünün kotunu alır.',
    action: 'snap',
    enforced: true,
  },
  {
    id: 'network.deck-ends',
    stage: 'network',
    subject: 'bridge',
    other: 'bridge',
    relation: 'joins',
    constraint: 'Uç uca gelen köprü parçaları aynı kotta birleşir.',
    action: 'snap',
    checks: ['seam.bridge-end'],
    enforced: true,
  },
  {
    id: 'network.shore',
    stage: 'network',
    subject: 'water',
    other: 'carriageway',
    relation: 'overlaps',
    constraint: 'Kıyı yolu ve çevresi deniz kotunun en az 1 m üstündedir.',
    action: 'raise',
    enforced: true,
  },

  // ── elevation: what passes over what
  {
    id: 'clearance.bridge-rail',
    stage: 'elevation',
    subject: 'bridge',
    other: 'rail',
    relation: 'over',
    constraint: 'Ray hattı üstünde alt açıklık en az 6,5 m.',
    action: 'raise',
    enforced: true,
  },
  {
    id: 'clearance.bridge-tram',
    stage: 'elevation',
    subject: 'bridge',
    other: 'tram',
    relation: 'over',
    constraint: 'Tramvay üstünde alt açıklık en az 6 m.',
    action: 'raise',
    enforced: true,
  },
  {
    id: 'clearance.bridge-road',
    stage: 'elevation',
    subject: 'bridge',
    other: 'carriageway',
    relation: 'over',
    constraint: 'Taşıt yolu üstünde alt açıklık en az 4,8 m.',
    action: 'raise',
    enforced: true,
  },
  {
    id: 'clearance.bridge-path',
    stage: 'elevation',
    subject: 'bridge',
    other: 'path',
    relation: 'over',
    constraint: 'Yaya yolu üstünde alt açıklık en az 2,5 m.',
    action: 'raise',
    enforced: true,
  },
  {
    id: 'pier.rail',
    stage: 'elevation',
    subject: 'pier',
    other: 'rail',
    relation: 'overlaps',
    constraint: 'Köprü ayağı ray yatağına ve 1 m yakınına basmaz.',
    action: 'move',
    enforced: true,
  },
  {
    id: 'pier.carriageway',
    stage: 'elevation',
    subject: 'pier',
    other: 'carriageway',
    relation: 'overlaps',
    constraint: 'Köprü ayağı taşıt yoluna basmaz (bordürden 0,9 m).',
    action: 'move',
    checks: ['pier.carriageway'],
    enforced: true,
  },
  {
    id: 'clearance.overhead',
    stage: 'elevation',
    subject: 'overhead',
    other: 'building',
    relation: 'over',
    constraint: 'Enerji hattı binanın üstünden en az 5 m yukarıdan geçer.',
    action: 'flag',
    enforced: false,
  },
  {
    id: 'rail.bridge-deck',
    stage: 'elevation',
    subject: 'rail',
    other: 'carriageway',
    relation: 'over',
    constraint:
      'Köprüdeki ray hattı köprü tabliyesinde, altındaki yolun açıklığı korunarak çizilir.',
    action: 'elevate',
    enforced: true,
  },
  {
    id: 'tunnel.cover',
    stage: 'elevation',
    subject: 'tunnel',
    other: 'terrain',
    relation: 'under',
    constraint: 'Tünel tavanı ile zemin arasında örtü kalır; yarma duvarları birleşir.',
    action: 'lower',
    checks: ['seam.trench-rim', 'seam.twin-trench'],
    enforced: true,
  },
  {
    id: 'underground.station',
    stage: 'elevation',
    subject: 'rail',
    other: 'terrain',
    relation: 'under',
    constraint: 'Yer altı istasyonu girişleriyle birlikte yerin altında; girişten inilir.',
    action: 'lower',
    enforced: false,
  },

  // ── structures: buildings against everything above them
  {
    id: 'building.rail',
    stage: 'structures',
    subject: 'building',
    other: 'rail',
    relation: 'overlaps',
    constraint:
      'Bina ray yatağına ve 1 m güvenlik payına girmez (yükseltilmiş hol ve peron örtüsü hariç).',
    action: 'cut',
    enforced: true,
  },
  {
    id: 'building.tram',
    stage: 'structures',
    subject: 'building',
    other: 'tram',
    relation: 'overlaps',
    constraint: 'Bina tramvay yatağına ve 0,5 m güvenlik payına girmez.',
    action: 'cut',
    enforced: true,
  },
  {
    id: 'building.carriageway',
    stage: 'structures',
    subject: 'building',
    other: 'carriageway',
    relation: 'overlaps',
    constraint: 'Bina taşıt yoluna ve kaldırıma taşmaz; kaldırımdan 2 m geride kesilir.',
    action: 'cut',
    enforced: true,
  },
  {
    id: 'building.building',
    stage: 'structures',
    subject: 'building',
    other: 'building',
    relation: 'overlaps',
    constraint: 'Binalar üst üste binmez; sonra gelen kesilir.',
    action: 'cut',
    checks: ['overlap.building', 'data.overlap'],
    enforced: true,
  },
  {
    id: 'building.raised',
    stage: 'structures',
    subject: 'elevated-building',
    other: 'rail',
    relation: 'over',
    constraint:
      'Ray / yol üstündeki istasyon holü kolonlar üstünde, alt kotu açıklık zarfının üstünde.',
    action: 'elevate',
    enforced: true,
  },
  {
    id: 'building.structure',
    stage: 'structures',
    subject: 'building',
    other: 'bridge',
    relation: 'overlaps',
    constraint: 'Bina köprü tabliyesine, ayağına ve yarmaya girmez.',
    action: 'cut',
    checks: ['building.structure'],
    enforced: false,
  },
  {
    id: 'building.airfield',
    stage: 'structures',
    subject: 'building',
    other: 'airfield',
    relation: 'near',
    constraint: "Pist ve taksi yoluna 10 m'den yakın bina yok.",
    action: 'flag',
    enforced: false,
  },
  {
    id: 'building.pylon',
    stage: 'structures',
    subject: 'building',
    other: 'pylon',
    relation: 'near',
    constraint: 'Yüksek gerilim direğinin 2 m yakınında bina yok.',
    action: 'flag',
    enforced: false,
  },
  {
    id: 'balcony.carriageway',
    stage: 'structures',
    subject: 'building',
    other: 'carriageway',
    relation: 'over',
    constraint: 'Balkon ve cumba taşıt yolunun üstüne çıkmaz (Fransız balkon olur).',
    action: 'cut',
    enforced: true,
  },

  // ── surfaces: one surface per spot
  {
    id: 'surface.rail',
    stage: 'surfaces',
    subject: 'hard-ground',
    other: 'rail',
    relation: 'overlaps',
    constraint: 'Ray yatağının altında kaldırım, avlu, otopark, saha yok (yatak tek yüzey).',
    action: 'cut',
    enforced: true,
  },
  {
    id: 'surface.carriageway',
    stage: 'surfaces',
    subject: 'street-surface',
    other: 'carriageway',
    relation: 'overlaps',
    constraint: 'Kaldırım / refüj / döşeme taşıt yolunun üstünde değil.',
    action: 'cut',
    checks: ['surface.over-carriageway'],
    enforced: true,
  },
  {
    id: 'surface.hairline',
    stage: 'surfaces',
    subject: 'street-surface',
    other: 'street-surface',
    relation: 'overlaps',
    constraint: "5 cm'den ince yüzey parçası kalmaz.",
    action: 'remove',
    checks: ['surface.hairline'],
    enforced: true,
  },
  {
    id: 'path.carriageway',
    stage: 'surfaces',
    subject: 'path',
    other: 'carriageway',
    relation: 'overlaps',
    constraint: 'Aynı kotta yolla üst üste binen yaya yolu yüzeyi çizilmez (yol kazanır).',
    action: 'remove',
    enforced: false,
  },
  {
    id: 'path.bridge-end',
    stage: 'surfaces',
    subject: 'path',
    other: 'bridge',
    relation: 'joins',
    constraint: 'Üst geçidin ucu yaya yoluna bağlanır; merdiven / rampa üretilir.',
    action: 'snap',
    checks: ['seam.bridge-end'],
    enforced: false,
  },
  {
    id: 'green.special-ground',
    stage: 'surfaces',
    subject: 'green',
    other: 'special-ground',
    relation: 'overlaps',
    constraint:
      'Liman, şantiye, mezarlık, havalimanı gibi alanlara bahçe ağacı ve dolgu bina konmaz.',
    action: 'remove',
    enforced: true,
  },

  // ── paint
  {
    id: 'marking.rail',
    stage: 'paint',
    subject: 'marking',
    other: 'rail',
    relation: 'overlaps',
    constraint: 'Yol ve yaya çizgisi ray yatağının üstüne boyanmaz.',
    action: 'cut',
    enforced: true,
  },
  {
    id: 'marking.path-cross',
    stage: 'paint',
    subject: 'marking',
    other: 'path',
    relation: 'overlaps',
    constraint: 'Yaya yolu kenar çizgisi başka yaya yolunu kesmez.',
    action: 'cut',
    checks: ['marking.path-cross'],
    enforced: true,
  },

  // ── furniture
  {
    id: 'furniture.rail',
    stage: 'furniture',
    subject: 'furniture',
    other: 'rail',
    relation: 'overlaps',
    constraint: 'Direk, lamba, durak, kabin ray yatağında olmaz; yatağın dışına taşınır.',
    action: 'move',
    enforced: true,
  },
  {
    id: 'tree.rail',
    stage: 'furniture',
    subject: 'tree',
    other: 'rail',
    relation: 'overlaps',
    constraint: 'Ray yatağında ağaç olmaz.',
    action: 'remove',
    enforced: true,
  },
  {
    id: 'fence.rail',
    stage: 'furniture',
    subject: 'fence',
    other: 'rail',
    relation: 'overlaps',
    constraint: 'Duvar / çit ray hattını kesmez.',
    action: 'cut',
    enforced: true,
  },
  {
    id: 'furniture.carriageway',
    stage: 'furniture',
    subject: 'furniture',
    other: 'carriageway',
    relation: 'overlaps',
    constraint: 'Donatı taşıt yolunda olmaz; bordüre çekilir.',
    action: 'move',
    checks: ['pole.kerb'],
    enforced: true,
  },
  {
    id: 'furniture.bridge',
    stage: 'furniture',
    subject: 'furniture',
    other: 'bridge',
    relation: 'under',
    constraint: 'Donatı köprü ayağına ve tabliyenin altına girmez.',
    action: 'remove',
    enforced: true,
  },
  {
    id: 'furniture.building',
    stage: 'furniture',
    subject: 'furniture',
    other: 'building',
    relation: 'overlaps',
    constraint: 'Donatı binanın içinde olmaz; ağaç duvara sığacak kadar küçülür.',
    action: 'remove',
    checks: ['overlap.prop-building'],
    enforced: true,
  },
  {
    id: 'furniture.support',
    stage: 'furniture',
    subject: 'furniture',
    other: 'street-surface',
    relation: 'overlaps',
    constraint: 'Her donatı kendi zeminine oturur (araba otoparka, ağaç toprağa …).',
    action: 'remove',
    checks: ['prop.support', 'prop.height'],
    enforced: true,
  },
  {
    id: 'fence.carriageway',
    stage: 'furniture',
    subject: 'fence',
    other: 'carriageway',
    relation: 'overlaps',
    constraint: 'Bahçe duvarı yolda olmaz.',
    action: 'cut',
    checks: ['fence.street'],
    enforced: true,
  },

  // ── audit: what is left over is listed, never silent
  {
    id: 'audit.validator',
    stage: 'audit',
    subject: 'synthetic',
    other: 'synthetic',
    relation: 'overlaps',
    constraint: 'Doğrulayıcının bulduğu kalan ihlaller panelde "çözülemedi" olarak listelenir.',
    action: 'flag',
    enforced: false,
  },
];

export const RULE_BY_ID: Readonly<Record<string, RuleDef>> = Object.fromEntries(
  RULES.map((r) => [r.id, r]),
);
