import { closestOnSegment, dist } from './geo';
import type { SourceLine, SourcePoint } from './osm';
import { densify } from './roads';
import { GridIndex } from './spatial';
import type { Utility, UtilityKind, UtilityNode, Vec2, Vec3 } from './types';

/**
 * Buried networks: gas, water, sewer, power, telecom and district heating
 * lines from source lines tagged the OpenStreetMap way (`man_made=pipeline` +
 * `substance`, `power=cable`, `telecom=line`, or `utility=*`), with
 * `diameter` (mm) and `depth` (cover to the top, m; `depth:end` for a sloped
 * run). Each run follows the surface at its depth; where two networks cross
 * too close the smaller one is moved over or under the other, and a service
 * line ending at a main of its network joins it at the main's height.
 */

interface UtilitySpec {
  /** Typical outer diameter of a main / of a service line, m. */
  diameter: number;
  service: number;
  /** Typical cover (surface to pipe top), m. */
  depth: number;
  /** Least cover allowed, m. */
  minCover: number;
}

export const UTILITY_SPECS: Record<UtilityKind, UtilitySpec> = {
  gas: { diameter: 0.125, service: 0.04, depth: 0.9, minCover: 0.6 },
  water: { diameter: 0.2, service: 0.05, depth: 1.2, minCover: 0.8 },
  sewer: { diameter: 0.5, service: 0.16, depth: 2.5, minCover: 1.0 },
  power: { diameter: 0.12, service: 0.05, depth: 0.8, minCover: 0.6 },
  telecom: { diameter: 0.06, service: 0.03, depth: 0.6, minCover: 0.4 },
  heat: { diameter: 0.3, service: 0.08, depth: 1.0, minCover: 0.6 },
};

/** Least gap between two crossing networks' outer walls, m. */
export const UTILITY_CLEARANCE = 0.3;
/** Sample spacing of a run, m (crossing moves are shaped on it). */
const STEP = 1;
/** A run's end this close to a main of its network joins it, m. */
const JOIN = 1.5;

const SUBSTANCE: Record<string, UtilityKind> = {
  gas: 'gas',
  natural_gas: 'gas',
  water: 'water',
  drinking_water: 'water',
  sewage: 'sewer',
  sewerage: 'sewer',
  wastewater: 'sewer',
  rainwater: 'sewer',
  heat: 'heat',
  hot_water: 'heat',
  steam: 'heat',
  power: 'power',
  electricity: 'power',
  telecom: 'telecom',
  communication: 'telecom',
};

/** Network of a source line, or null (not a utility, or above ground). */
export function utilityKindOf(tags: Record<string, string>): UtilityKind | null {
  const location = tags.location ?? '';
  if (location === 'overground' || location === 'overhead') return null;
  if (tags.man_made === 'pipeline' || tags.utility) {
    const kind = SUBSTANCE[tags.substance ?? tags['pipeline:substance'] ?? tags.utility ?? ''];
    if (kind) return kind;
  }
  if (tags.power === 'cable') return 'power';
  if (tags.telecom === 'line' || tags.telecom === 'cable' || tags.communication === 'line')
    return 'telecom';
  return null;
}

