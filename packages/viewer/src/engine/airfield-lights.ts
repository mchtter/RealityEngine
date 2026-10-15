import type { AirfieldLight, AirfieldLightKind } from '@opentwin/city-core';
import {
  atan,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cos,
  exp,
  float,
  fract,
  max,
  mix,
  min,
  modelViewMatrix,
  modelWorldMatrix,
  oneMinus,
  positionLocal,
  select,
  sin,
  smoothstep,
  step,
  time,
  vec2,
  vec3,
  vec4,
  vertexStage,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import { toThree } from './geom';

/** How a light shines: steady, a sequenced flasher, a strobe pair, a PAPI unit. */
const MODE = { steady: 0, flash: 1, reil: 2, papi: 3 } as const;
/** `dir` of a light seen all round. */
const OMNI = 99;

/** Colour (linear, before intensity), lamp radius (m) and mode of each kind. */
const LOOK: Record<
  AirfieldLightKind,
  { color: [number, number, number]; size: number; mode: number }
> = {
  edge: { color: [1, 0.9, 0.72], size: 0.5, mode: MODE.steady },
  'edge-caution': { color: [1, 0.72, 0.12], size: 0.5, mode: MODE.steady },
  center: { color: [0.92, 0.94, 1], size: 0.35, mode: MODE.steady },
  'center-red': { color: [1, 0.07, 0.04], size: 0.35, mode: MODE.steady },
  threshold: { color: [0.12, 1, 0.38], size: 0.55, mode: MODE.steady },
  end: { color: [1, 0.06, 0.04], size: 0.5, mode: MODE.steady },
  tdz: { color: [0.95, 0.95, 1], size: 0.35, mode: MODE.steady },
  approach: { color: [1, 0.88, 0.66], size: 0.6, mode: MODE.steady },
  'approach-flash': { color: [0.85, 0.92, 1], size: 1.1, mode: MODE.flash },
  reil: { color: [0.85, 0.92, 1], size: 1, mode: MODE.reil },
  papi: { color: [1, 1, 1], size: 0.8, mode: MODE.papi },
  'taxi-edge': { color: [0.12, 0.32, 1], size: 0.4, mode: MODE.steady },
  'taxi-center': { color: [0.12, 1, 0.42], size: 0.3, mode: MODE.steady },
  stopbar: { color: [1, 0.05, 0.03], size: 0.4, mode: MODE.steady },
};

/**
 * One mesh for a tile's airfield lights: a quad per light, turned to the
 * camera in the vertex stage (see airfieldLightMaterial). Attributes: the
 * lamp's position, `corner` (quad corner, lamp radius), `lightColor`, and
 * `light` (mode, flash order, PAPI angle, facing).
 */
export function buildAirfieldLights(
  lights: AirfieldLight[],
  groundAt: (x: number, y: number) => number,
  material: unknown,
): THREE.Mesh | null {
  if (!lights.length) return null;
  const n = lights.length;
  const position = new Float32Array(n * 12);
  const corner = new Float32Array(n * 12);
  const color = new Float32Array(n * 12);
  const light = new Float32Array(n * 16);
  const normal = new Float32Array(n * 12);
  const index = new Uint32Array(n * 6);
  const CORNERS = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  lights.forEach((l, i) => {
    const look = LOOK[l.kind];
    const p = toThree(l.at[0], l.at[1], groundAt(l.at[0], l.at[1]) + l.lift);
    for (let c = 0; c < 4; c++) {
      const v = i * 4 + c;
      position.set(p, v * 3);
      corner.set([CORNERS[c][0], CORNERS[c][1], look.size], v * 3);
      color.set(look.color, v * 3);
      light.set([look.mode, l.seq ?? 0, l.angle ?? 0, l.dir ?? OMNI], v * 4);
      normal.set([0, 1, 0], v * 3);
    }
    index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setAttribute('corner', new THREE.BufferAttribute(corner, 3));
  g.setAttribute('lightColor', new THREE.BufferAttribute(color, 3));
  g.setAttribute('light', new THREE.BufferAttribute(light, 4));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  // Quads grow with distance: keep the culling sphere generous.
  g.boundingSphere!.radius += 60;
  const mesh = new THREE.Mesh(g, material as THREE.Material);
  mesh.name = 'airfield-lights';
  mesh.userData.role = 'airfield:lights';
  mesh.renderOrder = 20;
  mesh.frustumCulled = true;
  return mesh;
}

/**
 * Airfield lights at night: each quad faces the camera and never shrinks
 * under a few pixels, so a runway reads as lines of light from kilometres
 * off. Directional lights are seen only from in front; PAPI units show red
 * below their angle and white above; approach flashers fire in sequence
 * toward the threshold twice a second; REIL strobes flash together.
 */
export function airfieldLightMaterial(
  night: THREE.UniformNode<'float', number>,
): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  m.blending = THREE.AdditiveBlending;
  const corner = attribute<'vec3'>('corner', 'vec3');
  const tint = attribute<'vec3'>('lightColor', 'vec3');
  const light = attribute<'vec4'>('light', 'vec4');

  // Billboard in view space at the lamp's own size, so lamps shrink with
  // distance like everything else; never under ~1.5 px (a runway still reads
  // as lines of light from afar, without shimmer), never over 3 m. Pulled
  // toward the camera by its size so the ground does not cut the lower half off.
  const view = modelViewMatrix.mul(vec4(positionLocal, 1));
  const distance = view.z.negate();
  const size = min(max(corner.z, distance.mul(0.0015)), 3);
  m.vertexNode = cameraProjectionMatrix.mul(
    vec4(view.xy.add(corner.xy.mul(size)), view.z.add(size), view.w),
  );

  // Per light (vertex stage): where the camera stands relative to the lamp.
  const lamp = modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz;
  const toEye = cameraPosition.sub(lamp);
  const flat = vec2(toEye.x, toEye.z);
  const facing = light.w;
  // Model heading → three.js (x east, z south).
  const face = vec2(cos(facing), sin(facing).negate());
  const seen = select(
    facing.greaterThan(50),
    float(1),
    // Straight overhead the direction is undefined: no NaN (it would bloom into a blob).
    smoothstep(-0.05, 0.3, flat.div(max(flat.length(), 0.001)).dot(face)),
  );
  const mode = light.x;
  const elevation = atan(toEye.y, flat.length()).mul(180 / Math.PI);
  // PAPI: red below the unit's angle, white above (a short blend across it).
  const papiWhite = smoothstep(light.z.sub(0.04), light.z.add(0.04), elevation);
  const papi = mix(vec3(1, 0.06, 0.03), vec3(1, 0.96, 0.9), papiWhite);
  const isPapi = step(2.5, mode);
  const colour = vertexStage(mix(tint, papi, isPapi));
  // Flashes: a sequenced front every 0.5 s (0.3 s out → in), strobes once a second.
  const cycle = fract(time.mul(2));
  const at = light.y.mul(0.3);
  const flash = step(at, cycle)
    .mul(exp(cycle.sub(at).mul(-45)))
    .mul(16);
  const strobe = exp(fract(time).mul(-28)).mul(14);
  const isFlash = step(0.5, mode).mul(step(mode, 1.5));
  const isReil = step(1.5, mode).mul(step(mode, 2.5));
  const steady = float(1).sub(isFlash).sub(isReil);
  const power = vertexStage(
    steady
      .mul(8)
      .add(isFlash.mul(flash))
      .add(isReil.mul(strobe))
      .mul(seen)
      .mul(night)
      // An airfield reads from far off at night; past 8 km they fade (gone at 15).
      // (smoothstep needs low < high: reversed edges are undefined on the GPU.)
      .mul(oneMinus(smoothstep(8000, 15000, distance))),
  );

  // A bright core and a soft halo (bloom spreads it further).
  const r = corner.xy.length();
  const core = exp(r.mul(r).mul(-14));
  const halo = exp(r.mul(-4)).mul(0.25);
  m.colorNode = colour
    .mul(max(power, 0))
    .mul(core.add(halo))
    .mul(oneMinus(smoothstep(0.8, 1, r)));
  return m;
}
