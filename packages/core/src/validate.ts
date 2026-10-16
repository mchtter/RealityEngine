import { TWIN_MEDIAN } from './cuttings';
import { FENCE_FOOT, fenceProfile } from './fence-profile';
import { closestOnSegment, dist, pointInRing } from './geo';
import { GroundModel, STREET_SURFACES, SURFACE_LIFT, type Support } from './ground-model';
import {
  HAIRLINE,
  bufferPolyline,
  difference,
  intersection,
  meanThickness,
  offset,
  polygonArea,
} from './poly';
import { CUT_TRUNK_CLEAR, PROP_RADIUS, carriageReach, poleReach } from './props';
import { GridIndex, PolygonSet, RoadIndex } from './spatial';
import type {
  Bridge,
  Building,
  CityModel,
  Fence,
  FenceStyle,
  Polygon,
  Prop,
  PropKind,
  Road,
  SurfaceKind,
  Vec2,
  Vec3,
} from './types';
import { UTILITY_SPECS, utilityClashes } from './utilities';

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
  'surface.over-carriageway': 'Kaldırım / ada / taş kaplama taşıt yolunun (asfalt) üstüne biniyor',
  'surface.hairline': 'Kıl inceliğinde yüzey parçası (< 5 cm, koyu çizgi gibi görünür)',
  'crossing.in-cut': 'Yaya geçidi hendek / tünel ağzı kapağı içinde',
  'marking.path-cross':
    'Yürüyüş / bisiklet yolu kenar çizgisi başka bir yolun içinden geçiyor (köşeyi dönmüyor)',
  // Props
  'prop.support': 'Üretilen nesne uygun olmayan zeminde (ağaç asfaltta, direk çimde …)',
  'data.prop-support': 'Veriden gelen nesne uygun olmayan zeminde (kaynak veri hatası)',
  'prop.height': 'Nesne zeminine oturmuyor (havada ya da gömülü, > 8 cm)',
  'prop.fence': 'Nesne bahçe duvarı / çitin içinde',
  'pole.kerb': 'Direk / lamba bordüre 0,4 m’den yakın ya da yolda',
  'tree.over-cut': 'Ağaç gövdesi hendek / tünel ağzı duvarında (kenara < 1 m; taç taşabilir)',
  // Seams
  'seam.trench-rim': 'Kaldırım / yol hendek duvarının içine giriyor',
  'seam.wall-top': 'Hendek duvarının yanındaki zemin duvar tepesinden yüksek',
  'seam.trench-end': 'Hendek yolu açık uçta sokakla aynı yükseklikte / genişlikte değil',
  'seam.twin-trench': 'İkiz rampa: iki hendek arası < 4 m ama tek orta duvar altında değil',
  'seam.bridge-end': 'Köprü ucu sokakla aynı yükseklikte / genişlikte değil',
  'bridge.barrier-road':
    'Sokak seviyesindeki köprünün korkuluğu kesilmeden başka bir yolun şeridinde',
  // Structures
  'building.structure': 'Bina köprü tabliyesi / ayağı / hendekle kesişiyor',
  'fence.street': 'Bahçe duvarı / çit yola ya da kaldırıma taşıyor',
  // Nothing stands in anything else
  'overlap.prop': 'İki nesnenin gövdesi iç içe (ağaç gövdesi, direk, bank, araba …)',
  'overlap.prop-building': 'Nesne bina içinde',
  'overlap.fence': 'İki bahçe duvarı / çit iç içe ya da kesişiyor',
  'overlap.fence-building': 'Bahçe duvarı / çit bina içinden geçiyor',
  'overlap.building': 'İki bina iç içe (> 0,5 m²)',
  'data.overlap': 'Veriden gelen iki nesne iç içe (kaynak veri)',
  'data.road-attr':
    'Yolun genişlik / şerit sayısı verisi sınıfı için olanaksız; varsayılan kullanıldı (kaynak veri)',
  'fence.stub': 'Bahçe duvarı parçası 1,5 m’den kısa (kopuk parça)',
  'fence.gap': 'İki bahçe duvarı arasında kapısız 0,3–2 m boşluk',
  'pier.carriageway': 'Köprü ayağı taşıt yolunda',
  // Buried networks
  'utility.clash': 'İki farklı altyapı hattı kesişiminde duvarlar arası < 0,3 m (çakışma)',
  'utility.cover': 'Boru / kablo üstü örtü derinliği türü için az (gaz < 0,6 m, su < 0,8 m …)',
  'utility.building': 'Ana hat bina altından geçiyor (bağlantı hattı değil)',
  // Everything meets the ground it is drawn on
  'fence.float': 'Bahçe duvarı / çit tabanı ile zemin arasında boşluk (> 3 cm, havada)',
  'building.float': 'Bina duvarının dibi ile zemin arasında boşluk (> 3 cm, havada)',
  'terrain.spike': 'Arazide tek düğümlük sivri tepe / çukur (dört komşusundan > 1,5 m)',
  'junction.paint-inside':
    'Durma / yol ver çizgisi ya da dönüş oku kavşak alanının içinde (kolda olmalı)',
  'junction.stop-on-crossing': 'Durma / yol ver çizgisi yaya geçidinin üstünde',
  'bridge.ground-through': 'Zemin köprü tabliyesinin içinden çıkıyor (tabliye üstünden yüksek)',
  'street.edge-step':
    'Sokak kenarında bordürden yüksek basamak (> 0,5 m): yandaki zemin çukurda ya da sokağın üstünde',
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
    'street-cabinet': set(...hard, 'ground'),
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
  for (const r of model.roads)
    if (r.rejected) {
      const mid = r.centerline[Math.floor(r.centerline.length / 2)];
      const what = [
        r.rejected.width !== undefined ? `genişlik ${r.rejected.width} m` : '',
        r.rejected.lanes !== undefined ? `${r.rejected.lanes} şerit` : '',
      ].filter(Boolean);
      add('data.road-attr', [mid[0], mid[1]], `${r.cls} ${r.ref}: ${what.join(', ')}`);
    }
  overlapRules(model, add);
  for (const sf of model.surfaces)
    for (const p of sf.polygons)
      if (meanThickness(p) < HAIRLINE) add('surface.hairline', centroidOf(p), sf.kind);
  // Street layers never cover the carriageway (they lie above it and hid the road).
  const asphalt = model.surfaces.filter((s) => s.kind === 'asphalt').flatMap((s) => s.polygons);
  for (const sf of model.surfaces) {
    if (sf.kind !== 'sidewalk' && sf.kind !== 'island' && sf.kind !== 'paving') continue;
    for (const piece of intersection(sf.polygons, asphalt)) {
      if (polygonArea(piece) < 1 || meanThickness(piece) < 0.2) continue;
      add(
        'surface.over-carriageway',
        centroidOf(piece),
        `${sf.kind} ${polygonArea(piece).toFixed(0)} m²`,
      );
    }
  }
  for (const c of model.crossings) {
    if (ground.cut.inTrench(c.center[0], c.center[1]) || ground.cut.inLid(c.center[0], c.center[1]))
      add('crossing.in-cut', c.center);
  }
  // Path edge lines run along the path's side; one deep inside the path
  // surface is a line carried on across a joining path.
  const pathInner = new PolygonSet(
    offset(
      model.surfaces.filter((sf) => sf.kind === 'path').flatMap((sf) => sf.polygons),
      -0.5,
    ),
  );
  for (const m of model.markings) {
    if (m.kind !== 'path-edge') continue;
    const hit = m.points.find((p) => inCore(p) && pathInner.contains(p[0], p[1]));
    if (hit) add('marking.path-cross', hit);
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
    if (inFence(p, fenceSegs)) add('prop.fence', q, p.kind);
    if (POLES.has(p.kind) && p.provenance !== 'observed') {
      const hit = roadIndex.covering(q, poleReach);
      if (hit) add('pole.kerb', q, p.kind);
    }
    if (p.kind === 'tree' && s.support !== 'trench') {
      // The trunk, not the crown: a crown over an underpass wall is what trees do.
      const reach = CUT_TRUNK_CLEAR;
      for (const c of cutIndex.query(q[0] - reach, q[1] - reach, q[0] + reach, q[1] + reach)) {
        if (distToPolygon(q, c) < reach) {
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
  // Garden walls run on: no short loose pieces, no small holes between two
  // walls except at a gate.
  const fences = model.fences ?? [];
  const gateAt = new GridIndex<Vec2>(10);
  for (const p of model.props)
    if (p.kind === 'gate')
      gateAt.insert(
        [p.position[0], p.position[1]],
        p.position[0],
        p.position[1],
        p.position[0],
        p.position[1],
      );
  const endAt = new GridIndex<{ p: Vec2; f: number }>(10);
  fences.forEach((f, i) => {
    let len = 0;
    for (let k = 1; k < f.points.length; k++) len += dist(f.points[k - 1], f.points[k]);
    // A piece ending on the core's edge goes on in the neighbouring tile.
    const onEdge = [f.points[0], f.points[f.points.length - 1]].some(
      ([x, y]) =>
        Math.min(
          Math.abs(x - b0.minX),
          Math.abs(x - b0.maxX),
          Math.abs(y - b0.minY),
          Math.abs(y - b0.maxY),
        ) < 0.05,
    );
    if (len < 1.5 && !onEdge) add('fence.stub', f.points[0], `${len.toFixed(1)} m`);
    for (const p of [f.points[0], f.points[f.points.length - 1]])
      endAt.insert({ p, f: i }, p[0], p[1], p[0], p[1]);
  });
  // A free end: one touching no other wall (a joint or a T is not a gap).
  const wallSegs = new GridIndex<{ f: number; a: Vec2; b: Vec2 }>(10);
  fences.forEach((f, i) => {
    for (let k = 1; k < f.points.length; k++) {
      const a = f.points[k - 1];
      const b = f.points[k];
      wallSegs.insert(
        { f: i, a, b },
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.max(a[0], b[0]),
        Math.max(a[1], b[1]),
      );
    }
  });
  const free = (p: Vec2, i: number) =>
    !wallSegs
      .query(p[0] - 0.3, p[1] - 0.3, p[0] + 0.3, p[1] + 0.3)
      .some((sg) => sg.f !== i && closestOnSegment(p, sg.a, sg.b).d < 0.3);
  fences.forEach((f, i) => {
    for (const p of [f.points[0], f.points[f.points.length - 1]]) {
      if (!free(p, i)) continue;
      for (const o of endAt.query(p[0] - 2, p[1] - 2, p[0] + 2, p[1] + 2)) {
        if (o.f <= i || !free(o.p, o.f)) continue;
        const g = dist(p, o.p);
        if (g <= 0.3 || g >= 2) continue;
        const m: Vec2 = [(p[0] + o.p[0]) / 2, (p[1] + o.p[1]) / 2];
        if (gateAt.query(m[0] - 2, m[1] - 2, m[0] + 2, m[1] + 2).some((q) => dist(q, m) < 2))
          continue;
        add('fence.gap', m, `${g.toFixed(2)} m`);
      }
    }
  });
  for (const d of decks) {
    for (const pier of d.br.piers) {
      const n: Vec2 = [-pier.dir[1], pier.dir[0]];
      for (const o of pier.columns) {
        const c: Vec2 = [pier.at[0] + n[0] * o, pier.at[1] + n[1] * o];
        if (roadIndex.covering(c, carriageReach)) add('pier.carriageway', c);
      }
    }
  }

  // ─── Buried networks ──────────────────────────────────────────────────
  const utilities = model.utilities ?? [];
  for (const c of utilityClashes(utilities)) {
    const p = c.a.path[c.ka - 1];
    const q = c.a.path[c.ka];
    const at: Vec2 = [p[0] + (q[0] - p[0]) * c.ta, p[1] + (q[1] - p[1]) * c.ta];
    if (inCore(at)) add('utility.clash', at, `${c.a.kind}/${c.b.kind} ${c.gap.toFixed(2)} m`);
  }
  const footprints = new PolygonSet(model.buildings.map((b) => b.footprint));
  for (const u of utilities) {
    const min = UTILITY_SPECS[u.kind].minCover;
    const shallow = u.path.find(
      (p) =>
        inCore([p[0], p[1]]) &&
        ground.surfaceAt(p[0], p[1]).z - (p[2] + u.diameter / 2) < min - 0.05,
    );
    if (shallow) add('utility.cover', [shallow[0], shallow[1]], u.kind);
    if (u.service) continue;
    const under = u.path.find((p) => inCore([p[0], p[1]]) && footprints.contains(p[0], p[1]));
    if (under) add('utility.building', [under[0], under[1]], u.kind);
  }

  groundContactRules(model, ground, add);
  junctionPaintRules(model, add);

  return { counts, samples, ms: Date.now() - started };
}

/** Largest gap (m) still drawn as touching the ground. */
const CONTACT_GAP = 0.03;
/** Step (m) of the ground checks along fences and building walls. */
const CONTACT_STEP = 0.5;
/** A step (m) between a street surface's top and the ground beside it taller than a kerb. */
const STREET_STEP = 0.5;
/** A terrain node this much (m) above / below all four neighbours is a spike / pit. */
const SPIKE = 1.5;

/**
 * Nothing hangs over the ground it is drawn on: garden boundaries (their
 * drawn profile, sunk by its foot), building walls (from `baseZ - 0.6`, as
 * the viewer draws them) against the drawn ground — terrain, trench and
 * street surfaces with their lifts — on both sides; no single terrain node
 * sticks out of its neighbours.
 */
function groundContactRules(
  model: CityModel,
  ground: GroundModel,
  add: (rule: RuleId, at: Vec2, note?: string) => void,
): void {
  const drawn = (x: number, y: number) => ground.surfaceAt(x, y).z;
  for (const f of model.fences ?? []) {
    const pts = fenceProfile(f, (x, y) => ground.cut.heightAt(x, y));
    const foot = FENCE_FOOT[f.style];
    const half = FENCE_WIDTH[f.style] / 2;
    let worst = CONTACT_GAP;
    let at: Vec2 | null = null;
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1];
      const b = pts[k];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-6) continue;
      const n: Vec2 = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
      const steps = Math.max(1, Math.ceil(len / CONTACT_STEP));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = a[0] + (b[0] - a[0]) * t;
        const y = a[1] + (b[1] - a[1]) * t;
        const bottom = a[2] + (b[2] - a[2]) * t - foot;
        for (const o of [-half, 0, half]) {
          const gap = bottom - drawn(x + n[0] * o, y + n[1] * o);
          if (gap > worst) {
            worst = gap;
            at = [x, y];
          }
        }
      }
    }
    if (at) add('fence.float', at, `${f.style} ${worst.toFixed(2)} m`);
  }
  for (const b of model.buildings) {
    if (b.underside !== undefined || b.form === 'canopy') continue;
    const ring = b.footprint.outer;
    let area2 = 0;
    for (let k = 0; k < ring.length; k++) {
      const p = ring[k];
      const q = ring[(k + 1) % ring.length];
      area2 += p[0] * q[1] - q[0] * p[1];
    }
    // Outward: to the right of a counter-clockwise ring.
    const out = area2 > 0 ? 1 : -1;
    const bottom = b.baseZ - 0.6;
    let worst = CONTACT_GAP;
    let at: Vec2 | null = null;
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const c = ring[(k + 1) % ring.length];
      const len = dist(a, c);
      if (len < 1e-6) continue;
      const n: Vec2 = [((c[1] - a[1]) / len) * out, (-(c[0] - a[0]) / len) * out];
      const steps = Math.max(1, Math.ceil(len / CONTACT_STEP));
      for (let i = 0; i < steps; i++) {
        const t = i / steps;
        const x = a[0] + (c[0] - a[0]) * t + n[0] * 0.15;
        const y = a[1] + (c[1] - a[1]) * t + n[1] * 0.15;
        const gap = bottom - drawn(x, y);
        if (gap > worst) {
          worst = gap;
          at = [x, y];
        }
      }
    }
    if (at) add('building.float', at, `${b.form ?? 'bina'} ${worst.toFixed(2)} m`);
  }
  // Street surfaces drawn on the street profile meet the ground beside them
  // with a vertical face (kerb down, retaining face up — the viewer closes
  // either); one taller than a kerb is a pit or a cut the ground should not
  // have (the terrain lowered too far under a sloping street, 2026-10-16).
  for (const sf of model.surfaces) {
    if (!STREET_SURFACES.has(sf.kind)) continue;
    for (const poly of sf.polygons)
      for (const [h, ring] of [poly.outer, ...poly.holes].entries()) {
        let area2 = 0;
        for (let k = 0; k < ring.length; k++) {
          const p = ring[k];
          const q = ring[(k + 1) % ring.length];
          area2 += p[0] * q[1] - q[0] * p[1];
        }
        // Away from the surface: right of a counter-clockwise outer ring, left of a hole.
        const out = area2 > 0 === (h === 0) ? 1 : -1;
        let long = 0;
        let worst = 0;
        let rise = 0;
        let at: Vec2 | null = null;
        for (let k = 0; k < ring.length; k++) {
          const a = ring[k];
          const c = ring[(k + 1) % ring.length];
          const len = dist(a, c);
          if (len < 1e-6) continue;
          const n: Vec2 = [((c[1] - a[1]) / len) * out, (-(c[0] - a[0]) / len) * out];
          const steps = Math.max(1, Math.ceil(len));
          for (let i = 0; i < steps; i++) {
            const t = (i + 0.5) / steps;
            const x = a[0] + (c[0] - a[0]) * t;
            const y = a[1] + (c[1] - a[1]) * t;
            const inside = ground.supportAt(x - n[0] * 0.1, y - n[1] * 0.1);
            const outside = ground.supportAt(x + n[0] * 0.1, y + n[1] * 0.1);
            if (!STREET_SURFACES.has(inside as SurfaceKind)) continue;
            if (STREET_SURFACES.has(outside as SurfaceKind)) continue;
            if (outside === 'trench' || outside === 'lid') continue;
            const top =
              ground.streetAt(x - n[0] * 0.1, y - n[1] * 0.1) + SURFACE_LIFT[inside as SurfaceKind];
            const step = ground.baseAt(x + n[0] * 0.1, y + n[1] * 0.1) - top;
            if (Math.abs(step) > STREET_STEP) {
              long += len / steps;
              if (Math.abs(step) > worst) {
                worst = Math.abs(step);
                rise = step;
                at = [x, y];
              }
            }
          }
        }
        if (at)
          add(
            'street.edge-step',
            at,
            `${sf.kind} ${long.toFixed(0)} m, en çok ${worst.toFixed(2)} m ` +
              (rise > 0 ? '(zemin üstte)' : '(zemin altta)'),
          );
      }
  }

  const t = model.terrain;
  if (!t) return;
  const h = (i: number, j: number) => t.heights[j * t.cols + i];
  for (let j = 1; j < t.rows - 1; j++)
    for (let i = 1; i < t.cols - 1; i++) {
      const z = h(i, j);
      const n = [h(i - 1, j), h(i + 1, j), h(i, j - 1), h(i, j + 1)];
      const up = Math.min(...n.map((v) => z - v));
      const down = Math.min(...n.map((v) => v - z));
      if (up > SPIKE || down > SPIKE)
        add(
          'terrain.spike',
          [t.minX + i * t.cellSize, t.minY + j * t.cellSize],
          `${(up > SPIKE ? up : -down).toFixed(1)} m`,
        );
    }
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
      // Opening an opened block again leaves arc-approximation crumbs: under
      // 1.5 m², or hairline thin (mm-wide crescents along a corner arc).
      if (area < 1.5 || meanThickness(piece) < HAIRLINE) continue;
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

