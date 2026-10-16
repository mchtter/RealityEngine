import { describe, expect, it } from 'vitest';
import { laneLayout } from '../src/lanes';

describe('laneLayout', () => {
  it('splits a two-way road by rule: the odd lane goes with the drawing direction', () => {
    const lanes = laneLayout({ lanes: 3, width: 9, oneway: false }, {});
    expect(lanes.map((l) => l.forward)).toEqual([false, true, true]);
    expect(lanes.every((l) => l.provenance === 'inferred')).toBe(true);
    // Left to right, edge to edge: middles at 3, 0, -3 for 3 m lanes.
    expect(lanes.map((l) => l.offset)).toEqual([3, 0, -3]);
  });

  it('reads lanes per direction and turn lanes from the centre outwards', () => {
    const lanes = laneLayout(
      { lanes: 4, width: 13, oneway: false },
      {
        'lanes:forward': '3',
        'lanes:backward': '1',
        'turn:lanes:forward': 'left|through|through;right',
        'turn:lanes:backward': 'through',
        'width:lanes': '3.25|3.5|3.25|3',
      },
    );
    expect(lanes.map((l) => l.forward)).toEqual([false, true, true, true]);
    // The forward lane next to the centre turns left; the outermost goes through or right.
    expect(lanes[1].turns).toEqual(['left']);
    expect(lanes[3].turns).toEqual(['through', 'right']);
    expect(lanes[0].turns).toEqual(['through']);
    expect(lanes.map((l) => l.width)).toEqual([3.25, 3.5, 3.25, 3]);
    // The lanes tile the carriageway: from +6.5 to -6.5.
    const left = lanes[0].offset + lanes[0].width / 2;
    const right = lanes[3].offset - lanes[3].width / 2;
    expect(left).toBeCloseTo(6.5);
    expect(right).toBeCloseTo(-6.5);
  });

  it("reads a one-way road's turn lanes left to right, and ignores a list of the wrong length", () => {
    const one = laneLayout(
      { lanes: 2, width: 7, oneway: true },
      { 'turn:lanes': 'left;through|right' },
    );
    expect(one.every((l) => l.forward)).toBe(true);
    expect(one.map((l) => l.turns)).toEqual([['left', 'through'], ['right']]);
    const wrong = laneLayout(
      { lanes: 2, width: 7, oneway: true },
      { 'turn:lanes': 'left|through|right' },
    );
    expect(wrong.every((l) => l.turns.length === 0)).toBe(true);
  });
});
