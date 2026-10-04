import { TWIN_MEDIAN } from './cuttings';
import { closestOnSegment, dist, pointInRing } from './geo';
import { GroundModel, STREET_SURFACES, type Support } from './ground-model';
import { bufferPolyline, difference, intersection, offset, polygonArea } from './poly';
import { PROP_RADIUS, carriageReach, poleReach } from './props';
import { isVehicular } from './roads';
import { GridIndex, RoadIndex } from './spatial';
import type {
  Bridge,
  CityModel,
  Fence,
  FenceStyle,
  Polygon,
  Prop,
  PropKind,
  Road,
  Vec2,
  Vec3,
} from './types';

/**
 * Rules every compiled tile must keep — the contract of each class with the
 * ones it meets. `validateCity` counts the violations per rule (with a few
 * sample locations); tests drive the counts to zero and the viewer can mark
 * the samples. Rule ids are stable: they name what is wrong, not where.
 */
export const RULES = {
  // Streets
  'street.sliver': 'İki yolun kaldırımı arasında kalan ince şerit / boşluk (< 3 m)',
  'street.kerb-step': 'Birleşen yolların kaldırım genişliği basamak yapıyor (> 0,3 m)',
  'street.kerb-notch':
    'Kaldırım kenarında sivri girinti / çıkıntı (> 0,3 m, kısa kenarlı keskin köşe)',
  'crossing.in-cut': 'Yaya geçidi hendek / tünel ağzı kapağı içinde',
  // Props
  'prop.support': 'Üretilen nesne uygun olmayan zeminde (ağaç asfaltta, direk çimde …)',
  'data.prop-support': 'Veriden gelen nesne uygun olmayan zeminde (kaynak veri hatası)',
  'prop.height': 'Nesne zeminine oturmuyor (havada ya da gömülü, > 8 cm)',
  'prop.fence': 'Nesne bahçe duvarı / çitin içinde',
  'pole.kerb': 'Direk / lamba bordüre 0,4 m’den yakın ya da yolda',
  'tree.over-cut': 'Ağaç tacı hendek / tünel ağzının üstüne taşıyor',
  // Seams
  'seam.trench-rim': 'Kaldırım / yol hendek duvarının içine giriyor',
  'seam.wall-top': 'Hendek duvarının yanındaki zemin duvar tepesinden yüksek',
  'seam.trench-end': 'Hendek yolu açık uçta sokakla aynı yükseklikte / genişlikte değil',
  'seam.twin-trench': 'İkiz rampa: iki hendek arası < 4 m ama tek orta duvar altında değil',
  'seam.bridge-end': 'Köprü ucu sokakla aynı yükseklikte / genişlikte değil',
  'bridge.barrier-road': 'Sokak seviyesindeki köprünün korkuluğu başka bir yolun şeridinde',
  // Structures
  'building.structure': 'Bina köprü tabliyesi / ayağı / hendekle kesişiyor',
  'fence.street': 'Bahçe duvarı / çit yola ya da kaldırıma taşıyor',
  'pier.carriageway': 'Köprü ayağı taşıt yolunda',
} as const;

export type RuleId = keyof typeof RULES;

export interface Violation {
  rule: RuleId;
  /** Model coordinates (x east, y north). */
  at: Vec2;
  note?: string;
}

export interface ValidationReport {
  counts: Partial<Record<RuleId, number>>;
  /** Up to SAMPLES_PER_RULE locations per rule. */
  samples: Violation[];
  ms: number;
}

const SAMPLES_PER_RULE = 12;

/** Body width of a garden boundary, by style (the viewer draws them this wide). */
export const FENCE_WIDTH: Record<FenceStyle, number> = {
  'wall-rail': 0.3,
  wall: 0.28,
  stone: 0.46,
  hedge: 0.5,
  mesh: 0.18,
};

