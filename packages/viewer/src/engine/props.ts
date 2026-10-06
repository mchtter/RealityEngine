import { type Prop, type PropKind, Rng } from '@opentwin/city-core';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three/webgpu';
import { paint, toThree } from './geom';
import type { DtMaterials } from './materials';

const C = (hex: string) => new THREE.Color(hex);

function cyl(
  rt: number,
  rb: number,
  h: number,
  seg: number,
  c: THREE.Color,
  x = 0,
  y = 0,
  z = 0,
  rotX = 0,
  rotZ = 0,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  g.deleteAttribute('uv');
  if (rotX) g.rotateX(rotX);
  if (rotZ) g.rotateZ(rotZ);
  g.translate(x, y, z);
  return paint(g, c);
}

function box(
  w: number,
  h: number,
  d: number,
  c: THREE.Color,
  x = 0,
  y = 0,
  z = 0,
  rotX = 0,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.deleteAttribute('uv');
  if (rotX) g.rotateX(rotX);
  g.translate(x, y, z);
  return paint(g, c);
}

function blob(
  r: number,
  c: THREE.Color,
  x: number,
  y: number,
  z: number,
  sy = 1,
  detail = 1,
): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail);
  g.deleteAttribute('uv');
  g.scale(1, sy, 1);
  g.translate(x, y, z);
  return paint(g, c);
}

const merge = (parts: THREE.BufferGeometry[]) =>
  mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));

/**
 * Low-poly street furniture and roof clutter. Local frame: +y up, +z is the
 * direction the prop faces (towards the road for lamps / stops).
 */