/** Number from a tag ("160", "160 mm", "0,9 m"); null when absent or not a number. */
function num(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number.parseFloat(v.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Diameter in metres: OSM gives millimetres; values under 5 are taken as metres already. */
function diameterOf(tags: Record<string, string>, kind: UtilityKind, service: boolean): number {
  const v = num(tags.diameter);
  const spec = UTILITY_SPECS[kind];
  if (v === null || v <= 0) return service ? spec.service : spec.diameter;
  return Math.min(3, v > 5 ? v / 1000 : v);
}

/** A service connection to a building, not a main. */
export const isServiceLine = (tags: Record<string, string>) =>
  tags.service === 'yes' || tags.usage === 'service' || tags['utility:service'] === 'yes';

const MANHOLE: Record<string, UtilityKind> = {
  sewer: 'sewer',
  drain: 'sewer',
  sewerage: 'sewer',
  water: 'water',
  gas: 'gas',
  telecom: 'telecom',
  power: 'power',
  heat: 'heat',
};

export interface UtilityNetwork {
  utilities: Utility[];
  nodes: UtilityNode[];
}

/**
 * Buried runs and their access points. `surfaceAt` gives the height of the
 * top surface (street, ground, trench floor) at a point.
 */
export function buildUtilities(
  lines: SourceLine[],
  points: SourcePoint[],
  surfaceAt: (x: number, y: number) => number,
  /** Street cabinets: each is linked to the nearest main of its network. */
  cabinets: { ref: string; p: Vec2; kind: UtilityKind }[] = [],
): UtilityNetwork {
  const utilities: Utility[] = [];
  for (const line of lines) {
    const kind = utilityKindOf(line.tags);
    if (!kind || line.points.length < 2) continue;
    const service = isServiceLine(line.tags);
    const diameter = diameterOf(line.tags, kind, service);
    const cover0 = num(line.tags.depth) ?? UTILITY_SPECS[kind].depth;
    const cover1 = num(line.tags['depth:end']) ?? cover0;
    const pts = densify(line.points, STEP);
    let along = 0;
    const total = pts.reduce((s, p, k) => (k ? s + dist(pts[k - 1], p) : 0), 0) || 1;
    const path: Vec3[] = pts.map((p, k) => {
      if (k) along += dist(pts[k - 1], p);
      const cover = cover0 + ((cover1 - cover0) * along) / total;
      return [p[0], p[1], surfaceAt(p[0], p[1]) - cover - diameter / 2];
    });
    utilities.push({
      id: `u:${line.ref}`,
      ref: line.ref,
      kind,
      service,
      diameter,
      path,
      ...(line.tags.material ? { material: line.tags.material } : {}),
      provenance: 'observed',
    });
  }
  utilities.push(...cabinetLinks(cabinets, utilities, surfaceAt));
  joinServices(utilities);
  resolveCrossings(utilities, surfaceAt);

  const nodes: UtilityNode[] = [];
  for (const pt of points) {
    const type =
      pt.tags.man_made === 'manhole' ? 'manhole' : pt.tags.pipeline === 'valve' ? 'valve' : null;
    if (!type) continue;
    const kind =
      MANHOLE[pt.tags.manhole ?? pt.tags.substance ?? ''] ??
      (type === 'manhole' ? 'sewer' : (SUBSTANCE[pt.tags.substance ?? ''] ?? 'water'));
    const z = surfaceAt(pt.p[0], pt.p[1]);
    // Down to the bottom of the deepest run of its network under the cover.
    let bottom = -Infinity;
    for (const u of utilities) {
      if (u.kind !== kind) continue;
      for (let k = 1; k < u.path.length; k++) {
        const a = u.path[k - 1];
        const b = u.path[k];
        const hit = closestOnSegment(pt.p, [a[0], a[1]], [b[0], b[1]]);
        if (hit.d < 1.5)
          bottom = Math.max(bottom, z - (a[2] + (b[2] - a[2]) * hit.t) + u.diameter / 2);
      }
    }
    const depth =
      num(pt.tags.depth) ??
      (Number.isFinite(bottom) ? bottom + 0.3 : UTILITY_SPECS[kind].depth + 0.5);
    nodes.push({
      id: `n:${pt.ref}`,
      ref: pt.ref,
      kind,
      type,
      position: [pt.p[0], pt.p[1], z],
      depth,
    });
  }
  return { utilities, nodes };
}

/** A cabinet farther than this from every main of its network stays unlinked, m. */
const CABINET_REACH = 12;

/**
 * Conduit from each street cabinet down to the nearest main of its network
 * (inferred: the data has the cabinet, not the duct): from under the
 * cabinet's plinth to the main, joining it at the main's height.
 */
function cabinetLinks(
  cabinets: { ref: string; p: Vec2; kind: UtilityKind }[],
  utilities: Utility[],
  surfaceAt: (x: number, y: number) => number,
): Utility[] {
  const mains = utilities.filter((u) => !u.service);
  const index = segmentIndex(mains);
  const out: Utility[] = [];
  for (const c of cabinets) {
    let best: { q: Vec2; d: number } | null = null;
    for (const s of index.query(
      c.p[0] - CABINET_REACH,
      c.p[1] - CABINET_REACH,
      c.p[0] + CABINET_REACH,
      c.p[1] + CABINET_REACH,
    )) {
      if (s.u.kind !== c.kind) continue;
      const a = s.u.path[s.k - 1];
      const b = s.u.path[s.k];
      const hit = closestOnSegment(c.p, [a[0], a[1]], [b[0], b[1]]);
      if (hit.d < CABINET_REACH && (!best || hit.d < best.d)) best = { q: hit.point, d: hit.d };
    }
    if (!best || best.d < 0.3) continue;
    const diameter = UTILITY_SPECS[c.kind].service;
    const path: Vec3[] = densify([c.p, best.q], STEP).map((p) => [
      p[0],
      p[1],
      surfaceAt(p[0], p[1]) - 0.5 - diameter / 2,
    ]);
    out.push({
      id: `u:${c.ref}~link`,
      ref: c.ref,
      kind: c.kind,
      service: true,
      diameter,
      path,
      provenance: 'inferred',
    });
  }
  return out;
}

interface Seg {
  u: Utility;
  k: number;
}

function segmentIndex(utilities: Utility[]): GridIndex<Seg> {
  const index = new GridIndex<Seg>(20);
  for (const u of utilities) {
    for (let k = 1; k < u.path.length; k++) {
      const a = u.path[k - 1];
      const b = u.path[k];
      index.insert(
        { u, k },
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.max(a[0], b[0]),
        Math.max(a[1], b[1]),
      );
    }
  }
  return index;
}

/** Height of a run's centre at the point of segment k at parameter t. */
const zAt = (u: Utility, k: number, t: number) =>
  u.path[k - 1][2] + (u.path[k][2] - u.path[k - 1][2]) * t;

/**
 * A run ending at a run of its own network (a service line at its main, a
 * branch at a junction) joins it there: its end eases to the main's height
 * over the last few metres.
 */
function joinServices(utilities: Utility[]): void {
  const index = segmentIndex(utilities);
  for (const u of utilities) {
    for (const end of [0, u.path.length - 1]) {
      const p: Vec2 = [u.path[end][0], u.path[end][1]];
      let best: { z: number; d: number } | null = null;
      for (const s of index.query(p[0] - JOIN, p[1] - JOIN, p[0] + JOIN, p[1] + JOIN)) {
        if (s.u === u || s.u.kind !== u.kind || s.u.diameter < u.diameter) continue;
        const a = s.u.path[s.k - 1];
        const b = s.u.path[s.k];
        const hit = closestOnSegment(p, [a[0], a[1]], [b[0], b[1]]);
        if (hit.d < JOIN && (!best || hit.d < best.d)) best = { z: zAt(s.u, s.k, hit.t), d: hit.d };
      }
      if (!best) continue;
      const dz = best.z - u.path[end][2];
      if (Math.abs(dz) < 0.02) continue;
      // Ease over 6 m, or the whole run when it is shorter (a sloped service line).
      const reach = 6;
      let along = 0;
      const order = end === 0 ? u.path.map((_, k) => k) : u.path.map((_, k) => end - k);
      for (let i = 0; i < order.length; i++) {
        const k = order[i];
        if (i)
          along += dist(
            [u.path[order[i - 1]][0], u.path[order[i - 1]][1]],
            [u.path[k][0], u.path[k][1]],
          );
        const w = along >= reach ? 0 : 1 - smooth(along / reach);
        if (w <= 0) break;
        u.path[k][2] += dz * w;
      }
    }
  }
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Point where segments ab and cd cross (parameters on each), or null. */
function crossing(a: Vec3, b: Vec3, c: Vec3, d: Vec3): { t: number; s: number } | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  const s = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  return t >= 0 && t <= 1 && s >= 0 && s <= 1 ? { t, s } : null;
}

/**
 * Order in which runs settle: gravity sewers first (never moved), then the
 * larger, mains before service lines. A run gives way only to runs settled
 * before it, so a settled run never moves again.
 */
const settleOrder = (a: Utility, b: Utility) =>
  Number(b.kind === 'sewer') - Number(a.kind === 'sewer') ||
  b.diameter - a.diameter ||
  Number(a.service) - Number(b.service) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Every crossing of two networks with less than UTILITY_CLEARANCE between the walls. */
export function utilityClashes(
  utilities: Utility[],
): { a: Utility; ka: number; ta: number; b: Utility; kb: number; tb: number; gap: number }[] {
  const index = segmentIndex(utilities);
  const out: ReturnType<typeof utilityClashes> = [];
  for (const a of utilities) {
    for (let ka = 1; ka < a.path.length; ka++) {
      const p = a.path[ka - 1];
      const q = a.path[ka];
      for (const s of index.query(
        Math.min(p[0], q[0]),
        Math.min(p[1], q[1]),
        Math.max(p[0], q[0]),
        Math.max(p[1], q[1]),
      )) {
        const b = s.u;
        if (b.kind === a.kind || a.id >= b.id) continue;
        const x = crossing(p, q, b.path[s.k - 1], b.path[s.k]);
        if (!x) continue;
        const gap = Math.abs(zAt(a, ka, x.t) - zAt(b, s.k, x.s)) - a.diameter / 2 - b.diameter / 2;
        if (gap < UTILITY_CLEARANCE - 1e-3) out.push({ a, ka, ta: x.t, b, kb: s.k, tb: x.s, gap });
      }
    }
  }
  return out;
}

/**
 * Two networks crossing closer than the clearance: the run that settles later
 * gives way. Its crossings with settled runs a few metres apart form one
 * group, levelled at one height clear of every run in the group (the free
 * height nearest the current one, keeping the run's least cover) and eased in
 * over 3 m each side: one dip under a bundle of cables, not a wave, and no
 * move undoing another.
 */
function resolveCrossings(utilities: Utility[], surfaceAt: (x: number, y: number) => number) {
  const order = [...utilities].sort(settleOrder);
  const rank = new Map(order.map((u, i) => [u, i]));
  const index = segmentIndex(utilities);
  for (const m of order) {
    const cum = [0];
    for (let k = 1; k < m.path.length; k++)
      cum.push(
        cum[k - 1] + dist([m.path[k - 1][0], m.path[k - 1][1]], [m.path[k][0], m.path[k][1]]),
      );
    // Every crossing with a settled run (clear or not: a move must keep it clear).
    const hits: {
      k: number;
      t: number;
      along: number;
      zm: number;
      lo: number;
      hi: number;
      top: number;
      flat: number;
    }[] = [];
    for (let k = 1; k < m.path.length; k++) {
      const p = m.path[k - 1];
      const q = m.path[k];
      for (const sg of index.query(
        Math.min(p[0], q[0]),
        Math.min(p[1], q[1]),
        Math.max(p[0], q[0]),
        Math.max(p[1], q[1]),
      )) {
        const o = sg.u;
        if (o.kind === m.kind || rank.get(o)! > rank.get(m)!) continue;
        const x = crossing(p, q, o.path[sg.k - 1], o.path[sg.k]);
        if (!x) continue;
        const zo = zAt(o, sg.k, x.s);
        // 2 cm to spare, so the clearance holds after rounding.
        const reach = m.diameter / 2 + o.diameter / 2 + UTILITY_CLEARANCE + 0.02;
        const along = cum[k - 1] + (cum[k] - cum[k - 1]) * x.t;
        const flat = o.diameter / 2 + 1;
        // Lowest surface over the levelled stretch (the run keeps its cover all along it).
        let surface = surfaceAt(p[0] + (q[0] - p[0]) * x.t, p[1] + (q[1] - p[1]) * x.t);
        for (let i = 0; i < m.path.length; i++)
          if (Math.abs(cum[i] - along) <= flat + 0.5)
            surface = Math.min(surface, surfaceAt(m.path[i][0], m.path[i][1]));
        hits.push({
          k,
          t: x.t,
          along,
          zm: zAt(m, k, x.t),
          lo: zo - reach,
          hi: zo + reach,
          top: surface - UTILITY_SPECS[m.kind].minCover - m.diameter / 2,
          flat,
        });
      }
    }
    hits.sort((a, b) => a.along - b.along);
    for (let i = 0; i < hits.length; ) {
      let j = i + 1;
      while (j < hits.length && hits[j].along - hits[j - 1].along < 10) j++;
      const group = hits.slice(i, j);
      i = j;
      const blocked = (z: number) => group.some((h) => z > h.lo + 1e-6 && z < h.hi - 1e-6);
      if (!group.some((h) => blocked(h.zm))) continue;
      const current = group.reduce((sum, h) => sum + h.zm, 0) / group.length;
      const top = Math.min(...group.map((h) => h.top));
      const target = [current, ...group.flatMap((h) => [h.lo, h.hi])]
        .filter((z) => z <= top && !blocked(z))
        .sort((a, b) => Math.abs(a - current) - Math.abs(b - current))[0];
      if (target === undefined) continue;
      for (const h of group) bump(m, h.k, h.t, target, target < h.zm, h.flat, 3);
      m.rerouted = (m.rerouted ?? 0) + 1;
    }
  }
}

/**
 * Brings a run to height `target` around the point of segment k at t: level
 * for `flat` m, eased back over `ease` m. Only ever lowers (`down`) or raises
 * it, so moves at nearby crossings keep each other's clearance instead of
 * adding up or undoing one another.
 */
function bump(
  u: Utility,
  k: number,
  t: number,
  target: number,
  down: boolean,
  flat: number,
  ease: number,
) {
  const a = u.path[k - 1];
  const b = u.path[k];
  const at: Vec2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  // Distance along the run from the crossing to each vertex.
  const along = new Array<number>(u.path.length);
  along[k - 1] = dist(at, [a[0], a[1]]);
  along[k] = dist(at, [b[0], b[1]]);
  for (let i = k - 2; i >= 0; i--)
    along[i] =
      along[i + 1] + dist([u.path[i][0], u.path[i][1]], [u.path[i + 1][0], u.path[i + 1][1]]);
  for (let i = k + 1; i < u.path.length; i++)
    along[i] =
      along[i - 1] + dist([u.path[i][0], u.path[i][1]], [u.path[i - 1][0], u.path[i - 1][1]]);
  for (let i = 0; i < u.path.length; i++) {
    const s = along[i];
    const w = s <= flat ? 1 : s >= flat + ease ? 0 : 1 - smooth((s - flat) / ease);
    if (w <= 0) continue;
    const z = u.path[i][2];
    const want = z + (target - z) * w;
    u.path[i][2] = down ? Math.min(z, want) : Math.max(z, want);
  }
}
