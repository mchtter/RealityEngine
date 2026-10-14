import {
  type Building,
  type CityModel,
  type Polygon,
  Rng,
  barrelRise,
  clipPolygons,
  offsetPolygons,
  orientedBox,
  subtractPolygons,
  triangulate,
} from '@opentwin/city-core';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three/webgpu';
import { MeshBuilder, toThree } from './geom';
import { BUILDING_SLOT, type DtMaterials } from './materials';

type V2 = [number, number];
type V3 = [number, number, number];

const FINISH: Record<string, number> = {
  plaster: 0,
  'cladding-wood': 1,
  'cladding-panel': 2,
  stone: 3,
  brick: 4,
  /** Relief motif strip (see materials: wall). */
  ornament: 5,
};
const SIGN_COLORS = [
  '#c0392b',
  '#1f5fa8',
  '#e6b422',
  '#2e7d32',
  '#f4f1ea',
  '#8e2c48',
  '#1b1b1b',
  '#d35400',
];
const DOOR_COLORS = ['#4a3426', '#5b3d2a', '#3b3f44', '#6b6f73', '#2e2a26'];

const col = (hex: string) => new THREE.Color(hex);
/** Concrete entrance steps. */
const STEP_COLOR = col('#a29d95');

/** Accumulates instance transforms for one module geometry. */
class Instances {
  private readonly matrices: THREE.Matrix4[] = [];
  private readonly colors: THREE.Color[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);

  /** Places a module at a model-space point, its local +z facing `out` (model xy). */
  add(p: V3, out: V2, sx: number, sy: number, sz: number, color?: THREE.Color): void {
    const [x, y, z] = toThree(p[0], p[1], p[2]);
    this.q.setFromAxisAngle(this.up, Math.atan2(out[0], -out[1]));
    this.m.compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(sx, sy, sz));
    this.matrices.push(this.m.clone());
    if (color) this.colors.push(color);
  }

  get count(): number {
    return this.matrices.length;
  }

  /**
   * @param colorAttribute store colours in this per-instance geometry attribute
   *   instead of `instanceColor` (which three.js multiplies into the whole material).
   */
  build(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    name: string,
    shadow = false,
    colorAttribute?: string,
  ): THREE.InstancedMesh | null {
    if (!this.matrices.length) return null;
    let geo = geometry;
    if (colorAttribute) {
      geo = geometry.clone();
      const data = new Float32Array(this.matrices.length * 3);
      this.colors.forEach((c, i) => data.set([c.r, c.g, c.b], i * 3));
      geo.setAttribute(colorAttribute, new THREE.InstancedBufferAttribute(data, 3));
    }
    const mesh = new THREE.InstancedMesh(geo, material, this.matrices.length);
    this.matrices.forEach((mat, i) => mesh.setMatrixAt(i, mat));
    if (!colorAttribute && this.colors.length === this.matrices.length)
      this.colors.forEach((c, i) => mesh.setColorAt(i, c));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.name = name;
    return mesh;
  }
}

// ─── Module geometries (local: x across, y up, z out of the wall) ────────────

function box(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  g.deleteAttribute('uv');
  return g;
}

function plane(
  w: number,
  h: number,
  x: number,
  y: number,
  z: number,
  rotY = 0,
): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  return g;
}

/** Flat rectangular ring facing +z: outer half-size `o`, inner half-sizes (ix, iy). */
function frameRing(o: number, ix: number, iy: number, z: number): THREE.BufferGeometry {
  const pts = [
    [-o, -o],
    [o, -o],
    [o, o],
    [-o, o],
    [-ix, -iy],
    [ix, -iy],
    [ix, iy],
    [-ix, iy],
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      pts.flatMap(([x, y]) => [x, y, z]),
      3,
    ),
  );
  g.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute(
      pts.flatMap(() => [0, 0, 1]),
      3,
    ),
  );
  // Outer k → outer k+1 → inner k+1, inner k (counter-clockwise seen from +z).
  const idx: number[] = [];
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4;
    idx.push(k, k1, 4 + k1, k, 4 + k1, 4 + k);
  }
  g.setIndex(idx);
  return g;
}

function sillGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  // x ∈ [-0.56, 0.56], top at y = -0.5, projecting 0.14 from the wall.
  const p = [
    -0.56, -0.5, 0, 0.56, -0.5, 0, 0.56, -0.5, 0.14, -0.56, -0.5, 0.14, -0.56, -0.55, 0.14, 0.56,
    -0.55, 0.14, 0.56, -0.5, 0.14, -0.56, -0.5, 0.14,
  ];
  const n = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
  g.setIndex([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7]);
  return g;
}

function createModules() {
  return {
    // Sill: top + front faces only, under the unit window.
    sill: sillGeometry(),
    glass: plane(1, 1, 0, 0, 0.012),
    shopFrame: mergeGeometries([
      box(1, 0.04, 0.06, 0, 0.48, 0.03),
      box(0.025, 1, 0.06, -0.49, 0, 0.03),
      box(0.025, 1, 0.06, 0.49, 0, 0.03),
      box(0.02, 1, 0.05, 0, 0, 0.03),
    ]),
    door: mergeGeometries([box(1, 1, 0.08, 0, 0, 0.02), box(1.12, 0.06, 0.1, 0, 0.52, 0.05)]),
    canopy: box(1, 0.12, 1, 0, 0, 0.5),
    // Window surround (söve): a flat frame around the unit window, slightly proud.
    // Front face only (8 triangles): thousands per tile, the 4 cm relief does not read.
    surround: frameRing(0.5, 0.41, 0.4, 0.035),
    // Unit block standing on the ground in front of the wall (entrance steps).
    step: box(1, 1, 1, 0, 0.5, 0.5),
    sign: box(1, 1, 0.12, 0, 0, 0.1),
    slab: box(1, 0.16, 1.25, 0, -0.08, 0.625),
    railSolid: mergeGeometries([
      box(1, 1.0, 0.09, 0, 0.5, 1.2),
      box(0.09, 1.0, 1.2, -0.455, 0.5, 0.6),
      box(0.09, 1.0, 1.2, 0.455, 0.5, 0.6),
    ]),
    railPanels: mergeGeometries([
      plane(1, 1, 0, 0.5, 1.2),
      plane(1.2, 1, -0.49, 0.5, 0.6, -Math.PI / 2),
      plane(1.2, 1, 0.49, 0.5, 0.6, Math.PI / 2),
    ]),
    railTop: mergeGeometries([
      box(1, 0.05, 0.06, 0, 1.0, 1.2),
      box(0.05, 0.05, 1.2, -0.48, 1.0, 0.6),
      box(0.05, 0.05, 1.2, 0.48, 1.0, 0.6),
    ]),
    glazedUpper: mergeGeometries([
      plane(1, 1.45, 0, 1.0 + 0.725, 1.19),
      plane(1.18, 1.45, -0.48, 1.0 + 0.725, 0.6, -Math.PI / 2),
      plane(1.18, 1.45, 0.48, 1.0 + 0.725, 0.6, Math.PI / 2),
    ]),
    // Open-ended variants (front + right side only): the second leg of an
    // L-shaped corner balcony, whose left end runs into the first leg.
    railSolidEnd: mergeGeometries([
      box(1, 1.0, 0.09, 0, 0.5, 1.2),
      box(0.09, 1.0, 1.2, 0.455, 0.5, 0.6),
    ]),
    railPanelsEnd: mergeGeometries([
      plane(1, 1, 0, 0.5, 1.2),
      plane(1.2, 1, 0.49, 0.5, 0.6, Math.PI / 2),
    ]),
    railTopEnd: mergeGeometries([
      box(1, 0.05, 0.06, 0, 1.0, 1.2),
      box(0.05, 0.05, 1.2, 0.48, 1.0, 0.6),
    ]),
    glazedUpperEnd: mergeGeometries([
      plane(1, 1.45, 0, 1.0 + 0.725, 1.19),
      plane(1.18, 1.45, 0.48, 1.0 + 0.725, 0.6, Math.PI / 2),
    ]),
  };
}

// ─── Builder ─────────────────────────────────────────────────────────────────

export interface BuildingLayer {
  group: THREE.Group;
  /** Meshes with per-triangle owners for picking. */
  pickables: { mesh: THREE.Mesh; owners: number[] }[];
  buildings: Building[];
  /** Detail meshes hidden in the data view (windows, balconies…). */
  details: THREE.Object3D[];
  /** The same detail meshes grouped by LOD cell. */
  detailCells: Map<string, THREE.Object3D[]>;
  /** Cornices of the whole layer (drawn near the camera only). */
  trim: THREE.Mesh | null;
  shells: THREE.Mesh[];
  /**
   * Distance LOD of the walls: one quad per footprint edge (plus the roof's
   * gable / party walls) with the shader repeating the windows, in place of the
   * bay-by-bay walls in `shells[0]`.
   */
  farWalls: THREE.Mesh;
}

interface Edge {
  a: V2;
  b: V2;
  dir: V2;
  out: V2;
  len: number;
}

function edgeOf(ring: V2[], k: number): Edge {
  const a = ring[k];
  const b = ring[(k + 1) % ring.length];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const dir: V2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  return { a, b, dir, out: [dir[1], -dir[0]], len };
}

const along = (e: Edge, u: number, off = 0): V2 => [
  e.a[0] + e.dir[0] * u + e.out[0] * off,
  e.a[1] + e.dir[1] * u + e.out[1] * off,
];

/** Inset of a closed ring by `d` (mitred, good enough for parapet caps). */
function insetRing(ring: V2[], d: number): V2[] {
  return ring.map((p, k) => {
    const prev = ring[(k - 1 + ring.length) % ring.length];
    const next = ring[(k + 1) % ring.length];
    const e0 = [p[0] - prev[0], p[1] - prev[1]];
    const e1 = [next[0] - p[0], next[1] - p[1]];
    const l0 = Math.hypot(e0[0], e0[1]) || 1;
    const l1 = Math.hypot(e1[0], e1[1]) || 1;
    // inward (left) normals of a CCW ring
    const n0 = [-e0[1] / l0, e0[0] / l0];
    const n1 = [-e1[1] / l1, e1[0] / l1];
    const nx = n0[0] + n1[0];
    const ny = n0[1] + n1[1];
    const nl = Math.hypot(nx, ny) || 1;
    const cos = Math.max(0.4, (nx / nl) * n0[0] + (ny / nl) * n0[1]);
    return [p[0] + (nx / nl) * (d / cos), p[1] + (ny / nl) * (d / cos)];
  });
}