function createPropModules(): Record<PropKind | 'tree-pine', THREE.BufferGeometry> {
  const leaf = C('#4f6b2c');
  const leafDark = C('#3d5623');
  const bark = C('#5b4636');
  const pole = C('#7c8084');
  const darkMetal = C('#2f3336');
  return {
    // Low-poly crowns (icosahedron detail 0): ~100 triangles per tree, thousands per tile.
    tree: merge([
      cyl(0.13, 0.2, 2.8, 5, bark, 0, 1.4, 0),
      blob(1.9, leaf, 0, 4.1, 0, 0.85, 0),
      blob(1.4, leafDark, 0.9, 3.5, 0.4, 0.8, 0),
      blob(1.3, leaf, -0.8, 3.7, -0.5, 0.8, 0),
      blob(1.2, leafDark, 0.1, 5.0, -0.3, 0.8, 0),
    ]),
    'tree-pine': merge([
      cyl(0.14, 0.22, 4.5, 5, bark, 0, 2.25, 0),
      blob(2.4, leafDark, 0, 5.4, 0, 0.45, 0),
      blob(1.6, leaf, 0.8, 5.9, 0.3, 0.45, 0),
      blob(1.5, leafDark, -0.7, 5.8, -0.4, 0.45, 0),
    ]),
    'street-lamp': merge([
      cyl(0.06, 0.1, 8, 8, pole, 0, 4, 0),
      cyl(0.14, 0.16, 0.5, 8, pole, 0, 0.25, 0),
      box(0.07, 0.07, 1.6, pole, 0, 7.85, 0.8),
      box(0.3, 0.12, 0.62, pole, 0, 7.8, 1.55),
    ]),
    'traffic-signal': merge([
      cyl(0.07, 0.08, 3.4, 8, darkMetal, 0, 1.7, 0),
      box(0.34, 1.0, 0.26, C('#1f2124'), 0, 3.2, 0.1),
      blob(0.09, C('#c0392b'), 0, 3.5, 0.24, 1, 0),
      blob(0.09, C('#e6b422'), 0, 3.2, 0.24, 1, 0),
      blob(0.09, C('#2ecc71'), 0, 2.9, 0.24, 1, 0),
    ]),
    'bus-stop': merge([
      box(4, 0.1, 1.6, C('#3f4a55'), 0, 2.55, 0),
      box(4, 1.9, 0.05, C('#8fb3c4'), 0, 1.5, -0.75),
      cyl(0.05, 0.05, 2.5, 6, pole, -1.9, 1.25, -0.7),
      cyl(0.05, 0.05, 2.5, 6, pole, 1.9, 1.25, -0.7),
      cyl(0.05, 0.05, 2.5, 6, pole, -1.9, 1.25, 0.7),
      cyl(0.05, 0.05, 2.5, 6, pole, 1.9, 1.25, 0.7),
      box(2.6, 0.08, 0.45, C('#6b4a36'), 0, 0.48, -0.45),
      box(0.9, 1.4, 0.06, C('#1f5fa8'), 1.3, 1.4, -0.72),
      cyl(0.04, 0.04, 2.8, 6, pole, 2.4, 1.4, 0.8),
      box(0.5, 0.5, 0.04, C('#1f5fa8'), 2.4, 2.7, 0.8),
    ]),
    bench: merge([
      box(1.8, 0.07, 0.45, C('#6b4a36'), 0, 0.45, 0),
      box(1.8, 0.4, 0.06, C('#6b4a36'), 0, 0.75, -0.2),
      box(0.06, 0.45, 0.4, darkMetal, -0.8, 0.22, 0),
      box(0.06, 0.45, 0.4, darkMetal, 0.8, 0.22, 0),
    ]),
    'waste-basket': merge([
      cyl(0.22, 0.2, 0.75, 10, C('#4a5a3a'), 0, 0.5, 0),
      cyl(0.04, 0.04, 0.2, 6, darkMetal, 0, 0.1, 0),
    ]),
    'power-pole': merge([
      cyl(0.1, 0.14, 9, 8, C('#8a8580'), 0, 4.5, 0),
      box(1.8, 0.1, 0.1, C('#5b5650'), 0, 8.4, 0),
    ]),
    // Fibre distribution cabinet: two-door grey steel box on a concrete plinth,
    // vents and the operator's band on the street-facing front (+z).
    'street-cabinet': merge([
      box(0.98, 0.12, 0.52, C('#8d8a84'), 0, 0.06, 0),
      box(0.9, 1.18, 0.42, C('#b9bec2'), 0, 0.71, 0),
      box(0.96, 0.05, 0.48, C('#9aa0a5'), 0, 1.325, 0),
      box(0.012, 0.98, 0.006, darkMetal, 0, 0.66, 0.211),
      box(0.3, 0.07, 0.006, C('#7d8387'), -0.21, 1.06, 0.211),
      box(0.3, 0.07, 0.006, C('#7d8387'), 0.21, 1.06, 0.211),
      box(0.3, 0.07, 0.006, C('#7d8387'), -0.21, 0.3, 0.211),
      box(0.3, 0.07, 0.006, C('#7d8387'), 0.21, 0.3, 0.211),
      box(0.9, 0.05, 0.006, C('#ff8a1f'), 0, 1.21, 0.211),
      box(0.03, 0.08, 0.02, darkMetal, 0.06, 0.72, 0.22),
    ]),
    // Plastered stove flue with a concrete cap and a small rain hood (reference renders).
    chimney: merge([
      box(0.78, 2.3, 0.78, C('#bcb4a8'), 0, 1.15, 0),
      box(0.92, 0.16, 0.92, C('#7d7a75'), 0, 2.38, 0),
      // Flue pot on the cap.
      cyl(0.13, 0.15, 0.3, 8, C('#6d6a66'), 0, 2.6, 0),
    ]),
    // Thermosiphon heater as on Turkish roofs: a white tank on top, the tilted
    // collector in an aluminium frame below it, galvanised A-frame stands.
    'solar-heater': merge([
      cyl(0.25, 0.25, 1.7, 14, C('#e4e4e0'), 0, 1.28, -0.38, 0, Math.PI / 2),
      cyl(0.26, 0.26, 0.05, 14, C('#9ea2a6'), -0.86, 1.28, -0.38, 0, Math.PI / 2),
      cyl(0.26, 0.26, 0.05, 14, C('#9ea2a6'), 0.86, 1.28, -0.38, 0, Math.PI / 2),
      box(1.78, 0.04, 1.2, C('#b4b8bc'), 0, 0.68, 0.22, -0.65),
      box(1.66, 0.05, 1.08, C('#1d2c44'), 0, 0.705, 0.235, -0.65),
      // Stands: front and back posts each side, and the feet on the roof.
      box(0.05, 0.62, 0.05, C('#8a8f94'), -0.82, 0.31, 0.62),
      box(0.05, 0.62, 0.05, C('#8a8f94'), 0.82, 0.31, 0.62),
      box(0.05, 1.28, 0.05, C('#8a8f94'), -0.82, 0.64, -0.38),
      box(0.05, 1.28, 0.05, C('#8a8f94'), 0.82, 0.64, -0.38),
      box(1.7, 0.05, 0.05, C('#8a8f94'), 0, 0.03, 0.62),
      box(1.7, 0.05, 0.05, C('#8a8f94'), 0, 0.03, -0.38),
      // Pipes from the collector up into the tank.
      cyl(0.025, 0.025, 0.5, 6, C('#9ea2a6'), -0.7, 1.05, -0.12),
      cyl(0.025, 0.025, 0.5, 6, C('#9ea2a6'), 0.7, 1.05, -0.12),
    ]),
    'satellite-dish': merge([
      cyl(0.42, 0.3, 0.1, 14, C('#e6e4df'), 0, 0.75, 0.05, Math.PI / 2 - 0.5),
      cyl(0.025, 0.025, 0.75, 5, C('#8a8f94'), 0, 0.37, 0),
      // Feed arm from the lower rim to the LNB at the focus, and the LNB head.
      cyl(0.012, 0.012, 0.52, 5, C('#9a9c9e'), 0, 0.667, 0.295, 0.244),
      box(0.055, 0.055, 0.11, C('#3a3c3e'), 0, 0.918, 0.357, 0.244),
    ]),
    'ac-unit': merge([
      box(0.8, 0.56, 0.28, C('#e9e8e4'), 0, 0, 0.14),
      // Wall brackets under the unit.
      box(0.03, 0.03, 0.32, C('#5a5d60'), -0.3, -0.295, 0.16),
      box(0.03, 0.03, 0.32, C('#5a5d60'), 0.3, -0.295, 0.16),
    ]),
    // Parked car (+z = nose). Painted parts white: the instance tint is the paint.
    car: merge([
      box(1.78, 0.62, 4.3, C('#f2f2f2'), 0, 0.55, 0),
      box(1.6, 0.52, 2.2, C('#1c2126'), 0, 1.12, -0.25),
      box(1.56, 0.06, 1.9, C('#f2f2f2'), 0, 1.41, -0.3),
      box(1.5, 0.12, 0.05, C('#e8e4c8'), 0, 0.72, 2.15),
      box(1.5, 0.1, 0.05, C('#8a1f1f'), 0, 0.75, -2.15),
      cyl(0.33, 0.33, 0.22, 10, C('#16171a'), -0.82, 0.33, 1.38, 0, Math.PI / 2),
      cyl(0.33, 0.33, 0.22, 10, C('#16171a'), 0.82, 0.33, 1.38, 0, Math.PI / 2),
      cyl(0.33, 0.33, 0.22, 10, C('#16171a'), -0.82, 0.33, -1.38, 0, Math.PI / 2),
      cyl(0.33, 0.33, 0.22, 10, C('#16171a'), 0.82, 0.33, -1.38, 0, Math.PI / 2),
    ]),
    // Car park attendant booth: white cabin, window band, flat roof.
    booth: merge([
      box(1.6, 2.3, 1.6, C('#e9e7e1'), 0, 1.15, 0),
      box(1.62, 0.8, 1.62, C('#2a3540'), 0, 1.55, 0),
      box(1.9, 0.12, 1.9, C('#8a8f94'), 0, 2.36, 0),
      box(0.8, 1.9, 0.04, C('#6a7078'), 0.3, 0.95, 0.81),
    ]),
    // Barrier: striped post and arm across the entrance (+x).
    'barrier-arm': merge([
      box(0.32, 1.0, 0.32, C('#e3b321'), 0, 0.5, 0),
      box(0.33, 0.12, 0.33, C('#1f1f1f'), 0, 0.75, 0),
      box(3.6, 0.08, 0.08, C('#e8e8e8'), 1.95, 0.92, 0),
      box(0.5, 0.085, 0.085, C('#c0262d'), 1.0, 0.92, 0),
      box(0.5, 0.085, 0.085, C('#c0262d'), 2.4, 0.92, 0),
      box(0.5, 0.085, 0.085, C('#c0262d'), 3.5, 0.92, 0),
    ]),
    // Playground: painted steel frames, wooden seats and decks.
    swing: merge([
      cyl(0.05, 0.05, 2.3, 6, C('#2e6fb3'), -1.45, 1.15, 0.35),
      cyl(0.05, 0.05, 2.3, 6, C('#2e6fb3'), -1.45, 1.15, -0.35),
      cyl(0.05, 0.05, 2.3, 6, C('#2e6fb3'), 1.45, 1.15, 0.35),
      cyl(0.05, 0.05, 2.3, 6, C('#2e6fb3'), 1.45, 1.15, -0.35),
      box(3.0, 0.09, 0.09, C('#2e6fb3'), 0, 2.28, 0),
      cyl(0.012, 0.012, 1.7, 4, C('#8a8f94'), -0.95, 1.4, 0),
      cyl(0.012, 0.012, 1.7, 4, C('#8a8f94'), -0.45, 1.4, 0),
      cyl(0.012, 0.012, 1.7, 4, C('#8a8f94'), 0.45, 1.4, 0),
      cyl(0.012, 0.012, 1.7, 4, C('#8a8f94'), 0.95, 1.4, 0),
      box(0.55, 0.05, 0.22, C('#c94d2b'), -0.7, 0.52, 0),
      box(0.55, 0.05, 0.22, C('#e3b321'), 0.7, 0.52, 0),
    ]),
    slide: merge([
      box(1.1, 0.08, 1.1, C('#a8754b'), 0, 1.5, -0.9),
      cyl(0.05, 0.05, 1.9, 6, C('#2f8f4e'), -0.5, 0.95, -1.4),
      cyl(0.05, 0.05, 1.9, 6, C('#2f8f4e'), 0.5, 0.95, -1.4),
      cyl(0.05, 0.05, 1.9, 6, C('#2f8f4e'), -0.5, 0.95, -0.4),
      cyl(0.05, 0.05, 1.9, 6, C('#2f8f4e'), 0.5, 0.95, -0.4),
      box(0.5, 0.06, 0.08, C('#2f8f4e'), 0, 0.5, -1.45),
      box(0.5, 0.06, 0.08, C('#2f8f4e'), 0, 1.0, -1.45),
      box(0.62, 0.06, 2.6, C('#e0402e'), 0, 0.8, 0.85, -0.6),
      box(0.06, 0.25, 2.6, C('#e0402e'), -0.3, 0.92, 0.85, -0.6),
      box(0.06, 0.25, 2.6, C('#e0402e'), 0.3, 0.92, 0.85, -0.6),
    ]),
    seesaw: merge([
      box(0.25, 0.45, 0.3, C('#2e6fb3'), 0, 0.22, 0),
      box(0.28, 0.07, 3.2, C('#e3b321'), 0, 0.5, 0, 0.12),
      box(0.45, 0.04, 0.3, C('#c94d2b'), 0, 0.72, -1.35, 0.12),
      box(0.45, 0.04, 0.3, C('#c94d2b'), 0, 0.33, 1.35, 0.12),
    ]),
    climber: merge([
      ...[
        [-0.9, -0.9],
        [0.9, -0.9],
        [-0.9, 0.9],
        [0.9, 0.9],
      ].map(([x, z]) => cyl(0.045, 0.045, 1.9, 6, C('#c94d2b'), x, 0.95, z)),
      ...[0.6, 1.2, 1.85].flatMap((y) => [
        box(1.8, 0.05, 0.05, C('#e3b321'), 0, y, -0.9),
        box(1.8, 0.05, 0.05, C('#e3b321'), 0, y, 0.9),
        box(0.05, 0.05, 1.8, C('#e3b321'), -0.9, y, 0),
        box(0.05, 0.05, 1.8, C('#e3b321'), 0.9, y, 0),
      ]),
      box(1.8, 0.06, 1.8, C('#a8754b'), 0, 1.2, 0),
    ]),
    // Garden gate: two rendered piers with caps and a painted double gate (+z = street).
    gate: merge([
      box(0.42, 1.75, 0.42, C('#d6cdbd'), -1.29, 0.875, 0),
      box(0.42, 1.75, 0.42, C('#d6cdbd'), 1.29, 0.875, 0),
      box(0.52, 0.1, 0.52, C('#8f877b'), -1.29, 1.8, 0),
      box(0.52, 0.1, 0.52, C('#8f877b'), 1.29, 1.8, 0),
      box(2.16, 0.06, 0.05, C('#25302a'), 0, 0.15, 0),
      box(2.16, 0.06, 0.05, C('#25302a'), 0, 1.45, 0),
      box(0.04, 1.36, 0.05, C('#25302a'), 0, 0.8, 0),
      ...Array.from({ length: 14 }, (_, k) => -1.0 + (2.0 * (k + 0.5)) / 14).map((x) =>
        box(0.025, 1.3, 0.025, C('#25302a'), x, 0.8, 0),
      ),
    ]),
  };
}

