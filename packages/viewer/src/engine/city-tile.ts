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
    for (const m of this.fix) m.visible = this.data || this.cuts;
  }

  private cuts = false;

  /** Shows what was cut off buildings (red) without the rest of the data view. */
  setShowFixes(on: boolean): void {
    this.cuts = on;
    for (const m of this.fix) m.visible = this.data || on;
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

  /**
   * Whatever a ray hits first in this tile: a building, a structure (bridge,
   * trench, portal, tunnel, garden wall) with all its triangles, a street
   * prop (by instance), or a piece of ground / road surface with the one
   * triangle hit. The highlight geometry is in world coordinates.
   */
  inspect(
    ray: THREE.Raycaster,
  ): { d: number; info: DtInspect; highlight: THREE.BufferGeometry } | null {
    let best: { d: number; info: DtInspect; highlight: THREE.BufferGeometry } | null = null;
    const shown = (o: THREE.Object3D) => {
      for (let x: THREE.Object3D | null = o; x; x = x.parent) if (!x.visible) return false;
      return true;
    };
    const pickOf = new Map(this.pickables.map((p) => [p.mesh, p]));
    this.group.updateMatrixWorld(true);
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !shown(mesh)) return;
      const g = mesh.geometry as THREE.InstancedBufferGeometry;
      if (g.isInstancedBufferGeometry) {
        if (!/^(real|holo)-/.test(mesh.name)) return;
        const hit = instanceHit(ray, mesh);
        if (hit && (!best || hit.d < best.d)) {
          const kind = mesh.name.replace(/^(real|holo-syn|holo-sug)-/, '');
          best = {
            d: hit.d,
            info: {
              kind: 'prop',
              label: PROP_LABEL[kind] ?? kind,
              detail: mesh.name.startsWith('holo') ? 'veride yok (prosedürel)' : undefined,
              mesh: mesh.name,
              tile: this.key,
              point: this.worldPoint(hit.point),
            },
            highlight: sphereOutline(hit.center, hit.radius),
          };
        }
        return;
      }
      const hit = ray.intersectObject(mesh, false)[0];
      if (!hit || hit.faceIndex == null || (best && hit.distance >= best.d)) return;
      const pick = pickOf.get(mesh);
      const owner = pick ? pick.owners[hit.faceIndex] : -1;
      const id = owner >= 0 && pick ? pick.ids[owner] : undefined;
      let info: DtInspect;
      if (id && !id.includes('|')) {
        const b = this.buildingsById.get(id);
        info = {
          kind: 'building',
          label: 'Bina',
          sourceId: b?.ref ?? (b?.osmId ? `osm:w${b.osmId}` : id),
          detail: b ? `${b.archetype}, ${b.levels} kat, ${b.source}` : undefined,
          mesh: mesh.name,
          tile: this.key,
          point: this.worldPoint(hit.point),
          building: b,
        };
      } else if (id) {
        const [kind, source, detail] = id.split('|');
        info = {
          kind: kind as DtInspect['kind'],
          label: FEATURE_LABEL[kind] ?? kind,
          sourceId: source || undefined,
          detail: detail || undefined,
          mesh: mesh.name,
          tile: this.key,
          point: this.worldPoint(hit.point),
          triangle: hit.faceIndex,
        };
      } else {
        info = {
          kind: 'surface',
          label: SURFACE_LABEL[mesh.name] ?? mesh.name,
          detail: `üçgen #${hit.faceIndex}`,
          mesh: mesh.name,
          tile: this.key,
          point: this.worldPoint(hit.point),
          triangle: hit.faceIndex,
        };
      }
      best = {
        d: hit.distance,
        info,
        highlight: trianglesOf(
          mesh,
          owner >= 0 && pick ? (f) => pick.owners[f] === owner : (f) => f === hit.faceIndex,
        ),
      };
    });
    return best;
  }

  /** World model coordinates (x east, y north, z up) of a three.js world point. */
  private worldPoint(p: THREE.Vector3): [number, number, number] {
    return [p.x, -p.z, p.y];
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

/** What the inspect mode found under the cursor. */
export interface DtInspect {
  kind:
    | 'building'
    | 'bridge'
    | 'cutting'
    | 'portal'
    | 'tunnel'
    | 'lid'
    | 'fence'
    | 'prop'
    | 'surface';
  /** Kind in words (Turkish UI). */
  label: string;
  /** Source feature (e.g. "r:osm:w123" for the road a bridge carries). */
  sourceId?: string;
  detail?: string;
  /** Mesh name (renderer layer). */
  mesh: string;
  tile: string;
  /** World model coordinates: x east, y north, z up. */
  point: [number, number, number];
  building?: BuildingInfo;
  triangle?: number;
}

const FEATURE_LABEL: Record<string, string> = {
  bridge: 'Köprü / viyadük',
  cutting: 'Alt geçit hendeği (rampa + istinat duvarları)',
  portal: 'Tünel ağzı (portal)',
  tunnel: 'Tünel tüpü',
  lid: 'Tünel ağzı kapağı',
  fence: 'Bahçe duvarı / çit',
};

const SURFACE_LABEL: Record<string, string> = {
  terrain: 'Arazi',
  'terrain-coarse': 'Arazi (uzak)',
  'terrain-carved': 'Arazi (hendek çevresi)',
  surfaces: 'Yol / kaldırım / avlu yüzeyi',
  'surfaces-coarse': 'Yol yüzeyi (uzak)',
  markings: 'Yol çizgisi',
  sea: 'Deniz',
};

const PROP_LABEL: Record<string, string> = {
  tree: 'Ağaç',
  'tree-pine': 'Çam',
  'street-lamp': 'Sokak lambası',
  'traffic-signal': 'Trafik lambası',
  'bus-stop': 'Otobüs durağı',
  bench: 'Bank',
  'waste-basket': 'Çöp kutusu',
  'power-pole': 'Elektrik direği',
  car: 'Park etmiş araç',
  booth: 'Otopark kulübesi',
  'barrier-arm': 'Otopark bariyeri',
  swing: 'Salıncak',
  slide: 'Kaydırak',
  seesaw: 'Tahterevalli',
  climber: 'Tırmanma oyuncağı',
  gate: 'Bahçe kapısı',
  'lamp-glow': 'Sokak lambası',
};

/** Triangles of a mesh (those `keep` selects) copied out in world coordinates. */
function trianglesOf(mesh: THREE.Mesh, keep: (face: number) => boolean): THREE.BufferGeometry {
  const g = mesh.geometry as THREE.BufferGeometry;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const index = g.getIndex();
  const faces = (index ? index.count : pos.count) / 3;
  const out: number[] = [];
  const v = new THREE.Vector3();
  for (let f = 0; f < faces; f++) {
    if (!keep(f)) continue;
    for (let k = 0; k < 3; k++) {
      const i = index ? index.getX(f * 3 + k) : f * 3 + k;
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  }
  const h = new THREE.BufferGeometry();
  h.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  return h;
}

/** Three great circles around a sphere (outline of a picked prop). */
function sphereOutline(c: THREE.Vector3, r: number): THREE.BufferGeometry {
  const out: number[] = [];
  const n = 48;
  for (let axis = 0; axis < 3; axis++) {
    for (let k = 0; k < n; k++) {
      for (const j of [k, k + 1]) {
        const a = (j / n) * Math.PI * 2;
        const p = [Math.cos(a) * r, Math.sin(a) * r, 0];
        const q = axis === 0 ? p : axis === 1 ? [p[0], 0, p[1]] : [0, p[0], p[1]];
        out.push(c.x + q[0], c.y + q[1], c.z + q[2]);
      }
    }
  }
  const h = new THREE.BufferGeometry();
  h.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  h.userData.lines = true;
  return h;
}

/** Ray test against the bounding sphere of every instance of an instanced mesh. */
function instanceHit(
  ray: THREE.Raycaster,
  mesh: THREE.Mesh,
): { d: number; point: THREE.Vector3; center: THREE.Vector3; radius: number } | null {
  const g = mesh.geometry as THREE.InstancedBufferGeometry;
  let base = mesh.userData.baseSphere as THREE.Sphere | undefined;
  if (!base) {
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const box = new THREE.Box3().setFromBufferAttribute(pos);
    base = box.getBoundingSphere(new THREE.Sphere());
    mesh.userData.baseSphere = base;
  }
  const cols = ['iM0', 'iM1', 'iM2', 'iM3'].map((n) => g.getAttribute(n) as THREE.BufferAttribute);
  if (cols.some((c) => !c)) return null;
  const m = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  const p = new THREE.Vector3();
  let best: { d: number; point: THREE.Vector3; center: THREE.Vector3; radius: number } | null =
    null;
  // Exact test on the model's triangles for instances whose sphere the ray
  // meets (a tall lamp's sphere covers far more than the lamp).
  let probe = mesh.userData.probe as THREE.Mesh | undefined;
  if (!probe) {
    const base = new THREE.BufferGeometry();
    base.setAttribute('position', g.getAttribute('position'));
    if (g.index) base.setIndex(g.index);
    probe = new THREE.Mesh(base, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    probe.matrixAutoUpdate = false;
    mesh.userData.probe = probe;
  }
  for (let i = 0; i < g.instanceCount; i++) {
    m.set(
      cols[0].getX(i),
      cols[1].getX(i),
      cols[2].getX(i),
      cols[3].getX(i),
      cols[0].getY(i),
      cols[1].getY(i),
      cols[2].getY(i),
      cols[3].getY(i),
      cols[0].getZ(i),
      cols[1].getZ(i),
      cols[2].getZ(i),
      cols[3].getZ(i),
      cols[0].getW(i),
      cols[1].getW(i),
      cols[2].getW(i),
      cols[3].getW(i),
    );
    m.premultiply(mesh.matrixWorld);
    sphere.copy(base).applyMatrix4(m);
    if (!ray.ray.intersectSphere(sphere, p)) continue;
    probe.matrixWorld.copy(m);
    const exact = ray.intersectObject(probe, false)[0];
    if (!exact) continue;
    const d = exact.distance;
    if (!best || d < best.d)
      best = {
        d,
        point: exact.point.clone(),
        center: sphere.center.clone(),
        radius: sphere.radius,
      };
  }
  return best;
}
