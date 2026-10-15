import { describe, expect, it } from 'vitest';
import {
  PolygonIndex,
  clampStep,
  densifyRing,
  insideRingsLonLat,
  interiorPoint,
  outerRings,
  simplifyRing,
} from './boundary-geo';

/** A 1000 × 1000 square. */
const square = [0, 0, 1000, 0, 1000, 1000, 0, 1000];
/** A U open to the north: the notch 400–600 × 300–1000 is outside. */
const u = [0, 0, 1000, 0, 1000, 1000, 600, 1000, 600, 300, 400, 300, 400, 1000, 0, 1000];

describe('outerRings', () => {
  it('takes the outer ring of each polygon and ignores bad input', () => {
    const ring = [
      [30, 39],
      [31, 39],
      [31, 40],
      [30, 39],
    ];
    expect(outerRings({ type: 'Polygon', coordinates: [ring, ring] })).toHaveLength(1);
    expect(outerRings({ type: 'MultiPolygon', coordinates: [[ring], [ring]] })).toHaveLength(2);
    expect(outerRings(null)).toEqual([]);
    expect(outerRings({ type: 'Point', coordinates: [1, 2] })).toEqual([]);
    expect(outerRings({ type: 'Polygon', coordinates: [[[1, 2]]] })).toEqual([]);
  });

  it('tests geographic points and finds one inside', () => {
    const rings = outerRings({
      type: 'Polygon',
      coordinates: [
        [
          [32, 39],
          [33, 39],
          [33, 40],
          [32.6, 40],
          [32.6, 39.3],
          [32.4, 39.3],
          [32.4, 40],
          [32, 40],
          [32, 39],
        ],
      ],
    });
    expect(insideRingsLonLat(rings, 32.2, 39.5)).toBe(true);
    expect(insideRingsLonLat(rings, 32.5, 39.8)).toBe(false);
    const p = interiorPoint(rings)!;
    expect(insideRingsLonLat(rings, p[0], p[1])).toBe(true);
  });
});

describe('simplifyRing', () => {
  it('drops vertices on straight edges and keeps the corners', () => {
    const dense: number[] = [];
    for (let i = 0; i < 100; i++) dense.push(i * 10, 0);
    for (let i = 0; i < 100; i++) dense.push(1000, i * 10);
    for (let i = 0; i < 100; i++) dense.push(1000 - i * 10, 1000);
    for (let i = 0; i < 100; i++) dense.push(0, 1000 - i * 10);
    const s = simplifyRing(dense, 50);
    expect(s.length / 2).toBe(4);
    const corners = new Set<string>();
    for (let i = 0; i < s.length; i += 2) corners.add(`${s[i]},${s[i + 1]}`);
    expect(corners).toEqual(new Set(['0,0', '1000,0', '1000,1000', '0,1000']));
  });

  it('keeps detail larger than the tolerance', () => {
    const s = simplifyRing(u, 50);
    expect(s.length).toBe(u.length);
  });

  it('drops wiggles smaller than the tolerance', () => {
    const noisy: number[] = [];
    for (let i = 0; i < 200; i++) noisy.push(i * 5, i % 2 ? 10 : -10);
    noisy.push(1000, 500, 0, 500);
    const s = simplifyRing(noisy, 50);
    expect(s.length / 2).toBeLessThanOrEqual(5);
  });
});

describe('densifyRing', () => {
  it('splits long edges', () => {
    const d = densifyRing(square, 250);
    expect(d.length / 2).toBe(16);
  });
});

describe('PolygonIndex', () => {
  it('tests inside / outside on a concave ring', () => {
    const idx = new PolygonIndex([u], 8);
    expect(idx.contains(200, 500)).toBe(true);
    expect(idx.contains(500, 100)).toBe(true);
    expect(idx.contains(500, 600)).toBe(false);
    expect(idx.contains(-10, 500)).toBe(false);
    expect(idx.contains(1500, 500)).toBe(false);
  });

  it('handles several rings', () => {
    const other = square.map((v, i) => (i % 2 === 0 ? v + 5000 : v));
    const idx = new PolygonIndex([square, other]);
    expect(idx.contains(500, 500)).toBe(true);
    expect(idx.contains(5500, 500)).toBe(true);
    expect(idx.contains(3000, 500)).toBe(false);
  });

  it('finds the nearest boundary point, near and far', () => {
    const idx = new PolygonIndex([u], 8);
    const a = idx.nearest(500, 700)!;
    expect(Math.abs(a.dist - 100)).toBeLessThan(1e-6);
    expect([400, 600]).toContain(Math.round(a.x));
    const b = idx.nearest(-20000, 500)!;
    expect(b.x).toBeCloseTo(0);
    expect(b.dist).toBeCloseTo(20000);
    const c = idx.nearest(1300, 1400)!;
    expect(c.x).toBeCloseTo(1000);
    expect(c.y).toBeCloseTo(1000);
  });

  it('matches a brute-force nearest search', () => {
    const ring: number[] = [];
    for (let i = 0; i < 400; i++) {
      const a = (i / 400) * Math.PI * 2;
      const r = 5000 + 1500 * Math.sin(a * 7);
      ring.push(r * Math.cos(a), r * Math.sin(a));
    }
    const idx = new PolygonIndex([ring], 32);
    for (const [x, y] of [
      [9000, 0],
      [0, -8000],
      [100, 200],
      [-30000, 25000],
    ]) {
      let best = Infinity;
      for (let i = 0; i < 400; i++) {
        const j = (i + 1) % 400;
        const [ax, ay, bx, by] = [ring[2 * i], ring[2 * i + 1], ring[2 * j], ring[2 * j + 1]];
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
        best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y));
      }
      expect(idx.nearest(x, y)!.dist).toBeCloseTo(best, 6);
    }
  });

  it('puts the inward point just inside', () => {
    const idx = new PolygonIndex([u], 8);
    for (const [x, y] of [
      [500, 700],
      [-300, 500],
      [1200, 1300],
    ]) {
      const [gx, gy] = idx.inwardPoint(x, y, 25)!;
      expect(idx.contains(gx, gy)).toBe(true);
      expect(idx.nearest(gx, gy)!.dist).toBeLessThanOrEqual(25 + 1e-6);
    }
  });

  it('is empty without rings', () => {
    const idx = new PolygonIndex([]);
    expect(idx.contains(0, 0)).toBe(false);
    expect(idx.nearest(0, 0)).toBeNull();
  });
});

describe('clampStep', () => {
  it('eases towards the goal without overshoot and arrives', () => {
    let p: [number, number] = [0, 0];
    const goal: [number, number] = [100, -50];
    let prev = Infinity;
    for (let f = 0; f < 120; f++) {
      const [dx, dy] = clampStep(p, goal, 1 / 60);
      p = [p[0] + dx, p[1] + dy];
      const d = Math.hypot(goal[0] - p[0], goal[1] - p[1]);
      expect(d).toBeLessThanOrEqual(prev);
      prev = d;
    }
    expect(p[0]).toBeCloseTo(100);
    expect(p[1]).toBeCloseTo(-50);
  });

  it('never moves on a zero time step, except the last half metre', () => {
    expect(clampStep([0, 0], [10, 0], 0)).toEqual([0, 0]);
    expect(clampStep([0, 0], [0.3, 0], 0)).toEqual([0.3, 0]);
  });
});