/** Kind code of roof / wall clutter (w of the `lp` attribute, materials.roofClutter). */
const ROOF_CLUTTER_KIND: Partial<Record<PropKind, number>> = {
  'ac-unit': 1,
  'satellite-dish': 2,
  chimney: 3,
  'solar-heater': 4,
};

/**
 * Model-space position and kind code for the roof clutter material, packed in
 * one vec4 attribute `lp` (xyz, w = kind): a fifth attribute would exceed
 * WebGPU's 8 vertex buffers with the four instance-matrix columns.
 */
function markClutter(g: THREE.BufferGeometry, kind: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const lp = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    lp[i * 4] = pos.getX(i);
    lp[i * 4 + 1] = pos.getY(i);
    lp[i * 4 + 2] = pos.getZ(i);
    lp[i * 4 + 3] = kind;
  }
  g.setAttribute('lp', new THREE.Float32BufferAttribute(lp, 4));
  return g;
}

const LAMP_GLOW_LOCAL: [number, number, number] = [0, 7.72, 1.55];

/** Street furniture kinds that a data view shows as holograms when not observed. */
const FURNITURE: PropKind[] = [
  'tree',
  'street-lamp',
  'traffic-signal',
  'bus-stop',
  'bench',
  'waste-basket',
  'power-pole',
  'street-cabinet',
];

