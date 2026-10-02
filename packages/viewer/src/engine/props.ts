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
    chimney: merge([
      box(0.5, 1.4, 0.5, C('#9a5a44'), 0, 0.7, 0),
      box(0.62, 0.08, 0.62, C('#6b6f73'), 0, 1.45, 0),
    ]),
    'solar-heater': merge([
      cyl(0.24, 0.24, 1.6, 12, C('#d9d9d6'), 0, 1.25, -0.35, 0, Math.PI / 2),
      box(1.7, 0.05, 1.1, C('#1d2c44'), 0, 0.7, 0.25, -0.65),
      box(1.7, 0.07, 0.07, C('#8a8f94'), 0, 0.1, 0.6),
      box(1.7, 0.07, 0.07, C('#8a8f94'), 0, 0.1, -0.4),
      cyl(0.03, 0.03, 1.1, 5, C('#8a8f94'), -0.8, 0.6, -0.35),
      cyl(0.03, 0.03, 1.1, 5, C('#8a8f94'), 0.8, 0.6, -0.35),
    ]),
    'satellite-dish': merge([
      cyl(0.42, 0.3, 0.1, 14, C('#e6e4df'), 0, 0.75, 0.05, Math.PI / 2 - 0.5),
      cyl(0.025, 0.025, 0.75, 5, C('#8a8f94'), 0, 0.37, 0),
    ]),
    'ac-unit': box(0.8, 0.56, 0.28, C('#e9e8e4'), 0, 0, 0.14),
  };
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
        mats.prop,
        p,
        variant.startsWith('tree') || p.kind === 'bus-stop' || p.kind === 'street-lamp',
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
