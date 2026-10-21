/**
 * Reality Engine uyum motoru — kuralların uygulanması.
 *
 * The compiler hands each stage its objects; the engine enforces that
 * stage's rules (rules.ts) on them and keeps a correction (Fix) for every
 * change, with the rule, the action, the object given way to and a note.
 * Rails, airfields and the network are fixed before the stages run: they
 * give way to nothing below them in rank (classes.ts).
 */
import { closestOnSegment, pointInRing, ringCentroid } from '../geo';
import { bufferPolyline, difference, intersection, polygonArea } from '../poly';
import { isVehicular } from '../roads';
import type { RoadIndex } from '../spatial';
import type {
  Building,
  Fence,
  Fix,
  Marking,
  Polygon,
  Prop,
  RailLine,
  Surface,
  SurfaceKind,
  Vec2,
} from '../types';
import { CITY_CLASSES, type CityClassId } from './classes';
import { RULE_BY_ID } from './rules';

/** Footprint left after a cut below which the building is removed (m²). */
const MIN_BUILDING = 8;
/** Overlap below which a building is not cut (m²): width-estimate noise. */
const MIN_OVERLAP = 2;
/** Share of a station's footprint a bed must cover for the station to be a hall over it. */
const STATION_SPAN = 0.3;

/** What lies under a point and the free height it needs. */
export interface Envelope {
  clearance: number;
  cls: CityClassId;
  /** Ref of the object (rail / road) that needs it. */
  ref: string;
  rule: string;
}

interface Bed {
  rail: RailLine;
  cls: 'rail' | 'tram';
  /** The bed itself. */
  polys: Polygon[];
  /** The bed and its safety margin. */
  padded: Polygon[];
  box: [number, number, number, number];
}

const boxOf = (polys: Polygon[]): [number, number, number, number] => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of polys)
    for (const q of p.outer) {
      x0 = Math.min(x0, q[0]);
      y0 = Math.min(y0, q[1]);
      x1 = Math.max(x1, q[0]);
      y1 = Math.max(y1, q[1]);
    }
  return [x0, y0, x1, y1];
};
const inPoly = (p: Vec2, poly: Polygon) =>
  pointInRing(p, poly.outer) && !poly.holes.some((h) => pointInRing(p, h));
const meets = (a: [number, number, number, number], b: [number, number, number, number]) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const fmt = (m: number) => m.toFixed(1).replace('.', ',');

export class Harmonizer {
  readonly corrections: Fix[] = [];
  private readonly beds: Bed[];

  constructor(
    rails: RailLine[],
    private readonly roadIndex: RoadIndex,
  ) {
    // Rail at grade only: a line on a bridge stands on its deck.
    this.beds = rails
      .filter((r) => r.grade === 'ground')
      .map((rail) => {
        const cls = rail.kind === 'tram' ? 'tram' : 'rail';
        const polys = bufferPolyline(rail.points, rail.width / 2, false);
        const padded = bufferPolyline(
          rail.points,
          rail.width / 2 + (CITY_CLASSES[cls].margin ?? 0),
          false,
        );
        return { rail, cls, polys, padded, box: boxOf(padded) };
      });
  }

  private record(
    rule: string,
    fix: Omit<Fix, 'id' | 'note' | 'rule' | 'kind'> & { kind: Fix['kind']; note?: string },
  ): Fix {
    const def = RULE_BY_ID[rule];
    const f: Fix = {
      id: `${rule}:${fix.targetId}:${this.corrections.length}`,
      note: fix.note ?? def?.constraint ?? rule,
      rule,
      ...fix,
    };
    this.corrections.push(f);
    return f;
  }

  private bedAt(p: Vec2, padded = false): Bed | null {
    for (const b of this.beds) {
      if (p[0] < b.box[0] || p[0] > b.box[2] || p[1] < b.box[1] || p[1] > b.box[3]) continue;
      if ((padded ? b.padded : b.polys).some((q) => inPoly(p, q))) return b;
    }
    return null;
  }

  private bedsNear(box: [number, number, number, number]): Bed[] {
    return this.beds.filter((b) => meets(b.box, box));
  }

  // ── elevation ──────────────────────────────────────────────────────────

