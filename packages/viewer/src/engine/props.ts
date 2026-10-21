import {
  FUEL_BRAND_COLOURS,
  type FuelBrand,
  type Prop,
  type PropKind,
  Rng,
} from 'reality-engine-core';
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

/** Cylinder without end caps: ends hidden inside another part (or a flush ring). */
function tube(
  r: number,
  h: number,
  seg: number,
  c: THREE.Color,
  x = 0,
  y = 0,
  z = 0,
  rotZ = 0,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, h, seg, 1, true);
  g.deleteAttribute('uv');
  if (rotZ) g.rotateZ(rotZ);
  g.translate(x, y, z);
  return paint(g, c);
}

/**
 * Thin bar seen from the front and back only (4 triangles, a box has 12):
 * balusters a few centimetres thick, whose side faces never read.
 */
function slat(w: number, h: number, c: THREE.Color, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const front = new THREE.PlaneGeometry(w, h).translate(0, 0, 0.0125);
  const back = new THREE.PlaneGeometry(w, h).rotateY(Math.PI).translate(0, 0, -0.0125);
  const g = mergeGeometries([front, back]);
  g.deleteAttribute('uv');
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

/** Square bar of width w from point a to point b (lattice members, legs, braces). */
function bar(
  a: [number, number, number],
  b: [number, number, number],
  w: number,
  c: THREE.Color,
): THREE.BufferGeometry {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length();
  const g = new THREE.BoxGeometry(w, len, w);
  g.deleteAttribute('uv');
  g.applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()),
  );
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return paint(g, c);
}

/**
 * Four-legged lattice tower from a square base (half width b0) to a square
 * top (half width b1) at height h: legs, a ring of horizontal braces and
 * crossed diagonals on each face at every level.
 */
function lattice(b0: number, b1: number, h: number, levels: number, w: number, c: THREE.Color) {
  const parts: THREE.BufferGeometry[] = [];
  const half = (z: number) => b0 + (b1 - b0) * (z / h);
  const corners = (z: number): [number, number, number][] => {
    const r = half(z);
    return [
      [-r, z, -r],
      [r, z, -r],
      [r, z, r],
      [-r, z, r],
    ];
  };
  const c0 = corners(0);
  const c1 = corners(h);
  for (let k = 0; k < 4; k++) parts.push(bar(c0[k], c1[k], w * 1.6, c));
  for (let l = 0; l < levels; l++) {
    const za = (h * l) / levels;
    const zb = (h * (l + 1)) / levels;
    const lo = corners(za);
    const hi = corners(zb);
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      parts.push(bar(hi[k], hi[k2], w, c));
      parts.push(bar(lo[k], hi[k2], w * 0.7, c));
      parts.push(bar(lo[k2], hi[k], w * 0.7, c));
    }
  }
  return parts;
}

