import ClipperLib from 'clipper-lib';
import { ringArea } from './geo';
import type { Polygon, Vec2 } from './types';

/**
 * Polygon boolean / offset operations on local-metre geometry, backed by
 * Clipper (integer arithmetic → robust unions of hundreds of road buffers).
 * Coordinates are scaled to centimetres internally.
 */

const S = 100;
const { Clipper, ClipperOffset, ClipType, PolyType, PolyFillType, JoinType, EndType, PolyTree } =
  ClipperLib;

type Path = ClipperLib.Path;
type Paths = ClipperLib.Paths;

const toPath = (ring: Vec2[]): Path =>
  ring.map(([x, y]) => ({ X: Math.round(x * S), Y: Math.round(y * S) }));
const fromPath = (path: Path): Vec2[] => path.map((p) => [p.X / S, p.Y / S]);

function oriented(ring: Vec2[], ccw: boolean): Vec2[] {
  return ringArea(ring) > 0 === ccw ? ring : [...ring].reverse();
}

export function toPaths(polys: Polygon[]): Paths {
  const out: Paths = [];
  for (const p of polys) {
    if (p.outer.length < 3) continue;
    out.push(toPath(oriented(p.outer, true)));
    for (const h of p.holes) if (h.length >= 3) out.push(toPath(oriented(h, false)));
  }
  return out;
}

function fromTree(tree: ClipperLib.PolyTree): Polygon[] {
  const out: Polygon[] = [];
  const visitOuter = (node: ClipperLib.PolyNode) => {
    const holes: Vec2[][] = [];
    for (const child of node.Childs()) {
      holes.push(oriented(fromPath(child.Contour()), false));
      for (const island of child.Childs()) visitOuter(island);
    }
    out.push({ outer: oriented(fromPath(node.Contour()), true), holes });
  };
  for (const node of tree.Childs()) visitOuter(node);
  return out;
}

function execute(type: number, subject: Paths, clip: Paths): Polygon[] {
  const c = new Clipper();
  c.AddPaths(subject, PolyType.ptSubject, true);
  if (clip.length) c.AddPaths(clip, PolyType.ptClip, true);
  const tree = new PolyTree();
  c.Execute(type, tree, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  return fromTree(tree);
}

export function union(...sets: Polygon[][]): Polygon[] {
  return execute(ClipType.ctUnion, toPaths(sets.flat()), []);
}

export function unionPaths(paths: Paths): Polygon[] {
  return execute(ClipType.ctUnion, paths, []);
}

export function difference(subject: Polygon[], clip: Polygon[]): Polygon[] {
  if (!clip.length) return union(subject);
  return execute(ClipType.ctDifference, toPaths(subject), toPaths(clip));
}

export function intersection(subject: Polygon[], clip: Polygon[]): Polygon[] {
  if (!clip.length || !subject.length) return [];
  return execute(ClipType.ctIntersection, toPaths(subject), toPaths(clip));
}

/** Buffer of an open polyline (road corridor). Round joins and ends. */
export function bufferPolylinePaths(points: Vec2[], halfWidth: number, roundEnds = true): Paths {
  if (points.length < 2 || halfWidth <= 0) return [];
  const co = new ClipperOffset(2, 0.25 * S);
  co.AddPath(
    toPath(points),
    JoinType.jtRound,
    roundEnds ? EndType.etOpenRound : EndType.etOpenButt,
  );
  const out: Paths = [];
  co.Execute(out, halfWidth * S);
  return out;
}

export function bufferPolyline(points: Vec2[], halfWidth: number, roundEnds = true): Polygon[] {
  return unionPaths(bufferPolylinePaths(points, halfWidth, roundEnds));
}

/** Grows (delta > 0) or shrinks (delta < 0) polygons. Mitred joins keep building corners square. */
export function offset(
  polys: Polygon[],
  delta: number,
  join: 'miter' | 'round' = 'miter',
): Polygon[] {
  if (!polys.length) return [];
  const co = new ClipperOffset(2.5, 0.25 * S);
  co.AddPaths(
    toPaths(polys),
    join === 'miter' ? JoinType.jtMiter : JoinType.jtRound,
    EndType.etClosedPolygon,
  );
  const tree = new PolyTree();
  co.Execute(tree, delta * S);
  return fromTree(tree);
}

export function polygonArea(p: Polygon): number {
  return Math.abs(ringArea(p.outer)) - p.holes.reduce((s, h) => s + Math.abs(ringArea(h)), 0);
}

/** Mean thickness of a polygon: twice its area over its perimeter (metres). */
export function meanThickness(p: Polygon): number {
  let per = 0;
  for (const r of [p.outer, ...p.holes])
    for (let k = 0; k < r.length; k++) {
      const a = r[k];
      const b = r[(k + 1) % r.length];
      per += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
  return per > 0 ? (2 * polygonArea(p)) / per : 0;
}

/**
 * Surface pieces at least `min` m thick: boolean operations leave hairline
 * slivers (a few mm wide) along shared edges, which drape as dark lines.
 */
export function dropHairlines(polys: Polygon[], min = HAIRLINE): Polygon[] {
  return polys.filter((p) => meanThickness(p) >= min);
}

/** Thinner surface pieces than this are hairline slivers (metres). */
export const HAIRLINE = 0.05;

export function totalArea(polys: Polygon[]): number {
  return polys.reduce((s, p) => s + polygonArea(p), 0);
}

/** Removes vertices closer than `distance` metres and near-collinear points. */
export function clean(polys: Polygon[], distance = 0.05): Polygon[] {
  const cleaned = Clipper.CleanPolygons(toPaths(polys), distance * S);
  return unionPaths(cleaned.filter((p) => p.length >= 3));
}

/** Axis-aligned rectangle polygon. */
export function rect(minX: number, minY: number, maxX: number, maxY: number): Polygon {
  return {
    outer: [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ],
    holes: [],
  };
}
