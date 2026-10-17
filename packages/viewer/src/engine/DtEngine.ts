import {
  type GeoTerrainGrid,
  type LonLat,
  type UtilityKind,
  tileKey,
  utmForward,
  utmInverse,
  utmZoneOf,
} from '@opentwin/city-core';
import type { LiveFeedChange, LiveObjectView } from '@opentwin/plugin-sdk';
import type { CityObjectState, CityPlacement } from '@opentwin/shared';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import {
  exp,
  float,
  fog,
  mix,
  mrt,
  normalView,
  output,
  pass,
  positionWorld,
  rangeFogFactor,
  renderOutput,
  uniform,
  vibrance,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import {
  type FlatRing,
  PolygonIndex,
  clampStep,
  densifyRing,
  interiorPoint,
  outerRings,
  simplifyRing,
} from './boundary-geo';
import { CameraRig, type DtCameraMode } from './camera-modes';
import { BoundaryWall } from './city-boundary';
import { buildCityStates, disposeCityStates } from './city-states';
import { CityTile, type DtInspect, FAR_SHADOW_LAYER, type TileLevel } from './city-tile';
import { type DetailLevel, LEVEL_DWELL_MS, nextLevel } from './detail-level';
import { toThree } from './geom';
import { GroundAtlas } from './ground-atlas';
import { GroundClipmap, HIDDEN_LAYER } from './ground-clipmap';
import { HorizonLayer } from './horizon';
import { openLandAlbedo } from './landcover';
import { LiveObjectLayer, type LiveRef, type LiveScreen } from './live-objects';
import { allLayersRay, setLook } from './look-twin';
import type { MapStyle } from './map-style';
import {
  type DtMaterials,
  SCENARIO_ALPHA,
  SCENARIO_TEXTURE_HEIGHT,
  SCENARIO_TEXTURE_WIDTH,
  createMaterials,
  setUnderground as fadeGround,
} from './materials';
import { type OverviewData, OverviewMap, type OverviewPick } from './overview-map';
import { PlacePin, type PinScreen } from './place-pin';
import { PlacementLayer } from './placements';
import { PoiLabeller } from './poi-labels';
import { type QuakeCity, QuakeOverlay } from './quake-overlay';
import { SlotAllocator } from './slot-allocator';
import { StreetLabeller } from './street-labels';
import {
  type BuildingInfo,
  type MeshPayload,
  type TilePayload,
  type TileSummary,
  instancesOf,
} from './tile-payload';
import { VehicleLayer, type VehicleState } from './vehicles';

/** A building's scenario colour, the scenario key (join value) it matched and the overlay that painted it. */
export interface ScenarioPaint {
  color: THREE.Color;
  key: string;
  overlay: string;
}
export type ScenarioPaintOf = (b: BuildingInfo) => ScenarioPaint | null;

/** Buildings painted / loaded, and the distinct scenario keys found among them (`overlay|key`). */
export interface ScenarioSummary {
  matched: number;
  total: number;
  keys: Set<string>;
}

/** Distinct keys found per overlay in a summary. */
export function keysPerOverlay(summary: ScenarioSummary): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of summary.keys) {
    const overlay = k.slice(0, k.indexOf('|'));
    out[overlay] = (out[overlay] ?? 0) + 1;
  }
  return out;
}
type TileScenarioCount = ScenarioSummary;

/** A building's source identity: shared by its split parts and its copies in neighbouring tiles. */
export const buildingKey = (b: BuildingInfo): string =>
  b.ref ?? (b.osmId !== undefined ? String(b.osmId) : b.id.replace(/-\d+$/, ''));

/** Shadow cascade reach of near views (m); it grows with the camera distance up to the max. */
const CSM_NEAR_REACH = 700;
const CSM_MAX_REACH = 6000;
/** The far cascade reaches at least this far (the fog's least end, plus a margin). */
const CSM_COVER_MIN = 5600;

/** [west, south, east, north] in degrees. */
export type DtBox = [number, number, number, number];

/** A building painted by the active scenario. */
export interface ScenarioBuilding {
  /** Source identity (buildingKey). */
  id: string;
  info: BuildingInfo;
  paint: ScenarioPaint;
  box: DtBox;
}

const unionBox = (a: DtBox, b: DtBox): DtBox => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];

/** A focused building is framed at least this wide (degrees, ~90 m). */
const FOCUS_MIN_SPAN = 0.0009;

/** A box grown to at least `span` degrees around its centre. */
export const padBox = ([w, s, e, n]: DtBox, span: number): DtBox => {
  const dx = Math.max(0, (span - (e - w)) / 2);
  const dy = Math.max(0, (span - (n - s)) / 2);
  return [w - dx, s - dy, e + dx, n + dy];
};

const alphaOf = (data: boolean, selected: boolean): number =>
  data
    ? selected
      ? SCENARIO_ALPHA.dataSelected
      : SCENARIO_ALPHA.data
    : selected
      ? SCENARIO_ALPHA.selected
      : SCENARIO_ALPHA.none;

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
  /** Detail level (0 map, 1 over the city … 5 street). */
  level: DetailLevel;
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
  /** A placed model was clicked (null: a click elsewhere). */
  onSelectPlacement?: (id: string | null) => void;
  /** A live object (plugin feed) was clicked (null: a click elsewhere). */
  onSelectLive?: (sel: LiveRef | null) => void;
  /** The camera ran into the city's boundary (at most every few seconds). */
  onBoundary?: () => void;
  /**
   * Overview map (L0): the province under the pointer (client px relative to
   * the viewer), null when none / the map is not up.
   */
  onMapHover?: (hover: { pick: OverviewPick; x: number; y: number } | null) => void;
  /** A click on open ground in the city view (nothing picked there): where it landed. */
  onGroundClick?: (at: LonLat) => void;
}

/** Douglas–Peucker tolerance of the work area's rings (m): provinces have tens of thousands of vertices. */
const BOUNDARY_SIMPLIFY_M = 60;
/** Longest wall segment (m): the wall's foot follows the terrain between ring vertices. */
const BOUNDARY_SEGMENT_M = 250;
/** How far inside the boundary the camera is pulled back to (m). */
const BOUNDARY_MARGIN_M = 30;
/** Least time between two boundary notices (ms). */
const BOUNDARY_NOTICE_MS = 4000;
/** Least time between two re-samplings of the wall's foot while tiles stream (ms). */
const BOUNDARY_GROUND_MS = 1500;
/** The overview map (L0) fades in over the city between these camera heights (m over the map). */
const MAP_FADE_FROM = 9000;
const MAP_FADE_TO = 14000;
/** Farthest the orbit camera goes (m): the whole country on the overview map. */
const MAP_MAX_DISTANCE = 2_600_000;
/** Steepest orbit view (rad from straight down) in the city and over the full map. */
const ORBIT_MAX_POLAR = 1.43;
const MAP_MAX_POLAR = 0.95;
/** Where a click on a province brings the camera (m from its target). */
const PROVINCE_ENTRY_DISTANCE = 1800;
/** Live class drawn on the overview map as earthquakes (zone rings, arc to the city). */
const QUAKE_CLASS = 'hazard.earthquake';
/** The overview map's quakes are refreshed from the feeds this often (ms). */
const MAP_QUAKES_MS = 500;

/** What the transform gizmo does to a placed model (W / E / R, as in Unreal). */
export type PlacementGizmoMode = 'translate' | 'rotate' | 'scale';

/** Where a model ended up after a gizmo drag (CityPlacementInput fields). */
export interface PlacementTransform {
  lon: number;
  lat: number;
  heading: number;
  scale: number;
  /** Null while the model stands on the terrain (moved only on the ground). */
  altitude: number | null;
}

/** Keys the gizmo takes from the camera while it is shown. */
const GIZMO_KEYS: ReadonlySet<string> = new Set(['KeyW', 'KeyE', 'KeyR']);

const isTypingIn = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
};

/** Sky box side (m): its corners (√3 / 2 of it) stay inside the 70 km far plane. */
const SKY_SIZE = 60000;

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

