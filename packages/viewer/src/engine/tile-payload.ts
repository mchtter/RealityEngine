import type {
  Building,
  CityModel,
  DataCheck,
  Fix,
  TerrainCut,
  TerrainGrid,
  TileFrameInput,
  UtilityKind,
} from '@opentwin/city-core';
import * as THREE from 'three/webgpu';
import { type MallSign, mallSigns } from './mall-signs';
import {
  type DtMaterials,
  INSTANCE_COLOR_ATTRIBUTE,
  INSTANCE_MATRIX_ATTRIBUTES,
  instancedVariant,
} from './materials';
import { type StationSign, stationSigns } from './station-signs';
import { type StreetLine, streetLines } from './street-lines';
import { CONCOURSE_HEIGHT, CORRIDOR_HALF, CORRIDOR_HEIGHT } from './underground';

/**
 * Transfer format between the tile worker (builds geometry off the main
 * thread) and the engine (only wraps ready buffers in three.js objects).
 */

type TypedArray = Float32Array | Uint16Array | Uint32Array | Int32Array | Uint8Array;

export interface AttributePayload {
  array: TypedArray;
  itemSize: number;
  normalized: boolean;
  /** InstancedBufferAttribute (per-instance data, e.g. window frame colour). */
  instanced: boolean;
}

export interface MeshPayload {
  name: string;
  /** Key into DtMaterials. */
  material: keyof DtMaterials;
  /** Role tag wiring visibility / mode switches (see CityTile). */
  role: string;
  attributes: Record<string, AttributePayload>;
  index: Uint16Array | Uint32Array | null;
  /** Bounding sphere of the geometry (or of all instances). */
  sphere: [number, number, number, number];
  instanced: boolean;
  count: number;
  instanceMatrix: Float32Array | null;
  instanceColor: Float32Array | null;
  /** Shared prop module geometry: reused from the engine's cache. */
  geometryKey: string | null;
  matrix: number[];
  castShadow: boolean;
  receiveShadow: boolean;
  renderOrder: number;
  /** Picking: building id per owner index, owner per triangle. */
  pick: { ids: string[]; owners: Int32Array } | null;
}

/** The part of a building the UI needs (card, fixes, focus) — not its geometry. */
export type BuildingInfo = BuildingFacts & {
  /** Footprint box in tile-local metres [minX, minY, maxX, maxY] (camera focus, lists). */
  box: [number, number, number, number];
};
type BuildingFacts = Pick<
  Building,
  | 'id'
  | 'source'
  | 'ref'
  | 'entity'
  | 'attrs'
  | 'parcelRef'
  | 'osmId'
  | 'archetype'
  | 'area'
  | 'provenance'
  | 'levels'
  | 'topZ'
  | 'floorZ'
  | 'shopfront'
  | 'fixIds'
>;

/** Light view of a compiled tile kept on the main thread. */
export interface TileSummary {
  name: string;
  frame?: TileFrameInput;
  bounds: CityModel['bounds'];
  origin: CityModel['origin'];
  stats: Record<string, number>;
  attribution: string[];
  terrain: TerrainGrid;
  fixes: Fix[];
  /** Source data to verify (tile coords). */
  checks?: DataCheck[];
  buildings: BuildingInfo[];
  /** Underpass trenches and tunnel lids cut into the terrain. */
  terrainCut?: TerrainCut;
  /**
   * Surfaces off the terrain one can stand on: bridge decks and tunnel roads
   * (tile coords); a tunnel road has its clear height.
   */
  decks: { path: [number, number, number][]; half: number; clear?: number }[];
  /** Floors one can walk on under the ground (station concourses): outline, level, clear height. */
  floors?: { ring: [number, number][]; z: number; clear: number }[];
  /** Station name boards over underground platforms. */
  signs?: StationSign[];
  /** Malls' names on their fronts. */
  mallSigns?: MallSign[];
  /** Named ground streets (centreline on the street surface), for their names on the map. */
  streets?: StreetLine[];
  /** Points of interest (tile coords, on the ground), for the map's icons. */
  pois?: { kind: string; name?: string; position: [number, number, number] }[];
  /** No city data in the tile (drawn as the grey grid). */
  empty: boolean;
  /** Buried networks in the tile: runs and length (km) per network. */
  utilities: Partial<Record<UtilityKind, { runs: number; km: number; cabinets?: number }>>;
}

export interface TilePayload {
  summary: TileSummary;
  meshes: MeshPayload[];
  /** Detail LOD sub-tiles: centre (tile-local three.js coords) and radius. */
  subTiles: { center: [number, number, number]; radius: number }[];
  /**
   * Building ids in the order of the shells' `bslot` attribute, per layer
   * (observed / synthetic shells are separate meshes with their own indices).
   */
  slots: { obs: string[]; syn: string[] };
  /**
   * Ground picture of the tile (landcover.ts: GROUND_SIZE² RGBA, sRGB, row 0
   * at the south edge) the terrain is textured with; absent on an empty tile.
   */
  ground?: Uint8Array;
}

