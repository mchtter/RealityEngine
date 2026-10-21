import type { SourceRoad } from './osm';
import { bufferPolyline } from './poly';
import { densify, offsetPolyline } from './roads';
import { PolygonSet } from './spatial';
import type { AirfieldLight, Marking, Polygon, Prop, Vec2 } from './types';

/**
 * Airfield ways carried in the road theme: runways, taxiways, stopways and
 * stand (parking position) lines. They stay out of the street network.
 */
export const AIRFIELD_CLASSES: ReadonlySet<string> = new Set([
  'runway',
  'taxiway',
  'stopway',
  'stand',
]);

/** Paved width (m) of a way without a width in the data. */
const DEFAULT_WIDTH: Record<string, number> = { runway: 45, taxiway: 23, stopway: 45 };

/** A runway this long and wide is a precision runway: approach lights, TDZ, wing bars. */
const PRECISION = { length: 2400, width: 40 };

/** Where the wind blows the windsocks to: the region's sea breeze (imbat) comes from the north-west. */
const WIND_HEADING = -Math.PI / 4;

export interface Airfield {
  /** Runway / taxiway / stopway pavement. */
  pavement: Polygon[];
  markings: Marking[];
  lights: AirfieldLight[];
  /** Windsocks. */
  props: Prop[];
}

// ─── Polylines ──────────────────────────────────────────────────────────────

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** A polyline walked by arc length; past its ends it runs on straight. */
class Path {
  readonly length: number;
  private readonly cum: number[] = [0];

  constructor(readonly points: Vec2[]) {
    for (let k = 1; k < points.length; k++)
      this.cum.push(this.cum[k - 1] + dist(points[k - 1], points[k]));
    this.length = this.cum[this.cum.length - 1];
  }

  /** Point and unit direction at arc length s. */
  at(s: number): { p: Vec2; d: Vec2 } {
    const n = this.points.length;
    let k = 1;
    while (k < n - 1 && this.cum[k] < s) k++;
    const a = this.points[k - 1];
    const b = this.points[k];
    const seg = this.cum[k] - this.cum[k - 1] || 1;
    const d: Vec2 = [(b[0] - a[0]) / seg, (b[1] - a[1]) / seg];
    const t = s - this.cum[k - 1];
    return { p: [a[0] + d[0] * t, a[1] + d[1] * t], d };
  }

  /** The part between arc lengths a and b. */
  slice(a: number, b: number): Vec2[] {
    const out: Vec2[] = [this.at(a).p];
    for (let k = 1; k < this.points.length - 1; k++)
      if (this.cum[k] > a && this.cum[k] < b) out.push(this.points[k]);
    out.push(this.at(b).p);
    return out;
  }
}

/**
 * Joins the pieces of one runway (OSM splits a runway where it crosses an
 * area or a threshold moved): end to end, within 15 m.
 */
function joinPieces(pieces: Vec2[][]): Vec2[][] {
  const rest = pieces.map((p) => [...p]).sort((a, b) => b.length - a.length);
  const out: Vec2[][] = [];
  while (rest.length) {
    let line = rest.shift()!;
    for (let found = true; found; ) {
      found = false;
      for (let i = 0; i < rest.length; i++) {
        const p = rest[i];
        const head = line[0];
        const tail = line[line.length - 1];
        let joined: Vec2[] | null = null;
        if (dist(tail, p[0]) < 15) joined = [...line, ...p.slice(1)];
        else if (dist(tail, p[p.length - 1]) < 15) joined = [...line, ...[...p].reverse().slice(1)];
        else if (dist(head, p[p.length - 1]) < 15) joined = [...p, ...line.slice(1)];
        else if (dist(head, p[0]) < 15) joined = [...[...p].reverse(), ...line.slice(1)];
        if (joined) {
          line = joined;
          rest.splice(i, 1);
          found = true;
          break;
        }
      }
    }
    out.push(line);
  }
  return out;
}

/** Compass bearing (degrees, clockwise from north) from a to b. */
const bearing = (a: Vec2, b: Vec2) =>
  ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI + 360) % 360;
const angleGap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/**
 * The names of a runway's two ends ("16L/34R"), first end first: the end a
 * landing on heading 160° starts from is "16L".
 */
