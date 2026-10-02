import {
  type CityModel,
  type LonLat,
  utmForward,
  utmInverse,
  utmZoneOf,
} from '@opentwin/city-core';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { float, mix, mrt, normalView, output, pass, renderOutput, uniform } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { CityTile } from './city-tile';
import { toThree } from './geom';
import { seaPlane } from './ground';
import {
  type DtMaterials,
  SCENARIO_TEXTURE_HEIGHT,
  SCENARIO_TEXTURE_WIDTH,
  createMaterials,
} from './materials';
import { SlotAllocator } from './slot-allocator';
import { type BuildingInfo, type TilePayload, type TileSummary, instancesOf } from './tile-payload';

export type DtViewMode = 'showcase' | 'data';
export type DtQuality = 'high' | 'medium' | 'low';

export interface DtEngineStats {
  backend: 'webgpu' | 'webgl';
  fps: number;
  drawCalls: number;
  triangles: number;
  /** Average CPU time of render() per frame (ms). */
  cpuMsPerFrame: number;
}

export interface DtEngineEvents {
  onSelect?: (building: BuildingInfo | null) => void;
  onStats?: (stats: DtEngineStats) => void;
}

const DEG = Math.PI / 180;

/** Common frame of all loaded tiles: UTM zone + origin (metres). */
export interface WorldFrame {
  zone: number;
  originE: number;
  originN: number;
}

