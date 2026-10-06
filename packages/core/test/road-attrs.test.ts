import { describe, expect, it } from 'vitest';
import type { SourceRoad } from '../src/osm';
import { classifyRoads } from '../src/roads';

const road = (tags: Record<string, string>): SourceRoad =>
  ({
    ref: 'osm:w1',
    osmId: 1,
    tags: { highway: 'footway', ...tags },
    points: [
      [0, 0],
      [100, 0],
    ],
  }) as unknown as SourceRoad;

describe('road width / lanes from the source', () => {
  it('sets aside a width impossible for the class (a 1581 m footway)', () => {
    const [r] = classifyRoads([road({ width: '1581' })]);
    expect(r.width).toBe(2);
    expect(r.rejected).toEqual({ width: 1581 });
    expect(r.provenance.width).toBe('inferred');
  });

  it('keeps a plausible width', () => {
    const [r] = classifyRoads([road({ highway: 'residential', width: '7.5' })]);
    expect(r.width).toBe(7.5);
    expect(r.rejected).toBeUndefined();
  });

  it('sets aside an impossible lane count', () => {
    const [r] = classifyRoads([road({ highway: 'residential', lanes: '40' })]);
    expect(r.rejected).toEqual({ lanes: 40 });
    expect(r.lanes).toBe(2);
  });

  it('draws a service road closed to motor traffic as a path', () => {
    const [a] = classifyRoads([road({ highway: 'service', motor_vehicle: 'no' })]);
    const [b] = classifyRoads([road({ highway: 'track', bicycle: 'designated' })]);
    const [c] = classifyRoads([road({ highway: 'service' })]);
    expect([a.cls, b.cls, c.cls]).toEqual(['footway', 'footway', 'service']);
  });
});