export function runwayEnds(ref: string | undefined, line: Vec2[]): [string?, string?] {
  const parts = (ref ?? '').split('/').map((s) => s.trim().toUpperCase());
  if (parts.length !== 2 || parts.some((p) => !/^\d{1,2}[LRC]?$/.test(p))) return [];
  const heading = bearing(line[0], line[line.length - 1]);
  const [a, b] = parts.map((p) => Number.parseInt(p, 10) * 10);
  return angleGap(heading, a) <= angleGap(heading, b) ? [parts[0], parts[1]] : [parts[1], parts[0]];
}

// ─── Designators: a stroke font (ICAO digits are 9 m tall) ──────────────────

/** Seven segments in a 4 × 8 cell (x right, y up). */
const SEG: Record<string, [Vec2, Vec2]> = {
  a: [
    [0, 8],
    [4, 8],
  ],
  b: [
    [4, 8],
    [4, 4],
  ],
  c: [
    [4, 4],
    [4, 0],
  ],
  d: [
    [0, 0],
    [4, 0],
  ],
  e: [
    [0, 0],
    [0, 4],
  ],
  f: [
    [0, 4],
    [0, 8],
  ],
  g: [
    [0, 4],
    [4, 4],
  ],
};
const GLYPHS: Record<string, string> = {
  '0': 'abcdef',
  '2': 'abged',
  '3': 'abgcd',
  '4': 'fgbc',
  '5': 'afgcd',
  '6': 'afgedc',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
  L: 'fed',
  C: 'afed',
  R: 'abgef',
};

/** Strokes of a character in its 4 × 8 cell. */
function strokes(ch: string): [Vec2, Vec2][] {
  if (ch === '1')
    return [
      [
        [2, 0],
        [2, 8],
      ],
    ];
  const out = [...(GLYPHS[ch] ?? '')].map((s) => SEG[s]);
  if (ch === 'R')
    out.push([
      [1.6, 4],
      [4, 0],
    ]);
  return out;
}

const GLYPH = { height: 9, width: 4.5, gap: 3, stroke: 1.4 };

// ─── Runways ────────────────────────────────────────────────────────────────

/** One runway end's frame: s metres in from the threshold, v metres to the pilot's left. */
type Frame = (s: number, v: number) => Vec2;

class Runway {
  readonly path: Path;
  readonly L: number;
  readonly W: number;
  readonly precision: boolean;
  readonly ends: [string?, string?];

  constructor(
    readonly id: string,
    points: Vec2[],
    width: number,
    ref: string | undefined,
  ) {
    this.path = new Path(densify(points, 20));
    this.L = this.path.length;
    this.W = width / 2;
    this.precision = this.L >= PRECISION.length && width >= PRECISION.width;
    this.ends = runwayEnds(ref, points);
  }

  /** The frame of end e (0: the first point, 1: the last). */
  frame(e: 0 | 1): Frame {
    return (s, v) => {
      const { p, d } = this.path.at(e ? this.L - s : s);
      const dx = e ? -d[0] : d[0];
      const dy = e ? -d[1] : d[1];
      return [p[0] - dy * v, p[1] + dx * v];
    };
  }

  /** Heading (radians) of a landing on end e. */
  heading(e: 0 | 1): number {
    const f = this.frame(e);
    const a = f(0, 0);
    const b = f(50, 0);
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  }

  /** Distance from p to the centreline. */
  distanceTo(p: Vec2): number {
    let best = Infinity;
    const pts = this.path.points;
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1];
      const b = pts[k];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const t = Math.max(
        0,
        Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
      );
      best = Math.min(best, Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t));
    }
    return best;
  }
}

