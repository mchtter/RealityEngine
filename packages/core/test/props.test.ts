import { describe, expect, it } from 'vitest';
import { clearOfCuts } from '../src/props';
import type { Prop } from '../src/types';

const prop = (id: string, kind: Prop['kind'], x: number, y: number, observed = false): Prop => ({
  id,
  kind,
  position: [x, y, 0],
  heading: 0,
  scale: 1,
  provenance: observed ? 'observed' : 'inferred',
});

describe('clearOfCuts', () => {
  // An underpass trench 10 m wide along x, from x = 0 to 100.
  const trench = {
    outer: [
      [0, -5],
      [100, -5],
      [100, 5],
      [0, 5],
    ] as [number, number][],
    holes: [],
  };

  it('keeps generated trees off the retaining walls, and leaves the rest', () => {
    const kept = clearOfCuts(
      [
        prop('in-wall', 'tree', 50, 5.3),
        prop('by-wall', 'tree', 50, 5.8),
        prop('clear', 'tree', 50, 6.5),
        prop('mapped', 'tree', 50, 5.3, true),
        prop('lamp', 'street-lamp', 50, 5.3),
      ],
      { trenches: [trench], lids: [] },
    ).map((p) => p.id);
    expect(kept).toEqual(['clear', 'mapped', 'lamp']);
  });
});
