import { describe, expect, it } from 'vitest';
import { LEVEL_PLANS, levelAt, nextLevel } from './detail-level';

describe('detail levels', () => {
  it('maps the camera height to L5 (street) … L1 (over the city)', () => {
    expect([1.7, 9.9, 10, 99, 100, 399, 400, 1499, 1500, 9000].map(levelAt)).toEqual([
      5, 5, 4, 4, 3, 3, 2, 2, 1, 1,
    ]);
  });

  it('crosses a bound only well past it (hysteresis)', () => {
    // Up from L5: 11 m is not enough, 11.6 m is.
    expect(nextLevel(11, 5)).toBe(5);
    expect(nextLevel(11.6, 5)).toBe(4);
    // Down from L4: 9 m stays, 8.4 m goes.
    expect(nextLevel(9, 4)).toBe(4);
    expect(nextLevel(8.4, 4)).toBe(5);
    // A jump skips levels.
    expect(nextLevel(2000, 5)).toBe(1);
    expect(nextLevel(3, 1)).toBe(5);
  });

  it('loads more tiles, fewer of them in full, the higher the camera', () => {
    const plans = [5, 4, 3, 2, 1].map((l) => LEVEL_PLANS[l as 1]);
    for (let k = 1; k < plans.length; k++) {
      expect(plans[k].load).toBeGreaterThanOrEqual(plans[k - 1].load);
      expect(plans[k].full).toBeLessThanOrEqual(plans[k - 1].full);
      expect(plans[k].keep).toBeGreaterThan(plans[k].load);
    }
  });
});
