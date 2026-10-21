/**
 * Kavra uyum motoru — sınıf kaydı.
 *
 * Every kind of thing the city model holds is a class here: its place in the
 * order of precedence (`rank`: a lower rank never gives way to a higher one),
 * the stratum it lives in, and the space it claims around itself (vertical
 * clearance above it, a horizontal safety margin). Rules (rules.ts) are
 * written between classes, never between concrete types, so a new kind of
 * object joins every rule of its class by being registered here.
 */

/** Where an object lives relative to the ground. */
export type Stratum =
  /** The ground itself (terrain, sea). */
  | 'ground'
  /** On the ground: a footprint that takes its share of the surface. */
  | 'grade'
  /** Raised over the ground: decks, elevated halls, overhead lines. */
  | 'above'
  /** Under the ground: tubes, cuttings, buried networks. */
  | 'below'
  /** Paint and thin finishes laid on a surface. */
  | 'paint';

export interface CityClass {
  id: CityClassId;
  /** Turkish name, for correction notes and the panel. */
  label: string;
  /**
   * Precedence: in a conflict the higher number gives way (is cut, moved,
   * raised, lowered or removed). Same rank: the data source decides
   * (authoritative register > institution > OSM > synthetic).
   */
  rank: number;
  stratum: Stratum;
  /** Free height a crossing object must leave above it (m). */
  clearance?: number;
  /** Horizontal margin nothing of a higher rank may enter (m, beyond the footprint). */
  margin?: number;
}

/**
 * The classes, in order of precedence (plan §4.1):
 * terrain → rail → carriageway → bridge → tunnel → building → path →
 * surface → paint → furniture → synthetic.
 */
const CLASSES = [
  // 1 — the ground
  { id: 'terrain', label: 'Arazi', rank: 1, stratum: 'ground' },
  { id: 'water', label: 'Su / deniz', rank: 1, stratum: 'ground' },
  // 2 — rail: İZBAN / metro (6.5 m catenary envelope), tram (6 m)
  {
    id: 'rail',
    label: 'Demiryolu / banliyö / metro hattı',
    rank: 2,
    stratum: 'grade',
    clearance: 6.5,
    margin: 1,
  },
  { id: 'tram', label: 'Tramvay hattı', rank: 2, stratum: 'grade', clearance: 6, margin: 0.5 },
  { id: 'airfield', label: 'Pist / taksi yolu', rank: 2, stratum: 'grade', margin: 10 },
  // 3 — roads at grade
  { id: 'carriageway', label: 'Taşıt yolu', rank: 3, stratum: 'grade', clearance: 4.8 },
  // 4 — structures over the ground
  { id: 'bridge', label: 'Köprü / viyadük / üst geçit', rank: 4, stratum: 'above' },
  { id: 'pier', label: 'Köprü ayağı', rank: 4, stratum: 'grade' },
  { id: 'overhead', label: 'Enerji iletim hattı', rank: 4, stratum: 'above', clearance: 0 },
  { id: 'pylon', label: 'Yüksek gerilim direği', rank: 4, stratum: 'grade', margin: 2 },
  // 5 — under the ground
  { id: 'tunnel', label: 'Tünel / alt geçit', rank: 5, stratum: 'below' },
  { id: 'cutting', label: 'Yarma / rampa', rank: 5, stratum: 'grade' },
  { id: 'utility', label: 'Yeraltı hattı (altyapı)', rank: 5, stratum: 'below' },
  // 6 — buildings and grounds with a purpose
  { id: 'building', label: 'Bina', rank: 6, stratum: 'grade' },
  {
    id: 'elevated-building',
    label: 'Yükseltilmiş yapı (istasyon holü, köprü bina)',
    rank: 6,
    stratum: 'above',
  },
  { id: 'canopy', label: 'Sundurma / peron örtüsü', rank: 6, stratum: 'above' },
  {
    id: 'special-ground',
    label: 'Özel alan (havalimanı, liman, santral, askeri …)',
    rank: 6,
    stratum: 'grade',
  },
  // 7 — paths
  {
    id: 'path',
    label: 'Yaya / bisiklet yolu, merdiven',
    rank: 7,
    stratum: 'grade',
    clearance: 2.5,
  },
  // 8 — surfaces and open ground
  { id: 'street-surface', label: 'Kaldırım / refüj / döşeme', rank: 8, stratum: 'grade' },
  { id: 'hard-ground', label: 'Sert zemin (avlu, otopark, saha …)', rank: 8, stratum: 'grade' },
  { id: 'green', label: 'Park / yeşil alan / orman', rank: 8, stratum: 'grade' },
  // 9 — paint
  { id: 'marking', label: 'Yol çizgisi / yaya geçidi', rank: 9, stratum: 'paint' },
  // 10 — furniture
  { id: 'fence', label: 'Duvar / çit', rank: 10, stratum: 'grade' },
  {
    id: 'furniture',
    label: 'Kent donatısı (direk, lamba, durak, kabin …)',
    rank: 10,
    stratum: 'grade',
  },
  { id: 'tree', label: 'Ağaç', rank: 10, stratum: 'grade' },
  // 11 — generated, not in the data
  { id: 'synthetic', label: 'Sentetik (üretilmiş) nesne', rank: 11, stratum: 'grade' },
] as const satisfies readonly (Omit<CityClass, 'id'> & { id: string })[];

export type CityClassId = (typeof CLASSES)[number]['id'];

export const CITY_CLASSES: Readonly<Record<CityClassId, CityClass>> = Object.fromEntries(
  CLASSES.map((c) => [c.id, c as CityClass]),
) as Record<CityClassId, CityClass>;

/** Whether `a` gives way to `b` (a higher rank yields; ties: neither). */
export function yieldsTo(a: CityClassId, b: CityClassId): boolean {
  return CITY_CLASSES[a].rank > CITY_CLASSES[b].rank;
}
