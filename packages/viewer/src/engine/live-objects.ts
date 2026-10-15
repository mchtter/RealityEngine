import type { LiveFeedChange, LiveObjectView } from '@opentwin/plugin-sdk';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three/webgpu';
import { paint } from './geom';
import { type LiveKind, liveKindOf, markerColorOf } from './live-kinds';
import {
  type ScreenPoint,
  easeAngle,
  easeFactor,
  liveHeight,
  minScreenScale,
  nearestOnScreen,
  predictXY,
  staleFade,
  yawOf,
} from './live-motion';
import {
  INSTANCE_COLOR_ATTRIBUTE,
  INSTANCE_MATRIX_ATTRIBUTES,
  instancedVariant,
} from './materials';
import { prefabMesh } from './prefabs';

/** Where live objects stand: the engine's world frame and ground. */
export interface LivePlacement {
  worldOf(lon: number, lat: number): [number, number] | null;
  /** Terrain height (cheap). */
  heightAt(x: number, y: number): number;
  /** Drawn ground — street, deck, terrain (a ray cast: budgeted per frame). */
  surfaceAt(x: number, y: number): number;
}

/** An object of a feed: plugin, feed and object id. */
export interface LiveRef {
  pluginId: string;
  feedId: string;
  objectId: string;
}

/** Screen position (px in the canvas) of the selected object's label anchor; null off screen. */
export type LiveScreen = { x: number; y: number } | null;

const refKey = (pluginId: string, feedId: string, id: string) => `${pluginId}/${feedId}/${id}`;

/**
 * Per kind: model length (m, for the minimum on-screen size), that size in
 * px, height of its middle (picking) and of its top (label), whether it casts
 * a shadow.
 */
const KIND_SPEC: Record<
  LiveKind,
  { size: number; minPx: number; middle: number; top: number; shadow: boolean }
> = {
  aircraft: { size: 36, minPx: 30, middle: 0, top: 3, shadow: false },
  bus: { size: 12, minPx: 10, middle: 1.6, top: 3.6, shadow: true },
  vessel: { size: 80, minPx: 14, middle: 4, top: 12, shadow: true },
  rail: { size: 82, minPx: 14, middle: 2, top: 4.4, shadow: true },
  cctv: { size: 6, minPx: 12, middle: 4.8, top: 5.6, shadow: true },
  parking: { size: 5, minPx: 14, middle: 3.6, top: 4.4, shadow: true },
  marker: { size: 13, minPx: 22, middle: 10, top: 13.2, shadow: false },
};

const KINDS = Object.keys(KIND_SPEC) as LiveKind[];
/** Kinds turned to face the camera (signs, pins) instead of along a course. */
const BILLBOARD: ReadonlySet<LiveKind> = new Set(['parking', 'marker']);
/** Ground ray casts per frame (surfaceAt); the rest wait a frame on the terrain height. */
const SURFACE_BUDGET = 16;
/** Aircraft trail: a point every TRAIL_S seconds, TRAIL_POINTS kept. */
const TRAIL_S = 2;
const TRAIL_POINTS = 10;
/** A jump longer than this (m) is drawn at once, not eased across the city. */
const SNAP_M = 3000;
/** Default vessel model length (m): `attrs.length` scales it. */
const VESSEL_LENGTH = 80;

// ─── Models (x east, y north = forward, z up; returned in three.js axes) ─────

const C = (hex: string) => new THREE.Color(hex);
type G = THREE.BufferGeometry;

const prep = (g: G, c: THREE.Color): G => {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute('uv');
  return paint(out, c);
};

/** Box w (east) × d (north) × h (up), base centre at (x, y, z). */
const B = (w: number, d: number, h: number, c: THREE.Color, x = 0, y = 0, z = 0): G =>
  prep(new THREE.BoxGeometry(w, h, d).translate(x, z + h / 2, -y), c);