/** Paint of a runway (ICAO Annex 14 §5.2). */
function runwayPaint(r: Runway): Marking[] {
  const out: Marking[] = [];
  const { L, W } = r;
  const white = (points: Vec2[], width: number) =>
    out.push({ kind: 'airfield-white', points, width });
  // Side stripes over the full length.
  for (const v of [W - 0.45, -(W - 0.45)]) white(offsetPolyline(r.path.slice(0, L), v), 0.9);
  if (L < 600) return out;

  // Centreline: 30 m stripes, 20 m gaps, between the designators.
  const a = 80;
  const n = Math.floor((L - 2 * a + 20) / 50);
  const s0 = a + (L - 2 * a - (n * 50 - 20)) / 2;
  const f0 = r.frame(0);
  for (let k = 0; k < n; k++) {
    const s = s0 + k * 50;
    white([f0(s, 0), f0(s + 30, 0)], r.precision ? 0.9 : 0.45);
  }

  const width = W * 2;
  const keys = width >= 45 ? 6 : width >= 30 ? 4 : width >= 23 ? 3 : 2;
  const aim = L >= 2400 ? 400 : L >= 1200 ? 300 : L >= 800 ? 250 : 150;
  for (const e of [0, 1] as const) {
    const f = r.frame(e);
    const bar = (sA: number, sB: number, v: number, w: number) => white([f(sA, v), f(sB, v)], w);
    // Threshold: the "piano keys", 30 m long from 6 m in.
    const pitch = (W - 3 - 1.8) / keys;
    const keyWidth = Math.min(1.8, pitch / 2);
    for (let k = 0; k < keys; k++) {
      const v = 1.8 + pitch * (k + 0.5);
      bar(6, 36, v, keyWidth);
      bar(6, 36, -v, keyWidth);
    }
    // Designator: the letter nearest the threshold, the number beyond, 12 m after the keys.
    const name = r.ends[e];
    if (name) {
      const num = name.replace(/[LRC]$/, '').padStart(2, '0');
      const letter = name.slice(num.length).trim() || name.match(/[LRC]$/)?.[0];
      let s = 48;
      for (const row of [letter, num]) {
        if (!row) continue;
        const total = row.length * GLYPH.width + (row.length - 1) * GLYPH.gap;
        [...row].forEach((ch, i) => {
          const x0 = -total / 2 + i * (GLYPH.width + GLYPH.gap);
          for (const [p, q] of strokes(ch)) {
            // Each stroke runs on half a stroke past its ends: the corners close.
            const u = GLYPH.width / 4;
            const h = GLYPH.height / 8;
            const len = Math.hypot((q[0] - p[0]) * u, (q[1] - p[1]) * h) || 1;
            const ex = (((q[0] - p[0]) * u) / len) * (GLYPH.stroke / 2);
            const ey = (((q[1] - p[1]) * h) / len) * (GLYPH.stroke / 2);
            // Glyph x runs to the pilot's right (−v), glyph y down the runway (+s).
            white(
              [
                f(s + p[1] * h - ey, -(x0 + p[0] * u - ex)),
                f(s + q[1] * h + ey, -(x0 + q[0] * u + ex)),
              ],
              GLYPH.stroke,
            );
          }
        });
        s += GLYPH.height + 6;
      }
    }
    // Aiming point: two broad bars.
    const aimLength = L >= 2400 ? 60 : 45;
    const aimWidth = L >= 2400 ? 10 : 6;
    for (const sign of [1, -1]) bar(aim, aim + aimLength, sign * (9 + aimWidth / 2), aimWidth);
    // Touchdown zone (precision runways): stripe groups 3, 3, 2, 2, 1 a side.
    if (r.precision)
      for (const [d, count] of [
        [150, 3],
        [300, 3],
        [600, 2],
        [750, 2],
        [900, 1],
      ] as const) {
        if (d + 22.5 > L / 2) break;
        for (let k = 0; k < count; k++) {
          const v = 9 + 0.9 + k * 3.3;
          bar(d, d + 22.5, v, 1.8);
          bar(d, d + 22.5, -v, 1.8);
        }
      }
  }
  return out;
}

