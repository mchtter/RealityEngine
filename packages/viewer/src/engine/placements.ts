import { type CityPlacement, type FacilityInterior, cityClass } from '@kavra/core';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as THREE from 'three/webgpu';
import { prefabMesh } from './prefabs';

export interface PlacementFrame {
  worldOf(lon: number, lat: number): [number, number] | null;
  heightAt(x: number, y: number): number;
  /**
   * Bytes of an uploaded model (GLB); null: unknown asset. The host app
   * supplies it (with its session): the engine knows no API.
   */
  loadModel(assetId: string): Promise<ArrayBuffer> | null;
}

/** Floor plate colour by the ontology class of a space (domain fallback). */
const SPACE_COLOUR: Record<string, string> = {
  'building.hall': '#d9d2c3',
  'building.room': '#c6d4e2',
  'building.common_area': '#e4cfa0',
  'energy.solar_array': '#2d4a86',
  'industry.production_hall': '#d2c6b0',
  'social.pitch': '#4ea64e',
  'social.stand_sector': '#9aa3ad',
  'building.unit': '#e7b58a',
  'building.stairwell': '#8f99a3',
  'commerce.shop': '#f0c36d',
  'transit.metro_platform': '#cfd6dc',
  'health.emergency_department': '#e06666',
  'safety.temporary_shelter': '#e9ecef',
};

const EQUIPMENT_COLOUR: Record<string, string> = {
  'energy.inverter': '#e0a030',
  'energy.power_transformer': '#7a7f86',
  'energy.switchgear': '#4f6b85',
  'industry.machine': '#d06030',
  'industry.storage_rack': '#a07040',
  'industry.loading_dock': '#5a5f64',
  'aviation.checkin_counter': '#3a6ea5',
  'aviation.security_checkpoint': '#c03838',
  'aviation.baggage_claim': '#3d4247',
  'aviation.jet_bridge': '#b9bec2',
  'building.service_desk': '#3a6ea5',
  'social.turnstile': '#6b7177',
};

