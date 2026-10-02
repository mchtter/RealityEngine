import {
  abs,
  attribute,
  cameraPosition,
  clamp,
  color,
  dot,
  float,
  floor,
  fract,
  hash,
  instanceIndex,
  int,
  ivec2,
  luminance,
  mat4,
  materialColor,
  max,
  mix,
  mx_noise_float,
  normalLocal,
  normalize,
  normalWorld,
  oneMinus,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  step,
  textureLoad,
  time,
  transformNormal,
  uniform,
  uv,
  vec3,
  vec4,
  vertexColor,
  vertexStage,
} from 'three/tsl';
import * as THREE from 'three/webgpu';

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
  island: THREE.MeshStandardNodeMaterial;
  /** All road / yard surfaces and kerbs of a ground chunk in one mesh (`surf` attribute picks the pattern). */
  ground: THREE.MeshStandardNodeMaterial;
  yard: THREE.MeshStandardNodeMaterial;
  marking: THREE.MeshStandardNodeMaterial;
  terrain: THREE.MeshStandardNodeMaterial;
  water: THREE.MeshStandardNodeMaterial;
  prop: THREE.MeshStandardNodeMaterial;
  lampGlow: THREE.MeshStandardNodeMaterial;
  lampPool: THREE.MeshBasicNodeMaterial;
  holoSynthetic: THREE.MeshBasicNodeMaterial;
  holoSuggested: THREE.MeshBasicNodeMaterial;
  holoBuilding: THREE.MeshBasicNodeMaterial;
  fix: THREE.MeshBasicNodeMaterial;
  dispose(): void;
}

const viewDir = () => normalize(cameraPosition.sub(positionWorld));
const fresnel = (power: number) =>
  pow(oneMinus(clamp(abs(dot(viewDir(), normalWorld)), 0, 1)), power);

function decal(material: THREE.Material, factor: number): void {
  material.polygonOffset = true;
  material.polygonOffsetFactor = factor;
  material.polygonOffsetUnits = factor;
}

