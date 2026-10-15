import { describe, expect, it } from 'vitest';
import { MeshBuilder, drapeRingWall } from './geom';

/** z of the wall vertices over a point of the ring (three.js: y up, z = -north). */
function zsAt(mb: MeshBuilder, x: number, y: number): number[] {
  const out: number[] = [];
  for (let v = 0; v < mb.vertexCount; v++) {
    const [px, py, pz] = [mb.positions[v * 3], mb.positions[v * 3 + 1], mb.positions[v * 3 + 2]];
    if (Math.abs(px - x) < 1e-6 && Math.abs(-pz - y) < 1e-6) out.push(py);
  }
  return out;
}

describe('drapeRingWall', () => {
  // A 10 m square of street at 10 m (CCW), its top 0.24 m above that.
  const ring: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  const street = () => 10;

  it('reaches down to ground lying below its foot', () => {
    const mb = new MeshBuilder();
    drapeRingWall(mb, ring, street, 0.24, -1, true, 6, undefined, () => 8);
    const zs = zsAt(mb, 0, 0);
    expect(Math.min(...zs)).toBeLessThanOrEqual(8 - 0.05 + 1e-9);
    expect(Math.max(...zs)).toBeCloseTo(10.24);
  });

  it('rises to ground standing above its top, facing the street', () => {
    const mb = new MeshBuilder();
    drapeRingWall(mb, ring, street, 0.24, -1, true, 6, undefined, () => 11);
    // Every metre along the south edge: the faces span from the foot up to the ground.
    for (let x = 0; x <= 10; x++) {
      const zs = zsAt(mb, x, 0);
      expect(Math.min(...zs)).toBeCloseTo(9);
      expect(Math.max(...zs)).toBeCloseTo(11);
    }
    // The retaining face's normal points into the square (north on the south edge).
    const n = mb.normals;
    let inward = false;
    for (let v = 0; v < mb.vertexCount; v++)
      if (mb.positions[v * 3 + 1] > 10.5 && Math.abs(mb.positions[v * 3 + 2]) < 1e-6)
        inward ||= -n[v * 3 + 2] > 0.9;
    expect(inward).toBe(true);
  });

  it('without ground beside, keeps its fixed foot', () => {
    const mb = new MeshBuilder();
    drapeRingWall(mb, ring, street, 0.24, -1, true, 6);
    expect(Math.min(...zsAt(mb, 0, 0))).toBeCloseTo(9);
  });
});
