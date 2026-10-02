import { type CityModel, type Fix, ringArea, triangulate } from '@opentwin/city-core';
import * as THREE from 'three/webgpu';
import { MeshBuilder, toThree } from './geom';
import type { DtMaterials } from './materials';

type V2 = [number, number];

/**
 * Extrudes every geometry correction (the part the engine removed from a
 * source footprint) as a pulsing red ghost at the building's height, so the
 * data view shows exactly where the source data overflowed.
 */
export function buildFixOverlay(
  model: CityModel,
  mats: DtMaterials,
): { group: THREE.Group; fixes: Fix[] } {
  const mb = new MeshBuilder();
  const shown = model.fixes.filter((f) => f.removed.length && f.height > 0);
  for (const f of shown) {
    const z0 = f.baseZ;
    const z1 = f.baseZ + f.height + 0.3;
    for (const poly of f.removed) {
      for (const ring of [poly.outer, ...poly.holes] as V2[][]) {
        const ccw = ringArea(ring) > 0;
        for (let k = 0; k < ring.length; k++) {
          const a = ring[k];
          const b = ring[(k + 1) % ring.length];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const s = ccw ? 1 : -1;
          const n: [number, number, number] = [
            ((b[1] - a[1]) / len) * s,
            (-(b[0] - a[0]) / len) * s,
            0,
          ];
          mb.quad(
            [
              [a[0], a[1], z0],
              [b[0], b[1], z0],
              [b[0], b[1], z1],
              [a[0], a[1], z1],
            ],
            n,
            undefined,
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
          );
        }
      }
      const { vertices, indices } = triangulate(poly);
      const base = mb.vertexCount;
      for (let k = 0; k < vertices.length; k += 2)
        mb.vertex(toThree(vertices[k], vertices[k + 1], z1), [0, 1, 0]);
      for (let k = 0; k < indices.length; k += 3)
        mb.triangle(base + indices[k], base + indices[k + 1], base + indices[k + 2]);
    }
  }
  const group = new THREE.Group();
  group.name = 'fix-overlay';
  if (mb.vertexCount) {
    const mesh = new THREE.Mesh(mb.build({ uv: false }), mats.fix);
    mesh.renderOrder = 10;
    group.add(mesh);
  }
  group.visible = false;
  return { group, fixes: model.fixes };
}
