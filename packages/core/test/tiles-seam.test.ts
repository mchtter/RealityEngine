import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileCity } from '../src/compile';
import { intersection, totalArea } from '../src/poly';
import { tileFrame } from '../src/tiles';
import type { CityModel, CitySource, Polygon } from '../src/types';

const FIXTURE = resolve(__dirname, 'fixtures/demo-city.json');

/** Footprint in frame-global UTM metres. */
const globalFootprint = (m: CityModel, p: Polygon): Polygon => {
  const [ox, oy] = [m.frame!.originE, m.frame!.originN];
  return {
    outer: p.outer.map(([x, y]) => [x + ox, y + oy]),
    holes: p.holes.map((h) => h.map(([x, y]) => [x + ox, y + oy])),
  };
};

describe.skipIf(!existsSync(FIXTURE))(
  'adjacent tiles',
  () => {
    const source = JSON.parse(readFileSync(FIXTURE, 'utf8')) as CitySource;
    // Demo city center: 31.79E 41.45N is in utm36/398/4589, close to its east edge.
    const west = compileCity({ ...source, frame: tileFrame('utm36/398/4589') });
    const east = compileCity({ ...source, frame: tileFrame('utm36/399/4589') });

    it('assign every observed building to exactly one tile', () => {
      const refs = (m: CityModel) =>
        m.buildings.filter((b) => b.source !== 'synthetic').map((b) => b.ref);
      const w = new Set(refs(west));
      expect(refs(east).filter((r) => w.has(r))).toEqual([]);
      expect(w.size + refs(east).length).toBeGreaterThan(50);
    });

    it('do not overlap across the seam', () => {
      const near = (m: CityModel, x: number) =>
        m.buildings.filter((b) => b.footprint.outer.some(([bx]) => Math.abs(bx - x) < 40));
      const w = near(west, 1000).map((b) => globalFootprint(west, b.footprint));
      const e = near(east, 0).map((b) => globalFootprint(east, b.footprint));
      expect(w.length + e.length).toBeGreaterThan(5);
      expect(totalArea(intersection(w, e))).toBeLessThan(0.5);
    });

    it('share identical terrain heights on the common edge', () => {
      const t1 = west.terrain;
      const t2 = east.terrain;
      expect(t1.rows).toBe(t2.rows);
      for (let j = 0; j < t1.rows; j++) {
        expect(t1.heights[j * t1.cols + (t1.cols - 1)]).toBe(t2.heights[j * t2.cols]);
      }
    });

    it('cut surfaces at the tile edge', () => {
      for (const m of [west, east]) {
        for (const sf of m.surfaces) {
          for (const p of sf.polygons) {
            for (const [x, y] of p.outer) {
              expect(x).toBeGreaterThanOrEqual(-0.02);
              expect(x).toBeLessThanOrEqual(1000.02);
              expect(y).toBeGreaterThanOrEqual(-0.02);
              expect(y).toBeLessThanOrEqual(1000.02);
            }
          }
        }
      }
    });

    it('cut walls at the tile edge (each tile draws its part on its own terrain)', () => {
      let walls = 0;
      for (const m of [west, east])
        for (const f of m.fences ?? []) {
          walls++;
          for (const [x, y] of f.points) {
            expect(x).toBeGreaterThanOrEqual(-0.02);
            expect(x).toBeLessThanOrEqual(1000.02);
            expect(y).toBeGreaterThanOrEqual(-0.02);
            expect(y).toBeLessThanOrEqual(1000.02);
          }
        }
      expect(walls).toBeGreaterThan(10);
    });
  },
  120_000,
);