/** Airliner seen at a glance: fuselage, swept wings, tailplane, fin, two engines; origin mid-fuselage. */
function aircraftGeometry(): G {
  const white = C('#f4f5f6');
  const wing = C('#c9ced3');
  const dark = C('#26303a');
  const fin = C('#1f6fb2');
  const engine = C('#8f979e');
  const r = 1.9;
  const parts: G[] = [
    prep(new THREE.CylinderGeometry(r, r, 24, 14).rotateX(-Math.PI / 2), white),
    // Nose forward (north = -z), tail cone back.
    prep(new THREE.ConeGeometry(r, 5, 14).rotateX(-Math.PI / 2).translate(0, 0, -14.5), white),
    prep(new THREE.ConeGeometry(r, 6, 14).rotateX(Math.PI / 2).translate(0, 0.3, 15), white),
    // Window band and cockpit.
    prep(new THREE.BoxGeometry(2 * r + 0.04, 0.32, 18).translate(0, 0.55, -1.5), dark),
    prep(new THREE.BoxGeometry(1.7, 0.45, 0.7).translate(0, 0.95, -12.5), dark),
    ...[-1, 1].flatMap((s) => [
      // Wing swept back (tip towards +z), a little below the axis.
      prep(
        new THREE.BoxGeometry(15, 0.45, 4.6).rotateY(-s * 0.45).translate(s * (r + 6.6), -0.8, 1.6),
        wing,
      ),
      prep(
        new THREE.BoxGeometry(5.6, 0.3, 2.4).rotateY(-s * 0.5).translate(s * (r + 2.4), 0.5, 13.8),
        wing,
      ),
      prep(
        new THREE.CylinderGeometry(0.95, 0.95, 3.8, 12)
          .rotateX(-Math.PI / 2)
          .translate(s * 6.2, -1.6, -0.6),
        engine,
      ),
    ]),
    prep(new THREE.BoxGeometry(0.35, 5.6, 4.2).rotateX(0.45).translate(0, r + 2.4, 14), fin),
  ];
  return mergeGeometries(parts);
}

/** A prefab vehicle as one geometry (body + glass), turned so its front faces north. */
function prefabGeometry(
  id: 'city_bus' | 'ship' | 'metro_train',
  turn: number,
  params?: Record<string, number>,
): G {
  const p = prefabMesh(id, params);
  const parts = [p.body.clone(), ...(p.glass ? [p.glass.clone()] : [])];
  const g = mergeGeometries(parts);
  parts.forEach((x) => x.dispose());
  if (turn) g.rotateY(turn);
  return g;
}

/** Street camera: pole, arm, camera head looking north. */
function cctvGeometry(): G {
  const grey = C('#6b7280');
  const white = C('#e5e7eb');
  const dark = C('#111827');
  return mergeGeometries([
    prep(new THREE.CylinderGeometry(0.09, 0.13, 5, 8).translate(0, 2.5, 0), grey),
    B(0.12, 0.8, 0.12, grey, 0, 0.4, 4.9),
    B(0.38, 0.95, 0.38, white, 0, 0.95, 4.62),
    B(0.26, 0.06, 0.26, dark, 0, 1.44, 4.68),
  ]);
}

/** View cone of a camera: apex at the lens, opening north and a little down. */
function viewConeGeometry(): G {
  const g = new THREE.ConeGeometry(5.5, 14, 20, 1, true);
  g.rotateX(Math.PI / 2); // tip to +z (back), base 14 m forward
  g.translate(0, 0, -7);
  g.rotateX(-0.3); // dip the far end
  g.translate(0, 4.8, -1.48);
  g.deleteAttribute('uv');
  return g;
}

/** Car park sign: a blue square with a white P on both faces, on a pole. */
function parkingGeometry(): G {
  const grey = C('#9ca3af');
  const blue = C('#1d4ed8');
  const white = C('#ffffff');
  // The sign faces the camera (north side, read from the north: the P's stem is east).
  const P = (x0: number, x1: number, z0: number, z1: number) =>
    B(x1 - x0, 0.16, z1 - z0, white, -(x0 + x1) / 2, 0, z0);
  return mergeGeometries([
    prep(new THREE.CylinderGeometry(0.07, 0.07, 2.9, 8).translate(0, 1.45, 0), grey),
    B(1.5, 0.12, 1.5, blue, 0, 0, 2.85),
    P(-0.42, -0.18, 3.05, 4.15),
    P(-0.42, 0.3, 3.95, 4.15),
    P(-0.42, 0.3, 3.5, 3.7),
    P(0.1, 0.3, 3.5, 4.15),
  ]);
}

