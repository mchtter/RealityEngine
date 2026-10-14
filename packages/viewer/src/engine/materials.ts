import {
  abs,
  add,
  attribute,
  cameraPosition,
  clamp,
  cross,
  dFdx,
  dFdy,
  color,
  cos,
  dot,
  float,
  floor,
  Fn,
  fract,
  fwidth,
  hash,
  If,
  instanceIndex,
  int,
  ivec2,
  luminance,
  mat4,
  materialColor,
  max,
  min,
  mix,
  mx_cell_noise_float,
  mx_noise_float,
  normalLocal,
  normalize,
  normalView,
  normalWorld,
  oneMinus,
  positionGeometry,
  positionLocal,
  select,
  positionView,
  positionWorld,
  pow,
  sign,
  sin,
  smoothstep,
  step,
  texture,
  textureLoad,
  time,
  transformNormal,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  vertexColor,
  vertexStage,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import { airfieldLightMaterial } from './airfield-lights';
import { GROUND_GRID } from './ground-atlas';
import { GROUND_INNER, GROUND_PAD, GROUND_SIZE } from './landcover';

/**
 * Per-instance data of instanced meshes, as geometry attributes: the instance
 * matrix in four columns `iM0`…`iM3` and an optional tint `iColor`.
 */
export const INSTANCE_MATRIX_ATTRIBUTES = ['iM0', 'iM1', 'iM2', 'iM3'] as const;
export const INSTANCE_COLOR_ATTRIBUTE = 'iColor';

/**
 * Applies the instance transform to positionLocal / normalLocal. Must run
 * inside setupPosition, whose node stack records the assignments (as three
 * does for displacement maps); a Fn call pushed with toStack() was dropped.
 */
function applyInstanceTransform(): void {
  const [c0, c1, c2, c3] = INSTANCE_MATRIX_ATTRIBUTES.map((name) =>
    attribute<'vec4'>(name, 'vec4'),
  );
  const m = mat4(c0, c1, c2, c3);
  positionLocal.assign(m.mul(vec4(positionLocal, 1)).xyz);
  normalLocal.assign(transformNormal(normalLocal, m));
}

/** Per-vertex building index of building shells (made global per tile on the main thread). */
export const BUILDING_SLOT = 'bslot';
/** Scenario colour texture: one RGBA texel per building slot (alpha 255 = data colour). */
export const SCENARIO_TEXTURE_WIDTH = 1024;
export const SCENARIO_TEXTURE_HEIGHT = 256;
/** Alpha of a building's scenario texel — its scenario / selection state (read by the shell shaders). */
export const SCENARIO_ALPHA = { none: 0, selected: 64, dataSelected: 192, data: 255 } as const;

const instancedVariants = new WeakMap<THREE.Material, Map<boolean, THREE.Material>>();

/**
 * Instancing without THREE.InstancedMesh. three r183 adds the object's uuid
 * to an InstancedMesh's node cache key (the build binds that object's matrix
 * buffer), so every instanced mesh — windows, balconies, trees per detail cell
 * — rebuilt its shaders for the main and the shadow pass on first draw: about
 * a second of main-thread stall whenever tiles or detail cells came into view
 * (profiled 2026-10-01). This variant of `base` reads the instance transform
 * (and tint) from geometry attributes instead, so one build serves every mesh.
 */
export function instancedVariant(base: THREE.Material, tinted: boolean): THREE.Material {
  let byTint = instancedVariants.get(base);
  if (!byTint) {
    byTint = new Map();
    instancedVariants.set(base, byTint);
  }
  let variant = byTint.get(tinted);
  if (!variant) {
    const v = base.clone() as THREE.NodeMaterial;
    const proto = Object.getPrototypeOf(v) as THREE.NodeMaterial;
    // Instance transform first, like InstancedMesh does inside setupPosition.
    (v as unknown as { setupPosition: (builder: unknown) => unknown }).setupPosition = function (
      this: THREE.NodeMaterial,
      builder: unknown,
    ) {
      applyInstanceTransform();
      return (proto.setupPosition as (b: unknown) => unknown).call(this, builder);
    };
    if (tinted) {
      const tint = attribute<'vec3'>(INSTANCE_COLOR_ATTRIBUTE, 'vec3');
      v.colorNode = vec3((v.colorNode ?? materialColor) as never).mul(tint);
    }
    variant = v;
    byTint.set(tinted, variant);
  }
  return variant;
}

/** Disposes the instanced variants created for `base`. */
function disposeVariants(base: THREE.Material): void {
  for (const v of instancedVariants.get(base)?.values() ?? []) v.dispose();
  instancedVariants.delete(base);
}

/**
 * Procedural PBR materials (TSL). Everything is generated in shaders — no
 * texture downloads — so the scene works offline / on-prem and every
 * building gets unique plaster, cladding and roof tile variation.
 *
 * Shared uniforms drive the time of day: `night` (0 day → 1 night) turns on
 * window, shop and street lights; `skyTint` feeds fake sky reflections.
 */
export interface DtMaterials {
  night: THREE.UniformNode<'float', number>;
  /** 1 while a scenario colours the buildings (see `scenario`). */
  scenarioOn: THREE.UniformNode<'float', number>;
  /** Building slot → colour; written by the engine, sampled by shell materials. */
  scenario: THREE.DataTexture;
  skyTint: THREE.UniformNode<'color', THREE.Color>;
  wall: THREE.MeshStandardNodeMaterial;
  trim: THREE.MeshStandardNodeMaterial;
  glass: THREE.MeshStandardNodeMaterial;
  /** Three-casement window glass (wide living-room windows). */
  glassWide: THREE.MeshStandardNodeMaterial;
  /** Single-casement window (small bathroom / stair windows, halves of a window pair). */
  glassSingle: THREE.MeshStandardNodeMaterial;
  shopGlass: THREE.MeshStandardNodeMaterial;
  frame: THREE.MeshStandardNodeMaterial;
  roofTile: THREE.MeshStandardNodeMaterial;
  roofFlat: THREE.MeshStandardNodeMaterial;
  railGlass: THREE.MeshStandardNodeMaterial;
  railMetal: THREE.MeshStandardNodeMaterial;
  glazed: THREE.MeshStandardNodeMaterial;
  sign: THREE.MeshStandardNodeMaterial;
  asphalt: THREE.MeshStandardNodeMaterial;
  sidewalk: THREE.MeshStandardNodeMaterial;
  paving: THREE.MeshStandardNodeMaterial;
  path: THREE.MeshStandardNodeMaterial;
  curb: THREE.MeshStandardNodeMaterial;
  /** Board-formed concrete of retaining walls and tunnel portals. */
  retaining: THREE.MeshStandardNodeMaterial;
  island: THREE.MeshStandardNodeMaterial;
  /** All road / yard surfaces and kerbs of a ground chunk in one mesh (`surf` attribute picks the pattern). */
  ground: THREE.MeshStandardNodeMaterial;
  yard: THREE.MeshStandardNodeMaterial;
  marking: THREE.MeshStandardNodeMaterial;
  /** Taxiway centrelines (yellow). */
  markingYellow: THREE.MeshStandardNodeMaterial;
  /** Rail bed (ballast / tram concrete), sleepers, rails. */
  railBed: THREE.MeshStandardNodeMaterial;
  railTies: THREE.MeshStandardNodeMaterial;
  railSteel: THREE.MeshStandardNodeMaterial;
  terrain: THREE.MeshStandardNodeMaterial;
  /** Ground of an area without city data: a grey editor grid. */
  terrainGrid: THREE.MeshStandardNodeMaterial;
  water: THREE.MeshStandardNodeMaterial;
  prop: THREE.MeshStandardNodeMaterial;
  /**
   * Roof and wall clutter (AC units, dishes, chimneys, solar heaters): the
   * details (fan grille, louvres, dish rings, soot, tubes) are painted from
   * the model's own coordinates and kind code (`lp` attribute: xyz, w = kind).
   */
  roofClutter: THREE.MeshStandardNodeMaterial;
  /**
   * Garden walls and fences: vertex colour, pattern from the `fk` attribute
   * (FENCE_FINISH) and uv = (metres along, metres up). Railings and mesh are
   * cut out (alpha test); double-sided.
   */
  fence: THREE.MeshStandardNodeMaterial;
  lampGlow: THREE.MeshStandardNodeMaterial;
  lampPool: THREE.MeshBasicNodeMaterial;
  /** Runway, approach and taxiway lights (airfield-lights.ts). */
  airfieldLight: THREE.MeshBasicNodeMaterial;
  /** The dark inside of a tunnel mouth. */
  tunnelDark: THREE.MeshBasicNodeMaterial;
  /** Tunnel tube walls: light ceramic panels up to 3.5 m, dark coating above. */
  tunnelWall: THREE.MeshStandardNodeMaterial;
  /** Tunnel lights, illuminated signs and lane signals (vertex colour, unlit). */
  tunnelGlow: THREE.MeshBasicNodeMaterial;
  /** Tunnel fittings: sign boards, SOS cabinets, jet fans (vertex colour). */
  tunnelFixture: THREE.MeshStandardNodeMaterial;
  holoSynthetic: THREE.MeshBasicNodeMaterial;
  holoSuggested: THREE.MeshBasicNodeMaterial;
  holoBuilding: THREE.MeshBasicNodeMaterial;
  /** Buildings in the underground view (fainter than holoBuilding). */
  holoGhost: THREE.MeshBasicNodeMaterial;
  fix: THREE.MeshBasicNodeMaterial;
  /**
   * Buried pipes and cables (underground view): vertex colour per network,
   * light pulses travelling along the run (`ua` = metres along), rim glow.
   */
  utility: THREE.MeshStandardNodeMaterial;
  /** Cast-iron manhole / valve covers on the street. */
  utilityCover: THREE.MeshStandardNodeMaterial;
  /** Opacity of the ground in the underground view (1 = solid; see setUnderground). */
  groundFade: THREE.UniformNode<'float', number>;
  /** The ground atlas (ground-atlas.ts) the terrain samples; set by the engine. */
  groundAtlas: THREE.TextureNode;
  /** Albedo of plain open land in the region (terrain without a ground picture: the backdrop). */
  openLand: THREE.UniformNode<'color', THREE.Color>;
  dispose(): void;
}

const viewDir = () => normalize(cameraPosition.sub(positionWorld));

/**
 * Surface-gradient bump mapping (Mikkelsen) for a procedural height: the
 * height's screen-space derivatives tilt the view-space normal. `fade` scales
 * it down with distance so far surfaces do not shimmer.
 */
function bumpedNormal(height: ReturnType<typeof float>, strength: number, fadeFar = 90) {
  const fade = smoothstep(fadeFar, fadeFar * 0.25, positionView.z.negate());
  const h = height.mul(strength).mul(fade);
  const sigmaX = normalize(dFdx(positionView));
  const sigmaY = normalize(dFdy(positionView));
  const n = normalView;
  const r1 = cross(sigmaY, n);
  const r2 = cross(n, sigmaX);
  const det = sigmaX.dot(r1);
  // dFdx / dFdy are typed for vectors only: differentiate the height as x of a vec3.
  const hv = vec3(h, 0, 0);
  const grad = sign(det).mul(r1.mul(dFdx(hv).x).add(r2.mul(dFdy(hv).x)));
  return normalize(abs(det).mul(n).sub(grad));
}
const fresnel = (power: number) =>
  pow(oneMinus(clamp(abs(dot(viewDir(), normalWorld)), 0, 1)), power);

function decal(material: THREE.Material, factor: number): void {
  material.polygonOffset = true;
  material.polygonOffsetFactor = factor;
  material.polygonOffsetUnits = factor;
}

// ─── Street-level wear of the ground (L1) ───────────────────────────────────
// Cracks, repairs, potholes, broken pavers and concrete spalls, all procedural
// and deterministic from the world position. Only drawn near the camera: the
// fades below are a pixel's ground footprint in metres (the longer side of the
// pixel on the ground), detail fully on below the first value, gone above the
// second — far views, where it would only shimmer, keep the plain surfaces.
/** Hairline cracks, paver cracks, weeds in joints. */
const WEAR_FINE_PX = [0.025, 0.07] as const;
/** Repair patches, potholes, oil stains, concrete spalls. */
const WEAR_COARSE_PX = [0.12, 0.4] as const;
/** Relief of the wear (potholes, sunken pavers, crack grooves) in the ground normal. */
const WEAR_BUMP = 0.35;
/** View distance (m) past which the wear relief is flat (bumpedNormal fade). */
const WEAR_BUMP_FAR = 40;
/** Asphalt: one random repair patch / pothole / oil stain slot per cell of this size (m). */
const ASPHALT_WEAR_CELL = 8;
/** Asphalt: share of cells with a repair patch, a pothole, an oil stain. */
const ASPHALT_PATCH_SHARE = 0.07;
const ASPHALT_POTHOLE_SHARE = 0.02;
const ASPHALT_OIL_SHARE = 0.1;
/**
 * Pavers: base share of missing, sunken (cumulative), displaced (cumulative)
 * and cracked stones; scaled ×0.3…×2.5 by a dirt / wear noise so defects cluster.
 */
const PAVER_MISSING = 0.004;
const PAVER_SUNKEN = 0.012;
const PAVER_DISPLACED = 0.045;
const PAVER_CRACKED = 0.03;
/** Concrete bays: share with a corner crack, a crack across, spalled joint edges. */
const BAY_CORNER_CRACK = 0.14;
const BAY_MID_CRACK = 0.06;
const BAY_SPALL = 0.22;

export function createMaterials(): DtMaterials {
  const night = uniform(0);
  const skyTint = uniform(new THREE.Color(0.55, 0.68, 0.85));
  const day = oneMinus(night);

  // ─── Scenario colouring of building shells ───────────────────────────────
  // One texture for every loaded tile keeps a single shader build per material.
  const scenarioOn = uniform(0);
  const groundFade = uniform(1);
  const groundAtlas = texture(new THREE.Texture());
  const openLand = uniform(new THREE.Color(0.45, 0.4, 0.33));
  const scenario = new THREE.DataTexture(
    new Uint8Array(SCENARIO_TEXTURE_WIDTH * SCENARIO_TEXTURE_HEIGHT * 4),
    SCENARIO_TEXTURE_WIDTH,
    SCENARIO_TEXTURE_HEIGHT,
  );
  scenario.magFilter = THREE.NearestFilter;
  scenario.minFilter = THREE.NearestFilter;
  scenario.needsUpdate = true;
  /** Saturation kept by buildings without scenario data (1 = their own colours). */
  const SCENARIO_REST_SATURATION = 0.08;
  /** How far buildings without scenario data are lifted towards white (a clay model). */
  const SCENARIO_REST_LIGHTEN = 0.62;
  /** Glow of buildings with scenario data, so they read at city scale. */
  const SCENARIO_GLOW = 0.32;
  /** Colour of the selected building's glow (a pulse of light, not a category colour). */
  const SELECTED_GLOW = vec3(0.55, 0.85, 1.0);
  /**
   * A building's texel in the scenario texture. Alpha carries its state:
   * 255 scenario data, 192 data + selected, 64 selected only, 0 nothing
   * (see SCENARIO_ALPHA).
   */
  const scenarioTexel = () => {
    const slot = attribute<'float'>(BUILDING_SLOT, 'float');
    return vertexStage(
      textureLoad(
        scenario,
        ivec2(int(slot.mod(SCENARIO_TEXTURE_WIDTH)), int(floor(slot.div(SCENARIO_TEXTURE_WIDTH)))),
      ),
    );
  };
  const hasData = (a: ReturnType<typeof float>) => step(0.6, a);
  const isSelected = (a: ReturnType<typeof float>) => step(0.15, a).mul(oneMinus(step(0.9, a)));
  /**
   * Replaces a shell colour with the building's scenario colour while a
   * scenario is on. Matched buildings take the data colour, lightly shaded so
   * the form still reads; the rest turn into a pale clay model (8 %
   * saturation, lifted towards white) so the data stands out.
   */
  const scenarioTint = (original: ReturnType<typeof vec3>) => {
    const texel = scenarioTexel();
    const lum = luminance(original);
    const painted = texel.rgb.mul(lum.mul(0.35).add(0.78));
    const rest = mix(
      mix(vec3(lum), original, SCENARIO_REST_SATURATION),
      vec3(1),
      SCENARIO_REST_LIGHTEN,
    );
    return mix(original, mix(rest, painted, hasData(texel.a)), scenarioOn);
  };
  /** Emissive of a shell: scenario colours glow softly, the selected building strongly. */
  const scenarioGlow = () => {
    const texel = scenarioTexel();
    return (
      texel.rgb
        .mul(hasData(texel.a))
        .mul(scenarioOn)
        .mul(SCENARIO_GLOW)
        // The selection pulses, so it never reads as a data colour.
        .add(SELECTED_GLOW.mul(isSelected(texel.a)).mul(sin(time.mul(3.2)).mul(0.28).add(0.5)))
    );
  };

  // ─── Walls ────────────────────────────────────────────────────────────────
  // uv = (metres along the wall, metres above sea level); `finish` selects the pattern.
  const wall = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  {
    const u = uv().x;
    const v = uv().y;
    const finish = attribute<'float'>('finish', 'float');
    const is = (k: number) => step(k - 0.5, finish).mul(step(finish, k + 0.5));
    const grain = mx_noise_float(positionWorld.mul(0.9))
      .mul(0.05)
      .add(mx_noise_float(positionWorld.mul(7)).mul(0.025));
    const plaster = float(1).add(grain);
    // Wood-look cladding: horizontal planks with grain.
    const plank = fract(v.mul(6.5));
    const wood = mix(float(0.72), float(1.05), smoothstep(0.02, 0.12, plank)).mul(
      float(0.92).add(mx_noise_float(vec3(u.mul(0.35), v.mul(20), 0)).mul(0.1)),
    );
    // Composite panels: 1.2 m × 0.8 m grid with dark joints.
    const joint = max(step(0.975, fract(u.div(1.2))), step(0.965, fract(v.div(0.8))));
    const panel = mix(float(1.02), float(0.7), joint).add(grain.mul(0.4));
    // Rough stone plinth: irregular courses with per-stone tone.
    const course = floor(v.div(0.32));
    const stoneId = floor(u.div(0.55).add(course.mul(0.5)));
    const stoneEdge = max(
      step(0.93, fract(v.div(0.32))),
      step(0.95, fract(u.div(0.55).add(course.mul(0.5)))),
    );
    const stone = mix(
      float(0.8).add(hash(stoneId.add(course.mul(31))).mul(0.35)),
      float(0.55),
      stoneEdge,
    );
    // Brick.
    const row = floor(v.div(0.075));
    const brickEdge = max(
      step(0.86, fract(v.div(0.075))),
      step(0.93, fract(u.div(0.24).add(row.mul(0.5)))),
    );
    const brick = mix(
      float(0.9).add(hash(floor(u.div(0.24).add(row.mul(0.5))).add(row.mul(17))).mul(0.2)),
      float(1.25),
      brickEdge,
    );
    // Motif strip: a relief lattice of diamonds with a boss in each (Seljuk-style
    // geometric band seen on the reference fronts).
    const mu = fract(u.div(0.28));
    const mv = fract(v.div(0.28));
    const md = abs(mu.sub(0.5)).add(abs(mv.sub(0.5)));
    const motif = float(1.06)
      .sub(step(abs(md.sub(0.38)), 0.05).mul(0.32))
      .sub(step(md, 0.1).mul(0.22));
    const pattern = plaster
      .mul(is(0))
      .add(wood.mul(is(1)))
      .add(panel.mul(is(2)))
      .add(stone.mul(is(3)))
      .add(brick.mul(is(4)))
      .add(motif.mul(is(5)));
    // Weathering (reference: soul_of_anatolia): faded patches, rain streaks running
    // down from sills and eaves, and a darker band where the street splashes the wall.
    const fl0 = attribute<'vec3'>('floorInfo', 'vec3');
    const patches = mx_noise_float(vec3(u.mul(0.11), v.mul(0.07), fl0.y.mul(3.1))).mul(0.09);
    const streaks = smoothstep(
      0.15,
      0.75,
      mx_noise_float(vec3(u.mul(2.4), v.mul(0.09), fl0.x.mul(0.7))),
    ).mul(0.08);
    const groundLevel = fl0.x.sub(3.6);
    const splash = oneMinus(smoothstep(0, 1.4, v.sub(groundLevel))).mul(0.14);
    const weathering = float(1).add(patches).sub(streaks).sub(splash);
    // Far windows: drawn by the shader on every window bay; near buildings add
    // 3D frames / glass instances on top that cover these exactly.
    const bay = attribute<'vec3'>('bay', 'vec3');
    const fl = attribute<'vec3'>('floorInfo', 'vec3');
    const rel = v.sub(fl.x);
    const local = rel.sub(fl.y.mul(floor(rel.div(fl.y))));
    // bay.x < 0 (far LOD walls: one quad per edge): a window every −bay.x metres.
    const period = max(bay.x.negate(), 0.01);
    const repeated = step(bay.x, -0.001);
    const bayCentre = mix(bay.x, floor(u.div(period)).add(0.5).mul(period), repeated);
    const inX = step(abs(u.sub(bayCentre)), bay.y.mul(0.5)).mul(step(0.01, bay.y));
    const inY = step(0.9, local)
      .mul(step(local, bay.z.add(0.9)))
      .mul(step(fl.x, v))
      .mul(step(v, fl.z));
    const win = inX.mul(inY);
    const lightId = hash(
      bayCentre
        .mul(3.7)
        .add(floor(rel.div(fl.y)).mul(17.3))
        .add(fl.x.mul(1.31)),
    );
    wall.colorNode = mix(
      scenarioTint(vertexColor().rgb.mul(pattern).mul(weathering)),
      vec3(0.07, 0.09, 0.11),
      win,
    );
    wall.roughnessNode = mix(mix(float(0.92), float(0.75), is(2)), float(0.12), win);
    // Relief under raking light: stucco grain, recessed mortar / plank / panel
    // joints, the motif's grooves. Window glass stays flat.
    const relief = grain
      .mul(4)
      .mul(is(0))
      .sub(oneMinus(smoothstep(0.02, 0.12, plank)).mul(is(1)))
      .sub(joint.mul(is(2)))
      .add(grain.mul(3).sub(stoneEdge).mul(is(3)))
      .sub(brickEdge.mul(is(4)))
      .add(motif.sub(1).mul(2).mul(is(5)));
    wall.normalNode = mix(bumpedNormal(relief, 0.05), normalView, win);
    wall.emissiveNode = vec3(1.0, 0.74, 0.44)
      .mul(night)
      .mul(step(0.62, lightId))
      .mul(win)
      .mul(hash(lightId.mul(9.1)).mul(0.45).add(0.2))
      .add(scenarioGlow().mul(oneMinus(win)));
  }

  const trim = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0 });
  trim.colorNode = scenarioTint(vertexColor().rgb);
  trim.emissiveNode = scenarioGlow();

  // ─── Windows ──────────────────────────────────────────────────────────────
  const curtainTone = hash(instanceIndex.add(11));
  const hasCurtain = step(0.5, hash(instanceIndex.add(3)));
  // Some windows carry a tilt-turn top light (vasistas) above the casements.
  const hasTransom = step(0.6, hash(instanceIndex.add(13)));
  const lit = step(0.62, hash(instanceIndex.add(7))).mul(night);
  // Window = one quad: frame, centre mullion, inner reveal shadow, curtains
  // and night lighting are all drawn here (2 triangles per window).
  /** Window glass with `panes` casements (1: small, 2: standard, 3: wide living-room window). */
  const windowGlass = (panes: 1 | 2 | 3) => {
    const glass = new THREE.MeshStandardNodeMaterial({ roughness: 0.06, metalness: 0.1 });
    const wu = uv().x;
    const wv = uv().y;
    const frameColor = attribute<'vec3'>('frameColor', 'vec3');
    // PVC / timber frames read thick in the reference renders.
    const fx = 0.085;
    const fy = 0.07;
    const opening = step(fx, wu)
      .mul(step(wu, 1 - fx))
      .mul(step(fy, wv))
      .mul(step(wv, 1 - fy));
    const mullionX =
      panes === 1
        ? float(0)
        : panes === 2
          ? step(abs(wu.sub(0.5)), 0.022)
          : max(step(abs(wu.sub(1 / 3)), 0.014), step(abs(wu.sub(2 / 3)), 0.014));
    const mullion = max(mullionX, hasTransom.mul(step(abs(wv.sub(0.74)), 0.025)));
    const frameMask = max(oneMinus(opening), mullion);
    const reveal = smoothstep(fx, fx + 0.07, wu)
      .mul(smoothstep(1 - fx, 1 - fx - 0.07, wu))
      .mul(smoothstep(1 - fy, 1 - fy - 0.1, wv))
      .mul(0.45)
      .add(0.55);
    const folds = sin(wu.mul(70)).mul(0.04).add(0.96);
    // Net curtains (tül), drawn back a little at the sides.
    const gathered = smoothstep(0.34, 0.44, abs(wu.sub(0.5)))
      .mul(0.25)
      .add(0.75);
    const curtain = mix(vec3(0.78, 0.76, 0.71), vec3(0.88, 0.86, 0.82), curtainTone)
      .mul(folds)
      .mul(gathered);
    const pane = vec3(0.1, 0.13, 0.15);
    const inside = mix(pane, curtain.mul(0.42), hasCurtain.mul(smoothstep(0.1, 0.25, wv))).mul(
      reveal,
    );
    glass.colorNode = mix(inside, frameColor, frameMask);
    glass.roughnessNode = mix(float(0.16), float(0.55), frameMask);
    glass.emissiveNode = skyTint
      .mul(fresnel(3).mul(0.12))
      .mul(day)
      .add(
        mix(vec3(1.0, 0.72, 0.42), vec3(0.85, 0.9, 1.0), step(0.8, curtainTone))
          .mul(lit)
          .mul(hash(instanceIndex.add(5)).mul(0.45).add(0.2)),
      )
      .mul(oneMinus(frameMask));
    return glass;
  };
  const glass = windowGlass(2);
  const glassWide = windowGlass(3);
  const glassSingle = windowGlass(1);
  const shopGlass = new THREE.MeshStandardNodeMaterial({ roughness: 0.05, metalness: 0.1 });
  {
    const shelves = step(0.8, fract(uv().y.mul(5))).mul(0.25);
    const goods = hash(
      floor(uv().x.mul(12))
        .add(floor(uv().y.mul(5)).mul(13))
        .add(instanceIndex),
    );
    shopGlass.colorNode = mix(vec3(0.16, 0.15, 0.14), vec3(0.45, 0.4, 0.33), goods.mul(0.6)).add(
      shelves,
    );
    shopGlass.emissiveNode = skyTint
      .mul(fresnel(3).mul(0.5))
      .mul(day)
      .add(vec3(1.0, 0.9, 0.75).mul(night.mul(0.9).add(0.12)).mul(goods.mul(0.5).add(0.5)));
  }
  const frame = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0 });

  // ─── Roofs ────────────────────────────────────────────────────────────────
  // uv = (metres along the eave, metres up the slope).
  // Vertex colour is folded into colorNode (not `vertexColors`) so scenarios can replace it.
  const roofTile = new THREE.MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0 });
  {
    const rowT = fract(uv().y.div(0.34));
    const col = uv()
      .x.div(0.22)
      .add(floor(uv().y.div(0.34)).mul(0.5));
    const tileShade = mix(float(0.62), float(1.05), smoothstep(0.0, 0.55, rowT)).mul(
      sin(fract(col).mul(Math.PI)).mul(0.14).add(0.9),
    );
    const tileTone = hash(floor(col).add(floor(uv().y.div(0.34)).mul(97)))
      .mul(0.2)
      .add(0.9);
    const moss = mx_noise_float(positionWorld.mul(0.35)).mul(0.06);
    // Each course of tiles bulges and laps over the next one.
    roofTile.normalNode = bumpedNormal(tileShade, 0.12, 70);
    roofTile.colorNode = scenarioTint(
      vertexColor().rgb.mul(vec3(tileShade.mul(tileTone).add(moss))),
    );
    roofTile.emissiveNode = scenarioGlow();
  }
  const roofFlat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  roofFlat.colorNode = scenarioTint(
    vertexColor().rgb.mul(float(0.92).add(mx_noise_float(positionWorld.mul(2.5)).mul(0.08))),
  );
  roofFlat.emissiveNode = scenarioGlow();

  // ─── Balconies ────────────────────────────────────────────────────────────
  const railGlass = new THREE.MeshStandardNodeMaterial({
    roughness: 0.05,
    metalness: 0.2,
    transparent: true,
    side: THREE.DoubleSide,
  });
  railGlass.colorNode = vec3(0.35, 0.52, 0.55);
  railGlass.opacityNode = fresnel(2).mul(0.35).add(0.35);
  railGlass.depthWrite = false;

  const railMetal = new THREE.MeshStandardNodeMaterial({
    roughness: 0.5,
    metalness: 0.6,
    side: THREE.DoubleSide,
  });
  railMetal.colorNode = vec3(0.16, 0.17, 0.18);
  railMetal.opacityNode = max(step(0.6, fract(uv().x.mul(9))), step(0.92, uv().y)).max(
    step(uv().y, 0.05),
  );
  railMetal.alphaTest = 0.5;

  // Semi-transparent tinted glass: the door and window behind the cam balkon show
  // through, dimmed, with the sky reflected at grazing angles.
  const glazed = new THREE.MeshStandardNodeMaterial({
    roughness: 0.05,
    metalness: 0.25,
    transparent: true,
  });
  {
    // Four aluminium sliding sashes with top and bottom rails; the glass between is
    // see-through (the door, window and curtains behind it are the real ones).
    const mullion = max(step(0.94, fract(uv().x.mul(4))), step(0.94, uv().y)).max(
      step(uv().y, 0.04),
    );
    glazed.colorNode = mix(vec3(0.1, 0.14, 0.15), vec3(0.78, 0.78, 0.76), mullion);
    glazed.opacityNode = mix(fresnel(2).mul(0.35).add(0.5), float(1), mullion);
    glazed.emissiveNode = skyTint
      .mul(fresnel(3).mul(0.35).add(0.04))
      .mul(day)
      .mul(oneMinus(mullion))
      .add(vec3(1, 0.8, 0.5).mul(lit.mul(0.7)).mul(oneMinus(mullion)));
  }

  const sign = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
  sign.emissiveNode = vec3(0.9, 0.85, 0.8).mul(night.mul(0.55));

  // ─── Ground ───────────────────────────────────────────────────────────────
  const wp = positionWorld;

  // Street-level wear (see WEAR_*): each worn surface has a `…Wear(on)` that
  // returns its colour (xyz) and a relief height (w, for wearNormal). The work
  // sits behind a dynamic branch on `on` × the near fade, so far fragments and
  // other surface kinds of the merged ground skip it. Derivatives are taken
  // here, outside any branch (WGSL derivative uniformity); inside the branches
  // only toVar'd values from the function's top are reused.
  type FloatNode = ReturnType<typeof float>;
  type Vec4Node = ReturnType<typeof vec4>;
  type Wear = (on: FloatNode) => Vec4Node;
  const pxA = dFdx(wp).length();
  const pxB = dFdy(wp).length();
  /** Pixel footprint on the ground (m): geometric mean, the width lines are filtered over. */
  const pxIso = pxA.mul(pxB).sqrt();
  /** Longer side of the footprint (grazing views stretch it): drives the fades. */
  const pxMax = max(pxA, pxB);
  const fineNear = oneMinus(smoothstep(WEAR_FINE_PX[0], WEAR_FINE_PX[1], pxMax));
  const coarseNear = oneMinus(smoothstep(WEAR_COARSE_PX[0], WEAR_COARSE_PX[1], pxMax));
  /**
   * Coverage of a line of half-width `w` (m) at distance `d` (m), filtered
   * over `aa` (m). Darkness is conserved: a line thinner than a pixel turns
   * fainter instead of flickering.
   */
  const lineAt = (d: FloatNode, w: number, aa: FloatNode) =>
    oneMinus(smoothstep(float(w), aa.add(w), d)).mul(float(2 * w).div(aa.add(2 * w)));
  const wearNormal = (height: FloatNode) => bumpedNormal(height, WEAR_BUMP, WEAR_BUMP_FAR);
  /** Rough crack-tar seal / patch seam colour (darker than any asphalt). */
  const sealColor = vec3(0.045, 0.045, 0.048);

  const asphalt = new THREE.MeshStandardNodeMaterial({ roughness: 0.93, metalness: 0 });
  const asphaltBase = vec3(0.13, 0.135, 0.14)
    .mul(
      float(0.88)
        .add(mx_noise_float(wp.mul(0.45)).mul(0.12))
        .add(mx_noise_float(wp.mul(9)).mul(0.05)),
    )
    .add(vec3(0.05).mul(smoothstep(0.35, 0.8, mx_noise_float(wp.mul(0.08)))));
  // Asphalt wear. Per 8 m cell (ASPHALT_WEAR_CELL) one slot each for a repair
  // patch (a re-laid rectangle 0.8–3 × 0.6–1.8 m at a random angle, fresh-dark
  // or faded-grey, tar-sealed seam), a pothole (r 0.14–0.42 m, ragged rim) and
  // an oil stain (r 0.25–0.7 m). Hairline cracks: long meandering cracks (zero
  // lines of a slow noise, a few metres apart) in some districts, some of them
  // sealed with tar; alligator (fatigue) cracking — two crossing sets of noise
  // zero lines, ~0.2–0.4 m blocks — in other districts. Most asphalt stays clean.
  const asphaltWear: Wear = (on) =>
    Fn(() => {
      const out = vec4(asphaltBase, 0).toVar();
      const coarse = coarseNear.mul(on).toVar();
      const fine = fineNear.mul(on).toVar();
      const aa = pxIso.toVar();
      const p = wp.xz.toVar();
      If(coarse.greaterThan(0.001), () => {
        const cell = floor(p.div(ASPHALT_WEAR_CELL));
        const lp = p.sub(cell.mul(ASPHALT_WEAR_CELL));
        const r = (k: number) => mx_cell_noise_float(vec3(cell, k));
        const grit = mx_noise_float(p.mul(9)).toVar();
        const ragged = mx_noise_float(p.mul(3.1).add(5.3)).toVar();
        const col = out.xyz.toVar();
        const height = float(0).toVar();
        // Repair patch (rotated box; signed distance < 0 inside, metres).
        const ang = r(1).mul(Math.PI);
        const ca = cos(ang);
        const sa = sin(ang);
        const q0 = lp.sub(
          vec2(r(2), r(3))
            .mul(ASPHALT_WEAR_CELL - 3.6)
            .add(1.8),
        );
        const qx = abs(q0.x.mul(ca).add(q0.y.mul(sa)));
        const qy = abs(q0.y.mul(ca).sub(q0.x.mul(sa)));
        const box = max(qx.sub(r(4).mul(1.1).add(0.4)), qy.sub(r(5).mul(0.6).add(0.3)));
        const hasPatch = step(r(0), ASPHALT_PATCH_SHARE).mul(coarse);
        const inPatch = oneMinus(smoothstep(aa.negate(), aa, box)).mul(hasPatch);
        const patchTone = mix(float(0.74), float(1.2), step(0.5, r(6))).mul(grit.mul(0.06).add(1));
        col.assign(mix(col, col.mul(patchTone), inPatch));
        col.assign(mix(col, sealColor, lineAt(abs(box), 0.012, aa).mul(hasPatch).mul(0.75)));
        height.addAssign(inPatch.mul(0.12));
        // Pothole: a ragged bowl, dark broken bottom, a rim of loose lighter chippings.
        const holeR = r(10).mul(0.28).add(0.14);
        const hd = lp
          .sub(
            vec2(r(8), r(9))
              .mul(ASPHALT_WEAR_CELL - 2)
              .add(1),
          )
          .length()
          .div(holeR)
          .add(ragged.mul(0.3));
        const hasHole = step(r(7), ASPHALT_POTHOLE_SHARE).mul(coarse);
        const hole = oneMinus(smoothstep(oneMinus(aa.div(holeR)).sub(0.04), float(1), hd)).mul(
          hasHole,
        );
        const rim = smoothstep(0.8, 1, hd)
          .mul(oneMinus(smoothstep(1, 1.35, hd)))
          .mul(hasHole);
        col.assign(mix(col, col.mul(grit.mul(0.25).add(0.45)), hole));
        col.assign(col.mul(rim.mul(0.18).add(1)));
        height.subAssign(hole.mul(oneMinus(hd.mul(hd)).max(0).mul(0.8).add(0.2)));
        // Oil stain: a soft dark ellipse with a ragged edge (same angle as the patch slot).
        const o0 = lp.sub(
          vec2(r(12), r(13))
            .mul(ASPHALT_WEAR_CELL - 2)
            .add(1),
        );
        const od = vec2(o0.x.mul(ca).add(o0.y.mul(sa)), o0.y.mul(ca).sub(o0.x.mul(sa)).mul(1.6))
          .length()
          .div(r(14).mul(0.45).add(0.25))
          .add(ragged.mul(0.25));
        const oil = oneMinus(smoothstep(0.3, 1, od))
          .mul(step(r(11), ASPHALT_OIL_SHARE))
          .mul(coarse);
        col.assign(col.mul(oneMinus(oil.mul(0.38))));
        // Hairline cracks (near only).
        If(fine.greaterThan(0.001), () => {
          // Districts: long cracks where `district` is high (sealed where higher
          // still), alligator cracking where it is low; the middle stays clean.
          const district = mx_noise_float(p.mul(0.045).add(11)).mul(0.5).add(0.5).toVar();
          const longCracks = smoothstep(0.6, 0.64, district);
          const sealed = smoothstep(0.69, 0.72, district);
          // Distance to a noise zero line ≈ |n| / (frequency × ~1.5 mean slope).
          const dLong = abs(mx_noise_float(p.mul(0.2).add(3.7)).add(grit.mul(0.012))).div(0.3);
          const crack = lineAt(dLong, 0.003, aa).mul(longCracks).toVar();
          const seal = lineAt(dLong, 0.016, aa).mul(sealed);
          const fatigue = oneMinus(smoothstep(0.3, 0.34, district)).toVar();
          If(fatigue.greaterThan(0.001), () => {
            const a1 = abs(mx_noise_float(p.mul(2.4)).add(grit.mul(0.03))).div(2.4 * 1.5);
            const a2 = abs(mx_noise_float(p.mul(3.9).add(17)).add(grit.mul(0.03))).div(3.9 * 1.5);
            crack.assign(
              max(crack, max(lineAt(a1, 0.0025, aa), lineAt(a2, 0.0025, aa)).mul(fatigue)),
            );
            // Fatigued asphalt is a little darker and more ravelled.
            col.assign(col.mul(oneMinus(fatigue.mul(fine).mul(0.07))));
          });
          col.assign(mix(col, sealColor, seal.mul(fine).mul(0.8)));
          col.assign(col.mul(oneMinus(crack.mul(fine).mul(0.72))));
          height.subAssign(crack.mul(fine).mul(0.5));
        });
        out.assign(vec4(col, height));
      });
      return out;
    })();
  {
    const w = asphaltWear(float(1));
    asphalt.colorNode = w.xyz;
    asphalt.normalNode = wearNormal(w.w);
  }
  decal(asphalt, -1);

  // Sidewalks: interlocking concrete pavers (kilit taşı), 20 × 10 cm in a
  // running bond with sanded joints; stone-to-stone tone variation, streets
  // laid grey, grey and red, or mostly red; dirt and wear. Joints fade out
  // with distance (fwidth) instead of shimmering.
  const sidewalk = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });
  let sidewalkWear: Wear;
  {
    const v = wp.z.div(0.1);
    const row = floor(v);
    const u = wp.x.div(0.2).add(row.mul(0.5));
    const fu = fract(u);
    const fv = fract(v);
    const wu = fwidth(u).max(1e-4);
    const wv = fwidth(v).max(1e-4);
    const jointU = oneMinus(smoothstep(0.03, add(0.03, wu), min(fu, oneMinus(fu))));
    const jointV = oneMinus(smoothstep(0.06, add(0.06, wv), min(fv, oneMinus(fv))));
    // Joints thinner than a pixel average into the stone colour.
    const fade = oneMinus(smoothstep(0.12, 0.35, max(wu, wv)));
    const joint = max(jointU, jointV).mul(fade);
    const id = floor(u).add(row.mul(131));
    // Stone-to-stone tone also fades out with distance (it aliased into rings).
    const tone = hash(id).mul(0.16).sub(0.08).mul(fade).add(0.94);
    const grey = vec3(0.5, 0.49, 0.465).mul(tone);
    // Two reds (terracotta and a browner one), stone by stone.
    const red = mix(vec3(0.55, 0.39, 0.34), vec3(0.5, 0.4, 0.37), step(0.5, hash(id.add(3.1)))).mul(
      tone,
    );
    // A street's paving scheme, by area: grey with a few red stones, grey and
    // red mixed, or mostly red. `share` is the red stones' fraction.
    const area = mx_noise_float(wp.mul(0.01)).mul(0.5).add(0.5);
    const share = mix(
      float(0.05),
      mix(float(0.3), float(0.75), smoothstep(0.56, 0.6, area)),
      smoothstep(0.4, 0.44, area),
    );
    // Stone by stone up close; the mixed colour where stones are below a pixel.
    const isRed = mix(share, step(oneMinus(share), hash(id.add(7.3))), fade);
    const stone = mix(grey, red, isRed);
    const dirt = mx_noise_float(wp.mul(0.45)).mul(0.5).add(0.5);
    const worn = mix(float(0.84), float(1.04), dirt);
    const sidewalkBase = mix(stone.mul(worn), vec3(0.33, 0.31, 0.28), joint.mul(0.85));
    // Paver wear, stone by stone (faded with the joints): a few missing stones
    // (bedding sand in a shadowed hole), sunken ones (darker, shadowed edge),
    // displaced ones (tone shift, tilted, one edge in shadow), cracked ones (a
    // straight break across the stone, the halves a little apart in tone), and
    // weeds in the joints of the dirtiest stretches. Defects cluster where the
    // dirt noise is high (tree roots, cars parked on the kerb).
    sidewalkWear = (on) =>
      Fn(() => {
        const out = vec4(sidewalkBase, 0).toVar();
        const gate = fade.mul(on).toVar();
        const fine = fineNear.mul(on).toVar();
        const aa = pxIso.toVar();
        const pf = vec2(fu, fv).toVar();
        const pid = vec2(floor(u), row).toVar();
        const jointAt = joint.toVar();
        const dirtAt = dirt.toVar();
        If(gate.greaterThan(0.001), () => {
          const r = (k: number) => mx_cell_noise_float(vec3(pid, k + 20));
          const col = out.xyz.toVar();
          const height = float(0).toVar();
          const dens = mix(float(0.3), float(2.5), smoothstep(0.45, 0.8, dirtAt));
          const pick = r(0).div(dens).toVar();
          const missing = step(pick, PAVER_MISSING);
          const sunken = step(pick, PAVER_SUNKEN).sub(missing);
          const displaced = step(pick, PAVER_DISPLACED).sub(step(pick, PAVER_SUNKEN));
          const cracked = step(oneMinus(dens.mul(PAVER_CRACKED)), r(0)).mul(fine);
          // Stone-local metres from its centre, and to its nearest edge.
          const lx = pf.x.sub(0.5).mul(0.2);
          const ly = pf.y.sub(0.5).mul(0.1);
          const edge = min(abs(lx).negate().add(0.1), abs(ly).negate().add(0.05)).toVar();
          const rimShade = smoothstep(0, 0.03, edge);
          // Missing: bedding sand, shadowed under the neighbours' edges.
          const sand = vec3(0.41, 0.36, 0.28).mul(r(5).mul(0.15).add(0.85));
          col.assign(mix(col, sand.mul(mix(float(0.45), float(1), rimShade)), missing.mul(gate)));
          height.subAssign(missing.mul(smoothstep(0, 0.012, edge)));
          // Sunken: darker, the edge in shadow.
          col.assign(
            col.mul(oneMinus(sunken.mul(gate).mul(oneMinus(rimShade.mul(0.5)).mul(0.36)))),
          );
          height.subAssign(sunken.mul(smoothstep(0, 0.01, edge)).mul(0.5));
          // Displaced: its own tone, tilted across, the raised edge's shadow side dark.
          const tilt = step(0.5, r(2)).mul(2).sub(1);
          const shadowSide = mix(pf.y, oneMinus(pf.y), step(0.5, r(2))).mul(0.1);
          col.assign(
            col.mul(
              mix(
                float(1),
                r(1)
                  .mul(0.24)
                  .add(0.88)
                  .mul(oneMinus(oneMinus(smoothstep(0, 0.012, shadowSide)).mul(0.3))),
                displaced.mul(gate),
              ),
            ),
          );
          height.addAssign(displaced.mul(ly.mul(tilt).mul(6)));
          // Cracked: a straight break through the stone at a random angle.
          const ang = r(3).mul(Math.PI);
          const side = lx
            .mul(cos(ang))
            .add(ly.mul(sin(ang)))
            .sub(r(4).sub(0.5).mul(0.04));
          const crack = lineAt(abs(side), 0.0015, aa).mul(cracked);
          col.assign(col.mul(step(0, side).mul(0.06).sub(0.03).mul(cracked).add(1)));
          col.assign(col.mul(oneMinus(crack.mul(0.7))));
          height.subAssign(crack.mul(0.4));
          // Weeds: green tufts in some joints of the dirtiest stretches.
          const weedy = smoothstep(0.68, 0.76, dirtAt).mul(step(r(6), 0.4));
          const weed = mix(vec3(0.2, 0.3, 0.09), vec3(0.33, 0.37, 0.14), r(7));
          col.assign(mix(col, weed, jointAt.mul(weedy).mul(fine).mul(0.9)));
          out.assign(vec4(col, height.mul(gate)));
        });
        return out;
      })();
    const w = sidewalkWear(float(1));
    sidewalk.colorNode = w.xyz;
    sidewalk.normalNode = wearNormal(w.w);
    sidewalk.roughnessNode = mix(float(0.86), float(0.95), joint);
  }
  decal(sidewalk, -2);

  const paving = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  {
    const r = floor(wp.z.div(0.2));
    const cx = wp.x.div(0.4).add(r.mul(0.5));
    const edge = max(step(0.9, fract(wp.z.div(0.2))), step(0.95, fract(cx)));
    const tone = hash(floor(cx).add(r.mul(57)))
      .mul(0.18)
      .add(0.88);
    paving.colorNode = mix(vec3(0.62, 0.55, 0.48).mul(tone), vec3(0.38, 0.35, 0.32), edge);
  }
  decal(paving, -2);

  // Walking / running / cycle paths: blue poured-rubber track, as Turkish
  // cities lay them (fine EPDM granules, sun-faded and worn in places).
  const path = new THREE.MeshStandardNodeMaterial({ roughness: 0.98, metalness: 0 });
  {
    const granule = mx_noise_float(wp.mul(14)).mul(0.08);
    const fade = mx_noise_float(wp.mul(0.12)).mul(0.5).add(0.5);
    const wear = smoothstep(0.65, 0.9, mx_noise_float(wp.mul(0.6)).mul(0.5).add(0.5)).mul(0.25);
    // Brighter, matte sport-track blue (a deep blue ribbon read as water).
    const blue = mix(vec3(0.17, 0.4, 0.72), vec3(0.23, 0.47, 0.78), fade);
    const speck = step(0.82, mx_noise_float(wp.mul(40)).mul(0.5).add(0.5)).mul(0.08);
    path.colorNode = mix(blue, vec3(0.42, 0.5, 0.6), wear)
      .mul(float(1).add(granule))
      .add(speck);
  }
  decal(path, -2);

  // Retaining walls: cast in 2.4 × 1.2 m formwork panels (joints, a grid of
  // tie holes), faint board marks, rain streaks from the coping down, a damp
  // darker band at the foot; tops stay plain. Coordinates along the wall come
  // from the world position across the face normal, so any wall direction works.
  const retaining = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });
  {
    const nw = normalWorld;
    const side = oneMinus(abs(nw.y));
    const along = positionWorld.x.mul(nw.z).sub(positionWorld.z.mul(nw.x));
    const up = positionWorld.y;
    const pu = fract(along.div(2.4));
    const pv = fract(up.div(1.2));
    const joint = max(step(0.985, pu), step(0.975, pv));
    const boards = step(0.93, fract(up.div(0.15))).mul(0.35);
    const tu = fract(along.div(0.6).add(0.5));
    const tv = fract(up.div(0.6).add(0.5));
    const tie = oneMinus(smoothstep(0.02, 0.035, vec3(tu.sub(0.5), tv.sub(0.5), 0).length()));
    const cell = hash(floor(along.div(2.4)).add(floor(up.div(1.2)).mul(37)));
    const tone = float(0.92).add(cell.mul(0.1));
    const n1 = mx_noise_float(positionWorld.mul(0.9)).mul(0.5).add(0.5);
    const streakCol = hash(floor(along.div(0.35)));
    const streak = step(0.72, streakCol).mul(
      mx_noise_float(vec3(along.mul(3), up.mul(0.25), 0))
        .mul(0.5)
        .add(0.5),
    );
    let c = vec3(0.66, 0.65, 0.62)
      .mul(tone)
      .mul(mix(float(0.9), float(1.04), n1));
    c = mix(c, c.mul(0.78), streak.mul(0.45));
    c = mix(c, c.mul(0.82), boards);
    c = mix(c, vec3(0.3, 0.3, 0.29), joint.mul(0.7));
    c = mix(c, vec3(0.22, 0.22, 0.21), tie.mul(0.8));
    retaining.colorNode = mix(
      vec3(0.6, 0.59, 0.56).mul(mix(float(0.92), float(1.02), n1)),
      c,
      side,
    );
    retaining.roughnessNode = mix(float(0.85), float(0.92), joint);
  }

  const curb = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0 });
  curb.colorNode = vec3(0.68, 0.67, 0.64);

  const island = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  island.colorNode = vec3(0.3, 0.4, 0.18).mul(
    float(0.85).add(mx_noise_float(wp.mul(1.5)).mul(0.2)),
  );
  decal(island, -2);

  // Yards: worn concrete / gravel with patches of dry grass.
  const yard = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  {
    const patch = smoothstep(0.25, 0.65, mx_noise_float(wp.mul(0.12)).mul(0.5).add(0.5));
    const gravel = vec3(0.56, 0.53, 0.48).mul(float(0.88).add(mx_noise_float(wp.mul(6)).mul(0.12)));
    yard.colorNode = mix(gravel, vec3(0.5, 0.48, 0.32), patch.mul(0.55));
  }
  decal(yard, -1);

  // Hard ground of dense blocks and institutional yards: cast concrete in
  // 3 m bays with joints, stains, cracks and patches of bare soil.
  const concrete = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  let concreteWear: Wear;
  {
    const g = wp.xz.div(3);
    const joint = max(step(0.985, fract(g.x)), step(0.985, fract(g.y)));
    const bay = hash(floor(g.x).add(floor(g.y).mul(97)))
      .mul(0.14)
      .add(0.86);
    const stain = mx_noise_float(wp.mul(0.35)).mul(0.5).add(0.5);
    // Small patches of bare soil (a few metres across, here and there).
    const soil = smoothstep(0.72, 0.78, mx_noise_float(wp.mul(0.16).add(13)).mul(0.5).add(0.5));
    const slab = vec3(0.6, 0.59, 0.56)
      .mul(bay)
      .mul(mix(float(0.8), float(1.05), stain));
    const earth = vec3(0.45, 0.37, 0.28).mul(float(0.85).add(mx_noise_float(wp.mul(4)).mul(0.15)));
    const concreteBase = mix(mix(slab, slab.mul(0.62), joint), earth, soil.mul(0.75));
    // Bay wear: spalled joint edges (chips 2–8 cm deep in stretches along the
    // joints, exposed darker aggregate), corner cracks (a jagged diagonal 0.3–0.9 m
    // from a corner) and the odd crack straight across a bay. Not on the soil.
    concreteWear = (on) =>
      Fn(() => {
        const out = vec4(concreteBase, 0).toVar();
        const coarse = coarseNear
          .mul(on)
          .mul(oneMinus(soil.mul(0.75)))
          .toVar();
        const fine = fineNear.mul(coarse).toVar();
        const aa = pxIso.toVar();
        const gv = g.toVar();
        If(coarse.greaterThan(0.001), () => {
          const r = (k: number) => mx_cell_noise_float(vec3(floor(gv), k + 40));
          const lm = fract(gv).mul(3).toVar();
          const p = gv.mul(3);
          const jag = mx_noise_float(p.mul(7.3)).toVar();
          const col = out.xyz.toVar();
          const height = float(0).toVar();
          // Spalls: where the distance to a joint is under a ragged depth.
          const e = min(min(lm.x, lm.x.negate().add(2.955)), min(lm.y, lm.y.negate().add(2.955)));
          const stretch = smoothstep(
            0.55,
            0.7,
            mx_noise_float(p.mul(1.3).add(17)).mul(0.5).add(0.5),
          );
          const depth = jag.mul(0.5).add(0.5).mul(0.06).add(0.02);
          const spall = oneMinus(smoothstep(aa.negate(), aa, e.sub(depth)))
            .mul(stretch)
            .mul(step(r(0), BAY_SPALL))
            .mul(coarse);
          col.assign(mix(col, col.mul(vec3(0.8, 0.78, 0.74)).mul(jag.mul(0.12).add(1)), spall));
          height.subAssign(spall.mul(0.8));
          If(fine.greaterThan(0.001), () => {
            // Corner crack: the diagonal dx + dy = L from a random corner, jagged.
            const corner = vec2(step(0.5, r(1)), step(0.5, r(2))).mul(2.955);
            const dc = abs(lm.sub(corner));
            const reach = r(3).mul(0.6).add(0.3);
            const dCorner = abs(dc.x.add(dc.y).sub(reach).add(jag.mul(0.03))).mul(0.7071);
            const cornerCrack = lineAt(dCorner, 0.002, aa).mul(step(r(4), BAY_CORNER_CRACK));
            // Crack across the bay, along x or y, wandering a few centimetres.
            const across = mix(lm.y, lm.x, step(0.5, r(5)));
            const dMid = abs(across.sub(r(6).mul(1.4).add(0.8)).add(jag.mul(0.04)));
            const midCrack = lineAt(dMid, 0.002, aa).mul(step(r(7), BAY_MID_CRACK));
            const crack = max(cornerCrack, midCrack).mul(fine);
            col.assign(col.mul(oneMinus(crack.mul(0.6))));
            height.subAssign(crack.mul(0.5));
          });
          out.assign(vec4(col, height));
        });
        return out;
      })();
    const w = concreteWear(float(1));
    concrete.colorNode = w.xyz;
    concrete.normalNode = wearNormal(w.w);
  }
  decal(concrete, -1);

  // Surface car park: worn asphalt, a little lighter than the streets.
  const parkingLot = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  parkingLot.colorNode = vec3(0.25, 0.26, 0.28).mul(
    float(0.88).add(mx_noise_float(wp.mul(0.8)).mul(0.14)),
  );
  decal(parkingLot, -1);

  // Playground safety surface: poured rubber in two colours.
  const playground = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  {
    const blob = step(0.55, mx_noise_float(wp.mul(0.18)).mul(0.5).add(0.5));
    const grain = float(0.9).add(mx_noise_float(wp.mul(9)).mul(0.1));
    playground.colorNode = mix(vec3(0.55, 0.22, 0.17), vec3(0.2, 0.42, 0.3), blob).mul(grain);
  }
  decal(playground, -1);

  // Sports turf (a stadium pitch, a halı saha): even, well-kept green.
  const pitch = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  pitch.colorNode = vec3(0.13, 0.32, 0.1).mul(
    float(0.92).add(mx_noise_float(wp.mul(0.8)).mul(0.08)),
  );
  decal(pitch, -1);
  // Running track: red-brown tartan.
  const track = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  track.colorNode = vec3(0.5, 0.17, 0.11).mul(float(0.94).add(mx_noise_float(wp.mul(3)).mul(0.06)));
  decal(track, -1);

  // Cemetery ground: dark brown earth between the graves, mostly, with
  // patches of green (grass, ivy under the trees) and the odd pale gravel path.
  const cemetery = new THREE.MeshStandardNodeMaterial({ roughness: 0.97, metalness: 0 });
  {
    const green = smoothstep(0.5, 0.72, mx_noise_float(wp.mul(0.09)).mul(0.5).add(0.5)).mul(
      smoothstep(0.35, 0.65, mx_noise_float(wp.mul(0.6).add(7)).mul(0.5).add(0.5)),
    );
    const clods = float(0.84).add(mx_noise_float(wp.mul(3.5)).mul(0.16));
    const soil = mix(
      vec3(0.3, 0.22, 0.15),
      vec3(0.37, 0.28, 0.19),
      mx_noise_float(wp.mul(0.25)).mul(0.5).add(0.5),
    );
    const grass = vec3(0.24, 0.31, 0.15).mul(float(0.88).add(mx_noise_float(wp.mul(5)).mul(0.12)));
    cemetery.colorNode = mix(soil.mul(clods), grass, green.mul(0.85));
  }
  decal(cemetery, -1);
  // Building site: bare worked soil, darker where it is damp or freshly dug,
  // wheel ruts here and there.
  const earth = new THREE.MeshStandardNodeMaterial({ roughness: 0.98, metalness: 0 });
  {
    const damp = smoothstep(0.45, 0.75, mx_noise_float(wp.mul(0.08)).mul(0.5).add(0.5));
    const clods = float(0.86).add(mx_noise_float(wp.mul(3)).mul(0.14));
    const rut = step(0.93, fract(wp.x.add(mx_noise_float(wp.mul(0.05)).mul(6)).div(2.6))).mul(
      smoothstep(0.55, 0.7, mx_noise_float(wp.mul(0.03).add(5)).mul(0.5).add(0.5)),
    );
    const soil = mix(vec3(0.55, 0.45, 0.33), vec3(0.4, 0.32, 0.24), damp).mul(clods);
    earth.colorNode = mix(soil, soil.mul(0.72), rut);
  }
  decal(earth, -1);
  // Quarry floor: broken pale limestone and dust, rubble in heaps.
  const quarry = new THREE.MeshStandardNodeMaterial({ roughness: 0.96, metalness: 0 });
  {
    const heap = smoothstep(0.5, 0.8, mx_noise_float(wp.mul(0.06)).mul(0.5).add(0.5));
    const rubble = float(0.84).add(mx_noise_float(wp.mul(2.4)).mul(0.16));
    quarry.colorNode = mix(vec3(0.76, 0.73, 0.66), vec3(0.62, 0.58, 0.5), heap).mul(rubble);
  }
  decal(quarry, -1);
  // Substation yard: crushed grey stone.
  const gravel = new THREE.MeshStandardNodeMaterial({ roughness: 0.97, metalness: 0 });
  gravel.colorNode = vec3(0.57, 0.57, 0.55).mul(
    float(0.86).add(mx_noise_float(wp.mul(5)).mul(0.14)),
  );
  decal(gravel, -1);
  // Runway / taxiway: dark grooved asphalt, rubber deposits darker in the middle.
  const airfield = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  {
    const patch = mx_noise_float(wp.mul(0.05)).mul(0.5).add(0.5);
    const grain = float(0.9).add(mx_noise_float(wp.mul(4)).mul(0.1));
    airfield.colorNode = mix(vec3(0.3, 0.31, 0.32), vec3(0.22, 0.23, 0.24), patch).mul(grain);
  }
  decal(airfield, -1);

  // One draw per ground chunk: surface kind comes from the `surf` vertex attribute
  // (0 asphalt, 1 paving, 2 sidewalk, 3 path, 4 island, 5 yard, 6 kerb,
  // 7 concrete, 8 car park, 9 playground, 10 pitch, 11 track, 12 cemetery, 13 earth, 14 quarry, 15 gravel, 16 airfield).
  const ground = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  {
    const surf = attribute<'float'>('surf', 'float');
    const isKind = (k: number) => step(k - 0.5, surf).mul(step(surf, k + 0.5));
    const kinds = [
      asphalt,
      paving,
      sidewalk,
      path,
      island,
      yard,
      curb,
      concrete,
      parkingLot,
      playground,
      pitch,
      track,
      cemetery,
      earth,
      quarry,
      gravel,
      airfield,
    ];
    // Worn surfaces gate their wear by their own kind, so the other kinds'
    // fragments skip it; the relief of each is 0 off its kind.
    const worn = new Map<number, Vec4Node>([
      [0, asphaltWear(isKind(0))],
      [2, sidewalkWear(isKind(2))],
      [7, concreteWear(isKind(7))],
    ]);
    const c = kinds
      .map((m, k) => vec3((worn.get(k)?.xyz ?? m.colorNode) as never).mul(isKind(k)))
      .reduce((a, b) => a.add(b));
    const r = kinds.map((m, k) => float(m.roughness).mul(isKind(k))).reduce((a, b) => a.add(b));
    ground.colorNode = c;
    ground.roughnessNode = r;
    ground.normalNode = wearNormal(
      [...worn.values()].map((w) => w.w).reduce((a, b) => a.add(b)) as FloatNode,
    );
  }
  decal(ground, -2);

  const marking = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
  marking.colorNode = vec3(0.86, 0.86, 0.82).mul(
    float(0.85).add(mx_noise_float(wp.mul(4)).mul(0.15)),
  );
  decal(marking, -4);
  // Taxiway centrelines: airfield yellow.
  const markingYellow = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
  markingYellow.colorNode = vec3(0.86, 0.64, 0.1).mul(
    float(0.85).add(mx_noise_float(wp.mul(4)).mul(0.15)),
  );
  decal(markingYellow, -4);

  // Rail bed: ballast, grey-brown crushed stone; a tram's bed is concrete
  // (the `rb` attribute: 0 ballast, 1 concrete).
  const railBed = new THREE.MeshStandardNodeMaterial({ roughness: 0.98, metalness: 0 });
  {
    const rb = attribute<'float'>('rb', 'float');
    const stone = vec3(0.47, 0.44, 0.4).mul(float(0.8).add(mx_noise_float(wp.mul(7)).mul(0.2)));
    const slab = vec3(0.6, 0.59, 0.56).mul(float(0.9).add(mx_noise_float(wp.mul(0.8)).mul(0.1)));
    railBed.colorNode = mix(stone, slab, rb);
  }
  decal(railBed, -1);
  // Sleepers: concrete ties every 0.6 m along the track (uv.x in metres along),
  // the ballast showing between them.
  const railTies = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  {
    const along = uv().x;
    const tie = step(fract(along.div(0.6)), float(0.42));
    const stone = vec3(0.42, 0.39, 0.35).mul(float(0.8).add(mx_noise_float(wp.mul(7)).mul(0.2)));
    railTies.colorNode = mix(stone, vec3(0.62, 0.61, 0.58), tie);
  }
  decal(railTies, -2);
  // Thin rail heads and webs: drawn from both sides.
  const railSteel = new THREE.MeshStandardNodeMaterial({
    roughness: 0.35,
    metalness: 0.7,
    side: THREE.DoubleSide,
  });
  railSteel.colorNode = vec3(0.45, 0.42, 0.4);

  // Terrain: grass / dry grass / bare soil by noise, rock on steep slopes, sand at the shore.
  const terrain = new THREE.MeshStandardNodeMaterial({ roughness: 0.97, metalness: 0 });
  {
    // Ground colour baked per vertex, parcel by parcel as on satellite imagery
    // (landcover.ts); the shader adds only its fine grain — tufts, stones,
    // wheel tracks — at street scale. No large noise patches: the parcels are
    // the patches.
    const n1 = mx_noise_float(wp.mul(0.03)).mul(0.5).add(0.5);
    const n2 = mx_noise_float(wp.mul(0.25)).mul(0.5).add(0.5);
    const n3 = mx_noise_float(wp.mul(2.2));
    const n4 = mx_noise_float(wp.mul(9));
    // The tile's ground picture in the atlas (tiles are 1000 m, inside the
    // slot's padding); −1: plain open land.
    const gslot = attribute<'float'>('gslot', 'float');
    const inTile = clamp(
      vec2(positionGeometry.x, positionGeometry.z.negate()).div(1000),
      0.5 / GROUND_INNER,
      1 - 0.5 / GROUND_INNER,
    )
      .mul(GROUND_INNER)
      .add(GROUND_PAD)
      .div(GROUND_SIZE);
    const slotAt = vec2(gslot.mod(GROUND_GRID), floor(gslot.div(GROUND_GRID)));
    const picture = groundAtlas.sample(slotAt.add(inTile).div(GROUND_GRID)).rgb;
    let g = select(gslot.lessThan(0), vec3(openLand), picture).mul(n2.sub(0.5).mul(0.08).add(1));
    const slope = oneMinus(normalWorld.y);
    g = mix(g, vec3(0.45, 0.43, 0.4), smoothstep(0.35, 0.6, slope));
    // Cliff faces (sharpened coasts, mapped cliffs): bedded limestone /
    // travertine — beige and ochre beds, wavy with noise, dark joints.
    const bed = fract(wp.y.div(1.7).add(n1.mul(1.4)).add(n3.mul(0.12)));
    const strata = mix(vec3(0.5, 0.4, 0.29), vec3(0.38, 0.3, 0.21), smoothstep(0.35, 0.65, bed));
    const joint = smoothstep(0.9, 0.98, bed).add(smoothstep(0.82, 0.95, n2).mul(0.35));
    const rock = mix(strata, vec3(0.2, 0.17, 0.13), clamp(joint, 0, 1).mul(0.7));
    g = mix(g, rock, smoothstep(0.42, 0.58, slope));
    // Sand only on the waterline (low-lying city ground near the sea is not a beach).
    const shore = smoothstep(1.0, 0.3, wp.y);
    g = mix(g, vec3(0.62, 0.57, 0.45), shore);
    // Ground footprint of a pixel (m): a noise octave finer than about two
    // pixels only shimmers as the camera moves (the "crackle" on the terrain
    // at a grazing view, 2026-10-12), so it fades out instead.
    const footprint = fwidth(wp.x).add(fwidth(wp.y)).add(fwidth(wp.z));
    const octave = (freq: number) => oneMinus(smoothstep(0.25, 0.6, footprint.mul(freq)));
    const k3 = octave(2.2);
    const k4 = octave(9);
    terrain.colorNode = g.mul(n3.mul(0.1).mul(k3).add(n4.mul(0.06).mul(k4)).add(1));
    // Grass clumps and tussocks catch the low sun.
    terrain.normalNode = bumpedNormal(
      n2.mul(0.6).mul(octave(0.25)).add(n3.mul(0.3).mul(k3)).add(n4.mul(0.15).mul(k4)),
      0.9,
      120,
    );
  }

  // Empty ground (an area without city data yet): a neutral grey grid, the
  // blank level of a game editor — 10 m checker cells, 1 m minor lines that
  // fade out with distance (no moiré), 10 m major lines.
  const terrainGrid = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  {
    const line = (u: ReturnType<typeof float>, cell: number, half: number) => {
      const d = abs(fract(u.div(cell).add(0.5)).sub(0.5)).mul(cell);
      return oneMinus(smoothstep(float(half), fwidth(u).add(half), d));
    };
    const blur = fwidth(wp.x).add(fwidth(wp.z));
    const minor = max(line(wp.x, 1, 0.012), line(wp.z, 1, 0.012)).mul(
      oneMinus(smoothstep(0.08, 0.35, blur)),
    );
    const major = max(line(wp.x, 10, 0.035), line(wp.z, 10, 0.035)).mul(
      oneMinus(smoothstep(1.5, 6, blur)),
    );
    const checker = step(
      0.5,
      fract(
        floor(wp.x.div(10))
          .add(floor(wp.z.div(10)))
          .mul(0.5),
      ),
    );
    const base = mix(vec3(0.34, 0.34, 0.35), vec3(0.3, 0.3, 0.31), checker);
    terrainGrid.colorNode = mix(
      mix(base, vec3(0.25, 0.25, 0.26), minor.mul(0.6)),
      vec3(0.17, 0.17, 0.18),
      major.mul(0.85),
    );
  }

  const water = new THREE.MeshStandardNodeMaterial({
    roughness: 0.12,
    metalness: 0.05,
    transparent: true,
  });
  {
    const ripple = mx_noise_float(vec3(wp.x.mul(0.12), wp.z.mul(0.12), time.mul(0.25)))
      .mul(0.5)
      .add(0.5);
    const glint = smoothstep(
      0.78,
      0.95,
      mx_noise_float(vec3(wp.x.mul(0.6), wp.z.mul(0.6), time.mul(0.8))),
    );
    water.colorNode = mix(vec3(0.03, 0.12, 0.16), vec3(0.06, 0.2, 0.24), ripple);
    water.emissiveNode = skyTint
      .mul(fresnel(4).mul(0.7).add(glint.mul(0.2)))
      .mul(day.mul(0.9).add(0.1));
    water.opacityNode = float(0.93).mul(groundFade);
  }

  const prop = new THREE.MeshStandardNodeMaterial({
    roughness: 0.7,
    metalness: 0.05,
    vertexColors: true,
  });

  const roofClutter = new THREE.MeshStandardNodeMaterial({
    roughness: 0.62,
    metalness: 0.05,
    vertexColors: true,
  });
  {
    const lp4 = attribute<'vec4'>('lp', 'vec4');
    const lp = lp4.xyz;
    const ck = lp4.w;
    const base = vertexColor().rgb;
    const seed = hash(instanceIndex.add(5));
    // Grime that differs per unit: value noise in model space, offset per instance.
    const grime = mx_noise_float(lp.mul(7).add(seed.mul(40)))
      .mul(0.5)
      .add(0.5);
    const line = (v: ReturnType<typeof float>, period: number, width: number) =>
      step(1 - width, fract(v.div(period)));

    // 1 · AC unit (0.8 × 0.56 × 0.28 m, front face at z = 0.28).
    const front = step(0.275, lp.z);
    const fan = lp.xy.sub(vec3(-0.12, 0, 0).xy);
    const r = fan.length();
    const inFan = oneMinus(smoothstep(0.19, 0.2, r));
    const wires = line(r, 0.028, 0.22).mul(inFan);
    const spokes = max(
      oneMinus(smoothstep(0.006, 0.012, abs(fan.x))),
      oneMinus(smoothstep(0.006, 0.012, abs(fan.y))),
    ).mul(inFan);
    const hub = oneMinus(smoothstep(0.03, 0.036, r));
    const louvreZone = step(0.12, lp.x)
      .mul(step(lp.x, 0.36))
      .mul(step(abs(lp.y), 0.22));
    const louvres = line(lp.y, 0.034, 0.32).mul(louvreZone);
    const seam = oneMinus(smoothstep(0.003, 0.007, abs(lp.x.sub(0.09))));
    const bevel = smoothstep(0, 0.018, min(float(0.4).sub(abs(lp.x)), float(0.28).sub(abs(lp.y))));
    let ac = mix(base, vec3(0.13, 0.14, 0.15), inFan.mul(0.92));
    ac = mix(ac, vec3(0.55, 0.56, 0.56), max(wires, spokes).mul(0.85));
    ac = mix(ac, vec3(0.42, 0.43, 0.44), hub);
    ac = mix(ac, base.mul(0.55), max(louvres, seam).mul(front));
    ac = mix(base.mul(0.82), ac, front);
    // Side vents (horizontal slots) and the seams along the edges.
    const sideVent = line(lp.y, 0.04, 0.3)
      .mul(step(0.395, abs(lp.x)))
      .mul(oneMinus(front));
    ac = mix(ac, base.mul(0.6), sideVent);
    ac = ac.mul(mix(float(0.72), float(1), bevel.mul(front).add(oneMinus(front))));
    // Rust-brown drip below the unit and dust settled on the lower part.
    ac = mix(ac, ac.mul(vec3(0.78, 0.7, 0.6)), smoothstep(-0.05, -0.28, lp.y).mul(grime).mul(0.6));

    // 2 · Satellite dish (dish centre at (0, 0.75, 0.05)): rings, a darker rim, weathered spots.
    const dr = lp.sub(vec3(0, 0.75, 0.05)).length();
    const dishRing = line(dr, 0.07, 0.12).mul(step(dr, 0.4));
    const rim = smoothstep(0.36, 0.4, dr);
    let dish = mix(base, base.mul(0.78), dishRing.mul(0.6));
    dish = mix(dish, base.mul(0.62), rim);
    dish = dish.mul(mix(float(0.86), float(1.04), grime));

    // 3 · Chimney (0.78 m box up to 2.3 m): weathered plaster, rain streaks
    // from under the cap, a darker damp band at the foot, soot near the top.
    const plaster = mx_noise_float(lp.mul(3.1).add(seed.mul(17)))
      .mul(0.5)
      .add(0.5);
    const along = lp.x.add(lp.z);
    let chimney = base.mul(mix(float(0.88), float(1.04), plaster));
    const streak = line(along.add(hash(floor(along.mul(9))).mul(0.3)), 0.11, 0.18)
      .mul(smoothstep(1.0, 2.25, lp.y))
      .mul(step(lp.y, 2.29));
    chimney = mix(chimney, chimney.mul(0.7), streak.mul(0.45));
    chimney = mix(chimney, chimney.mul(0.78), oneMinus(smoothstep(0.2, 0.7, lp.y)).mul(0.6));
    chimney = mix(chimney, vec3(0.13, 0.12, 0.11), smoothstep(1.8, 2.32, lp.y).mul(0.5));

    // 4 · Solar water heater: vacuum tubes on the dark panel, straps on the tank.
    const panel = step(luminance(base), 0.2);
    const tubes = line(lp.x, 0.085, 0.45);
    let solar = mix(base, mix(base.mul(0.55), vec3(0.34, 0.4, 0.5), tubes), panel);
    const strap = oneMinus(smoothstep(0.015, 0.025, abs(abs(lp.x).sub(0.52))))
      .mul(step(1.0, lp.y))
      .mul(oneMinus(panel));
    solar = mix(solar, vec3(0.45, 0.46, 0.47), strap);
    solar = mix(solar, solar.mul(vec3(0.85, 0.78, 0.66)), grime.mul(0.35).mul(oneMinus(panel)));

    roofClutter.colorNode = select(
      ck.lessThan(1.5),
      ac,
      select(ck.lessThan(2.5), dish, select(ck.lessThan(3.5), chimney, solar)),
    );
  }

  const fence = new THREE.MeshStandardNodeMaterial({
    roughness: 0.85,
    metalness: 0,
    vertexColors: true,
    side: THREE.DoubleSide,
    alphaTest: 0.5,
  });
  {
    const fk = attribute<'float'>('fk', 'float');
    const is = (k: number) => step(k - 0.5, fk).mul(step(fk, k + 0.5));
    const a = uv().x;
    const h = uv().y;
    const base = vertexColor().rgb;
    const n = mx_noise_float(positionWorld.mul(1.7)).mul(0.5).add(0.5);
    // 0 plaster: stains and a damp band at the foot.
    const plaster = base
      .mul(mix(float(0.86), float(1.04), n))
      .mul(mix(float(0.8), float(1), smoothstep(0, 0.35, h)));
    // 1 stone: random courses of rough blocks with dark joints.
    const course = floor(h.div(0.28));
    const sx = a.div(0.45).add(hash(course).mul(0.7));
    const stoneJoint = max(step(0.9, fract(h.div(0.28))), step(0.92, fract(sx)));
    const stone = mix(
      vec3(0.62, 0.57, 0.5).mul(float(0.8).add(hash(floor(sx).add(course.mul(41))).mul(0.3))),
      vec3(0.32, 0.3, 0.27),
      stoneJoint,
    );
    // 2 hedge: clumps of dark and light leaves.
    const leaf = mx_noise_float(positionWorld.mul(4.5)).mul(0.5).add(0.5);
    const hedge = mix(vec3(0.12, 0.2, 0.08), vec3(0.26, 0.36, 0.13), leaf).mul(
      float(0.8).add(mx_noise_float(positionWorld.mul(0.6)).mul(0.25)),
    );
    // 3 railing: vertical bars every 12 cm between rails (cut out between).
    const bar = step(0.72, fract(a.div(0.12)));
    const rails = max(step(fract(h), 0.06), step(0.94, fract(h)));
    // 4 mesh: diamond wire mesh (cut out between the wires).
    const d1 = fract(a.add(h).div(0.07));
    const d2 = fract(a.sub(h).div(0.07));
    const wire = max(step(0.86, d1), step(0.86, d2));
    const metal = base;
    fence.colorNode = plaster
      .mul(is(0).add(is(6)))
      .add(stone.mul(is(1)))
      .add(hedge.mul(is(2)))
      .add(metal.mul(is(3).add(is(4)).add(is(5))));
    fence.roughnessNode = mix(float(0.85), float(0.45), is(3).add(is(4)).add(is(5)));
    // Under the alpha test once the ground fades: fences give way to the pipes.
    fence.opacityNode = float(1)
      .sub(is(3).mul(oneMinus(max(bar, rails))))
      .sub(is(4).mul(oneMinus(wire)))
      .mul(groundFade);
  }

  const lampGlow = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0 });
  lampGlow.colorNode = vec3(0.85, 0.85, 0.8);
  lampGlow.emissiveNode = vec3(1.0, 0.8, 0.5).mul(night.mul(6));

  // Warm pools of light on the ground under street lamps (night only).
  const lampPool = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  lampPool.blending = THREE.AdditiveBlending;
  {
    const r = uv().sub(0.5).length().mul(2);
    const falloff = pow(clamp(oneMinus(r), 0, 1), 2.2);
    lampPool.colorNode = vec3(1.0, 0.72, 0.4).mul(falloff).mul(night).mul(0.55);
  }
  decal(lampPool, -6);

  const airfieldLight = airfieldLightMaterial(night);

  // ─── Holograms (data view) ────────────────────────────────────────────────
  const holo = (tint: THREE.Color, strength: number) => {
    const m = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    m.blending = THREE.AdditiveBlending;
    const scan = smoothstep(0.35, 0.5, fract(wp.y.mul(2.2).sub(time.mul(0.6)))).mul(0.35);
    const flicker = sin(time.mul(7)).mul(0.04).add(0.96);
    m.colorNode = color(tint)
      .mul(fresnel(1.6).mul(1.4).add(0.25).add(scan))
      .mul(flicker)
      .mul(strength);
    m.opacityNode = float(0.9);
    return m;
  };
  const holoSynthetic = holo(new THREE.Color(0.25, 0.85, 1.0), 0.9);
  const holoSuggested = holo(new THREE.Color(1.0, 0.68, 0.18), 1.2);
  const holoBuilding = holo(new THREE.Color(0.3, 0.6, 1.0), 0.11);
  // Underground view: buildings barely there, so the networks under them lead.
  const holoGhost = holo(new THREE.Color(0.3, 0.6, 1.0), 0.035);

  const tunnelDark = new THREE.MeshBasicNodeMaterial();
  tunnelDark.colorNode = vec3(0.015, 0.016, 0.018);

  const tunnelWall = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0 });
  {
    // Height above the tube's road is not known per pixel; the panel band is
    // found from the world height relative to a 1.2 × 0.6 m panel grid along
    // the wall, and the vertex colour carries the zone (light panels / dark top).
    const along = positionWorld.x.add(positionWorld.z);
    const joint = max(
      step(0.97, fract(along.div(1.2))),
      step(0.95, fract(positionWorld.y.div(0.6))),
    );
    const panel = mix(float(1), float(0.72), joint).mul(
      float(0.96).add(
        hash(floor(along.div(1.2)).add(floor(positionWorld.y.div(0.6)).mul(31))).mul(0.06),
      ),
    );
    tunnelWall.colorNode = vertexColor().rgb.mul(panel);
  }
  const tunnelGlow = new THREE.MeshBasicNodeMaterial();
  tunnelGlow.colorNode = vertexColor().rgb;
  const tunnelFixture = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.2 });
  tunnelFixture.colorNode = vertexColor().rgb;

  const fix = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  fix.colorNode = vec3(1.0, 0.16, 0.12);
  fix.opacityNode = sin(time.mul(3.2)).mul(0.14).add(0.46).add(fresnel(2).mul(0.3));

  // ─── Buried networks (underground view) ───────────────────────────────────
  const utility = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0.1 });
  {
    const vc = vertexColor().rgb;
    const ua = attribute<'float'>('ua', 'float');
    // Pulses one every 8 m, moving 1.6 m/s: the network reads as live.
    const pulse = smoothstep(0.82, 1.0, fract(ua.div(8).sub(time.mul(0.2))));
    utility.colorNode = vc.mul(0.55);
    utility.emissiveNode = vc.mul(fresnel(2).mul(1.4).add(0.9).add(pulse.mul(2.4)));
  }
  const utilityCover = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.55 });
  {
    // Raised grip pattern of a cast-iron cover.
    const grip = step(
      0.55,
      fract(wp.x.mul(14))
        .add(fract(wp.z.mul(14)))
        .mul(0.5),
    );
    utilityCover.colorNode = vertexColor().rgb.mul(mix(float(0.8), float(1.12), grip));
  }
  decal(utilityCover, -1);

  // The ground fades (see setUnderground): its opacity follows groundFade.
  for (const m of [
    terrain,
    terrainGrid,
    ground,
    marking,
    markingYellow,
    railBed,
    railTies,
    yard,
    asphalt,
    sidewalk,
    paving,
    path,
    curb,
    island,
    retaining,
  ])
    m.opacityNode = groundFade;

  const all = [
    wall,
    trim,
    glass,
    glassWide,
    glassSingle,
    shopGlass,
    frame,
    roofTile,
    roofFlat,
    railGlass,
    railMetal,
    glazed,
    sign,
    asphalt,
    sidewalk,
    paving,
    path,
    curb,
    retaining,
    island,
    yard,
    ground,
    marking,
    markingYellow,
    railBed,
    railTies,
    railSteel,
    terrain,
    terrainGrid,
    water,
    prop,
    roofClutter,
    fence,
    lampGlow,
    holoSynthetic,
    holoSuggested,
    holoBuilding,
    holoGhost,
    fix,
    lampPool,
    airfieldLight,
    tunnelDark,
    tunnelWall,
    tunnelGlow,
    tunnelFixture,
    utility,
    utilityCover,
  ];

  return {
    night,
    scenarioOn,
    scenario,
    skyTint,
    wall,
    trim,
    glass,
    glassWide,
    glassSingle,
    shopGlass,
    frame,
    roofTile,
    roofFlat,
    railGlass,
    railMetal,
    glazed,
    sign,
    asphalt,
    sidewalk,
    paving,
    path,
    curb,
    retaining,
    island,
    yard,
    ground,
    marking,
    markingYellow,
    railBed,
    railTies,
    railSteel,
    terrain,
    terrainGrid,
    water,
    prop,
    roofClutter,
    fence,
    lampGlow,
    lampPool,
    airfieldLight,
    tunnelDark,
    tunnelWall,
    tunnelGlow,
    tunnelFixture,
    holoSynthetic,
    holoSuggested,
    holoBuilding,
    holoGhost,
    fix,
    utility,
    utilityCover,
    groundFade,
    groundAtlas,
    openLand,
    dispose: () => {
      all.forEach((m) => {
        disposeVariants(m);
        m.dispose();
      });
      scenario.dispose();
    },
  };
}

/** Ground materials faded in the underground view. */
const FADED: (keyof DtMaterials)[] = [
  'terrain',
  'terrainGrid',
  'ground',
  'marking',
  'yard',
  'asphalt',
  'sidewalk',
  'paving',
  'path',
  'curb',
  'island',
  'retaining',
  'water',
  'fence',
];
const UNDERGROUND_OPACITY = 0.16;

/**
 * Underground view: the ground turns to a faint see-through skin (no depth
 * writes, so the pipes under it show) — or back to solid.
 */
export function setUnderground(mats: DtMaterials, on: boolean): void {
  mats.groundFade.value = on ? UNDERGROUND_OPACITY : 1;
  for (const key of FADED) {
    const m = mats[key] as THREE.Material;
    const saved = (m.userData.solid ??= { transparent: m.transparent, depthWrite: m.depthWrite });
    m.transparent = on || saved.transparent;
    m.depthWrite = on ? false : saved.depthWrite;
    m.needsUpdate = true;
  }
}