/** Lights of a runway and its approaches. */
function runwayLights(r: Runway): AirfieldLight[] {
  const out: AirfieldLight[] = [];
  const { L, W } = r;
  const f0 = r.frame(0);
  const h0 = r.heading(0);
  const h1 = r.heading(1);
  // Edge lights every 60 m, a fixture is two lights back to back: each landing
  // direction sees white, and yellow over its last 600 m.
  const edgeN = Math.max(2, Math.round(L / 60));
  for (let k = 0; k <= edgeN; k++) {
    const s = (k * L) / edgeN;
    for (const v of [W + 1, -(W + 1)]) {
      const at = f0(s, v);
      // Landing on end 0 (heading h0) sees the faces turned to h1, and the reverse.
      out.push({ kind: L - s < 600 ? 'edge-caution' : 'edge', at, lift: 0.35, dir: h1 });
      out.push({ kind: s < 600 ? 'edge-caution' : 'edge', at, lift: 0.35, dir: h0 });
    }
  }
  // Centreline every 15 m (precision): red / white over the last 900 m, red over the last 300.
  if (r.precision) {
    const n = Math.floor(L / 15);
    for (let k = 1; k < n; k++) {
      const s = k * 15;
      const at = f0(s, 0.6);
      const kindFor = (left: number) =>
        left < 300 ? 'center-red' : left < 900 && k % 2 ? 'center-red' : 'center';
      out.push({ kind: kindFor(L - s), at, lift: 0.05, dir: h1 });
      out.push({ kind: kindFor(s), at, lift: 0.05, dir: h0 });
    }
  }
  const aim = L >= 2400 ? 400 : L >= 1200 ? 300 : L >= 800 ? 250 : 150;
  for (const e of [0, 1] as const) {
    const f = r.frame(e);
    // Toward an aircraft landing on this end; into the runway for one rolling to it.
    const toApproach = e ? h0 : h1;
    const intoRunway = e ? h1 : h0;
    // Threshold (green) and end (red) lights across the runway, 3 m apart.
    const across = Math.floor((2 * W) / 3);
    for (let k = 0; k <= across; k++) {
      const v = -W + (k * 2 * W) / across;
      out.push({ kind: 'threshold', at: f(-1, v), lift: 0.3, dir: toApproach });
      out.push({ kind: 'end', at: f(0.5, v + 1.5 < W ? v + 1.5 : v), lift: 0.3, dir: intoRunway });
    }
    if (r.precision) {
      // Wing bars: green, 5 a side past the edges.
      for (let k = 0; k < 5; k++)
        for (const sign of [1, -1])
          out.push({
            kind: 'threshold',
            at: f(-1, sign * (W + 3 + k * 2.5)),
            lift: 0.3,
            dir: toApproach,
          });
      // Touchdown zone barrettes: 3 lights a side every 30 m to 900 m.
      for (let s = 60; s <= Math.min(900, L / 2); s += 30)
        for (const v of [9, 10.5, 12])
          for (const sign of [1, -1])
            out.push({ kind: 'tdz', at: f(s, sign * v), lift: 0.05, dir: toApproach });
      // Approach lights: a centreline of 5-light barrettes every 30 m out to
      // 900 m, crossbars every 150 m (wider farther out), and a flasher on each
      // barrette from 900 to 300 m out, fired in turn toward the threshold.
      for (let d = 30; d <= 900; d += 30) {
        for (let v = -2; v <= 2; v++)
          out.push({ kind: 'approach', at: f(-d, v), lift: 1.5, dir: toApproach });
        if (d >= 300)
          out.push({
            kind: 'approach-flash',
            at: f(-d, 0),
            lift: 2.2,
            dir: toApproach,
            seq: (900 - d) / 600,
          });
        if (d % 150 === 0) {
          const half = 2 + (d / 150) * 4;
          for (let v = 4; v <= half; v += 2)
            for (const sign of [1, -1])
              out.push({ kind: 'approach', at: f(-d, sign * v), lift: 1.5, dir: toApproach });
        }
      }
    } else {
      // Runway end identifier: two synchronised strobes beside the threshold.
      for (const sign of [1, -1])
        out.push({ kind: 'reil', at: f(0, sign * (W + 12)), lift: 1, dir: toApproach });
    }
    // PAPI on the pilot's left at the aiming point: from the runway out
    // 3.50°, 3.17°, 2.83°, 2.50° — on the glide path two red, two white.
    if (L >= 1000)
      [3.5, 3.17, 2.83, 2.5].forEach((angle, k) =>
        out.push({
          kind: 'papi',
          at: f(aim, W + 15 + k * 9),
          lift: 0.8,
          dir: toApproach,
          angle,
        }),
      );
  }
  return out;
}

