import {
  type CityModel,
  STATION_PIT,
  offsetPolygons,
  pointInRing,
  STATION_PIT_LENGTH,
  type StationEntrance,
  type UndergroundStructure,
  type UndergroundTrack,
  pitDepthAt,
} from '@opentwin/city-core';
import * as THREE from 'three/webgpu';
import { MeshBuilder, toThree } from './geom';
import type { DtMaterials } from './materials';

/**
 * Under the ground (F5b): metro entrances — a stair pit down to the
 * concourse in the ground the compiler opened for it — and, in the
 * underground view, the stations as glowing red volumes at their depth.
 */

/** Railing height round a stair pit's opening (m). */
const RAIL_HEIGHT = 1.05;
/** Passage from a stair pit into its station: half width and clear height (m). */
export const CORRIDOR_HALF = 1.5;
export const CORRIDOR_HEIGHT = 3;
/** A station concourse's clear height (m). */
export const CONCOURSE_HEIGHT = 4.5;
/** Columns in a concourse stand on a grid this wide (m), kept off its walls. */
const COLUMN_GRID = 9;
/** A level down is about this deep (m): concourse ceiling to floor and slab. */
const LEVEL_DEPTH = 6;
/** A station's glow in the underground view (metro red, dimmed). */
const STATION_COLOUR = new THREE.Color('#a8322b');

export function buildUnderground(model: CityModel, mats: DtMaterials): THREE.Group | null {
  const ug = model.underground;
  if (!ug || (!ug.entrances.length && !ug.structures.length)) return null;
  const group = new THREE.Group();
  group.name = 'underground';
  if (ug.entrances.length) {
    const solid = new MeshBuilder();
    const rails = new MeshBuilder();
    const door = new MeshBuilder();
    const glow = new MeshBuilder();
    for (const e of ug.entrances) {
      entrance(e, { solid, rails, door });
      if (e.passage) corridor(e.passage, solid, glow);
    }
    const parts: [MeshBuilder, THREE.Material, string][] = [
      [solid, mats.tunnelFixture, 'station-entrance'],
      [rails, mats.railMetal, 'station-entrance-rails'],
      [door, mats.tunnelDark, 'station-entrance-door'],
      [glow, mats.tunnelGlow, 'station-passage-lights'],
    ];
    for (const [mb, material, name] of parts) {
      if (!mb.indices.length) continue;
      const m = new THREE.Mesh(mb.build({ color: true, uv: true }), material);
      m.name = name;
      m.castShadow = name === 'station-entrance';
      m.receiveShadow = true;
      m.userData.role = 'underground:entrance';
      group.add(m);
    }
  }
  if (ug.structures.length || ug.tracks?.length) {
    // Inside: the concourse one walks into (always drawn, under the ground).
    const inside = new MeshBuilder();
    const lights = new MeshBuilder();
    const platforms = ug.structures.filter((s) => s.kind === 'platform');
    for (const s of ug.structures)
      if (s.kind === 'platform') platform(s, inside, lights, ug.tracks ?? []);
      else concourse(s, inside, lights);
    for (const t of ug.tracks ?? []) trackTunnel(t, platforms, inside);
    for (const [mb, material, name] of [
      [inside, mats.tunnelFixture, 'station-concourse'],
      [lights, mats.tunnelGlow, 'station-concourse-lights'],
    ] as const) {
      if (!mb.indices.length) continue;
      const m = new THREE.Mesh(mb.build({ color: true }), material);
      m.name = name;
      m.receiveShadow = true;
      m.userData.role = 'underground:entrance';
      group.add(m);
    }
    const vol = new MeshBuilder();
    // The networks' glowing material (a station reads like a pipe network down there).
    vol.defineAttribute('ua', 1);
    for (const s of ug.structures) volume(s, vol);
    for (const t of ug.tracks ?? []) trackGlow(t, vol);
    const m = new THREE.Mesh(vol.build({ color: true }), mats.utility);
    m.name = 'station-volumes';
    m.userData.role = 'underground:structure';
    m.renderOrder = 3;
    group.add(m);
  }
  return group;
}

