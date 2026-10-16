import { closestOnSegment } from './geo';
import type {
  Crossing,
  Junction,
  JunctionArm,
  LaneTurn,
  Marking,
  Polygon,
  Road,
  Vec2,
} from './types';

/** How far out (m) an arm is followed to find where the junction ends. */
const ARM_REACH = 40;
const STEP = 0.5;
/** Clear distance (m) beyond another arm's carriageway edge. */
const CLEAR = 0.3;
/** Turns within this angle (degrees) of straight on go through; past REVERSE they turn back. */
const THROUGH_DEG = 30;
const REVERSE_DEG = 150;

/** The road's centreline from the junction outwards (half of it at a middle vertex). */
function armLine(road: Road, at: number, outward: boolean): Vec2[] {
  const line = road.centerline;
  return outward ? line.slice(at) : line.slice(0, at + 1).reverse();
}

/** Point and unit tangent `s` metres along a polyline (the last segment carries on). */
function along(line: Vec2[], s: number): { p: Vec2; t: Vec2 } {
  let left = s;
  for (let k = 1; k < line.length; k++) {
    const a = line[k - 1];
    const b = line[k];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-9) continue;
    const t: Vec2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    if (left <= l || k === line.length - 1)
      return { p: [a[0] + t[0] * left, a[1] + t[1] * left], t };
    left -= l;
  }
  return { p: line[0], t: [1, 0] };
}

const distToLine = (q: Vec2, line: Vec2[]) => {
  let d = Infinity;
  for (let k = 1; k < line.length; k++)
    d = Math.min(d, closestOnSegment(q, line[k - 1], line[k]).d);
  return d;
};

/**
 * The arms of every junction and where the junction ends on each (D-012):
 * an arm leaves the junction along its road; its edge is the first cross-
 * section out from the centre whose two carriageway corners lie clear of
 * every other arm's carriageway. The junction area joins those corners.
 * Sets `arms` and `polygon` on each junction.
 */
export function layoutJunctions(junctions: Junction[], roads: Road[]): void {
  const byId = new Map(roads.map((r) => [r.id, r]));
  for (const j of junctions) {
    const lines: { road: Road; at: number; outward: boolean; line: Vec2[] }[] = [];
    for (const id of j.roadIds) {
      const road = byId.get(id);
      if (!road) continue;
      const c = road.centerline;
      for (let k = 0; k < c.length; k++) {
        if (Math.hypot(c[k][0] - j.center[0], c[k][1] - j.center[1]) > 0.05) continue;
        if (k < c.length - 1)
          lines.push({ road, at: k, outward: true, line: armLine(road, k, true) });
        if (k > 0) lines.push({ road, at: k, outward: false, line: armLine(road, k, false) });
        break;
      }
    }
    if (lines.length < 3) continue;
    const arms: JunctionArm[] = [];
    const corners: Vec2[] = [];
    for (const [i, arm] of lines.entries()) {
      const half = arm.road.width / 2;
      const clear = (q: Vec2) =>
        lines.every(
          (o, n) => n === i || distToLine(q, o.line.slice(0, 12)) >= o.road.width / 2 + CLEAR,
        );
      let edge = ARM_REACH;
      let found = false;
      let at = along(arm.line, edge);
      for (let s = STEP; s <= ARM_REACH; s += STEP) {
        const here = along(arm.line, s);
        const nrm: Vec2 = [-here.t[1], here.t[0]];
        const l: Vec2 = [here.p[0] + nrm[0] * half, here.p[1] + nrm[1] * half];
        const r: Vec2 = [here.p[0] - nrm[0] * half, here.p[1] - nrm[1] * half];
        if (clear(l) && clear(r)) {
          edge = s;
          at = here;
          found = true;
          break;
        }
      }
      const nrm: Vec2 = [-at.t[1], at.t[0]];
      corners.push(
        [at.p[0] + nrm[0] * half, at.p[1] + nrm[1] * half],
        [at.p[0] - nrm[0] * half, at.p[1] - nrm[1] * half],
      );
      arms.push({
        roadId: arm.road.id,
        at: arm.at,
        outward: arm.outward,
        dir: along(arm.line, 0).t,
        edge,
        ...(found ? {} : { merging: true as const }),
      });
    }
    corners.sort(
      (a, b) =>
        Math.atan2(a[1] - j.center[1], a[0] - j.center[0]) -
        Math.atan2(b[1] - j.center[1], b[0] - j.center[0]),
    );
    j.arms = arms;
    j.polygon = { outer: corners, holes: [] } satisfies Polygon;
  }
}

