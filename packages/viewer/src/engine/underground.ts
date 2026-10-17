import {
  type CityModel,
  STATION_PIT,
  STATION_PIT_LENGTH,
  type StationEntrance,
  type UndergroundStructure,
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
    const glass = new MeshBuilder();
    const door = new MeshBuilder();
    for (const e of ug.entrances) entrance(e, { solid, rails, glass, door });
    const parts: [MeshBuilder, THREE.Material, string][] = [
      [solid, mats.tunnelFixture, 'station-entrance'],
      [rails, mats.railMetal, 'station-entrance-rails'],
      [glass, mats.railGlass, 'station-entrance-glass'],
      [door, mats.tunnelDark, 'station-entrance-door'],
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
  if (ug.structures.length) {
    const vol = new MeshBuilder();
    // The networks' glowing material (a station reads like a pipe network down there).
    vol.defineAttribute('ua', 1);
    for (const s of ug.structures) volume(s, vol);
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
  b: { solid: MeshBuilder; rails: MeshBuilder; glass: MeshBuilder; door: MeshBuilder },
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
  quad(
    b.solid,
    [
      at(L, inner, floor(L)),
      at(L, -inner, floor(L)),
      at(L, -inner, z0 + 0.05),
      at(L, inner, z0 + 0.05),
    ],
    back,
    CONCRETE,
  );
  quad(
    b.door,
    [
      at(L - 0.03, 1.2, floor(L)),
      at(L - 0.03, -1.2, floor(L)),
      at(L - 0.03, -1.2, floor(L) + 2.6),
      at(L - 0.03, 1.2, floor(L) + 2.6),
    ],
    back,
  );
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
  // Escalator balustrades: glass, a metre over the treads.
  for (const v of [esc0 + 0.05, esc1 - 0.05]) {
    const pts: [number, number, number][] = [
      at(sTop - 0.5, v, z0 + 0.05),
      at(sLow + 0.5, v, floor(sLow) + 0.05),
      at(sLow + 0.5, v, floor(sLow) + 1.05),
      at(sTop - 0.5, v, z0 + 1.05),
    ];
    quad(b.glass, pts, [l[0], l[1], 0]);
    quad(b.glass, [pts[1], pts[0], pts[3], pts[2]], [-l[0], -l[1], 0]);
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
