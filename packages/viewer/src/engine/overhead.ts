import type { CityModel } from '@kavra/core';
import * as THREE from 'three/webgpu';
import { MeshBuilder } from './geom';
import type { DtMaterials } from './materials';

/** `fk` of the fence material for plain metal (fences.ts FK.metal). */
const FK_METAL = 5;

/**
 * Where the wires hang on a pylon (props.ts `pylon`): [across the line, height]
 * — the conductors 2 m under each cross-arm's tip (the insulator), the earth
 * wire on the peak.
 */
const ATTACH: [number, number][] = [
  [-5.5, 23],
  [5.5, 23],
  [-7, 27.5],
  [7, 27.5],
  [-5.5, 32],
  [5.5, 32],
  [0, 38],
];
/** Sag at mid-span, share of the span. */
const SAG = 0.028;
const SEGMENTS = 16;
/** Drawn wider than a real conductor (≈3 cm) so it reads at a distance. */
const WIDTH = 0.09;
const WIRE = new THREE.Color('#3a3f44');

/**
 * Overhead lines between pylons (CityModel.overhead): seven wires per span,
 * each a sagging curve drawn as two crossed ribbons, both faces, so it shows
 * from any side.
 */
export function buildOverhead(model: CityModel, mats: DtMaterials): THREE.Mesh | null {
  const spans = model.overhead ?? [];
  if (!spans.length) return null;
  const key = (x: number, y: number) => `${Math.round(x * 10)},${Math.round(y * 10)}`;
  const heading = new Map<string, number>();
  for (const p of model.props)
    if (p.kind === 'pylon') heading.set(key(p.position[0], p.position[1]), p.heading);
  const mb = new MeshBuilder();
  mb.defineAttribute('fk', 1);
  mb.setAttribute('fk', [FK_METAL]);
  const ids: string[] = [];
  for (const sp of spans) {
    ids.push('overhead||Enerji iletim hattı (direklerden çıkarım)');
    mb.setOwner(ids.length - 1);
    const dx = sp.b[0] - sp.a[0];
    const dy = sp.b[1] - sp.a[1];
    const len = Math.hypot(dx, dy) || 1;
    const across = (x: number, y: number): [number, number] => {
      const h = heading.get(key(x, y));
      return h === undefined ? [-dy / len, dx / len] : [-Math.sin(h), Math.cos(h)];
    };
    const la = across(sp.a[0], sp.a[1]);
    let lb = across(sp.b[0], sp.b[1]);
    // The same side of the line at both ends.
    if (la[0] * lb[0] + la[1] * lb[1] < 0) lb = [-lb[0], -lb[1]];
    const sag = SAG * len;
    for (const [x, z] of ATTACH) {
      const pa: [number, number, number] = [sp.a[0] + la[0] * x, sp.a[1] + la[1] * x, sp.a[2] + z];
      const pb: [number, number, number] = [sp.b[0] + lb[0] * x, sp.b[1] + lb[1] * x, sp.b[2] + z];
      const at = (t: number): [number, number, number] => [
        pa[0] + (pb[0] - pa[0]) * t,
        pa[1] + (pb[1] - pa[1]) * t,
        pa[2] + (pb[2] - pa[2]) * t - sag * 4 * t * (1 - t),
      ];
      const side: [number, number] = [-dy / len, dx / len];
      for (let k = 0; k < SEGMENTS; k++) {
        const p0 = at(k / SEGMENTS);
        const p1 = at((k + 1) / SEGMENTS);
        const w = WIDTH / 2;
        // Vertical ribbon (seen from the side) and horizontal one (seen from below / above).
        const ribbons: [[number, number, number], [number, number, number]][] = [
          [
            [0, 0, w],
            [side[0], side[1], 0],
          ],
          [
            [side[0] * w, side[1] * w, 0],
            [0, 0, 1],
          ],
        ];
        for (const [o, n] of ribbons) {
          const quad: [number, number, number][] = [
            [p0[0] - o[0], p0[1] - o[1], p0[2] - o[2]],
            [p1[0] - o[0], p1[1] - o[1], p1[2] - o[2]],
            [p1[0] + o[0], p1[1] + o[1], p1[2] + o[2]],
            [p0[0] + o[0], p0[1] + o[1], p0[2] + o[2]],
          ];
          const uv: [number, number][] = [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ];
          mb.quad(quad, n, WIRE, uv);
          mb.quad([...quad].reverse(), [-n[0], -n[1], -n[2]], WIRE, uv);
        }
      }
    }
  }
  if (!mb.indices.length) return null;
  const mesh = new THREE.Mesh(mb.build({ color: true }), mats.fence);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.name = 'overhead';
  mesh.userData.pick = { ids, owners: mb.triangleOwner };
  mesh.userData.role = 'ground:near';
  return mesh;
}