/** Where each prop kind may stand (the class contract of street props). */
export const SUPPORTS: Partial<Record<PropKind, ReadonlySet<Support>>> = (() => {
  const hard: Support[] = ['sidewalk', 'island', 'paving', 'path', 'concrete', 'yard', 'parking'];
  const set = (...s: Support[]) => new Set(s);
  return {
    tree: set('ground', 'island', 'yard', 'sidewalk', 'paving', 'concrete'),
    'street-lamp': set(...hard, 'trench'),
    'traffic-signal': set(...hard),
    'power-pole': set(...hard, 'ground'),
    'bus-stop': set('sidewalk', 'paving', 'island'),
    bench: set(...hard, 'ground', 'playground'),
    'waste-basket': set(...hard, 'ground', 'playground'),
    car: set('parking', 'asphalt'),
    booth: set('parking', 'asphalt', 'concrete', 'sidewalk', 'yard'),
    'barrier-arm': set('parking', 'asphalt', 'concrete', 'sidewalk'),
    swing: set('playground'),
    slide: set('playground'),
    seesaw: set('playground'),
    climber: set('playground'),
    gate: set('ground', 'yard', 'sidewalk', 'concrete', 'paving', 'island'),
  };
})();

const POLES: ReadonlySet<PropKind> = new Set(['street-lamp', 'traffic-signal', 'power-pole']);

/** Garden boundary segments in a grid (with their body half-width). */
export function fenceIndex(fences: Fence[]): GridIndex<{ a: Vec2; b: Vec2; half: number }> {
  const index = new GridIndex<{ a: Vec2; b: Vec2; half: number }>(10);
  for (const f of fences) {
    const half = FENCE_WIDTH[f.style] / 2;
    for (let k = 1; k < f.points.length; k++) {
      const a = f.points[k - 1];
      const b = f.points[k];
      index.insert(
        { a, b, half },
        Math.min(a[0], b[0]) - 3,
        Math.min(a[1], b[1]) - 3,
        Math.max(a[0], b[0]) + 3,
        Math.max(a[1], b[1]) + 3,
      );
    }
  }
  return index;
}

/** Whether a ground prop stands in a garden wall / fence (gates stand in their gap). */
export function inFence(p: Prop, fences: GridIndex<{ a: Vec2; b: Vec2; half: number }>): boolean {
  if (p.kind === 'gate' || p.buildingId) return false;
  const q: Vec2 = [p.position[0], p.position[1]];
  const r = Math.max(0.15, (PROP_RADIUS[p.kind] ?? 0) * p.scale * (p.kind === 'tree' ? 0.4 : 1));
  for (const f of fences.query(q[0], q[1], q[0], q[1])) {
    if (closestOnSegment(q, f.a, f.b).d < r + f.half) return true;
  }
  return false;
}