/** Map pin on a thin stem (white: tinted per class). */
function markerGeometry(): G {
  const white = C('#ffffff');
  return mergeGeometries([
    prep(new THREE.CylinderGeometry(0.08, 0.08, 9, 6).translate(0, 4.5, 0), white),
    prep(new THREE.ConeGeometry(1.1, 2.6, 16).rotateX(Math.PI).translate(0, 10.3, 0), white),
    prep(new THREE.SphereGeometry(1.5, 16, 10).translate(0, 12.3, 0), white),
  ]);
}

function baseGeometry(kind: LiveKind): G {
  switch (kind) {
    case 'aircraft':
      return aircraftGeometry();
    case 'bus':
      // The prefab bus has its windscreen at the south end.
      return prefabGeometry('city_bus', Math.PI);
    case 'vessel':
      return prefabGeometry('ship', 0, { length: VESSEL_LENGTH });
    case 'rail':
      return prefabGeometry('metro_train', 0);
    case 'cctv':
      return cctvGeometry();
    case 'parking':
      return parkingGeometry();
    case 'marker':
      return markerGeometry();
  }
}

// ─── Instanced batch (one draw call per kind) ───────────────────────────────

/**
 * Instances of one model: an InstancedBufferGeometry with the instance
 * matrix (four column attributes) and tint, drawn with the material's shared
 * instanced variant (see materials.ts instancedVariant) — no InstancedMesh,
 * whose per-object shader builds stalled the frame. Grows by doubling.
 */
class Batch {
  readonly mesh: THREE.Mesh;
  private geometry: THREE.InstancedBufferGeometry;
  private cols: THREE.InstancedBufferAttribute[] = [];
  private tint!: THREE.InstancedBufferAttribute;
  private capacity = 0;
  private count = 0;

  constructor(
    private readonly base: G,
    material: THREE.Material,
    name: string,
    shadow: boolean,
  ) {
    this.geometry = this.make(16);
    this.mesh = new THREE.Mesh(this.geometry, instancedVariant(material, true));
    this.mesh.name = name;
    // Instances spread over the whole city: culled per instance by nothing, per batch by nothing.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadow;
    this.mesh.visible = false;
  }

  /** A geometry for `capacity` instances; it owns copies of the model's buffers. */
  private make(capacity: number): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry();
    for (const [name, a] of Object.entries(this.base.attributes))
      g.setAttribute(name, (a as THREE.BufferAttribute).clone());
    if (this.base.index) g.setIndex(this.base.index.clone());
    this.cols = INSTANCE_MATRIX_ATTRIBUTES.map((name) => {
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      attr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, attr);
      return attr;
    });
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.tint.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(INSTANCE_COLOR_ATTRIBUTE, this.tint);
    g.instanceCount = 0;
    this.capacity = capacity;
    return g;
  }

  begin(n: number): void {
    if (n > this.capacity) {
      const old = this.geometry;
      let cap = this.capacity;
      while (cap < n) cap *= 2;
      this.geometry = this.make(cap);
      this.mesh.geometry = this.geometry;
      old.dispose();
    }
    this.count = 0;
  }

  push(m: THREE.Matrix4, tint: THREE.Color): void {
    const i = this.count++;
    const e = m.elements;
    for (let c = 0; c < 4; c++) {
      const a = this.cols[c].array as Float32Array;
      a[i * 4] = e[c * 4];
      a[i * 4 + 1] = e[c * 4 + 1];
      a[i * 4 + 2] = e[c * 4 + 2];
      a[i * 4 + 3] = e[c * 4 + 3];
    }
    const t = this.tint.array as Float32Array;
    t[i * 3] = tint.r;
    t[i * 3 + 1] = tint.g;
    t[i * 3 + 2] = tint.b;
  }

  end(): void {
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (!this.count) return;
    for (const c of this.cols) c.needsUpdate = true;
    this.tint.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.base.dispose();
    this.mesh.removeFromParent();
  }
}

/** Growing set of line segments (stems, trails): one draw call. */
class Lines {
  readonly line: THREE.LineSegments;
  private positions = new Float32Array(0);
  private n = 0;

  constructor(material: THREE.Material, name: string) {
    this.line = new THREE.LineSegments(new THREE.BufferGeometry(), material);
    this.line.name = name;
    this.line.frustumCulled = false;
    this.line.visible = false;
  }

