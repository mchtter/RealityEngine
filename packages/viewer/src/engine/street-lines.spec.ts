import { describe, expect, it } from 'vitest';
import { straightestRun, streetLines } from './street-lines';

describe('streetLines', () => {
  it('keeps named ground streets with a profile, ranked by class', () => {
    const line: [number, number][] = [
      [0, 0],
      [50, 0],
    ];
    const lines = streetLines([
      {
        name: 'Atatürk Blv.',
        cls: 'primary',
        grade: 'ground',
        centerline: line,
        profile: [890, 891],
      },
      { name: ' ', cls: 'residential', grade: 'ground', centerline: line, profile: [1, 1] },
      { name: 'Köprü', cls: 'primary', grade: 'bridge', centerline: line, profile: [1, 1] },
      { name: 'Patika', cls: 'footway', grade: 'ground', centerline: line, profile: [1, 1] },
      { name: 'Eksik', cls: 'residential', grade: 'ground', centerline: line, profile: [] },
    ]);
    expect(lines).toEqual([
      {
        name: 'Atatürk Blv.',
        rank: 5,
        path: [
          [0, 0, 890],
          [50, 0, 891],
        ],
      },
    ]);
  });
});

describe('straightestRun', () => {
  it('takes the longest nearly straight run of a bent street', () => {
    // 30 m east, a sharp turn, then 80 m north in two slightly bent segments.
    const run = straightestRun([
      [0, 0, 0],
      [30, 0, 0],
      [30, 40, 1],
      [32, 80, 2],
    ]);
    expect(run?.a).toEqual([30, 0, 0]);
    expect(run?.b).toEqual([32, 80, 2]);
    expect(run?.length).toBeCloseTo(Math.hypot(2, 80));
  });

  it('has no run on a path of repeated points', () => {
    expect(
      straightestRun([
        [5, 5, 0],
        [5, 5, 0],
      ]),
    ).toBeNull();
  });
});
