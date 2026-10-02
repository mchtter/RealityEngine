import { CutGround } from '@opentwin/city-core';
import * as THREE from 'three/webgpu';
import { toThree } from './geom';
import { BUILDING_SLOT, type DtMaterials } from './materials';
import type { PropMode } from './props';
import { type BuildingInfo, type TilePayload, type TileSummary, buildMesh } from './tile-payload';

/** 3D window / balcony / roof detail of a sub-tile is drawn within this distance (+ its radius). */
const DETAIL_RANGE = 150;
/** Street furniture is drawn for tiles closer than this (metres, ground distance). */
const FURNITURE_RANGE = 700;
/** Beyond this the tile uses its coarse terrain and drops kerbs / lane markings. */
const GROUND_DETAIL_RANGE = 900;

interface SubTile {
  /** Centre in tile-local three.js coordinates. */
  center: THREE.Vector3;
  radius: number;
  obsDetail: THREE.Mesh[];
  synDetail: THREE.Mesh[];
  obsProps: THREE.Mesh[];
  synProps: THREE.Mesh[];
}

const SUB_ROLE = /^sub:(\d+):(obsShell|obsDetail|synShell|synDetail|obsProps|synProps)$/;

/**
 * One compiled city tile in the scene, assembled from buffers the tile
 * worker prepared (no geometry work here). Visibility follows role tags:
 * detail and furniture only near the camera, holograms / fixes in the data view.
 */
export class CityTile {
  readonly group = new THREE.Group();
  private readonly fix: THREE.Mesh[] = [];
  private readonly propsShowcase: THREE.Mesh[] = [];
  private readonly propsData: THREE.Mesh[] = [];
  private readonly groundNear: THREE.Mesh[] = [];
  private readonly groundFar: THREE.Mesh[] = [];
  /** Cornices: shown with ground detail (near tiles); synthetic ones hidden in the data view. */
  private readonly trims: { mesh: THREE.Mesh; synthetic: boolean }[] = [];
  private readonly subTiles: SubTile[];
  private readonly synShells: { mesh: THREE.Mesh; material: THREE.Material }[] = [];
  private readonly pickables: { mesh: THREE.Mesh; ids: string[]; owners: Int32Array }[] = [];
  private readonly buildingsById: Map<string, BuildingInfo>;
  private readonly local = new THREE.Vector3();
  private data = false;
  readonly summary: TileSummary;
  private readonly ground: CutGround;
  /** Building ids per shell layer, in slot order (see TilePayload.slots). */
  readonly slots: TilePayload['slots'];

  constructor(
    readonly key: string,
    payload: TilePayload,
    /** World model coordinates of this tile's (0, 0). */
    readonly offset: [number, number],
    private readonly mats: DtMaterials,
    geometryCache: Map<string, THREE.BufferGeometry>,
    /** Start of this tile's building slot ranges in the scenario texture (null: none free). */
    readonly slotBases: { obs: number | null; syn: number | null },
  ) {
    this.slots = payload.slots;
    this.summary = payload.summary;
    this.ground = new CutGround(payload.summary.terrain, payload.summary.terrainCut);
    this.buildingsById = new Map(payload.summary.buildings.map((b) => [b.id, b]));
    this.group.name = `tile-${key}`;
    this.group.position.set(...toThree(offset[0], offset[1], 0));
    this.subTiles = payload.subTiles.map((s) => ({
      center: new THREE.Vector3(...s.center),
      radius: s.radius,
      obsDetail: [],
      synDetail: [],
      obsProps: [],
      synProps: [],
    }));
    for (const p of payload.meshes) {
      const mesh = buildMesh(p, mats, geometryCache);
      this.group.add(mesh);
      const layer = /^tile:(obs|syn)(Shell|Trim)$/.exec(p.role)?.[1] as 'obs' | 'syn' | undefined;
      if (layer) this.globalSlots(mesh, slotBases[layer]);
      if (p.pick) this.pickables.push({ mesh, ids: p.pick.ids, owners: p.pick.owners });
      if (p.role === 'fix') {
        mesh.visible = false;
        this.fix.push(mesh);
      } else if (p.role === 'ground:near') {
        this.groundNear.push(mesh);
      } else if (p.role === 'ground:far') {
        mesh.visible = false;
        this.groundFar.push(mesh);
      } else if (p.role === 'tile:obsTrim' || p.role === 'tile:synTrim') {
        this.trims.push({ mesh, synthetic: p.role === 'tile:synTrim' });
      } else if (p.role === 'tile:synShell') {
        this.synShells.push({ mesh, material: mesh.material as THREE.Material });
      } else if (p.role === 'props:showcase') {
        this.propsShowcase.push(mesh);
      } else if (p.role === 'props:data') {
        mesh.visible = false;
        this.propsData.push(mesh);
      } else {
        const m = SUB_ROLE.exec(p.role);
        if (!m) continue;
        const sub = this.subTiles[Number(m[1])];
        switch (m[2]) {
          case 'synShell':
            this.synShells.push({ mesh, material: mesh.material as THREE.Material });
            break;
          case 'obsDetail':
            sub.obsDetail.push(mesh);
            break;
          case 'synDetail':
            sub.synDetail.push(mesh);
            break;
          case 'obsProps':
            sub.obsProps.push(mesh);
            break;
          case 'synProps':
            sub.synProps.push(mesh);
            break;
          default:
            break;
        }
      }
    }
    this.group.updateMatrixWorld(true);
  }