/** The lanes of a road that drive into a junction on that arm, from the centre line outwards. */
export function lanesInto(road: Road, arm: JunctionArm) {
  const lanes = road.laneLayout ?? [];
  // Outward: the road is drawn away from the junction, so its backward lanes come in.
  const incoming = lanes.filter((l) => l.forward !== arm.outward);
  // From the centre line outwards: the backward lanes lie left (largest offset last
  // towards the centre), the forward lanes right (largest offset nearest the centre).
  return arm.outward
    ? incoming.sort((a, b) => a.offset - b.offset)
    : incoming.sort((a, b) => b.offset - a.offset);
}

/**
 * Turns of the lanes driving into each junction (`arm.turns`): the road's own
 * (`turn:lanes`, provenance observed) where it ends at the junction — OSM
 * gives a way's turns for the junction it leads into — else by the arms
 * there: the lane by the centre line turns left, the kerb lane right, both
 * also go straight on where an arm lies ahead; the lanes between go straight
 * on. Only exits a driver may take (an arm with lanes leading away).
 */
export function inferTurns(junctions: Junction[], roads: Road[]): void {
  const byId = new Map(roads.map((r) => [r.id, r]));
  for (const j of junctions) {
    for (const arm of j.arms ?? []) {
      const road = byId.get(arm.roadId);
      if (!road?.laneLayout) continue;
      const lanes = lanesInto(road, arm);
      if (!lanes.length) continue;
      const last = road.centerline.length - 1;
      const endsHere = arm.outward ? arm.at === 0 : arm.at === last;
      if (endsHere && lanes.every((l) => l.turns.length)) {
        arm.turns = lanes.map((l) => [...l.turns]);
        arm.turnsProvenance = 'observed';
        continue;
      }
      const heading: Vec2 = [-arm.dir[0], -arm.dir[1]];
      const exits = new Set<LaneTurn>();
      for (const other of j.arms ?? []) {
        if (other === arm) continue;
        const out = byId.get(other.roadId);
        // An exit has lanes leading away from the junction.
        if (!out?.laneLayout?.some((l) => l.forward === other.outward)) continue;
        const cross = heading[0] * other.dir[1] - heading[1] * other.dir[0];
        const dot = heading[0] * other.dir[0] + heading[1] * other.dir[1];
        const deg = (Math.atan2(cross, dot) * 180) / Math.PI;
        if (Math.abs(deg) <= THROUGH_DEG) exits.add('through');
        else if (Math.abs(deg) < REVERSE_DEG) exits.add(deg > 0 ? 'left' : 'right');
      }
      if (!exits.size) continue;
      const all = (['left', 'through', 'right'] as const).filter((t) => exits.has(t));
      arm.turns = lanes.map((_, k) => {
        const first = k === 0;
        const kerb = k === lanes.length - 1;
        let turns: LaneTurn[];
        if (lanes.length === 1) turns = [...all];
        else if (first) turns = all.filter((t) => t === 'left' || t === 'through');
        else if (kerb) turns = all.filter((t) => t === 'right' || t === 'through');
        else turns = all.filter((t) => t === 'through');
        return turns.length ? turns : first ? all.slice(0, 1) : all.slice(-1);
      });
      arm.turnsProvenance = 'inferred';
    }
  }
}

/** Point on an arm `s` metres out from the junction centre, with the road's left normal there. */
export function armPoint(
  road: Road,
  arm: JunctionArm,
  s: number,
): { p: Vec2; out: Vec2; left: Vec2 } {
  const { p, t } = along(armLine(road, arm.at, arm.outward), s);
  // The road's drawing direction runs out along the arm when it is drawn away from the junction.
  const draw: Vec2 = arm.outward ? t : [-t[0], -t[1]];
  return { p, out: t, left: [-draw[1], draw[0]] };
}

