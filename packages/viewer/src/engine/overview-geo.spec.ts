import { describe, expect, it } from 'vitest';
import { type Polygon, insidePolygon, overlaps, thinRing } from './overview-geo';

const square = (w: number, s: number, e: number, n: number): Polygon => [
  [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
  ],
];

describe('overview map geometry', () => {
  it('tests points against outer rings and holes', () => {
    const withHole: Polygon = [...square(0, 0, 4, 4), ...square(1, 1, 2, 2)];
    expect(insidePolygon(withHole, 3, 3)).toBe(true);
    expect(insidePolygon(withHole, 1.5, 1.5)).toBe(false);
    expect(insidePolygon(withHole, 5, 1)).toBe(false);
  });

  it('thins a ring, keeping its corners', () => {
    const ring: [number, number][] = [];
    for (let i = 0; i <= 100; i++) ring.push([i / 100, 0.0001 * Math.sin(i)]);
    ring.push([1, 1], [0, 1]);
    const thin = thinRing(ring, 0.001);
    expect(thin.length).toBeLessThan(10);
    expect(thin).toContainEqual([1, 1]);
    expect(thin).toContainEqual([0, 1]);
  });

  it('counts a province-wide area, not the border strip it spills into a neighbour', () => {
    const province = [square(32, 39, 34, 41)];
    // The work area: the province plus a 0.05° strip into the neighbour east of it.
    const area = [square(31.98, 38.98, 34.05, 41.02)];
    const neighbour = [square(34, 39, 36, 41)];
    expect(overlaps(province, area)).toBe(true);
    expect(overlaps(neighbour, area)).toBe(false);
  });

  it('counts a district-sized area inside a province', () => {
    const province = [square(32, 39, 34, 41)];
    const district = [square(32.8, 39.8, 33, 40)];
    expect(overlaps(province, district)).toBe(true);
  });
});
