import { describe, expect, it } from 'vitest';
import { overheadSpans } from '../src/overhead';
import type { Prop } from '../src/types';

const pylon = (id: string, x: number, y: number): Prop => ({
  id,
  kind: 'pylon',
  position: [x, y, 0],
  heading: 0,
  scale: 1,
  provenance: 'observed',
});

describe('overheadSpans', () => {
  it('strings each line along its pylons, never across to a parallel line', () => {
    // Two lines 40 m apart, pylons every 300 m; the second one bends 25° at its third pylon.
    const a = [0, 1, 2, 3].map((k) => pylon(`a${k}`, k * 300, 0));
    const turn = (25 * Math.PI) / 180;
    const b = [
      pylon('b0', 0, 40),
      pylon('b1', 300, 40),
      pylon('b2', 600, 40),
      pylon('b3', 600 + 300 * Math.cos(turn), 40 + 300 * Math.sin(turn)),
    ];
    // A lone pylon far off the lines.
    const lone = pylon('x', 300, 900);
    const spans = overheadSpans([...a, ...b, lone]);
    expect(spans).toHaveLength(6);
    for (const s of spans) {
      const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      expect(len).toBeGreaterThan(250);
      expect(s.provenance).toBe('inferred');
    }
    // Cross-arms across the line: the pylons of line a face along x.
    for (const p of a) expect(Math.abs(Math.sin(p.heading))).toBeLessThan(1e-6);
  });

  it('does not skip over a pylon or turn sharply', () => {
    // Three in a row 200 m apart: two spans, not also the 400 m one over the middle.
    const row = [0, 1, 2].map((k) => pylon(`r${k}`, k * 200, 0));
    expect(overheadSpans(row)).toHaveLength(2);
    // A right angle: not one line.
    const corner = [pylon('c0', 0, 0), pylon('c1', 300, 0), pylon('c2', 300, 300)];
    expect(overheadSpans(corner)).toHaveLength(1);
  });
});