const CONCRETE = new THREE.Color('#b8b4ab');
const GRANITE = new THREE.Color('#8e8a83');
const NOSING = new THREE.Color('#d9b23a');
const ESCALATOR = new THREE.Color('#3b3e42');
const STAINLESS = new THREE.Color('#c3c6cb');
const HANDRAIL = new THREE.Color('#1d1e20');
const UV: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/**
 * A metro entrance's stair pit (the compiler opens the ground there,
 * STATION_PIT): walls down to the concourse, a door at the bottom, stairs
 * two escalator widths wide beside one escalator, landings at the top and
 * the bottom, and railings round the opening on the street.
 */
function entrance(
  e: StationEntrance,
  b: { solid: MeshBuilder; rails: MeshBuilder; door: MeshBuilder },
): void {
  const [x, y, z0] = e.position;
  const f: [number, number] = [Math.cos(e.heading), Math.sin(e.heading)];
  const l: [number, number] = [-f[1], f[0]];
  /** A point `s` along the pit, `v` to its left, at height z. */
  const at = (s: number, v: number, z: number): [number, number, number] => [
    x + f[0] * s + l[0] * v,
    y + f[1] * s + l[1] * v,
    z,
  ];
  const floor = (s: number) => z0 - pitDepthAt(s);
  const P = STATION_PIT;
  const L = STATION_PIT_LENGTH;
  const half = P.width / 2;
  const inner = half - P.wall;
  const quad = (
    mb: MeshBuilder,
    pts: [number, number, number][],
    n: [number, number, number],
    c?: THREE.Color,
  ) => mb.quad(pts, n, c, UV);
  // Side walls (inner faces) down to the floor, and the end wall with its door.
  const breaks = [0, P.top, P.top + P.run, L];
  for (const side of [1, -1] as const) {
    const v = side * inner;
    const n: [number, number, number] = [-l[0] * side, -l[1] * side, 0];
    for (let k = 1; k < breaks.length; k++) {
      const s0 = breaks[k - 1];
      const s1 = breaks[k];
      const pts: [number, number, number][] = [
        at(s0, v, floor(s0)),
        at(s1, v, floor(s1)),
        at(s1, v, z0 + 0.05),
        at(s0, v, z0 + 0.05),
      ];
      quad(b.solid, side > 0 ? pts : [pts[1], pts[0], pts[3], pts[2]], n, CONCRETE);
    }
  }
  const back: [number, number, number] = [-f[0], -f[1], 0];
  const zf = floor(L);
  const endWall = (v0: number, v1: number, h0: number, h1: number) =>
    quad(b.solid, [at(L, v1, h0), at(L, v0, h0), at(L, v0, h1), at(L, v1, h1)], back, CONCRETE);
  if (e.passage) {
    // The way on into the station: the end wall open for the passage.
    endWall(CORRIDOR_HALF, inner, zf, z0 + 0.05);
    endWall(-inner, -CORRIDOR_HALF, zf, z0 + 0.05);
    endWall(-CORRIDOR_HALF, CORRIDOR_HALF, zf + CORRIDOR_HEIGHT, z0 + 0.05);
  } else {
    endWall(-inner, inner, zf, z0 + 0.05);
    quad(
      b.door,
      [
        at(L - 0.03, 1.2, zf),
        at(L - 0.03, -1.2, zf),
        at(L - 0.03, -1.2, zf + 2.6),
        at(L - 0.03, 1.2, zf + 2.6),
      ],
      back,
    );
  }
  const up: [number, number, number] = [0, 0, 1];
  // Landings.
  quad(
    b.solid,
    [
      at(0, -inner, z0 + 0.02),
      at(P.top, -inner, z0 + 0.02),
      at(P.top, inner, z0 + 0.02),
      at(0, inner, z0 + 0.02),
    ],
    up,
    GRANITE,
  );
  const zb = floor(L) + 0.02;
  quad(
    b.solid,
    [
      at(P.top + P.run, -inner, zb),
      at(L, -inner, zb),
      at(L, inner, zb),
      at(P.top + P.run, inner, zb),
    ],
    up,
    GRANITE,
  );
  // Stairs (two escalator widths, on the left) and the escalator (on the right).
  const split = inner - 2 * P.escalator;
  const steps = Math.ceil(P.depth / 0.16);
  const rise = P.depth / steps;
  const tread = P.run / steps;
  for (let i = 0; i < steps; i++) {
    const s0 = P.top + i * tread;
    const s1 = s0 + tread;
    const zTop = z0 - i * rise;
    const zLow = zTop - rise;
    // Riser down from this step's front edge, then the tread.
    quad(
      b.solid,
      [at(s0, split, zTop), at(s0, inner, zTop), at(s0, inner, zLow), at(s0, split, zLow)],
      back,
      GRANITE,
    );
    quad(
      b.solid,
      [at(s0, split, zLow), at(s1, split, zLow), at(s1, inner, zLow), at(s0, inner, zLow)],
      up,
      GRANITE,
    );
    // A yellow nosing strip on each step's edge.
    quad(
      b.solid,
      [
        at(s0, split, zLow + 0.005),
        at(s0 + 0.05, split, zLow + 0.005),
        at(s0 + 0.05, inner, zLow + 0.005),
        at(s0, inner, zLow + 0.005),
      ],
      up,
      NOSING,
    );
  }
  const esc0 = -inner;
  const esc1 = split;
  const sTop = P.top;
  const sLow = P.top + P.run;
  const n30: [number, number, number] = [-f[0] * 0.5, -f[1] * 0.5, Math.sqrt(3) / 2];
  quad(
    b.solid,
    [
      at(sTop, esc0, z0 + 0.05),
      at(sLow, esc0, floor(sLow) + 0.05),
      at(sLow, esc1, floor(sLow) + 0.05),
      at(sTop, esc1, z0 + 0.05),
    ],
    n30,
    ESCALATOR,
  );
  // Escalator balustrades: brushed steel panels a metre over the treads with a
  // black handrail (glass read as black panels against the dark pit).
  for (const v of [esc0 + 0.05, esc1 - 0.05]) {
    const pts: [number, number, number][] = [
      at(sTop - 0.5, v, z0 + 0.05),
      at(sLow + 0.5, v, floor(sLow) + 0.05),
      at(sLow + 0.5, v, floor(sLow) + 0.95),
      at(sTop - 0.5, v, z0 + 0.95),
    ];
    quad(b.solid, pts, [l[0], l[1], 0], STAINLESS);
    quad(b.solid, [pts[1], pts[0], pts[3], pts[2]], [-l[0], -l[1], 0], STAINLESS);
    const rail: [number, number, number][] = [
      at(sTop - 0.5, v - 0.05, z0 + 0.98),
      at(sLow + 0.5, v - 0.05, floor(sLow) + 0.98),
      at(sLow + 0.5, v + 0.05, floor(sLow) + 0.98),
      at(sTop - 0.5, v + 0.05, z0 + 0.98),
    ];
    quad(b.solid, rail, [0, 0, 1], HANDRAIL);
  }
  // Railings round the opening on the street: both long sides and the far end.
  const fence = (a: [number, number], c: [number, number]) => {
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const p0 = at(a[0], a[1], z0);
    const p1 = at(c[0], c[1], z0);
    const nx = -(p1[1] - p0[1]) / len;
    const ny = (p1[0] - p0[0]) / len;
    const top = (p: [number, number, number]): [number, number, number] => [
      p[0],
      p[1],
      p[2] + RAIL_HEIGHT,
    ];
    // railMetal draws a bar every 1/9 uv: 9 × 0.3 a metre, one every ~37 cm.
    const uv: [number, number][] = [
      [0, 0],
      [len * 0.3, 0],
      [len * 0.3, 1],
      [0, 1],
    ];
    b.rails.quad([p0, p1, top(p1), top(p0)], [nx, ny, 0], undefined, uv);
    b.rails.quad([p1, p0, top(p0), top(p1)], [-nx, -ny, 0], undefined, uv);
  };
  fence([P.top, half], [L, half]);
  fence([P.top, -half], [L, -half]);
  fence([L, -half], [L, half]);
}

