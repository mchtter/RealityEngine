import type { Rng } from './random';
import type { Archetype, BuildingPalette, RailKind, RoofShape, WallFinish } from './types';

/**
 * Anatolian building families. Palettes are taken from typical Turkish town
 * fabric: plastered apartments in cream / salmon / sky blue / ochre, terracotta
 * hip roofs, 2010s blocks with wood-look and composite-panel cladding bands.
 */
interface ArchetypeSpec {
  walls: string[];
  bands: string[];
  trims: string[];
  roofs: string[];
  bases: string[];
  frames: string[];
  glass: string[];
  floorHeight: [number, number];
  window: { w: [number, number]; h: [number, number] };
  bay: [number, number];
  rails: readonly (readonly [RailKind, number])[];
  glazedBalcony: number;
  hipRoof: number;
  finishes: WallFinish[][];
}

const TERRACOTTA = ['#a4502f', '#b0603a', '#9a4a30', '#b86a44', '#8f4a36'];

export const ARCHETYPES: Record<Archetype, ArchetypeSpec> = {
  mustakil: {
    walls: ['#e6d9b0', '#d8cf8e', '#a9504a', '#e8e1cf', '#c9b48a', '#b9c4c9'],
    bands: ['#8b3b33', '#7d6a4f', '#c9b48a'],
    trims: ['#f1ece0', '#b8563f', '#d9d2c3'],
    roofs: TERRACOTTA,
    bases: ['#5d5a55', '#6b655c', '#4f4c48'],
    frames: ['#f4f2ec', '#6b4a33', '#8a5a3a'],
    glass: ['#2d3a40', '#34444c'],
    floorHeight: [2.8, 3.0],
    window: { w: [1.1, 1.4], h: [1.2, 1.4] },
    bay: [2.6, 3.4],
    rails: [['metal', 1]],
    glazedBalcony: 0.05,
    hipRoof: 0.95,
    finishes: [
      ['plaster', 'stone'],
      ['plaster', 'plaster'],
    ],
  },
  eski: {
    walls: ['#cfc9bf', '#b9a79a', '#c47f6d', '#9fb3c4', '#d8d0c0', '#a8a39a'],
    bands: ['#8e8479', '#a45b4b', '#6f7f8f'],
    trims: ['#ece7dc', '#d8d1c4'],
    roofs: TERRACOTTA,
    bases: ['#8a7f6d', '#7a7466'],
    frames: ['#f0eee8', '#d8d4ca', '#5f4a3a'],
    glass: ['#2c373d', '#3a474d'],
    floorHeight: [2.9, 3.1],
    window: { w: [1.0, 1.3], h: [1.3, 1.5] },
    bay: [2.8, 3.6],
    rails: [
      ['metal', 0.7],
      ['solid', 0.3],
    ],
    glazedBalcony: 0.15,
    hipRoof: 0.85,
    finishes: [
      ['plaster', 'plaster'],
      ['plaster', 'brick'],
    ],
  },
  klasik: {
    walls: ['#c99582', '#e3d7bf', '#8fa6c4', '#d9a441', '#d6c6a8', '#c7b299', '#b7c3cf'],
    bands: ['#b0735e', '#39414a', '#e8ddc8', '#c9794a', '#5f6f86'],
    trims: ['#f2eee6', '#e5ddd0'],
    roofs: TERRACOTTA,
    bases: ['#7c7a76', '#8f877b', '#6e6a64'],
    frames: ['#f5f4f0', '#e9e6df'],
    glass: ['#29353b', '#324048'],
    floorHeight: [2.85, 3.0],
    window: { w: [1.2, 1.5], h: [1.35, 1.5] },
    bay: [2.7, 3.3],
    rails: [
      ['solid', 0.6],
      ['metal', 0.4],
    ],
    glazedBalcony: 0.35,
    hipRoof: 0.9,
    finishes: [
      ['plaster', 'plaster'],
      ['plaster', 'cladding-panel'],
    ],
  },
  modern: {
    walls: ['#ece8df', '#d9cdb2', '#f3f1ec', '#b9b4ab', '#e2dccf'],
    bands: ['#b8743f', '#d9773a', '#6b4a36', '#5a5d62', '#8b5a3c', '#c98a4b'],
    trims: ['#5a5d62', '#6b4a36', '#e9e6df'],
    roofs: ['#5a4034', '#4f4a46', '#6b4a36', '#a4502f'],
    bases: ['#d9d6cf', '#9aa0a6', '#4f5358'],
    frames: ['#3b3f44', '#5a5d62', '#e9e6df'],
    glass: ['#3c5560', '#2f4550', '#4a6570'],
    floorHeight: [3.0, 3.1],
    window: { w: [1.3, 1.7], h: [1.45, 1.6] },
    bay: [2.9, 3.5],
    rails: [
      ['glass', 0.8],
      ['metal', 0.2],
    ],
    glazedBalcony: 0.25,
    hipRoof: 0.25,
    finishes: [
      ['plaster', 'cladding-wood'],
      ['plaster', 'cladding-panel'],
      ['cladding-panel', 'cladding-wood'],
    ],
  },
  yuksek: {
    walls: ['#e9e6df', '#cfd4d8', '#d9cdb2'],
    bands: ['#5a5d62', '#8b5a3c', '#3e5566'],
    trims: ['#3b3f44', '#e9e6df'],
    roofs: ['#4f4a46', '#5a5d62'],
    bases: ['#4f5358', '#9aa0a6'],
    frames: ['#2f3338', '#5a5d62'],
    glass: ['#3c5560', '#2f4550'],
    floorHeight: [3.1, 3.2],
    window: { w: [1.5, 1.9], h: [1.6, 1.8] },
    bay: [3.0, 3.6],
    rails: [['glass', 1]],
    glazedBalcony: 0.2,
    hipRoof: 0,
    finishes: [['plaster', 'cladding-panel']],
  },
};