/** Chevrons on a stopway (yellow), pointing at the runway it extends. */
function stopwayPaint(points: Vec2[], width: number, runways: Runway[]): Marking[] {
  const near = (p: Vec2) =>
    runways.some((r) => dist(r.path.points[0], p) < 30 || dist(r.path.points.at(-1)!, p) < 30);
  // Walk the stopway outward from the runway end.
  const line = near(points[0]) ? points : near(points.at(-1)!) ? [...points].reverse() : null;
  if (!line) return [];
  const path = new Path(line);
  const w = width / 2 - 1;
  const out: Marking[] = [];
  const point = (s: number, v: number): Vec2 => {
    const { p, d } = path.at(s);
    return [p[0] - d[1] * v, p[1] + d[0] * v];
  };
  for (let s = 4; s + 2 < path.length; s += 30) {
    const reach = Math.min(w, path.length - 1 - s);
    if (reach < 4) break;
    for (const sign of [1, -1])
      out.push({
        kind: 'airfield-yellow',
        points: [point(s, 0), point(s + reach, sign * reach)],
        width: 0.9,
      });
  }
  return out;
}

/** Runs of a polyline (sampled every `step` m) whose points pass `keep`. */
function runsWhere(points: Vec2[], step: number, keep: (p: Vec2) => boolean): Vec2[][] {
  const out: Vec2[][] = [];
  let run: Vec2[] = [];
  for (const p of densify(points, step)) {
    if (keep(p)) run.push(p);
    else {
      if (run.length >= 2) out.push(run);
      run = [];
    }
  }
  if (run.length >= 2) out.push(run);
  return out;
}

/** Points every `step` m along a polyline (its ends included). */
function every(points: Vec2[], step: number): Vec2[] {
  const path = new Path(points);
  const n = Math.max(1, Math.round(path.length / step));
  return Array.from({ length: n + 1 }, (_, k) => path.at((k * path.length) / n).p);
}

/**
 * Lays the airfield: pavement, ICAO paint, lights (runways, approaches,
 * taxiways, stop bars) and windsocks from the airfield ways. `aprons` keep
 * the taxiway edge lights and lines off the aprons.
 */
