import { describe, expect, it } from 'vitest';
import { straightRuns, straightestRun, streetLines } from './street-lines';

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

describe('streetLines joining', () => {
  it('joins pieces of one name meeting end to end, walking one backwards', () => {
    const lines = streetLines([
      {
        name: 'Cad.',
        cls: 'residential',
        grade: 'ground',
        centerline: [
          [0, 0],
          [40, 0],
        ],
        profile: [1, 2],
      },
      // Drawn the other way: from the far end back to the junction at (40, 0).
      {
        name: 'Cad.',
        cls: 'secondary',
        grade: 'ground',
        centerline: [
          [100, 0],
          [40, 0],
        ],
        profile: [4, 2],
      },
      {
        name: 'Başka',
        cls: 'residential',
        grade: 'ground',
        centerline: [
          [40, 0],
          [40, 50],
        ],
        profile: [2, 3],
      },
    ]);
    const cad = lines.find((l) => l.name === 'Cad.');
    expect(lines).toHaveLength(2);
    expect(cad?.rank).toBe(4);
    expect(cad?.path).toEqual([
      [0, 0, 1],
      [40, 0, 2],
      [100, 0, 4],
    ]);
  });
});

describe('straightRuns', () => {
  it('lists every straight run in order', () => {
    const runs = straightRuns([
      [0, 0, 0],
      [30, 0, 0],
      [30, 40, 0],
    ]);
    expect(runs.map((r) => r.length)).toEqual([30, 40]);
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