/** Camera in MapLibre terms (see DtEngine.getGeoView). */
export interface GeoView {
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

/** Ground metres per pixel at MapLibre zoom 0 (512 px world) at a latitude. */
const metresPerPixelAtZoom0 = (lat: number) =>
  (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / 512;

/** Zonguldak latitude drives the sun's noon elevation (September). */
const NOON_ELEVATION = 48;

/**
 * Digital-twin city renderer. Owns the three.js scene built from a compiled
 * CityModel; React only passes the container and receives events.
 */
export class DtEngine {
  readonly backend: 'webgpu' | 'webgl';
  private readonly renderer: THREE.WebGPURenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: MapControls;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  private readonly hemi = new THREE.HemisphereLight(0xbfd6ff, 0x5b5a48, 1.1);
  private readonly sky = new SkyMesh();
  /** Sky copy rendered into a PMREM environment map for image-based lighting. */
  private readonly envSky = new SkyMesh();
  private readonly envScene = new THREE.Scene();
  private readonly pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.RenderTarget | null = null;
  private envTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly mats: DtMaterials;
  private readonly pipeline: THREE.RenderPipeline;
  private glow: ReturnType<typeof bloom> | null = null;
  private readonly tiles = new Map<string, CityTile>();
  /** Shared prop module geometry, reused by every tile. */
  private readonly geometryCache = new Map<string, THREE.BufferGeometry>();
  private sea: THREE.Mesh | null = null;
  private world: WorldFrame | null = null;
  private placed = false;
  /** Building slot ranges in the scenario colour texture. */
  private readonly slotAllocator = new SlotAllocator(
    SCENARIO_TEXTURE_WIDTH * SCENARIO_TEXTURE_HEIGHT,
  );
  /** Colour of a building under the active scenario (null: no data); null = no scenario. */
  private scenarioColor: ((b: BuildingInfo) => THREE.Color | null) | null = null;
  /** Matched / total buildings per tile under the active scenario. */
  private readonly scenarioCounts = new Map<string, { matched: number; total: number }>();
  /** Geo camera requested before the first tile fixed the world frame. */
  private pendingView: GeoView | null = null;
  private readonly resize: ResizeObserver;
  private readonly sunDir = new THREE.Vector3();
  private mode: DtViewMode = 'showcase';
  private fly: {
    from: [THREE.Vector3, THREE.Vector3];
    to: [THREE.Vector3, THREE.Vector3];
    t: number;
  } | null = null;
  private frames = 0;
  /** CPU time spent submitting frames since the last stats tick (draw-call overhead). */
  private cpuMs = 0;
  /** Development A/B switches for performance analysis. */
  private debugFlags = { post: true, shadows: true, ao: true };
  /** Share of ambient occlusion applied (0 = off). */
  private readonly aoStrength = uniform(1);
  private lastStats = performance.now();
  private pointerDown: { x: number; y: number } | null = null;
  private disposed = false;

  static async create(container: HTMLElement, events: DtEngineEvents = {}): Promise<DtEngine> {
    const renderer = new THREE.WebGPURenderer({ antialias: false, alpha: false });
    await renderer.init();
    return new DtEngine(container, renderer, events);
  }

  private constructor(
    private readonly container: HTMLElement,
    renderer: THREE.WebGPURenderer,
    private readonly events: DtEngineEvents,
  ) {
    this.renderer = renderer;
    const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
      ? 'webgpu'
      : 'webgl';
    this.backend = backend;
    const quality: DtQuality = backend === 'webgpu' ? 'high' : 'medium';

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === 'high' ? 1.5 : 1));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.78;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';

    this.camera = new THREE.PerspectiveCamera(
      42,
      container.clientWidth / container.clientHeight,
      1,
      14000,
    );
    this.mats = createMaterials();

    // Sky, light, fog.
    this.sky.scale.setScalar(12000);
    this.sky.turbidity.value = 2.6;
    this.sky.rayleigh.value = 1.1;
    this.sky.mieCoefficient.value = 0.004;
    this.sky.mieDirectionalG.value = 0.8;
    this.sky.cloudCoverage.value = 0.42;
    this.sky.cloudDensity.value = 0.5;
    this.scene.add(this.sky);
    this.envSky.scale.setScalar(50);
    this.envSky.turbidity.value = 2.6;
    this.envSky.rayleigh.value = 1.1;
    this.envSky.mieCoefficient.value = 0.004;
    this.envSky.mieDirectionalG.value = 0.8;
    this.envSky.cloudCoverage.value = 0.42;
    this.envScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environmentIntensity = 0.3;
    this.scene.fog = new THREE.Fog(0xb9c9d8, 1300, 5200);

    this.sun.castShadow = true;
    const size = quality === 'high' ? 4096 : 2048;
    this.sun.shadow.mapSize.set(size, size);
    const cam = this.sun.shadow.camera;
    cam.left = -320;
    cam.right = 320;
    cam.top = 320;
    cam.bottom = -320;
    cam.near = 10;
    cam.far = 2400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.8;
    this.scene.add(this.sun, this.sun.target, this.hemi);

    // One sea plane at sea level for all tiles.
    const sea = seaPlane(
      {
        bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
        terrain: { seaLevel: 0 } as CityModel['terrain'],
      },
      this.mats,
    );
    sea.geometry.dispose();
    sea.geometry = new THREE.PlaneGeometry(60000, 60000);
    this.scene.add(sea);
    this.sea = sea;

    this.controls = new MapControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = 1.43;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 1800;
    this.controls.zoomToCursor = true;
    this.camera.position.set(260, 230, 330);
    this.controls.update();

    // Post-processing: AO + bloom (night lights) + FXAA.
    this.pipeline = new THREE.RenderPipeline(renderer);
    const scenePass = pass(this.scene, this.camera);
    let lit;
    if (quality === 'high') {
      scenePass.setMRT(mrt({ output, normal: normalView }));
      const color = scenePass.getTextureNode('output');
      const aoPass = ao(
        scenePass.getTextureNode('depth'),
        scenePass.getTextureNode('normal'),
        this.camera,
      );
      // Full resolution: upsampled half-resolution GTAO left a screen-aligned
      // grid of dark bars on smooth ground (A/B tested 2026-10-01; fps difference
      // within measurement noise over 8 views, headless WebGPU 1920×1080).
      aoPass.resolutionScale = 1;
      aoPass.radius.value = 1.6;
      aoPass.thickness.value = 1.2;
      // GTAO renders a single-channel (red) texture.
      lit = color.mul(mix(float(1), aoPass.getTextureNode().r, this.aoStrength));
    } else {
      lit = scenePass.getTextureNode('output');
    }
    // Bloom only picks up emissive lights (windows, lamps, signs); tuned per time of day.
    const glow = bloom(lit, 0.1, 0.35, 3);
    this.glow = glow;
    this.pipeline.outputColorTransform = false;
    this.pipeline.outputNode = fxaa(renderOutput(lit.add(glow)));

    this.setTimeOfDay(15.5);

    this.resize = new ResizeObserver(() => this.onResize());
    this.resize.observe(container);
    renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    renderer.domElement.addEventListener('pointerup', this.onPointerUp);
    renderer.setAnimationLoop(this.frame);
  }

