import { describe, expect, it } from 'vitest';
import { transferGrades } from '../src/grade';
import type { SourceRoad } from '../src/osm';

const road = (ref: string, points: [number, number][], tags: Record<string, string>) =>
  ({ ref, source: ref.split(':')[0], priority: 0, tags, points }) as unknown as SourceRoad;

describe('transferGrades', () => {
  it('keeps an authoritative road with a grade of its own whole', () => {
    // The register's viaduct way and another source's copy of it, sampled short of its end.
    const own = road(
      'reg:1',
      [
        [0, 0],
        [41.3, 0],
      ],
      { highway: 'motorway', bridge: 'yes', layer: '1' },
    );
    const copy = road(
      'osm:1',
      [
        [0, 0.5],
        [40, 0.5],
      ],
      { highway: 'motorway', bridge: 'yes', layer: '1' },
    );
    const { roads, absorbed } = transferGrades([own], [copy]);
    expect(roads).toEqual([own]);
    expect(absorbed.has(copy)).toBe(true);
  });

  it('leaves no short ungraded piece at the end of a transferred bridge', () => {
    const register = road(
      'reg:2',
      [
        [-100, 0],
        [43, 0],
      ],
      { highway: 'tertiary' },
    );
    const bridge = road(
      'osm:2',
      [
        [0, 1],
        [40, 1],
      ],
      { highway: 'tertiary', bridge: 'yes', layer: '1' },
    );
    const { roads } = transferGrades([register], [bridge]);
    const pieces = roads.map((r) => ({
      bridge: r.tags.bridge ?? null,
      from: Math.round(r.points[0][0]),
      to: Math.round(r.points[r.points.length - 1][0]),
    }));
    expect(pieces).toEqual([
      { bridge: null, from: -100, to: 0 },
      { bridge: 'yes', from: 0, to: 43 },
    ]);
  });

  it('absorbs a short copy of a graded authoritative road', () => {
    // The same 3 m footbridge piece from the register and from another source.
    const own = road(
      'reg:3',
      [
        [0, 0],
        [3, 0],
      ],
      { highway: 'footway', bridge: 'yes', layer: '1' },
    );
    const copy = road(
      'osm:3',
      [
        [0.1, 0.1],
        [3, 0.1],
      ],
      { highway: 'footway', bridge: 'yes', layer: '1' },
    );
    const { roads, absorbed } = transferGrades([own], [copy]);
    expect(roads).toEqual([own]);
    expect(absorbed.has(copy)).toBe(true);
  });
});
