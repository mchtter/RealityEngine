import { describe, expect, it } from 'vitest';
import {
  AIR_CLEARANCE,
  MAX_PREDICT_S,
  easeAngle,
  liveHeight,
  minScreenScale,
  nearestOnScreen,
  predictXY,
  staleFade,
  yawOf,
} from './live-motion';

describe('predictXY (dead reckoning)', () => {
  it('carries a fix along its heading at its speed', () => {
    const [x, y] = predictXY(100, 200, 90, 10, 3); // east, 10 m/s, 3 s
    expect(x).toBeCloseTo(130);
    expect(y).toBeCloseTo(200);
    const [x2, y2] = predictXY(0, 0, 0, 250, 2); // north
    expect(x2).toBeCloseTo(0);
    expect(y2).toBeCloseTo(500);
  });

  it('stops after MAX_PREDICT_S', () => {
    const [, y] = predictXY(0, 0, 0, 100, 600);
    expect(y).toBeCloseTo(100 * MAX_PREDICT_S);
  });

  it('keeps the fix without course, speed or with a standing object', () => {
    expect(predictXY(5, 6, undefined, 10, 3)).toEqual([5, 6]);
    expect(predictXY(5, 6, 90, undefined, 3)).toEqual([5, 6]);
    expect(predictXY(5, 6, 90, 0.2, 3)).toEqual([5, 6]);
    expect(predictXY(5, 6, Number.NaN, 10, 3)).toEqual([5, 6]);
    expect(predictXY(5, 6, 90, 10, -1)).toEqual([5, 6]);
  });
});

describe('liveHeight', () => {
  it('puts an object without altitude on the ground', () => {
    expect(liveHeight(undefined, 42)).toBe(42);
  });

  it('flies an aircraft at its altitude above sea level', () => {
    expect(liveHeight(3000, 42)).toBe(3000);
  });

  it('keeps an altitude below the ground (bad fix, taxiing) just above it', () => {
    expect(liveHeight(10, 42)).toBe(42 + AIR_CLEARANCE);
    expect(liveHeight(Number.NaN, 42)).toBe(42);
  });
});

describe('heading → yaw', () => {
  it('turns north-facing models clockwise seen from above', () => {
    expect(yawOf(0)).toBeCloseTo(0);
    expect(yawOf(90)).toBeCloseTo(-Math.PI / 2);
  });

  it('eases the short way round', () => {
    // From 350° to 10°: 20° clockwise, not 340° back.
    const from = yawOf(350);
    const to = yawOf(10);
    const mid = easeAngle(from, to, 0.5);
    const deg = ((((-mid * 180) / Math.PI) % 360) + 360) % 360;
    expect(deg).toBeCloseTo(0, 5);
  });
});

describe('minScreenScale', () => {
  it('is 1 while the object is big enough', () => {
    expect(minScreenScale(100, 45, 1000, 36, 30)).toBe(1);
  });

  it('scales a far object up to the minimum size in pixels', () => {
    // 20 km away, 45° fov, 1000 px: 16.57 m per px → 30 px = 497 m → 497 / 36.
    const s = minScreenScale(20_000, 45, 1000, 36, 30);
    const metresPerPx = (2 * 20_000 * Math.tan((22.5 * Math.PI) / 180)) / 1000;
    expect(s).toBeCloseTo((30 * metresPerPx) / 36);
  });

  it('is capped', () => {
    expect(minScreenScale(1e7, 45, 1000, 1, 30, 60)).toBe(60);
  });
});

describe('staleFade', () => {
  it('is fresh for half the stale time, then fades to 1', () => {
    expect(staleFade(0, 120_000)).toBe(0);
    expect(staleFade(60_000, 120_000)).toBe(0);
    expect(staleFade(90_000, 120_000)).toBeCloseTo(0.5);
    expect(staleFade(200_000, 120_000)).toBe(1);
  });
});

describe('nearestOnScreen', () => {
  const pts = [
    { x: 100, y: 100, radius: 2 },
    null,
    { x: 108, y: 100, radius: 2 },
    { x: 400, y: 300, radius: 60 },
  ];

  it('picks the nearest object within 12 px', () => {
    expect(nearestOnScreen(pts, 105, 100)).toBe(2);
    expect(nearestOnScreen(pts, 101, 101)).toBe(0);
  });

  it('misses beyond 12 px of small objects', () => {
    expect(nearestOnScreen(pts, 100, 130)).toBe(-1);
  });

  it('hits a large drawn object anywhere within its radius', () => {
    expect(nearestOnScreen(pts, 440, 300)).toBe(3);
  });
});
