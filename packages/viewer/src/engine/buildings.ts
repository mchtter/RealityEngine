import { type Building, type CityModel, Rng, orientedBox, triangulate } from '@opentwin/city-core';
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
    shopGlass: new Instances(),
    shopFrame: new Instances(),
    door: new Instances(),
    canopy: new Instances(),
    sign: new Instances(),
    slab: new Instances(),
    railSolid: new Instances(),
    railGlass: new Instances(),
    railMetal: new Instances(),
    railTop: new Instances(),
    glazed: new Instances(),
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

    const wallQuad = (
      e: Edge,
      u0: number,
      u1: number,
      z0: number,
      z1: number,
      c: THREE.Color,
      finish: number,
    ) => {
      if (z1 - z0 < 0.01) return;
      const p0 = along(e, u0);
      const p1 = along(e, u1);
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
        const hasWindow = upper === 'window' || upper === 'balcony' || upper === 'glazed-balcony';
        const ww = Math.min(b.windowWidth, bayW - 0.6);
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
      if (groundColor) strip(e, groundTop - 0.12, 0.24, 0.16, trimColor);
      if (flat) strip(e, wallTop - 0.05, 0.22, 0.2, trimColor);

      // Openings.
      for (let lv = 0; lv < b.levels; lv++) {
        const floorBase = lv === 0 ? b.floorZ : groundTop + (lv - 1) * b.floorHeight;
        for (let i = 0; i < bays; i++) {
          const u = (i + 0.5) * bayW;
          const kind = lv === 0 ? f.groundBays[i] : f.bays[i];
          const ww = Math.min(b.windowWidth, bayW - 0.6);
          if (ww < 0.5) continue;
          switch (kind) {
            case 'window': {
              const wh = b.windowHeight;
              const z =
                lv === 0
                  ? floorBase + Math.max(0.9, (b.groundFloorHeight - wh) / 2 + 0.25) + wh / 2
                  : floorBase + 0.9 + wh / 2;
              const p = along(e, u);
              inst.glass.add([p[0], p[1], z], e.out, ww, wh, 1, frameColor);
              inst.sill.add([p[0], p[1], z], e.out, ww, wh, 1, trimColor);
              break;
            }
            case 'balcony':
            case 'glazed-balcony': {
              const bw = Math.min(bayW - 0.2, Math.max(2.4, bayW * 0.9));
              const p = along(e, u);
              const railColor =
                b.rail === 'solid' ? (rng.chance(0.5) ? trimColor : bandColor) : trimColor;
              inst.slab.add([p[0], p[1], floorBase], e.out, bw, 1, 1, trimColor);
              // Balcony door + window behind the rail.
              const dw = Math.min(bw - 0.4, 1.9);
              inst.glass.add([p[0], p[1], floorBase + 1.2], e.out, dw, 2.2, 1, frameColor);
              // Residents glaze some balconies floor by floor.
              const glazedHere = kind === 'glazed-balcony' || rng.chance(0.12);
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

    // Inner courtyard walls (holes), plain.
    for (const hole of b.footprint.holes as V2[][]) {
      for (let k = 0; k < hole.length; k++) {
        const e = edgeOf(hole, k);
        wallQuad(e, 0, e.len, bottom, wallTop, wallColor, FINISH.plaster);
      }
    }

    buildRoof(
      b,
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
      inst.sill.build(modules.sill, mats.frame, 'sills'),
      inst.shopGlass.build(modules.glass, mats.shopGlass, 'shop-glass'),
      inst.shopFrame.build(modules.shopFrame, mats.frame, 'shop-frames'),
      inst.door.build(modules.door, mats.frame, 'doors'),
      inst.canopy.build(modules.canopy, mats.frame, 'canopies', true),
      inst.sign.build(modules.sign, mats.sign, 'signs'),
      inst.slab.build(modules.slab, mats.frame, 'balcony-slabs', true),
      inst.railSolid.build(modules.railSolid, mats.frame, 'rails-solid', true),
      inst.railGlass.build(modules.railPanels, mats.railGlass, 'rails-glass'),
      inst.railMetal.build(modules.railPanels, mats.railMetal, 'rails-metal', true),
      inst.railTop.build(modules.railTop, mats.frame, 'rails-top'),
      inst.glazed.build(modules.glazedUpper, mats.glazed, 'glazed'),
    ].filter((o): o is THREE.InstancedMesh => o !== null);
    objects.forEach((o) => group.add(o));
    detailCells.set(cell, objects);
  }

  return {
    group,
    pickables: [{ mesh: wallMesh, owners: walls.triangleOwner }],
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

  const face = (pts: V3[], uvOf: (p: V3) => [number, number]) => {
    // Orient upward.
    const [a, c, d] = pts;
    const nx = (c[1] - a[1]) * (d[2] - a[2]) - (c[2] - a[2]) * (d[1] - a[1]);
    const ny = (c[2] - a[2]) * (d[0] - a[0]) - (c[0] - a[0]) * (d[2] - a[2]);
    const nz = (c[0] - a[0]) * (d[1] - a[1]) - (c[1] - a[1]) * (d[0] - a[0]);
    const flip = nz < 0;
    const ordered = flip ? [...pts].reverse() : pts;
    const len = Math.hypot(nx, ny, nz) || 1;
    const n: [number, number, number] = flip
      ? [-nx / len, -ny / len, -nz / len]
      : [nx / len, ny / len, nz / len];
    const three = toThree(n[0], n[1], n[2]);
    const ids = ordered.map((p) => {
      const [u, v] = uvOf(p);
      return tiles.vertex(toThree(p[0], p[1], p[2]), three, roofColor, u, v);
    });
    for (let k = 1; k + 1 < ids.length; k++) tiles.triangle(ids[0], ids[k], ids[k + 1], owner);
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

  if (b.roof.shape === 'gable') {
    const r0 = c(-L, 0, ridgeZ);
    const r1 = c(L, 0, ridgeZ);
    face([c(-L, -W, eaveZ), c(L, -W, eaveZ), r1, r0], uvSide);
    face([c(L, W, eaveZ), c(-L, W, eaveZ), r0, r1], uvSide);
    // Gable end walls.
    for (const s of [-1, 1]) {
      const g0 = c(s * ob.halfLength, -ob.halfWidth, b.topZ);
      const g1 = c(s * ob.halfLength, ob.halfWidth, b.topZ);
      const top = c(s * ob.halfLength, 0, ridgeZ);
      const n = toThree(axis[0] * s, axis[1] * s, 0);
      const ids = (s > 0 ? [g0, g1, top] : [g1, g0, top]).map((p) =>
        walls.vertex(toThree(p[0], p[1], p[2]), n, wallColor, 0, p[2], 0),
      );
      walls.triangle(ids[0], ids[1], ids[2], owner);
    }
  } else {
    const ridgeHalf = Math.max(0, ob.halfLength - ob.halfWidth);
    const r0 = c(-ridgeHalf, 0, ridgeZ);
    const r1 = c(ridgeHalf, 0, ridgeZ);
    face([c(-L, -W, eaveZ), c(L, -W, eaveZ), r1, r0], uvSide);
    face([c(L, W, eaveZ), c(-L, W, eaveZ), r0, r1], uvSide);
    face([c(L, -W, eaveZ), c(L, W, eaveZ), r1], uvEnd);
    face([c(-L, W, eaveZ), c(-L, -W, eaveZ), r0], uvEnd);
  }

  // Fascia board and soffit along the eaves.
  const corners: V2[] = [at(-L, -W), at(L, -W), at(L, W), at(-L, W)];
  for (let k = 0; k < 4; k++) {
    const e = edgeOf(corners, k);
    trims.quad(
      [
        [e.a[0], e.a[1], eaveZ - 0.2],
        [e.b[0], e.b[1], eaveZ - 0.2],
        [e.b[0], e.b[1], eaveZ + 0.02],
        [e.a[0], e.a[1], eaveZ + 0.02],
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
  trims.quad(
    [
      [corners[3][0], corners[3][1], eaveZ - 0.2],
      [corners[2][0], corners[2][1], eaveZ - 0.2],
      [corners[1][0], corners[1][1], eaveZ - 0.2],
      [corners[0][0], corners[0][1], eaveZ - 0.2],
    ],
    [0, 0, -1],
    trimColor,
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  );
}
