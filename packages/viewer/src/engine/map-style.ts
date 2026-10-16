/**
 * The map look's style (D-013): colours, label rules and the distances
 * things show from, apart from the compiled tiles — the same city drawn as
 * another map without compiling it again. Plain JSON, so a style can be
 * stored, sent and chosen in the UI.
 */

/** Where a rank's labels show: within `distance` (m) of the camera, where a pixel covers at most `mpp` m. */
export interface LabelRange {
  distance: number;
  mpp: number;
}

export interface MapStyle {
  id: string;
  label: string;
  streets: {
    /** CSS font (size in px of the drawn text; shown at `letterPx`). */
    font: string;
    color: string;
    halo: string;
    /** Text line height on screen (px). */
    letterPx: number;
    /** By street rank (6 motorway … 1 service). */
    ranges: Record<string, LabelRange>;
  };
  pois: {
    /** By kind (contract POI_KINDS): the icon disc's colour and the rank it keeps its place by. */
    categories: Record<string, { colour: string; rank: number }>;
    /** By rank (5 … 1). */
    ranges: Record<string, LabelRange>;
    /** Names show beside the icons where a pixel covers at most this many metres. */
    nameMpp: number;
    /** Icon disc diameter and name font size (screen px). */
    discPx: number;
    fontPx: number;
  };
}

const FOOD = '#e8833a';
const SHOP = '#3f86d4';
const HEALTH = '#e0474c';
const LEARN = '#9a7254';
const CULTURE = '#8e63c9';
const MONEY = '#2c9a8c';
const PUBLIC = '#5865b8';
const TRANSPORT = '#3a78b6';

export const DEFAULT_MAP_STYLE: MapStyle = {
  id: 'day',
  label: 'Gündüz',
  streets: {
    font: '600 64px Inter, system-ui, sans-serif',
    color: '#30343b',
    halo: 'rgba(255,255,255,0.92)',
    letterPx: 17,
    ranges: {
      6: { distance: 7000, mpp: 4 },
      5: { distance: 6000, mpp: 3.5 },
      4: { distance: 4000, mpp: 2.4 },
      3: { distance: 2500, mpp: 1.5 },
      2: { distance: 1500, mpp: 0.9 },
      1: { distance: 900, mpp: 0.6 },
    },
  },
  pois: {
    categories: {
      restaurant: { colour: FOOD, rank: 2 },
      fast_food: { colour: FOOD, rank: 2 },
      cafe: { colour: FOOD, rank: 2 },
      bar: { colour: FOOD, rank: 2 },
      bakery: { colour: FOOD, rank: 2 },
      supermarket: { colour: SHOP, rank: 3 },
      mall: { colour: SHOP, rank: 4 },
      shop: { colour: SHOP, rank: 1 },
      pharmacy: { colour: HEALTH, rank: 3 },
      hospital: { colour: HEALTH, rank: 5 },
      clinic: { colour: HEALTH, rank: 2 },
      school: { colour: LEARN, rank: 4 },
      university: { colour: LEARN, rank: 5 },
      kindergarten: { colour: LEARN, rank: 2 },
      library: { colour: LEARN, rank: 3 },
      place_of_worship: { colour: '#6b7681', rank: 4 },
      museum: { colour: CULTURE, rank: 5 },
      culture: { colour: CULTURE, rank: 3 },
      hotel: { colour: '#cf4f93', rank: 4 },
      attraction: { colour: CULTURE, rank: 5 },
      bank: { colour: MONEY, rank: 3 },
      atm: { colour: MONEY, rank: 2 },
      post_office: { colour: PUBLIC, rank: 3 },
      police: { colour: PUBLIC, rank: 4 },
      fire_station: { colour: PUBLIC, rank: 4 },
      public_office: { colour: PUBLIC, rank: 4 },
      bus_station: { colour: TRANSPORT, rank: 5 },
      parking: { colour: TRANSPORT, rank: 2 },
    },
    ranges: {
      5: { distance: 3500, mpp: 2.2 },
      4: { distance: 2200, mpp: 1.3 },
      3: { distance: 1400, mpp: 0.8 },
      2: { distance: 900, mpp: 0.55 },
      1: { distance: 600, mpp: 0.4 },
    },
    nameMpp: 0.5,
    discPx: 22,
    fontPx: 12,
  },
};

/** A rank's range, else the lowest rank's (a rank the style does not list). */
export function rangeOf(ranges: Record<string, LabelRange>, rank: number): LabelRange {
  return ranges[rank] ?? ranges[Math.min(...Object.keys(ranges).map(Number))];
}