const TILE_WALL = new THREE.Color('#d8d4cb');
const CEILING = new THREE.Color('#e6e3dc');
const FLOOR = new THREE.Color('#9d988f');
const COLUMN = new THREE.Color('#c7c1b6');
const LIGHT = new THREE.Color('#fff4dc');

/** A quad from four model points; its normal from the first three (for lighting). */
function face(mb: MeshBuilder, pts: [number, number, number][], c: THREE.Color): void {
  const [a, b, d] = pts;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  mb.quad(pts, [n[0] / l, n[1] / l, n[2] / l], c, UV);
}

/** The corridor from a stair pit's door into its station: floor, walls, ceiling, a light strip. */
function corridor(path: number[][], mb: MeshBuilder, glow: MeshBuilder): void {
  const h = CORRIDOR_HEIGHT;
  const w = CORRIDOR_HALF;
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1];
    const b = path[k];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    const lx = (-(b[1] - a[1]) / len) * w;
    const ly = ((b[0] - a[0]) / len) * w;
    const P = (q: number[], side: number, dz: number): [number, number, number] => [
      q[0] + lx * side,
      q[1] + ly * side,
      q[2] + dz,
    ];
    // Counter-clockwise seen from inside the corridor.
    face(mb, [P(a, -1, 0.02), P(b, -1, 0.02), P(b, 1, 0.02), P(a, 1, 0.02)], FLOOR);
    face(mb, [P(a, 1, h), P(b, 1, h), P(b, -1, h), P(a, -1, h)], CEILING);
    // Walls face in: a quad along the run faces right of it, so the left wall
    // as it is and the right one reversed.
    face(mb, [P(a, 1, 0), P(b, 1, 0), P(b, 1, h), P(a, 1, h)], TILE_WALL);
    face(
      mb,
      [P(a, -1, 0), P(b, -1, 0), P(b, -1, h), P(a, -1, h)].reverse() as [number, number, number][],
      TILE_WALL,
    );
    const s = 0.15 / w;
    const strip = (q: number[], side: number): [number, number, number] => [
      q[0] + lx * side * s,
      q[1] + ly * side * s,
      q[2] + h - 0.02,
    ];
    face(glow, [strip(a, 1), strip(b, 1), strip(b, -1), strip(a, -1)], LIGHT);
  }
}