const domainColour = (classId: string | undefined, fallback: string) => {
  if (!classId) return fallback;
  let h = 0;
  for (const ch of cityClass(classId)?.domain ?? classId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360}, 35%, 60%)`;
};

/** Uploaded models farther than this from the camera are not drawn (m). */
const GLB_DRAW_DISTANCE = 4000;

/** Compass heading (degrees clockwise from north) → rotation about three's up axis. */
const yawOf = (heading: number) => (-heading * Math.PI) / 180;

/**
 * Placed models in the DT scene: prefabs (procedural) and uploaded GLB files,
 * stood on the ground at their point, turned to their heading and scaled. A
 * selected placement gets an outline; a placement opened "inside" shows its
 * facility interior floor by floor (levels pulled apart by `explode` metres)
 * with the shell faded around it.
 */
export class PlacementLayer {
  readonly group = new THREE.Group();
  private readonly body = new THREE.MeshStandardNodeMaterial({
    roughness: 0.7,
    metalness: 0.05,
    vertexColors: true,
  });
  private readonly glass = new THREE.MeshStandardNodeMaterial({
    color: 0x6f8ea8,
    roughness: 0.15,
    metalness: 0.6,
  });
  private readonly ghost = new THREE.MeshStandardNodeMaterial({
    color: 0xbfd3e6,
    roughness: 0.6,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
  });
  private readonly plate = new THREE.MeshStandardNodeMaterial({
    roughness: 0.85,
    vertexColors: true,
  });
  private readonly outline = new THREE.LineBasicNodeMaterial({ color: 0xffb000, depthTest: false });
  /** Room / zone borders on the floor plates (inside view). */
  private readonly edges = new THREE.LineBasicNodeMaterial({ color: 0x1e293b });

  private readonly roots = new Map<string, THREE.Group>();
  private readonly rotors: { obj: THREE.Object3D; axis: THREE.Vector3; rpm: number }[] = [];
  private readonly glbCache = new Map<string, Promise<THREE.Group>>();
  private list: CityPlacement[] = [];
  private frame: PlacementFrame | null = null;
  private selected: string | null = null;
  private inside: { id: string; explode: number } | null = null;
  private generation = 0;

  constructor() {
    this.group.name = 'placements';
  }

  /** Draws `list` (replaces what was drawn). Call again when the ground under them changes. */
  update(list: CityPlacement[], frame: PlacementFrame): void {
    this.list = list;
    this.frame = frame;
    this.rebuild();
  }

  setSelected(id: string | null): void {
    this.selected = id;
    this.rebuild();
  }

  /** Opens a placement's interior (null: closes); levels are drawn `explode` metres apart. */
  setInside(id: string | null, explode = 8): void {
    this.inside = id ? { id, explode } : null;
    this.rebuild();
  }

  /** Placement under a ray (nearest). */
  pick(ray: THREE.Raycaster): { id: string; d: number } | null {
    const hit = ray.intersectObject(this.group, true).find((h) => h.object.visible);
    if (!hit) return null;
    let o: THREE.Object3D | null = hit.object;
    while (o && !o.userData.placementId) o = o.parent;
    return o ? { id: o.userData.placementId as string, d: hit.distance } : null;
  }

  /** The scene object of a placement (the transform gizmo moves it), if drawn. */
  rootOf(id: string): THREE.Group | null {
    return this.roots.get(id) ?? null;
  }

  /** World box (three axes) of a placement, for framing the camera. */
  boxOf(id: string): THREE.Box3 | null {
    const root = this.roots.get(id);
    return root ? new THREE.Box3().setFromObject(root) : null;
  }

  /**
   * Turns rotors; uploaded models (up to the upload limit each) are drawn only
   * within GLB_DRAW_DISTANCE of the camera, so many of them stay affordable.
   */
  tick(dt: number, camera?: THREE.Vector3): void {
    for (const r of this.rotors) r.obj.rotateOnAxis(r.axis, (r.rpm / 60) * Math.PI * 2 * dt);
    if (!camera) return;
    for (const root of this.roots.values())
      if (root.userData.uploaded)
        root.visible = root.position.distanceTo(camera) < GLB_DRAW_DISTANCE;
  }

  dispose(): void {
    this.clear();
    for (const m of [this.body, this.glass, this.ghost, this.plate, this.outline, this.edges])
      m.dispose();
  }

  // ─── Building ─────────────────────────────────────────────────────────────

  private clear(): void {
    for (const root of this.roots.values()) {
      root.traverse((o) => {
        const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (g && !g.userData.shared) g.dispose();
      });
      root.removeFromParent();
    }
    this.roots.clear();
    this.rotors.length = 0;
  }

  private rebuild(): void {
    this.clear();
    const gen = ++this.generation;
    if (!this.frame) return;
    for (const p of this.list) {
      const at = this.frame.worldOf(p.lon, p.lat);
      if (!at) continue;
      const base = p.altitude ?? this.frame.heightAt(at[0], at[1]);
      const root = new THREE.Group();
      root.userData.placementId = p.id;
      root.position.set(at[0], base, -at[1]);
      root.rotation.y = yawOf(p.heading);
      root.scale.setScalar(p.scale);
      const open = this.inside?.id === p.id;
      const shell = new THREE.Group();
      root.add(shell);
      if (p.source.kind === 'prefab') {
        this.addPrefab(shell, p, open);
      } else {
        const assetId = p.source.assetId;
        root.userData.uploaded = true;
        void this.loadGlb(assetId)?.then((scene) => {
          if (gen !== this.generation) return;
          const copy = scene.clone(true);
          if (open)
            copy.traverse((o) => {
              if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = this.ghost;
            });
          shell.add(copy);
          if (this.selected === p.id) this.addOutline(root);
        });
      }
      if (open && p.interior) root.add(this.interiorGroup(p.interior, this.inside!.explode));
      this.group.add(root);
      this.roots.set(p.id, root);
      if (this.selected === p.id) this.addOutline(root);
    }
  }

  private addPrefab(shell: THREE.Group, p: CityPlacement, open: boolean): void {
    if (p.source.kind !== 'prefab') return;
    const mesh = prefabMesh(p.source.prefab, p.source.params);
    shell.add(new THREE.Mesh(mesh.body, open ? this.ghost : this.body));
    if (mesh.glass) shell.add(new THREE.Mesh(mesh.glass, open ? this.ghost : this.glass));
    for (const r of mesh.rotors) {
      const pivot = new THREE.Group();
      pivot.position.copy(r.at);
      pivot.add(new THREE.Mesh(r.geometry, open ? this.ghost : this.body));
      shell.add(pivot);
      this.rotors.push({ obj: pivot, axis: r.axis, rpm: r.rpm });
    }
  }

  private addOutline(root: THREE.Group): void {
    root.getObjectByName('placement-outline')?.removeFromParent();
    // Outline in the root's own frame: the model's extent, turned with it.
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const box = new THREE.Box3();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld).applyMatrix4(inv);
      box.union(b);
    });
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const g = new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z));
    const lines = new THREE.LineSegments(g, this.outline);
    lines.name = 'placement-outline';
    lines.position.copy(box.getCenter(new THREE.Vector3()));
    lines.renderOrder = 1000;
    root.add(lines);
  }

  /** Levels → floor plates (by space) and equipment blocks, pulled apart by `explode`. */
  private interiorGroup(interior: FacilityInterior, explode: number): THREE.Group {
    const out = new THREE.Group();
    out.name = 'interior';
    interior.levels.forEach((lv, i) => {
      const level = new THREE.Group();
      level.position.y = lv.elevation + i * explode;
      for (const sp of lv.spaces) {
        const shape = new THREE.Shape(sp.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
        const g = new THREE.ExtrudeGeometry(shape, { depth: 0.25, bevelEnabled: false });
        g.rotateX(-Math.PI / 2);
        g.deleteAttribute('uv');
        const c = new THREE.Color(
          SPACE_COLOUR[sp.classId ?? ''] ?? domainColour(sp.classId, '#d8d8d8'),
        );
        const n = g.getAttribute('position').count;
        g.setAttribute(
          'color',
          new THREE.BufferAttribute(
            new Float32Array(n * 3).map((_, k) => [c.r, c.g, c.b][k % 3]),
            3,
          ),
        );
        level.add(new THREE.Mesh(g, this.plate));
        level.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), this.edges));
        for (const e of sp.equipment ?? []) {
          const [sx, sy, sh] = e.size;
          const eg = new THREE.BoxGeometry(sx, sh, sy);
          eg.deleteAttribute('uv');
          const ec = new THREE.Color(
            EQUIPMENT_COLOUR[e.classId] ?? domainColour(e.classId, '#999999'),
          );
          const en = eg.getAttribute('position').count;
          eg.setAttribute(
            'color',
            new THREE.BufferAttribute(
              new Float32Array(en * 3).map((_, k) => [ec.r, ec.g, ec.b][k % 3]),
              3,
            ),
          );
          const m = new THREE.Mesh(eg, this.plate);
          m.position.set(e.position[0], 0.25 + e.position[2] + sh / 2, -e.position[1]);
          m.rotation.y = yawOf(e.heading ?? 0);
          m.userData.equipmentId = e.id;
          level.add(m);
        }
      }
      out.add(level);
    });
    return out;
  }

  /**
   * An uploaded GLB, stood on its lowest point and centred over the placement
   * point (authoring tools put origins anywhere). Loaded once per asset.
   */
  private loadGlb(assetId: string): Promise<THREE.Group> | null {
    let p = this.glbCache.get(assetId);
    if (!p) {
      const bytes = this.frame?.loadModel(assetId);
      if (!bytes) return null;
      p = bytes
        .then(
          (buf) =>
            new Promise<THREE.Group>((resolve, reject) =>
              new GLTFLoader().parse(
                buf,
                '',
                (gltf) => resolve(gltf.scene as unknown as THREE.Group),
                reject,
              ),
            ),
        )
        .then((scene) => {
          const box = new THREE.Box3().setFromObject(scene);
          const c = box.getCenter(new THREE.Vector3());
          const holder = new THREE.Group();
          scene.position.set(-c.x, -box.min.y, -c.z);
          holder.add(scene);
          return holder;
        });
      // A failed load may be retried on the next rebuild.
      p.catch(() => this.glbCache.delete(assetId));
      this.glbCache.set(assetId, p);
    }
    return p;
  }
}
