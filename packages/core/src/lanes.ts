import type { Lane, LaneTurn, Provenance } from './types';

/** Width (m) of a cycle lane and of a kerbside parking lane laid by rule. */
export const CYCLE_LANE = 1.5;
export const PARKING_LANE = 2.3;

/**
 * Cycle and parking lanes beside the traffic lanes, per side (left / right of
 * the drawing direction), from `cycleway` / `parking:<side>` tags.
 */
export function sideLanes(
  tags: Record<string, string>,
  oneway: boolean,
): { cycle: [boolean, boolean]; parking: [boolean, boolean] } {
  const cyc = (side: string) => {
    const v = tags[`cycleway:${side}`] ?? tags['cycleway:both'] ?? tags.cycleway;
    return v === 'lane' || v === 'opposite_lane';
  };
  const park = (side: string) => {
    const v = tags[`parking:${side}`] ?? tags['parking:both'];
    return v === 'lane' || v === 'parallel' || v === 'yes';
  };
  // A one-way road's lane (cycleway=lane) runs on its right; both sides otherwise.
  const both = tags.cycleway === 'lane' && !tags['cycleway:left'] && !tags['cycleway:right'];
  return {
    cycle: [both ? !oneway : cyc('left'), both ? true : cyc('right')],
    parking: [park('left'), park('right')],
  };
}

/**
 * A road's cross-section as lanes (D-012), left to right looking along the
 * centreline's drawing direction. Traffic keeps right: lanes against the
 * drawing direction lie left of the centreline, lanes along it right. Each
 * direction's lanes are listed (and their `turn:lanes` read) from the centre
 * outwards, which is left to right for the driver in that direction.
 *
 * From the source when it says (`lanes:forward` / `:backward`,
 * `turn:lanes[:forward|:backward]`, `width:lanes`), else by rule: an
 * odd lane count gives the extra lane to the drawing direction; equal widths;
 * no turns (junction rules add them, F2.3).
 */
export function laneLayout(
  road: { lanes: number; width: number; oneway: boolean },
  tags: Record<string, string>,
  /** Cycle / parking lanes outside the traffic lanes (left, right); `width` covers them. */
  side: { cycle: [boolean, boolean]; parking: [boolean, boolean] } = {
    cycle: [false, false],
    parking: [false, false],
  },
): Lane[] {
  const total = Math.max(1, road.lanes);
  const int = (v?: string) => {
    const n = Number.parseInt(v ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  let forward = total;
  let backward = 0;
  let split: Provenance = 'inferred';
  if (!road.oneway) {
    const f = int(tags['lanes:forward']);
    const b = int(tags['lanes:backward']);
    if (f !== undefined && b !== undefined && f + b === total) {
      [forward, backward, split] = [f, b, 'observed'];
    } else if (f !== undefined && f <= total) {
      [forward, backward, split] = [f, total - f, 'observed'];
    } else if (b !== undefined && b <= total) {
      [forward, backward, split] = [total - b, b, 'observed'];
    } else {
      backward = Math.floor(total / 2);
      forward = total - backward;
    }
  } else split = 'observed';

  const extra = (k: 0 | 1) =>
    (side.cycle[k] ? CYCLE_LANE : 0) + (side.parking[k] ? PARKING_LANE : 0);
  const driveWidth = road.width - extra(0) - extra(1);
  // Widths: `width:lanes` left to right across the road when it has one per
  // lane and they add up to about the carriageway; else equal shares.
  const listed = (tags['width:lanes'] ?? '')
    .split('|')
    .map((w) => Number.parseFloat(w.replace(',', '.')));
  const widths =
    listed.length === total &&
    listed.every((w) => w > 1.5 && w < 6) &&
    Math.abs(listed.reduce((s, w) => s + w, 0) - driveWidth) < 1
      ? listed
      : new Array<number>(total).fill(driveWidth / total);

  const turnsOf = (v: string | undefined, n: number): LaneTurn[][] | null => {
    if (!v) return null;
    const lanes = v.split('|');
    if (lanes.length !== n) return null;
    return lanes.map((l) =>
      l
        .split(';')
        .map((t) => t.trim())
        .filter((t): t is LaneTurn => TURNS.has(t as LaneTurn)),
    );
  };
  const fwdTurns = turnsOf(road.oneway ? tags['turn:lanes'] : tags['turn:lanes:forward'], forward);
  const bwdTurns = turnsOf(tags['turn:lanes:backward'], backward);

  // Left to right across the road: parking and cycle lanes on the left, the
  // backward lanes (outermost first), the forward lanes, cycle and parking
  // lanes on the right.
  const out: Lane[] = [];
  let x = road.width / 2;
  const sideLane = (kind: 'cycle' | 'parking', width: number, forward: boolean) => {
    out.push({ offset: x - width / 2, width, kind, forward, turns: [], provenance: 'observed' });
    x -= width;
  };
  const leftForward = road.oneway;
  if (side.parking[0]) sideLane('parking', PARKING_LANE, leftForward);
  if (side.cycle[0]) sideLane('cycle', CYCLE_LANE, leftForward);
  for (let k = 0; k < total; k++) {
    const w = widths[k];
    const isBackward = k < backward;
    // Index from the centre outwards within its direction.
    const fromCentre = isBackward ? backward - 1 - k : k - backward;
    const turns = (isBackward ? bwdTurns : fwdTurns)?.[fromCentre] ?? [];
    out.push({
      offset: x - w / 2,
      width: w,
      kind: 'drive',
      forward: !isBackward,
      turns,
      provenance: turns.length || split === 'observed' ? 'observed' : 'inferred',
    });
    x -= w;
  }
  if (side.cycle[1]) sideLane('cycle', CYCLE_LANE, true);
  if (side.parking[1]) sideLane('parking', PARKING_LANE, true);
  return out;
}

const TURNS: ReadonlySet<LaneTurn> = new Set<LaneTurn>([
  'left',
  'slight_left',
  'sharp_left',
  'through',
  'slight_right',
  'right',
  'sharp_right',
  'reverse',
  'merge_to_left',
  'merge_to_right',
]);