  /** Tile-local building indices of a shell → global scenario texture slots (0 = none). */
  private globalSlots(mesh: THREE.Mesh, base: number | null): void {
    const attr = mesh.geometry.getAttribute(BUILDING_SLOT) as THREE.BufferAttribute | undefined;
    if (!attr) return;
    const a = attr.array as Float32Array;
    for (let i = 0; i < a.length; i++) a[i] = base === null ? 0 : a[i] + base;
  }

  /** Building info by id (scenario colouring, picking). */
  building(id: string): BuildingInfo | undefined {
    return this.buildingsById.get(id);
  }

  /** Near sub-tiles get full 3D detail; far ones show shells with shader windows. */
  updateDetail(camera: THREE.Vector3): void {
    this.local.copy(camera).sub(this.group.position);
    const b = this.summary.bounds;
    const dx = Math.max(b.minX - this.local.x, 0, this.local.x - b.maxX);
    const dz = Math.max(-b.maxY - this.local.z, 0, this.local.z + b.minY);
    const tileDistance = Math.hypot(dx, dz);
    const furniture = tileDistance < FURNITURE_RANGE;
    const groundDetail = tileDistance < GROUND_DETAIL_RANGE;
    for (const m of this.groundNear) m.visible = groundDetail;
    for (const m of this.groundFar) m.visible = !groundDetail;
    for (const t of this.trims) t.mesh.visible = groundDetail && !(t.synthetic && this.data);
    for (const m of this.propsShowcase) m.visible = furniture && !this.data;
    for (const m of this.propsData) m.visible = furniture && this.data;
    for (const t of this.subTiles) {
      const near = this.local.distanceTo(t.center) < DETAIL_RANGE + t.radius;
      for (const m of t.obsDetail) m.visible = near;
      for (const m of t.obsProps) m.visible = near;
      for (const m of t.synDetail) m.visible = near && !this.data;
      for (const m of t.synProps) m.visible = near && !this.data;
    }
  }

  setMode(mode: PropMode): void {
    this.data = mode === 'data';
    // Synthetic buildings become translucent holograms so observed data stands out.
    for (const s of this.synShells) {
      s.mesh.material = this.data ? this.mats.holoBuilding : s.material;
      s.mesh.castShadow = !this.data;
    }
    for (const m of this.fix) m.visible = this.data;
  }

  /** Ground height (trench floor in an underpass) at a world point, or null when outside this tile. */
  heightAt(x: number, y: number): number | null {
    const lx = x - this.offset[0];
    const ly = y - this.offset[1];
    const b = this.summary.bounds;
    if (lx < b.minX || lx > b.maxX || ly < b.minY || ly > b.maxY) return null;
    return this.ground.heightAt(lx, ly);
  }

  /**
   * Bridge decks and tunnel roads over / under a world point, a tunnel road
   * with its clear height. Not limited to the tile's bounds: a deck's part in
   * this tile may end a little past its edge, at a vertex the neighbour's
   * part starts from.
   */
  decksAt(x: number, y: number): { h: number; clear?: number }[] {
    const lx = x - this.offset[0];
    const ly = y - this.offset[1];
    const out: { h: number; clear?: number }[] = [];
    for (const d of this.summary.decks ?? []) {
      for (let k = 1; k < d.path.length; k++) {
        const a = d.path[k - 1];
        const b = d.path[k];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((lx - a[0]) * dx + (ly - a[1]) * dy) / l2)) : 0;
        if (Math.hypot(lx - a[0] - dx * t, ly - a[1] - dy * t) <= d.half) {
          out.push({ h: a[2] + (b[2] - a[2]) * t, clear: d.clear });
          break;
        }
      }
    }
    return out;
  }

  pick(ray: THREE.Raycaster): { d: number; b: BuildingInfo } | null {
    let best: { d: number; b: BuildingInfo } | null = null;
    for (const p of this.pickables) {
      const hit = ray.intersectObject(p.mesh, false)[0];
      if (!hit || hit.faceIndex == null) continue;
      const owner = p.owners[hit.faceIndex];
      const b = owner >= 0 ? this.buildingsById.get(p.ids[owner]) : undefined;
      if (b && (!best || hit.distance < best.d)) best = { d: hit.distance, b };
    }
    return best;
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh && !o.geometry.userData.shared) o.geometry.dispose();
    });
    this.group.removeFromParent();
  }
}
