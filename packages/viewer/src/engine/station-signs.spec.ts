import type { CityModel } from '@kavra/core';
import { describe, expect, it } from 'vitest';
import { stationSigns } from './station-signs';

const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

describe('stationSigns', () => {
  it("names a platform's boards after its concourse and the lines beside it", () => {
    const structure = (
      ref: string,
      kind: string,
      layer: number,
      floorZ: number,
      ring: [number, number][],
      name?: string,
    ) => ({
      id: `ug:${ref}`,
      ref,
      kind,
      layer,
      floorZ,
      groundZ: 860,
      footprint: { outer: ring, holes: [] },
      ...(name ? { name } : {}),
    });
    const model = {
      underground: {
        entrances: [],
        structures: [
          structure('hall', 'train_station', -1, 854, rect(-40, -20, 40, 20), 'Kızılay'),
          structure('p', 'platform', -2, 848, rect(-50, 2, 50, 8)),
        ],
        tracks: [
          {
            id: 't1',
            ref: 't1',
            name: 'M1 Line 1',
            layer: -2,
            path: [
              [-60, 0, 846.9],
              [60, 0, 846.9],
            ],
          },
          {
            id: 't2',
            ref: 't2',
            name: 'M1 Line 2',
            layer: -2,
            path: [
              [-60, 10, 846.9],
              [60, 10, 846.9],
            ],
          },
          // A line far under the platform does not stop there.
          {
            id: 't3',
            ref: 't3',
            name: 'M4 Line 1',
            layer: -4,
            path: [
              [-60, 5, 834],
              [60, 5, 834],
            ],
          },
        ],
      },
    } as unknown as CityModel;
    const signs = stationSigns(model);
    expect(signs.length).toBeGreaterThan(0);
    expect(signs[0].title).toBe('Kızılay');
    expect(signs[0].lines).toBe('M1');
    expect(signs[0].at[2]).toBeCloseTo(848 + 3.2);
  });
});
