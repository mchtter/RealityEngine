import { describe, expect, it } from 'vitest';
import { LEVEL_PLANS, levelAt, nextLevel } from './detail-level';

describe('detail levels', () => {
  it('maps the camera height to L1 … L5', () => {
    expect([1.7, 9.9, 10, 99, 100, 399, 400, 1499, 1500, 9000].map(levelAt)).toEqual([
      1, 1, 2, 2, 3, 3, 4, 4, 5, 5,
    ]);
  });

  it('crosses a bound only well past it (hysteresis)', () => {
    // Up from L1: 11 m is not enough, 11.6 m is.
    expect(nextLevel(11, 1)).toBe(1);
    expect(nextLevel(11.6, 1)).toBe(2);
    // Down from L2: 9 m stays, 8.4 m goes.
    expect(nextLevel(9, 2)).toBe(2);
    expect(nextLevel(8.4, 2)).toBe(1);
    // A jump skips levels.
    expect(nextLevel(2000, 1)).toBe(5);
    expect(nextLevel(3, 5)).toBe(1);
  });

  it('loads more tiles, fewer of them in full, the higher the camera', () => {
    const plans = [1, 2, 3, 4, 5].map((l) => LEVEL_PLANS[l as 1]);
    for (let k = 1; k < plans.length; k++) {
      expect(plans[k].load).toBeGreaterThanOrEqual(plans[k - 1].load);
      expect(plans[k].full).toBeLessThanOrEqual(plans[k - 1].full);
      expect(plans[k].keep).toBeGreaterThan(plans[k].load);
    }
  });
});