  begin(segments: number): void {
    const need = segments * 6;
    if (need > this.positions.length) {
      let cap = Math.max(96, this.positions.length);
      while (cap < need) cap *= 2;
      this.positions = new Float32Array(cap);
      const old = this.line.geometry;
      const g = new THREE.BufferGeometry();
      const attr = new THREE.BufferAttribute(this.positions, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('position', attr);
      this.line.geometry = g;
      old.dispose();
    }
    this.n = 0;
  }

  push(a: THREE.Vector3, b: THREE.Vector3): void {
    const p = this.positions;
    const i = this.n * 6;
    p[i] = a.x;
    p[i + 1] = a.y;
    p[i + 2] = a.z;
    p[i + 3] = b.x;
    p[i + 4] = b.y;
    p[i + 5] = b.z;
    this.n++;
  }

  end(): void {
    const g = this.line.geometry;
    this.line.visible = this.n > 0;
    if (!this.n) return;
    g.setDrawRange(0, this.n * 2);
    const attr = g.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (attr) attr.needsUpdate = true;
  }

  dispose(): void {
    this.line.geometry.dispose();
    this.line.removeFromParent();
  }
}

// ─── Layer ───────────────────────────────────────────────────────────────────

interface Entry {
  key: string;
  ref: LiveRef;
  kind: LiveKind;
  view: LiveObjectView;
  staleMs: number;
  /** When the newest fix arrived (ms, Date.now). */
  heard: number;
  /** World position of the fix (null: outside the world frame / not placed yet). */
  fix: [number, number] | null;
  fixDirty: boolean;
  /** Previous fix (course from the move when none is reported). */
  last: [number, number] | null;
  pos: THREE.Vector3;
  placed: boolean;
  yaw: number;
  targetYaw: number;
  ground: number;
  groundAt: [number, number] | null;
  groundExact: boolean;
  /** Model scale from the object's attributes (vessel length, quake magnitude). */
  size: number;
  colour: THREE.Color;
  trail: THREE.Vector3[];
  trailAt: number;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Model scale an object's attributes ask for. */
function sizeOf(kind: LiveKind, view: LiveObjectView): number {
  const a = view.attrs ?? {};
  if (kind === 'vessel') {
    const l = num(a.length) ?? num(a.lengthM);
    return l ? Math.min(5, Math.max(0.2, l / VESSEL_LENGTH)) : 1;
  }
  if (kind === 'marker') {
    const mag = num(a.magnitude) ?? num(a.mag);
    return mag !== null ? Math.min(2.5, Math.max(0.6, 0.4 + mag * 0.25)) : 1;
  }
  return 1;
}

const WHITE = new THREE.Color(1, 1, 1);
const GREY = new THREE.Color(0.42, 0.44, 0.46);
const GOLD = new THREE.Color(1.6, 1.25, 0.35);

/**
 * Live objects of plugins' feeds in the scene: one instanced mesh per model
 * kind (aircraft, bus, vessel, train, camera + view cones, car park sign,
 * marker pin), eased each frame towards the newest fix carried forward along
 * its course (dead reckoning), turned to its heading; aircraft at their
 * altitude with a stem to the ground and a short trail, kept at least a few
 * pixels big from afar. Stale objects grey out; the selected one is lit.
 */
export class LiveObjectLayer {
  readonly group = new THREE.Group();
  private readonly body = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.15 });
  private readonly cone = new THREE.MeshBasicNodeMaterial({
    color: 0x7dd3fc,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly stemMat = new THREE.LineBasicNodeMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  });
  private readonly trailMat = new THREE.LineBasicNodeMaterial({
    color: 0x93c5fd,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });
  private readonly batches = new Map<LiveKind, Batch>();
  private readonly cones: Batch;
  private readonly stems = new Lines(this.stemMat, 'live-stems');
  private readonly trails = new Lines(this.trailMat, 'live-trails');
  private readonly entries = new Map<string, Entry>();
  private selected: string | null = null;
  private readonly screenListeners = new Set<(p: LiveScreen) => void>();
  private lastScreen: LiveScreen = null;
  // Scratch.
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly v = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly tint = new THREE.Color();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor() {
    this.group.name = 'live-objects';
    this.body.vertexColors = true;
    for (const kind of KINDS) {
      const batch = new Batch(
        baseGeometry(kind),
        this.body,
        `live-${kind}`,
        KIND_SPEC[kind].shadow,
      );
      this.batches.set(kind, batch);
      this.group.add(batch.mesh);
    }
    this.cones = new Batch(viewConeGeometry(), this.cone, 'live-cctv-cones', false);
    this.cones.mesh.renderOrder = 2;
    this.group.add(this.cones.mesh, this.stems.line, this.trails.line);
  }

