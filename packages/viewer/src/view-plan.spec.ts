import { describe, expect, it } from 'vitest';
import { type EyeView, planCentre, viewScore } from './view-plan';

const eye = (o: Partial<EyeView> = {}): EyeView => ({
  e: 0,
  n: 0,
  height: 60,
  heading: 0,
  pitch: 30,
  ...o,
});

describe('view plan', () => {
  it('puts tiles in view before tiles behind the camera', () => {
    const ahead = viewScore([0, 2000], eye());
    const behind = viewScore([0, -2000], eye());
    const side = viewScore([2000, 0], eye());
    expect(ahead).toBeLessThan(side);
    expect(side).toBeLessThan(behind);
    expect(behind).toBeGreaterThan(ahead * 3);
  });

  it('treats the ground around the camera and a straight-down view alike in all directions', () => {
    expect(viewScore([0, -500], eye())).toBeCloseTo(Math.hypot(500, 60));
    const down = eye({ pitch: 89 });
    expect(viewScore([0, -2000], down)).toBeCloseTo(viewScore([0, 2000], down));
  });

  it('counts height: a tile under a high camera is not "near"', () => {
    expect(viewScore([0, 0], eye({ height: 1500 }))).toBeCloseTo(1500);
  });

  it('leans the plan toward the view and ahead of the motion', () => {
    const flat = planCentre([0, 0], eye({ height: 200 }));
    expect(flat[0]).toBeCloseTo(0);
    expect(flat[1]).toBeCloseTo(600);
    expect(planCentre([0, 0], eye({ pitch: 89 }))[1]).toBeCloseTo(0, 0);
    // East at 400 m/s: 1.5 s ahead, capped at 2 km.
    const moving = planCentre([0, 0], eye({ pitch: 89 }), [400, 0]);
    expect(moving[0]).toBeCloseTo(600);
    expect(planCentre([0, 0], eye({ pitch: 89 }), [4000, 0])[0]).toBeCloseTo(2000);
  });
});