  // ─── Tiles ─────────────────────────────────────────────────────────────────

  get worldFrame(): WorldFrame | null {
    return this.world;
  }

  hasTile(key: string): boolean {
    return this.tiles.has(key);
  }

  tileKeys(): string[] {
    return [...this.tiles.keys()];
  }

  /** World model coordinates of a tile's (0, 0) — [0, 0] before the first tile. */
  offsetOf(summary: Pick<TileSummary, 'frame'>): [number, number] {
    if (!summary.frame || !this.world) return [0, 0];
    return [summary.frame.originE - this.world.originE, summary.frame.originN - this.world.originN];
  }

  /**
   * Adds (or replaces) a tile built by the tile worker. The first tile fixes
   * the world frame; later tiles are placed relative to it. Tiles of another
   * UTM zone are skipped (not needed for a single city).
   */
  addTile(key: string, payload: TilePayload): boolean {
    const { frame, bounds } = payload.summary;
    if (frame) {
      if (!this.world) {
        this.world = { zone: frame.zone, originE: frame.originE, originN: frame.originN };
      } else if (this.tiles.size === 0) {
        // Floating origin: after a long jump every old tile is gone; re-anchor the
        // world at this tile so coordinates stay small (float32 on the GPU).
        this.rebase(frame);
      } else if (frame.zone !== this.world.zone) {
        return false;
      }
    }
    this.removeTile(key);
    const tile = new CityTile(
      key,
      payload,
      this.offsetOf(payload.summary),
      this.mats,
      this.geometryCache,
      {
        obs: this.slotAllocator.alloc(payload.slots.obs.length),
        syn: this.slotAllocator.alloc(payload.slots.syn.length),
      },
    );
    if (this.scenarioColor) this.scenarioCounts.set(key, this.paintScenario(tile));
    if (this.mode !== 'showcase') tile.setMode(this.mode);
    tile.updateDetail(this.camera.position);
    this.tiles.set(key, tile);
    this.scene.add(tile.group);
    if (!this.placed) {
      this.placed = true;
      const [ox, oy] = this.offsetOf(payload.summary);
      if (this.pendingView) {
        const view = this.pendingView;
        this.pendingView = null;
        this.setGeoView(view);
        return true;
      }
      this.setView(
        ox + (bounds.minX + bounds.maxX) / 2,
        oy + (bounds.minY + bounds.maxY) / 2,
        520,
        315,
        38,
      );
    }
    return true;
  }

  /** Moves the world origin to `frame`, keeping the camera where it is on the ground. */
  private rebase(frame: { zone: number; originE: number; originN: number }): void {
    const world = this.world!;
    if (frame.zone !== world.zone) {
      // Another UTM zone: camera position has no meaning there; the next view sets it.
      this.world = { zone: frame.zone, originE: frame.originE, originN: frame.originN };
      this.placed = false;
      return;
    }
    const dx = frame.originE - world.originE;
    const dy = frame.originN - world.originN;
    this.world = { zone: frame.zone, originE: frame.originE, originN: frame.originN };
    const shift = new THREE.Vector3(...toThree(dx, dy, 0));
    this.camera.position.sub(shift);
    this.controls.target.sub(shift);
    if (this.fly) {
      for (const v of [...this.fly.from, ...this.fly.to]) v.sub(shift);
    }
    this.controls.update();
  }