  // ─── Data ────────────────────────────────────────────────────────────────

  /** Replaces every object (a fresh snapshot); `heard` tells when each was last heard of. */
  setAll(
    feeds: {
      pluginId: string;
      feedId: string;
      staleMs: number;
      objects: LiveObjectView[];
      heard?: (id: string) => number | undefined;
    }[],
  ): void {
    const keep = new Set<string>();
    for (const f of feeds) {
      for (const o of f.objects) {
        keep.add(refKey(f.pluginId, f.feedId, o.id));
        this.upsert(f.pluginId, f.feedId, o, f.staleMs, f.heard?.(o.id));
      }
    }
    for (const key of [...this.entries.keys()]) if (!keep.has(key)) this.entries.delete(key);
  }

  /** Applies a feed change (`replace` drops the feed's objects not in it). */
  apply(change: LiveFeedChange, staleMs: number): void {
    const { pluginId, feedId } = change;
    if (change.replace) {
      const keep = new Set(change.upsert.map((o) => refKey(pluginId, feedId, o.id)));
      const prefix = `${pluginId}/${feedId}/`;
      for (const key of [...this.entries.keys()])
        if (key.startsWith(prefix) && !keep.has(key)) this.entries.delete(key);
    }
    for (const id of change.remove ?? []) this.entries.delete(refKey(pluginId, feedId, id));
    for (const o of change.upsert ?? []) this.upsert(pluginId, feedId, o, staleMs);
  }

  private upsert(
    pluginId: string,
    feedId: string,
    view: LiveObjectView,
    staleMs: number,
    heard = Date.now(),
  ): void {
    const key = refKey(pluginId, feedId, view.id);
    const kind = liveKindOf(view.classId);
    let e = this.entries.get(key);
    if (!e || e.kind !== kind) {
      e = {
        key,
        ref: { pluginId, feedId, objectId: view.id },
        kind,
        view,
        staleMs,
        heard,
        fix: null,
        fixDirty: true,
        last: null,
        pos: new THREE.Vector3(),
        placed: false,
        yaw: 0,
        targetYaw: 0,
        ground: 0,
        groundAt: null,
        groundExact: false,
        size: 1,
        colour: kind === 'marker' ? new THREE.Color(markerColorOf(view.classId)) : WHITE.clone(),
        trail: [],
        trailAt: 0,
      };
      this.entries.set(key, e);
    }
    e.view = view;
    e.staleMs = staleMs;
    e.heard = heard;
    e.fixDirty = true;
    e.size = sizeOf(kind, view);
  }

  /** The world frame changed (first tile, floating origin): every object is placed anew. */
  relocate(): void {
    for (const e of this.entries.values()) {
      e.fixDirty = true;
      e.fix = null;
      e.last = null;
      e.placed = false;
      e.groundAt = null;
      e.trail = [];
    }
  }

  /** Tiles came or went: the ground under objects is looked up again. */
  groundChanged(): void {
    for (const e of this.entries.values()) e.groundExact = false;
  }

  /** The highlighted object (null: none). */
  select(ref: LiveRef | null): void {
    this.selected = ref ? refKey(ref.pluginId, ref.feedId, ref.objectId) : null;
  }

  has(ref: LiveRef): boolean {
    return this.entries.has(refKey(ref.pluginId, ref.feedId, ref.objectId));
  }

  /** Key of the highlighted object (`plugin/feed/object`), null: none. */
  get selectedKey(): string | null {
    return this.selected;
  }

  /** Key (`plugin/feed/object`) of a reference. */
  keyOf(ref: LiveRef): string {
    return refKey(ref.pluginId, ref.feedId, ref.objectId);
  }

  /** Latest view of an object (null: not in any feed). */
  viewOf(ref: LiveRef): LiveObjectView | null {
    return this.entries.get(refKey(ref.pluginId, ref.feedId, ref.objectId))?.view ?? null;
  }