/**
 * A station's concourse one can walk in: floor and ceiling over its
 * outline, walls facing in (open where passages come through), columns on a
 * grid and light panels on the ceiling.
 */
function concourse(s: UndergroundStructure, mb: MeshBuilder, glow: MeshBuilder): void {
  const z = s.floorZ;
  const h = CONCOURSE_HEIGHT;
  const ring =
    s.footprint.outer[0][0] === s.footprint.outer.at(-1)![0] &&
    s.footprint.outer[0][1] === s.footprint.outer.at(-1)![1]
      ? s.footprint.outer.slice(0, -1)
      : s.footprint.outer;
  if (ring.length < 3) return;
  let area = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  // Inside lies left of each edge of a counter-clockwise outline.
  const ccw = area > 0;
  const gap = CORRIDOR_HALF + 0.2;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    // Spans of this edge left open for the passages' doors.
    const cuts: [number, number][] = [];
    for (const d of s.doors ?? []) {
      const t = ((d[0] - a[0]) * (b[0] - a[0]) + (d[1] - a[1]) * (b[1] - a[1])) / (len * len);
      const px = a[0] + (b[0] - a[0]) * t;
      const py = a[1] + (b[1] - a[1]) * t;
      if (t < -0.01 || t > 1.01 || Math.hypot(d[0] - px, d[1] - py) > 0.5) continue;
      cuts.push([t - gap / len, t + gap / len]);
    }
    cuts.sort((p, q) => p[0] - q[0]);
    const spans: [number, number][] = [];
    let from = 0;
    for (const [c0, c1] of cuts) {
      if (c0 > from) spans.push([from, Math.min(1, c0)]);
      from = Math.max(from, c1);
    }
    if (from < 1) spans.push([from, 1]);
    for (const [t0, t1] of spans) {
      const p0: [number, number] = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
      const p1: [number, number] = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
      const pts: [number, number, number][] = [
        [p0[0], p0[1], z],
        [p1[0], p1[1], z],
        [p1[0], p1[1], z + h],
        [p0[0], p0[1], z + h],
      ];
      face(mb, ccw ? (pts.reverse() as [number, number, number][]) : pts, TILE_WALL);
    }
  }
  // Floor (facing up, open over platform stairs) and ceiling (facing down) over the outline.
  const contour = ring.map((p) => new THREE.Vector2(p[0], p[1]));
  const openings = (s.openings ?? []).filter((o) => o.every((p) => pointInRing(p, ring)));
  const holeRings = [...s.footprint.holes, ...openings];
  const holes = holeRings.map((hh) => hh.map((p) => new THREE.Vector2(p[0], p[1])));
  const tris = THREE.ShapeUtils.triangulateShape(contour, holes);
  const pts = [...ring, ...holeRings.flat()];
  const fl = pts.map((p) => mb.vertex(toThree(p[0], p[1], z + 0.02), [0, 1, 0], FLOOR));
  for (const [i, j, l] of tris) mb.triangle(fl[i], fl[j], fl[l]);
  const ce = pts.map((p) => mb.vertex(toThree(p[0], p[1], z + h), [0, -1, 0], CEILING));
  for (const [i, j, l] of tris) mb.triangle(ce[i], ce[l], ce[j]);
  // Columns and ceiling lights on a grid, kept two metres off the walls.
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const clear = (x: number, y: number) => {
    if (!pointInRing([x, y], ring)) return false;
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % ring.length];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
      if (Math.hypot(a[0] + dx * t - x, a[1] + dy * t - y) < 2) return false;
    }
    return true;
  };
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  for (let x = x0 + COLUMN_GRID / 2; x < Math.max(...xs); x += COLUMN_GRID)
    for (let y = y0 + COLUMN_GRID / 2; y < Math.max(...ys); y += COLUMN_GRID) {
      if (clear(x, y)) column(mb, x, y, z, z + h);
      const lx = x + COLUMN_GRID / 2;
      const ly = y;
      if (clear(lx, ly)) {
        const q = (dx: number, dy: number): [number, number, number] => [
          lx + dx,
          ly + dy,
          z + h - 0.02,
        ];
        face(glow, [q(-0.6, -0.2), q(-0.6, 0.2), q(0.6, 0.2), q(0.6, -0.2)], LIGHT);
      }
    }
}