/** Length (m) of an arm's road from the junction outwards. */
export function armLength(road: Road, arm: JunctionArm): number {
  const line = armLine(road, arm.at, arm.outward);
  let l = 0;
  for (let k = 1; k < line.length; k++)
    l += Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1]);
  return l;
}

/** Gap (m) between the junction edge and a crossing's near side; stop line 1 m behind its far side. */
export const CROSSING_GAP = 0.5;
export const CROSSING_WIDTH = 3;
const STOP_BEHIND = 1;

/**
 * Where traffic driving in on each arm stops (`arm.stop`): 1 m behind a
 * crossing on the arm next to the junction, else just outside its edge.
 */
export function setStops(junctions: Junction[], roads: Road[], crossings: Crossing[]): void {
  const byId = new Map(roads.map((r) => [r.id, r]));
  for (const j of junctions)
    for (const arm of j.arms ?? []) {
      if (arm.merging) continue;
      const road = byId.get(arm.roadId);
      let stop = arm.edge + CROSSING_GAP;
      if (road) {
        const line = armLine(road, arm.at, arm.outward).slice(0, 12);
        for (const c of crossings) {
          let walked = 0;
          for (let k = 1; k < line.length; k++) {
            const hit = closestOnSegment(c.center, line[k - 1], line[k]);
            const seg = Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1]);
            if (hit.d < 1) {
              const at = walked + seg * hit.t;
              if (at > arm.edge - 1 && at < arm.edge + 10)
                stop = Math.max(stop, at + CROSSING_WIDTH / 2 + STOP_BEHIND);
              break;
            }
            walked += seg;
          }
        }
      }
      arm.stop = stop;
    }
}

const RANK: Record<string, number> = {
  motorway: 7,
  trunk: 6,
  primary: 5,
  secondary: 4,
  tertiary: 3,
  unclassified: 2,
  residential: 2,
  living_street: 1,
  service: 0,
  track: 0,
};

/** Arrows sit this far (m) behind the stop line, this long. */
const ARROW_BACK = 2;
const ARROW_LENGTH = 5;

/**
 * Paint at each junction from the lane model (D-012): a stop line across the
 * lanes driving in where the junction has signals, a give-way line on an arm
 * of a lower class than another there; turn arrows on the lanes driving in
 * where there are two or more of them, or the source gives their turns.
 */
export function junctionMarkings(junctions: Junction[], roads: Road[]): Marking[] {
  const byId = new Map(roads.map((r) => [r.id, r]));
  const out: Marking[] = [];
  for (const j of junctions) {
    const arms = (j.arms ?? []).filter((a) => byId.get(a.roadId)?.grade === 'ground');
    const top = Math.max(...arms.map((a) => RANK[byId.get(a.roadId)!.cls] ?? 0));
    for (const arm of arms) {
      const road = byId.get(arm.roadId)!;
      const lanes = lanesInto(road, arm);
      if (!lanes.length || arm.stop === undefined) continue;
      const length = armLength(road, arm);
      if (length < arm.stop + 2) continue;
      const at = armPoint(road, arm, arm.stop);
      const across = (offset: number, q = at): Vec2 => [
        q.p[0] + q.left[0] * offset,
        q.p[1] + q.left[1] * offset,
      ];
      const hi = Math.max(...lanes.map((l) => l.offset + l.width / 2)) - 0.2;
      const lo = Math.min(...lanes.map((l) => l.offset - l.width / 2)) + 0.2;
      const minor = (RANK[road.cls] ?? 0) < top;
      if (j.signalised) out.push({ kind: 'stop', points: [across(hi), across(lo)] });
      else if (minor) out.push({ kind: 'give-way', points: [across(hi), across(lo)] });
      if (!arm.turns || (lanes.length < 2 && arm.turnsProvenance !== 'observed')) continue;
      if (length < arm.stop + ARROW_BACK + ARROW_LENGTH + 2) continue;
      const head = armPoint(road, arm, arm.stop + ARROW_BACK);
      const tail = armPoint(road, arm, arm.stop + ARROW_BACK + ARROW_LENGTH);
      lanes.forEach((lane, k) => {
        const turns = arm.turns![k];
        if (!turns?.length) return;
        out.push({
          kind: 'arrow',
          points: [across(lane.offset, tail), across(lane.offset, head)],
          turns,
        });
      });
    }
  }
  return out;
}
