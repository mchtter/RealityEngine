import {
  type LonLat,
  type UtilityKind,
  utmForward,
  utmInverse,
  utmZoneOf,
} from '@opentwin/city-core';
import type { CityObjectState } from '@opentwin/shared';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import {
  float,
  mix,
  mrt,
  normalView,
  output,
  pass,
  renderOutput,
  uniform,
  vibrance,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import { CameraRig, type DtCameraMode } from './camera-modes';
import { buildCityStates, disposeCityStates } from './city-states';
import { CityTile, type DtInspect, type TileLevel } from './city-tile';
import { toThree } from './geom';
import {
  type DtMaterials,
  SCENARIO_TEXTURE_HEIGHT,
  SCENARIO_TEXTURE_WIDTH,
  createMaterials,
  setUnderground as fadeGround,
} from './materials';
import { SlotAllocator } from './slot-allocator';
import { type BuildingInfo, type TilePayload, type TileSummary, instancesOf } from './tile-payload';
import { VehicleLayer, type VehicleState } from './vehicles';

export type DtViewMode = 'showcase' | 'data';
export type DtQuality = 'high' | 'medium' | 'low';
export type { DtCameraMode } from './camera-modes';

export interface DtEngineStats {
  backend: 'webgpu' | 'webgl';
  fps: number;
  drawCalls: number;
  triangles: number;
  /** Average CPU time of render() per frame (ms). */
  cpuMsPerFrame: number;
}

/** Inspect result with geographic position (for the UI). */
export interface DtInspection extends DtInspect {
  lonLat: LonLat | null;
}

export interface DtEngineEvents {
  onSelect?: (building: BuildingInfo | null) => void;
  /** Inspect mode: what a click hit (null: nothing / cleared). */
  onInspect?: (hit: DtInspection | null) => void;
  onStats?: (stats: DtEngineStats) => void;
  /** Buried networks in the loaded tiles changed (runs and km per network). */
  onUtilities?: (stats: TileSummary['utilities']) => void;
}

const DEG = Math.PI / 180;
/** Background and haze of the underground view. */
const UNDERGROUND_BG = new THREE.Color(0x061420);

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

/** Farthest a scenario / bounds fit backs the camera off (metres): a whole district. */
const FIT_MAX_DISTANCE = 6000;

/** Zonguldak latitude drives the sun's noon elevation (September). */
const NOON_ELEVATION = 48;

/**
 * Digital-twin city renderer. Owns the three.js scene built from a compiled
 * CityModel; React only passes the container and receives events.
 */
export type DtLook = 'hdr' | 'classic';

export class DtEngine {
  readonly backend: 'webgpu' | 'webgl';
  private readonly renderer: THREE.WebGPURenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: MapControls;
  /** Camera modes (orbit / isometric / street / fly) and keyboard navigation. */
  private readonly rig: CameraRig;
  private lastFrame = performance.now();
  private readonly lodEye = new THREE.Vector3();
  private readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  /**
   * Cascaded shadows fitted to the view, fading out at their far end. The
   * single box around the focus ended in a hard line that followed the
   * camera (2026-10-04). `localStorage.dtShadows = 'box'` keeps the old box.
   */
  private csm: CSMShadowNode | null = null;
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
  /** Colour grade strength: 0 classic, 1 HDR look (after tone mapping). */
  private readonly grade = uniform(1);
  /** HDR look settings (`debugTune` adjusts them live). */
  private readonly tune = {
    exposure: 0.44,
    sun: 5.6,
    hemi: 0.2,
    env: 0.3,
    bloom: 0.1,
    /**
     * Bloom threshold by day (linear radiance): 3 = only emissive lights glow.
     * 1.4 made sunlit white walls and balconies bloom and burn out (2026-10-04).
     */
    threshold: 3,
    vibrance: uniform(0.28),
    contrast: uniform(0.2),
  };
  private look: DtLook = 'hdr';
  private hours = 15.5;
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
    // The dome is far beyond the fog's far distance: fogged, it renders flat grey.
    (this.sky.material as THREE.NodeMaterial).fog = false;
    this.scene.add(this.sky);
    this.envSky.scale.setScalar(50);
    this.envSky.turbidity.value = 2.6;
    this.envSky.rayleigh.value = 1.1;
    this.envSky.mieCoefficient.value = 0.004;
    this.envSky.mieDirectionalG.value = 0.8;
    this.envSky.cloudCoverage.value = 0.42;
    this.envScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environmentIntensity = 0.22;
    this.scene.fog = new THREE.Fog(0xb9c9d8, 1300, 5200);

    this.sun.castShadow = true;
    let shadowMode = 'csm';
    try {
      shadowMode = localStorage.getItem('dtShadows') ?? 'csm';
    } catch {
      // Storage blocked: default.
    }
    if (shadowMode !== 'box') {
      // One cascade: the shadow pass costs what the old single box did (two
      // drew ~3 M more triangles a frame); fitted to the view and fading out
      // at its far end, so no hard line follows the camera.
      const csm = new CSMShadowNode(this.sun, {
        cascades: 1,
        maxFar: 700,
        mode: 'practical',
        lightMargin: 300,
      });
      csm.fade = true;
      (this.sun.shadow as THREE.DirectionalLightShadow & { shadowNode: unknown }).shadowNode = csm;
      this.csm = csm;
    }
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

    // Backdrop beyond the loaded tiles: ground (fogged at that distance), just
    // under the lowest loaded terrain. A sea plane here showed the inland city
    // floating over a blue void; coastal tiles draw their own sea.
    const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000), this.mats.terrain);
    backdrop.rotation.x = -Math.PI / 2;
    backdrop.receiveShadow = false;
    backdrop.name = 'backdrop';
    this.scene.add(backdrop);
    this.scene.add(this.vehicles.group);
    this.sea = backdrop;

    this.controls = new MapControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = 1.43;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 1800;
    this.controls.zoomToCursor = true;
    this.camera.position.set(260, 230, 330);
    this.controls.update();
    this.rig = new CameraRig(
      this.camera,
      this.controls,
      renderer.domElement,
      this.scene,
      (x, y) => this.heightAt(x, y),
      () => this.controls.dispatchEvent({ type: 'change' }),
      (x, y, foot) => this.standHeightAt(x, y, foot),
    );

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
    const shown = renderOutput(lit.add(glow));
    // HDR grade: an S-curve (deeper shadows, brighter highlights), then vibrance.
    const curved = mix(shown, shown.mul(shown).mul(shown.mul(-2).add(3)), this.tune.contrast);
    const graded = vibrance(curved, this.tune.vibrance);
    this.pipeline.outputNode = fxaa(mix(shown, graded, this.grade));

    this.setLook(this.look);

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
  addTile(key: string, payload: TilePayload, level: TileLevel = 'full'): boolean {
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
      level,
    );
    if (this.scenarioColor) this.scenarioCounts.set(key, this.paintScenario(tile));
    if (this.mode !== 'showcase') tile.setMode(this.mode);
    if (this.showFixes) tile.setShowFixes(true);
    if (this.underground.size) tile.setUnderground(this.underground);
    tile.updateDetail(this.rig.lodEye(this.lodEye));
    this.tiles.set(key, tile);
    this.scene.add(tile.group);
    this.placeBackdrop();
    this.emitUtilities();
    // Ground heights / building tops of states on this tile are known now.
    if (this.cityStates.length) this.rebuildCityStates();
    if (this.vehicleList.length) this.setVehicles(this.vehicleList);
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

  /** Backdrop 3 m under the lowest loaded ground. */
  private placeBackdrop(): void {
    if (!this.sea) return;
    // A city not built yet (every loaded tile empty) lies on the grey grid to the horizon.
    const empty = this.tiles.size > 0 && [...this.tiles.values()].every((t) => t.summary.empty);
    this.sea.material = empty ? this.mats.terrainGrid : this.mats.terrain;
    let low = Infinity;
    for (const t of this.tiles.values()) {
      const h = t.summary.terrain.heights;
      for (let i = 0; i < h.length; i += 7) low = Math.min(low, h[i]);
    }
    if (Number.isFinite(low)) this.sea.position.y = low - 3;
  }

  /** Development aid: GPU bytes per mesh name of a loaded tile. */
  debugTileMemory(key: string): Record<string, number> {
    return this.tiles.get(key)?.debugBytes() ?? {};
  }

  /** Detail level of a loaded tile (null if not loaded). */
  tileLevel(key: string): TileLevel | null {
    return this.tiles.get(key)?.level ?? null;
  }

  /** GPU geometry a loaded tile holds (bytes), 0 if not loaded. */
  tileBytes(key: string): number {
    return this.tiles.get(key)?.bytes ?? 0;
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
    this.emitUtilities();
  }

  /**
   * Where someone at foot height `foot` stands at (x, y). Inside a tunnel tube
   * (feet between its road and ceiling) only the tube's road: the hill over it
   * rises gently at the mouth and would otherwise be climbed step by step.
   * Elsewhere the highest surface (ground, bridge deck) no more than a step
   * above the feet, so walking climbs onto a bridge along its ramp; falls back
   * to the lowest surface.
   */
  standHeightAt(x: number, y: number, foot: number): number {
    const hs = [{ h: this.heightAt(x, y) } as { h: number; clear?: number }];
    for (const tile of this.tiles.values()) hs.push(...tile.decksAt(x, y));
    const tube = hs.find(
      (s) => s.clear !== undefined && foot > s.h - 1.5 && foot < s.h + s.clear - 1,
    );
    if (tube) return tube.h;
    const below = hs.filter((s) => s.h <= foot + 1.2).map((s) => s.h);
    return below.length ? Math.max(...below) : Math.min(...hs.map((s) => s.h));
  }

  /** Ground height at a world point (0 outside loaded tiles). */
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
    // Isometric views stand far off with a narrow lens: zoom as the base lens would see it.
    const distance = c.distanceTo(t) / this.rig.distanceScale;
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
    const eye = this.rig.lodEye(this.lodEye);
    for (const tile of this.tiles.values()) tile.updateDetail(eye);
  }

  /** Camera mode: map orbit, isometric, street level, free flight (all with WASD). */
  setCameraMode(mode: DtCameraMode): void {
    this.fly = null;
    this.rig.setMode(mode);
    this.updateDetail();
  }

  get cameraMode(): DtCameraMode {
    return this.rig.mode;
  }

  /**
   * Overall look. `hdr`: Neutral tone mapping (keeps hue and saturation in
   * bright light), a stronger sun against a dimmer sky (deeper shadows), a
   * light S-curve and vibrance after tone mapping.
   * `classic`: the earlier ACES look. (AgX was tried: flat and washed out.)
   */
  setLook(look: DtLook): void {
    this.look = look;
    this.renderer.toneMapping =
      look === 'hdr' ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
    this.grade.value = look === 'hdr' ? 1 : 0;
    this.pipeline.needsUpdate = true;
    this.setTimeOfDay(this.hours);
  }

  /** Development aid: adjust the HDR look live (and the tone mapper). */
  debugTune(
    t: Partial<{
      exposure: number;
      sun: number;
      hemi: number;
      env: number;
      bloom: number;
      threshold: number;
      vibrance: number;
      contrast: number;
      mapper: 'agx' | 'aces' | 'neutral';
    }>,
  ): void {
    for (const k of ['exposure', 'sun', 'hemi', 'env', 'bloom', 'threshold'] as const)
      if (t[k] !== undefined) this.tune[k] = t[k];
    if (t.vibrance !== undefined) this.tune.vibrance.value = t.vibrance;
    if (t.contrast !== undefined) this.tune.contrast.value = t.contrast;
    if (t.mapper) {
      this.renderer.toneMapping =
        t.mapper === 'agx'
          ? THREE.AgXToneMapping
          : t.mapper === 'neutral'
            ? THREE.NeutralToneMapping
            : THREE.ACESFilmicToneMapping;
      this.pipeline.needsUpdate = true;
    }
    this.setTimeOfDay(this.hours);
  }

  /** Hours 0–24 → sun position, light colour, sky, night factor. */
  setTimeOfDay(hours: number): void {
    this.hours = hours;
    const hdr = this.look === 'hdr';
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
    // Direct sun vs sky light about 5:1, as in clear-day photographs: lit and shaded
    // walls read clearly apart.
    // HDR: a stronger sun against a dimmer sky light, deeper shadows.
    this.sun.intensity = (hdr ? this.tune.sun : 4.4) * dayness;
    this.sun.color.setRGB(1, 1 - 0.28 * golden, 1 - 0.5 * golden);
    this.hemi.intensity = hdr ? this.tune.hemi + 0.08 - 0.08 * dayness : 0.3 - 0.08 * dayness;
    // Night: cool moonlit ambient so streets stay readable.
    // Day: near-neutral sky light (a blue one pushed grey-blue plaster to saturated blue).
    this.hemi.color.setRGB(0.35 + 0.53 * dayness, 0.45 + 0.44 * dayness, 0.75 + 0.17 * dayness);
    if (this.glow) {
      // By day only emissive lights glow (tune.threshold).
      this.glow.strength.value = (hdr ? this.tune.bloom : 0.1) + 0.7 * this.mats.night.value;
      const day = hdr ? this.tune.threshold : 3;
      this.glow.threshold.value = day + (0.6 - day) * this.mats.night.value;
    }
    this.mats.skyTint.value
      .setRGB(0.5 + 0.2 * golden, 0.62, 0.8 - 0.2 * golden)
      .multiplyScalar(0.25 + 0.75 * dayness);
    (this.scene.fog as THREE.Fog).color.setRGB(
      0.72 * dayness + 0.05,
      0.79 * dayness + 0.06,
      0.86 * dayness + 0.1,
    );
    // Sunlit plaster lands near its own colour (not washed to white); night opens up.
    this.renderer.toneMappingExposure = (hdr ? this.tune.exposure : 0.42) + 0.6 * (1 - dayness);
    this.scene.environmentIntensity = hdr ? this.tune.env : 0.22;
    this.envSky.sunPosition.value.copy(this.sunDir);
    this.scheduleEnvironment();
    this.applyUndergroundLook();
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

  private showFixes = false;

  /** Red overlay of what was cut off buildings (road / neighbour overlaps). */
  setShowFixes(on: boolean): void {
    this.showFixes = on;
    for (const tile of this.tiles.values()) tile.setShowFixes(on);
  }

  private readonly vehicles = new VehicleLayer();
  private vehicleList: VehicleState[] = [];

  private readonly downRay = new THREE.Raycaster();

  /**
   * Height of the drawn ground at a world point (street surface, sidewalk,
   * terrain): a ray down onto the tile's ground meshes; the terrain model
   * where none is hit. Streets lie on their own profile, up to a few metres
   * off the terrain grid, so objects placed on them use this.
   */
  surfaceAt(x: number, y: number): number {
    const meshes: THREE.Object3D[] = [];
    for (const tile of this.tiles.values()) {
      if (tile.heightAt(x, y) !== null) meshes.push(...tile.visibleGround());
    }
    this.downRay.set(new THREE.Vector3(x, 5000, -y), new THREE.Vector3(0, -1, 0));
    const hit = this.downRay.intersectObjects(meshes, false)[0];
    return hit ? hit.point.y : this.heightAt(x, y);
  }

  /** Live vehicles (eased to each new fix). */
  setVehicles(list: VehicleState[]): void {
    this.vehicleList = list;
    this.vehicles.update(list, {
      worldOf: (lon, lat) => this.worldOf(lon, lat),
      heightAt: (x, y) => this.surfaceAt(x, y),
    });
  }

  /** Vehicle the camera keeps following (until the user takes the camera). */
  private followId: string | null = null;

  /** Flies close to a vehicle and follows it. */
  focusVehicle(id: string): void {
    const at = this.vehicles.positionOf(id);
    if (!at) return;
    this.flyTo(at[0], at[1], 70);
    this.followId = id;
  }

  /** Moves camera and target with the followed vehicle (same view, new place). */
  private follow(dt: number): void {
    if (!this.followId || this.fly) return;
    const p = this.vehicles.scenePositionOf(this.followId);
    if (!p) {
      this.followId = null;
      return;
    }
    const k = 1 - Math.exp(-dt * 3);
    const delta = p.clone().sub(this.controls.target).multiplyScalar(k);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
  }

  private cityStates: CityObjectState[] = [];
  private cityStatesGroup: THREE.Group | null = null;

  /** Shows the states of city objects (damaged, hazard …) as pulsing walls and beacons. */
  setCityStates(states: CityObjectState[]): void {
    this.cityStates = states;
    this.rebuildCityStates();
  }

  private rebuildCityStates(): void {
    if (this.cityStatesGroup) disposeCityStates(this.cityStatesGroup);
    this.cityStatesGroup = null;
    if (!this.cityStates.length || !this.world) return;
    this.cityStatesGroup = buildCityStates(this.cityStates, {
      worldOf: (lon, lat) => this.worldOf(lon, lat),
      heightAt: (x, y) => this.surfaceAt(x, y),
      buildingTop: (objectId) => {
        for (const tile of this.tiles.values()) {
          const b = tile.summary.buildings.find((i) => i.entity === objectId || i.ref === objectId);
          if (b) return b.topZ;
        }
        return null;
      },
    });
    this.scene.add(this.cityStatesGroup);
  }

  /** Flies to a state's object (its outline, else ~60 m around the point). */
  focusCityState(state: CityObjectState): void {
    const pts = state.outline?.length
      ? state.outline
      : [[state.lon, state.lat] as [number, number]];
    const lons = pts.map((p) => p[0]);
    const lats = pts.map((p) => p[1]);
    const pad = 0.0003;
    this.flyToBounds([
      Math.min(...lons) - pad,
      Math.min(...lats) - pad,
      Math.max(...lons) + pad,
      Math.max(...lats) + pad,
    ]);
  }

  private underground = new Set<UtilityKind>();
  private utilitiesKey = '';

  /**
   * Underground view: the given buried networks show under a faded,
   * see-through ground with buildings as holograms; none = the normal city.
   */
  setUnderground(kinds: UtilityKind[]): void {
    this.underground = new Set(kinds);
    fadeGround(this.mats, this.underground.size > 0);
    for (const tile of this.tiles.values()) tile.setUnderground(this.underground);
    // Sky and fog back to the time of day, then the underground look over them.
    this.setTimeOfDay(this.hours);
    this.updateDetail();
  }

  /** Underground view: no sky, a dark soil-blue void and haze, so the networks glow through the ground. */
  private applyUndergroundLook(): void {
    const on = this.underground.size > 0;
    this.sky.visible = !on;
    this.scene.background = on ? UNDERGROUND_BG : null;
    if (on) (this.scene.fog as THREE.Fog).color.copy(UNDERGROUND_BG);
  }

  /** Runs and km of every buried network in the loaded tiles. */
  utilityStats(): TileSummary['utilities'] {
    const out: TileSummary['utilities'] = {};
    for (const tile of this.tiles.values()) {
      for (const [kind, st] of Object.entries(tile.utilityStats) as [
        UtilityKind,
        { runs: number; km: number; cabinets?: number },
      ][]) {
        const o = (out[kind] ??= { runs: 0, km: 0 });
        o.runs += st.runs;
        o.km += st.km;
        if (st.cabinets) o.cabinets = (o.cabinets ?? 0) + st.cabinets;
      }
    }
    return out;
  }

  private emitUtilities(): void {
    const stats = this.utilityStats();
    const key = JSON.stringify(
      Object.entries(stats).map(([k, v]) => [k, v.runs, Math.round(v.km * 100), v.cabinets]),
    );
    if (key === this.utilitiesKey) return;
    this.utilitiesKey = key;
    this.events.onUtilities?.(stats);
  }

  /** Flies to the buried networks shown (all loaded ones when none is). Returns false when there are none. */
  focusUtilities(): boolean {
    const box = new THREE.Box3();
    for (const tile of this.tiles.values()) tile.utilityBox(this.underground, box);
    if (box.isEmpty() || !this.world) return false;
    const a = utmInverse(
      this.world.originE + box.min.x,
      this.world.originN - box.max.z,
      this.world.zone,
    );
    const b = utmInverse(
      this.world.originE + box.max.x,
      this.world.originN - box.min.z,
      this.world.zone,
    );
    this.flyToBounds([a.lon, a.lat, b.lon, b.lat]);
    return true;
  }

  setMode(mode: DtViewMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    for (const tile of this.tiles.values()) tile.setMode(mode);
    this.updateDetail();
  }

  /** Moves the camera to look at a model-space point from `distance` metres. */
  /**
   * Frames a geographic box [minLon, minLat, maxLon, maxLat]: the camera
   * backs off until the box's diagonal fits the view (near for a few
   * buildings, far for a district) and looks down at ~50°. A box in another
   * UTM zone (or before the first tile) is kept as the pending view: the
   * tiles there are requested and the camera lands once they arrive.
   */
  flyToBounds(bbox: [number, number, number, number]): void {
    const [w, s, e, n] = bbox;
    const lon = (w + e) / 2;
    const lat = (s + n) / 2;
    const mLat = 111_320;
    const mLon = mLat * Math.cos((lat * Math.PI) / 180);
    const radius = Math.max(30, Math.hypot((e - w) * mLon, (n - s) * mLat) / 2);
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const distance = THREE.MathUtils.clamp(
      (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.1,
      this.controls.minDistance * 4,
      FIT_MAX_DISTANCE,
    );
    // The user may zoom out as far as the fit went.
    this.controls.maxDistance = Math.max(this.controls.maxDistance, distance);
    const at = this.worldOf(lon, lat);
    if (!at || !this.placed || this.rig.mode !== 'orbit') {
      const zoom = Math.log2((1.5 * this.viewportHeight() * metresPerPixelAtZoom0(lat)) / distance);
      if (at && this.placed) {
        this.setGeoView({ lng: lon, lat, zoom, pitch: 40, bearing: 0 });
      } else {
        this.pendingView = { lng: lon, lat, zoom, pitch: 40, bearing: 0 };
      }
      return;
    }
    const z = this.heightAt(at[0], at[1]);
    const target = new THREE.Vector3(...toThree(at[0], at[1], z));
    // Keep the current heading, look down at 50°.
    const dir = this.camera.position.clone().sub(this.controls.target);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize().multiplyScalar(Math.cos((50 * Math.PI) / 180));
    dir.y = Math.sin((50 * Math.PI) / 180);
    const position = target.clone().add(dir.multiplyScalar(distance));
    this.fly = {
      from: [this.camera.position.clone(), this.controls.target.clone()],
      to: [position, target],
      t: 0,
    };
  }

  flyTo(x: number, y: number, distance = 140): void {
    if (this.rig.mode !== 'orbit') {
      const dir = this.camera.getWorldDirection(new THREE.Vector3());
      const heading = (Math.atan2(dir.x, -dir.z) * 180) / Math.PI;
      this.setView(x, y, distance, heading, 38);
      return;
    }
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
    if (this.rig.mode === 'street' || this.rig.mode === 'fly') {
      // Street / fly keep their own camera: stand at the point, facing the heading.
      const [tx, , tz] = toThree(x, y, z);
      const height =
        this.rig.mode === 'fly' ? z + distance * Math.sin(Math.max(pitchDeg, 10) * DEG) : null;
      this.rig.placeAt(tx, tz, headingDeg, height);
      this.fly = null;
      return;
    }
    if (this.rig.mode === 'isometric') {
      distance *= this.rig.distanceScale;
      pitchDeg = 35.264;
    }
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

  /** Development aid: camera position (world) and mode. */
  debugEye(): { x: number; y: number; z: number; mode: DtCameraMode } {
    const p = this.camera.position;
    return { x: p.x, y: p.y, z: p.z, mode: this.rig.mode };
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

  private inspectMode = false;
  private highlight: THREE.Object3D | null = null;

  /** Inspect mode: a click picks any object (not just buildings) and outlines it. */
  setInspectMode(on: boolean): void {
    this.inspectMode = on;
    if (!on) this.clearHighlight();
  }

  private clearHighlight(): void {
    if (!this.highlight) return;
    this.highlight.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) (m.material as THREE.Material).dispose();
    });
    this.highlight.removeFromParent();
    this.highlight = null;
  }

  /** Picks whatever is under a canvas point (CSS pixels) and outlines it. */
  inspectAt(clientX: number, clientY: number): DtInspection | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    let best: ReturnType<CityTile['inspect']> = null;
    for (const tile of this.tiles.values()) {
      const hit = tile.inspect(ray);
      if (hit && (!best || hit.d < best.d)) best = hit;
    }
    this.clearHighlight();
    if (!best) return null;
    const group = new THREE.Group();
    group.name = 'inspect-highlight';
    const g = best.highlight;
    if (g.userData.lines) {
      const mat = new THREE.LineBasicMaterial({ color: 0xff7a00, depthTest: false });
      group.add(new THREE.LineSegments(g, mat));
    } else {
      // Filled (see-through, drawn over everything) and a solid pass where visible.
      const over = new THREE.MeshBasicMaterial({
        color: 0xff7a00,
        transparent: true,
        opacity: 0.28,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const front = new THREE.MeshBasicMaterial({
        color: 0xff7a00,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const a = new THREE.Mesh(g, over);
      const b = new THREE.Mesh(g, front);
      a.renderOrder = 998;
      b.renderOrder = 999;
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(g, 20),
        new THREE.LineBasicMaterial({ color: 0xffd400, depthTest: false }),
      );
      edges.renderOrder = 1000;
      group.add(a, b, edges);
    }
    this.scene.add(group);
    this.highlight = group;
    const [x, y] = best.info.point;
    const lonLat = this.world
      ? utmInverse(this.world.originE + x, this.world.originN + y, this.world.zone)
      : null;
    return { ...best.info, lonLat };
  }

  dispose(): void {
    this.vehicles.dispose();
    this.clearHighlight();
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.csm?.dispose();
    this.resize.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.rig.dispose();
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
    const now0 = performance.now();
    const dt = (now0 - this.lastFrame) / 1000;
    const controlsOwnCamera = this.rig.update(dt);
    this.lastFrame = now0;
    this.vehicles.tick(Math.min(dt, 0.25));
    this.follow(Math.min(dt, 0.25));
    if (this.fly && controlsOwnCamera) {
      this.fly.t = Math.min(1, this.fly.t + 1 / 70);
      const k = this.fly.t < 0.5 ? 4 * this.fly.t ** 3 : 1 - (-2 * this.fly.t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(this.fly.from[0], this.fly.to[0], k);
      this.controls.target.lerpVectors(this.fly.from[1], this.fly.to[1], k);
      if (this.fly.t >= 1) this.fly = null;
    }
    if (controlsOwnCamera) this.controls.update();
    this.updateDetail();

    // Near plane follows the camera's height above ground: depth precision
    // scales with it, and with a fixed 1 m near plane ground layers a few cm
    // apart z-fought a few hundred metres away.
    const pos = this.camera.position;
    const near = THREE.MathUtils.clamp(
      (pos.y - this.heightAt(pos.x, -pos.z)) * 0.15,
      this.rig.minNear,
      40,
    );
    if (Math.abs(near - this.camera.near) > this.camera.near * 0.15) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }

    // Shadow frustum follows the camera target.
    const target = this.controls.target;
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(this.sunDir, 1000);
    const dist = this.camera.position.distanceTo(target);
    // Haze starts beyond the focus: a district seen from 5 km is not lost in it.
    const fog = this.scene.fog as THREE.Fog;
    fog.near = Math.max(1300, dist * 1.2);
    fog.far = Math.max(5200, dist * 2.5 + 2000);
    // Shadows only matter near the focus; a smaller box keeps the shadow pass cheap and sharp.
    const extent = THREE.MathUtils.clamp(dist * 1.1, 120, 450);
    const cam = this.sun.shadow.camera;
    if (!this.csm && Math.abs(cam.right - extent) > 20) {
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
    // Taking the camera ends following a vehicle.
    this.followId = null;
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    const start = this.pointerDown;
    this.pointerDown = null;
    if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;
    if (this.inspectMode) {
      this.events.onInspect?.(this.inspectAt(e.clientX, e.clientY));
      return;
    }
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