/**
 * Solid body radius of a prop for the overlap rule (metres): a tree's trunk,
 * not its crown (crowns interlock, trunks do not); 0 = not checked.
 */
const BODY_RADIUS: Partial<Record<PropKind, number>> = {
  tree: 0.3,
  'street-lamp': 0.15,
  'traffic-signal': 0.15,
  'power-pole': 0.2,
  'waste-basket': 0.25,
  bench: 0.9,
  'bus-stop': 0.85,
  car: 1,
  booth: 1,
  swing: 1.5,
  slide: 1.5,
  seesaw: 1.4,
  climber: 1.4,
};

/** Shortest distance between segments ab and cd (0 when they cross). */
function segmentGap(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  const cross = (p: Vec2, q: Vec2, r: Vec2) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  return Math.min(
    closestOnSegment(a, c, d).d,
    closestOnSegment(b, c, d).d,
    closestOnSegment(c, a, b).d,
    closestOnSegment(d, a, b).d,
  );
}

/** Nothing stands in anything else: props, garden walls and buildings. */
function overlapRules(
  model: CityModel,
  add: (rule: RuleId, at: Vec2, note?: string) => void,
): void {
  const footprints = new PolygonSet(model.buildings.map((b) => b.footprint));
  // Props: bodies apart, none in a building.
  const props = model.props.filter((p) => !p.buildingId && (BODY_RADIUS[p.kind] ?? 0) > 0);
  const bodies = new GridIndex<Prop>(6);
  for (const p of props) {
    const r = BODY_RADIUS[p.kind]! * p.scale;
    bodies.insert(p, p.position[0] - r, p.position[1] - r, p.position[0] + r, p.position[1] + r);
  }
  const seen = new Set<string>();
  for (const p of props) {
    const r = BODY_RADIUS[p.kind]! * p.scale;
    const q: Vec2 = [p.position[0], p.position[1]];
    const inBuilding = [
      q,
      [q[0] + r, q[1]],
      [q[0] - r, q[1]],
      [q[0], q[1] + r],
      [q[0], q[1] - r],
    ].some((v) => footprints.contains(v[0], v[1]));
    if (inBuilding)
      add(p.provenance === 'observed' ? 'data.overlap' : 'overlap.prop-building', q, p.kind);
    for (const o of bodies.query(q[0] - r - 1.5, q[1] - r - 1.5, q[0] + r + 1.5, q[1] + r + 1.5)) {
      if (o === p) continue;
      const key = p.id < o.id ? `${p.id}|${o.id}` : `${o.id}|${p.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ro = BODY_RADIUS[o.kind]! * o.scale;
      if (dist(q, [o.position[0], o.position[1]]) >= r + ro - 0.02) continue;
      const data = p.provenance === 'observed' && o.provenance === 'observed';
      add(data ? 'data.overlap' : 'overlap.prop', q, `${p.kind} / ${o.kind}`);
    }
  }
  // Garden walls: bodies apart (joints at their ends allowed), none through a building.
  const fences = model.fences ?? [];
  type Seg = { f: number; a: Vec2; b: Vec2 };
  const segs = new GridIndex<Seg>(10);
  fences.forEach((f, i) => {
    for (let k = 1; k < f.points.length; k++) {
      const a = f.points[k - 1];
      const b = f.points[k];
      segs.insert(
        { f: i, a, b },
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.max(a[0], b[0]),
        Math.max(a[1], b[1]),
      );
      const n = Math.max(1, Math.round(dist(a, b) / 0.5));
      for (let j = 1; j < n; j++) {
        const t = j / n;
        const q: Vec2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        if (footprints.contains(q[0], q[1])) {
          add('overlap.fence-building', q);
          break;
        }
      }
    }
  });
  const ends = fences.map((f) => [f.points[0], f.points[f.points.length - 1]]);
  const atEnd = (q: Vec2, i: number) => ends[i].some((e) => dist(e, q) < 0.4);
  const pairs = new Set<string>();
  fences.forEach((f, i) => {
    for (let k = 1; k < f.points.length; k++) {
      const a = f.points[k - 1];
      const b = f.points[k];
      for (const o of segs.query(
        Math.min(a[0], b[0]) - 0.6,
        Math.min(a[1], b[1]) - 0.6,
        Math.max(a[0], b[0]) + 0.6,
        Math.max(a[1], b[1]) + 0.6,
      )) {
        if (o.f <= i || pairs.has(`${i}|${o.f}`)) continue;
        const room = (FENCE_WIDTH[f.style] + FENCE_WIDTH[fences[o.f].style]) / 2 - 0.02;
        if (segmentGap(a, b, o.a, o.b) >= room) continue;
        // Where they touch: a joint (an end of either wall) is how walls meet.
        const near = [a, b, o.a, o.b].filter(
          (q) =>
            closestOnSegment(q, a, b).d < room + 0.05 &&
            closestOnSegment(q, o.a, o.b).d < room + 0.05,
        );
        if (near.some((q) => atEnd(q, i) || atEnd(q, o.f))) continue;
        pairs.add(`${i}|${o.f}`);
        add('overlap.fence', near[0] ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      }
    }
  });
  // Buildings: footprints apart.
  const boxes = new GridIndex<Building>(30);
  for (const b of model.buildings) {
    const bb = boundsOf(b.footprint);
    boxes.insert(b, bb[0], bb[1], bb[2], bb[3]);
  }
  const bpairs = new Set<string>();
  for (const b of model.buildings) {
    const bb = boundsOf(b.footprint);
    for (const o of boxes.query(bb[0], bb[1], bb[2], bb[3])) {
      if (o === b) continue;
      const key = b.id < o.id ? `${b.id}|${o.id}` : `${o.id}|${b.id}`;
      if (bpairs.has(key)) continue;
      bpairs.add(key);
      const ob = boundsOf(o.footprint);
      if (ob[0] > bb[2] || ob[2] < bb[0] || ob[1] > bb[3] || ob[3] < bb[1]) continue;
      const shared = intersection([b.footprint], [o.footprint]).reduce(
        (s2, q) => s2 + polygonArea(q),
        0,
      );
      if (shared > 0.5) add('overlap.building', centroidOf(b.footprint), `${shared.toFixed(1)} m²`);
    }
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
    groundThroughDeck(br, ground, add);
    bridgeEnds(br, model.bridges ?? [], ground, roadIndex, add);
    if (barrierOnRoad(br, ground, roadIndex).length)
      add('bridge.barrier-road', [br.path[0][0], br.path[0][1]]);
  }
}

/** A deck less than this above the street meets it at street level (culvert, low bridge). */
export const LOW_DECK = 2;
/** How far past a carriageway's edge a barrier still stands on the road (carriageReach). */
const KERB_REACH = 0.3;

/**
 * Whether a deck's barrier / walkway stops at a point: a low deck over another
 * road's asphalt (a junction at street level). The one decision, shared by the
 * viewer (which leaves the barrier out there) and the validator.
 */
export function barrierStops(ground: GroundModel, deckZ: number, x: number, y: number): boolean {
  if (deckZ - ground.streetAt(x, y) >= LOW_DECK) return false;
  // On a ground road's carriageway or its kerb (carriageReach), its asphalt
  // drawn there or not: a deck's end ramp eases in over up to 90 m and runs
  // low beside the streets at its ends.
  if (ground.supportAt(x, y) === 'asphalt') return true;
  const s = ground.street.sample(x, y);
  return s !== null && s.pastCarriage < KERB_REACH;
}

/**
 * Barrier points left standing on another road's carriageway at street level
 * (not stopped by `barrierStops`, e.g. where the junction has no asphalt drawn).
 */
export function barrierOnRoad(
  br: Bridge,
  ground: GroundModel,
  roads: RoadIndex,
): { k: number; side: 1 | -1 }[] {
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
      if (p[k][2] - ground.streetAt(x, y) >= LOW_DECK) continue;
      if (barrierStops(ground, p[k][2], x, y)) continue;
      if (roads.covering([x, y], carriageReach)) out.push({ k, side });
    }
  }
  return out;
}

/**
 * The drawn ground rising through a deck: sampled every metre along it and
 * across its width, away from its ends (where it lands on the street).
 */
function groundThroughDeck(
  br: Bridge,
  ground: GroundModel,
  add: (rule: RuleId, at: Vec2, note?: string) => void,
): void {
  const p = br.path;
  let s = 0;
  const total = p.reduce(
    (t, q, k) => (k ? t + dist([q[0], q[1]], [p[k - 1][0], p[k - 1][1]]) : 0),
    0,
  );
  let worst = 0.05;
  let where = 0;
  let kind = '';
  let at: Vec2 | null = null;
  for (let k = 1; k < p.length; k++) {
    const a = p[k - 1];
    const b = p[k];
    const len = dist([a[0], a[1]], [b[0], b[1]]);
    if (len < 1e-6) continue;
    const n: Vec2 = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    for (let i = 0; i < Math.ceil(len); i++) {
      const t = i / Math.ceil(len);
      const along = s + len * t;
      if (along < 3 || total - along < 3) continue;
      const z = a[2] + (b[2] - a[2]) * t;
      for (const o of [-br.width / 2, 0, br.width / 2]) {
        const x = a[0] + (b[0] - a[0]) * t + n[0] * o;
        const y = a[1] + (b[1] - a[1]) * t + n[1] * o;
        const sf = ground.surfaceAt(x, y);
        const over = sf.z - z;
        if (over > worst) {
          worst = over;
          at = [x, y];
          where = Math.min(along, total - along);
          kind = sf.support;
        }
      }
    }
    s += len;
  }
  if (at)
    add(
      'bridge.ground-through',
      at,
      `${kind} ${worst.toFixed(2)} m, ucundan ${where.toFixed(0)} m`,
    );
}

/**
 * Junction paint (D-012): stop / give-way lines and arrows lie on the arms,
 * not in the junction area; a stop / give-way line is not on a crossing.
 */
function junctionPaintRules(
  model: CityModel,
  add: (rule: RuleId, at: Vec2, note?: string) => void,
): void {
  const areas = model.junctions.filter((j) => j.polygon && j.polygon.outer.length >= 3);
  const paint = model.markings.filter(
    (m) => m.kind === 'stop' || m.kind === 'give-way' || m.kind === 'arrow',
  );
  for (const m of paint) {
    const mid: Vec2 = [
      (m.points[0][0] + m.points[m.points.length - 1][0]) / 2,
      (m.points[0][1] + m.points[m.points.length - 1][1]) / 2,
    ];
    if (areas.some((j) => pointInRing(mid, j.polygon!.outer)))
      add('junction.paint-inside', mid, m.kind);
    if (m.kind === 'arrow') continue;
    for (const c of model.crossings) {
      // The zebra: along the road ±1.5 m, across it ±length / 2.
      const dx = mid[0] - c.center[0];
      const dy = mid[1] - c.center[1];
      const along = Math.abs(dx * c.dir[0] + dy * c.dir[1]);
      const across = Math.abs(-dx * c.dir[1] + dy * c.dir[0]);
      if (along < 1.5 + 0.25 && across < c.length / 2) {
        add('junction.stop-on-crossing', mid, m.kind);
        break;
      }
    }
  }
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
  // Each end: the deck runs 1–1.5 m on past its road's end (p[0] / p[n-1],
  // under the street); the street it lands on ends at the original end
  // (p[1] / p[n-2]).
  for (const o of [p[1], p[p.length - 2]] as Vec3[]) {
    const end: Vec2 = [o[0], o[1]];
    const endsHere = (r: Road) =>
      r.grade === 'ground' &&
      [r.centerline[0], r.centerline[r.centerline.length - 1]].some((q) => dist(q, end) < 2);
    const street = roads.nearest(end, 2, endsHere);
    if (!street) continue; // joins another deck, or leaves the tile
    // The deck end lies flush with the street asphalt (on the ground where it
    // lands on a footpath or open ground).
    const st = ground.street.heightAt(o[0], o[1]);
    const dz = o[2] - (st !== null ? st + SURFACE_LIFT.asphalt : ground.baseAt(o[0], o[1]));
    if (Math.abs(dz) > 0.1) add('seam.bridge-end', end, `Δz ${dz.toFixed(2)} m`);
    // A junction at the deck end (streets, or footpaths meeting a footbridge):
    // the other ways' own surfaces are there.
    const reach = street.road.width / 2 + street.road.sidewalk;
    if (roads.nearest(end, reach, (r) => r !== street.road && r.grade === 'ground')) continue;
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
