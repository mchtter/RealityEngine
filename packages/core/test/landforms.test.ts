import { describe, expect, it } from 'vitest';
import { sharpenLandforms, terrainHeightAt } from '../src/terrain';
import type { TerrainGrid } from '../src/types';

/** 400 × 400 m, 4 m cells: land falls from `top` (y ≥ 260) to −4 m (y ≤ 150) — a smeared cliff. */
const bank = (top: number): TerrainGrid => {
  const cell = 4;
  const cols = 101;
  const rows = 101;
  const heights: number[] = [];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const y = j * cell;
      const f = Math.min(1, Math.max(0, (y - 150) / 110));
      heights.push(-4 + (top + 4) * f);
    }
  return { minX: 0, minY: 0, cellSize: cell, cols, rows, heights, seaLevel: 0 };
};

// Coastline along y = 205 running west → east: land (left) to the north.
const coast = {
  points: [
    [0, 205],
    [400, 205],
  ] as [number, number][],
  tags: { natural: 'coastline' },
};

describe('sharpenLandforms', () => {
  it('turns a high coast smeared over 110 m into a cliff falling within a cell or two', () => {
    const t = bank(36);
    expect(sharpenLandforms(t, [coast])).toBeGreaterThan(0);
    const at = (y: number) => terrainHeightAt(t, 200, y);
    expect(at(210)).toBeGreaterThan(33); // the plateau runs out to the edge …
    expect(at(200)).toBeLessThan(0); // … and drops to the sea within ~10 m
    for (let y = 210; y < 300; y += 8) expect(at(y + 8)).toBeGreaterThanOrEqual(at(y) - 0.01); // no dip behind the edge
    expect(at(300)).toBeCloseTo(36, 0); // beyond the band: unchanged
  });

  it('leaves a low shore (beach) as it is', () => {
    const t = bank(8);
    const before = [...t.heights];
    expect(sharpenLandforms(t, [coast])).toBe(0);
    expect(t.heights).toEqual(before);
  });

  it('sharpens a mapped cliff inland (top on the left)', () => {
    const t = bank(36);
    const cliff = {
      points: [
        [0, 205],
        [400, 205],
      ] as [number, number][],
      tags: { natural: 'cliff' },
    };
    sharpenLandforms(t, [cliff]);
    expect(terrainHeightAt(t, 200, 212) - terrainHeightAt(t, 200, 198)).toBeGreaterThan(25);
  });
});