/** Checks a compiled tile against RULES. Cheap enough to run on every compile. */
export function validateCity(model: CityModel): ValidationReport {
  const started = Date.now();
  const counts: Partial<Record<RuleId, number>> = {};
  const samples: Violation[] = [];
  const b0 = model.bounds;
  const add = (rule: RuleId, at: Vec2, note?: string) => {
    // Each tile answers for its own core (the neighbour counts its margin).
    if (at[0] < b0.minX || at[0] >= b0.maxX || at[1] < b0.minY || at[1] >= b0.maxY) return;
    const n = (counts[rule] ?? 0) + 1;
    counts[rule] = n;
    if (n <= SAMPLES_PER_RULE)
      samples.push({ rule, at: [at[0], at[1]], ...(note ? { note } : {}) });
  };
  const ground = new GroundModel(model);
  const groundRoads = model.roads.filter((r) => r.grade === 'ground');
  const roadIndex = new RoadIndex(groundRoads);
  const core = model.bounds;
  const inCore = (p: Vec2) =>
    p[0] >= core.minX && p[0] < core.maxX && p[1] >= core.minY && p[1] < core.maxY;

  streetRules(model, ground, groundRoads, add);
  for (const c of model.crossings) {
    if (ground.cut.inTrench(c.center[0], c.center[1]) || ground.cut.inLid(c.center[0], c.center[1]))
      add('crossing.in-cut', c.center);
  }

  // ─── Props ────────────────────────────────────────────────────────────
  const fenceSegs = fenceIndex(model.fences ?? []);
  const cutPrints: Polygon[] = [
    ...(model.terrainCut?.trenches ?? []),
    ...(model.terrainCut?.lids ?? []),
  ];
  const cutIndex = new GridIndex<Polygon>(30);
  for (const p of cutPrints) {
    const b = boundsOf(p);
    cutIndex.insert(p, b[0], b[1], b[2], b[3]);
  }
  for (const p of model.props) {
    if (p.buildingId) continue;
    const q: Vec2 = [p.position[0], p.position[1]];
    if (!inCore(q)) continue;
    const allowed = SUPPORTS[p.kind];
    const s = ground.surfaceAt(q[0], q[1]);
    if (allowed && !allowed.has(s.support))
      add(
        p.provenance === 'observed' ? 'data.prop-support' : 'prop.support',
        q,
        `${p.kind} on ${s.support}`,
      );
    if (Math.abs(p.position[2] - s.z) > 0.08)
      add('prop.height', q, `${p.kind} ${(p.position[2] - s.z).toFixed(2)} m`);
    const r = (PROP_RADIUS[p.kind] ?? 0) * p.scale;
    if (inFence(p, fenceSegs)) add('prop.fence', q, p.kind);
    if (POLES.has(p.kind) && p.provenance !== 'observed') {
      const hit = roadIndex.covering(q, poleReach);
      if (hit) add('pole.kerb', q, p.kind);
    }
    if (p.kind === 'tree' && s.support !== 'trench') {
      for (const c of cutIndex.query(q[0] - r, q[1] - r, q[0] + r, q[1] + r)) {
        if (distToPolygon(q, c) < r * 0.8) {
          add('tree.over-cut', q);
          break;
        }
      }
    }
  }

  seamRules(model, ground, groundRoads, add);

  // ─── Structures ───────────────────────────────────────────────────────
  const decks = (model.bridges ?? []).map((br) => ({
    br,
    print: bufferPolyline(
      br.path.map((q) => [q[0], q[1]] as Vec2),
      br.width / 2,
      false,
    ),
  }));
  for (const b of model.buildings) {
    const bb = boundsOf(b.footprint);
    let hit = false;
    for (const d of decks) {
      const db = boundsOf(d.print[0] ?? b.footprint);
      if (db[0] > bb[2] || db[2] < bb[0] || db[1] > bb[3] || db[3] < bb[1]) continue;
      const deckZ = Math.min(...d.br.path.map((q) => q[2]));
      if (deckZ - 2 > b.topZ) continue;
      if (polygonArea(intersection([b.footprint], d.print)[0] ?? { outer: [], holes: [] }) > 1) {
        hit = true;
        break;
      }
      for (const pier of d.br.piers) {
        if (pointInRing(pier.at, b.footprint.outer)) {
          hit = true;
          break;
        }
      }
    }
    if (!hit) {
      for (const c of cutIndex.query(bb[0], bb[1], bb[2], bb[3])) {
        const area = intersection([b.footprint], [c]).reduce((s, p) => s + polygonArea(p), 0);
        if (area > 1) {
          hit = true;
          break;
        }
      }
    }
    if (hit) add('building.structure', b.footprint.outer[0]);
  }
  for (const f of model.fences ?? []) {
    const half = FENCE_WIDTH[f.style] / 2;
    for (let k = 1; k < f.points.length; k++) {
      const a = f.points[k - 1];
      const b = f.points[k];
      const l = dist(a, b) || 1;
      const n: Vec2 = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
      const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const bad = [-half, half].some((o) => {
        const sp = ground.supportAt(m[0] + n[0] * o, m[1] + n[1] * o);
        return sp === 'asphalt' || sp === 'sidewalk' || sp === 'island';
      });
      if (bad) {
        add('fence.street', m);
        break;
      }
    }
  }
  for (const d of decks) {
    for (const pier of d.br.piers) {
      const n: Vec2 = [-pier.dir[1], pier.dir[0]];
      for (const o of pier.columns) {
        const c: Vec2 = [pier.at[0] + n[0] * o, pier.at[1] + n[1] * o];
        if (roadIndex.covering(c, carriageReach)) add('pier.carriageway', c);
      }
    }
  }

  return { counts, samples, ms: Date.now() - started };
}

