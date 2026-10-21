import type { Rng } from './random';
import type { StyleChoice } from './styles';
import type { BuildingForm, BuildingPalette, WallFinish } from './types';

/**
 * Building forms other than a block of flats / offices, from the source's
 * building type: the compiler gives them their height, palette and roof, the
 * renderer their shape (domes and minarets, bell towers, raked stands …).
 * OSM `building=` values, plus `man_made` silos and tanks.
 */
const FORM_OF: Record<string, BuildingForm> = {
  stadium: 'stands',
  grandstand: 'stands',
  industrial: 'shed',
  factory: 'shed',
  manufacture: 'shed',
  warehouse: 'shed',
  hangar: 'shed',
  sports_hall: 'shed',
  storage: 'shed',
  mosque: 'mosque',
  church: 'church',
  cathedral: 'church',
  chapel: 'church',
  silo: 'silo',
  storage_tank: 'tank',
  parking: 'carpark',
  shed: 'hut',
  hut: 'hut',
  cabin: 'hut',
  kiosk: 'hut',
  toilets: 'hut',
  service: 'hut',
  container: 'hut',
  garage: 'hut',
  roof: 'canopy',
  carport: 'canopy',
  greenhouse: 'greenhouse',
  minaret: 'minaret',
  communication_tower: 'telecom',
  clock_tower: 'clock',
  tower: 'tower',
  // An airport terminal: a long low box, glazed front, entrance hall and sign.
  terminal: 'box',
  // A station building: a hall of two tall storeys, not a block of flats.
  train_station: 'box',
  transportation: 'box',
};

/** Below this footprint (m²) a building without levels in the data is a hut, not a house. */
const HUT_AREA = 20;

/** Retail floor (m²) from which a shop building is a box (mall, hypermarket), not a block. */
const BOX_AREA = 2500;

/** Towers by `tower:type` (man_made=tower). */
const TOWER_FORM: Record<string, BuildingForm> = {
  minaret: 'minaret',
  communication: 'telecom',
  clock_tower: 'clock',
};

/**
 * A building wholly under the ground: a layer below 0 and no storey above it
 * (a metro station's concourse, an underground car park). It is not drawn on
 * the surface, nor cut by the streets over it.
 */
export function undergroundBuilding(tags: Record<string, string>): boolean {
  const layer = Number.parseInt(tags.layer ?? '', 10);
  const levels = Number.parseFloat(tags['building:levels'] ?? '');
  return layer <= -1 && !(levels > 0);
}

export function formOf(tags: Record<string, string>, area: number): BuildingForm {
  const b = tags.building ?? '';
  if (tags.man_made === 'tower') return TOWER_FORM[tags['tower:type'] ?? ''] ?? 'tower';
  // A transformer kiosk is a blank box with steel doors; a large substation
  // building an industrial hall.
  if (b === 'substation' || tags.power === 'substation') return area < 150 ? 'hut' : 'shed';
  const form = FORM_OF[b] ?? FORM_OF[tags.man_made ?? ''];
  if (form) return form;
  // A few square metres with no storeys in the data: a shed, a booth, a stair
  // or lift housing — not a one-room house with a balcony.
  if (
    area < HUT_AREA &&
    !tags['building:levels'] &&
    !tags.height &&
    ['yes', '', 'residential', 'house'].includes(b)
  )
    return 'hut';
  if (tags.amenity === 'place_of_worship' && (tags.religion ?? 'muslim') === 'muslim')
    return 'mosque';
  // A mall / hypermarket, not an office or hotel tower (`commercial`): low and
  // wide — a mall said so (shop=mall) at any height (City Hub AVM, 8.5 storeys).
  const levels = Number.parseInt(tags['building:levels'] ?? '', 10);
  if (
    (['retail', 'supermarket'].includes(b) ||
      tags.shop === 'mall' ||
      tags.shop === 'supermarket') &&
    area >= BOX_AREA &&
    (!(levels > 4) || tags.shop === 'mall')
  )
    return 'box';
  return 'block';
}