  /**
   * What lies under a point of a deck and the free height it needs (the most
   * demanding of: a rail bed, a ground carriageway, a ground path). `skip`:
   * roads the deck itself lands on (its ramps run down onto them).
   */
  envelopeAt(p: Vec2, skip: (roadId: string) => boolean): Envelope | null {
    let best: Envelope | null = null;
    const take = (e: Envelope) => {
      if (!best || e.clearance > best.clearance) best = e;
    };
    const bed = this.bedAt(p);
    if (bed)
      take({
        clearance: CITY_CLASSES[bed.cls].clearance ?? 0,
        cls: bed.cls,
        ref: bed.rail.ref,
        rule: bed.cls === 'tram' ? 'clearance.bridge-tram' : 'clearance.bridge-rail',
      });
    const road = this.roadIndex.covering(p, (r) =>
      r.grade === 'ground' && !skip(r.id) ? r.width / 2 : 0,
    );
    if (road) {
      const vehicular = isVehicular(road.cls);
      take({
        clearance: CITY_CLASSES[vehicular ? 'carriageway' : 'path'].clearance ?? 0,
        cls: vehicular ? 'carriageway' : 'path',
        ref: road.ref ?? road.id,
        rule: vehicular ? 'clearance.bridge-road' : 'clearance.bridge-path',
      });
    }
    return best;
  }

  /** A pier column may not stand here (rule pier.rail). */
  blocksPier(p: Vec2): boolean {
    return this.bedAt(p, true) !== null;
  }

  /** Records a deck raised over what it crosses (rules clearance.*). */
  deckRaised(
    roadId: string,
    at: Vec2,
    e: Envelope,
    before: number,
    after: number,
    resolved: boolean,
  ): void {
    const what = CITY_CLASSES[e.cls].label.toLocaleLowerCase('tr-TR');
    this.record(e.rule, {
      kind: resolved ? 'clearance' : 'needs-review',
      action: resolved ? 'raise' : 'flag',
      targetId: roadId,
      otherId: e.ref,
      at,
      removedArea: 0,
      removed: [],
      height: 0,
      baseZ: 0,
      note: resolved
        ? `Köprü ${what} üstünden geçiyordu: alt açıklık ${fmt(before)} m → ${fmt(after)} m (en az ${fmt(e.clearance)} m)`
        : `Köprü ${what} üstünde ${fmt(after)} m açıklıkta kaldı (en az ${fmt(e.clearance)} m); rampa sığmadı, incelenmeli`,
    });
  }

  // ── structures ─────────────────────────────────────────────────────────

  /**
   * Buildings against rail beds (building.rail / building.tram): cut back to
   * the bed and its margin; what is left too small goes. A raised hall over
   * the tracks (station) and a platform canopy stay.
   */
  structures(buildings: Building[]): Building[] {
    if (!this.beds.length) return buildings;
    const out: Building[] = [];
    for (const b of buildings) {
      const near = this.bedsNear(boxOf([b.footprint]));
      // A hall over the tracks: mapped as raised (layer ≥ 1), or a station the
      // bed runs through (over 30 % of it) — a station beside the line, just
      // touched by it, is cut like any building.
      if (near.length && (b.raised || b.station)) {
        const share =
          intersection(
            [b.footprint],
            near.flatMap((n) => n.polys),
          ).reduce((s, p) => s + polygonArea(p), 0) / Math.max(1, b.area);
        if (b.raised || share > STATION_SPAN) {
          this.elevate(b, near);
          out.push(b);
          continue;
        }
      }
      if (!near.length || b.form === 'canopy') {
        out.push(b);
        continue;
      }
      const padded = near.flatMap((n) => n.padded);
      const removed = intersection([b.footprint], padded);
      const area = removed.reduce((s, p) => s + polygonArea(p), 0);
      if (area < MIN_OVERLAP) {
        out.push(b);
        continue;
      }
      const hit = near.find((n) => intersection([b.footprint], n.padded).length) ?? near[0];
      const rule = hit.cls === 'tram' ? 'building.tram' : 'building.rail';
      const pieces = difference([b.footprint], padded).sort(
        (x, y) => polygonArea(y) - polygonArea(x),
      );
      const keep = pieces[0];
      const keptArea = keep ? polygonArea(keep) : 0;
      const gone = keptArea < MIN_BUILDING;
      const fix = this.record(rule, {
        kind: 'rail-overlap',
        action: gone ? 'remove' : 'cut',
        targetId: b.id,
        otherId: hit.rail.ref,
        removed: gone ? [b.footprint] : [...removed, ...pieces.slice(1)],
        removedArea: gone ? b.area : b.area - keptArea,
        height: b.topZ - b.baseZ,
        baseZ: b.baseZ,
        note: gone
          ? `Bina ${CITY_CLASSES[hit.cls].label.toLocaleLowerCase('tr-TR')} yatağının üstündeydi; kalan parça çok küçük, kaldırıldı`
          : `Bina ${CITY_CLASSES[hit.cls].label.toLocaleLowerCase('tr-TR')} yatağına taşıyordu; yatak ve güvenlik payı kadar kesildi`,
      });
      if (gone) continue;
      b.footprint = keep;
      b.area = keptArea;
      b.fixIds.push(fix.id);
      // The front edge index refers to the old ring: the longest edge now.
      const ring = keep.outer;
      let longest = 0;
      let len = -1;
      ring.forEach((p, k) => {
        const q = ring[(k + 1) % ring.length];
        const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (l > len) {
          len = l;
          longest = k;
        }
      });
      if (b.facades[0]) b.facades[0] = { ...b.facades[0], edge: longest, length: len };
      out.push(b);
    }
    return out;
  }

