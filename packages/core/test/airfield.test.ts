import { describe, expect, it } from 'vitest';
import { layAirfield, runwayEnds } from '../src/airfield';
import type { SourceRoad } from '../src/osm';
import type { Marking, Vec2 } from '../src/types';

const way = (ref: string, points: Vec2[], tags: Record<string, string>): SourceRoad => ({
  ref,
  source: 'osm',
  priority: 0,
  tags,
  points,
});

const length = (m: Marking) =>
  m.points.reduce(
    (s, p, k) => (k ? s + Math.hypot(p[0] - m.points[k - 1][0], p[1] - m.points[k - 1][1]) : s),
    0,
  );

/** A 3240 m × 45 m runway along x, mapped in two pieces like Adnan Menderes' 16R/34L. */
const runway = [
  way(
    'rw-a',
    [
      [-1620, 0],
      [1220, 0],
    ],
    { highway: 'runway', ref: '09L/27R', width: '45' },
  ),
  way(
    'rw-b',
    [
      [1220, 0],
      [1620, 0],
    ],
    { highway: 'runway', ref: '09L/27R', width: '45' },
  ),
];

describe('runwayEnds', () => {
  it('names the end a landing on the first heading starts from', () => {
    // Drawn north → south (bearing 180°): landing on 16 starts at the north end.
    expect(
      runwayEnds('16R/34L', [
        [0, 1500],
        [0, -1500],
      ]),
    ).toEqual(['16R', '34L']);
    expect(
      runwayEnds('16R/34L', [
        [0, -1500],
        [0, 1500],
      ]),
    ).toEqual(['34L', '16R']);
    expect(
      runwayEnds(undefined, [
        [0, 0],
        [10, 0],
      ]),
    ).toEqual([]);
  });
});

describe('layAirfield', () => {
  it('joins the pieces of a runway: threshold paint at both real ends', () => {
    const f = layAirfield(runway);
    const keysAt = (x0: number, x1: number) =>
      f.markings.filter(
        (m) =>
          m.kind === 'airfield-white' &&
          Math.abs(length(m) - 30) < 0.1 &&
          m.width! > 1 &&
          m.points.every((p) => p[0] >= x0 && p[0] <= x1),
      );
    // 12 piano keys (6 a side) 6–36 m in from each threshold; none at the join.
    expect(keysAt(-1615, -1583)).toHaveLength(12);
    expect(keysAt(1583, 1615)).toHaveLength(12);
    expect(keysAt(1180, 1260)).toHaveLength(0);
  });

  it('writes the designators: the letter at the threshold, the number beyond', () => {
    const f = layAirfield(runway);
    const glyphs = (x0: number, x1: number) =>
      f.markings.filter((m) => m.width === 1.4 && m.points.every((p) => p[0] >= x0 && p[0] <= x1));
    // End 09L at x = −1620: "L" over 48–57 m, "09" over 63–72 m.
    expect(glyphs(-1620 + 47, -1620 + 58).length).toBe(3);
    expect(glyphs(-1620 + 62, -1620 + 73).length).toBe(6 + 6);
    // End 27R at the other end, read from the east.
    expect(glyphs(1620 - 58, 1620 - 47).length).toBe(6);
    expect(glyphs(1620 - 73, 1620 - 62).length).toBe(5 + 3);
  });

  it('lights a precision runway: approach flashers in sequence, PAPI, threshold and end', () => {
    const f = layAirfield(runway);
    const of = (k: string) => f.lights.filter((l) => l.kind === k);
    const flash = of('approach-flash');
    expect(flash).toHaveLength(2 * 21);
    // The flash runs in toward the threshold: farthest out first.
    const west = flash.filter((l) => l.at[0] < 0).sort((a, b) => a.seq! - b.seq!);
    expect(west[0].at[0]).toBeCloseTo(-1620 - 900);
    expect(west.at(-1)!.at[0]).toBeCloseTo(-1620 - 300);
    expect(of('papi').map((l) => l.angle)).toEqual([3.5, 3.17, 2.83, 2.5, 3.5, 3.17, 2.83, 2.5]);
    // PAPI on the pilot's left: landing eastbound (09L), left is north (+y).
    expect(
      of('papi')
        .filter((l) => l.at[0] < 0)
        .every((l) => l.at[1] > 22.5),
    ).toBe(true);
    // Threshold green faces the approach (west at the west end), end red the runway.
    const green = of('threshold').filter((l) => l.at[0] < 0);
    expect(green.every((l) => Math.abs(Math.cos(l.dir!) + 1) < 1e-6)).toBe(true);
    const red = of('end').filter((l) => l.at[0] < 0);
    expect(red.every((l) => Math.abs(Math.cos(l.dir!) - 1) < 1e-6)).toBe(true);
    // The centreline turns red near either end, for the direction that ends there.
    expect(of('center-red').length).toBeGreaterThan(40);
    expect(of('reil')).toHaveLength(0);
  });

  it('holds a taxiway short of the runway: markings and a red stop bar 90 m out', () => {
    const f = layAirfield([
      ...runway,
      way(
        'tw',
        [
          [0, -400],
          [0, 0],
        ],
        { highway: 'taxiway' },
      ),
    ]);
    const bar = f.lights.filter((l) => l.kind === 'stopbar');
    expect(bar.length).toBeGreaterThan(4);
    expect(bar.every((l) => Math.abs(l.at[1] + 93) < 0.6)).toBe(true);
    const hold = f.markings.filter(
      (m) => m.kind === 'airfield-yellow' && m.width === 0.3 && m.points.every((p) => p[1] < -80),
    );
    // Two solid lines across, two dashed ones (in pieces).
    expect(hold.filter((m) => length(m) > 15)).toHaveLength(2);
    expect(hold.filter((m) => length(m) <= 1.01).length).toBeGreaterThan(10);
    // No green centreline light on the runway itself.
    expect(f.lights.filter((l) => l.kind === 'taxi-center').every((l) => l.at[1] < -22.5)).toBe(
      true,
    );
  });

  it('marks a stopway with chevrons toward the runway and sets out windsocks', () => {
    const f = layAirfield([
      ...runway,
      way(
        'sw',
        [
          [1620, 0],
          [1680, 0],
        ],
        { highway: 'stopway' },
      ),
    ]);
    const chevrons = f.markings.filter(
      (m) => m.kind === 'airfield-yellow' && m.points.every((p) => p[0] > 1619),
    );
    expect(chevrons).toHaveLength(4);
    // The apex of each chevron is its runway-side end.
    expect(chevrons.every((m) => m.points[0][0] < m.points[1][0] && m.points[0][1] === 0)).toBe(
      true,
    );
    expect(f.props.filter((p) => p.kind === 'windsock')).toHaveLength(2);
  });
});