// ─── Landmarks: domes, minarets, bell towers ─────────────────────────────────

/** Upright prism of `sides` faces round (cx, cy), from z0 to z1 (walls: blank bays). */
function prism(
  mb: MeshBuilder,
  cx: number,
  cy: number,
  radius: number,
  sides: number,
  z0: number,
  z1: number,
  c: THREE.Color,
  owner: number,
  turn = 0,
): void {
  for (let k = 0; k < sides; k++) {
    const a0 = turn + (k / sides) * Math.PI * 2;
    const a1 = turn + ((k + 1) / sides) * Math.PI * 2;
    const p0: V2 = [cx + Math.cos(a0) * radius, cy + Math.sin(a0) * radius];
    const p1: V2 = [cx + Math.cos(a1) * radius, cy + Math.sin(a1) * radius];
    const am = (a0 + a1) / 2;
    const w = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    mb.quad(
      [
        [p0[0], p0[1], z0],
        [p1[0], p1[1], z0],
        [p1[0], p1[1], z1],
        [p0[0], p0[1], z1],
      ],
      [Math.cos(am), Math.sin(am), 0],
      c,
      [
        [k * w, z0],
        [(k + 1) * w, z0],
        [(k + 1) * w, z1],
        [k * w, z1],
      ],
      0,
      owner,
    );
  }
}

/**
 * Surface of revolution round (cx, cy): `profile` gives [radius, z] from the
 * rim up (a dome's quarter circle, a cone's two points); smooth normals.
 */
function revolve(
  mb: MeshBuilder,
  cx: number,
  cy: number,
  profile: [number, number][],
  sides: number,
  c: THREE.Color,
  owner: number,
): void {
  const rows: number[][] = [];
  for (let j = 0; j < profile.length; j++) {
    const [r, z] = profile[j];
    // Normal of the profile at this point (perpendicular to its slope, outward / up).
    const [ra, za] = profile[Math.max(0, j - 1)];
    const [rb, zb] = profile[Math.min(profile.length - 1, j + 1)];
    const dr = rb - ra;
    const dz = zb - za;
    const len = Math.hypot(dr, dz) || 1;
    const nr = dz / len;
    const nz = -dr / len;
    const row: number[] = [];
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const n = toThree(Math.cos(a) * nr, Math.sin(a) * nr, nz);
      row.push(
        mb.vertex(
          toThree(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z),
          n,
          c,
          k / sides,
          j / Math.max(1, profile.length - 1),
        ),
      );
    }
    rows.push(row);
  }
  for (let j = 0; j + 1 < rows.length; j++)
    for (let k = 0; k < sides; k++) {
      mb.triangle(rows[j][k], rows[j][k + 1], rows[j + 1][k + 1], owner);
      mb.triangle(rows[j][k], rows[j + 1][k + 1], rows[j + 1][k], owner);
    }
}

/**
 * A mosque's dome on a low drum over the prayer hall, and its minaret(s) —
 * slim shafts with a balcony (şerefe) and a lead cone — at the hall's
 * corners; a church's bell tower with a tiled pyramid at the end of its nave.
 * Sizes follow the footprint's oriented box.
 */
function landmarks(
  b: Building,
  ring: V2[],
  wallTop: number,
  wallColor: THREE.Color,
  roofColor: THREE.Color,
  walls: MeshBuilder,
  flats: MeshBuilder,
  tiles: MeshBuilder,
  owner: number,
): void {
  const ob = orientedBox(ring);
  const [cx, cy] = ob.center;
  const ax = ob.axis;
  const nx: V2 = [-ax[1], ax[0]];
  const at = (u: number, v: number): V2 => [cx + ax[0] * u + nx[0] * v, cy + ax[1] * u + nx[1] * v];
  walls.setAttribute('bay', [0, 0, 0]);
  if (b.form === 'mosque') {
    const lead = col('#7a8086');
    const r = Math.min(16, Math.max(2.5, Math.min(ob.halfWidth, ob.halfLength) * 0.72));
    const drumTop = wallTop + Math.max(0.8, r * 0.22);
    prism(walls, cx, cy, r, 16, wallTop - 0.3, drumTop, wallColor, owner);
    const dome: [number, number][] = Array.from({ length: 9 }, (_, j) => {
      const t = (j / 8) * (Math.PI / 2);
      return [Math.max(0.001, Math.cos(t) * r), drumTop + Math.sin(t) * r * 0.95];
    });
    revolve(flats, cx, cy, dome, 16, lead, owner);
    // Finial (alem): a short spike.
    revolve(
      flats,
      cx,
      cy,
      [
        [0.18, drumTop + r * 0.95],
        [0.001, drumTop + r * 0.95 + 1.4],
      ],
      6,
      col('#b89a4a'),
      owner,
    );
    // Minarets: one at a small mosque, two at a large one, at the hall's front corners.
    const mr = b.area > 600 ? 1.5 : 1.15;
    const height = Math.min(62, Math.max(wallTop - b.floorZ + 14, r * 2.4 + 16));
    const top = b.floorZ + height;
    // Not where the data maps the minarets as buildings of their own (b.minarets 0).
    const count = b.minarets ?? (b.area > 1200 ? 2 : 1);
    const corners: V2[] = [
      at(ob.halfLength - mr, ob.halfWidth - mr),
      at(ob.halfLength - mr, -(ob.halfWidth - mr)),
    ].slice(0, count);
    for (const [mx, my] of corners) {
      prism(walls, mx, my, mr, 12, b.baseZ, top, col('#f1eee8'), owner);
      // Şerefe (balcony) three quarters up: a wider ring with a floor on top.
      const sz = b.floorZ + height * 0.78;
      prism(walls, mx, my, mr + 0.55, 12, sz - 0.45, sz, col('#e3ded5'), owner);
      revolve(
        flats,
        mx,
        my,
        [
          [mr + 0.55, sz],
          [mr, sz],
        ],
        12,
        col('#d9d3c8'),
        owner,
      );
      // Lead cone.
      revolve(
        flats,
        mx,
        my,
        [
          [mr * 1.05, top],
          [0.001, top + mr * 3.4],
        ],
        12,
        lead,
        owner,
      );
    }
    return;
  }
  // Church: a square bell tower at the nave's front end, its pyramid roof tiled.
  const s = Math.min(7, Math.max(3.5, Math.min(ob.halfWidth * 1.2, 6)));
  const [tx, ty] = at(ob.halfLength - s / 2, 0);
  const top = wallTop + 8 + s;
  const turn = Math.atan2(ax[1], ax[0]) + Math.PI / 4;
  prism(walls, tx, ty, s / Math.SQRT2, 4, b.baseZ, top, wallColor, owner, turn);
  const apex = top + s * 1.3;
  for (let k = 0; k < 4; k++) {
    const a0 = turn + (k / 4) * Math.PI * 2;
    const a1 = turn + ((k + 1) / 4) * Math.PI * 2;
    const R = (s / Math.SQRT2) * 1.08;
    const p0: [number, number, number] = [tx + Math.cos(a0) * R, ty + Math.sin(a0) * R, top];
    const p1: [number, number, number] = [tx + Math.cos(a1) * R, ty + Math.sin(a1) * R, top];
    const am = (a0 + a1) / 2;
    const slope = Math.atan2(apex - top, R * Math.cos(Math.PI / 4));
    const n = toThree(
      Math.cos(am) * Math.sin(slope),
      Math.sin(am) * Math.sin(slope),
      Math.cos(slope),
    );
    const w = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const ids = [
      tiles.vertex(toThree(...p0), n, roofColor, 0, 0),
      tiles.vertex(toThree(...p1), n, roofColor, w, 0),
      tiles.vertex(toThree(tx, ty, apex), n, roofColor, w / 2, Math.hypot(apex - top, R)),
    ];
    tiles.triangle(ids[0], ids[1], ids[2], owner);
  }
}

/**
 * A mall reads as one from afar: on its front a glazed entrance hall (full
 * height, standing out a metre, a light frame) and a coloured sign band
 * along the top of the front wall.
 */
function mallFront(
  b: Building,
  ring: V2[],
  wallTop: number,
  walls: MeshBuilder,
  owner: number,
): void {
  const f = b.facades.find((x) => x.front);
  if (!f) return;
  const a = ring[f.edge];
  const c = ring[(f.edge + 1) % ring.length];
  const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
  if (len < 20) return;
  const t: V2 = [(c[0] - a[0]) / len, (c[1] - a[1]) / len];
  // Outward normal: the side of the edge away from the footprint's centre.
  const ob = orientedBox(ring);
  let o: V2 = [t[1], -t[0]];
  const mid: V2 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
  if ((ob.center[0] - mid[0]) * o[0] + (ob.center[1] - mid[1]) * o[1] > 0) o = [-o[0], -o[1]];
  const rng = new Rng(b.seed + 23);
  const sign = col(rng.pick(['#c0392b', '#1f5fa8', '#2f8f4e', '#d68910', '#6c3483', '#17202a']));
  const glass = col('#5d7a8c');
  const frame = col('#e9ecee');
  walls.setAttribute('bay', [0, 0, 0]);
  const at = (u: number, d: number, z: number): [number, number, number] => [
    a[0] + t[0] * u + o[0] * d,
    a[1] + t[1] * u + o[1] * d,
    z,
  ];
  const n: [number, number, number] = [o[0], o[1], 0];
  // Quads wound to face their normal (the front edge may run either way round).
  const face = (
    pts: [number, number, number][],
    nn: [number, number, number],
    c: THREE.Color,
    uvs: [number, number][],
  ) => {
    const e1 = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]];
    const e2 = [pts[3][0] - pts[0][0], pts[3][1] - pts[0][1], pts[3][2] - pts[0][2]];
    const cx = e1[1] * e2[2] - e1[2] * e2[1];
    const cy = e1[2] * e2[0] - e1[0] * e2[2];
    const cz = e1[0] * e2[1] - e1[1] * e2[0];
    const ok = cx * nn[0] + cy * nn[1] + cz * nn[2] >= 0;
    walls.quad(ok ? pts : [pts[1], pts[0], pts[3], pts[2]], nn, c, uvs, 0, owner);
  };
  const uv: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  // Sign band, 1.6 m, just under the parapet, a few centimetres proud.
  const z1 = wallTop - 0.2;
  face(
    [at(0, 0.06, z1 - 1.6), at(len, 0.06, z1 - 1.6), at(len, 0.06, z1), at(0, 0.06, z1)],
    n,
    sign,
    uv,
  );
  // Entrance hall: a glass box in the middle of the front, 1 m proud.
  const w = Math.min(18, len * 0.22);
  const u0 = len / 2 - w / 2;
  const u1 = len / 2 + w / 2;
  const z0 = b.floorZ;
  const zt = wallTop + 1.2;
  const d = 1;
  face([at(u0, d, z0), at(u1, d, z0), at(u1, d, zt), at(u0, d, zt)], n, glass, uv);
  const side = (u: number, s: number) =>
    face(
      s > 0
        ? [at(u, 0, z0), at(u, d, z0), at(u, d, zt), at(u, 0, zt)]
        : [at(u, d, z0), at(u, 0, z0), at(u, 0, zt), at(u, d, zt)],
      [t[0] * s, t[1] * s, 0],
      frame,
      uv,
    );
  side(u1, 1);
  side(u0, -1);
  face([at(u0, 0, zt), at(u1, 0, zt), at(u1, d, zt), at(u0, d, zt)], [0, 0, 1], frame, uv);
  // Mullions every 2.4 m across the glass.
  for (let u = u0 + 2.4; u < u1 - 0.5; u += 2.4)
    face(
      [
        at(u - 0.08, d + 0.02, z0),
        at(u + 0.08, d + 0.02, z0),
        at(u + 0.08, d + 0.02, zt),
        at(u - 0.08, d + 0.02, zt),
      ],
      n,
      frame,
      uv,
    );
}

