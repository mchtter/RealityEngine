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

export function buildBuildingLayer(
  model: CityModel,
  mats: DtMaterials,
  buildings: Building[],
  name: string,
  /** Groups 3D detail (windows, balconies …) into cells for distance LOD; shells stay one mesh each. */
  cellOf: (b: Building) => string = () => '',
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
  const roofArea = (b: Building): Polygon[] => {
    const own = footprints.find((f) => f.id === b.id)?.bb;
    const grown = offsetPolygons([b.footprint], Math.max(0, b.roof.overhang), 'miter');
    if (!own) return grown;
    const near = footprints
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
  const trims = new MeshBuilder();
  const tiles = new MeshBuilder();
  const flats = new MeshBuilder();
  // Building index per vertex (offset to a global slot on the main thread):
  // scenario colouring looks each building's colour up in one shared texture.
  const shellBuilders = [walls, trims, tiles, flats];
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
    const groundColor =
      b.shopfront && b.archetype !== 'eski'
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
    const noWindow = [0, 0, 0];
    const facadeByEdge = new Map(b.facades.map((f) => [f.edge, f]));
    for (let k = 0; k < ring.length; k++) {
      const e = edgeOf(ring, k);
      const f = facadeByEdge.get(k);
      const bays = f?.bays.length ? f.bays.length : 1;
      const bayW = e.len / bays;
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
    for (const k of b.cornerBalconies ?? []) {
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

    // Inner courtyard walls (holes), plain.
    for (const hole of b.footprint.holes as V2[][]) {
      for (let k = 0; k < hole.length; k++) {
        const e = edgeOf(hole, k);
        wallQuad(e, 0, e.len, bottom, wallTop, wallColor, FINISH.plaster);
      }
    }

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
      rng,
    );
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
    const grey = new THREE.Color().setScalar(rng.range(0.28, 0.42));
    const base = flats.vertexCount;
    for (let k = 0; k < vertices.length; k += 2) {
      flats.vertex(
        toThree(vertices[k], vertices[k + 1], z),
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
  // footprint under its box roof. Sampled every metre along each edge.
  for (let k = 0; k < ring.length; k++) {
    const e = edgeOf(ring, k);
    const n = Math.max(1, Math.ceil(e.len / 1));
    const n3 = toThree(e.out[0], e.out[1], 0);
    for (let i = 0; i < n; i++) {
      const t0 = i / n;
      const t1 = (i + 1) / n;
      const p0: V2 = [e.a[0] + (e.b[0] - e.a[0]) * t0, e.a[1] + (e.b[1] - e.a[1]) * t0];
      const p1: V2 = [e.a[0] + (e.b[0] - e.a[0]) * t1, e.a[1] + (e.b[1] - e.a[1]) * t1];
      const z0 = roofZ(p0);
      const z1 = roofZ(p1);
      if (z0 < b.topZ + 0.03 && z1 < b.topZ + 0.03) continue;
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
