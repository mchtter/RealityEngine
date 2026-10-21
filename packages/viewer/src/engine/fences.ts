import { type CityModel, CutGround, FENCE_FOOT, fenceProfile } from '@kavra/core';
import * as THREE from 'three/webgpu';
import { MeshBuilder } from './geom';
import type { DtMaterials } from './materials';

/** `fk` attribute values of the fence material (materials.ts). */
const FK = { plaster: 0, stone: 1, hedge: 2, railing: 3, mesh: 4, metal: 5, cap: 6 } as const;

type P3 = [number, number, number];

const RAIL = new THREE.Color('#28302b');
const MESH = new THREE.Color('#7d8287');
const CAP = new THREE.Color('#9a948a');
const STONE = new THREE.Color('#ffffff');
const HEDGE = new THREE.Color('#ffffff');

/**
 * Garden walls, fences and hedges along lot boundaries (CityModel.fences),
 * following the ground: low walls with a railing, plain and stone walls,
 * hedges, wire mesh on a kerb, with piers / posts.
 */
export function buildFences(model: CityModel, mats: DtMaterials): THREE.Mesh | null {
  const fences = model.fences ?? [];
  if (!fences.length) return null;
  const ground = new CutGround(model.terrain, model.terrainCut);
  const mb = new MeshBuilder();
  mb.defineAttribute('fk', 1);

  const STYLE: Record<string, string> = {
    'wall-rail': 'alçak duvar + korkuluk',
    wall: 'duvar',
    stone: 'taş duvar',
    hedge: 'çit (bitki)',
    mesh: 'tel örgü',
  };
  const ids: string[] = [];
  for (const f of fences) {
    ids.push(`fence||${STYLE[f.style] ?? f.style}, ${f.height.toFixed(1)} m`);
    mb.setOwner(ids.length - 1);
    const pts = fenceProfile(f, (x, y) => ground.heightAt(x, y)) as P3[];
    if (pts.length < 2) continue;
    const wall = new THREE.Color(f.color);
    const h = f.height;
    const foot = -FENCE_FOOT[f.style];
    switch (f.style) {
      case 'wall-rail': {
        const w = Math.min(0.65, h * 0.42);
        strip(mb, pts, 0.24, foot, w, wall, FK.plaster);
        strip(mb, pts, 0.3, w, w + 0.06, CAP, FK.cap);
        panel(mb, pts, w + 0.06, h, RAIL, FK.railing, true);
        piers(mb, pts, 3, 0.36, h + 0.08, wall, FK.plaster);
        break;
      }
      case 'wall':
        strip(mb, pts, 0.22, foot, h, wall, FK.plaster);
        strip(mb, pts, 0.28, h, h + 0.06, CAP, FK.cap);
        break;
      case 'stone':
        strip(mb, pts, 0.42, foot, h, STONE, FK.stone);
        strip(mb, pts, 0.46, h, h + 0.07, CAP, FK.cap);
        break;
      case 'hedge':
        strip(mb, pts, 0.5, foot, h, HEDGE, FK.hedge);
        break;
      case 'mesh':
        strip(mb, pts, 0.18, foot, 0.3, wall, FK.plaster);
        panel(mb, pts, 0.3, h, MESH, FK.mesh, false);
        piers(mb, pts, 2.5, 0.06, h + 0.05, RAIL, FK.metal);
        break;
    }
  }
  if (!mb.indices.length) return null;
  const mesh = new THREE.Mesh(mb.build({ color: true }), mats.fence);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'fences';
  mesh.userData.pick = { ids, owners: mb.triangleOwner };
  mesh.userData.role = 'ground:near';
  return mesh;
}

/** Mitred left normals per point (as the bridge strips). */
function normals(pts: P3[]): [number, number][] {
  return pts.map((_, k) => {
    const seg = (a: P3, b: P3): [number, number] => {
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
    };
    const n0 = k > 0 ? seg(pts[k - 1], pts[k]) : null;
    const n1 = k < pts.length - 1 ? seg(pts[k], pts[k + 1]) : null;
    if (!n0) return n1!;
    if (!n1) return n0;
    const mx = n0[0] + n1[0];
    const my = n0[1] + n1[1];
    const ml = Math.hypot(mx, my) || 1;
    const cos = Math.max(0.5, (mx / ml) * n1[0] + (my / ml) * n1[1]);
    return [mx / ml / cos, my / ml / cos];
  });
}

/**
 * Solid wall body of `width`, from z0 to z1 above the ground at each point:
 * both faces, the top and the two ends. uv = (metres along, metres up).
 */