export function pickArchetype(levels: number, tags: Record<string, string>, rng: Rng): Archetype {
  const b = tags.building;
  if (['house', 'detached', 'bungalow', 'hut', 'farm', 'cabin', 'semidetached_house'].includes(b)) {
    return levels <= 2 ? 'mustakil' : 'eski';
  }
  if (
    ['school', 'university', 'hospital', 'public', 'government', 'office', 'commercial'].includes(b)
  ) {
    return levels >= 9 ? 'yuksek' : 'modern';
  }
  if (levels >= 9) return 'yuksek';
  if (levels <= 2)
    return rng.weighted([
      ['mustakil', 0.7],
      ['eski', 0.3],
    ] as const);
  if (levels <= 4)
    return rng.weighted([
      ['eski', 0.45],
      ['klasik', 0.35],
      ['modern', 0.2],
    ] as const);
  return rng.weighted([
    ['klasik', 0.55],
    ['modern', 0.45],
  ] as const);
}

/** Accepts OSM colour tags (named or #hex) and returns a hex colour or null. */
export function osmColour(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  const named: Record<string, string> = {
    white: '#efece6',
    beige: '#d9cdb2',
    cream: '#e6dcc4',
    yellow: '#d9b84a',
    orange: '#d9773a',
    red: '#a9504a',
    brown: '#6b4a36',
    grey: '#9a9a96',
    gray: '#9a9a96',
    blue: '#8fa6c4',
    pink: '#d6a39a',
    green: '#9fae84',
    black: '#3b3f44',
  };
  return named[v] ?? null;
}

export interface StyleChoice {
  palette: BuildingPalette;
  finishes: WallFinish[];
  roofShape: RoofShape;
  pitchDeg: number;
  rail: RailKind;
  windowWidth: number;
  windowHeight: number;
  floorHeight: number;
  bayWidth: number;
  glazedBalcony: number;
}

export function pickStyle(
  archetype: Archetype,
  tags: Record<string, string>,
  rectangularity: number,
  depth: number,
  rng: Rng,
): { style: StyleChoice; fromData: boolean } {
  const spec = ARCHETYPES[archetype];
  const wallTag = osmColour(tags['building:colour']);
  const roofTag = osmColour(tags['roof:colour']);
  const palette: BuildingPalette = {
    wall: wallTag ?? rng.pick(spec.walls),
    band: rng.pick(spec.bands),
    trim: rng.pick(spec.trims),
    roof: roofTag ?? rng.pick(spec.roofs),
    base: rng.pick(spec.bases),
    frame: rng.pick(spec.frames),
    glass: rng.pick(spec.glass),
  };
  const shapeTag = tags['roof:shape'];
  let roofShape: RoofShape;
  if (shapeTag === 'flat') roofShape = 'flat';
  else if (shapeTag === 'hipped' || shapeTag === 'pyramidal' || shapeTag === 'half-hipped')
    roofShape = 'hip';
  else if (shapeTag === 'gabled') roofShape = 'gable';
  else roofShape = rectangularity > 0.82 && rng.chance(spec.hipRoof) ? 'hip' : 'flat';
  // Irregular footprints get a flat roof: the renderer's hip roof needs a near-rectangle.
  if (roofShape !== 'flat' && rectangularity < 0.7) roofShape = 'flat';
  // Deep plans (> 20 m across) are never tiled in Anatolian towns; they carry flat roofs.
  if (roofShape !== 'flat' && !shapeTag && depth > 20) roofShape = 'flat';

  return {
    style: {
      palette,
      finishes: rng.pick(spec.finishes),
      roofShape,
      pitchDeg: roofShape === 'flat' ? 0 : rng.range(20, 28),
      rail: rng.weighted(spec.rails),
      windowWidth: rng.range(...spec.window.w),
      windowHeight: rng.range(...spec.window.h),
      floorHeight: rng.range(...spec.floorHeight),
      bayWidth: rng.range(...spec.bay),
      glazedBalcony: spec.glazedBalcony,
    },
    fromData: Boolean(wallTag || roofTag || shapeTag),
  };
}