/**
 * Towers from the data, sized by their footprint:
 * - minaret: a round shaft to the top, a balcony (şerefe) three quarters up,
 *   a lead cone and its finial;
 * - transmitter: a mast on its low base, tapering, with antenna rings and
 *   red-and-white bands at the top;
 * - clock tower: clock faces on the four sides under a lead cap;
 * - other towers: battlements on the parapet (built with the walls).
 */
function towerTop(
  b: Building,
  ring: V2[],
  wallTop: number,
  wallColor: THREE.Color,
  walls: MeshBuilder,
  flats: MeshBuilder,
  owner: number,
): void {
  const ob = orientedBox(ring);
  const [cx, cy] = ob.center;
  walls.setAttribute('bay', [0, 0, 0]);
  const lead = col('#7a8086');
  if (b.form === 'minaret') {
    const r = Math.max(0.9, Math.min(3, Math.min(ob.halfWidth, ob.halfLength)));
    const top = b.topZ;
    const height = top - b.floorZ;
    prism(walls, cx, cy, r, 12, b.baseZ, top, wallColor, owner);
    const sz = b.floorZ + height * 0.78;
    prism(walls, cx, cy, r + 0.55, 12, sz - 0.45, sz, col('#e3ded5'), owner);
    revolve(
      flats,
      cx,
      cy,
      [
        [r + 0.55, sz],
        [r, sz],
      ],
      12,
      col('#d9d3c8'),
      owner,
    );
    revolve(
      flats,
      cx,
      cy,
      [
        [r * 1.05, top],
        [0.001, top + r * 3.4],
      ],
      12,
      lead,
      owner,
    );
    revolve(
      flats,
      cx,
      cy,
      [
        [0.12, top + r * 3.4],
        [0.001, top + r * 3.4 + 1.2],
      ],
      6,
      col('#b89a4a'),
      owner,
    );
    return;
  }
  if (b.form === 'telecom') {
    const tip = b.baseZ + (b.towerHeight ?? 70);
    const r0 = Math.max(1.2, Math.min(4, Math.min(ob.halfWidth, ob.halfLength) * 0.5));
    const shaft: [number, number][] = [
      [r0, wallTop],
      [r0 * 0.45, tip - 8],
    ];
    revolve(walls, cx, cy, shaft, 10, col('#d9dbdd'), owner);
    // Antenna rings and the banded top (aviation marking).
    for (const z of [tip - 22, tip - 14])
      prism(walls, cx, cy, r0 * 0.75, 10, z, z + 2.2, col('#f2f2f0'), owner);
    const bands = 4;
    for (let k = 0; k < bands; k++) {
      const z0 = tip - 8 + (k * 8) / bands;
      prism(
        walls,
        cx,
        cy,
        r0 * (0.45 - 0.25 * (k / bands)),
        8,
        z0,
        z0 + 8 / bands,
        col(k % 2 ? '#f2f2f0' : '#c8302a'),
        owner,
      );
    }
    return;
  }
  if (b.form === 'clock') {
    const ax = ob.axis;
    const nx: V2 = [-ax[1], ax[0]];
    const face = col('#f4f1e8');
    const hand = col('#2a2a2a');
    const zc = wallTop - Math.min(3, (wallTop - b.floorZ) * 0.15);
    const rc = Math.max(0.6, Math.min(1.4, Math.min(ob.halfWidth, ob.halfLength) * 0.6));
    for (const [d, half] of [
      [ax, ob.halfLength],
      [[-ax[0], -ax[1]] as V2, ob.halfLength],
      [nx, ob.halfWidth],
      [[-nx[0], -nx[1]] as V2, ob.halfWidth],
    ] as [V2, number][]) {
      const px = cx + d[0] * (half + 0.03);
      const py = cy + d[1] * (half + 0.03);
      const side: V2 = [-d[1], d[0]];
      const n: [number, number, number] = [d[0], d[1], 0];
      const disc = (rad: number, off: number, c: THREE.Color) => {
        const ids: number[] = [];
        const centre = walls.vertex(
          toThree(px + d[0] * off, py + d[1] * off, zc),
          toThree(...n),
          c,
          0,
          0,
        );
        for (let k = 0; k <= 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          ids.push(
            walls.vertex(
              toThree(
                px + d[0] * off + side[0] * Math.cos(a) * rad,
                py + d[1] * off + side[1] * Math.cos(a) * rad,
                zc + Math.sin(a) * rad,
              ),
              toThree(...n),
              c,
              0,
              0,
            ),
          );
        }
        for (let k = 0; k < 16; k++) walls.triangle(centre, ids[k], ids[k + 1], owner);
      };
      disc(rc, 0, face);
      // Hands at ten past ten.
      const handQuad = (ang: number, len: number) => {
        const tx = Math.cos(ang);
        const tz = Math.sin(ang);
        const w = 0.06;
        const o = 0.02;
        const p = (s: number, t: number): [number, number, number] => [
          px + d[0] * o + side[0] * (tx * s - tz * t),
          py + d[1] * o + side[1] * (tx * s - tz * t),
          zc + tz * s + tx * t,
        ];
        walls.quad(
          [p(0, -w), p(len, -w), p(len, w), p(0, w)],
          n,
          hand,
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
          0,
          owner,
        );
      };
      handQuad(Math.PI / 2 + 0.5, rc * 0.75);
      handQuad(Math.PI / 2 - 0.9, rc * 0.55);
    }
    // Lead cap with a finial.
    const R = Math.hypot(ob.halfLength, ob.halfWidth) * 0.95;
    revolve(
      flats,
      cx,
      cy,
      [
        [R, wallTop],
        [0.001, wallTop + R * 1.3],
      ],
      8,
      lead,
      owner,
    );
    revolve(
      flats,
      cx,
      cy,
      [
        [0.1, wallTop + R * 1.3],
        [0.001, wallTop + R * 1.3 + 1],
      ],
      6,
      col('#b89a4a'),
      owner,
    );
    return;
  }
  // Other towers: merlons along the parapet, every 1.6 m.
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const c = ring[(k + 1) % ring.length];
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const n = Math.max(1, Math.floor(len / 1.6));
    for (let i = 0; i < n; i += 2) {
      const t0 = (i + 0.25) / n;
      const t1 = (i + 0.75) / n;
      const p0: V2 = [a[0] + (c[0] - a[0]) * t0, a[1] + (c[1] - a[1]) * t0];
      const p1: V2 = [a[0] + (c[0] - a[0]) * t1, a[1] + (c[1] - a[1]) * t1];
      const out: [number, number, number] = [(c[1] - a[1]) / len, -(c[0] - a[0]) / len, 0];
      walls.quad(
        [
          [p0[0], p0[1], wallTop],
          [p1[0], p1[1], wallTop],
          [p1[0], p1[1], wallTop + 0.7],
          [p0[0], p0[1], wallTop + 0.7],
        ],
        out,
        wallColor,
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        0,
        owner,
      );
    }
  }
}

/**
 * A roof on posts (fuel station canopy, carport, shelter): steel posts at the
 * footprint's corners (every few metres along long sides), the slab's edge
 * band and its underside — the slab top is the flat roof.
 */
function canopy(
  b: Building,
  ring: V2[],
  postColor: THREE.Color,
  slabColor: THREE.Color,
  walls: MeshBuilder,
  flats: MeshBuilder,
  owner: number,
): void {
  const top = b.topZ;
  const under = top - 0.35;
  walls.setAttribute('bay', [0, 0, 0]);
  const inner = insetRing(ring, 0.6);
  for (let k = 0; k < inner.length; k++) {
    const a = inner[k];
    const c = inner[(k + 1) % inner.length];
    const n = Math.max(1, Math.round(Math.hypot(c[0] - a[0], c[1] - a[1]) / 8));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      prism(
        walls,
        a[0] + (c[0] - a[0]) * t,
        a[1] + (c[1] - a[1]) * t,
        0.14,
        6,
        b.baseZ,
        under,
        col('#8d9398'),
        owner,
      );
    }
  }
  // Fascia band round the slab edge.
  for (let k = 0; k < ring.length; k++) {
    const e = edgeOf(ring, k);
    walls.quad(
      [
        [e.a[0], e.a[1], under],
        [e.b[0], e.b[1], under],
        [e.b[0], e.b[1], top + 0.02],
        [e.a[0], e.a[1], top + 0.02],
      ],
      [e.out[0], e.out[1], 0],
      postColor,
      [
        [0, under],
        [e.len, under],
        [e.len, top],
        [0, top],
      ],
      0,
      owner,
    );
  }
  // Underside (lit from below by the sky, seen from the street).
  const { vertices, indices } = triangulate(b.footprint);
  const base = flats.vertexCount;
  for (let k = 0; k < vertices.length; k += 2)
    flats.vertex(
      toThree(vertices[k], vertices[k + 1], under),
      [0, -1, 0],
      slabColor,
      vertices[k],
      vertices[k + 1],
    );
  for (let k = 0; k < indices.length; k += 3) {
    const [i0, i1, i2] = [indices[k], indices[k + 1], indices[k + 2]];
    const ax = vertices[i0 * 2];
    const ay = vertices[i0 * 2 + 1];
    const cr =
      (vertices[i1 * 2] - ax) * (vertices[i2 * 2 + 1] - ay) -
      (vertices[i1 * 2 + 1] - ay) * (vertices[i2 * 2] - ax);
    // Facing down: clockwise seen from above.
    if (cr >= 0) flats.triangle(base + i0, base + i2, base + i1, owner);
    else flats.triangle(base + i0, base + i1, base + i2, owner);
  }
}