/** Kerb-line rules on the city blocks (the land between street corridors). */
function streetRules(
  model: CityModel,
  ground: GroundModel,
  roads: Road[],
  add: (rule: RuleId, at: Vec2, note?: string) => void,
): void {
  // Slivers: parts of a block thinner than 3 m (an opening by 1.5 m removes them).
  for (const b of model.blocks) {
    const opened = offset(offset([b.polygon], -1.5, 'round'), 1.5, 'round');
    for (const piece of difference([b.polygon], opened)) {
      const area = polygonArea(piece);
      // Opening again leaves arc-approximation crumbs of ~1 m².
      if (area < 1.5) continue;
      add('street.sliver', centroidOf(piece), `${area.toFixed(1)} m²`);
    }
    // Notches: sharp corners between short edges along the kerb line.
    for (const ring of [b.polygon.outer, ...b.polygon.holes]) {
      const n = ring.length;
      for (let k = 0; k < n; k++) {
        const p0 = ring[(k + n - 1) % n];
        const p1 = ring[k];
        const p2 = ring[(k + 1) % n];
        const a = dist(p0, p1);
        const c = dist(p1, p2);
        if (a > 2 || c > 2 || a < 0.05 || c < 0.05) continue;
        const cos =
          ((p0[0] - p1[0]) * (p2[0] - p1[0]) + (p0[1] - p1[1]) * (p2[1] - p1[1])) / (a * c);
        // Visible ones only: the corner stands out more than 0.3 m from its neighbours' line.
        if (cos > Math.cos((100 * Math.PI) / 180) && closestOnSegment(p1, p0, p2).d > 0.3)
          add('street.kerb-notch', p1);
      }
    }
  }
  // Kerb steps: where two corridor roads meet end to end with different
  // widths, the kerb line must carry on — 0.3 m (the step allowed) inside the
  // wider road's kerb, over the first metres of the narrower road, there is
  // street surface.
  const key = (p: Vec2) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;
  const ends = new Map<string, { road: Road; start: boolean }[]>();
  for (const r of roads) {
    if (!r.formsBlocks) continue;
    const c = r.centerline;
    for (const [p, start] of [
      [c[0], true],
      [c[c.length - 1], false],
    ] as [Vec2, boolean][]) {
      const k = key(p);
      ends.set(k, [...(ends.get(k) ?? []), { road: r, start }]);
    }
  }
  const STREET = new Set<Support>(['sidewalk', 'asphalt', 'island', 'paving']);
  for (const list of ends.values()) {
    if (list.length !== 2) continue;
    const half = (r: Road) => r.width / 2 + r.sidewalk;
    const [a, b] = list;
    if (Math.abs(half(a.road) - half(b.road)) <= 0.3) continue;
    const [wide, narrow] = half(a.road) > half(b.road) ? [a, b] : [b, a];
    const c = narrow.start ? narrow.road.centerline : [...narrow.road.centerline].reverse();
    if (c.length < 2 || dist(c[0], c[1]) < 3.5) continue;
    const l = dist(c[0], c[1]);
    const d: Vec2 = [(c[1][0] - c[0][0]) / l, (c[1][1] - c[0][1]) / l];
    const n: Vec2 = [-d[1], d[0]];
    const o = half(wide.road) - 0.3;
    const open = [0.5, 1.5, 3].some((s) =>
      [1, -1].some((side) => {
        const x = c[0][0] + d[0] * s + n[0] * side * o;
        const y = c[0][1] + d[1] * s + n[1] * side * o;
        return !STREET.has(ground.supportAt(x, y));
      }),
    );
    if (open)
      add(
        'street.kerb-step',
        c[0],
        `${half(wide.road).toFixed(1)} / ${half(narrow.road).toFixed(1)} m`,
      );
  }
}

