import type { SourceRoad } from './osm';
import { bufferPolyline } from './poly';
import { densify, offsetPolyline } from './roads';
import type { Marking, Polygon, RailLine, Vec2 } from './types';

/**
 * Lines with a width that are not roads, carried in the road theme (class
 * `rail` / `subway` / `tram` / `runway` / `taxiway`): they stay out of the
 * street network and are laid here instead.
 */
export const GUIDEWAY_CLASSES: ReadonlySet<string> = new Set([
  'rail',
  'subway',
  'tram',
  'runway',
  'taxiway',
]);

/** Paved width (m) of an airfield way without a width in the data. */
const AIRFIELD_WIDTH: Record<string, number> = { runway: 45, taxiway: 23 };
/** Tracks of a rail line without a count in the data. */
const TRACKS: Record<string, number> = { rail: 2, subway: 2, tram: 1 };
/** Track spacing, centre to centre (m). */
export const TRACK_SPACING = 4.2;

export interface Guideways {
  rails: RailLine[];
  /** Runway / taxiway asphalt. */
  airfield: Polygon[];
  /** Runway paint (white) and taxiway centrelines (yellow). */
  markings: Marking[];
  /** Ground the lines take (rail beds, airfield): no trees, no infill there. */
  footprint: Polygon[];
}

/** Arc length of a polyline. */
const lengthOf = (pts: Vec2[]) =>
  pts.reduce((s, p, k) => (k ? s + Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]) : s), 0);

/** The part of a polyline between arc lengths a and b. */
function slice(pts: Vec2[], a: number, b: number): Vec2[] {
  const out: Vec2[] = [];
  let walked = 0;
  for (let k = 1; k < pts.length; k++) {
    const p = pts[k - 1];
    const q = pts[k];
    const seg = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const at = (s: number): Vec2 => {
      const t = seg > 0 ? (s - walked) / seg : 0;
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    };
    if (walked + seg >= a && walked <= b) {
      if (!out.length) out.push(at(Math.max(a, walked)));
      out.push(at(Math.min(b, walked + seg)));
    }
    walked += seg;
  }
  return out;
}

/**
 * Runway paint along the runway's own centreline (ICAO): a dashed
 * centreline, side stripes, threshold bars ("piano keys") and touchdown-zone
 * bar pairs 150, 300 and 450 m in from each end.
 */
function runwayPaint(line: Vec2[], width: number): Marking[] {
  const out: Marking[] = [];
  const L = lengthOf(line);
  if (L < 600) return out;
  const W = width / 2;
  const pts = densify(line, 20);
  out.push({ kind: 'runway-center', points: slice(pts, 70, L - 70) });
  for (const v of [-(W - 1.5), W - 1.5])
    out.push({ kind: 'runway-edge', points: offsetPolyline(slice(pts, 6, L - 6), v) });
  const bars = Math.max(2, Math.floor((W - 3) / 3.6));
  for (const [a, b] of [
    [6, 36],
    [L - 6, L - 36],
  ] as const) {
    const piece = slice(pts, Math.min(a, b), Math.max(a, b));
    for (let k = 0; k < bars; k++) {
      const v = 4.8 + k * 3.6;
      if (v > W - 3) break;
      for (const s of [-1, 1])
        out.push({ kind: 'runway-bar', points: offsetPolyline(piece, s * v) });
    }
  }
  for (const d of [150, 300, 450]) {
    if (L / 2 - d < 100) break;
    for (const [a, b] of [
      [d, d + 22.5],
      [L - d - 22.5, L - d],
    ] as const) {
      const piece = slice(pts, a, b);
      for (const v of [-(W * 0.45), W * 0.45])
        out.push({ kind: 'runway-bar', points: offsetPolyline(piece, v) });
    }
  }
  return out;
}

/** Rail lines, runways and taxiways from the road-theme lines of those classes. */
export function layGuideways(sources: SourceRoad[]): Guideways {
  const rails: RailLine[] = [];
  const airfield: Polygon[] = [];
  const markings: Marking[] = [];
  const footprint: Polygon[] = [];
  for (const r of sources) {
    const cls = r.tags.highway ?? '';
    if (!GUIDEWAY_CLASSES.has(cls) || r.points.length < 2) continue;
    const tunnel = !!r.tags.tunnel && r.tags.tunnel !== 'no';
    const tagWidth = Number.parseFloat(r.tags.width ?? '');
    if (cls === 'runway' || cls === 'taxiway') {
      const width = Number.isFinite(tagWidth) && tagWidth > 5 ? tagWidth : AIRFIELD_WIDTH[cls];
      const paved = bufferPolyline(r.points, width / 2, false);
      airfield.push(...paved);
      footprint.push(...paved);
      if (cls === 'runway') markings.push(...runwayPaint(r.points, width));
      else markings.push({ kind: 'taxiway-center', points: densify(r.points, 20) });
      continue;
    }
    // Underground stretches (metro, the İZBAN tunnel) are not drawn.
    if (tunnel) continue;
    const lanes = Number.parseInt(r.tags.lanes ?? '', 10);
    const tracks = Number.isFinite(lanes) && lanes > 0 && lanes <= 6 ? lanes : TRACKS[cls];
    const bed = tracks * TRACK_SPACING + (cls === 'tram' ? 0.6 : 2.4);
    rails.push({
      id: `rl:${r.ref}`,
      ref: r.ref,
      kind: cls as RailLine['kind'],
      tracks,
      width: bed,
      points: r.points,
      ...(r.tags.name ? { name: r.tags.name } : {}),
      provenance: 'observed',
    });
    footprint.push(...bufferPolyline(r.points, bed / 2, false));
  }
  return { rails, airfield, markings, footprint };
}