/** No city data in the tile at all: the blank start of a city (grey grid ground). */
export const isEmptyTile = (model: CityModel) =>
  !model.roads.length &&
  !model.buildings.length &&
  !model.areas.length &&
  !model.props.length &&
  !model.utilities?.length;

function footprintBox(ring: [number, number][]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

export function summarize(model: CityModel): TileSummary {
  return {
    name: model.name,
    frame: model.frame,
    bounds: model.bounds,
    origin: model.origin,
    stats: model.stats,
    attribution: model.attribution,
    terrain: model.terrain,
    ...(model.terrainCut ? { terrainCut: model.terrainCut } : {}),
    fixes: model.fixes,
    ...(model.checks?.length ? { checks: model.checks } : {}),
    utilities: utilityStats(model),
    empty: isEmptyTile(model),
    streets: streetLines(model.roads),
    pois: [
      ...(model.pois ?? []).map((p) => ({ kind: p.kind, name: p.name, position: p.position })),
      // Metro entrances are points of interest on the map too.
      ...(model.underground?.entrances ?? []).map((e) => ({
        kind: 'subway_entrance',
        name: e.name,
        position: e.position,
      })),
    ],
    decks: [
      ...(model.bridges ?? []).map((b) => ({ path: b.path, half: b.width / 2 })),
      ...(model.tunnels ?? []).map((t) => ({ path: t.path, half: t.width / 2, clear: t.height })),
      // The corridors from metro entrances into their stations.
      ...(model.underground?.entrances ?? [])
        .filter((e) => e.passage)
        .map((e) => ({ path: e.passage!, half: CORRIDOR_HALF, clear: CORRIDOR_HEIGHT })),
      // Stairs from concourses down to their platforms.
      ...(model.underground?.structures ?? [])
        .filter((s) => s.stairs)
        .map((s) => ({
          path: [s.stairs!.from, s.stairs!.to],
          half: s.stairs!.width / 2,
          clear: CORRIDOR_HEIGHT,
        })),
    ],
    signs: stationSigns(model),
    mallSigns: mallSigns(model),
    floors: (model.underground?.structures ?? []).map((s) => ({
      ring: s.footprint.outer,
      z: s.floorZ,
      clear: CONCOURSE_HEIGHT,
    })),
    buildings: model.buildings.map((b) => ({
      id: b.id,
      source: b.source,
      ref: b.ref,
      entity: b.entity,
      attrs: b.attrs,
      parcelRef: b.parcelRef,
      osmId: b.osmId,
      archetype: b.archetype,
      area: b.area,
      provenance: b.provenance,
      levels: b.levels,
      topZ: b.topZ,
      floorZ: b.floorZ,
      shopfront: b.shopfront,
      fixIds: b.fixIds,
      box: footprintBox(b.footprint.outer),
    })),
  };
}

/** Runs, length (km) and street cabinets of each buried network in a tile. */
function utilityStats(model: CityModel): TileSummary['utilities'] {
  const out: TileSummary['utilities'] = {};
  for (const p of model.props) {
    if (p.kind !== 'street-cabinet' || !p.network) continue;
    const s = (out[p.network] ??= { runs: 0, km: 0 });
    s.cabinets = (s.cabinets ?? 0) + 1;
  }
  for (const u of model.utilities ?? []) {
    const s = (out[u.kind] ??= { runs: 0, km: 0 });
    s.runs++;
    for (let k = 1; k < u.path.length; k++)
      s.km += Math.hypot(u.path[k][0] - u.path[k - 1][0], u.path[k][1] - u.path[k - 1][1]) / 1000;
  }
  return out;
}

const roleOf = (o: THREE.Object3D): string => {
  for (let cur: THREE.Object3D | null = o; cur; cur = cur.parent) {
    if (typeof cur.userData.role === 'string') return cur.userData.role;
  }
  return 'ground';
};

/** Serializes every mesh under `root` (worker side). Returns transferable buffers too. */
export function serializeMeshes(root: THREE.Object3D): {
  meshes: MeshPayload[];
  transfer: ArrayBuffer[];
} {
  root.updateMatrixWorld(true);
  const meshes: MeshPayload[] = [];
  const transfer = new Set<ArrayBuffer>();
  // Shared module geometry is reused for every tile in the worker: copy, never transfer.
  const own = <T extends TypedArray>(arr: T, shared: boolean): T => {
    if (shared) return arr.slice() as T;
    transfer.add(arr.buffer as ArrayBuffer);
    return arr;
  };
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry as THREE.BufferGeometry;
    const shared = !!g.userData.shared;
    const instanced = (mesh as THREE.InstancedMesh).isInstancedMesh === true;
    const attributes: Record<string, AttributePayload> = {};
    for (const [name, attr] of Object.entries(g.attributes)) {
      const a = attr as THREE.BufferAttribute;
      attributes[name] = {
        array: own(a.array as TypedArray, shared),
        itemSize: a.itemSize,
        normalized: a.normalized,
        instanced: (a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute === true,
      };
    }
    if (instanced) (mesh as THREE.InstancedMesh).computeBoundingSphere();
    else if (!g.boundingSphere) g.computeBoundingSphere();
    const s = instanced ? (mesh as THREE.InstancedMesh).boundingSphere! : g.boundingSphere!;
    const im = instanced ? (mesh as THREE.InstancedMesh) : null;
    const pick = mesh.userData.pick as { ids: string[]; owners: number[] } | undefined;
    const owners = pick ? Int32Array.from(pick.owners) : null;
    if (owners) transfer.add(owners.buffer as ArrayBuffer);
    meshes.push({
      name: mesh.name,
      material: mesh.material as unknown as keyof DtMaterials,
      role: roleOf(mesh),
      attributes,
      index: g.index ? own(g.index.array as Uint16Array | Uint32Array, shared) : null,
      sphere: [s.center.x, s.center.y, s.center.z, s.radius],
      instanced,
      count: im ? im.count : 0,
      instanceMatrix: im ? own(im.instanceMatrix.array as Float32Array, false) : null,
      instanceColor: im?.instanceColor ? own(im.instanceColor.array as Float32Array, false) : null,
      geometryKey: shared ? ((g.userData.moduleKey as string | undefined) ?? null) : null,
      matrix: mesh.matrixWorld.elements.slice(),
      castShadow: mesh.castShadow,
      receiveShadow: mesh.receiveShadow,
      renderOrder: mesh.renderOrder,
      pick: pick && owners ? { ids: pick.ids, owners } : null,
    });
  });
  return { meshes, transfer: [...transfer] };
}