/** Height (m) of a stadium's stands at their pitch-side front. */
const STAND_FRONT = 2.5;

export function buildBuildingLayer(
  model: CityModel,
  mats: DtMaterials,
  buildings: Building[],
  name: string,
  /** Groups 3D detail (windows, balconies …) into cells for distance LOD; shells stay one mesh each. */
  cellOf: (b: Building) => string = () => '',
  /** Only what shows from afar: far walls and roofs (no bay walls, trims or 3D detail). */
  farOnly = false,
): BuildingLayer {
  const modules = createModules();
  // Footprints of every building of the tile, with bounding boxes: a roof may
  // not reach into a neighbour (attached buildings).
  const footprints = model.buildings.map((o) => {
    let bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const q of o.footprint.outer)
      bb = [
        Math.min(bb[0], q[0]),
        Math.min(bb[1], q[1]),
        Math.max(bb[2], q[0]),
        Math.max(bb[3], q[1]),
      ];
    return { id: o.id, footprint: o.footprint, bb };
  });
  // By id (the first of a repeated id, as a search would find) and in a 50 m
  // grid: finding the neighbours by scanning every footprint per building was
  // quadratic — a fifth of a 4,000-building tile's meshing (2026-10-12).
  const byId = new Map<string, (typeof footprints)[number]>();
  for (const f of footprints) if (!byId.has(f.id)) byId.set(f.id, f);
  const CELL = 50;
  const grid = new Map<string, number[]>();
  const cellsOf = (bb: number[], pad: number, visit: (key: string) => void) => {
    for (let x = Math.floor((bb[0] - pad) / CELL); x <= Math.floor((bb[2] + pad) / CELL); x++)
      for (let y = Math.floor((bb[1] - pad) / CELL); y <= Math.floor((bb[3] + pad) / CELL); y++)
        visit(`${x},${y}`);
  };
  footprints.forEach((f, i) =>
    cellsOf(f.bb, 0, (key) => {
      const list = grid.get(key);
      if (list) list.push(i);
      else grid.set(key, [i]);
    }),
  );
  const roofArea = (b: Building): Polygon[] => {
    const own = byId.get(b.id)?.bb;
    const grown = offsetPolygons([b.footprint], Math.max(0, b.roof.overhang), 'miter');
    if (!own) return grown;
    const around = new Set<number>();
    cellsOf(own, 2, (key) => grid.get(key)?.forEach((i) => around.add(i)));
    const near = [...around]
      .sort((x, y) => x - y)
      .map((i) => footprints[i])
      .filter(
        (f) =>
          f.id !== b.id &&
          f.bb[0] <= own[2] + 2 &&
          f.bb[2] >= own[0] - 2 &&
          f.bb[1] <= own[3] + 2 &&
          f.bb[3] >= own[1] - 2,
      )
      .map((f) => f.footprint);
    return near.length ? subtractPolygons(grown, offsetPolygons(near, 0.02, 'miter')) : grown;
  };
  const walls = new MeshBuilder();
  // Far-window data for the wall shader: bay = (centre u, window width | 0, window height),
  // floorInfo = (top of ground floor, floor height, top of the last window row).
  walls.defineAttribute('bay', 3);
  walls.defineAttribute('floorInfo', 3);
  // Far walls: bay = (−window period, window width, window height) repeats the window.
  const farWalls = new MeshBuilder();
  farWalls.defineAttribute('bay', 3);
  farWalls.defineAttribute('floorInfo', 3);
  const trims = new MeshBuilder();
  const tiles = new MeshBuilder();
  const flats = new MeshBuilder();
  // Building index per vertex (offset to a global slot on the main thread):
  // scenario colouring looks each building's colour up in one shared texture.
  const shellBuilders = [walls, farWalls, trims, tiles, flats];
  for (const mb of shellBuilders) mb.defineAttribute(BUILDING_SLOT, 1);
  const newInstances = () => ({
    sill: new Instances(),
    glass: new Instances(),
    glassWide: new Instances(),
    glassSingle: new Instances(),
    shopGlass: new Instances(),
    shopFrame: new Instances(),
    door: new Instances(),
    canopy: new Instances(),
    step: new Instances(),
    surround: new Instances(),
    sign: new Instances(),
    slab: new Instances(),
    railSolid: new Instances(),
    railGlass: new Instances(),
    railMetal: new Instances(),
    railTop: new Instances(),
    glazed: new Instances(),
    railSolidEnd: new Instances(),
    railGlassEnd: new Instances(),
    railMetalEnd: new Instances(),
    railTopEnd: new Instances(),
    glazedEnd: new Instances(),
  });
  const cells = new Map<string, ReturnType<typeof newInstances>>();

  buildings.forEach((b, owner) => {
    for (const mb of shellBuilders) mb.setAttribute(BUILDING_SLOT, [owner]);
    const cell = cellOf(b);
    let inst = cells.get(cell);
    if (!inst) {
      inst = newInstances();
      cells.set(cell, inst);
    }
    const rng = new Rng(b.seed + 3);
    const ring = b.footprint.outer as V2[];
    const wallColor = col(b.palette.wall);
    const bandColor = col(b.palette.band);
    const baseColor = col(b.palette.base);
    const trimColor = col(b.palette.trim);
    const frameColor = col(b.palette.frame);
    const roofColor = col(b.palette.roof);
    const flat = b.roof.shape === 'flat';
    const wallTop = b.topZ + (flat ? b.roof.parapet : 0);
    const groundTop = b.floorZ + b.groundFloorHeight;
    const bottom = b.baseZ - 0.6;
    const plinthFinish =
      b.archetype === 'mustakil' || b.archetype === 'eski' ? FINISH.stone : FINISH.plaster;
    // Public buildings: the ground floor in its own colour (palette.band), below a band.
    const groundColor =
      b.use === 'public' && !b.form
        ? bandColor
        : b.shopfront && b.archetype !== 'eski'
          ? b.archetype === 'modern' || b.archetype === 'yuksek'
            ? baseColor
            : trimColor
          : null;
    const hasCornices =
      b.archetype === 'klasik'
        ? rng.chance(0.6)
        : b.archetype === 'modern' || b.archetype === 'yuksek'
          ? rng.chance(0.75)
          : rng.chance(0.3);
    // One balcony front colour per building (reference: salmon / orange / white
    // balcony fronts repeated floor by floor), not a random one per balcony.
    const balconyFront =
      b.archetype === 'modern' || b.archetype === 'yuksek'
        ? rng.chance(0.5)
          ? trimColor
          : bandColor
        : rng.chance(0.65)
          ? bandColor
          : trimColor;
    // Corner pilasters and window surrounds (söve) in a contrast colour, as on
    // the reference blocks and houses; chosen once per building.
    const accent = rng.chance(0.6) ? bandColor : trimColor;
    const pilasters = rng.chance(
      { mustakil: 0.45, eski: 0.4, klasik: 0.55, modern: 0.2, yuksek: 0.2 }[b.archetype],
    );
    const surrounds = rng.chance(
      { mustakil: 0.6, eski: 0.5, klasik: 0.35, modern: 0.1, yuksek: 0.05 }[b.archetype],
    );
    const orielColor = rng.chance(0.5) ? wallColor : bandColor;
    const cornerGlazed = rng.chance(0.5);
    // 2010s blocks: a thick, dark fascia under the roof edge (reference: modern blocks).
    const modernTop = b.archetype === 'modern' || b.archetype === 'yuksek';
    const thickCornice = modernTop && rng.chance(0.7);
    const corniceColor = rng.chance(0.6) ? col('#5a4034') : bandColor;
    /** Opening width of a window bay (wide: three-casement living-room window). */
    const windowWidthOf = (kind: string | undefined, bayW: number) =>
      kind === 'wide-window' || kind === 'tall-triple'
        ? Math.min(bayW - 0.35, Math.max(b.windowWidth * 1.8, 2.2))
        : kind === 'pair-window'
          ? Math.min(bayW - 0.4, b.windowWidth * 1.2 + 0.4)
          : kind === 'small-window'
            ? Math.min(0.6, bayW - 0.6)
            : kind === 'french-window'
              ? Math.min(1.1, bayW - 0.6)
              : kind === 'tall-pair'
                ? Math.min(1.5, bayW - 0.5)
                : Math.min(b.windowWidth, bayW - 0.6);
    const OPENING = new Set([
      'window',
      'wide-window',
      'pair-window',
      'small-window',
      'french-window',
      'tall-pair',
      'tall-triple',
      'balcony',
      'glazed-balcony',
    ]);

    const wallQuad = (
      e: Edge,
      u0: number,
      u1: number,
      z0: number,
      z1: number,
      c: THREE.Color,
      finish: number,
      /** Distance in front of the wall line (cumba fronts, motif strips). */
      off = 0,
    ) => {
      if (z1 - z0 < 0.01) return;
      const p0 = along(e, u0, off);
      const p1 = along(e, u1, off);
      walls.quad(
        [
          [p0[0], p0[1], z0],
          [p1[0], p1[1], z0],
          [p1[0], p1[1], z1],
          [p0[0], p0[1], z1],
        ],
        [e.out[0], e.out[1], 0],
        c,
        [
          [u0, z0],
          [u1, z0],
          [u1, z1],
          [u0, z1],
        ],
        finish,
        owner,
      );
    };

    // Protruding horizontal strip (cornice / floor band) along an edge.
    const strip = (e: Edge, z: number, h: number, depth: number, c: THREE.Color) => {
      const a0 = along(e, -depth * 0.5, 0);
      const b0 = along(e, e.len + depth * 0.5, 0);
      const a1 = along(e, -depth * 0.5, depth);
      const b1 = along(e, e.len + depth * 0.5, depth);
      trims.quad(
        [
          [a1[0], a1[1], z],
          [b1[0], b1[1], z],
          [b1[0], b1[1], z + h],
          [a1[0], a1[1], z + h],
        ],
        [e.out[0], e.out[1], 0],
        c,
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      );
      trims.quad(
        [
          [a1[0], a1[1], z + h],
          [b1[0], b1[1], z + h],
          [b0[0], b0[1], z + h],
          [a0[0], a0[1], z + h],
        ],
        [0, 0, 1],
        c,
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      );
      trims.quad(
        [
          [a0[0], a0[1], z],
          [b0[0], b0[1], z],
          [b1[0], b1[1], z],
          [a1[0], a1[1], z],
        ],
        [0, 0, -1],
        c,
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      );
    };

    /** Vertical strip proud of the wall between u0 and u1 (corner pilaster). */
    const pilaster = (e: Edge, u0: number, u1: number, z0: number, z1: number, c: THREE.Color) => {
      const d = 0.06;
      const a0 = along(e, u0, 0);
      const b0 = along(e, u1, 0);
      const a1 = along(e, u0, d);
      const b1 = along(e, u1, d);
      const uv: [number, number][] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      trims.quad(
        [
          [a1[0], a1[1], z0],
          [b1[0], b1[1], z0],
          [b1[0], b1[1], z1],
          [a1[0], a1[1], z1],
        ],
        [e.out[0], e.out[1], 0],
        c,
        uv,
      );
      for (const [p0, p1, n] of [
        [a0, a1, [-e.dir[0], -e.dir[1], 0]],
        [b1, b0, [e.dir[0], e.dir[1], 0]],
      ] as const) {
        trims.quad(
          [
            [p0[0], p0[1], z0],
            [p1[0], p1[1], z0],
            [p1[0], p1[1], z1],
            [p0[0], p0[1], z1],
          ],
          [n[0], n[1], n[2]],
          c,
          uv,
        );
      }
    };

    walls.setAttribute('floorInfo', [groundTop, b.floorHeight, b.topZ - 0.3]);
    farWalls.setAttribute('floorInfo', [groundTop, b.floorHeight, b.topZ - 0.3]);
    const noWindow = [0, 0, 0];
    const farQuad = (
      e: Edge,
      u0: number,
      u1: number,
      z0: number,
      z1: number,
      c: THREE.Color,
      finish: number,
    ) => {
      if (z1 - z0 < 0.01) return;
      const p0 = along(e, u0, 0);
      const p1 = along(e, u1, 0);
      farWalls.quad(
        [
          [p0[0], p0[1], z0],
          [p1[0], p1[1], z0],
          [p1[0], p1[1], z1],
          [p0[0], p0[1], z1],
        ],
        [e.out[0], e.out[1], 0],
        c,
        [
          [u0, z0],
          [u1, z0],
          [u1, z1],
          [u0, z1],
        ],
        finish,
        owner,
      );
    };
    const facadeByEdge = new Map(b.facades.map((f) => [f.edge, f]));
    // A canopy has no walls: posts and the roof slab only; a minaret is a round
    // shaft of its own (towerTop()).
    for (let k = 0; k < (b.form === 'canopy' || b.form === 'minaret' ? 0 : ring.length); k++) {
      const e = edgeOf(ring, k);
      const f = facadeByEdge.get(k);
      const bays = f?.bays.length ? f.bays.length : 1;
      const bayW = e.len / bays;
      {
        // Far LOD: the façade's commonest window, repeated every bay; one quad
        // per run of bays in the same colour band.
        const kinds = (f?.bays ?? []).filter((k) => OPENING.has(k));
        const ww = kinds.length * 2 >= bays ? windowWidthOf(kinds[0], bayW) : 0;
        // A shopfront ground floor reads from afar; the plinth does not.
        farWalls.setAttribute('bay', noWindow);
        if (groundColor) farQuad(e, 0, e.len, bottom, groundTop, groundColor, FINISH.plaster);
        farWalls.setAttribute('bay', ww > 0.5 ? [-bayW, ww, b.windowHeight] : noWindow);
        for (let i = 0; i < bays; ) {
          const band = f?.bands[i] ?? 0;
          let j = i + 1;
          while (j < bays && (f?.bands[j] ?? 0) === band) j++;
          const finish = FINISH[b.finishes[band] ?? 'plaster'] ?? 0;
          const c = band ? bandColor : wallColor;
          farQuad(e, i * bayW, j * bayW, groundColor ? groundTop : bottom, wallTop, c, finish);
          i = j;
        }
      }
      if (farOnly) continue;
      for (let i = 0; i < bays; i++) {
        const u0 = i * bayW;
        const u1 = (i + 1) * bayW;
        const band = f?.bands[i] ?? 0;
        const c = band ? bandColor : wallColor;
        const finish = FINISH[b.finishes[band] ?? 'plaster'] ?? 0;
        const upper = f?.bays[i];
        const hasWindow = upper !== undefined && OPENING.has(upper);
        const ww = windowWidthOf(upper, bayW);
        const bayAttr = hasWindow && ww > 0.5 ? [(u0 + u1) / 2, ww, b.windowHeight] : noWindow;
        walls.setAttribute('bay', noWindow);
        wallQuad(e, u0, u1, bottom, b.floorZ, baseColor, plinthFinish);
        if (groundColor) {
          wallQuad(e, u0, u1, b.floorZ, groundTop, groundColor, FINISH.plaster);
          walls.setAttribute('bay', bayAttr);
          wallQuad(e, u0, u1, groundTop, wallTop, c, finish);
        } else {
          walls.setAttribute('bay', bayAttr);
          wallQuad(e, u0, u1, b.floorZ, wallTop, c, finish);
        }
        walls.setAttribute('bay', noWindow);
      }

      if (!f || !f.bays.length) continue;
      // Floor bands / cornices.
      if (hasCornices) {
        for (let lv = 1; lv < b.levels; lv++) {
          strip(
            e,
            b.floorZ + b.groundFloorHeight + (lv - 1) * b.floorHeight - 0.08,
            0.16,
            0.09,
            trimColor,
          );
        }
      }
      if (pilasters && e.len > 4) {
        const w = 0.45;
        pilaster(e, 0, w, b.floorZ, wallTop, accent);
        pilaster(e, e.len - w, e.len, b.floorZ, wallTop, accent);
      }
      if (groundColor) strip(e, groundTop - 0.12, 0.24, 0.16, trimColor);
      if (flat) strip(e, wallTop - 0.05, 0.22, 0.2, trimColor);
      if (thickCornice && (flat || b.roof.shape === 'barrel'))
        strip(e, wallTop - (flat ? 0.5 : 0.45), 0.62, 0.5, corniceColor);

      // Ornamental motif strip between two bays (reference: klasik / modern fronts).
      if (f.ornament !== undefined) {
        const u = f.ornament * bayW;
        walls.setAttribute('bay', noWindow);
        wallQuad(
          e,
          u - 0.28,
          u + 0.28,
          groundTop,
          wallTop - 0.25,
          trimColor,
          FINISH.ornament,
          0.03,
        );
      }

      // Cumba: the upper floors of a few bays project as a closed box with windows.
      const orielDepth = 0.75;
      const oriel = f.oriel;
      if (oriel && b.levels >= 2) {
        const ou0 = oriel[0] * bayW + 0.2;
        const ou1 = (oriel[1] + 1) * bayW - 0.2;
        const z0 = groundTop;
        const z1 = flat ? b.topZ : b.topZ - 0.05;
        for (let i = oriel[0]; i <= oriel[1]; i++) {
          const s0 = Math.max(ou0, i * bayW);
          const s1 = Math.min(ou1, (i + 1) * bayW);
          const ww = windowWidthOf(f.bays[i], bayW);
          walls.setAttribute('bay', [(i + 0.5) * bayW, ww, b.windowHeight]);
          wallQuad(e, s0, s1, z0, z1, orielColor, FINISH.plaster, orielDepth);
        }
        walls.setAttribute('bay', noWindow);
        for (const [u, sgn] of [
          [ou0, -1],
          [ou1, 1],
        ] as const) {
          const a = along(e, u, 0);
          const c = along(e, u, orielDepth);
          walls.quad(
            sgn < 0
              ? [
                  [a[0], a[1], z0],
                  [c[0], c[1], z0],
                  [c[0], c[1], z1],
                  [a[0], a[1], z1],
                ]
              : [
                  [c[0], c[1], z0],
                  [a[0], a[1], z0],
                  [a[0], a[1], z1],
                  [c[0], c[1], z1],
                ],
            [e.dir[0] * sgn, e.dir[1] * sgn, 0],
            orielColor,
            [
              [0, z0],
              [orielDepth, z0],
              [orielDepth, z1],
              [0, z1],
            ],
            FINISH.plaster,
            owner,
          );
        }
        const corners = [
          along(e, ou0, 0),
          along(e, ou1, 0),
          along(e, ou1, orielDepth),
          along(e, ou0, orielDepth),
        ];
        const uv: [number, number][] = [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ];
        // Soffit (underside) and cap.
        trims.quad(
          [...corners].reverse().map((p) => [p[0], p[1], z0] as V3),
          [0, 0, -1],
          trimColor,
          uv,
        );
        trims.quad(
          corners.map((p) => [p[0], p[1], z1 + 0.04] as V3),
          [0, 0, 1],
          trimColor,
          uv,
        );
        strip(e, z0 - 0.1, 0.12, orielDepth + 0.08, trimColor);
      }

      // Openings (a flat may differ from its column: f.cells).
      const cellKind = new Map((f.cells ?? []).map(([lv, i, k]) => [`${lv}:${i}`, k]));
      for (let lv = 0; lv < b.levels; lv++) {
        const floorBase = lv === 0 ? b.floorZ : groundTop + (lv - 1) * b.floorHeight;
        for (let i = 0; i < bays; i++) {
          const u = (i + 0.5) * bayW;
          const kind = lv === 0 ? f.groundBays[i] : (cellKind.get(`${lv}:${i}`) ?? f.bays[i]);
          const ww = windowWidthOf(kind, bayW);
          if (ww < 0.5) continue;
          const inOriel = oriel !== undefined && lv >= 1 && i >= oriel[0] && i <= oriel[1];
          switch (kind) {
            case 'window':
            case 'wide-window': {
              const wh = b.windowHeight;
              const z =
                lv === 0
                  ? floorBase + Math.max(0.9, (b.groundFloorHeight - wh) / 2 + 0.25) + wh / 2
                  : floorBase + 0.9 + wh / 2;
              const p = along(e, u, inOriel ? orielDepth : 0);
              (kind === 'wide-window' ? inst.glassWide : inst.glass).add(
                [p[0], p[1], z],
                e.out,
                ww,
                wh,
                1,
                frameColor,
              );
              inst.sill.add([p[0], p[1], z], e.out, ww, wh, 1, trimColor);
              if (surrounds)
                inst.surround.add([p[0], p[1], z], e.out, ww + 0.3, wh + 0.3, 1, accent);
              break;
            }
            case 'pair-window': {
              // Two single-casement windows with a narrow pier between (ikili pencere).
              const wh = b.windowHeight;
              const z =
                lv === 0
                  ? floorBase + Math.max(0.9, (b.groundFloorHeight - wh) / 2 + 0.25) + wh / 2
                  : floorBase + 0.9 + wh / 2;
              const half = (ww - 0.16) / 2;
              for (const s of [-1, 1]) {
                const p = along(e, u + s * (half / 2 + 0.08), inOriel ? orielDepth : 0);
                inst.glassSingle.add([p[0], p[1], z], e.out, half, wh, 1, frameColor);
                inst.sill.add([p[0], p[1], z], e.out, half, wh, 1, trimColor);
              }
              if (surrounds) {
                const p = along(e, u, inOriel ? orielDepth : 0);
                inst.surround.add([p[0], p[1], z], e.out, ww + 0.3, wh + 0.3, 1, accent);
              }
              break;
            }
            case 'small-window': {
              const p = along(e, u, inOriel ? orielDepth : 0);
              const z = floorBase + (lv === 0 ? b.groundFloorHeight : b.floorHeight) - 0.75;
              inst.glassSingle.add([p[0], p[1], z], e.out, ww, 0.6, 1, frameColor);
              inst.sill.add([p[0], p[1], z], e.out, ww, 0.6, 1, trimColor);
              break;
            }
            case 'french-window':
            case 'tall-pair':
            case 'tall-triple': {
              // Door-height windows down to the floor; a French window has a
              // rail flush with the wall.
              const p = along(e, u, inOriel ? orielDepth : 0);
              const h = Math.min(2.3, (lv === 0 ? b.groundFloorHeight : b.floorHeight) - 0.45);
              (kind === 'tall-triple' ? inst.glassWide : inst.glass).add(
                [p[0], p[1], floorBase + 0.08 + h / 2],
                e.out,
                ww,
                h,
                1,
                frameColor,
              );
              if (kind === 'french-window' || lv > 0) {
                const rw = ww + 0.16;
                inst.railMetal.add([p[0], p[1], floorBase], e.out, rw, 1, 0.1);
                inst.railTop.add([p[0], p[1], floorBase], e.out, rw, 1, 0.1, col('#2a2c2e'));
              }
              if (surrounds)
                inst.surround.add(
                  [p[0], p[1], floorBase + 0.08 + h / 2],
                  e.out,
                  ww + 0.3,
                  h + 0.3,
                  1,
                  accent,
                );
              break;
            }
            case 'balcony':
            case 'glazed-balcony': {
              const bw = Math.min(bayW - 0.2, Math.max(2.4, bayW * 0.9));
              const p = along(e, u);
              const railColor = b.rail === 'solid' ? balconyFront : trimColor;
              inst.slab.add([p[0], p[1], floorBase], e.out, bw, 1, 1, balconyFront);
              // Balcony door + window behind the rail.
              const dw = Math.min(bw - 0.4, 1.9);
              inst.glass.add([p[0], p[1], floorBase + 1.2], e.out, dw, 2.2, 1, frameColor);
              // Glazed flat by flat (the compiler's per-flat cells), not by column.
              const glazedHere = kind === 'glazed-balcony';
              if (glazedHere || b.rail === 'solid')
                inst.railSolid.add([p[0], p[1], floorBase], e.out, bw, 1, 1, railColor);
              else if (b.rail === 'glass') {
                inst.railGlass.add([p[0], p[1], floorBase], e.out, bw, 1, 1);
                inst.railTop.add([p[0], p[1], floorBase], e.out, bw, 1, 1, col('#3b3f44'));
              } else {
                inst.railMetal.add([p[0], p[1], floorBase], e.out, bw, 1, 1);
                inst.railTop.add([p[0], p[1], floorBase], e.out, bw, 1, 1, col('#2a2c2e'));
              }
              if (glazedHere) inst.glazed.add([p[0], p[1], floorBase], e.out, bw, 1, 1);
              break;
            }
            case 'door': {
              const p = along(e, u);
              const doorColor = col(rng.pick(DOOR_COLORS));
              inst.door.add([p[0], p[1], floorBase + 1.15], e.out, 1.2, 2.3, 1, doorColor);
              // Steps up to a raised ground floor: tallest block at the wall.
              if (b.plinth > 0.2) {
                const n = Math.max(2, Math.round(b.plinth / 0.17));
                const street = b.floorZ - b.plinth;
                for (let k = 0; k < n; k++) {
                  const h = (b.plinth * (n - k)) / n;
                  inst.step.add([p[0], p[1], street], e.out, 1.7, h, 0.45 + 0.3 * k, STEP_COLOR);
                }
              }
              inst.canopy.add(
                [p[0], p[1], floorBase + 2.75],
                e.out,
                Math.min(bayW - 0.2, 2.0),
                1,
                1.0,
                trimColor,
              );
              break;
            }
            case 'shop': {
              const p = along(e, u);
              const sw = bayW - 0.35;
              const sh = b.groundFloorHeight - 1.15;
              inst.shopGlass.add([p[0], p[1], floorBase + 0.2 + sh / 2], e.out, sw, sh, 1);
              inst.shopFrame.add(
                [p[0], p[1], floorBase + 0.2 + sh / 2],
                e.out,
                sw,
                sh,
                1,
                col(rng.pick(['#2f3338', '#5a5d62', '#e9e6df'])),
              );
              inst.sign.add(
                [p[0], p[1], floorBase + b.groundFloorHeight - 0.55],
                e.out,
                bayW - 0.15,
                0.62,
                1,
                col(rng.pick(SIGN_COLORS)),
              );
              break;
            }
            default:
              break;
          }
        }
      }
    }

    // L-shaped corner balconies on the upper floors: the first leg runs past the
    // corner (covering the corner square), the second leg closes the L with
    // open-ended rails so no partition stands between the two.
    for (const k of farOnly ? [] : (b.cornerBalconies ?? [])) {
      const ea = edgeOf(ring, k);
      const eb = edgeOf(ring, (k + 1) % ring.length);
      const w = Math.min(3.0, ea.len * 0.35, eb.len * 0.35);
      const depth = 1.25;
      const pa = along(ea, ea.len - w + (w + depth) / 2);
      const pb = along(eb, w / 2);
      for (let lv = 1; lv < b.levels; lv++) {
        const z = groundTop + (lv - 1) * b.floorHeight;
        inst.slab.add([pa[0], pa[1], z], ea.out, w + depth, 1, 1, balconyFront);
        inst.slab.add([pb[0], pb[1], z], eb.out, w, 1, 1, balconyFront);
        if (cornerGlazed || b.rail === 'solid') {
          inst.railSolid.add([pa[0], pa[1], z], ea.out, w + depth, 1, 1, balconyFront);
          inst.railSolidEnd.add([pb[0], pb[1], z], eb.out, w, 1, 1, balconyFront);
        } else {
          const top = col(b.rail === 'glass' ? '#3b3f44' : '#2a2c2e');
          (b.rail === 'glass' ? inst.railGlass : inst.railMetal).add(
            [pa[0], pa[1], z],
            ea.out,
            w + depth,
            1,
            1,
          );
          (b.rail === 'glass' ? inst.railGlassEnd : inst.railMetalEnd).add(
            [pb[0], pb[1], z],
            eb.out,
            w,
            1,
            1,
          );
          inst.railTop.add([pa[0], pa[1], z], ea.out, w + depth, 1, 1, top);
          inst.railTopEnd.add([pb[0], pb[1], z], eb.out, w, 1, 1, top);
        }
        if (cornerGlazed) {
          inst.glazed.add([pa[0], pa[1], z], ea.out, w + depth, 1, 1);
          inst.glazedEnd.add([pb[0], pb[1], z], eb.out, w, 1, 1);
        }
        // No extra door: the corner bays keep their windows (city-core turns them into windows).
      }
    }

    // Inner courtyard walls (holes), plain. A stadium's inner edge is the low
    // front of its stands (the seating rakes up from it to the outer wall).
    const holeTop = b.use === 'stadium' ? b.floorZ + STAND_FRONT : wallTop;
    for (const hole of b.footprint.holes as V2[][]) {
      for (let k = 0; k < hole.length; k++) {
        const e = edgeOf(hole, k);
        wallQuad(e, 0, e.len, bottom, holeTop, wallColor, FINISH.plaster);
        farWalls.setAttribute('bay', noWindow);
        farQuad(e, 0, e.len, bottom, holeTop, wallColor, FINISH.plaster);
      }
    }

    // Gable / party walls of the roof go to both wall meshes.
    const roofWallsFrom = [walls.vertexCount, walls.indices.length] as const;
    walls.setAttribute('bay', noWindow);
    if (b.form !== 'minaret')
      buildRoof(
        b,
        roofArea(b),
        ring,
        wallTop,
        roofColor,
        trimColor,
        wallColor,
        tiles,
        flats,
        trims,
        walls,
        owner,
        // Own sequence: the roof comes out the same whether or not the façade detail was built.
        new Rng(b.seed + 11),
      );
    // Domes and minarets, bell towers: built with the roof, so the far walls get them too.
    if (b.form === 'canopy') canopy(b, ring, wallColor, roofColor, walls, flats, owner);
    if (b.form === 'mosque' || b.form === 'church')
      landmarks(b, ring, wallTop, wallColor, roofColor, walls, flats, tiles, owner);
    if (b.form === 'box') mallFront(b, ring, wallTop, walls, owner);
    if (b.form === 'minaret' || b.form === 'telecom' || b.form === 'clock' || b.form === 'tower')
      towerTop(b, ring, wallTop, wallColor, walls, flats, owner);
    farWalls.appendFrom(walls, ...roofWallsFrom);
  });

  const group = new THREE.Group();
  group.name = name;
  const add = <T extends THREE.Object3D | null>(o: T) => {
    if (o) group.add(o);
    return o;
  };

  const nonEmpty = (mb: MeshBuilder) => mb.indices.length > 0;
  const wallMesh = new THREE.Mesh(walls.build({ color: true, finish: true }), mats.wall);
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  wallMesh.name = `${name}-walls`;
  add(wallMesh);
  const farWallMesh = new THREE.Mesh(farWalls.build({ color: true, finish: true }), mats.wall);
  farWallMesh.castShadow = true;
  farWallMesh.receiveShadow = true;
  farWallMesh.name = `${name}-walls-far`;
  add(farWallMesh);
  const tileMesh = new THREE.Mesh(tiles.build({ color: true }), mats.roofTile);
  tileMesh.name = `${name}-roof-tiles`;
  tileMesh.castShadow = true;
  tileMesh.receiveShadow = true;
  if (nonEmpty(tiles)) add(tileMesh);
  const flatMesh = new THREE.Mesh(flats.build({ color: true }), mats.roofFlat);
  flatMesh.name = `${name}-roof-flat`;
  flatMesh.castShadow = true;
  flatMesh.receiveShadow = true;
  if (nonEmpty(flats)) add(flatMesh);
  const trimMesh = new THREE.Mesh(trims.build({ color: true }), mats.trim);
  trimMesh.name = `${name}-trims`;
  trimMesh.castShadow = true;
  trimMesh.receiveShadow = true;
  if (nonEmpty(trims)) add(trimMesh);

  const detailCells = new Map<string, THREE.Object3D[]>();
  for (const [cell, inst] of cells) {
    const objects = [
      inst.glass.build(modules.glass, mats.glass, 'windows', false, 'frameColor'),
      inst.glassWide.build(modules.glass, mats.glassWide, 'windows-wide', false, 'frameColor'),
      inst.glassSingle.build(
        modules.glass,
        mats.glassSingle,
        'windows-single',
        false,
        'frameColor',
      ),
      inst.sill.build(modules.sill, mats.frame, 'sills'),
      inst.shopGlass.build(modules.glass, mats.shopGlass, 'shop-glass'),
      inst.shopFrame.build(modules.shopFrame, mats.frame, 'shop-frames'),
      inst.door.build(modules.door, mats.frame, 'doors'),
      inst.canopy.build(modules.canopy, mats.frame, 'canopies', true),
      inst.step.build(modules.step, mats.frame, 'steps', true),
      inst.surround.build(modules.surround, mats.frame, 'window-surrounds'),
      inst.sign.build(modules.sign, mats.sign, 'signs'),
      inst.slab.build(modules.slab, mats.frame, 'balcony-slabs', true),
      inst.railSolid.build(modules.railSolid, mats.frame, 'rails-solid', true),
      inst.railGlass.build(modules.railPanels, mats.railGlass, 'rails-glass'),
      inst.railMetal.build(modules.railPanels, mats.railMetal, 'rails-metal', true),
      inst.railTop.build(modules.railTop, mats.frame, 'rails-top'),
      inst.glazed.build(modules.glazedUpper, mats.glazed, 'glazed'),
      inst.railSolidEnd.build(modules.railSolidEnd, mats.frame, 'rails-solid-end', true),
      inst.railGlassEnd.build(modules.railPanelsEnd, mats.railGlass, 'rails-glass-end'),
      inst.railMetalEnd.build(modules.railPanelsEnd, mats.railMetal, 'rails-metal-end', true),
      inst.railTopEnd.build(modules.railTopEnd, mats.frame, 'rails-top-end'),
      inst.glazedEnd.build(modules.glazedUpperEnd, mats.glazed, 'glazed-end'),
    ].filter((o): o is THREE.InstancedMesh => o !== null);
    objects.forEach((o) => group.add(o));
    detailCells.set(cell, objects);
  }

  return {
    group,
    // Walls and roofs: a building is picked from the street and from above.
    pickables: [
      { mesh: wallMesh, owners: walls.triangleOwner },
      { mesh: farWallMesh, owners: farWalls.triangleOwner },
      ...(nonEmpty(tiles) ? [{ mesh: tileMesh, owners: tiles.triangleOwner }] : []),
      ...(nonEmpty(flats) ? [{ mesh: flatMesh, owners: flats.triangleOwner }] : []),
    ],
    buildings,
    details: [...detailCells.values()].flat(),
    detailCells,
    shells: [
      wallMesh,
      ...(nonEmpty(tiles) ? [tileMesh] : []),
      ...(nonEmpty(flats) ? [flatMesh] : []),
    ],
    // Cornices / floor bands: many small quads that do not read from afar.
    trim: nonEmpty(trims) ? trimMesh : null,
    farWalls: farWallMesh,
  };
}