  /** The objects of a class with their keys (e.g. earthquakes for the overview map). */
  ofClass(classId: string): { key: string; view: LiveObjectView }[] {
    const out: { key: string; view: LiveObjectView }[] = [];
    for (const [key, e] of this.entries)
      if (e.view.classId === classId) out.push({ key, view: e.view });
    return out;
  }

  /** Scene position, kind and heading of an object (camera focus / follow). */
  stateOf(
    ref: LiveRef,
  ): { pos: THREE.Vector3; kind: LiveKind; heading: number; airborne: boolean } | null {
    const e = this.entries.get(refKey(ref.pluginId, ref.feedId, ref.objectId));
    if (!e?.placed) return null;
    return {
      pos: e.pos,
      kind: e.kind,
      heading: (-e.yaw * 180) / Math.PI,
      airborne: e.view.alt !== undefined && e.pos.y - e.ground > 20,
    };
  }

  /** Screen position of the selected object's label anchor, on change. */
  onScreen(cb: (p: LiveScreen) => void): () => void {
    this.screenListeners.add(cb);
    cb(this.lastScreen);
    return () => this.screenListeners.delete(cb);
  }

  // ─── Frame ───────────────────────────────────────────────────────────────

  tick(
    dt: number,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
    at: LivePlacement,
  ): void {
    const now = Date.now();
    const k = easeFactor(dt, 3);
    let budget = SURFACE_BUDGET;
    const counts = new Map<LiveKind, number>();
    for (const e of this.entries.values()) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    for (const kind of KINDS) this.batches.get(kind)!.begin(counts.get(kind) ?? 0);
    this.cones.begin(counts.get('cctv') ?? 0);
    const aircraft = counts.get('aircraft') ?? 0;
    this.stems.begin(aircraft);
    this.trails.begin(aircraft * TRAIL_POINTS);

    for (const e of this.entries.values()) {
      if (e.fixDirty) {
        const xy = at.worldOf(e.view.lon, e.view.lat);
        if (xy) {
          e.fixDirty = false;
          // Course: reported, else from the move since the last fix.
          if (e.view.heading !== undefined && Number.isFinite(e.view.heading)) {
            e.targetYaw = yawOf(e.view.heading);
          } else if (e.last && Math.hypot(xy[0] - e.last[0], xy[1] - e.last[1]) > 1) {
            e.targetYaw = Math.atan2(-(xy[0] - e.last[0]), xy[1] - e.last[1]);
          }
          e.last = xy;
        }
        e.fix = xy;
      }
      if (!e.fix) continue;
      const [x, y] = predictXY(
        e.fix[0],
        e.fix[1],
        e.view.heading,
        e.view.speed,
        (now - e.heard) / 1000,
      );
      // Ground under the object: terrain at once, the drawn street surface when the budget allows.
      const moved = !e.groundAt || Math.hypot(x - e.groundAt[0], y - e.groundAt[1]) > 6;
      if (moved || !e.groundExact) {
        if (e.kind !== 'aircraft' && budget > 0) {
          e.ground = at.surfaceAt(x, y);
          e.groundExact = true;
          budget--;
        } else if (moved) {
          e.ground = at.heightAt(x, y);
          e.groundExact = e.kind === 'aircraft';
        }
        e.groundAt = [x, y];
      }
      // Vessels float at sea level (the ground under the sea lies below it).
      const z =
        e.kind === 'vessel' && e.view.alt === undefined
          ? Math.max(e.ground, 0)
          : liveHeight(e.view.alt, e.ground);
      this.v.set(x, z, -y); // toThree
      if (!e.placed || this.v.distanceTo(e.pos) > SNAP_M) {
        e.pos.copy(this.v);
        e.yaw = e.targetYaw;
        e.placed = true;
      } else {
        e.pos.lerp(this.v, k);
        e.yaw = easeAngle(e.yaw, e.targetYaw, k);
      }
      const spec = KIND_SPEC[e.kind];
      let yaw = e.yaw;
      if (BILLBOARD.has(e.kind)) {
        yaw = Math.atan2(-(camera.position.x - e.pos.x), -(camera.position.z - e.pos.z));
      }
      const fade = staleFade(now - e.heard, e.staleMs);
      const dist = camera.position.distanceTo(e.pos);
      const scale =
        e.size *
        minScreenScale(dist, camera.fov, height, spec.size * e.size, spec.minPx) *
        (1 - 0.3 * fade);
      this.q.setFromAxisAngle(this.up, yaw);
      this.m.compose(e.pos, this.q, this.s.setScalar(scale));
      this.tint.copy(e.colour).lerp(GREY, fade * 0.8);
      if (e.key === this.selected) this.tint.lerp(GOLD, 0.6);
      this.batches.get(e.kind)!.push(this.m, this.tint);
      if (e.kind === 'cctv') this.cones.push(this.m, e.key === this.selected ? GOLD : WHITE);
      if (e.kind === 'aircraft') {
        this.v2.copy(e.pos);
        this.v2.y = e.ground;
        this.stems.push(e.pos, this.v2);
        if (now - e.trailAt > TRAIL_S * 1000) {
          e.trailAt = now;
          e.trail.push(e.pos.clone());
          if (e.trail.length > TRAIL_POINTS) e.trail.shift();
        }
        for (let i = 1; i < e.trail.length; i++) this.trails.push(e.trail[i - 1], e.trail[i]);
        if (e.trail.length) this.trails.push(e.trail[e.trail.length - 1], e.pos);
      }
    }
    for (const b of this.batches.values()) b.end();
    this.cones.end();
    this.stems.end();
    this.trails.end();
    this.reportScreen(camera, width, height);
  }