const SAFETY = new THREE.Color('#e3c33a');
const TRACK_BED = new THREE.Color('#4a4740');
const STEEL = new THREE.Color('#6e7177');
/** A metro tunnel's half width and clear height over the rails (m). */
const TRACK_HALF = 2.3;
const TRACK_CLEAR = 4.6;
/** Standard gauge, half (m). */
const GAUGE = 0.7175;

/**
 * A platform under the ground: its slab at its level (faces down to the
 * rails), a yellow safety line round its edge, a ceiling over it and the
 * tracks beside it, and its stairs up to the concourse.
 */
function platform(
  s: UndergroundStructure,
  mb: MeshBuilder,
  glow: MeshBuilder,
  tracks: UndergroundTrack[],
): void {
  const z = s.floorZ;
  const ring =
    s.footprint.outer[0][0] === s.footprint.outer.at(-1)![0] &&
    s.footprint.outer[0][1] === s.footprint.outer.at(-1)![1]
      ? s.footprint.outer.slice(0, -1)
      : s.footprint.outer;
  if (ring.length < 3) return;
  let area = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const ccw = area > 0;
  const tris = THREE.ShapeUtils.triangulateShape(
    ring.map((p) => new THREE.Vector2(p[0], p[1])),
    [],
  );
  const top = ring.map((p) => mb.vertex(toThree(p[0], p[1], z + 0.02), [0, 1, 0], GRANITE));
  for (const [i, j, l] of tris) mb.triangle(top[i], top[j], top[l]);
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    // The slab's edge face (outward), down to the rails.
    const edge: [number, number, number][] = [
      [a[0], a[1], z - 1.1],
      [b[0], b[1], z - 1.1],
      [b[0], b[1], z + 0.02],
      [a[0], a[1], z + 0.02],
    ];
    face(mb, ccw ? edge : (edge.reverse() as [number, number, number][]), CONCRETE);
    // The yellow line, 0.5 m in from the edge.
    const inX = ((ccw ? -1 : 1) * (b[1] - a[1])) / len;
    const inY = ((ccw ? 1 : -1) * (b[0] - a[0])) / len;
    const q = (p: number[], d: number): [number, number, number] => [
      p[0] + inX * d,
      p[1] + inY * d,
      z + 0.03,
    ];
    face(
      mb,
      ccw
        ? [q(a, 0.5), q(b, 0.5), q(b, 0.65), q(a, 0.65)]
        : [q(a, 0.65), q(b, 0.65), q(b, 0.5), q(a, 0.5)],
      SAFETY,
    );
  }
  // Ceiling over the platform and its tracks, and the hall's walls round them
  // (open where a line runs in and out: the tunnel goes on).
  for (const poly of offsetPolygons([s.footprint], TRACK_HALF * 2, 'miter')) {
    const outer = poly.outer;
    hallWalls(outer, z - 1.4, z + CONCOURSE_HEIGHT, tracks, mb);
    // Open over the stairs coming down from the concourse.
    const stairHole = s.stairs ? stairsRect(s.stairs) : null;
    const holes = stairHole && stairHole.every((p) => pointInRing(p, outer)) ? [stairHole] : [];
    const t2 = THREE.ShapeUtils.triangulateShape(
      outer.map((p) => new THREE.Vector2(p[0], p[1])),
      holes.map((h) => h.map((p) => new THREE.Vector2(p[0], p[1]))),
    );
    const ce = [...outer, ...holes.flat()].map((p) =>
      mb.vertex(toThree(p[0], p[1], z + CONCOURSE_HEIGHT), [0, -1, 0], CEILING),
    );
    for (const [i, j, l] of t2) mb.triangle(ce[i], ce[l], ce[j]);
  }
  // Light strips along the platform.
  const c = s.footprint.outer
    .reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0])
    .map((v) => v / s.footprint.outer.length);
  let ax: [number, number] = [1, 0];
  let best = 0;
  for (let k = 1; k < s.footprint.outer.length; k++) {
    const d = [
      s.footprint.outer[k][0] - s.footprint.outer[k - 1][0],
      s.footprint.outer[k][1] - s.footprint.outer[k - 1][1],
    ];
    const l = Math.hypot(d[0], d[1]);
    if (l > best) [best, ax] = [l, [d[0] / l, d[1] / l]];
  }
  for (let t = -best / 2 + 3; t < best / 2 - 3; t += 6) {
    const p: [number, number] = [c[0] + ax[0] * t, c[1] + ax[1] * t];
    if (!pointInRing(p, ring)) continue;
    const L = (u: number, v: number): [number, number, number] => [
      p[0] + ax[0] * u - ax[1] * v,
      p[1] + ax[1] * u + ax[0] * v,
      z + CONCOURSE_HEIGHT - 0.02,
    ];
    face(glow, [L(-1.5, -0.15), L(-1.5, 0.15), L(1.5, 0.15), L(1.5, -0.15)], LIGHT);
  }
  if (s.stairs) platformStairs(s.stairs, mb);
}