function buildRoof(
  b: Building,
  /** Where the roof may reach: footprint plus eaves, less the neighbouring buildings. */
  allowed: Polygon[],
  ring: V2[],
  wallTop: number,
  roofColor: THREE.Color,
  trimColor: THREE.Color,
  wallColor: THREE.Color,
  tiles: MeshBuilder,
  flats: MeshBuilder,
  trims: MeshBuilder,
  walls: MeshBuilder,
  owner: number,
  rng: Rng,
): void {
  if (b.roof.shape === 'flat') {
    // Roof slab slightly below the parapet top, with inner parapet faces.
    const z = b.topZ + 0.02;
    const { vertices, indices } = triangulate(b.footprint);
    // Stands: the top is the seating, raked from the pitch-side front (the
    // hole's edge, low) up to the outer wall; coloured seats, not a grey slab.
    const stands = b.use === 'stadium' && b.footprint.holes.length > 0;
    const front = new Set(
      (b.footprint.holes as V2[][]).flatMap((h) => h.map((q) => `${q[0]},${q[1]}`)),
    );
    const grey = stands ? col('#4f5d70') : new THREE.Color().setScalar(rng.range(0.28, 0.42));
    const base = flats.vertexCount;
    for (let k = 0; k < vertices.length; k += 2) {
      const low = stands && front.has(`${vertices[k]},${vertices[k + 1]}`);
      flats.vertex(
        toThree(vertices[k], vertices[k + 1], low ? b.floorZ + STAND_FRONT : z),
        [0, 1, 0],
        grey,
        vertices[k],
        vertices[k + 1],
      );
    }
    for (let k = 0; k < indices.length; k += 3) {
      const [i0, i1, i2] = [indices[k], indices[k + 1], indices[k + 2]];
      const ax = vertices[i0 * 2];
      const ay = vertices[i0 * 2 + 1];
      const cr =
        (vertices[i1 * 2] - ax) * (vertices[i2 * 2 + 1] - ay) -
        (vertices[i1 * 2 + 1] - ay) * (vertices[i2 * 2] - ax);
      if (cr >= 0) flats.triangle(base + i0, base + i1, base + i2, owner);
      else flats.triangle(base + i0, base + i2, base + i1, owner);
    }
    const inner = insetRing(ring, 0.22);
    for (let k = 0; k < ring.length; k++) {
      const a = inner[k];
      const c = inner[(k + 1) % inner.length];
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      const n: V3 = [-(c[1] - a[1]) / len, (c[0] - a[0]) / len, 0]; // inward
      walls.quad(
        [
          [c[0], c[1], z],
          [a[0], a[1], z],
          [a[0], a[1], wallTop],
          [c[0], c[1], wallTop],
        ],
        n,
        wallColor,
        [
          [len, z],
          [0, z],
          [0, wallTop],
          [len, wallTop],
        ],
        0,
        owner,
      );
      const o0 = ring[k];
      const o1 = ring[(k + 1) % ring.length];
      trims.quad(
        [
          [o0[0], o0[1], wallTop + 0.17],
          [o1[0], o1[1], wallTop + 0.17],
          [c[0], c[1], wallTop + 0.17],
          [a[0], a[1], wallTop + 0.17],
        ],
        [0, 0, 1],
        trimColor,
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      );
    }
    // Stair / lift housing on larger flat roofs.
    if (b.area > 140 && rng.chance(0.7)) {
      const ob = orientedBox(ring);
      const nrm: V2 = [-ob.axis[1], ob.axis[0]];
      const hx = Math.min(2, ob.halfLength * 0.3);
      const hy = Math.min(1.8, ob.halfWidth * 0.4);
      const c0 = ob.center;
      const corner = (su: number, sv: number): V2 => [
        c0[0] + ob.axis[0] * hx * su + nrm[0] * hy * sv,
        c0[1] + ob.axis[1] * hx * su + nrm[1] * hy * sv,
      ];
      const pts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
      const top = z + 2.6;
      for (let k = 0; k < 4; k++) {
        const e = edgeOf(pts, k);
        walls.quad(
          [
            [e.a[0], e.a[1], z],
            [e.b[0], e.b[1], z],
            [e.b[0], e.b[1], top],
            [e.a[0], e.a[1], top],
          ],
          [e.out[0], e.out[1], 0],
          wallColor,
          [
            [0, z],
            [e.len, z],
            [e.len, top],
            [0, top],
          ],
          0,
          owner,
        );
      }
      flats.quad(
        [
          [pts[0][0], pts[0][1], top],
          [pts[1][0], pts[1][1], top],
          [pts[2][0], pts[2][1], top],
          [pts[3][0], pts[3][1], top],
        ],
        [0, 0, 1],
        new THREE.Color(0.35, 0.35, 0.35),
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      );
    }
    return;
  }

  const ob = orientedBox(ring);
  const axis = ob.axis;
  const nrm: V2 = [-axis[1], axis[0]];
  const tan = Math.tan((b.roof.pitchDeg * Math.PI) / 180);
  const o = b.roof.overhang;
  const L = ob.halfLength + o;
  const W = ob.halfWidth + o;
  const eaveZ = b.topZ - o * tan;
  const ridgeZ = b.topZ + ob.halfWidth * tan;
  const at = (u: number, v: number): V2 => [
    ob.center[0] + axis[0] * u + nrm[0] * v,
    ob.center[1] + axis[1] * u + nrm[1] * v,
  ];
  const cosP = Math.cos((b.roof.pitchDeg * Math.PI) / 180);

  // Roof faces are planes over the footprint's oriented box, clipped to the
  // allowed area (an irregular or attached footprint is not its box).
  const face = (pts: V3[], uvOf: (p: V3) => [number, number]) => {
    const [a, c, d] = pts;
    let nx = (c[1] - a[1]) * (d[2] - a[2]) - (c[2] - a[2]) * (d[1] - a[1]);
    let ny = (c[2] - a[2]) * (d[0] - a[0]) - (c[0] - a[0]) * (d[2] - a[2]);
    let nz = (c[0] - a[0]) * (d[1] - a[1]) - (c[1] - a[1]) * (d[0] - a[0]);
    if (nz < 0) [nx, ny, nz] = [-nx, -ny, -nz];
    if (nz < 1e-9) return;
    const len = Math.hypot(nx, ny, nz) || 1;
    const three = toThree(nx / len, ny / len, nz / len);
    const zAt = (x: number, y: number) => a[2] - (nx * (x - a[0]) + ny * (y - a[1])) / nz;
    const pieces = clipPolygons(
      [{ outer: pts.map((p) => [p[0], p[1]] as V2), holes: [] }],
      allowed,
    );
    for (const piece of pieces) {
      const tri = triangulate(piece);
      const ids: number[] = [];
      for (let k = 0; k < tri.vertices.length; k += 2) {
        const p: V3 = [tri.vertices[k], tri.vertices[k + 1], 0];
        p[2] = zAt(p[0], p[1]);
        const [u, v] = uvOf(p);
        ids.push(tiles.vertex(toThree(p[0], p[1], p[2]), three, roofColor, u, v));
      }
      for (let k = 0; k < tri.indices.length; k += 3) {
        const [i0, i1, i2] = [tri.indices[k], tri.indices[k + 1], tri.indices[k + 2]];
        const ax = tri.vertices[i0 * 2];
        const ay = tri.vertices[i0 * 2 + 1];
        const cr =
          (tri.vertices[i1 * 2] - ax) * (tri.vertices[i2 * 2 + 1] - ay) -
          (tri.vertices[i1 * 2 + 1] - ay) * (tri.vertices[i2 * 2] - ax);
        if (Math.abs(cr) < 1e-9) continue;
        if (cr > 0) tiles.triangle(ids[i0], ids[i1], ids[i2], owner);
        else tiles.triangle(ids[i0], ids[i2], ids[i1], owner);
      }
    }
  };
  const rel = (p: V3) => [
    (p[0] - ob.center[0]) * axis[0] + (p[1] - ob.center[1]) * axis[1],
    (p[0] - ob.center[0]) * nrm[0] + (p[1] - ob.center[1]) * nrm[1],
  ];
  const uvSide = (p: V3): [number, number] => {
    const [u, v] = rel(p);
    return [u, (W - Math.abs(v)) / cosP];
  };
  const uvEnd = (p: V3): [number, number] => {
    const [u, v] = rel(p);
    return [v, (L - Math.abs(u)) / cosP];
  };

  const c = (u: number, v: number, z: number): V3 => {
    const p = at(u, v);
    return [p[0], p[1], z];
  };

  if (b.roof.shape === 'barrel') {
    // Arched roof across the short side, as on 2010s blocks (reference renders).
    const rise = barrelRise(ob.halfWidth);
    const archZ = (v: number) => b.topZ + rise * Math.max(0, 1 - (v / W) ** 2);
    const N = 14;
    let arc = 0;
    for (let j = 0; j < N; j++) {
      const v0 = -W + (2 * W * j) / N;
      const v1 = -W + (2 * W * (j + 1)) / N;
      const z0 = archZ(v0);
      const z1 = archZ(v1);
      const seg = Math.hypot(v1 - v0, z1 - z0);
      const a0 = arc;
      arc += seg;
      face([c(-L, v0, z0), c(L, v0, z0), c(L, v1, z1), c(-L, v1, z1)], (p) => {
        const [u, v] = rel(p);
        return [u, Math.abs(v - v0) < 1e-6 ? a0 : a0 + seg];
      });
    }
  } else if (b.roof.shape === 'gable') {
    const r0 = c(-L, 0, ridgeZ);
    const r1 = c(L, 0, ridgeZ);
    face([c(-L, -W, eaveZ), c(L, -W, eaveZ), r1, r0], uvSide);
    face([c(L, W, eaveZ), c(-L, W, eaveZ), r0, r1], uvSide);
  } else {
    const hip = Math.max(0, ob.halfLength - ob.halfWidth);
    const r0 = c(-hip, 0, ridgeZ);
    const r1 = c(hip, 0, ridgeZ);
    face([c(-L, -W, eaveZ), c(L, -W, eaveZ), r1, r0], uvSide);
    face([c(L, W, eaveZ), c(-L, W, eaveZ), r0, r1], uvSide);
    face([c(L, -W, eaveZ), c(L, W, eaveZ), r1], uvEnd);
    face([c(-L, W, eaveZ), c(-L, -W, eaveZ), r0], uvEnd);
  }

  // Height of the (unclipped) roof surface over a point.
  const ridgeHalf = Math.max(0, ob.halfLength - ob.halfWidth);
  const roofZ = (p: V2): number => {
    const u = (p[0] - ob.center[0]) * axis[0] + (p[1] - ob.center[1]) * axis[1];
    const v = Math.abs((p[0] - ob.center[0]) * nrm[0] + (p[1] - ob.center[1]) * nrm[1]);
    if (b.roof.shape === 'barrel')
      return b.topZ + barrelRise(ob.halfWidth) * Math.max(0, 1 - (v / W) ** 2);
    const side = ridgeZ - v * tan;
    if (b.roof.shape === 'gable') return side;
    return Math.min(side, ridgeZ - Math.max(0, Math.abs(u) - ridgeHalf) * tan);
  };
  // Walls up to the roof wherever it rises above the wall top: gable ends,
  // party walls where the roof stops at a neighbour, corners of an irregular
  // footprint under its box roof. Sampled every metre along each edge; runs of
  // samples on one straight line (a planar roof face) become one quad.
  for (let k = 0; k < ring.length; k++) {
    const e = edgeOf(ring, k);
    const n = Math.max(1, Math.ceil(e.len / 1));
    const n3 = toThree(e.out[0], e.out[1], 0);
    const pointAt = (t: number): V2 => [
      e.a[0] + (e.b[0] - e.a[0]) * t,
      e.a[1] + (e.b[1] - e.a[1]) * t,
    ];
    const zs = Array.from({ length: n + 1 }, (_, i) => roofZ(pointAt(i / n)));
    const rises = (i: number) => zs[i] >= b.topZ + 0.03 || zs[i + 1] >= b.topZ + 0.03;
    const top = (i: number) => Math.max(b.topZ, zs[i]);
    /** Samples between i and j lie within 2 cm of the straight top from i to j. */
    const straight = (i: number, j: number) => {
      for (let m = i + 1; m < j; m++) {
        if (Math.abs(top(m) - (top(i) + ((top(j) - top(i)) * (m - i)) / (j - i))) > 0.02)
          return false;
      }
      return true;
    };
    for (let i = 0; i < n; ) {
      if (!rises(i)) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < n && rises(j) && straight(i, j + 1)) j++;
      const t0 = i / n;
      const t1 = j / n;
      i = j;
      const p0 = pointAt(t0);
      const p1 = pointAt(t1);
      const z0 = roofZ(p0);
      const z1 = roofZ(p1);
      const ids = [
        walls.vertex(toThree(p0[0], p0[1], b.topZ - 0.05), n3, wallColor, t0 * e.len, b.topZ, 0),
        walls.vertex(toThree(p1[0], p1[1], b.topZ - 0.05), n3, wallColor, t1 * e.len, b.topZ, 0),
        walls.vertex(toThree(p1[0], p1[1], Math.max(b.topZ, z1)), n3, wallColor, t1 * e.len, z1, 0),
        walls.vertex(toThree(p0[0], p0[1], Math.max(b.topZ, z0)), n3, wallColor, t0 * e.len, z0, 0),
      ];
      walls.triangle(ids[0], ids[1], ids[2], owner);
      walls.triangle(ids[0], ids[2], ids[3], owner);
    }
  }
  // Fascia board and soffit along the eaves (edges of the roof below the wall top).
  for (const poly of allowed) {
    for (const r of [poly.outer]) {
      for (let k = 0; k < r.length; k++) {
        const e = edgeOf(r as V2[], k);
        const za = roofZ(e.a);
        const zb = roofZ(e.b);
        if (za > b.topZ + 0.05 || zb > b.topZ + 0.05 || e.len < 0.05) continue;
        trims.quad(
          [
            [e.a[0], e.a[1], za - 0.2],
            [e.b[0], e.b[1], zb - 0.2],
            [e.b[0], e.b[1], zb + 0.02],
            [e.a[0], e.a[1], za + 0.02],
          ],
          [e.out[0], e.out[1], 0],
          trimColor,
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
        );
      }
    }
  }
  const eaves = subtractPolygons(allowed, [b.footprint]);
  const down = toThree(0, 0, -1);
  for (const poly of eaves) {
    const tri = triangulate(poly);
    const ids: number[] = [];
    for (let k = 0; k < tri.vertices.length; k += 2)
      ids.push(
        trims.vertex(
          toThree(tri.vertices[k], tri.vertices[k + 1], eaveZ - 0.2),
          down,
          trimColor,
          0,
          0,
        ),
      );
    for (let k = 0; k < tri.indices.length; k += 3) {
      const [i0, i1, i2] = [tri.indices[k], tri.indices[k + 1], tri.indices[k + 2]];
      const ax = tri.vertices[i0 * 2];
      const ay = tri.vertices[i0 * 2 + 1];
      const cr =
        (tri.vertices[i1 * 2] - ax) * (tri.vertices[i2 * 2 + 1] - ay) -
        (tri.vertices[i1 * 2 + 1] - ay) * (tri.vertices[i2 * 2] - ax);
      // Facing down: clockwise from above.
      if (cr > 0) trims.triangle(ids[i0], ids[i2], ids[i1]);
      else trims.triangle(ids[i0], ids[i1], ids[i2]);
    }
  }
}