/** Work slower than this (ms) is logged in debugSlow. */
const SLOW_MS = 100;

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
  /** Reach of the sharp (first) shadow cascade, metres. */
  private csmNear = CSM_NEAR_REACH;
  private readonly hemi = new THREE.HemisphereLight(0xbfd6ff, 0x5b5a48, 1.1);
  private readonly sky = new SkyMesh();
  /** Behind everything (never black): the haze colour. */
  private readonly skyFallback = new THREE.Color(0xb9c9d8);
  /** Sky copy rendered into a PMREM environment map for image-based lighting. */
  private readonly envSky = new SkyMesh();
  private readonly envScene = new THREE.Scene();
  private readonly pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.RenderTarget | null = null;
  private envTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly mats: DtMaterials;
  private readonly fogUniforms = {
    near: uniform(1300),
    far: uniform(5200),
    color: uniform(new THREE.Color(0xb9c9d8)),
    /** Ground height at the camera target: the fog thins above it. */
    ground: uniform(0),
  };
  /** Land and sea beyond the loaded tiles (horizon.ts), once its grid arrived. */
  private horizon: HorizonLayer | null = null;
  /** Geographic centre of the horizon grid. */
  private horizonAt: LonLat | null = null;

  /** The city's work area as given (GeoJSON), its outer rings ([lon, lat]). */
  private boundaryInput: unknown = null;
  private boundaryRings: [number, number][][] | null = null;
  /**
   * The work area in the world's UTM zone, in metres from an anchor (whole km):
   * its index (inside tests, nearest point) and wall. Rebuilt only when the
   * zone changes; a moved world origin only moves the wall.
   */
  private boundary: {
    zone: number;
    anchorE: number;
    anchorN: number;
    index: PolygonIndex;
    wall: BoundaryWall;
  } | null = null;
  /** Zone the boundary was last built for (also when nothing of it fell in that zone). */
  private boundaryZone: number | null = null;
  private boundaryGroundDirty = false;
  private boundaryGroundAt = 0;
  /** Where the clamp last found the camera inside (skips the test while nothing moved). */
  private readonly boundaryChecked = new THREE.Vector3(Number.NaN, 0, 0);
  private boundaryPulling = false;
  /** The orbit target was last found outside the work area. */
  private targetOutside = false;
  private boundaryNoticeAt = -Infinity;
  /** Tiles the tile service reported outside the work area (red hatch on the horizon). */
  private outsideTiles = new Set<string>();

  /** Ground pictures of the loaded tiles (ground-atlas.ts). */
  private readonly groundAtlas: GroundAtlas;
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
  private scenarioColor: ScenarioPaintOf | null = null;
  /** The selected building (its source identity, shared by its split parts and tile copies). */
  private selectedKey: string | null = null;
  /** Matched / total buildings per tile under the active scenario. */
  private readonly scenarioCounts = new Map<string, TileScenarioCount>();
  /** Painted buildings of each loaded tile (scenario lists / navigation). */
  private readonly scenarioHits = new Map<string, { info: BuildingInfo; paint: ScenarioPaint }[]>();
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
  private debugFlags = { post: true, shadows: true, ao: true, drape: false };
  /** The ground as one picture (D-011, F3; behind the `drape` flag while it is measured). */
  private clipmap: GroundClipmap | null = null;
  /** Street names (the map look). */
  private readonly streetLabeller = new StreetLabeller();
  /** Point-of-interest icons (the map look), after the street names. */
  private readonly poiLabeller = new PoiLabeller();
  private drapedKey = '';
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
      // Out to the horizon's mountains (±50 km).
      70000,
    );
    this.mats = createMaterials();
    this.groundAtlas = new GroundAtlas(renderer);
    this.mats.groundAtlas.value = this.groundAtlas.texture;

    // Sky, light, fog.
    // A box round the camera (it follows it each frame), its corners inside the
    // far plane: a 12 km box at the world origin was left behind once the
    // camera went 6 km out, and the sky turned black (2026-10-13).
    this.sky.scale.setScalar(SKY_SIZE);
    this.sky.frustumCulled = false;
    this.sky.turbidity.value = 2.6;
    this.sky.rayleigh.value = 1.1;
    this.sky.mieCoefficient.value = 0.004;
    this.sky.mieDirectionalG.value = 0.8;
    this.sky.cloudCoverage.value = 0.42;
    this.sky.cloudDensity.value = 0.5;
    // The dome is far beyond the fog's far distance: fogged, it renders flat grey.
    (this.sky.material as THREE.NodeMaterial).fog = false;
    this.scene.add(this.sky);
    this.scene.background = this.skyFallback;
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
    // The fog drawn is a node over `scene.fog`'s values (still set by the
    // camera and the time of day): the same range fog, thinning with height
    // above the ground in view, so far mountains read through the haze that
    // hides the end of the loaded tiles at street level.
    this.scene.fogNode = fog(
      this.fogUniforms.color,
      rangeFogFactor(this.fogUniforms.near, this.fogUniforms.far).mul(
        mix(
          float(0.35),
          float(1),
          exp(positionWorld.y.sub(this.fogUniforms.ground).max(0).div(-350)),
        ),
      ),
    );

    this.sun.castShadow = true;
    let shadowMode = 'csm';
    try {
      shadowMode = localStorage.getItem('dtShadows') ?? 'csm';
    } catch {
      // Storage blocked: default.
    }
    if (shadowMode !== 'box') {
      // Two cascades: a sharp one around the focus (`csmNear` metres) and one
      // out to where the haze swallows the city. Surfaces past the last cascade
      // come out dark, so it must reach the fog's end; one cascade stretched
      // that far lost the street-level shadows (measured 2026-10-09).
      const csm = new CSMShadowNode(this.sun, {
        cascades: 2,
        maxFar: CSM_COVER_MIN,
        mode: 'custom',
        lightMargin: 300,
      });
      csm.customSplitsCallback = (_n, _near, far, breaks) => {
        breaks.push(Math.min(0.9, this.csmNear / far), 1);
      };
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
    // Plain open land of the region (no ground picture; coloured with the climate).
    backdrop.geometry.setAttribute(
      'gslot',
      new THREE.BufferAttribute(
        new Float32Array(backdrop.geometry.attributes.position.count).fill(-1),
        1,
      ),
    );
    backdrop.name = 'backdrop';
    this.scene.add(backdrop);
    this.scene.add(this.vehicles.group);
    this.scene.add(this.live.group);
    this.scene.add(this.placements.group);
    this.sea = backdrop;

    this.controls = new MapControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = ORBIT_MAX_POLAR;
    this.controls.minDistance = 12;
    // Out to the whole country: above MAP_FADE_FROM the overview map comes up.
    this.controls.maxDistance = MAP_MAX_DISTANCE;
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
      (x, y) => this.groundAt(x, y),
    );

    // Transform gizmo for the selected placed model (shown only to editors).
    this.gizmo = new TransformControls(this.camera, renderer.domElement);
    this.gizmo.setSpace('world');
    this.gizmo.setSize(1.4);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value;
    });
    this.gizmo.addEventListener('mouseDown', () => {
      const o = this.gizmo.object;
      if (o) this.gizmoStart = { y: o.position.y, scale: o.scale.x };
    });
    this.gizmo.addEventListener('objectChange', () => this.constrainGizmo());
    this.gizmo.addEventListener('mouseUp', () => this.commitGizmo());
    this.scene.add(this.gizmo.getHelper());
    window.addEventListener('keydown', this.onGizmoKey);
    window.addEventListener('keyup', this.onGizmoKeyUp);

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
    renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    renderer.domElement.addEventListener('pointerleave', this.onPointerLeave);
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
    const t0 = performance.now();
    try {
      return this.addTileNow(key, payload, level);
    } finally {
      this.logSlow('tile', performance.now() - t0, { key });
    }
  }

  /**
   * Development aid: work that took over SLOW_MS (frames by phase, tile
   * assembly), the last 60 — what a stutter was spent on.
   */
  readonly debugSlow: { at: number; kind: string; ms: number; parts?: Record<string, unknown> }[] =
    [];

  private logSlow(kind: string, ms: number, parts?: Record<string, unknown>): void {
    if (ms < SLOW_MS) return;
    this.debugSlow.push({ at: Math.round(performance.now()), kind, ms: Math.round(ms), parts });
    if (this.debugSlow.length > 60) this.debugSlow.shift();
  }

  private addTileNow(key: string, payload: TilePayload, level: TileLevel): boolean {
    const { frame, bounds } = payload.summary;
    if (frame) {
      if (!this.world) {
        this.world = { zone: frame.zone, originE: frame.originE, originN: frame.originN };
        this.updateClimate();
        this.live.relocate();
      } else if (this.tiles.size === 0) {
        // Floating origin: after a long jump every old tile is gone; re-anchor the
        // world at this tile so coordinates stay small (float32 on the GPU).
        this.rebase(frame);
        this.live.relocate();
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
      payload.ground ? this.groundAtlas.add(payload.ground) : -1,
    );
    this.horizon?.setTile(key, 'loaded');
    this.boundaryGroundDirty = true;
    // Always written: a reused slot must not keep a previous building's colour / selection.
    const painted = this.paintScenario(tile);
    if (this.scenarioColor) {
      this.scenarioCounts.set(key, painted);
      this.scenarioHits.set(key, painted.hits);
    }
    if (this.mode !== 'showcase') tile.setMode(this.mode);
    if (this.showFixes) tile.setShowFixes(true);
    if (this.underground.size) tile.setUnderground(this.underground);
    if (this.mapLook) tile.setPlain(true);
    const eye = this.rig.lodEye(this.lodEye);
    tile.updateDetail(eye, Math.max(0, eye.y - this.heightAt(eye.x, -eye.z)));
    this.tiles.set(key, tile);
    this.scene.add(tile.group);
    this.placeBackdrop();
    this.emitUtilities();
    // Ground heights / building tops of states on this tile are known now.
    if (this.cityStates.length) this.rebuildCityStates();
    if (this.placementList.length) this.rebuildPlacements();
    if (this.vehicleList.length) this.setVehicles(this.vehicleList);
    this.live.groundChanged();
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

  /**
   * Whether the horizon should be (re)loaded for a view at `at`: none yet, or
   * the camera has gone more than 25 km from its centre (it reaches ±50 km).
   */
  needsHorizon(at: LonLat): boolean {
    if (!this.world) return false;
    if (!this.horizon || !this.horizonAt) return true;
    const dLat = (at.lat - this.horizonAt.lat) * 111;
    const dLon = (at.lon - this.horizonAt.lon) * 111 * Math.cos((at.lat * Math.PI) / 180);
    return Math.hypot(dLat, dLon) > 25;
  }

  /** Tiles being compiled on the server or meshed here (hatched on the horizon). */
  private pendingTiles = new Set<string>();

  /** Marks the tiles in `keys` as on their way (the others in view drop the mark). */
  setPendingTiles(keys: Iterable<string>): void {
    const next = new Set(keys);
    for (const key of this.pendingTiles)
      if (!next.has(key) && !this.tiles.has(key)) this.horizon?.setTile(key, 'none');
    for (const key of next) if (!this.tiles.has(key)) this.horizon?.setTile(key, 'pending');
    this.pendingTiles = next;
  }

  /** The land beyond the loaded tiles, from a coarse DEM grid around `at`. */
  setHorizon(grid: GeoTerrainGrid, at: LonLat): void {
    if (!this.world) return;
    this.horizon?.mesh.removeFromParent();
    this.horizon?.dispose();
    this.horizon = new HorizonLayer(grid, this.world, this.mats.openLand);
    this.horizonAt = at;
    for (const key of this.pendingTiles) this.horizon.setTile(key, 'pending');
    for (const key of this.tiles.keys()) this.horizon.setTile(key, 'loaded');
    this.horizon.setOutsideTiles(this.outsideTiles);
    this.applyRestricted();
    this.boundaryGroundDirty = true;
    this.scene.add(this.horizon.mesh);
  }

  // ─── Overview map (L0) ──────────────────────────────────────────────────────

  private overviewData: OverviewData | null = null;
  private overview: OverviewMap | null = null;
  /** Height of the overview map (m): the city's ground at the target when the map came up. */
  private mapY = 0;
  /** 0 … 1: how far the overview map has come up over the city. */
  private mapK = 0;
  /** City objects hidden while the full map covers them (shown again on the way down). */
  private mapHidden: THREE.Object3D[] = [];
  /** Pointer over the viewer (client px), picked on the map once a frame. */
  private mapPointer: { x: number; y: number } | null = null;
  private mapPointerDirty = false;
  private mapHoverCode: number | null = null;
  /** Earthquakes on the overview map (in its group). */
  private quakes: QuakeOverlay | null = null;
  private quakesAt = 0;

  /** Country map data (Natural Earth, /dt/l0/turkey.json); null removes the map. */
  setOverviewData(data: OverviewData | null): void {
    this.overviewData = data;
    this.overview?.dispose();
    this.overview = null;
    this.quakes = null;
  }

  /** The full overview map covers the city (L0, the camera high above it). */
  get mapMode(): boolean {
    return this.mapK >= 0.999;
  }

  /** The map for the world's zone and work area, built when missing. */
  private syncOverview(): OverviewMap | null {
    if (!this.overviewData || !this.world) return null;
    if (this.overview && this.overview.zone === this.world.zone) return this.overview;
    this.overview?.dispose();
    const area = this.boundaryRings?.map((ring) => [ring as [number, number][]]) ?? null;
    const m = new OverviewMap(this.overviewData, this.world.zone, area);
    this.overview = m;
    this.quakes = new QuakeOverlay(m.project, m.mpp, m.fade);
    this.quakesAt = 0;
    m.group.add(this.quakes.group);
    this.scene.add(m.group);
    return m;
  }

  /**
   * Per frame: the map faded in with the camera's height, placed for the
   * origin, its lines and names scaled; the city hidden under the full map;
   * camera limits for the map (tilt, extent, no coming down outside the city).
   */
  private tickMap(): void {
    const m = this.syncOverview();
    if (!m || !this.world) {
      this.mapK = 0;
      return;
    }
    const cam = this.camera.position;
    const t = this.controls.target;
    if (this.mapK === 0) this.mapY = t.y;
    const k = THREE.MathUtils.smoothstep(cam.y - this.mapY, MAP_FADE_FROM, MAP_FADE_TO);
    this.mapK = k;
    m.setFade(k);
    m.group.position.set(
      m.anchorE - this.world.originE,
      this.mapY,
      -(m.anchorN - this.world.originN),
    );
    const dist = cam.distanceTo(t);
    const mpp =
      (dist * 2 * Math.tan((this.camera.fov * Math.PI) / 360)) /
      Math.max(1, this.container.clientHeight);
    m.setScale(mpp, mpp * 1.5);
    if (k > 0) m.declutter(this.camera, this.container.clientWidth, this.container.clientHeight);
    if (this.quakes && k > 0) {
      const now = performance.now();
      if (now - this.quakesAt > MAP_QUAKES_MS) {
        this.quakesAt = now;
        const selected = this.live.selectedKey;
        this.quakes.update(
          this.live.ofClass(QUAKE_CLASS).map(({ key, view }) => ({
            key,
            lon: view.lon,
            lat: view.lat,
            magnitude:
              typeof view.attrs?.magnitude === 'number' && Number.isFinite(view.attrs.magnitude)
                ? view.attrs.magnitude
                : null,
          })),
          selected,
          this.cityPoint(),
        );
      }
      this.quakes.setScale(mpp, mpp * 1.5);
    }
    // Far plane out past the map's far edge.
    const far = Math.max(70000, dist * 4);
    if (Math.abs(far - this.camera.far) > this.camera.far * 0.1) {
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    this.hideCity(k >= 0.999, m);
    if (this.rig.mode === 'orbit') {
      this.controls.maxPolarAngle = THREE.MathUtils.lerp(ORBIT_MAX_POLAR, MAP_MAX_POLAR, k);
      // Outside the city the camera stays over the map.
      const up = Math.max(0.2, (cam.y - t.y) / Math.max(dist, 1));
      this.controls.minDistance =
        this.targetOutside && this.boundary ? (MAP_FADE_TO + this.mapY - t.y) / up : 12;
      if (k > 0) this.keepOverMap(m);
    }
    if (this.mapPointerDirty) {
      this.mapPointerDirty = false;
      this.hoverMap();
    } else if (!this.mapMode && this.mapHoverCode !== null) this.hoverMap();
  }

  /**
   * The tenant's city on the overview map: the capital of the province its
   * work area covers, else a point inside the work area.
   */
  private cityPoint(): QuakeCity | null {
    const m = this.overview;
    const p = m?.data.provinces.find((pr) => m.provinceHasData(pr.code));
    if (p) return { name: p.name, at: p.capital };
    const inner = this.boundaryRings ? interiorPoint(this.boundaryRings) : null;
    return inner ? { name: '', at: [inner[0], inner[1]] } : null;
  }

  /** Whether a lon/lat point lies outside the work area (false without one). */
  private outsideWorkArea(lon: number, lat: number): boolean {
    const b = this.boundary;
    if (!b) return false;
    const [e, n] = utmForward(lon, lat, b.zone);
    return !b.index.contains(e - b.anchorE, n - b.anchorN);
  }

  /** The orbit target kept over the map's extent (the camera moved with it). */
  private keepOverMap(m: OverviewMap): void {
    const t = this.controls.target;
    const [w, s, e, n] = m.extent;
    const x = t.x - (m.anchorE - this.world!.originE);
    const y = -t.z - (m.anchorN - this.world!.originN);
    const dx = THREE.MathUtils.clamp(x, w, e) - x;
    const dy = THREE.MathUtils.clamp(y, s, n) - y;
    if (dx === 0 && dy === 0) return;
    t.x += dx;
    t.z -= dy;
    this.camera.position.x += dx;
    this.camera.position.z -= dy;
  }

  /** Hides the city's own objects under the full map (lights, sky, live objects stay). */
  private hideCity(on: boolean, m: OverviewMap): void {
    if (!on) {
      for (const o of this.mapHidden) o.visible = true;
      this.mapHidden = [];
      return;
    }
    for (const o of this.scene.children) {
      if (!o.visible || o === m.group || o === this.live.group || o === this.sky) continue;
      if ((o as THREE.Light).isLight) continue;
      o.visible = false;
      this.mapHidden.push(o);
    }
  }

  /** The province under the pointer on the full map (highlight + event). */
  private hoverMap(): void {
    const p = this.mapPointer;
    const pick = this.mapMode && p ? this.mapPickAt(p.x, p.y) : null;
    this.overview?.setHover(pick?.code ?? null);
    this.mapHoverCode = pick?.code ?? null;
    if (!pick || !p) {
      this.events.onMapHover?.(null);
      return;
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.events.onMapHover?.({ pick, x: p.x - rect.left, y: p.y - rect.top });
  }

  /** The province at a client point on the overview map. */
  private mapPickAt(clientX: number, clientY: number): OverviewPick | null {
    const m = this.overview;
    if (!m || !this.world) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ray = allLayersRay();
    ray.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      ),
      this.camera,
    );
    const hit = ray.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.mapY),
      new THREE.Vector3(),
    );
    if (!hit) return null;
    const { lon, lat } = utmInverse(
      this.world.originE + hit.x,
      this.world.originN - hit.z,
      this.world.zone,
    );
    return m.pick(lon, lat);
  }

  /**
   * Down into a province's city: its capital when the work area holds it,
   * else the work-area point nearest to it; the camera flies there from the map.
   */
  private enterProvince(pick: OverviewPick): void {
    if (!this.world) return;
    let [lon, lat] = pick.capital;
    const b = this.boundary;
    if (b) {
      const [e, n] = utmForward(lon, lat, b.zone);
      const x = e - b.anchorE;
      const y = n - b.anchorN;
      if (!b.index.contains(x, y)) {
        const q = b.index.inwardPoint(x, y, 500);
        if (q) ({ lon, lat } = utmInverse(q[0] + b.anchorE, q[1] + b.anchorN, b.zone));
      }
    }
    const at = this.worldOf(lon, lat);
    if (!at) return;
    const z = this.heightAt(at[0], at[1]) || this.mapY;
    const target = new THREE.Vector3(...toThree(at[0], at[1], z));
    const dir = this.camera.position.clone().sub(this.controls.target);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize().multiplyScalar(Math.cos((50 * Math.PI) / 180));
    dir.y = Math.sin((50 * Math.PI) / 180);
    this.targetOutside = false;
    this.controls.minDistance = 12;
    this.fly = {
      from: [this.camera.position.clone(), this.controls.target.clone()],
      to: [target.clone().add(dir.multiplyScalar(PROVINCE_ENTRY_DISTANCE)), target],
      t: 0,
    };
  }

  private readonly onPointerMove = (e: PointerEvent) => {
    this.mapPointer = { x: e.clientX, y: e.clientY };
    if (this.mapK > 0) this.mapPointerDirty = true;
  };

  private readonly onPointerLeave = () => {
    this.mapPointer = null;
    this.mapPointerDirty = true;
  };

  // ─── City boundary (work area) ─────────────────────────────────────────────

  /**
   * The city's work area (GeoJSON Polygon / MultiPolygon, EPSG:4326; null
   * clears it): a wall of light along its outer rings, the camera kept
   * inside, the land outside hatched red on the horizon. Applied once the
   * world frame is known (the first tile), in the world's UTM zone — ring
   * points of another zone are skipped.
   */
  setCityBoundary(geometry: unknown): void {
    if (geometry === this.boundaryInput) return;
    this.boundaryInput = geometry;
    const rings = geometry ? outerRings(geometry) : [];
    this.boundaryRings = rings.length ? rings : null;
    this.dropBoundary();
    this.outsideTiles = new Set();
    this.horizon?.setOutsideTiles(this.outsideTiles);
    this.syncBoundary();
    // Provinces with data follow the work area.
    this.overview?.dispose();
    this.overview = null;
    this.quakes = null;
  }

  /** Tiles the tile service reported outside the work area (kept until the boundary changes). */
  markOutsideTiles(keys: Iterable<string>): void {
    for (const key of keys) {
      if (this.outsideTiles.has(key)) continue;
      this.outsideTiles.add(key);
      this.horizon?.setTile(key, 'restricted');
    }
  }

  private dropBoundary(): void {
    this.boundary?.wall.dispose();
    this.boundary = null;
    this.boundaryZone = null;
    this.boundaryPulling = false;
    this.boundaryChecked.set(Number.NaN, 0, 0);
    this.horizon?.setRestricted(null);
  }

  /** Builds the boundary for the world's zone when needed and places its wall for the origin. */
  private syncBoundary(): void {
    if (!this.boundaryRings || !this.world) return;
    const world = this.world;
    if (this.boundaryZone !== world.zone) {
      this.dropBoundary();
      this.boundaryZone = world.zone;
      let anchor: [number, number] | null = null;
      const rings: FlatRing[] = [];
      for (const ring of this.boundaryRings) {
        const flat: FlatRing = [];
        for (const [lon, lat] of ring) {
          if (utmZoneOf(lon) !== world.zone) continue;
          const [e, n] = utmForward(lon, lat, world.zone);
          anchor ??= [Math.floor(e / 1000) * 1000, Math.floor(n / 1000) * 1000];
          flat.push(e - anchor[0], n - anchor[1]);
        }
        // GeoJSON repeats the first point at the end.
        const k = flat.length;
        if (k >= 4 && flat[0] === flat[k - 2] && flat[1] === flat[k - 1]) flat.length = k - 2;
        if (flat.length >= 6) rings.push(simplifyRing(flat, BOUNDARY_SIMPLIFY_M));
      }
      if (!anchor || !rings.length) return;
      const wall = new BoundaryWall(rings.map((r) => densifyRing(r, BOUNDARY_SEGMENT_M)));
      this.boundary = {
        zone: world.zone,
        anchorE: anchor[0],
        anchorN: anchor[1],
        index: new PolygonIndex(rings),
        wall,
      };
      this.scene.add(wall.mesh);
      this.boundaryGroundDirty = true;
      this.boundaryGroundAt = 0;
      this.applyRestricted();
    }
    const b = this.boundary;
    if (!b) return;
    b.wall.mesh.position.set(...toThree(b.anchorE - world.originE, b.anchorN - world.originN, 0));
  }

  /** Horizon cells whose centre lies outside the work area are hatched red. */
  private applyRestricted(): void {
    const b = this.boundary;
    const h = this.horizon;
    if (!h) return;
    if (!b || h.world.zone !== b.zone) {
      h.setRestricted(null);
      return;
    }
    h.setRestricted((e, n) => !b.index.contains(e - b.anchorE, n - b.anchorN));
  }

  /**
   * The wall's foot on the ground: a loaded tile's terrain where there is one,
   * else the horizon's coarse heights, else the ground at the camera target.
   */
  private groundBoundary(): void {
    const b = this.boundary;
    if (!b || !this.world) return;
    const world = this.world;
    const fallback = this.controls.target.y;
    b.wall.setGround((ax, ay) => {
      const e = b.anchorE + ax;
      const n = b.anchorN + ay;
      const tile = this.tiles.get(tileKey(b.zone, Math.floor(e / 1000), Math.floor(n / 1000)));
      const h = tile?.heightAt(e - world.originE, n - world.originN);
      if (h !== null && h !== undefined) return h;
      return this.horizon?.heightAtUtm(e, n) ?? fallback;
    });
  }

  /**
   * Keeps the camera inside the work area: the orbit target (street / fly:
   * the camera) found outside is pulled back — camera and target by the same
   * amount — towards a point just inside the nearest boundary, eased like
   * running into a wall. Tested only when it moved.
   */
  private clampToBoundary(dt: number): void {
    const b = this.boundary;
    if (!b || !this.world || this.fly) return;
    const own = this.rig.mode === 'street' || this.rig.mode === 'fly';
    const p = own ? this.camera.position : this.controls.target;
    if (!this.boundaryPulling && this.boundaryChecked.distanceToSquared(p) < 0.01) return;
    const e = this.world.originE + p.x - b.anchorE;
    const n = this.world.originN - p.z - b.anchorN;
    if (b.index.contains(e, n)) {
      this.boundaryChecked.copy(p);
      this.boundaryPulling = false;
      this.targetOutside = false;
      return;
    }
    this.targetOutside = true;
    // Over the overview map the camera roams the country; outside the city it
    // cannot come down below the map (tickMap keeps it up there).
    if (this.overview && this.camera.position.y - this.mapY >= MAP_FADE_TO * 0.98) {
      this.boundaryChecked.copy(p);
      this.boundaryPulling = false;
      return;
    }
    const goal = b.index.inwardPoint(e, n, BOUNDARY_MARGIN_M);
    if (!goal) return;
    const [dx, dy] = clampStep([e, n], goal, dt);
    // three: x east, z south.
    this.camera.position.x += dx;
    this.camera.position.z -= dy;
    this.controls.target.x += dx;
    this.controls.target.z -= dy;
    this.boundaryChecked.copy(p);
    this.boundaryPulling = true;
    this.controls.dispatchEvent({ type: 'change' });
    const now = performance.now();
    if (now - this.boundaryNoticeAt > BOUNDARY_NOTICE_MS) {
      this.boundaryNoticeAt = now;
      this.events.onBoundary?.();
    }
  }

  /** Per frame: the wall placed for the origin, its foot re-sampled after tiles came, its fade, the clamp. */
  private tickBoundary(dt: number): void {
    if (!this.boundaryRings) return;
    this.syncBoundary();
    const b = this.boundary;
    if (!b) return;
    const now = performance.now();
    if (this.boundaryGroundDirty && now - this.boundaryGroundAt > BOUNDARY_GROUND_MS) {
      this.boundaryGroundDirty = false;
      this.boundaryGroundAt = now;
      this.groundBoundary();
    }
    this.clampToBoundary(dt);
    const c = this.camera.position;
    b.wall.setCameraHeight(c.y - this.heightAt(c.x, -c.z));
  }

  /** The backdrop beyond the loaded tiles in the region's open-land colour (climate.ts). */
  private updateClimate(): void {
    if (!this.world) return;
    const at = utmInverse(this.world.originE, this.world.originN, this.world.zone);
    this.mats.openLand.value.setRGB(...openLandAlbedo(at.lon, at.lat));
  }

  /** Moves the world origin to `frame`, keeping the camera where it is on the ground. */
  private rebase(frame: { zone: number; originE: number; originN: number }): void {
    // The horizon mesh is in the old origin's coordinates: dropped, loaded again.
    this.horizon?.mesh.removeFromParent();
    this.horizon?.dispose();
    this.horizon = null;
    this.horizonAt = null;
    const world = this.world!;
    if (frame.zone !== world.zone) {
      // Another UTM zone: camera position has no meaning there; the next view sets it.
      this.world = { zone: frame.zone, originE: frame.originE, originN: frame.originN };
      this.placed = false;
      this.updateClimate();
      return;
    }
    const dx = frame.originE - world.originE;
    const dy = frame.originN - world.originN;
    this.world = { zone: frame.zone, originE: frame.originE, originN: frame.originN };
    this.updateClimate();
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
    this.groundAtlas.release(tile.groundSlot);
    this.horizon?.setTile(key, this.pendingTiles.has(key) ? 'pending' : 'none');
    this.boundaryGroundDirty = true;
    tile.dispose();
    this.tiles.delete(key);
    this.scenarioCounts.delete(key);
    this.scenarioHits.delete(key);
    this.emitUtilities();
    this.live.groundChanged();
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

  /** Ground height at a world point: a loaded tile's, else the horizon's (null beyond both). */
  groundAt(x: number, y: number): number | null {
    for (const tile of this.tiles.values()) {
      const h = tile.heightAt(x, y);
      if (h !== null) return h;
    }
    return this.horizonHeightAt(x, y);
  }

  /** Ground height at a world point (0 beyond the loaded tiles and the horizon). */
  heightAt(x: number, y: number): number {
    return this.groundAt(x, y) ?? 0;
  }

  /**
   * The horizon's coarse heights where no tile is loaded (not built yet, or
   * beyond the boundary): the camera is kept above the ground drawn there.
   */
  private horizonHeightAt(x: number, y: number): number | null {
    if (!this.world || !this.horizon) return null;
    return this.horizon.heightAtUtm(this.world.originE + x, this.world.originN + y);
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

  /**
   * The camera for tile planning: its ground position (UTM metres in the
   * world's zone), height above the ground, and the compass heading and pitch
   * (degrees below the horizon) it looks along. Null before the first tile.
   */
  eyeView(): {
    zone: number;
    e: number;
    n: number;
    height: number;
    heading: number;
    pitch: number;
  } | null {
    if (!this.world) return null;
    const p = this.camera.position;
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    const flat = Math.hypot(dir.x, dir.z);
    return {
      zone: this.world.zone,
      e: this.world.originE + p.x,
      n: this.world.originN - p.z,
      height: p.y - this.heightAt(p.x, -p.z),
      // three: x east, z south.
      heading: ((Math.atan2(dir.x, -dir.z) * 180) / Math.PI + 360) % 360,
      pitch: (Math.atan2(-dir.y, flat) * 180) / Math.PI,
    };
  }

  /** World model coordinates of a geographic point (requires the world frame). */
  worldOf(lon: number, lat: number): [number, number] | null {
    if (!this.world || utmZoneOf(lon) !== this.world.zone) return null;
    const [e, n] = utmForward(lon, lat, this.world.zone);
    return [e - this.world.originE, n - this.world.originN];
  }

  private level: DetailLevel = 3;
  private levelCandidate: { level: DetailLevel; since: number } | null = null;
  private readonly levelListeners = new Set<(level: DetailLevel) => void>();

  /** Detail level (L1 over the city … L5 street) from the camera's height above the ground. */
  get detailLevel(): DetailLevel {
    return this.level;
  }

  /** Subscribes to detail level changes (the tile plan follows them). */
  onDetailLevel(cb: (level: DetailLevel) => void): () => void {
    this.levelListeners.add(cb);
    return () => this.levelListeners.delete(cb);
  }

  private updateDetail(): void {
    const eye = this.rig.lodEye(this.lodEye);
    // Height above the ground: detail falls off with the 3D distance, and
    // the level (tiles to load) follows it, held LEVEL_DWELL_MS first.
    const height = Math.max(0, eye.y - this.heightAt(eye.x, -eye.z));
    const next = nextLevel(height, this.level);
    const now = performance.now();
    if (next === this.level) this.levelCandidate = null;
    else if (!this.levelCandidate || this.levelCandidate.level !== next)
      this.levelCandidate = { level: next, since: now };
    else if (now - this.levelCandidate.since >= LEVEL_DWELL_MS) {
      this.level = next;
      this.levelCandidate = null;
      this.levelListeners.forEach((cb) => cb(next));
    }
    for (const tile of this.tiles.values()) tile.updateDetail(eye, height);
    // Street wear (cracks, potholes, broken pavers) only at street height (L5).
    this.mats.streetDetail.value = 1 - THREE.MathUtils.smoothstep(height, 10, 14);
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
   * Colours building shells by a scenario: `paintOf` returns the building's
   * data colour and the scenario key it matched, or null when the scenario has
   * no value for it (pale clay). Null switches scenario colouring off.
   */
  setScenario(paintOf: ScenarioPaintOf | null): ScenarioSummary {
    this.scenarioColor = paintOf;
    this.mats.scenarioOn.value = paintOf ? 1 : 0;
    this.scenarioCounts.clear();
    this.scenarioHits.clear();
    for (const [key, tile] of this.tiles) {
      const c = this.paintScenario(tile);
      if (paintOf) {
        this.scenarioCounts.set(key, c);
        this.scenarioHits.set(key, c.hits);
      }
    }
    return this.scenarioSummary();
  }

  /** Buildings and scenario keys matched in the loaded tiles under the active scenario. */
  scenarioSummary(): ScenarioSummary {
    let matched = 0;
    let total = 0;
    const keys = new Set<string>();
    for (const c of this.scenarioCounts.values()) {
      matched += c.matched;
      total += c.total;
      for (const k of c.keys) keys.add(k);
    }
    return { matched, total, keys };
  }

  /**
   * Marks the selected building (glow on its shells, all of its parts); null
   * clears it. Works with or without a scenario.
   */
  setSelectedBuilding(building: BuildingInfo | null): void {
    const key = building ? buildingKey(building) : null;
    if (key === this.selectedKey) return;
    this.selectedKey = key;
    const data = this.mats.scenario.image.data as Uint8Array;
    for (const tile of this.tiles.values()) {
      this.eachSlot(tile, (info, k) => {
        const hasData = data[k + 3] >= 128;
        const sel = key !== null && !!info && buildingKey(info) === key;
        data[k + 3] = alphaOf(hasData, sel);
      });
    }
    this.mats.scenario.needsUpdate = true;
  }

  private eachSlot(tile: CityTile, fn: (info: BuildingInfo | undefined, texel: number) => void) {
    for (const layer of ['obs', 'syn'] as const) {
      const base = tile.slotBases[layer];
      if (base === null) continue;
      tile.slots[layer].forEach((id, i) => fn(tile.building(id), (base + i) * 4));
    }
  }

  /** Writes a tile's building colours (and the selection) into the scenario texture. */
  private paintScenario(tile: CityTile): TileScenarioCount & {
    hits: { info: BuildingInfo; paint: ScenarioPaint }[];
  } {
    const paintOf = this.scenarioColor;
    const data = this.mats.scenario.image.data as Uint8Array;
    let matched = 0;
    let total = 0;
    const keys = new Set<string>();
    const hits: { info: BuildingInfo; paint: ScenarioPaint }[] = [];
    this.eachSlot(tile, (info, k) => {
      const paint = info && paintOf ? paintOf(info) : null;
      const sel = this.selectedKey !== null && !!info && buildingKey(info) === this.selectedKey;
      total++;
      if (paint) {
        matched++;
        keys.add(`${paint.overlay}|${paint.key}`);
        if (info) hits.push({ info, paint });
        data[k] = Math.round(paint.color.r * 255);
        data[k + 1] = Math.round(paint.color.g * 255);
        data[k + 2] = Math.round(paint.color.b * 255);
      } else {
        data[k] = data[k + 1] = data[k + 2] = 0;
      }
      data[k + 3] = alphaOf(!!paint, sel);
    });
    this.mats.scenario.needsUpdate = true;
    return { matched, total, keys, hits };
  }

  /** Lon / lat box of a tile-local box. */
  private lonLatBox(tile: CityTile, [x0, y0, x1, y1]: BuildingInfo['box']): DtBox | null {
    if (!this.world) return null;
    const [ox, oy] = this.offsetOf(tile.summary);
    const a = utmInverse(
      this.world.originE + ox + x0,
      this.world.originN + oy + y0,
      this.world.zone,
    );
    const b = utmInverse(
      this.world.originE + ox + x1,
      this.world.originN + oy + y1,
      this.world.zone,
    );
    return [a.lon, a.lat, b.lon, b.lat];
  }

  /**
   * The buildings the active scenario painted in the loaded tiles, one entry
   * per source building (its split parts and copies in neighbouring tiles
   * merged): identity, the scenario key / colour, and its lon / lat box.
   */
  scenarioBuildings(): ScenarioBuilding[] {
    const out = new Map<string, ScenarioBuilding>();
    for (const [tileKey, hits] of this.scenarioHits) {
      const tile = this.tiles.get(tileKey);
      if (!tile) continue;
      for (const { info, paint } of hits) {
        const box = this.lonLatBox(tile, info.box);
        if (!box) continue;
        const id = buildingKey(info);
        const prev = out.get(id);
        if (prev) prev.box = unionBox(prev.box, box);
        else out.set(id, { id, info, paint, box });
      }
    }
    return [...out.values()];
  }

  /**
   * Lon / lat box of a building — all of its parts in every loaded tile —
   * or null when it is not loaded.
   */
  buildingBox(building: BuildingInfo): DtBox | null {
    const key = buildingKey(building);
    let box: DtBox | null = null;
    for (const tile of this.tiles.values()) {
      for (const layer of ['obs', 'syn'] as const) {
        for (const id of tile.slots[layer]) {
          const info = tile.building(id);
          if (!info || buildingKey(info) !== key) continue;
          const b = this.lonLatBox(tile, info.box);
          if (b) box = box ? unionBox(box, b) : b;
        }
      }
    }
    return box;
  }

  /** Flies to a building, framed with some of its surroundings. */
  focusBuilding(building: BuildingInfo): boolean {
    const box = this.buildingBox(building) ?? null;
    if (!box) return false;
    this.flyToBounds(padBox(box, FOCUS_MIN_SPAN));
    return true;
  }

  private showFixes = false;

  /** Red overlay of what was cut off buildings (road / neighbour overlaps). */
  setShowFixes(on: boolean): void {
    this.showFixes = on;
    for (const tile of this.tiles.values()) tile.setShowFixes(on);
  }

  // ─── Placed models (prefabs, uploaded GLB) and facility interiors ─────────

  private readonly placements = new PlacementLayer();
  private placementList: CityPlacement[] = [];
  private loadModel: (assetId: string) => Promise<ArrayBuffer> | null = () => null;

  /** Placed models to draw; `loadModel` fetches an uploaded model's bytes (the host's session). */
  setPlacements(
    list: CityPlacement[],
    loadModel: (assetId: string) => Promise<ArrayBuffer> | null = this.loadModel,
  ): void {
    this.placementList = list;
    this.loadModel = loadModel;
    this.rebuildPlacements();
  }

  private rebuildPlacements(): void {
    // Not under a drag (a tile arriving rebuilt the models): it would snap back.
    if (this.gizmo.dragging) {
      this.gizmoRebuild = true;
      return;
    }
    this.placements.update(this.placementList, {
      worldOf: (lon, lat) => this.worldOf(lon, lat),
      heightAt: (x, y) => this.heightAt(x, y),
      loadModel: (id) => this.loadModel(id),
    });
    this.syncGizmo();
  }

  setSelectedPlacement(id: string | null): void {
    this.placements.setSelected(id);
    this.syncGizmo();
  }

  /** Shows a placement's facility interior floor by floor (null: closes it). */
  setPlacementInside(id: string | null, explode = 8): void {
    this.placements.setInside(id, explode);
    this.syncGizmo();
  }

  // ─── Transform gizmo ──────────────────────────────────────────────────────

  private readonly gizmo: TransformControls;
  /** Placement the gizmo is for (null: hidden). */
  private gizmoId: string | null = null;
  /** The model's height and scale when the current drag began. */
  private gizmoStart: { y: number; scale: number } | null = null;
  /** Lifted off the ground with the up handle in this session: its altitude is kept. */
  private gizmoLifted = false;
  /** Models changed under a drag: rebuilt when it ends. */
  private gizmoRebuild = false;
  /** Pointer went down on a gizmo handle (that click selects nothing). */
  private downOnGizmo = false;
  private readonly gizmoTransformCbs = new Set<(id: string, t: PlacementTransform) => void>();
  private readonly gizmoModeCbs = new Set<(mode: PlacementGizmoMode) => void>();

  /**
   * Shows the transform gizmo on a placed model (null: hides it). While it is
   * shown W / E / R switch move / rotate / scale (the camera leaves those
   * keys), Shift snaps (1 m, 15°, 0.1) and Esc lets go of the model.
   */
  setPlacementGizmo(id: string | null): void {
    if (id !== this.gizmoId) this.gizmoLifted = false;
    this.gizmoId = id;
    this.rig.blockedKeys = id ? GIZMO_KEYS : new Set();
    this.syncGizmo();
  }

  setGizmoMode(mode: PlacementGizmoMode): void {
    this.gizmo.setMode(mode);
    // Turning only about the vertical (a heading); moving and scaling on all axes.
    this.gizmo.showX = mode !== 'rotate';
    this.gizmo.showZ = mode !== 'rotate';
    for (const cb of this.gizmoModeCbs) cb(mode);
  }

  get gizmoMode(): PlacementGizmoMode {
    return this.gizmo.mode as PlacementGizmoMode;
  }

  /** Called with the model's new place, heading and scale whenever a gizmo drag ends. */
  onPlacementTransform(cb: (id: string, t: PlacementTransform) => void): () => void {
    this.gizmoTransformCbs.add(cb);
    return () => this.gizmoTransformCbs.delete(cb);
  }

  /** Called when the gizmo mode changes (keys or setGizmoMode). */
  onGizmoMode(cb: (mode: PlacementGizmoMode) => void): () => void {
    this.gizmoModeCbs.add(cb);
    return () => this.gizmoModeCbs.delete(cb);
  }

  /** Attaches the gizmo to the placement's current scene object (models are rebuilt often). */
  private syncGizmo(): void {
    if (this.gizmo.dragging) return;
    const root = this.gizmoId ? this.placements.rootOf(this.gizmoId) : null;
    if (root) {
      if (this.gizmo.object !== root) this.gizmo.attach(root);
    } else if (this.gizmo.object) {
      this.gizmo.detach();
    }
  }

  /** Keeps a drag to what a placement can express: ground or a set altitude, a heading, one scale. */
  private constrainGizmo(): void {
    const o = this.gizmo.object;
    const p = this.placementList.find((x) => x.id === this.gizmoId);
    if (!o || !p) return;
    if (this.gizmo.mode === 'translate') {
      if (this.gizmo.axis === 'Y') this.gizmoLifted = true;
      else if (!this.gizmoLifted && p.altitude === null)
        o.position.y = this.heightAt(o.position.x, -o.position.z);
      else if (this.gizmoStart) o.position.y = this.gizmoStart.y;
    } else if (this.gizmo.mode === 'rotate') {
      // The view-axis ring would tilt the model: keep only its turn about the vertical.
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(o.quaternion);
      o.rotation.set(0, Math.atan2(f.x, f.z), 0);
    } else {
      // One scale: the axis pulled furthest from where the drag began.
      const s0 = this.gizmoStart?.scale ?? 1;
      const s = [o.scale.x, o.scale.y, o.scale.z].reduce((a, b) =>
        Math.abs(b - s0) > Math.abs(a - s0) ? b : a,
      );
      o.scale.setScalar(THREE.MathUtils.clamp(s, 0.05, 20));
    }
  }

  private commitGizmo(): void {
    const o = this.gizmo.object;
    const id = this.gizmoId;
    const p = this.placementList.find((x) => x.id === id);
    if (this.gizmoRebuild) {
      this.gizmoRebuild = false;
      queueMicrotask(() => this.rebuildPlacements());
    }
    if (!o || !id || !p || !this.world) return;
    const at = utmInverse(
      this.world.originE + o.position.x,
      this.world.originN - o.position.z,
      this.world.zone,
    );
    const heading = (((-o.rotation.y / DEG) % 360) + 360) % 360;
    const t: PlacementTransform = {
      lon: at.lon,
      lat: at.lat,
      heading: Math.round(heading * 10) / 10,
      scale: Math.round(o.scale.x * 1000) / 1000,
      altitude:
        this.gizmoLifted || p.altitude !== null ? Math.round(o.position.y * 100) / 100 : null,
    };
    // Until the new list arrives, a rebuild draws the model where it was left.
    this.placementList = this.placementList.map((x) => (x.id === id ? { ...x, ...t } : x));
    for (const cb of this.gizmoTransformCbs) cb(id, t);
  }

  private setGizmoSnap(on: boolean): void {
    this.gizmo.setTranslationSnap(on ? 1 : null);
    this.gizmo.setRotationSnap(on ? 15 * DEG : null);
    this.gizmo.setScaleSnap(on ? 0.1 : null);
  }

  private readonly onGizmoKey = (e: KeyboardEvent) => {
    if (!this.gizmoId || isTypingIn(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Shift') this.setGizmoSnap(true);
    if (e.repeat) return;
    if (e.code === 'KeyW') this.setGizmoMode('translate');
    else if (e.code === 'KeyE') this.setGizmoMode('rotate');
    else if (e.code === 'KeyR') this.setGizmoMode('scale');
    else if (e.code === 'Escape') this.events.onSelectPlacement?.(null);
  };

  private readonly onGizmoKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Shift') this.setGizmoSnap(false);
  };

  /** Flies to a placed model. */
  focusPlacement(id: string): boolean {
    const box = this.placements.boxOf(id);
    if (!box || box.isEmpty() || !this.world) return false;
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
    this.flyToBounds(padBox([a.lon, a.lat, b.lon, b.lat], FOCUS_MIN_SPAN));
    return true;
  }

  /** The canvas the scene is drawn on (drop target of the model library). */
  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** Geographic point on the ground under a canvas point (CSS pixels); null off the city. */
  lonLatAt(clientX: number, clientY: number): LonLat | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ray = allLayersRay();
    ray.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      ),
      this.camera,
    );
    return this.groundPointAt(ray);
  }

  /** The next click on the city answers with its geographic point instead of selecting. */
  private pointRequest: ((at: LonLat | null) => void) | null = null;

  /** Waits for a click on the ground (placing a model); resolves null when cancelled. */
  pickPoint(): Promise<LonLat | null> {
    this.pointRequest?.(null);
    return new Promise((resolve) => {
      this.pointRequest = resolve;
    });
  }

  cancelPickPoint(): void {
    this.pointRequest?.(null);
    this.pointRequest = null;
  }

  private groundPointAt(ray: THREE.Raycaster): LonLat | null {
    if (!this.world) return null;
    const meshes: THREE.Object3D[] = [];
    for (const tile of this.tiles.values()) meshes.push(...tile.visibleGround());
    const hit = ray.intersectObjects(meshes, false)[0];
    let p: THREE.Vector3 | null = hit?.point ?? null;
    if (!p) {
      const t = this.controls.target;
      p = ray.ray.intersectPlane(
        new THREE.Plane(new THREE.Vector3(0, 1, 0), -t.y),
        new THREE.Vector3(),
      );
    }
    return p
      ? utmInverse(this.world.originE + p.x, this.world.originN - p.z, this.world.zone)
      : null;
  }

  private readonly vehicles = new VehicleLayer();
  private vehicleList: VehicleState[] = [];

  private readonly downRay = allLayersRay();

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
    this.followLiveObject(dt);
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

  // ─── Live objects (plugin feeds) ────────────────────────────────────────

  private readonly live = new LiveObjectLayer();
  /** Live object the camera keeps following, and where it was last frame. */
  private followLive: LiveRef | null = null;
  private followLiveAt: THREE.Vector3 | null = null;

  /**
   * Replaces every live object (a fresh snapshot of all feeds). `staleMs`:
   * the feed's stale time (objects fade towards it); `heard`: when an object
   * was last heard of (ms).
   */
  setLiveObjects(
    feeds: {
      pluginId: string;
      feedId: string;
      staleMs: number;
      objects: LiveObjectView[];
      heard?: (id: string) => number | undefined;
    }[],
  ): void {
    this.live.setAll(feeds);
  }

  /** Applies one change of a live feed (moves, adds, removes objects). */
  applyLiveChange(change: LiveFeedChange, staleMs: number): void {
    this.live.apply(change, staleMs);
  }

  /** Highlights a live object (null: none); its label follows `onLiveScreen`. */
  selectLive(sel: LiveRef | null): void {
    this.live.select(sel);
  }

  /** Screen position (px in the canvas) of the selected live object's label anchor. */
  onLiveScreen(cb: (p: LiveScreen) => void): () => void {
    return this.live.onScreen(cb);
  }

  /**
   * Flies to a live object and keeps following it: an aircraft is seen from
   * behind and above along its course, anything else from the current side.
   * An object not in the scene yet (outside the loaded world) is flown to by
   * its position `at` (the tiles there load). False when it could not be found.
   */
  focusLive(sel: LiveRef, at?: { lon: number; lat: number }): boolean {
    // Beyond the city (a quake in another province): up to the overview map,
    // the object and the city framed together — not the boundary.
    const view = this.live.viewOf(sel);
    const where = view ? { lon: view.lon, lat: view.lat } : at;
    if (where && this.overviewData && this.outsideWorkArea(where.lon, where.lat)) {
      const city = this.cityPoint();
      const lons = [where.lon, ...(city ? [city.at[0]] : [])];
      const lats = [where.lat, ...(city ? [city.at[1]] : [])];
      const pad = 0.35;
      this.followLive = null;
      this.followLiveAt = null;
      this.flyToBounds(
        [
          Math.min(...lons) - pad,
          Math.min(...lats) - pad,
          Math.max(...lons) + pad,
          Math.max(...lats) + pad,
        ],
        MAP_MAX_DISTANCE,
        MAP_FADE_TO * 2,
      );
      return true;
    }
    const st = this.live.stateOf(sel);
    if (!st) {
      if (!at) return false;
      const pad = 0.002;
      this.flyToBounds([at.lon - pad, at.lat - pad, at.lon + pad, at.lat + pad]);
      return true;
    }
    if (this.rig.mode !== 'orbit') {
      this.flyTo(st.pos.x, -st.pos.z, 80);
      return true;
    }
    const target = st.pos.clone();
    let position: THREE.Vector3;
    if (st.airborne) {
      // Behind and a little above, looking along the course.
      const h = st.heading * DEG;
      const p = 14 * DEG;
      const dist = 140;
      const forward = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
      position = target
        .clone()
        .addScaledVector(forward, -dist * Math.cos(p))
        .add(new THREE.Vector3(0, dist * Math.sin(p), 0));
    } else {
      const dist = {
        vessel: 220,
        rail: 160,
        bus: 70,
        cctv: 45,
        parking: 45,
        marker: 90,
        aircraft: 120,
      }[st.kind];
      const dir = this.camera.position.clone().sub(this.controls.target).normalize();
      if (dir.y < 0.45) dir.y = 0.45;
      dir.normalize();
      position = target.clone().add(dir.multiplyScalar(dist));
    }
    this.controls.maxDistance = Math.max(this.controls.maxDistance, position.distanceTo(target));
    this.fly = {
      from: [this.camera.position.clone(), this.controls.target.clone()],
      to: [position, target],
      t: 0,
    };
    this.followId = null;
    this.followLive = sel;
    this.followLiveAt = st.pos.clone();
    return true;
  }

  /**
   * Carries camera and target along with the followed live object: its move
   * exactly (the view keeps its angle), plus an easing of the target onto it.
   * During the fly-to the landing point moves with it.
   */
  private followLiveObject(dt: number): void {
    if (!this.followLive) return;
    const st = this.live.stateOf(this.followLive);
    if (!st || !this.followLiveAt) {
      this.followLive = null;
      this.followLiveAt = null;
      return;
    }
    const moved = st.pos.clone().sub(this.followLiveAt);
    this.followLiveAt.copy(st.pos);
    if (this.fly) {
      this.fly.to[0].add(moved);
      this.fly.to[1].add(moved);
      return;
    }
    const k = 1 - Math.exp(-dt * 3);
    const delta = moved.add(st.pos.clone().sub(this.controls.target).multiplyScalar(k));
    this.controls.target.add(delta);
    this.camera.position.add(delta);
  }

  private placePin: PlacePin | null = null;
  private pinned: { lon: number; lat: number; height: number } | null = null;
  private readonly pinListeners = new Set<(p: PinScreen) => void>();

  /**
   * Pins a place: a thin white line `height` m up from its ground, kept while
   * the camera moves (null clears). The label on top is the page's — it
   * follows `onPinScreen`.
   */
  pinPlace(place: { lon: number; lat: number; height: number } | null): void {
    this.pinned = place;
    this.placePin ??= new PlacePin(this.scene);
    this.placePin.set(null);
  }

  /** Screen position of the pin's top (px in the canvas), null when off screen or cleared. */
  onPinScreen(cb: (p: PinScreen) => void): () => void {
    this.pinListeners.add(cb);
    return () => this.pinListeners.delete(cb);
  }

  private tickPin(): void {
    const pin = this.placePin;
    if (!pin) return;
    // The world frame may come after the pin (first tile): place it once it is there.
    if (this.pinned && !pin.isSet()) {
      const at = this.worldOf(this.pinned.lon, this.pinned.lat);
      if (at) pin.set({ x: at[0], y: at[1], height: this.pinned.height });
    }
    pin.tick(
      (x, y) => this.heightAt(x, y),
      this.camera,
      this.container.clientWidth,
      this.container.clientHeight,
      (p) => this.pinListeners.forEach((cb) => cb(p)),
    );
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
  /** Loaded full-detail tiles whose networks are not built yet. */
  tilesNeedingUtilities(): string[] {
    return [...this.tiles.entries()]
      .filter(([, t]) => t.level === 'full' && t.needsUtilities)
      .map(([k]) => k);
  }

  /** Buried networks of a loaded tile (built when the underground view opened). */
  addTileUtilities(key: string, meshes: MeshPayload[]): void {
    const tile = this.tiles.get(key);
    if (!tile) return;
    tile.addUtilities(meshes, this.geometryCache);
    tile.setUnderground(this.underground);
  }

  setUnderground(kinds: UtilityKind[]): void {
    this.underground = new Set(kinds);
    fadeGround(this.mats, this.underground.size > 0);
    this.clipmap?.setFaded(this.underground.size > 0);
    for (const tile of this.tiles.values()) tile.setUnderground(this.underground);
    // Sky and fog back to the time of day, then the underground look over them.
    this.setTimeOfDay(this.hours);
    this.updateDetail();
  }

  /** Underground view: no sky, a dark soil-blue void and haze, so the networks glow through the ground. */
  private applyUndergroundLook(): void {
    const on = this.underground.size > 0;
    this.sky.visible = !on;
    this.scene.background = on ? UNDERGROUND_BG : this.skyFallback;
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
  flyToBounds(
    bbox: [number, number, number, number],
    /** Farthest (m) the fit may back off; the overview map passes its own. */
    maxDistance = FIT_MAX_DISTANCE,
    /** Nearest (m): a fit onto the overview map stays above it. */
    minDistance = 0,
  ): void {
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
      Math.max(this.controls.minDistance * 4, minDistance),
      maxDistance,
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
  /** Orbit camera and target against the ground under them (debugging). */
  debugOrbit(): { target: number; groundAtTarget: number; camera: number; groundAtCamera: number } {
    const t = this.controls.target;
    const p = this.camera.position;
    return {
      target: t.y,
      groundAtTarget: this.heightAt(t.x, -t.z),
      camera: p.y,
      groundAtCamera: this.heightAt(p.x, -p.z),
    };
  }

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

  /**
   * The ground drawn from the clipmap (D-011): every flat ground mesh takes
   * the drape material (its own kept for the clipmap's pass), markings are
   * drawn into the clipmap only; the levels are redrawn when the focus moves
   * or the shown ground changes (a tile loaded, its detail switched).
   */
  private tickDrape(): void {
    if (!this.clipmap) {
      this.clipmap = new GroundClipmap(this.renderer, this.mats.ground, this.mats.groundFade);
      this.applyGroundPalette(this.clipmap);
      if (this.underground.size) this.clipmap.setFaded(true);
    }
    const meshes: THREE.Mesh[] = [];
    for (const tile of this.tiles.values())
      for (const m of tile.drapedGround()) {
        if (!m.userData.draped) {
          m.userData.draped = true;
          if (/^markings/.test(m.name)) m.layers.set(HIDDEN_LAYER);
          else
            setLook(
              m,
              'drape',
              m.material === this.mats.ground ? this.clipmap.drapeSurface : this.clipmap.drape,
            );
        }
        meshes.push(m);
      }
    const key = meshes
      .filter((m) => m.visible)
      .map((m) => m.uuid)
      .join();
    const force = key !== this.drapedKey;
    this.drapedKey = key;
    this.clipmap.update(this.scene, this.controls.target, meshes, 9000, force);
  }

  /** Back to the layered ground (each mesh its own material, markings in the main pass). */
  private undrape(): void {
    for (const tile of this.tiles.values())
      for (const m of tile.drapedGround()) {
        if (!m.userData.draped) continue;
        delete m.userData.draped;
        if (/^markings/.test(m.name)) m.layers.set(0);
        else setLook(m, 'drape', null);
        // The clipmap's own twins stay (hidden off its layer's pass), ready for the next time.
      }
    this.drapedKey = '';
  }

  /** The map look's style (D-013): label colours, ranks and distances; tiles stay as compiled. */
  setMapStyle(style: MapStyle): void {
    this.mapStyle = style;
    this.streetLabeller.setStyle(style, this.tiles.values());
    this.poiLabeller.setStyle(style, this.tiles.values());
    this.mats.mapBuildings.saturation.value = style.buildings.saturation;
    this.mats.mapBuildings.lighten.value = style.buildings.lighten;
    if (this.clipmap) this.applyGroundPalette(this.clipmap);
  }

  private mapStyle: MapStyle | null = null;

  private applyGroundPalette(clipmap: GroundClipmap): void {
    const g = this.mapStyle?.ground;
    if (!g) return;
    clipmap.palette.saturation.value = g.saturation;
    clipmap.palette.gain.value = g.gain;
    clipmap.palette.tint.value.set(g.tint);
  }

  /** Icons of the points of interest, as SVG markup by kind (POI_ICON_KINDS); the host draws them. */
  setPoiIcons(svgs: Record<string, string>): void {
    this.poiLabeller.setIcons(svgs);
  }

  /** Map look on (see setMapLook). */
  private mapLook = false;

  /**
   * The map look (F3, the UI's "map mode"): the ground drawn as one picture
   * (the clipmap, D-011) — no paint or surface laid over another to z-fight
   * up close — and plain buildings: one quad per wall edge with shader
   * windows at every distance, no texture, 3D windows, cornices or clutter.
   * Off: the detailed city.
   */
  setMapLook(on: boolean): void {
    this.mapLook = on;
    this.debugSet({ drape: on });
    for (const tile of this.tiles.values()) tile.setPlain(on);
    this.streetLabeller.setEnabled(on, this.tiles.values());
    this.poiLabeller.setEnabled(on, this.tiles.values());
    this.updateDetail();
  }

  /** Development aid: toggle post-processing / shadows to isolate frame cost. */
  debugSet(flags: Partial<{ post: boolean; shadows: boolean; ao: boolean; drape: boolean }>): void {
    const wasDrape = this.debugFlags.drape;
    Object.assign(this.debugFlags, flags);
    if (wasDrape && !this.debugFlags.drape) this.undrape();
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
    const ray = allLayersRay();
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
    this.boundary?.wall.dispose();
    this.boundary = null;
    this.placePin?.dispose();
    this.pinListeners.clear();
    this.vehicles.dispose();
    this.live.dispose();
    this.poiLabeller.dispose();
    this.placements.dispose();
    this.groundAtlas.dispose();
    this.horizon?.dispose();
    this.clearHighlight();
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.csm?.dispose();
    this.resize.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.removeEventListener('pointerleave', this.onPointerLeave);
    this.overview?.dispose();
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('keydown', this.onGizmoKey);
    window.removeEventListener('keyup', this.onGizmoKeyUp);
    this.gizmo.detach();
    this.gizmo.getHelper().removeFromParent();
    this.gizmo.dispose();
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
    this.placements.tick(Math.min(dt, 0.25), this.camera.position);
    this.follow(Math.min(dt, 0.25));
    if (this.fly && controlsOwnCamera) {
      this.fly.t = Math.min(1, this.fly.t + 1 / 70);
      const k = this.fly.t < 0.5 ? 4 * this.fly.t ** 3 : 1 - (-2 * this.fly.t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(this.fly.from[0], this.fly.to[0], k);
      this.controls.target.lerpVectors(this.fly.from[1], this.fly.to[1], k);
      if (this.fly.t >= 1) this.fly = null;
    }
    if (controlsOwnCamera) this.controls.update();
    this.tickBoundary(Math.min(dt, 0.25));
    this.tickMap();
    this.updateDetail();
    this.live.tick(
      Math.min(dt, 0.25),
      this.camera,
      this.container.clientWidth,
      this.container.clientHeight,
      {
        worldOf: (lon, lat) => this.worldOf(lon, lat),
        // Over the full overview map, on the map.
        heightAt: (x, y) => (this.mapMode ? this.mapY : this.heightAt(x, y)),
        surfaceAt: (x, y) => (this.mapMode ? this.mapY : this.surfaceAt(x, y)),
      },
    );

    // Near plane follows the camera's height above ground: depth precision
    // scales with it, and with a fixed 1 m near plane ground layers a few cm
    // apart z-fought a few hundred metres away.
    const pos = this.camera.position;
    // Over the overview map only the map is near: a near plane far out keeps
    // its lines off the paper at a thousand kilometres.
    const near = Math.max(
      THREE.MathUtils.clamp((pos.y - this.heightAt(pos.x, -pos.z)) * 0.15, this.rig.minNear, 40),
      pos.distanceTo(this.controls.target) * 0.04 * this.mapK,
    );
    if (Math.abs(near - this.camera.near) > this.camera.near * 0.15) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }

    this.sky.position.copy(this.camera.position);
    // Shadow frustum follows the camera target.
    const target = this.controls.target;
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(this.sunDir, 1000);
    const dist = this.camera.position.distanceTo(target);
    // Haze starts beyond the focus: a district seen from 5 km is not lost in it.
    const fog = this.scene.fog as THREE.Fog;
    fog.near = Math.max(1300, dist * 1.2);
    fog.far = Math.max(5200, dist * 2.5 + 2000);
    this.fogUniforms.near.value = fog.near;
    this.fogUniforms.far.value = fog.far;
    this.fogUniforms.color.value.copy(fog.color);
    this.fogUniforms.ground.value = target.y;
    // The cascades must reach what the camera sees: three's CSM leaves surfaces
    // beyond its far end dark, so buildings seen from afar turned brown-black
    // (2026-10-08: from 1.5 km with maxFar 700 dark, 4000 lit; 2026-10-09: the
    // top of a 400 m view still dark past 880 m). The far cascade reaches the
    // fog's end; the sharp one keeps 700 m near the focus and grows with distance.
    // (Only once the cascade is set up: it gets its camera on the first shadow pass.)
    if (this.csm && (this.csm as unknown as { camera: unknown }).camera) {
      // The far cascade draws only what casts a shadow that reads from afar
      // (building shells, bridge bodies): trees, props and detail cost it 2–4 M
      // triangles a frame for sub-pixel shadows.
      const far = this.csm.lights[1]?.shadow?.camera;
      if (far && far.layers.mask !== 1 << FAR_SHADOW_LAYER) {
        far.layers.set(FAR_SHADOW_LAYER);
        // A render collects the lights its camera's layers see: without them on
        // this layer the far cascade's pass left the frame without its sun and
        // sky light (everything ~40 levels darker, measured 2026-10-09).
        this.scene.traverse((o) => {
          if ((o as THREE.Light).isLight) o.layers.enable(FAR_SHADOW_LAYER);
        });
      }
      const near = THREE.MathUtils.clamp(dist * 2.2, CSM_NEAR_REACH, CSM_MAX_REACH);
      const cover = Math.max(CSM_COVER_MIN, fog.far * 1.08);
      if (
        Math.abs(near - this.csmNear) > this.csmNear * 0.15 ||
        Math.abs(cover - this.csm.maxFar) > this.csm.maxFar * 0.1
      ) {
        this.csmNear = near;
        this.csm.maxFar = cover;
        this.csm.updateFrustums();
      }
    }
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

    this.tickPin();
    const tDrape = performance.now();
    if (this.debugFlags.drape) this.tickDrape();
    const tLabels = performance.now();
    const moved = this.streetLabeller.update(
      this.tiles.values(),
      this.camera,
      this.container.clientWidth,
      this.container.clientHeight,
    );
    this.poiLabeller.update(
      this.tiles.values(),
      this.camera,
      this.container.clientWidth,
      this.container.clientHeight,
      [...this.streetLabeller.placed],
      moved,
      Math.max(
        0,
        this.camera.position.y - this.heightAt(this.camera.position.x, -this.camera.position.z),
      ),
    );

    const cpu0 = performance.now();
    if (this.debugFlags.post) this.pipeline.render();
    else this.renderer.render(this.scene, this.camera);
    const end = performance.now();
    this.cpuMs += end - cpu0;
    this.logSlow('frame', end - now0, {
      update: Math.round(tDrape - now0),
      drape: Math.round(tLabels - tDrape),
      labels: Math.round(cpu0 - tLabels),
      render: Math.round(end - cpu0),
      clip: this.clipmap ? { ...this.clipmap.stats } : null,
    });

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
        level: this.level,
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
    // The gizmo handles its own pointer first (listening since before this one).
    this.downOnGizmo = !!this.gizmo.object && this.gizmo.axis !== null;
    // Taking the camera ends following a vehicle / live object.
    this.followId = null;
    this.followLive = null;
    this.followLiveAt = null;
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    const start = this.pointerDown;
    this.pointerDown = null;
    if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;
    if (this.downOnGizmo) return;
    if (this.mapMode) {
      // A live object on the map (a quake) first, else the province under it.
      const rect = this.renderer.domElement.getBoundingClientRect();
      const live = this.live.pick(
        this.camera,
        rect.width,
        rect.height,
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
      if (live) {
        this.events.onSelectLive?.(live);
        return;
      }
      const pick = this.mapPickAt(e.clientX, e.clientY);
      if (pick?.hasData) this.enterProvince(pick);
      return;
    }
    if (this.inspectMode) {
      this.events.onInspect?.(this.inspectAt(e.clientX, e.clientY));
      return;
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = allLayersRay();
    ray.setFromCamera(ndc, this.camera);
    if (this.pointRequest) {
      const resolve = this.pointRequest;
      this.pointRequest = null;
      resolve(this.groundPointAt(ray));
      return;
    }
    // Live objects first: small and moving, picked on the screen (nearest within ~12 px).
    const live = this.live.pick(
      this.camera,
      rect.width,
      rect.height,
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
    if (live) {
      this.events.onSelect?.(null);
      this.events.onSelectPlacement?.(null);
      this.events.onSelectLive?.(live);
      return;
    }
    this.events.onSelectLive?.(null);
    let best: { d: number; b: BuildingInfo } | null = null;
    for (const tile of this.tiles.values()) {
      const hit = tile.pick(ray);
      if (hit && (!best || hit.d < best.d)) best = hit;
    }
    const placed = this.placements.pick(ray);
    if (placed && (!best || placed.d < best.d)) {
      this.events.onSelect?.(null);
      this.events.onSelectPlacement?.(placed.id);
      return;
    }
    this.events.onSelectPlacement?.(null);
    this.events.onSelect?.(best?.b ?? null);
    if (!best) {
      const at = this.groundPointAt(ray);
      if (at) this.events.onGroundClick?.(at);
    }
  };
}