/** A stair run's plan rectangle (corner ring). */
function stairsRect(st: { from: number[]; to: number[]; width: number }): [number, number][] {
  const dx = st.to[0] - st.from[0];
  const dy = st.to[1] - st.from[1];
  const l = Math.hypot(dx, dy) || 1;
  const w = [(-dy / l) * (st.width / 2), (dx / l) * (st.width / 2)];
  return [
    [st.from[0] - w[0], st.from[1] - w[1]],
    [st.to[0] - w[0], st.to[1] - w[1]],
    [st.to[0] + w[0], st.to[1] + w[1]],
    [st.from[0] + w[0], st.from[1] + w[1]],
  ];
}

/** A platform hall's walls (facing in), open where a track crosses its outline. */
function hallWalls(
  ring: [number, number][],
  z0: number,
  z1: number,
  tracks: UndergroundTrack[],
  mb: MeshBuilder,
): void {
  const n =
    ring.length - (ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1] ? 1 : 0);
  let area = 0;
  for (let k = 0; k < n; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  for (let k = 0; k < n; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    const cuts: [number, number][] = [];
    for (const t of tracks)
      for (let j = 1; j < t.path.length; j++) {
        // Only a line at this hall's level (one passing far under it keeps the wall).
        if (Math.abs(t.path[j][2] - (z0 + 0.3)) > 2.5) continue;
        const hit = segmentCross(a, b, t.path[j - 1], t.path[j]);
        if (hit !== null)
          cuts.push([hit - (TRACK_HALF + 0.4) / len, hit + (TRACK_HALF + 0.4) / len]);
      }
    cuts.sort((p, q) => p[0] - q[0]);
    let from = 0;
    const spans: [number, number][] = [];
    for (const [c0, c1] of cuts) {
      if (c0 > from) spans.push([from, Math.min(1, c0)]);
      from = Math.max(from, c1);
    }
    if (from < 1) spans.push([from, 1]);
    for (const [t0, t1] of spans) {
      const p0 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
      const p1 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
      const pts: [number, number, number][] = [
        [p0[0], p0[1], z0],
        [p1[0], p1[1], z0],
        [p1[0], p1[1], z1],
        [p0[0], p0[1], z1],
      ];
      face(mb, area > 0 ? (pts.reverse() as [number, number, number][]) : pts, TILE_WALL);
    }
  }
}