/** Storeys and storey height of a form, when the source has neither levels nor height. */
export function formLevels(
  form: BuildingForm,
  area: number,
  rng: Rng,
): { levels: number; floorHeight: number } | null {
  const diameter = 2 * Math.sqrt(area / Math.PI);
  switch (form) {
    case 'stands':
      return {
        levels: area > 20000 ? 7 : area > 5000 ? 5 : area > 1200 ? 3 : 2,
        floorHeight: 3.2,
      };
    case 'shed':
      return { levels: area > 4000 ? 2 : 1, floorHeight: rng.range(5.5, 7.5) };
    case 'mosque':
      return { levels: 2, floorHeight: area > 600 ? 5.5 : area > 200 ? 4.5 : 3.6 };
    case 'church':
      return { levels: 3, floorHeight: 4.2 };
    case 'silo':
      return { levels: rng.int(9, 12), floorHeight: 3.5 };
    case 'tank':
      return { levels: Math.max(2, Math.round(Math.min(18, diameter * 0.55) / 3)), floorHeight: 3 };
    case 'carpark':
      return { levels: area > 3000 ? 5 : 4, floorHeight: 3 };
    case 'box':
      return { levels: 2, floorHeight: 5 };
    case 'hut':
      return { levels: 1, floorHeight: rng.range(2.4, 2.9) };
    case 'canopy':
      return { levels: 1, floorHeight: area > 150 ? 5 : 3.2 };
    case 'greenhouse':
      return { levels: 1, floorHeight: 3 };
    // Towers are one tall storey (the renderer draws their shaft and top);
    // a transmitter's body is its low base, the mast goes on top of it.
    case 'minaret':
      return { levels: 1, floorHeight: 28 };
    case 'clock':
      return { levels: 1, floorHeight: 24 };
    case 'tower':
      // Slender: about four times its width (a 6 m lift tower ≈ 24 m).
      return { levels: 1, floorHeight: Math.min(40, Math.max(12, 4 * Math.sqrt(area))) };
    case 'telecom':
      return { levels: 2, floorHeight: 3.2 };
    default:
      return null;
  }
}

const pal = (wall: string, roof: string, extra: Partial<BuildingPalette> = {}) => ({
  wall,
  roof,
  band: wall,
  trim: '#d8d6d0',
  base: '#8f8c85',
  ...extra,
});

/**
 * Style of a form over the archetype's: palette, finish, roof. `tags` colours
 * (`building:colour`, `roof:colour`) still win.
 */
export function formStyle(
  form: BuildingForm,
  style: StyleChoice,
  tags: Record<string, string>,
  rectangularity: number,
  rng: Rng,
): StyleChoice {
  if (form === 'block') return style;
  const palettes: Record<Exclude<BuildingForm, 'block'>, Partial<BuildingPalette>[]> = {
    stands: [pal('#b9b6ae', '#9b9890', { band: '#a9a69e', trim: '#cfccc5' })],
    // Corrugated metal sheds: light grey, off-white, the odd blue or green.
    shed: [
      pal('#c9cdd0', '#9aa3aa'),
      pal('#dcdcd6', '#8d97a0'),
      pal('#a9b8c6', '#7d8e9e'),
      pal('#b7c2b3', '#8a978a'),
      pal('#d6cfc2', '#a0a4a8'),
    ],
    mosque: [pal('#e8e3d8', '#7c8287'), pal('#d9d1c2', '#737a80'), pal('#efece6', '#7f868c')],
    church: [pal('#d8cfbf', '#a24e33'), pal('#c9bba4', '#8f4a35')],
    silo: [pal('#cfcac0', '#b8b3a8'), pal('#bdb8ad', '#a9a49a')],
    tank: [pal('#e9eaeb', '#d6d8da'), pal('#dcdfe2', '#c9ccce')],
    carpark: [pal('#b5b3ad', '#8e8c86')],
    box: [pal('#d9d6cf', '#a6a8aa'), pal('#c7ccd1', '#9ea3a8'), pal('#e3ddd2', '#a8a59e')],
    // Whitewash, unpainted block, tin and the odd blue-painted shed.
    hut: [
      pal('#e8e4da', '#8f9397'),
      pal('#c9c3b6', '#8a8d90'),
      pal('#d8cdb6', '#9a5a3c'),
      pal('#9fb3c4', '#7f8a92'),
      pal('#bfc3c6', '#8e9499'),
    ],
    canopy: [pal('#d6d8da', '#c9cdd1'), pal('#e9e9e6', '#b8bcc0')],
    greenhouse: [pal('#dfeae6', '#d2e2dd')],
    minaret: [pal('#efece6', '#7a8086'), pal('#e6e1d6', '#737a80')],
    telecom: [pal('#d9dbdd', '#a7abaf')],
    clock: [pal('#d8c7a4', '#7a8086'), pal('#cdbb98', '#6f777d')],
    tower: [pal('#c9bba0', '#8f8676'), pal('#b9ad97', '#857c6e')],
  };
  const finish: WallFinish[] =
    form === 'shed' || form === 'box' || form === 'tank' || form === 'greenhouse'
      ? ['cladding-panel']
      : ['church', 'mosque', 'minaret', 'clock', 'tower'].includes(form)
        ? ['stone']
        : ['plaster'];
  const picked = rng.pick(palettes[form]);
  const palette: BuildingPalette = {
    ...style.palette,
    ...picked,
    ...(tags['building:colour'] ? { wall: style.palette.wall } : {}),
    ...(tags['roof:colour'] ? { roof: style.palette.roof } : {}),
  };
  // Sheds: a low-pitched metal ridge roof on a near-rectangle; churches a steep tiled one.
  const roofShape =
    tags['roof:shape'] && style.roofShape !== 'flat'
      ? style.roofShape
      : (form === 'shed' || form === 'greenhouse' || form === 'hut') && rectangularity > 0.85
        ? 'gable'
        : form === 'church' && rectangularity > 0.75
          ? 'gable'
          : 'flat';
  return {
    ...style,
    palette,
    finishes: finish,
    roofShape,
    pitchDeg:
      roofShape === 'gable'
        ? form === 'church'
          ? 38
          : form === 'greenhouse'
            ? 24
            : form === 'hut'
              ? 16
              : 9
        : 0,
  };
}