  removeTile(key: string): void {
    const tile = this.tiles.get(key);
    if (!tile) return;
    for (const layer of ['obs', 'syn'] as const) {
      const base = tile.slotBases[layer];
      if (base !== null) this.slotAllocator.release(base, tile.slots[layer].length);
    }
    tile.dispose();
    this.tiles.delete(key);
    this.scenarioCounts.delete(key);
  }

  /** Terrain height at a world point (0 outside loaded tiles). */
  heightAt(x: number, y: number): number {
    for (const tile of this.tiles.values()) {
      const h = tile.heightAt(x, y);
      if (h !== null) return h;
    }
    return 0;
  }

  /**
   * Camera in MapLibre terms (lng/lat/zoom, pitch from nadir, bearing clockwise
   * from north), for keeping DT in step with the 2D map. Zoom ↔ distance uses
   * MapLibre's own camera: 512 px tiles and a 36.87° vertical field of view put
   * the camera 1.5 × viewport height × metres-per-pixel from its target.
   */
  getGeoView(): GeoView | null {
    const target = this.targetLonLat();
    if (!target) return null;
    const t = this.controls.target;
    const c = this.camera.position;
    const distance = c.distanceTo(t);
    const zoom = Math.log2(
      (1.5 * this.viewportHeight() * metresPerPixelAtZoom0(target.lat)) / Math.max(distance, 1),
    );
    // three: x east, z south. Bearing = compass direction the camera looks at.
    const bearing = (Math.atan2(t.x - c.x, -(t.z - c.z)) * 180) / Math.PI;
    return {
      lng: target.lon,
      lat: target.lat,
      zoom,
      pitch: (this.controls.getPolarAngle() * 180) / Math.PI,
      bearing: (bearing + 360) % 360,
    };
  }

  /** Where the camera will look once tiles arrive (a view requested before the first tile). */
  pendingLonLat(): LonLat | null {
    return this.pendingView ? { lon: this.pendingView.lng, lat: this.pendingView.lat } : null;
  }

  /** Places the camera from a MapLibre-style view (kept until the first tile arrives). */
  setGeoView(view: GeoView): void {
    const at = this.worldOf(view.lng, view.lat);
    if (!at || !this.placed) {
      this.pendingView = view;
      return;
    }
    const distance = THREE.MathUtils.clamp(
      (1.5 * this.viewportHeight() * metresPerPixelAtZoom0(view.lat)) / 2 ** view.zoom,
      this.controls.minDistance,
      this.controls.maxDistance,
    );
    const pitch = Math.min(view.pitch, (this.controls.maxPolarAngle * 180) / Math.PI);
    this.setView(at[0], at[1], distance, view.bearing, 90 - pitch);
  }

  /** Subscribes to camera changes (user navigation, fly-tos). */
  onCameraChange(cb: () => void): () => void {
    this.controls.addEventListener('change', cb);
    return () => this.controls.removeEventListener('change', cb);
  }

  private viewportHeight(): number {
    return this.container.clientHeight || 800;
  }

  /** Geographic position the camera looks at (null before the first tile). */
  targetLonLat(): LonLat | null {
    if (!this.world) return null;
    const t = this.controls.target;
    return utmInverse(this.world.originE + t.x, this.world.originN - t.z, this.world.zone);
  }

  /** World model coordinates of a geographic point (requires the world frame). */
  worldOf(lon: number, lat: number): [number, number] | null {
    if (!this.world || utmZoneOf(lon) !== this.world.zone) return null;
    const [e, n] = utmForward(lon, lat, this.world.zone);
    return [e - this.world.originE, n - this.world.originN];
  }

  private updateDetail(): void {
    for (const tile of this.tiles.values()) tile.updateDetail(this.camera.position);
  }