/** Where segment a–b meets segment c–d in plan, as a fraction along a–b; null when they do not. */
function segmentCross(a: number[], b: number[], c: number[], d: number[]): number | null {
  const r = [b[0] - a[0], b[1] - a[1]];
  const q = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * q[1] - r[1] * q[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * q[1] - (c[1] - a[1]) * q[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/** Stairs from a concourse floor down to a platform, with side walls up to the concourse. */
function platformStairs(
  st: { from: number[]; to: number[]; width: number },
  mb: MeshBuilder,
): void {
  const dx = st.to[0] - st.from[0];
  const dy = st.to[1] - st.from[1];
  const run = Math.hypot(dx, dy);
  if (run < 0.5) return;
  const f = [dx / run, dy / run];
  const l = [-f[1], f[0]];
  const w = st.width / 2;
  const drop = st.from[2] - st.to[2];
  const n = Math.max(1, Math.ceil(drop / 0.16));
  const rise = drop / n;
  const tread = run / n;
  const at = (s: number, v: number, z: number): [number, number, number] => [
    st.from[0] + f[0] * s + l[0] * v,
    st.from[1] + f[1] * s + l[1] * v,
    z,
  ];
  for (let i = 0; i < n; i++) {
    const s0 = i * tread;
    const zTop = st.from[2] - i * rise;
    const zLow = zTop - rise;
    face(mb, [at(s0, w, zTop), at(s0, -w, zTop), at(s0, -w, zLow), at(s0, w, zLow)], GRANITE);
    face(
      mb,
      [at(s0, -w, zLow), at(s0 + tread, -w, zLow), at(s0 + tread, w, zLow), at(s0, w, zLow)],
      GRANITE,
    );
    face(
      mb,
      [
        at(s0, -w, zLow + 0.005),
        at(s0 + 0.05, -w, zLow + 0.005),
        at(s0 + 0.05, w, zLow + 0.005),
        at(s0, w, zLow + 0.005),
      ],
      NOSING,
    );
  }
  // Side walls, from the treads up to the concourse floor, both faces.
  for (const side of [1, -1]) {
    const v = side * w;
    const pts: [number, number, number][] = [
      at(0, v, st.from[2]),
      at(run, v, st.to[2]),
      at(run, v, st.from[2]),
      at(0, v, st.from[2] + 0.001),
    ];
    face(mb, pts, TILE_WALL);
    face(mb, [pts[1], pts[0], pts[3], pts[2]], TILE_WALL);
  }
}

/**
 * A metro line in its tunnel: track bed, two rails, walls and roof — left
 * open beside a platform (the wall would stand between them).
 */
function trackTunnel(
  t: UndergroundTrack,
  platforms: UndergroundStructure[],
  mb: MeshBuilder,
): void {
  // A platform at this line's level (rails 1.1 m under its floor), not one passing over it.
  const level = platforms.filter((s) => Math.abs(s.floorZ - 1.1 - t.path[0][2]) < 2.5);
  const beside = (p: [number, number]) => level.some((s) => pointInRing(p, s.footprint.outer));
  for (let k = 1; k < t.path.length; k++) {
    const a = t.path[k - 1];
    const b = t.path[k];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    const lx = -(b[1] - a[1]) / len;
    const ly = (b[0] - a[0]) / len;
    const P = (q: number[], v: number, dz: number): [number, number, number] => [
      q[0] + lx * v,
      q[1] + ly * v,
      q[2] + dz,
    ];
    face(
      mb,
      [
        P(a, -TRACK_HALF, -0.3),
        P(b, -TRACK_HALF, -0.3),
        P(b, TRACK_HALF, -0.3),
        P(a, TRACK_HALF, -0.3),
      ],
      TRACK_BED,
    );
    for (const g of [GAUGE, -GAUGE]) {
      face(
        mb,
        [P(a, g - 0.04, 0.15), P(b, g - 0.04, 0.15), P(b, g + 0.04, 0.15), P(a, g + 0.04, 0.15)],
        STEEL,
      );
    }
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (const side of [1, -1]) {
      // Beside a platform: no wall, no roof on that side (the platform's ceiling covers it).
      if (beside([mid[0] + lx * side * 2.2, mid[1] + ly * side * 2.2])) continue;
      const wall: [number, number, number][] = [
        P(a, side * TRACK_HALF, -0.3),
        P(b, side * TRACK_HALF, -0.3),
        P(b, side * TRACK_HALF, TRACK_CLEAR),
        P(a, side * TRACK_HALF, TRACK_CLEAR),
      ];
      face(mb, side > 0 ? wall : (wall.reverse() as [number, number, number][]), CONCRETE);
      const roof: [number, number, number][] = [
        P(a, 0, TRACK_CLEAR),
        P(b, 0, TRACK_CLEAR),
        P(b, side * TRACK_HALF, TRACK_CLEAR),
        P(a, side * TRACK_HALF, TRACK_CLEAR),
      ];
      face(mb, side > 0 ? (roof.reverse() as [number, number, number][]) : roof, CEILING);
    }
  }
}

/** A metro line glowing in the underground view. */
function trackGlow(t: UndergroundTrack, mb: MeshBuilder): void {
  for (let k = 1; k < t.path.length; k++) {
    const a = t.path[k - 1];
    const b = t.path[k];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    const lx = (-(b[1] - a[1]) / len) * 0.8;
    const ly = ((b[0] - a[0]) / len) * 0.8;
    const P = (q: number[], v: number, dz: number): [number, number, number] => [
      q[0] + lx * v,
      q[1] + ly * v,
      q[2] + dz,
    ];
    mb.quad([P(a, -1, 1), P(b, -1, 1), P(b, 1, 1), P(a, 1, 1)], [0, 0, 1], TRACK_GLOW, UV);
    mb.quad([P(a, 1, 1), P(b, 1, 1), P(b, -1, 1), P(a, -1, 1)], [0, 0, -1], TRACK_GLOW, UV);
  }
}

const TRACK_GLOW = new THREE.Color('#2f7fd0');

/** A square column (0.6 m) from floor to ceiling. */
function column(mb: MeshBuilder, x: number, y: number, z0: number, z1: number): void {
  const r = 0.3;
  const c: [number, number][] = [
    [x - r, y - r],
    [x + r, y - r],
    [x + r, y + r],
    [x - r, y + r],
  ];
  for (let k = 0; k < 4; k++) {
    const a = c[k];
    const b = c[(k + 1) % 4];
    face(
      mb,
      [
        [a[0], a[1], z0],
        [b[0], b[1], z0],
        [b[0], b[1], z1],
        [a[0], a[1], z1],
      ],
      COLUMN,
    );
  }
}

/** A station as a volume at its depth: walls round its outline and its ceiling. */
function volume(s: UndergroundStructure, mb: MeshBuilder): void {
  const top = s.groundZ - 0.8;
  const bottom = s.groundZ - LEVEL_DEPTH * Math.max(1, -s.layer) - 0.5;
  const ring = s.footprint.outer;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    mb.quad(
      [
        [a[0], a[1], bottom],
        [b[0], b[1], bottom],
        [b[0], b[1], top],
        [a[0], a[1], top],
      ],
      [(b[1] - a[1]) / len, -(b[0] - a[0]) / len, 0],
      STATION_COLOUR,
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    );
  }
  // Ceiling (and floor): the outline triangulated.
  const contour = ring.map((p) => new THREE.Vector2(p[0], p[1]));
  const holes = s.footprint.holes.map((h) => h.map((p) => new THREE.Vector2(p[0], p[1])));
  const tris = THREE.ShapeUtils.triangulateShape(contour, holes);
  const pts = [...ring, ...s.footprint.holes.flat()];
  for (const z of [top, bottom]) {
    const base = pts.map((p) => mb.vertex(toThree(p[0], p[1], z), [0, 1, 0], STATION_COLOUR));
    for (const [i, j, l] of tris) mb.triangle(base[i], base[j], base[l]);
  }
}
