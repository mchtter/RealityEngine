import { describe, expect, it } from 'vitest';
import { layGuideways } from '../src/guideways';
import type { SourceRoad } from '../src/osm';
import { totalArea } from '../src/poly';

const line = (
  ref: string,
  points: [number, number][],
  tags: Record<string, string>,
): SourceRoad => ({
  ref,
  source: 'osm',
  priority: 0,
  tags,
  points,
});

describe('layGuideways', () => {
  it('paves a runway with its paint and a taxiway with a yellow centreline', () => {
    const g = layGuideways([
      line(
        'rw',
        [
          [-1500, 0],
          [1500, 0],
        ],
        { highway: 'runway', width: '45' },
      ),
      line(
        'tw',
        [
          [-1000, 120],
          [0, 120],
          [200, 300],
        ],
        { highway: 'taxiway' },
      ),
    ]);
    // 3000 × 45 m and ≈1270 × 23 m of asphalt.
    expect(totalArea(g.airfield)).toBeGreaterThan(3000 * 45 + 1200 * 23 - 1);
    // Runway paint (airfield.ts covers it in detail): side stripes, keys, centreline.
    expect(g.markings.filter((m) => m.kind === 'airfield-white').length).toBeGreaterThan(60);
    expect(g.lights.length).toBeGreaterThan(100);
    const yellow = g.markings.filter((m) => m.kind === 'taxiway-center');
    expect(yellow).toHaveLength(1);
    // The taxiway's yellow line follows its centreline, bend included.
    expect(yellow[0].points.some((p) => p[1] > 200)).toBe(true);
    expect(g.rails).toEqual([]);
  });

  it('lays rail at the surface and leaves tunnels out', () => {
    const g = layGuideways([
      line(
        'izban',
        [
          [0, 0],
          [500, 0],
        ],
        { highway: 'rail' },
      ),
      line(
        'metro',
        [
          [0, 50],
          [500, 50],
        ],
        { highway: 'subway', tunnel: 'yes' },
      ),
      line(
        'tram',
        [
          [0, 100],
          [500, 100],
        ],
        { highway: 'tram' },
      ),
      line(
        'street',
        [
          [0, 150],
          [500, 150],
        ],
        { highway: 'residential' },
      ),
    ]);
    expect(g.rails.map((r) => [r.kind, r.tracks])).toEqual([
      ['rail', 2],
      ['tram', 1],
    ]);
    // Their beds keep trees and infill off.
    expect(totalArea(g.footprint)).toBeGreaterThan(500 * 8);
  });
});