export function layAirfield(sources: SourceRoad[], aprons: Polygon[] = []): Airfield {
  const pavement: Polygon[] = [];
  const markings: Marking[] = [];
  const lights: AirfieldLight[] = [];
  const props: Prop[] = [];
  const ways = sources.filter(
    (r) => AIRFIELD_CLASSES.has(r.tags.highway ?? '') && r.points.length >= 2,
  );
  if (!ways.length) return { pavement, markings, lights, props };
  const widthOf = (r: SourceRoad) => {
    const w = Number.parseFloat(r.tags.width ?? '');
    return Number.isFinite(w) && w > 5 ? w : (DEFAULT_WIDTH[r.tags.highway ?? ''] ?? 23);
  };

  // Runways: the pieces of one runway joined.
  const byRef = new Map<string, SourceRoad[]>();
  for (const r of ways.filter((w) => w.tags.highway === 'runway')) {
    const key = r.tags.ref?.trim() || `#${r.ref}`;
    byRef.set(key, [...(byRef.get(key) ?? []), r]);
  }
  const runways: Runway[] = [];
  for (const [key, pieces] of byRef) {
    const width = Math.max(...pieces.map(widthOf));
    const ref = key.startsWith('#') ? undefined : key;
    joinPieces(pieces.map((p) => p.points)).forEach((line, i) =>
      runways.push(new Runway(`${pieces[0].ref}${i ? `~${i}` : ''}`, line, width, ref)),
    );
  }
  const runwayPaved = runways.flatMap((r) => bufferPolyline(r.path.points, r.W, false));
  const taxiways = ways.filter((w) => w.tags.highway === 'taxiway');
  const stopways = ways.filter((w) => w.tags.highway === 'stopway');
  const taxiPaved = taxiways.map((t) => bufferPolyline(t.points, widthOf(t) / 2));
  const stopPaved = stopways.flatMap((s) => bufferPolyline(s.points, widthOf(s) / 2, false));
  pavement.push(...runwayPaved, ...taxiPaved.flat(), ...stopPaved);
  const onRunway = new PolygonSet(runwayPaved);
  const paved = new PolygonSet(pavement);
  const onApron = new PolygonSet(aprons);

  for (const r of runways) {
    markings.push(...runwayPaint(r));
    lights.push(...runwayLights(r));
  }
  for (const s of stopways) markings.push(...stopwayPaint(s.points, widthOf(s), runways));

  // Taxiways: centreline and edges, their lights, and where they meet a
  // runway the holding position with its stop bar.
  taxiways.forEach((t) => {
    const W = widthOf(t) / 2;
    markings.push(
      ...runsWhere(t.points, 2, (p) => !onRunway.contains(p[0], p[1])).map((points) => ({
        kind: 'taxiway-center' as const,
        points,
      })),
    );
    for (const p of every(t.points, 15))
      if (!onRunway.contains(p[0], p[1])) lights.push({ kind: 'taxi-center', at: p, lift: 0.05 });
    // Edges: double yellow lines and blue lights, drawn where just past the
    // edge there is no other pavement (a junction, a runway) and no apron.
    const line = densify(t.points, 2);
    const free = (p: Vec2) => !paved.contains(p[0], p[1]) && !onApron.contains(p[0], p[1]);
    for (const sign of [1, -1]) {
      const probe = offsetPolyline(line, sign * (W + 0.8));
      for (const v of [W - 0.5, W - 0.95]) {
        const edge = offsetPolyline(line, sign * v);
        let run: Vec2[] = [];
        edge.forEach((p, i) => {
          if (free(probe[i])) run.push(p);
          else {
            if (run.length >= 2)
              markings.push({ kind: 'airfield-yellow', points: run, width: 0.15 });
            run = [];
          }
        });
        if (run.length >= 2) markings.push({ kind: 'airfield-yellow', points: run, width: 0.15 });
      }
      for (const p of every(offsetPolyline(t.points, sign * (W + 1)), 30))
        if (free(p)) lights.push({ kind: 'taxi-edge', at: p, lift: 0.3 });
    }
    for (const r of runways) {
      const hold = r.precision ? 90 : r.L >= 1200 ? 75 : 50;
      const pts = densify(t.points, 1);
      const d = pts.map((p) => r.distanceTo(p));
      if (Math.min(...d) > r.W) continue;
      for (let k = 1; k < pts.length; k++) {
        const inward = d[k - 1] > hold && d[k] <= hold;
        const outward = d[k - 1] <= hold && d[k] > hold;
        if (!inward && !outward) continue;
        // Toward the runway.
        const a = inward ? pts[k - 1] : pts[k];
        const b = inward ? pts[k] : pts[k - 1];
        const len = dist(a, b) || 1;
        const tx = (b[0] - a[0]) / len;
        const ty = (b[1] - a[1]) / len;
        const at = pts[k];
        const across = (o: number, v: number): Vec2 => [
          at[0] + tx * o - ty * v,
          at[1] + ty * o + tx * v,
        ];
        const half = W - 0.5;
        // Pattern A: two solid lines on the taxiway side, two dashed on the runway side.
        for (const o of [-1.35, -0.9])
          markings.push({
            kind: 'airfield-yellow',
            points: [across(o, -half), across(o, half)],
            width: 0.3,
          });
        for (const o of [-0.45, 0])
          for (let v = -half; v < half; v += 2)
            markings.push({
              kind: 'airfield-yellow',
              points: [across(o, v), across(o, Math.min(half, v + 1))],
              width: 0.3,
            });
        // Stop bar: red lights across the taxiway, facing the aircraft that comes.
        const face = Math.atan2(-ty, -tx);
        for (let v = -half + 1; v <= half - 1; v += 3)
          lights.push({ kind: 'stopbar', at: across(-3, v), lift: 0.05, dir: face });
      }
    }
  });

  // Stand lines: lead-in lines on the apron (yellow).
  for (const s of ways.filter((w) => w.tags.highway === 'stand'))
    markings.push({ kind: 'airfield-yellow', points: densify(s.points, 4), width: 0.2 });

  // A windsock beside each runway end, clear of the pavement.
  for (const r of runways) {
    if (r.L < 1000) continue;
    for (const e of [0, 1] as const) {
      const f = r.frame(e);
      const at = [f(300, r.W + 80), f(300, -(r.W + 80))].find(
        (p) => !paved.contains(p[0], p[1]) && !onApron.contains(p[0], p[1]),
      );
      if (at)
        props.push({
          id: `ws:${r.id}:${e}`,
          kind: 'windsock',
          position: [at[0], at[1], 0],
          heading: WIND_HEADING,
          scale: 1,
          provenance: 'synthetic',
        });
    }
  }
  return { pavement, markings, lights, props };
}
