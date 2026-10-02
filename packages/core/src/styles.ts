import type { Rng } from './random';
import type { Archetype, BuildingPalette, RailKind, RoofShape, WallFinish } from './types';

/**
 * Anatolian building families. Palettes are sampled from the reference renders
 * in `soul_of_anatolia/` (2026-10-02): dusty, weathered plaster — salmon-beige,
 * grey-blue, greige, cream, faded mustard, brick red — with antrasit, wood-look
 * and salmon cladding bands, muted terracotta hip roofs, white PVC or brown
 * joinery. Saturation stays low (≈0.05–0.35): Anatolian paint fades.
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

const TERRACOTTA = ['#a0644e', '#a86e58', '#93604c', '#a3765f', '#8a5e4e', '#ad7a63'];

export const ARCHETYPES: Record<Archetype, ArchetypeSpec> = {
  mustakil: {
    walls: ['#ddd0b4', '#e0d2a4', '#c8c08a', '#a65a50', '#c3bbb0', '#c49a8a', '#d6cfc0'],
    bands: ['#8a4f3f', '#6b4a3a', '#e3d8c0', '#a65a50'],
    trims: ['#ece6da', '#a85d47', '#d8d0c0'],
    roofs: TERRACOTTA,
    bases: ['#5d5a55', '#6e675e', '#4f4c48', '#7a7266'],
    frames: ['#eeece6', '#5a3e2e', '#8a5a3a'],
    glass: ['#2d3a40', '#34444c'],
    floorHeight: [2.8, 3.0],
    window: { w: [1.1, 1.4], h: [1.2, 1.4] },
    bay: [2.6, 3.4],
    rails: [['metal', 1]],
    glazedBalcony: 0.1,
    hipRoof: 0.95,
    finishes: [
      ['plaster', 'stone'],
      ['plaster', 'plaster'],
    ],
  },
  eski: {
    walls: ['#c7baaa', '#a9a39a', '#9e6a5e', '#8d9aa6', '#baa27e', '#d8d0c2', '#b5ada2'],
    bands: ['#8e8479', '#7d5a4b', '#6f7f8f', '#a08c70'],
    trims: ['#e6e0d4', '#d2cabd'],
    roofs: TERRACOTTA,
    bases: ['#b09a78', '#7a7466', '#8a8172'],
    frames: ['#e8e5de', '#cfcac0', '#5f4a3a', '#6e5a48'],
    glass: ['#2c373d', '#3a474d'],
    floorHeight: [2.9, 3.1],
    window: { w: [1.0, 1.3], h: [1.3, 1.5] },
    bay: [2.8, 3.6],
    rails: [
      ['metal', 0.7],
      ['solid', 0.3],
    ],
    glazedBalcony: 0.35,
    hipRoof: 0.85,
    finishes: [
      ['plaster', 'plaster'],
      ['plaster', 'brick'],
    ],
  },
  klasik: {
    walls: ['#c0a093', '#ddd2b8', '#cfccc6', '#6d819a', '#c9a967', '#bfc2c4', '#b9978a', '#d5cbb6'],
    bands: ['#a8786a', '#3c3e40', '#4a5d78', '#8a4f3f', '#b8783f', '#e3dccd'],
    trims: ['#ece8e0', '#e2ddd2'],
    roofs: TERRACOTTA,
    bases: ['#6e6a64', '#5a5c5e', '#8a857c'],
    frames: ['#efede8', '#e6e3dc', '#6a4a32', '#8a5a36'],
    glass: ['#29353b', '#324048'],
    floorHeight: [2.85, 3.0],
    window: { w: [1.2, 1.5], h: [1.35, 1.5] },
    bay: [2.7, 3.3],
    rails: [
      ['solid', 0.6],
      ['metal', 0.4],
    ],
    glazedBalcony: 0.6,
    hipRoof: 0.9,
    finishes: [
      ['plaster', 'plaster'],
      ['plaster', 'cladding-panel'],
    ],
  },
  modern: {
    walls: ['#e3d6bc', '#d5c7a8', '#ecebe6', '#a7a19a', '#8d8984', '#ddd8cf'],
    bands: ['#b8733f', '#c27a42', '#6b4f40', '#5a5d62', '#c96a35', '#9a6a4a'],
    trims: ['#6b4f40', '#5a5d62', '#e9e6df'],
    roofs: ['#5a4034', '#4f4a46', '#6b4a36', '#a8644a'],
    bases: ['#dcd7cf', '#9aa0a6', '#4f5358', '#c9c4bb'],
    frames: ['#3b3f44', '#5a5d62', '#e9e6df'],
    glass: ['#3c5560', '#2f4550', '#4a6570'],
    floorHeight: [3.0, 3.1],
    window: { w: [1.3, 1.7], h: [1.45, 1.6] },
    bay: [2.9, 3.5],
    rails: [
      ['glass', 0.8],
      ['metal', 0.2],
    ],
    glazedBalcony: 0.35,
    hipRoof: 0.25,
    finishes: [
      ['plaster', 'cladding-wood'],
      ['plaster', 'cladding-panel'],
      ['cladding-panel', 'cladding-wood'],
    ],
  },
  yuksek: {
    walls: ['#d9cdb2', '#cfd4d8', '#c4a27a', '#b98a5e', '#e2ddd2'],
    bands: ['#8b5a3c', '#5a5d62', '#3e5566', '#b8733f'],
    trims: ['#3b3f44', '#e9e6df', '#8b5a3c'],
    roofs: ['#4f4a46', '#5a5d62'],
    bases: ['#4f5358', '#9aa0a6', '#6b6e70'],
    frames: ['#2f3338', '#5a5d62', '#e9e6df'],
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

/**
 * Building family. `dt:archetype` forces one (style gallery, hand-set
 * landmarks); otherwise it follows the building type and floor count.
 */
/** Rise of a barrel (arched) roof above the wall top, for a plan half-width in metres. */
export function barrelRise(halfWidth: number): number {
  return Math.min(3.5, halfWidth * 0.45);
}

export function pickArchetype(levels: number, tags: Record<string, string>, rng: Rng): Archetype {
  const forced = tags['dt:archetype'];
  if (forced && forced in ARCHETYPES) return forced as Archetype;
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
  // 2010s blocks: arched roof over the top floor on regular, not too deep plans.
  if (
    roofShape === 'flat' &&
    !shapeTag &&
    archetype === 'modern' &&
    rectangularity > 0.85 &&
    depth <= 18 &&
    rng.chance(0.35)
  )
    roofShape = 'barrel';

  return {
    style: {
      palette,
      finishes: rng.pick(spec.finishes),
      roofShape,
      pitchDeg: roofShape === 'flat' || roofShape === 'barrel' ? 0 : rng.range(20, 28),
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