/** Forms whose walls carry no windows (the renderer draws their own features). */
export const BLANK_FORMS: ReadonlySet<BuildingForm> = new Set([
  'stands',
  'shed',
  'silo',
  'tank',
  'box',
  'canopy',
  'greenhouse',
  'minaret',
  'telecom',
  'clock',
  'tower',
]);

type PublicKind = 'school' | 'hospital' | 'government';

function publicKind(tags: Record<string, string>): PublicKind | null {
  const b = tags.building ?? '';
  const a = tags.amenity ?? '';
  if (['school', 'kindergarten', 'college', 'university'].includes(b)) return 'school';
  if (['school', 'kindergarten', 'college', 'university'].includes(a)) return 'school';
  if (b === 'hospital' || ['hospital', 'clinic'].includes(a)) return 'hospital';
  if (
    ['public', 'government', 'civic', 'fire_station'].includes(b) ||
    ['townhall', 'courthouse', 'police', 'fire_station'].includes(a) ||
    tags.office === 'government'
  )
    return 'government';
  return null;
}

/**
 * Public buildings read as such, not as blocks of flats: a ground floor in
 * another colour (stone / brick / painted plinth storey), calm walls above,
 * taller storeys. Schools in the warm ochres and creams of Turkish school
 * buildings over a brick-red or grey ground floor; hospitals white over
 * blue-grey; government buildings stone. `building:colour` still wins.
 */
export function publicStyle(
  tags: Record<string, string>,
  style: StyleChoice,
  form: BuildingForm,
  rng: Rng,
): StyleChoice {
  const kind = form === 'block' ? publicKind(tags) : null;
  if (!kind) return style;
  const palettes: Record<PublicKind, [string, string][]> = {
    school: [
      ['#ead9b0', '#a4573a'],
      ['#f0e2c2', '#8f8a82'],
      ['#e7c98f', '#a4573a'],
      ['#efe7d6', '#b0623f'],
      ['#e9d1a7', '#7f7a73'],
    ],
    hospital: [
      ['#eef0ef', '#7f93a6'],
      ['#e9edf0', '#9aa6b0'],
      ['#f1efe9', '#6f8a9d'],
    ],
    government: [
      ['#ddd4c4', '#a59a88'],
      ['#e6dfd2', '#8e8678'],
      ['#d3cbbd', '#9c9282'],
    ],
  };
  const [wall, ground] = rng.pick(palettes[kind]);
  return {
    ...style,
    palette: {
      ...style.palette,
      wall: tags['building:colour'] ? style.palette.wall : wall,
      band: ground,
      trim: '#f2efe8',
      frame: kind === 'hospital' ? '#dfe5ea' : '#f4f2ec',
    },
    finishes: ['plaster'],
    floorHeight: kind === 'hospital' ? 3.7 : 3.5,
    rail: 'metal',
  };
}