export type PropMode = 'showcase' | 'data';

let sharedModules: ReturnType<typeof createPropModules> | null = null;
let sharedGlow: THREE.BufferGeometry | null = null;
let sharedPool: THREE.BufferGeometry | null = null;

const m4 = new THREE.Matrix4();
const q4 = new THREE.Quaternion();
const up = new THREE.Vector3(0, 1, 0);
const pos = new THREE.Vector3();
const scl = new THREE.Vector3();

function matrixOf(p: Prop): THREE.Matrix4 {
  const [x, y, z] = toThree(p.position[0], p.position[1], p.position[2]);
  // heading (model radians, 0 = east) → local +z faces that direction
  q4.setFromAxisAngle(up, Math.atan2(Math.cos(p.heading), -Math.sin(p.heading)));
  pos.set(x, y, z);
  scl.setScalar(p.scale);
  return m4.compose(pos, q4, scl).clone();
}

const variantOf = (p: Prop): PropKind | 'tree-pine' =>
  p.kind === 'tree' && new Rng(p.id).chance(0.3) ? 'tree-pine' : p.kind;

/**
 * Instanced meshes for a set of props. In the data view, street furniture
 * that is not in the source data is drawn as a hologram; suggestions are
 * always holograms (amber).
 */
export function buildPropGroup(
  props: Prop[],
  mats: DtMaterials,
  mode: PropMode,
  name: string,
): THREE.Group {
  if (!sharedModules) {
    sharedModules = createPropModules();
    for (const [kind, code] of Object.entries(ROOF_CLUTTER_KIND))
      markClutter(sharedModules[kind as PropKind], code);
    // Shared by every tile: never disposed with a tile.
    for (const [key, g] of Object.entries(sharedModules)) {
      g.userData.shared = true;
      g.userData.moduleKey = `prop:${key}`;
    }
  }
  if (!sharedGlow) {
    sharedGlow = new THREE.BoxGeometry(0.26, 0.04, 0.5);
    sharedGlow.userData.shared = true;
    sharedGlow.userData.moduleKey = 'prop:lamp-glow';
  }
  // 16 m disc on the ground, centred under the lamp head (1.5 m towards the road).
  if (!sharedPool) {
    sharedPool = new THREE.PlaneGeometry(16, 16).rotateX(-Math.PI / 2).translate(0, 0.25, 1.5);
    sharedPool.userData.shared = true;
    sharedPool.userData.moduleKey = 'prop:lamp-pool';
  }
  const modules = sharedModules;
  const group = new THREE.Group();
  group.name = name;
  const buckets = new Map<
    string,
    { geo: THREE.BufferGeometry; mat: THREE.Material; items: Prop[]; shadow: boolean }
  >();
  const push = (
    key: string,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    p: Prop,
    shadow: boolean,
  ) => {
    const bucket = buckets.get(key) ?? { geo, mat, items: [], shadow };
    bucket.items.push(p);
    buckets.set(key, bucket);
  };
  for (const p of props) {
    const variant = variantOf(p);
    const geo = modules[variant];
    const furniture = FURNITURE.includes(p.kind) && !p.buildingId;
    if (p.provenance === 'suggested') {
      push(`holo-sug-${variant}`, geo, mats.holoSuggested, p, false);
    } else if (furniture && p.provenance !== 'observed' && mode === 'data') {
      push(`holo-syn-${variant}`, geo, mats.holoSynthetic, p, false);
    } else {
      push(
        `real-${variant}`,
        geo,
        ROOF_CLUTTER_KIND[p.kind] ? mats.roofClutter : mats.prop,
        p,
        variant.startsWith('tree') ||
          [
            'bus-stop',
            'street-lamp',
            'street-cabinet',
            'car',
            'booth',
            'swing',
            'slide',
            'climber',
            'gate',
          ].includes(p.kind),
      );
      if (p.kind === 'street-lamp') {
        push('lamp-glow', sharedGlow, mats.lampGlow, p, false);
        push('lamp-pool', sharedPool, mats.lampPool, p, false);
      }
    }
  }
  const glowOffset = new THREE.Matrix4().makeTranslation(...LAMP_GLOW_LOCAL);
  for (const [key, b] of buckets) {
    const mesh = new THREE.InstancedMesh(b.geo, b.mat, b.items.length);
    if (key === 'lamp-pool') mesh.renderOrder = 5;
    const rng = new Rng(key);
    b.items.forEach((p, i) => {
      const mat = matrixOf(p);
      if (key === 'lamp-glow') mat.multiply(glowOffset);
      mesh.setMatrixAt(i, mat);
      if (key === 'real-car') {
        const r = new Rng(p.id);
        mesh.setColorAt(
          i,
          new THREE.Color(
            r.weighted([
              ['#f1f1ef', 0.3],
              ['#b9bcc0', 0.2],
              ['#1d1f22', 0.12],
              ['#6c7076', 0.12],
              ['#9c1f22', 0.08],
              ['#24427a', 0.1],
              ['#2d4a35', 0.04],
              ['#c9b48e', 0.04],
            ] as const),
          ),
        );
      }
      if (key.startsWith('real-tree')) {
        const tint = new THREE.Color().setHSL(
          0.22 + rng.range(-0.04, 0.05),
          rng.range(0.35, 0.55),
          rng.range(0.45, 0.55),
        );
        mesh.setColorAt(i, tint.multiplyScalar(1.6));
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = b.shadow;
    mesh.receiveShadow = !key.startsWith('holo');
    mesh.name = key;
    group.add(mesh);
  }
  return group;
}