  /** Label anchor of the selected object: above its top, scaled as drawn. */
  private reportScreen(camera: THREE.PerspectiveCamera, width: number, height: number): void {
    let next: LiveScreen = null;
    const e = this.selected ? this.entries.get(this.selected) : undefined;
    if (e?.placed) {
      const spec = KIND_SPEC[e.kind];
      const dist = camera.position.distanceTo(e.pos);
      const scale =
        e.size * minScreenScale(dist, camera.fov, height, spec.size * e.size, spec.minPx);
      this.v.copy(e.pos);
      this.v.y += spec.top * scale;
      this.v.project(camera);
      if (this.v.z < 1 && Math.abs(this.v.x) < 1.2 && Math.abs(this.v.y) < 1.2)
        next = { x: ((this.v.x + 1) / 2) * width, y: ((1 - this.v.y) / 2) * height };
    }
    const last = this.lastScreen;
    const moved = !next || !last || Math.abs(next.x - last.x) + Math.abs(next.y - last.y) > 0.5;
    if ((next === null) !== (last === null) || (next && moved)) {
      this.lastScreen = next;
      this.screenListeners.forEach((cb) => cb(next));
    }
  }

  /**
   * The object drawn nearest to a click (px in the canvas) within ~12 px or
   * its own drawn size; null when none.
   */
  pick(
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
    sx: number,
    sy: number,
  ): LiveRef | null {
    const list = [...this.entries.values()];
    const vFov = Math.tan((camera.fov * Math.PI) / 360);
    const points = list.map((e): ScreenPoint | null => {
      if (!e.placed) return null;
      const spec = KIND_SPEC[e.kind];
      const dist = camera.position.distanceTo(e.pos);
      const scale =
        e.size * minScreenScale(dist, camera.fov, height, spec.size * e.size, spec.minPx);
      this.v.copy(e.pos);
      this.v.y += spec.middle * scale;
      this.v.project(camera);
      if (this.v.z > 1 || this.v.z < -1) return null;
      const pxPerM = height / (2 * Math.max(dist, 1) * vFov);
      return {
        x: ((this.v.x + 1) / 2) * width,
        y: ((1 - this.v.y) / 2) * height,
        radius: (spec.size * e.size * scale * pxPerM) / 2,
      };
    });
    const i = nearestOnScreen(points, sx, sy, 12);
    return i < 0 ? null : list[i].ref;
  }

  dispose(): void {
    for (const b of this.batches.values()) b.dispose();
    this.cones.dispose();
    this.stems.dispose();
    this.trails.dispose();
    instancedVariant(this.body, true).dispose();
    instancedVariant(this.cone, true).dispose();
    this.body.dispose();
    this.cone.dispose();
    this.stemMat.dispose();
    this.trailMat.dispose();
    this.entries.clear();
    this.screenListeners.clear();
    this.group.removeFromParent();
  }
}