export function createMaterials(): DtMaterials {
  const night = uniform(0);
  const skyTint = uniform(new THREE.Color(0.55, 0.68, 0.85));
  const day = oneMinus(night);

  // ─── Scenario colouring of building shells ───────────────────────────────
  // One texture for every loaded tile keeps a single shader build per material.
  const scenarioOn = uniform(0);
  const scenario = new THREE.DataTexture(
    new Uint8Array(SCENARIO_TEXTURE_WIDTH * SCENARIO_TEXTURE_HEIGHT * 4),
    SCENARIO_TEXTURE_WIDTH,
    SCENARIO_TEXTURE_HEIGHT,
  );
  scenario.magFilter = THREE.NearestFilter;
  scenario.minFilter = THREE.NearestFilter;
  scenario.needsUpdate = true;
  /** Saturation kept by buildings without scenario data (1 = their own colours). */
  const SCENARIO_REST_SATURATION = 0.2;
  /** How far buildings without scenario data are lifted towards white. */
  const SCENARIO_REST_LIGHTEN = 0.4;
  /**
   * Replaces a shell colour with the building's scenario colour while a
   * scenario is on. Matched buildings (alpha 1) take the data colour, with the
   * original's light / dark pattern showing through; the rest keep their own
   * texture and colour, washed out (20 % saturation) and lifted towards white.
   */
  const scenarioTint = (original: ReturnType<typeof vec3>) => {
    const slot = attribute<'float'>(BUILDING_SLOT, 'float');
    const texel = vertexStage(
      textureLoad(
        scenario,
        ivec2(int(slot.mod(SCENARIO_TEXTURE_WIDTH)), int(floor(slot.div(SCENARIO_TEXTURE_WIDTH)))),
      ),
    );
    const lum = luminance(original);
    const painted = texel.rgb.mul(lum.mul(0.9).add(0.55));
    const rest = mix(
      mix(vec3(lum), original, SCENARIO_REST_SATURATION),
      vec3(1),
      SCENARIO_REST_LIGHTEN,
    );
    return mix(original, mix(rest, painted, step(0.5, texel.a)), scenarioOn);
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
    const pattern = plaster
      .mul(is(0))
      .add(wood.mul(is(1)))
      .add(panel.mul(is(2)))
      .add(stone.mul(is(3)))
      .add(brick.mul(is(4)));
    // Far windows: drawn by the shader on every window bay; near buildings add
    // 3D frames / glass instances on top that cover these exactly.
    const bay = attribute<'vec3'>('bay', 'vec3');
    const fl = attribute<'vec3'>('floorInfo', 'vec3');
    const rel = v.sub(fl.x);
    const local = rel.sub(fl.y.mul(floor(rel.div(fl.y))));
    const inX = step(abs(u.sub(bay.x)), bay.y.mul(0.5)).mul(step(0.01, bay.y));
    const inY = step(0.9, local)
      .mul(step(local, bay.z.add(0.9)))
      .mul(step(fl.x, v))
      .mul(step(v, fl.z));
    const win = inX.mul(inY);
    const lightId = hash(
      bay.x
        .mul(3.7)
        .add(floor(rel.div(fl.y)).mul(17.3))
        .add(fl.x.mul(1.31)),
    );
    wall.colorNode = mix(scenarioTint(vertexColor().rgb.mul(pattern)), vec3(0.07, 0.09, 0.11), win);
    wall.roughnessNode = mix(mix(float(0.92), float(0.75), is(2)), float(0.12), win);
    wall.emissiveNode = vec3(1.0, 0.74, 0.44)
      .mul(night)
      .mul(step(0.62, lightId))
      .mul(win)
      .mul(hash(lightId.mul(9.1)).mul(0.45).add(0.2));
  }

  const trim = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0 });
  trim.colorNode = scenarioTint(vertexColor().rgb);

  // ─── Windows ──────────────────────────────────────────────────────────────
  const curtainTone = hash(instanceIndex.add(11));
  const hasCurtain = step(0.35, hash(instanceIndex.add(3)));
  const lit = step(0.62, hash(instanceIndex.add(7))).mul(night);
  // Window = one quad: frame, centre mullion, inner reveal shadow, curtains
  // and night lighting are all drawn here (2 triangles per window).
  const glass = new THREE.MeshStandardNodeMaterial({ roughness: 0.06, metalness: 0.1 });
  {
    const wu = uv().x;
    const wv = uv().y;
    const frameColor = attribute<'vec3'>('frameColor', 'vec3');
    const fx = 0.06;
    const fy = 0.05;
    const opening = step(fx, wu)
      .mul(step(wu, 1 - fx))
      .mul(step(fy, wv))
      .mul(step(wv, 1 - fy));
    const mullion = step(abs(wu.sub(0.5)), 0.016);
    const frameMask = max(oneMinus(opening), mullion);
    const reveal = smoothstep(fx, fx + 0.07, wu)
      .mul(smoothstep(1 - fx, 1 - fx - 0.07, wu))
      .mul(smoothstep(1 - fy, 1 - fy - 0.1, wv))
      .mul(0.45)
      .add(0.55);
    const folds = sin(wu.mul(70)).mul(0.04).add(0.96);
    const curtain = mix(vec3(0.86, 0.84, 0.78), vec3(0.95, 0.93, 0.9), curtainTone).mul(folds);
    const pane = vec3(0.1, 0.13, 0.15);
    const inside = mix(pane, curtain.mul(0.55), hasCurtain.mul(smoothstep(0.1, 0.25, wv))).mul(
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
  }
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
    roofTile.colorNode = scenarioTint(
      vertexColor().rgb.mul(vec3(tileShade.mul(tileTone).add(moss))),
    );
  }
  const roofFlat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  roofFlat.colorNode = scenarioTint(
    vertexColor().rgb.mul(float(0.92).add(mx_noise_float(positionWorld.mul(2.5)).mul(0.08))),
  );

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

  const glazed = new THREE.MeshStandardNodeMaterial({ roughness: 0.08, metalness: 0.15 });
  {
    const mullion = max(step(0.95, fract(uv().x.div(0.75))), step(0.94, uv().y)).max(
      step(uv().y, 0.04),
    );
    const g = mix(vec3(0.16, 0.22, 0.25), vec3(0.85, 0.85, 0.82), mullion);
    glazed.colorNode = mix(g, vec3(0.8, 0.78, 0.72), hasCurtain.mul(0.25).mul(oneMinus(mullion)));
    glazed.emissiveNode = skyTint
      .mul(fresnel(3).mul(0.45))
      .mul(day)
      .mul(oneMinus(mullion))
      .add(vec3(1, 0.8, 0.5).mul(lit.mul(0.7)).mul(oneMinus(mullion)));
  }

  const sign = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
  sign.emissiveNode = vec3(0.9, 0.85, 0.8).mul(night.mul(0.55));

  // ─── Ground ───────────────────────────────────────────────────────────────
  const wp = positionWorld;
  const asphalt = new THREE.MeshStandardNodeMaterial({ roughness: 0.93, metalness: 0 });
  asphalt.colorNode = vec3(0.13, 0.135, 0.14)
    .mul(
      float(0.88)
        .add(mx_noise_float(wp.mul(0.45)).mul(0.12))
        .add(mx_noise_float(wp.mul(9)).mul(0.05)),
    )
    .add(vec3(0.05).mul(smoothstep(0.35, 0.8, mx_noise_float(wp.mul(0.08)))));
  decal(asphalt, -1);

  const sidewalk = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  {
    const g = wp.xz.div(0.4);
    const edge = max(step(0.94, fract(g.x)), step(0.94, fract(g.y)));
    const tone = hash(floor(g.x).add(floor(g.y).mul(131)))
      .mul(0.12)
      .add(0.94);
    sidewalk.colorNode = mix(vec3(0.6, 0.58, 0.54).mul(tone), vec3(0.4, 0.39, 0.36), edge);
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

  const path = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  path.colorNode = vec3(0.55, 0.52, 0.47).mul(float(0.9).add(mx_noise_float(wp.mul(3)).mul(0.1)));
  decal(path, -2);

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

  // One draw per ground chunk: surface kind comes from the `surf` vertex attribute
  // (0 asphalt, 1 paving, 2 sidewalk, 3 path, 4 island, 5 yard, 6 kerb).
  const ground = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  {
    const surf = attribute<'float'>('surf', 'float');
    const isKind = (k: number) => step(k - 0.5, surf).mul(step(surf, k + 0.5));
    const kinds = [asphalt, paving, sidewalk, path, island, yard, curb];
    const c = kinds
      .map((m, k) => vec3(m.colorNode as never).mul(isKind(k)))
      .reduce((a, b) => a.add(b));
    const r = kinds.map((m, k) => float(m.roughness).mul(isKind(k))).reduce((a, b) => a.add(b));
    ground.colorNode = c;
    ground.roughnessNode = r;
  }
  decal(ground, -2);

  const marking = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
  marking.colorNode = vec3(0.86, 0.86, 0.82).mul(
    float(0.85).add(mx_noise_float(wp.mul(4)).mul(0.15)),
  );
  decal(marking, -4);

  // Terrain: grass / dry grass / bare soil by noise, rock on steep slopes, sand at the shore.
  const terrain = new THREE.MeshStandardNodeMaterial({ roughness: 0.97, metalness: 0 });
  {
    const n1 = mx_noise_float(wp.mul(0.03)).mul(0.5).add(0.5);
    const n2 = mx_noise_float(wp.mul(0.25)).mul(0.5).add(0.5);
    const n3 = mx_noise_float(wp.mul(2.2));
    const grass = mix(vec3(0.24, 0.33, 0.13), vec3(0.37, 0.4, 0.19), n2);
    const dry = vec3(0.55, 0.5, 0.33);
    const soil = vec3(0.42, 0.35, 0.26);
    let g = mix(grass, dry, smoothstep(0.55, 0.85, n1));
    g = mix(g, soil, smoothstep(0.72, 0.9, n2).mul(0.7));
    const slope = oneMinus(normalWorld.y);
    g = mix(g, vec3(0.45, 0.43, 0.4), smoothstep(0.35, 0.6, slope));
    const shore = smoothstep(2.2, 0.6, wp.y);
    g = mix(g, vec3(0.62, 0.57, 0.45), shore);
    terrain.colorNode = g.mul(n3.mul(0.07).add(1));
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
    water.opacityNode = float(0.93);
  }

  const prop = new THREE.MeshStandardNodeMaterial({
    roughness: 0.7,
    metalness: 0.05,
    vertexColors: true,
  });

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

  const fix = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  fix.colorNode = vec3(1.0, 0.16, 0.12);
  fix.opacityNode = sin(time.mul(3.2)).mul(0.14).add(0.46).add(fresnel(2).mul(0.3));

  const all = [
    wall,
    trim,
    glass,
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
    island,
    yard,
    ground,
    marking,
    terrain,
    water,
    prop,
    lampGlow,
    holoSynthetic,
    holoSuggested,
    holoBuilding,
    fix,
    lampPool,
  ];

  return {
    night,
    scenarioOn,
    scenario,
    skyTint,
    wall,
    trim,
    glass,
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
    island,
    yard,
    ground,
    marking,
    terrain,
    water,
    prop,
    lampGlow,
    lampPool,
    holoSynthetic,
    holoSuggested,
    holoBuilding,
    fix,
    dispose: () => {
      all.forEach((m) => {
        disposeVariants(m);
        m.dispose();
      });
      scenario.dispose();
    },
  };
}