  /**
   * A hall over the tracks (building.raised): its lowest floor is lifted
   * clear of the envelope of what it spans, and it stands on columns placed
   * every ~8 m inside its footprint, none on a bed or a carriageway.
   */
  private elevate(b: Building, near: Bed[]): void {
    const spanned = near.filter((n) => intersection([b.footprint], n.polys).length);
    if (!spanned.length) return;
    const need = Math.max(...spanned.map((n) => CITY_CLASSES[n.cls].clearance ?? 0));
    // Rails lie on the ground under the hall: the envelope from the highest ground under it.
    const ground = b.floorZ - b.plinth;
    const underside = Math.max(b.floorZ, ground + need + 0.6);
    const lift = underside - b.floorZ;
    if (lift <= 0.05) return;
    b.floorZ += lift;
    b.topZ += lift;
    b.plinth = 0;
    b.underside = underside;
    // Columns on an 8 m grid along the footprint's axis.
    const ring = b.footprint.outer;
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    const cols: Vec2[] = [];
    for (let x = Math.min(...xs) + 1.5; x <= Math.max(...xs) - 1.5; x += 8)
      for (let y = Math.min(...ys) + 1.5; y <= Math.max(...ys) - 1.5; y += 8) {
        const p: Vec2 = [x, y];
        if (!inPoly(p, b.footprint) || this.bedAt(p, true)) continue;
        if (
          this.roadIndex.covering(p, (r) =>
            r.grade === 'ground' && isVehicular(r.cls) ? r.width / 2 + 0.6 : 0,
          )
        )
          continue;
        cols.push(p);
      }
    b.columns = cols;
    this.record('building.raised', {
      kind: 'clearance',
      action: 'elevate',
      targetId: b.id,
      otherId: spanned[0].rail.ref,
      at: ringCentroid(ring),
      removed: [],
      removedArea: 0,
      height: 0,
      baseZ: 0,
      note: `Hol ${CITY_CLASSES[spanned[0].cls].label.toLocaleLowerCase('tr-TR')} üstünde: alt kotu ${fmt(underside - ground)} m'ye kaldırıldı, ${cols.length} kolon üstünde`,
    });
  }

  // ── surfaces ───────────────────────────────────────────────────────────

  /**
   * One surface per spot (surface.rail): under a rail bed nothing else is
   * drawn — the bed is the surface. The carriageway's asphalt stays (a level
   * crossing; a tram running in the street lies over it), as do the
   * airfield's.
   */
  surfaces(surfaces: Surface[]): Surface[] {
    if (!this.beds.length) return surfaces;
    const keep = new Set<SurfaceKind>(['asphalt', 'airfield']);
    const beds = this.beds.flatMap((b) => b.polys);
    return surfaces.map((sf) => {
      if (keep.has(sf.kind) || !sf.polygons.length) return sf;
      const removed = intersection(sf.polygons, beds);
      const area = removed.reduce((s, p) => s + polygonArea(p), 0);
      if (area < 1) return sf;
      this.record('surface.rail', {
        kind: 'surface-cut',
        action: 'cut',
        targetId: `surface:${sf.kind}`,
        removed,
        removedArea: area,
        height: 0.3,
        baseZ: 0,
        at: ringCentroid(removed[0].outer),
        note: `Ray yatağının altında kalan ${sf.kind} yüzeyi kesildi (${Math.round(area)} m²)`,
      });
      return { ...sf, polygons: difference(sf.polygons, beds) };
    });
  }

  // ── paint ──────────────────────────────────────────────────────────────

