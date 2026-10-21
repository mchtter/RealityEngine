import {
  closestOnSegment,
  dist,
  dot,
  lerp2,
  normalize,
  polylineLength,
  samplePolyline,
  sub,
} from './geo';
import type { SourceRoad } from './osm';
import type { Vec2 } from './types';

/**
 * Grade separation (bridges, tunnels, layers) for an authoritative road
 * network that carries none: a municipal centreline register such as CADASTRE
 * lists the street but not that it crosses the valley on a viaduct or dips
 * under a junction. The grade comes from another source's road that runs
 * along the same line (OSM `bridge=*`, `tunnel=*`, `layer=*`).
 */

/** Tags that describe grade separation, copied onto the authoritative road. */
const GRADE_TAGS = ['bridge', 'tunnel', 'layer', 'bridge:structure', 'covered'];

/** Within this distance (m) a graded road counts as running along a centreline. */
const ALONG = 12;
/** Shortest overlap (m) worth splitting a centreline for. */
const MIN_SPAN = 8;

export function isGraded(r: SourceRoad): boolean {
  const t = r.tags;
  return (
    (Boolean(t.bridge) && t.bridge !== 'no') ||
    (Boolean(t.tunnel) && t.tunnel !== 'no') ||
    (Number.parseInt(t.layer ?? '0', 10) || 0) !== 0
  );
}

interface Projection {
  /** Arc length along the polyline. */
  s: number;
  d: number;
  dir: Vec2;
}

function project(points: Vec2[], p: Vec2): Projection {
  let best: Projection = { s: 0, d: Infinity, dir: [1, 0] };
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = dist(a, b);
    const c = closestOnSegment(p, a, b);
    if (c.d < best.d) best = { s: walked + c.t * len, d: c.d, dir: normalize(sub(b, a)) };
    walked += len;
  }
  return best;
}

/** Polyline between arc lengths s0 and s1. */
function slice(points: Vec2[], s0: number, s1: number): Vec2[] {
  const out: Vec2[] = [];
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = dist(a, b);
    const end = walked + len;
    if (end >= s0 && walked <= s1 && len > 0) {
      if (!out.length) out.push(lerp2(a, b, Math.max(0, (s0 - walked) / len)));
      if (end <= s1) out.push(b);
      else {
        out.push(lerp2(a, b, (s1 - walked) / len));
        break;
      }
    }
    walked = end;
  }
  return out;
}

interface Span {
  s0: number;
  s1: number;
  tags: Record<string, string>;
}

/**
 * Splits authoritative roads where a graded road of another source runs along
 * them, giving the overlapping piece that road's grade tags. Returns the new
 * authoritative road list and the graded roads that were absorbed this way
 * (the caller drops those; graded roads crossing over or under are kept).
 * An authoritative road with a grade of its own keeps it whole (the other
 * source's copy is still absorbed): splitting it by the copy's sampled extent
 * turned the last metre of a viaduct way into ground, and the deck of the next
 * way stopped in mid-air (CoastCity, 2026-10-09). Ungraded pieces shorter than
 * MIN_SPAN between or after graded ones join them: the sampled extent stops
 * up to a sample short of the graded road's end.
 */
export function transferGrades(
  authoritative: SourceRoad[],
  graded: SourceRoad[],
): { roads: SourceRoad[]; absorbed: Set<SourceRoad> } {
  const absorbed = new Set<SourceRoad>();
  const spans = new Map<SourceRoad, Span[]>();
  for (const g of graded) {
    // Every 4 m; a short piece (a footbridge segment) at least at both ends and its middle.
    const samples = samplePolyline(
      g.points,
      Math.max(0.5, Math.min(4, polylineLength(g.points) / 2)),
    );
    if (samples.length < 2) continue;
    for (const a of authoritative) {
      let s0 = Infinity;
      let s1 = -Infinity;
      let along = 0;
      for (const smp of samples) {
        const pr = project(a.points, smp.point);
        if (pr.d > ALONG || Math.abs(dot(pr.dir, smp.dir)) < 0.85) continue;
        s0 = Math.min(s0, pr.s);
        s1 = Math.max(s1, pr.s);
        along++;
      }
      if (s1 - s0 < MIN_SPAN) {
        // A short graded road lying wholly along an authoritative road that is
        // graded itself is a copy of it (the same footbridge from two sources):
        // both were drawn, at different heights.
        if (along === samples.length && isGraded(a)) absorbed.add(g);
        continue;
      }
      const tags: Record<string, string> = {};
      for (const k of GRADE_TAGS) if (g.tags[k]) tags[k] = g.tags[k];
      const list = spans.get(a) ?? [];
      list.push({ s0, s1, tags });
      spans.set(a, list);
      absorbed.add(g);
    }
  }

  const roads: SourceRoad[] = [];
  for (const a of authoritative) {
    const list = spans.get(a);
    if (!list || isGraded(a)) {
      roads.push(a);
      continue;
    }
    list.sort((x, y) => x.s0 - y.s0);
    const total = polylineLength(a.points);
    const cuts: { s0: number; s1: number; tags: Record<string, string> }[] = [];
    let at = 0;
    for (const sp of list) {
      const s0 = Math.max(at, sp.s0);
      const s1 = Math.min(total, sp.s1);
      if (s1 - s0 < MIN_SPAN / 2) continue;
      if (s0 - at > 0.5) cuts.push({ s0: at, s1: s0, tags: {} });
      cuts.push({ s0, s1, tags: sp.tags });
      at = s1;
    }
    if (total - at > 0.5) cuts.push({ s0: at, s1: total, tags: {} });
    // Short ungraded leftovers join a graded neighbour (the one before, else after).
    const graded = (c: Span) => Object.keys(c.tags).length > 0;
    for (let k = 0; k < cuts.length; k++) {
      const c = cuts[k];
      if (graded(c) || c.s1 - c.s0 >= MIN_SPAN) continue;
      const prev = cuts[k - 1];
      const next = cuts[k + 1];
      if (prev && graded(prev)) {
        prev.s1 = c.s1;
        cuts.splice(k--, 1);
      } else if (next && graded(next)) {
        next.s0 = c.s0;
        cuts.splice(k--, 1);
      }
    }
    // Neighbours with the same grade become one piece.
    for (let k = 1; k < cuts.length; k++) {
      if (JSON.stringify(cuts[k].tags) !== JSON.stringify(cuts[k - 1].tags)) continue;
      cuts[k - 1].s1 = cuts[k].s1;
      cuts.splice(k--, 1);
    }
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(a.tags)) if (!GRADE_TAGS.includes(k)) base[k] = v;
    cuts.forEach((c, k) => {
      const points = slice(a.points, c.s0, c.s1);
      if (points.length < 2) return;
      roads.push({ ...a, ref: `${a.ref}~${k}`, points, tags: { ...base, ...c.tags } });
    });
  }
  return { roads, absorbed };
}