/** Flag on a pole's top (hoist at x = 0, flying along +x), both faces. */
function flag(country: string | undefined, top: number): THREE.BufferGeometry[] {
  const W = 4.2;
  const H = 2.8;
  const y0 = top - H - 0.3;
  const out: THREE.BufferGeometry[] = [];
  const plane = (w: number, h: number, x: number, y: number, z: number, c: THREE.Color) => {
    for (const side of [1, -1]) {
      const g = new THREE.PlaneGeometry(w, h);
      if (side < 0) g.rotateY(Math.PI);
      g.deleteAttribute('uv');
      g.translate(x, y, z * side);
      out.push(paint(g, c));
    }
  };
  const disc = (r: number, x: number, y: number, z: number, c: THREE.Color, seg = 20) => {
    for (const side of [1, -1]) {
      const g = new THREE.CircleGeometry(r, seg);
      if (side < 0) g.rotateY(Math.PI);
      g.deleteAttribute('uv');
      g.translate(x, y, z * side);
      out.push(paint(g, c));
    }
  };
  const star = (r: number, x: number, y: number, z: number, c: THREE.Color, turn = 0) => {
    const shape = new THREE.Shape();
    for (let k = 0; k < 10; k++) {
      const a = turn + Math.PI / 2 + (k * Math.PI) / 5;
      const rr = k % 2 ? r * 0.4 : r;
      if (k === 0) shape.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      else shape.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    for (const side of [1, -1]) {
      const g = new THREE.ShapeGeometry(shape);
      if (side < 0) g.rotateY(Math.PI);
      g.deleteAttribute('uv');
      g.translate(x, y, z * side);
      out.push(paint(g, c));
    }
  };
  const cy = y0 + H / 2;
  if (country === 'EU') {
    plane(W, H, W / 2, cy, 0.01, C('#1f3f9a'));
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      star(0.14, W / 2 + Math.cos(a) * 0.85, cy + Math.sin(a) * 0.85, 0.02, C('#f2c80f'));
    }
  } else if (country === 'FR') {
    plane(W / 3, H, W / 6, cy, 0.01, C('#1f3f9a'));
    plane(W / 3, H, W / 2, cy, 0.01, C('#f4f4f2'));
    plane(W / 3, H, (5 * W) / 6, cy, 0.01, C('#d0303a'));
  } else {
    // National flag: crescent and star on red (crescent as a red disc over a white one).
    plane(W, H, W / 2, cy, 0.01, C('#d0202a'));
    disc(H * 0.25, W * 0.375, cy, 0.02, C('#f4f4f2'));
    disc(H * 0.2, W * 0.405, cy, 0.03, C('#d0202a'));
    star(H * 0.125, W * 0.52, cy, 0.03, C('#f4f4f2'), -Math.PI / 2);
  }
  return out;
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
/**
 * Fuel pump island (fuel.ts): a kerbed concrete island along local z, two
 * dispensers in the brand's accent with dark display faces, yellow-and-black
 * bollards at its ends.
 */
function fuelPump(brand: FuelBrand): THREE.BufferGeometry {
  const { accent, fascia } = FUEL_BRAND_COLOURS[brand];
  const body = C('#f2f3f4');
  const parts = [box(1.3, 0.18, 4.8, C('#b9bcbf'), 0, 0.09, 0)];
  for (const z of [-1.15, 1.15]) {
    parts.push(box(0.75, 1.75, 0.5, body, 0, 0.18 + 0.875, z));
    parts.push(box(0.77, 0.32, 0.52, C(accent), 0, 0.18 + 1.75 - 0.16, z));
    parts.push(box(0.77, 0.08, 0.52, C(fascia), 0, 0.18 + 0.3, z));
    for (const x of [-0.39, 0.39]) parts.push(box(0.02, 0.45, 0.32, C('#1f2428'), x, 1.25, z));
  }
  for (const z of [-2.25, 2.25]) {
    parts.push(cyl(0.09, 0.09, 0.9, 8, C('#f2c200'), 0, 0.18 + 0.45, z));
    parts.push(cyl(0.092, 0.092, 0.12, 8, C('#1f2428'), 0, 0.18 + 0.55, z));
  }
  return mergeGeometries(parts);
}

/**
 * Fuel station price sign: a tall panel across the road (thin along local z)
 * on two posts, in the brand's colours, white price rows on both faces.
 */
function fuelTotem(brand: FuelBrand): THREE.BufferGeometry {
  const { accent, fascia } = FUEL_BRAND_COLOURS[brand];
  const parts = [
    box(0.22, 1.3, 0.22, C('#8d9398'), -0.55, 0.65, 0),
    box(0.22, 1.3, 0.22, C('#8d9398'), 0.55, 0.65, 0),
    box(1.7, 5.0, 0.36, C(fascia), 0, 1.3 + 2.5, 0),
    box(1.72, 1.1, 0.38, C(accent), 0, 1.3 + 5.0 - 0.55, 0),
  ];
  for (let k = 0; k < 4; k++)
    for (const z of [-0.185, 0.185])
      parts.push(box(1.3, 0.42, 0.02, C('#f5f6f7'), 0, 1.3 + 0.6 + k * 0.75, z));
  return mergeGeometries(parts);
}

function createPropModules(): Record<PropVariant, THREE.BufferGeometry> {
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
    // Tank: an open tube closed by its two end rings (10 sides read round on a roof).
    'solar-heater': merge([
      tube(0.25, 1.7, 10, C('#e4e4e0'), 0, 1.28, -0.38, Math.PI / 2),
      cyl(0.26, 0.26, 0.05, 10, C('#9ea2a6'), -0.86, 1.28, -0.38, 0, Math.PI / 2),
      cyl(0.26, 0.26, 0.05, 10, C('#9ea2a6'), 0.86, 1.28, -0.38, 0, Math.PI / 2),
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
      tube(0.025, 0.5, 4, C('#9ea2a6'), -0.7, 1.05, -0.12),
      tube(0.025, 0.5, 4, C('#9ea2a6'), 0.7, 1.05, -0.12),
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
        slat(0.025, 1.3, C('#25302a'), x, 0.8, 0),
      ),
    ]),
    // Marble grave (+z = head): kerb slab round a planted bed, headstone at the head.
    grave: merge([
      box(0.9, 0.24, 1.95, C('#e9e7e2'), 0, 0.12, 0),
      box(0.66, 0.05, 1.6, C('#5d6a3a'), 0, 0.245, -0.05),
      box(0.56, 0.86, 0.1, C('#efedea'), 0, 0.55, 0.9),
    ]),
    // Italian cypress: a short trunk and one tall narrow dark crown (~11 m).
    cypress: merge([
      cyl(0.1, 0.16, 1.6, 5, bark, 0, 0.8, 0),
      blob(0.95, C('#2f4a2a'), 0, 6.1, 0, 5.2, 1),
    ]),
    // Tower crane: mast on a concrete base, jib and counter-jib, cab,
    // counterweights, the A-frame and a hoist line down to the hook.
    crane: merge([
      box(6, 1, 6, C('#9a968f'), 0, 0.5, 0),
      box(1.6, 40, 1.6, C('#e0b020'), 0, 21, 0),
      box(1.3, 1.3, 50, C('#e0b020'), 0, 41.6, 13),
      box(2.4, 2.4, 2.6, C('#d9d6cf'), 0, 39.6, 1.6),
      box(2.6, 2.2, 3, C('#8d8a84'), 0, 40.8, -10),
      box(0.6, 6, 0.6, C('#e0b020'), 0, 45.3, 0),
      cyl(0.03, 0.03, 26, 4, darkMetal, 0, 28, 26),
      box(0.6, 0.9, 0.6, C('#d23a2a'), 0, 14.6, 26),
    ]),
    // Market stall (+z = the aisle): poles, an awning (instance tint), the
    // counter with produce. Painted parts white / light: the tint is the colour.
    stall: merge([
      cyl(0.04, 0.04, 2.5, 5, C('#cfd2d4'), -1.45, 1.25, 1.2),
      cyl(0.04, 0.04, 2.5, 5, C('#cfd2d4'), 1.45, 1.25, 1.2),
      cyl(0.04, 0.04, 2.2, 5, C('#cfd2d4'), -1.45, 1.1, -1.2),
      cyl(0.04, 0.04, 2.2, 5, C('#cfd2d4'), 1.45, 1.1, -1.2),
      box(3.1, 0.05, 2.8, C('#f4f4f2'), 0, 2.38, 0, 0.12),
      box(2.8, 0.78, 0.95, C('#b9a58a'), 0, 0.39, 0.6),
      box(2.6, 0.14, 0.8, C('#d98b2b'), 0, 0.85, 0.6),
    ]),
    // High-voltage lattice pylon (~38 m; +z along the line): three cross-arms
    // each side with hanging insulators (the conductors attach 2 m below an
    // arm's tip, see overhead.ts in the renderer) and the earth-wire peak.
    pylon: merge([
      ...lattice(4, 0.9, 34, 6, 0.16, C('#8d9296')),
      ...[
        [25, 5.5],
        [29.5, 7],
        [34, 5.5],
      ].flatMap(([z, L]) => [
        bar([-L, z, 0], [L, z, 0], 0.22, C('#8d9296')),
        bar([-L, z, 0], [-1, z - 2.4, 0], 0.12, C('#8d9296')),
        bar([L, z, 0], [1, z - 2.4, 0], 0.12, C('#8d9296')),
        cyl(0.12, 0.12, 2, 6, C('#4b5a66'), -L + 0.2, z - 1, 0),
        cyl(0.12, 0.12, 2, 6, C('#4b5a66'), L - 0.2, z - 1, 0),
      ]),
      bar([0, 34, 0], [0, 38, 0], 0.2, C('#8d9296')),
    ]),
    // Communication mast (~32 m): a slim lattice, panel antennas and a dish.
    mast: merge([
      ...lattice(0.9, 0.5, 30, 10, 0.07, C('#c7cacd')),
      ...[0, 2.1, 4.2].map((a) =>
        box(0.4, 1.6, 0.15, C('#f2f2f0'), Math.cos(a) * 0.75, 28, Math.sin(a) * 0.75),
      ),
      cyl(0.55, 0.45, 0.15, 12, C('#f2f2f0'), 0.6, 24, 0, Math.PI / 2),
      bar([0, 30, 0], [0, 32, 0], 0.08, C('#c8302a')),
    ]),
    // Floodlight mast (~30 m): a tapered steel pole, a service platform and a
    // frame of lamps facing the apron / pitch (+z).
    floodlight: merge([
      cyl(0.22, 0.45, 28, 10, C('#9aa0a5'), 0, 14, 0),
      cyl(1.4, 1.4, 0.15, 12, C('#7d8287'), 0, 27.6, 0),
      box(3.2, 1.8, 0.25, C('#6f7378'), 0, 29, 0.4),
      ...[-1.05, 0, 1.05].flatMap((x) =>
        [28.55, 29.45].map((y) => box(0.9, 0.7, 0.08, C('#f4f1df'), x, y, 0.56)),
      ),
    ]),
    flagpole: merge([cyl(0.09, 0.16, 20, 8, C('#e8e8e6'), 0, 10, 0), ...flag(undefined, 20)]),
    // Windsock: a 6.6 m mast, a swivel, and a cone of five orange / white
    // bands blowing out along +z (the wind), drooping a little.
    windsock: merge([
      cyl(0.05, 0.08, 6.6, 8, pole, 0, 3.3, 0),
      box(0.12, 0.12, 0.5, darkMetal, 0, 6.5, 0.15),
      ...[0, 1, 2, 3, 4].map((k) => {
        const len = 0.72;
        const z = 0.45 + k * len + len / 2;
        const r0 = 0.46 - k * 0.05;
        return cyl(
          r0 - 0.05,
          r0,
          len,
          12,
          k % 2 ? C('#f4f1ea') : C('#ff5a14'),
          0,
          6.5 - z * 0.1,
          z,
          Math.PI / 2 + 0.1,
        );
      }),
    ]),
    'flagpole-EU': merge([cyl(0.09, 0.16, 20, 8, C('#e8e8e6'), 0, 10, 0), ...flag('EU', 20)]),
    'flagpole-FR': merge([cyl(0.09, 0.16, 20, 8, C('#e8e8e6'), 0, 10, 0), ...flag('FR', 20)]),
    // Fuel stations (fuel.ts): neutral colours, and one variant per known brand.
    'fuel-pump': fuelPump('generic'),
    'fuel-totem': fuelTotem('generic'),
    ...(Object.fromEntries(
      (Object.keys(FUEL_BRAND_COLOURS) as FuelBrand[]).flatMap((b) => [
        [`fuel-pump-${b}`, fuelPump(b)],
        [`fuel-totem-${b}`, fuelTotem(b)],
      ]),
    ) as Record<`fuel-pump-${FuelBrand}` | `fuel-totem-${FuelBrand}`, THREE.BufferGeometry>),
    // Power transformer: tank with radiator banks, three bushings, conservator.
    transformer: merge([
      box(1.8, 0.4, 3.6, C('#9a968f'), 0, 0.2, 0),
      box(2.6, 2.8, 3.2, C('#6f7a6c'), 0, 1.8, 0),
      ...[-1.2, -0.4, 0.4, 1.2].flatMap((z) => [
        box(0.5, 2.2, 0.08, C('#66705f'), 1.6, 1.7, z),
        box(0.5, 2.2, 0.08, C('#66705f'), -1.6, 1.7, z),
      ]),
      ...[-0.9, 0, 0.9].map((z) => cyl(0.12, 0.18, 1.3, 8, C('#d9d7d0'), 0.5, 3.85, z)),
      cyl(0.35, 0.35, 2.4, 10, C('#6f7a6c'), -0.7, 3.7, 0, Math.PI / 2),
    ]),
    // Substation gantry: a portal of two lattice columns and a beam with insulator strings.
    gantry: merge([
      ...lattice(0.6, 0.35, 11, 4, 0.08, C('#9aa0a5')).map((g) => g.translate(-5, 0, 0)),
      ...lattice(0.6, 0.35, 11, 4, 0.08, C('#9aa0a5')).map((g) => g.translate(5, 0, 0)),
      box(10.8, 0.6, 0.6, C('#9aa0a5'), 0, 11.2, 0),
      ...[-3, 0, 3].map((x) => cyl(0.1, 0.1, 1.6, 6, C('#4b5a66'), x, 10.1, 0)),
    ]),
    // Power station stack (~45 m), red and white bands at the top, a platform.
    stack: merge([
      cyl(1.6, 2.3, 40, 16, C('#b8b5ae'), 0, 20, 0),
      cyl(1.62, 1.66, 2.5, 16, C('#c8302a'), 0, 41.25, 0),
      cyl(1.58, 1.62, 2.5, 16, C('#f2f2f0'), 0, 43.75, 0),
      cyl(2.4, 2.4, 0.25, 16, C('#6f7378'), 0, 36, 0),
    ]),
    // 20 ft container (6.06 × 2.44 × 2.59 m, long side along z), doors at -z.
    container: merge([
      box(2.44, 2.59, 6.06, C('#f2f2f2'), 0, 1.295, 0),
      box(2.3, 2.4, 0.04, C('#d0d0d0'), 0, 1.3, -3.05),
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

/** Model variants: pines among the trees, flags by country, fuel pumps and signs by brand. */
type PropVariant =
  | PropKind
  | 'tree-pine'
  | 'flagpole-EU'
  | 'flagpole-FR'
  | `fuel-pump-${FuelBrand}`
  | `fuel-totem-${FuelBrand}`;

const variantOf = (p: Prop): PropVariant =>
  p.kind === 'tree' && new Rng(p.id).chance(0.3)
    ? 'tree-pine'
    : p.kind === 'flagpole' && (p.flag === 'EU' || p.flag === 'FR')
      ? `flagpole-${p.flag}`
      : (p.kind === 'fuel-pump' || p.kind === 'fuel-totem') &&
          p.brand &&
          p.brand in FUEL_BRAND_COLOURS
        ? `${p.kind}-${p.brand as FuelBrand}`
        : p.kind;

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
            'cypress',
            'crane',
            'stall',
            'container',
            'pylon',
            'mast',
            'floodlight',
            'flagpole',
            'windsock',
            'transformer',
            'gantry',
            'stack',
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
      if (key === 'real-container')
        mesh.setColorAt(
          i,
          C(
            new Rng(p.id).pick([
              '#b33a2b',
              '#2b5f9e',
              '#2f7d4a',
              '#c98a2b',
              '#6f7378',
              '#e3e1dc',
              '#7a2f6e',
            ]),
          ),
        );
      if (key === 'real-stall')
        mesh.setColorAt(
          i,
          C(new Rng(p.id).pick(['#c0392b', '#2e6fb3', '#e3b321', '#2f8f4e', '#eeeeea'])),
        );
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