function strip(
  mb: MeshBuilder,
  pts: P3[],
  width: number,
  z0: number,
  z1: number,
  color: THREE.Color,
  fk: number,
): void {
  mb.setAttribute('fk', [fk]);
  const n = normals(pts);
  const half = width / 2;
  const at = (k: number, side: number, z: number): P3 => [
    pts[k][0] + n[k][0] * half * side,
    pts[k][1] + n[k][1] * half * side,
    pts[k][2] + z,
  ];
  let s = 0;
  for (let k = 1; k < pts.length; k++) {
    const len = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    const s1 = s + len;
    const l = Math.hypot(n[k][0], n[k][1]) || 1;
    for (const side of [1, -1]) {
      const q: P3[] =
        side > 0
          ? [at(k, 1, z0), at(k - 1, 1, z0), at(k - 1, 1, z1), at(k, 1, z1)]
          : [at(k - 1, -1, z0), at(k, -1, z0), at(k, -1, z1), at(k - 1, -1, z1)];
      const uvs: [number, number][] =
        side > 0
          ? [
              [s1, z0],
              [s, z0],
              [s, z1],
              [s1, z1],
            ]
          : [
              [s, z0],
              [s1, z0],
              [s1, z1],
              [s, z1],
            ];
      mb.quad(q, [(n[k][0] / l) * side, (n[k][1] / l) * side, 0], color, uvs);
    }
    mb.quad([at(k - 1, -1, z1), at(k, -1, z1), at(k, 1, z1), at(k - 1, 1, z1)], [0, 0, 1], color, [
      [s, z1],
      [s1, z1],
      [s1, z1 + width],
      [s, z1 + width],
    ]);
    s = s1;
  }
  // End faces.
  for (const [k, toward] of [
    [0, 1],
    [pts.length - 1, pts.length - 2],
  ]) {
    const d = [pts[k][0] - pts[toward][0], pts[k][1] - pts[toward][1]];
    const l = Math.hypot(d[0], d[1]) || 1;
    const out: P3 = [d[0] / l, d[1] / l, 0];
    const a = at(k, 1, z0);
    const b = at(k, -1, z0);
    const c = at(k, -1, z1);
    const e = at(k, 1, z1);
    // Counter-clockwise seen from outside the end.
    const cross = (b[0] - a[0]) * out[1] - (b[1] - a[1]) * out[0];
    const q: P3[] = cross < 0 ? [a, b, c, e] : [b, a, e, c];
    mb.quad(q, out, color, [
      [0, z0],
      [width, z0],
      [width, z1],
      [0, z1],
    ]);
  }
}

/**
 * Thin vertical panel along the centre line (railing bars / wire mesh, cut out
 * by the material); `unit` maps its height to 0…1 (rails at the edges).
 */
function panel(
  mb: MeshBuilder,
  pts: P3[],
  z0: number,
  z1: number,
  color: THREE.Color,
  fk: number,
  unit: boolean,
): void {
  mb.setAttribute('fk', [fk]);
  const v0 = unit ? 0.001 : z0;
  const v1 = unit ? 0.999 : z1;
  let s = 0;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const l = len || 1;
    mb.quad(
      [
        [a[0], a[1], a[2] + z0],
        [b[0], b[1], b[2] + z0],
        [b[0], b[1], b[2] + z1],
        [a[0], a[1], a[2] + z1],
      ],
      [(b[1] - a[1]) / l, -(b[0] - a[0]) / l, 0],
      color,
      [
        [s, v0],
        [s + len, v0],
        [s + len, v1],
        [s, v1],
      ],
    );
    s += len;
  }
}

/** Square piers / posts every `every` metres and at both ends. */
function piers(
  mb: MeshBuilder,
  pts: P3[],
  every: number,
  size: number,
  top: number,
  color: THREE.Color,
  fk: number,
): void {
  mb.setAttribute('fk', [fk]);
  // Every `every` m along the line (evenly spread over its length), and at
  // both ends; the points are sparse where the ground runs straight.
  let total = 0;
  for (let k = 1; k < pts.length; k++)
    total += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  const count = Math.max(1, Math.round(total / every));
  const at: P3[] = [];
  let k = 1;
  let walked = 0;
  for (let i = 0; i <= count; i++) {
    const want = (total * i) / count;
    while (
      k < pts.length - 1 &&
      walked + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]) < want
    ) {
      walked += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      k++;
    }
    const a = pts[k - 1];
    const b = pts[k];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const t = Math.min(1, Math.max(0, (want - walked) / l));
    at.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }
  const h = size / 2;
  for (const p of at) {
    const z0 = p[2] - 0.3;
    const z1 = p[2] + top;
    const c: [number, number][] = [
      [p[0] - h, p[1] - h],
      [p[0] + h, p[1] - h],
      [p[0] + h, p[1] + h],
      [p[0] - h, p[1] + h],
    ];
    for (let k = 0; k < 4; k++) {
      const a = c[k];
      const b = c[(k + 1) % 4];
      const nx = (b[1] - a[1]) / size;
      const ny = -(b[0] - a[0]) / size;
      mb.quad(
        [
          [a[0], a[1], z0],
          [b[0], b[1], z0],
          [b[0], b[1], z1],
          [a[0], a[1], z1],
        ],
        [nx, ny, 0],
        color,
        [
          [0, z0 - p[2]],
          [size, z0 - p[2]],
          [size, z1 - p[2]],
          [0, z1 - p[2]],
        ],
      );
    }
    mb.quad(
      c.map((q) => [q[0], q[1], z1] as P3),
      [0, 0, 1],
      color,
      [
        [0, 0],
        [size, 0],
        [size, size],
        [0, size],
      ],
    );
  }
}