  /** No road or path paint on a rail bed (marking.rail); runways keep theirs. */
  paint(markings: Marking[]): Marking[] {
    if (!this.beds.length) return markings;
    const out: Marking[] = [];
    let cut = 0;
    let at: Vec2 | undefined;
    for (const m of markings) {
      if (m.kind.startsWith('runway') || m.kind.startsWith('taxiway')) {
        out.push(m);
        continue;
      }
      let run: Vec2[] = [];
      let dropped = false;
      for (const p of m.points as Vec2[]) {
        if (this.bedAt(p)) {
          dropped = true;
          at ??= p;
          if (run.length >= 2) out.push({ ...m, points: run });
          run = [];
        } else run.push(p);
      }
      if (run.length >= 2) out.push({ ...m, points: run });
      if (dropped) cut++;
    }
    if (cut)
      this.record('marking.rail', {
        kind: 'marking-cut',
        action: 'cut',
        targetId: 'markings',
        at,
        removed: [],
        removedArea: 0,
        height: 0,
        baseZ: 0,
        note: `Ray yatağının üstüne düşen ${cut} yol / yaya çizgisi kesildi`,
      });
    return out;
  }

  // ── furniture ──────────────────────────────────────────────────────────

  /**
   * Nothing stands on a rail bed (furniture.rail, tree.rail, fence.rail):
   * mapped poles, stops and cabinets move just outside the bed and its
   * margin, on their side of the line; generated ones and trees go; walls
   * and fences are cut where they cross.
   */
  furniture(props: Prop[], fences: Fence[]): { props: Prop[]; fences: Fence[] } {
    if (!this.beds.length) return { props, fences };
    const out: Prop[] = [];
    let moved = 0;
    let removed = 0;
    let at: Vec2 | undefined;
    for (const p of props) {
      if (p.buildingId) {
        out.push(p);
        continue;
      }
      const q: Vec2 = [p.position[0], p.position[1]];
      const bed = this.bedAt(q, true);
      if (!bed) {
        out.push(p);
        continue;
      }
      at ??= q;
      if (p.provenance !== 'observed' || p.kind === 'tree' || p.kind === 'gate') {
        removed++;
        continue;
      }
      const to = this.outside(q, bed);
      if (!to) {
        removed++;
        continue;
      }
      p.position = [to[0], to[1], p.position[2]];
      moved++;
      out.push(p);
    }
    if (moved || removed)
      this.record('furniture.rail', {
        kind: moved ? 'prop-moved' : 'prop-removed',
        action: moved ? 'move' : 'remove',
        targetId: 'props',
        at,
        removed: [],
        removedArea: 0,
        height: 0,
        baseZ: 0,
        note: `Ray yatağındaki donatı: ${moved} nesne yatağın dışına taşındı, ${removed} nesne (ağaç / üretilmiş) kaldırıldı`,
      });

    const outFences: Fence[] = [];
    let fenceCuts = 0;
    for (const f of fences) {
      const pts = densify(f.points as Vec2[], 1);
      let run: Vec2[] = [];
      let crossed = false;
      for (const p of pts) {
        if (this.bedAt(p, true)) {
          crossed = true;
          if (run.length >= 2) outFences.push({ ...f, points: run });
          run = [];
        } else run.push(p);
      }
      if (!crossed) {
        outFences.push(f);
        continue;
      }
      if (run.length >= 2) outFences.push({ ...f, points: run });
      fenceCuts++;
    }
    if (fenceCuts)
      this.record('fence.rail', {
        kind: 'fence-cut',
        action: 'cut',
        targetId: 'fences',
        removed: [],
        removedArea: 0,
        height: 0,
        baseZ: 0,
        note: `Ray hattını kesen ${fenceCuts} duvar / çit hattın iki yanında bırakıldı`,
      });
    return { props: out, fences: outFences };
  }

  /** The nearest point just outside a bed and its margin, on the point's side of the line. */
  private outside(p: Vec2, bed: Bed): Vec2 | null {
    const pts = bed.rail.points;
    let best: { point: Vec2; d: number; a: Vec2; b: Vec2 } | null = null;
    for (let k = 1; k < pts.length; k++) {
      const c = closestOnSegment(p, pts[k - 1], pts[k]);
      if (!best || c.d < best.d) best = { point: c.point, d: c.d, a: pts[k - 1], b: pts[k] };
    }
    if (!best) return null;
    const dx = best.b[0] - best.a[0];
    const dy = best.b[1] - best.a[1];
    const l = Math.hypot(dx, dy) || 1;
    let n: Vec2 = [-dy / l, dx / l];
    if ((p[0] - best.point[0]) * n[0] + (p[1] - best.point[1]) * n[1] < 0) n = [-n[0], -n[1]];
    const reach = bed.rail.width / 2 + (CITY_CLASSES[bed.cls].margin ?? 0) + 0.6;
    const to: Vec2 = [best.point[0] + n[0] * reach, best.point[1] + n[1] * reach];
    return this.bedAt(to, true) ? null : to;
  }
}

function densify(points: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [points[0]];
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1];
    const b = points[k];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let i = 1; i <= n; i++)
      out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  }
  return out;
}