const attributeOf = (a: AttributePayload) =>
  a.instanced
    ? new THREE.InstancedBufferAttribute(a.array, a.itemSize, a.normalized)
    : new THREE.BufferAttribute(a.array, a.itemSize, a.normalized);

/**
 * Instanced payload → plain Mesh over an InstancedBufferGeometry carrying the
 * instance matrix / tint as attributes, drawn with the material's shared
 * instanced variant (see instancedVariant: InstancedMesh rebuilt shaders per object).
 * The geometry owns all its buffers (module geometry is copied, not shared),
 * so disposing one tile never releases another tile's buffers.
 */
function buildInstanced(p: MeshPayload, matrices: Float32Array, mats: DtMaterials): THREE.Mesh {
  const geometry = new THREE.InstancedBufferGeometry();
  for (const [name, a] of Object.entries(p.attributes)) geometry.setAttribute(name, attributeOf(a));
  if (p.index) geometry.setIndex(new THREE.BufferAttribute(p.index, 1));
  INSTANCE_MATRIX_ATTRIBUTES.forEach((name, c) => {
    const column = new Float32Array(p.count * 4);
    for (let i = 0; i < p.count; i++) {
      for (let k = 0; k < 4; k++) column[i * 4 + k] = matrices[i * 16 + c * 4 + k];
    }
    geometry.setAttribute(name, new THREE.InstancedBufferAttribute(column, 4));
  });
  if (p.instanceColor) {
    geometry.setAttribute(
      INSTANCE_COLOR_ATTRIBUTE,
      new THREE.InstancedBufferAttribute(p.instanceColor, 3),
    );
  }
  geometry.instanceCount = p.count;
  // Sphere around all instances (object space): frustum culling of the whole set.
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(p.sphere[0], p.sphere[1], p.sphere[2]),
    p.sphere[3],
  );
  const base = mats[p.material] as unknown as THREE.Material;
  return new THREE.Mesh(geometry, instancedVariant(base, p.instanceColor !== null));
}

/** Number of drawn instances of a mesh (1 unless it uses an InstancedBufferGeometry). */
export function instancesOf(mesh: THREE.Mesh): number {
  const g = mesh.geometry as THREE.InstancedBufferGeometry;
  return g.isInstancedBufferGeometry ? g.instanceCount : 1;
}

/** Wraps a serialized mesh in three.js objects (main thread). */
export function buildMesh(
  p: MeshPayload,
  mats: DtMaterials,
  cache: Map<string, THREE.BufferGeometry>,
): THREE.Mesh {
  if (p.instanced && p.instanceMatrix) {
    const mesh = buildInstanced(p, p.instanceMatrix, mats);
    placeMesh(mesh, p);
    return mesh;
  }
  let geometry = p.geometryKey ? cache.get(p.geometryKey) : undefined;
  if (!geometry) {
    geometry = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(p.attributes))
      geometry.setAttribute(name, attributeOf(a));
    if (p.index) geometry.setIndex(new THREE.BufferAttribute(p.index, 1));
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(p.sphere[0], p.sphere[1], p.sphere[2]),
      p.sphere[3],
    );
    if (p.geometryKey) {
      geometry.userData.shared = true;
      cache.set(p.geometryKey, geometry);
    }
  }
  const mesh = new THREE.Mesh(geometry, mats[p.material] as unknown as THREE.Material);
  placeMesh(mesh, p);
  return mesh;
}

function placeMesh(mesh: THREE.Mesh, p: MeshPayload): void {
  mesh.name = p.name;
  mesh.matrixAutoUpdate = false;
  mesh.matrix.fromArray(p.matrix);
  mesh.castShadow = p.castShadow;
  mesh.receiveShadow = p.receiveShadow;
  mesh.renderOrder = p.renderOrder;
}