  /** Hours 0–24 → sun position, light colour, sky, night factor. */
  setTimeOfDay(hours: number): void {
    const t = (hours - 6) / 12; // 0 at 06:00, 1 at 18:00
    const elevation = Math.sin(Math.PI * t) * NOON_ELEVATION - 4;
    const azimuth = 90 + 180 * t; // east → south → west
    const phi = (90 - elevation) * DEG;
    const theta = azimuth * DEG;
    // Model axes: x east, y north. Azimuth measured from north, clockwise.
    const dx = Math.sin(theta) * Math.sin(phi);
    const dy = Math.cos(theta) * Math.sin(phi);
    const dz = Math.cos(phi);
    this.sunDir.set(...toThree(dx, dy, dz)).normalize();
    this.sky.sunPosition.value.copy(this.sunDir);

    const dayness = THREE.MathUtils.smoothstep(elevation, -6, 8);
    const golden = 1 - THREE.MathUtils.smoothstep(elevation, 4, 25);
    this.mats.night.value = 1 - THREE.MathUtils.smoothstep(elevation, -8, 3);
    this.sun.intensity = 3.2 * dayness;
    this.sun.color.setRGB(1, 1 - 0.28 * golden, 1 - 0.5 * golden);
    this.hemi.intensity = 0.3 + 0.2 * dayness;
    // Night: cool moonlit ambient so streets stay readable.
    this.hemi.color.setRGB(0.35 + 0.4 * dayness, 0.45 + 0.39 * dayness, 0.75 + 0.25 * dayness);
    if (this.glow) {
      this.glow.strength.value = 0.1 + 0.7 * this.mats.night.value;
      this.glow.threshold.value = 3 - 2.4 * this.mats.night.value;
    }
    this.mats.skyTint.value
      .setRGB(0.5 + 0.2 * golden, 0.62, 0.8 - 0.2 * golden)
      .multiplyScalar(0.25 + 0.75 * dayness);
    (this.scene.fog as THREE.Fog).color.setRGB(
      0.72 * dayness + 0.05,
      0.79 * dayness + 0.06,
      0.86 * dayness + 0.1,
    );
    this.renderer.toneMappingExposure = 0.78 + 0.25 * (1 - dayness);
    this.envSky.sunPosition.value.copy(this.sunDir);
    this.scheduleEnvironment();
  }

  /** Re-bakes the sky into the environment map (debounced while dragging the time slider). */
  private scheduleEnvironment(): void {
    if (this.envTimer) clearTimeout(this.envTimer);
    this.envTimer = setTimeout(() => {
      this.envTimer = null;
      if (this.disposed) return;
      const target = this.pmrem.fromScene(this.envScene);
      this.envTarget?.dispose();
      this.envTarget = target;
      this.scene.environment = target.texture;
    }, 120);
  }

  /**
   * Colours building shells by a scenario: `colorOf` returns the building's
   * data colour, or null when the scenario has no value for it (soft grey).
   * Null switches scenario colouring off. Returns matched / total buildings.
   */
  setScenario(colorOf: ((b: BuildingInfo) => THREE.Color | null) | null): {
    matched: number;
    total: number;
  } {
    this.scenarioColor = colorOf;
    this.mats.scenarioOn.value = colorOf ? 1 : 0;
    this.scenarioCounts.clear();
    if (colorOf) {
      for (const [key, tile] of this.tiles) this.scenarioCounts.set(key, this.paintScenario(tile));
    }
    return this.scenarioSummary();
  }

  /** Matched / total buildings of the loaded tiles under the active scenario. */
  scenarioSummary(): { matched: number; total: number } {
    let matched = 0;
    let total = 0;
    for (const c of this.scenarioCounts.values()) {
      matched += c.matched;
      total += c.total;
    }
    return { matched, total };
  }