/** Seams where a structure meets the street. */
function seamRules(
  model: CityModel,
  ground: GroundModel,
  roads: Road[],
  add: (rule: RuleId, at: Vec2, note?: string) => void,
): void {
  const cuttings = model.cuttings ?? [];
  const roadIndex = new RoadIndex(roads);
  for (const c of cuttings) {
    const pts = c.path.map((q) => [q[0], q[1]] as Vec2);
    const half = c.width / 2;
    // Rim: street surface in the 0.4 m wall band outside the footprint
    // (sampled every 0.5 m along both wall lines, metres overlapped).
    let overlap = 0;
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1];
      const b = pts[k];
      const l = dist(a, b);
      if (l < 1e-6) continue;
      const n: Vec2 = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
      for (let t = 0; t < l; t += 0.5) {
        for (const side of [1, -1]) {
          const x = a[0] + ((b[0] - a[0]) * t) / l + n[0] * side * (half + 0.2);
          const y = a[1] + ((b[1] - a[1]) * t) / l + n[1] * side * (half + 0.2);
          const sp = ground.supportAt(x, y);
          if (sp === 'asphalt' || sp === 'sidewalk' || sp === 'island') overlap += 0.5;
        }
      }
    }
    if (overlap > 1) add('seam.trench-rim', pts[0], `${overlap.toFixed(1)} m`);
    // Ground beside the walls below their tops.
    if (c.rimL && c.rimR) {
      let over = 0;
      c.path.forEach((q, k) => {
        const a = c.path[Math.max(0, k - 1)];
        const b = c.path[Math.min(c.path.length - 1, k + 1)];
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const n: Vec2 = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
        for (const [side, rim] of [
          [1, c.rimL![k]],
          [-1, c.rimR![k]],
        ] as [number, number][]) {
          const x = q[0] + n[0] * side * (half + 0.6);
          const y = q[1] + n[1] * side * (half + 0.6);
          if (ground.cut.inTrench(x, y)) continue;
          if (ground.surfaceAt(x, y).z > rim + 0.02) over++;
        }
      });
      if (over) add('seam.wall-top', pts[0], `${over} nokta`);
    }
    // Open end: the trench road meets the street at its height and width.
    const end = c.path[c.path.length - 1];
    const e: Vec2 = [end[0], end[1]];
    const dz = end[2] - ground.streetAt(e[0], e[1]);
    const hit = roadIndex.nearest(e, 3, (r) => r.grade === 'ground');
    const dw = hit ? Math.abs((c.carriageway ?? c.width) - hit.road.width) : 0;
    if (Math.abs(dz) > 0.05 || dw > 0.3)
      add('seam.trench-end', e, `Δz ${dz.toFixed(2)} m, Δgenişlik ${dw.toFixed(1)} m`);
  }
  // Twin ramps: a strip narrower than TWIN_MEDIAN between two trenches lies
  // inside the merged footprint (under the one median wall), sampled at its
  // middle, one count per pair. Path ends are left out: the closing leaves
  // the open end of the strip (≤ TWIN_MEDIAN / 2 deep) and the median wall
  // runs on to the end there anyway.
  for (let i = 0; i < cuttings.length; i++) {
    for (let j = i + 1; j < cuttings.length; j++) {
      const a = cuttings[i];
      const b = cuttings[j];
      let open: { at: Vec2; gap: number } | null = null;
      for (const p of a.path.slice(1, -1)) {
        let best = { d: Infinity, at: [0, 0] as Vec2 };
        for (let k = 1; k < b.path.length; k++) {
          const cl = closestOnSegment(
            [p[0], p[1]],
            [b.path[k - 1][0], b.path[k - 1][1]],
            [b.path[k][0], b.path[k][1]],
          );
          if (cl.d < best.d) best = { d: cl.d, at: cl.point };
        }
        const gap = best.d - a.width / 2 - b.width / 2;
        if (gap <= 0 || gap >= TWIN_MEDIAN) continue;
        // Middle of the strip, on the line between the two centrelines.
        const f = (a.width / 2 + gap / 2) / best.d;
        const m: Vec2 = [p[0] + (best.at[0] - p[0]) * f, p[1] + (best.at[1] - p[1]) * f];
        if (!ground.cut.inTrench(m[0], m[1]) && (!open || gap < open.gap)) open = { at: m, gap };
      }
      if (open) add('seam.twin-trench', open.at, `${open.gap.toFixed(2)} m`);
    }
  }
  for (const br of model.bridges ?? []) {
    bridgeEnds(br, model.bridges ?? [], ground, roadIndex, add);
    if (barrierOnRoad(br, ground).length)
      add('bridge.barrier-road', [br.path[0][0], br.path[0][1]]);
  }
}

/**
 * Points of a deck's barrier lines that stand on another road's carriageway
 * at street level (a low bridge or culvert at a junction): there the barrier
 * must stop. Returns the barrier sample points (deck path index, side).
 */
