import { describe, expect, it } from 'vitest';
import { SEGMENT_LENGTH, findSegment, locate, objectIdOf } from '../src/locate';
import type { Building, Prop, Road } from '../src/types';

const road = (over: Partial<Road> = {}): Road =>
  ({
    id: 'r:osm:w1',
    ref: 'osm:w1',
    entity: 'e-road-1',
    name: 'Gazipaşa Caddesi',
    cls: 'tertiary',
    grade: 'ground',
    layer: 0,
    centerline: [
      [0, 0],
      [100, 0],
    ],
    width: 7,
    sidewalk: 2,
    lanes: 2,
    oneway: false,
    ...over,
  }) as Road;

const building = {
  id: 'b:maks:4711',
  ref: 'maks:4711',
  entity: 'e-building-1',
  archetype: 'klasik',
  attrs: { name: 'Onay Apt.' },
  footprint: {
    outer: [
      [10, 10],
      [30, 10],
      [30, 25],
      [10, 25],
    ],
    holes: [],
  },
} as unknown as Building;

const lamp = {
  id: 'p:osm:n9',
  kind: 'street-lamp',
  position: [50, 4.5, 0],
  heading: 0,
  scale: 1,
  provenance: 'observed',
} as Prop;

const model = { roads: [road()], buildings: [building], props: [lamp], areas: [] };

describe('locate: the city object at a point', () => {
  it('prefers the canonical entity id, then the source ref', () => {
    expect(objectIdOf({ id: 'b:x', ref: 'osm:w1', entity: 'e1' })).toBe('e1');
    expect(objectIdOf({ id: 'b:x', ref: 'osm:w1' })).toBe('osm:w1');
    expect(objectIdOf({ id: 'b:x' })).toBe('b:x');
  });

  it('finds the building a point lies in', () => {
    expect(locate(model, [20, 20])).toMatchObject({
      kind: 'building',
      id: 'e-building-1',
      name: 'Onay Apt.',
    });
  });

  it('finds a point object right at the point before the street under it', () => {
    expect(locate(model, [50.3, 4.6])).toMatchObject({ kind: 'prop', id: 'p:osm:n9' });
  });

  it('cuts a street into 25 m carriageway and sidewalk segments, left / right of its direction', () => {
    const c = locate(model, [60, 1])!;
    expect(c).toMatchObject({
      kind: 'carriageway',
      id: 'e-road-1:C:2',
      parent: 'e-road-1',
      name: 'Gazipaşa Caddesi',
      range: [50, 75],
    });
    expect(locate(model, [30, 4.5])).toMatchObject({ kind: 'sidewalk', id: 'e-road-1:L:1' });
    expect(locate(model, [30, -4.5])).toMatchObject({ kind: 'sidewalk', id: 'e-road-1:R:1' });
    expect(locate(model, [30, 9])).toBeNull();
  });

  it('gives back a segment from its id, outlined on its band', () => {
    const seg = findSegment(model, 'e-road-1:L:3')!;
    expect(seg.index).toBe(3);
    const xs = seg.outline.map((p) => p[0]);
    const ys = seg.outline.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(3 * SEGMENT_LENGTH);
    expect(Math.max(...xs)).toBeCloseTo(4 * SEGMENT_LENGTH);
    expect(Math.min(...ys)).toBeCloseTo(3.5);
    expect(Math.max(...ys)).toBeCloseTo(5.5);
    expect(findSegment(model, 'e-road-1:C:9')).toBeNull();
  });
});