  /** Writes a tile's building colours into the scenario texture. */
  private paintScenario(tile: CityTile): { matched: number; total: number } {
    const colorOf = this.scenarioColor;
    const data = this.mats.scenario.image.data as Uint8Array;
    let matched = 0;
    let total = 0;
    for (const layer of ['obs', 'syn'] as const) {
      const base = tile.slotBases[layer];
      if (base === null) continue;
      tile.slots[layer].forEach((id, i) => {
        const info = tile.building(id);
        const c = info && colorOf ? colorOf(info) : null;
        const k = (base + i) * 4;
        total++;
        if (c) {
          matched++;
          data[k] = Math.round(c.r * 255);
          data[k + 1] = Math.round(c.g * 255);
          data[k + 2] = Math.round(c.b * 255);
          data[k + 3] = 255;
        } else {
          data[k] = data[k + 1] = data[k + 2] = data[k + 3] = 0;
        }
      });
    }
    this.mats.scenario.needsUpdate = true;
    return { matched, total };
  }

  setMode(mode: DtViewMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    for (const tile of this.tiles.values()) tile.setMode(mode);
    this.updateDetail();
  }

  /** Moves the camera to look at a model-space point from `distance` metres. */
  flyTo(x: number, y: number, distance = 140): void {
    const z = this.heightAt(x, y);
    const target = new THREE.Vector3(...toThree(x, y, z));
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.y < 0.35) dir.y = 0.35;
    dir.normalize();
    const position = target.clone().add(dir.multiplyScalar(distance));
    this.fly = {
      from: [this.camera.position.clone(), this.controls.target.clone()],
      to: [position, target],
      t: 0,
    };
  }

  /**
   * Places the camera instantly: looking at (x, y) from `distance` metres,
   * `headingDeg` compass direction the camera looks towards, `pitchDeg` above the horizon.
   */
  setView(x: number, y: number, distance: number, headingDeg: number, pitchDeg: number): void {
    const z = this.heightAt(x, y);
    const target = new THREE.Vector3(...toThree(x, y, z));
    const h = headingDeg * DEG;
    const p = pitchDeg * DEG;
    // Camera sits opposite to the look direction.
    const back = toThree(-Math.sin(h) * Math.cos(p), -Math.cos(h) * Math.cos(p), Math.sin(p));
    this.camera.position.copy(target).add(new THREE.Vector3(...back).multiplyScalar(distance));
    this.controls.target.copy(target);
    this.fly = null;
    this.controls.update();
  }

  /** Development aid: triangle budget of visible meshes per kind (instances × triangles). */
  debugSummary(): Record<string, { meshes: number; instances: number; triangles: number }> {
    const out: Record<string, { meshes: number; instances: number; triangles: number }> = {};
    this.scene.traverseVisible((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const g = o.geometry as THREE.BufferGeometry;
      const tris = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
      const n = instancesOf(o);
      const key =
        o.name.replace(/^(b[os]|p[os])-[-\d,]+-?/, '').replace(/-[-\d,]+$/, '') || 'unnamed';
      const e = (out[key] ??= { meshes: 0, instances: 0, triangles: 0 });
      e.meshes++;
      e.instances += n;
      e.triangles += tris * n;
    });
    return out;
  }

  /** Development aid: toggle post-processing / shadows to isolate frame cost. */
  debugSet(flags: Partial<{ post: boolean; shadows: boolean; ao: boolean }>): void {
    Object.assign(this.debugFlags, flags);
    this.renderer.shadowMap.enabled = this.debugFlags.shadows;
    this.sun.castShadow = this.debugFlags.shadows;
    this.aoStrength.value = this.debugFlags.ao ? 1 : 0;
  }

  /** Development aid: how many visible meshes / triangles each camera's frustum keeps. */
  debugCulling(): Record<string, number> {
    const frustum = (cam: THREE.Camera) => {
      cam.updateMatrixWorld();
      const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      return new THREE.Frustum().setFromProjectionMatrix(m);
    };
    const main = frustum(this.camera);
    this.sun.shadow.camera.updateProjectionMatrix();
    const shadow = frustum(this.sun.shadow.camera);
    const out = {
      visible: 0,
      visibleTris: 0,
      inView: 0,
      inViewTris: 0,
      shadowCasters: 0,
      shadowTris: 0,
      hugeSpheres: 0,
    };
    const sphere = new THREE.Sphere();
    this.scene.traverseVisible((o) => {
      if (!(o instanceof THREE.Mesh) || o.name === 'sea' || o === (this.sky as unknown)) return;
      const g = o.geometry as THREE.BufferGeometry;
      const n = instancesOf(o);
      const tris = ((g.index ? g.index.count : g.getAttribute('position').count) / 3) * n;
      const src = g.boundingSphere;
      if (!src) return;
      sphere.copy(src).applyMatrix4(o.matrixWorld);
      out.visible++;
      out.visibleTris += tris;
      if (sphere.radius > 1500) out.hugeSpheres++;
      if (main.intersectsSphere(sphere)) {
        out.inView++;
        out.inViewTris += tris;
      }
      if (o.castShadow && shadow.intersectsSphere(sphere)) {
        out.shadowCasters++;
        out.shadowTris += tris;
      }
    });
    return out;
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resize.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.controls.dispose();
    for (const tile of this.tiles.values()) tile.dispose();
    this.tiles.clear();
    for (const g of this.geometryCache.values()) g.dispose();
    this.geometryCache.clear();
    this.sea?.geometry.dispose();
    if (this.envTimer) clearTimeout(this.envTimer);
    this.envTarget?.dispose();
    this.pmrem.dispose();
    this.mats.dispose();
    this.pipeline.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private readonly frame = () => {
    if (this.disposed) return;
    if (this.fly) {
      this.fly.t = Math.min(1, this.fly.t + 1 / 70);
      const k = this.fly.t < 0.5 ? 4 * this.fly.t ** 3 : 1 - (-2 * this.fly.t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(this.fly.from[0], this.fly.to[0], k);
      this.controls.target.lerpVectors(this.fly.from[1], this.fly.to[1], k);
      if (this.fly.t >= 1) this.fly = null;
    }
    this.controls.update();
    this.updateDetail();

    // Near plane follows the camera's height above ground: depth precision
    // scales with it, and with a fixed 1 m near plane ground layers a few cm
    // apart z-fought a few hundred metres away.
    const pos = this.camera.position;
    const near = THREE.MathUtils.clamp((pos.y - this.heightAt(pos.x, -pos.z)) * 0.15, 1, 40);
    if (Math.abs(near - this.camera.near) > this.camera.near * 0.15) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }

    // Shadow frustum follows the camera target.
    const target = this.controls.target;
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(this.sunDir, 1000);
    const dist = this.camera.position.distanceTo(target);
    // Shadows only matter near the focus; a smaller box keeps the shadow pass cheap and sharp.
    const extent = THREE.MathUtils.clamp(dist * 1.1, 120, 450);
    const cam = this.sun.shadow.camera;
    if (Math.abs(cam.right - extent) > 20) {
      cam.left = -extent;
      cam.right = extent;
      cam.top = extent;
      cam.bottom = -extent;
      cam.updateProjectionMatrix();
    }

    const cpu0 = performance.now();
    if (this.debugFlags.post) this.pipeline.render();
    else this.renderer.render(this.scene, this.camera);
    this.cpuMs += performance.now() - cpu0;

    this.frames++;
    const now = performance.now();
    if (now - this.lastStats > 1000) {
      const info = this.renderer.info.render;
      this.events.onStats?.({
        backend: this.backend,
        fps: Math.round((this.frames * 1000) / (now - this.lastStats)),
        drawCalls: info.drawCalls,
        triangles: info.triangles,
        cpuMsPerFrame: Math.round((this.cpuMs / Math.max(1, this.frames)) * 10) / 10,
      });
      this.frames = 0;
      this.cpuMs = 0;
      this.lastStats = now;
    }
  };

  private onResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    this.pointerDown = { x: e.clientX, y: e.clientY };
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    const start = this.pointerDown;
    this.pointerDown = null;
    if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    let best: { d: number; b: BuildingInfo } | null = null;
    for (const tile of this.tiles.values()) {
      const hit = tile.pick(ray);
      if (hit && (!best || hit.d < best.d)) best = hit;
    }
    this.events.onSelect?.(best?.b ?? null);
  };
}