export function barrierOnRoad(br: Bridge, ground: GroundModel): { k: number; side: 1 | -1 }[] {
  const out: { k: number; side: 1 | -1 }[] = [];
  const p = br.path;
  const o = br.width / 2 - 0.2;
  for (let k = 0; k < p.length; k++) {
    const a = p[Math.max(0, k - 1)];
    const b = p[Math.min(p.length - 1, k + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const n: Vec2 = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
    for (const side of [1, -1] as const) {
      const x = p[k][0] + n[0] * o * side;
      const y = p[k][1] + n[1] * o * side;
      if (p[k][2] - ground.streetAt(x, y) > 2) continue;
      if (ground.supportAt(x, y) === 'asphalt') out.push({ k, side });
    }
  }
  return out;
}

/** Street land a deck end may meet: the street surfaces and footpaths. */
const LANDING = new Set<Support>([...STREET_SURFACES, 'path']);

function bridgeEnds(
  br: Bridge,
  decks: Bridge[],
  ground: GroundModel,
  roads: RoadIndex,
  add: (rule: RuleId, at: Vec2, note?: string) => void,
): void {
  const p = br.path;
  if (p.length < 3) return;
  const onDeck = (q: Vec2) =>
    decks.some(
      (d) =>
        d !== br &&
        d.path.some(
          (a, k) =>
            k > 0 &&
            closestOnSegment(q, [d.path[k - 1][0], d.path[k - 1][1]], [a[0], a[1]]).d < d.width / 2,
        ),
    );
  // Each end: the deck runs 1–1.5 m on past its road's end (p[0] / p[n-1]);
  // the street it lands on ends at the original end (p[1] / p[n-2]).
  for (const [e, o] of [
    [p[0], p[1]],
    [p[p.length - 1], p[p.length - 2]],
  ] as [Vec3, Vec3][]) {
    const end: Vec2 = [o[0], o[1]];
    const endsHere = (r: Road) =>
      r.grade === 'ground' &&
      [r.centerline[0], r.centerline[r.centerline.length - 1]].some((q) => dist(q, end) < 2);
    const street = roads.nearest(end, 2, endsHere);
    if (!street) continue; // joins another deck, or leaves the tile
    const dz = e[2] - ground.streetAt(e[0], e[1]);
    if (Math.abs(dz) > 0.1) add('seam.bridge-end', [e[0], e[1]], `Δz ${dz.toFixed(2)} m`);
    // A junction at the deck end: the crossing street's own surface is there.
    const reach = street.road.width / 2 + street.road.sidewalk;
    if (
      roads.nearest(
        end,
        reach,
        (r) => r !== street.road && r.grade === 'ground' && isVehicular(r.cls),
      )
    )
      continue;
    // 2 m out along the street (its own direction from the deck end): the
    // street surface reaches the deck edge, not past it.
    const sc = street.road.centerline;
    const from = dist(sc[0], end) < dist(sc[sc.length - 1], end) ? sc : [...sc].reverse();
    const step = from.find((q) => dist(q, from[0]) > 0.5) ?? from[from.length - 1];
    const l = dist(step, from[0]) || 1;
    const u: Vec2 = [(step[0] - from[0][0]) / l, (step[1] - from[0][1]) / l];
    const q: Vec2 = [from[0][0] + u[0] * 2, from[0][1] + u[1] * 2];
    const n: Vec2 = [-u[1], u[0]];
    const at = (off: number): Vec2 => [q[0] + n[0] * off, q[1] + n[1] * off];
    const onStreet = (off: number) => LANDING.has(ground.supportAt(...at(off)));
    for (const side of [1, -1]) {
      // Street beside the deck too (a twin deck, a median, another corridor):
      // the paving runs on between them, no kerb to meet.
      const far = side * (br.width / 2 + 2);
      if (!onStreet(side * (br.width / 2 + 0.3)) || onDeck(at(far)) || onStreet(far)) {
        if (!onStreet(side * (br.width / 2 - 0.3))) {
          add('seam.bridge-end', q, 'köprü sokaktan geniş');
          break;
        }
        continue;
      }
      add('seam.bridge-end', q, 'kaldırım köprüden geniş');
      break;
    }
  }
}

function boundsOf(p: Polygon): [number, number, number, number] {
  let b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const q of p.outer)
    b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[0]), Math.max(b[3], q[1])];
  return b;
}

function centroidOf(p: Polygon): Vec2 {
  const r = p.outer;
  return [r.reduce((s, q) => s + q[0], 0) / r.length, r.reduce((s, q) => s + q[1], 0) / r.length];
}

function distToPolygon(p: Vec2, poly: Polygon): number {
  if (pointInRing(p, poly.outer) && !poly.holes.some((h) => pointInRing(p, h))) return 0;
  let best = Infinity;
  for (const ring of [poly.outer, ...poly.holes]) {
    for (let k = 0; k < ring.length; k++)
      best = Math.min(best, closestOnSegment(p, ring[k], ring[(k + 1) % ring.length]).d);
  }
  return best;
}
