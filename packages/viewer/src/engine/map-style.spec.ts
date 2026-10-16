import { POI_KINDS } from '@opentwin/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP_STYLE, rangeOf } from './map-style';

describe('map style', () => {
  it('gives every point-of-interest kind of the contract a colour and a rank', () => {
    for (const kind of Object.keys(POI_KINDS)) {
      const cat = DEFAULT_MAP_STYLE.pois.categories[kind];
      expect(cat, kind).toBeDefined();
      expect(cat.colour).toMatch(/^#[0-9a-f]{6}$/);
      expect(rangeOf(DEFAULT_MAP_STYLE.pois.ranges, cat.rank)).toBeDefined();
    }
  });

  it('is plain JSON, and a rank it does not list takes the lowest one', () => {
    expect(JSON.parse(JSON.stringify(DEFAULT_MAP_STYLE))).toEqual(DEFAULT_MAP_STYLE);
    expect(rangeOf(DEFAULT_MAP_STYLE.streets.ranges, 0)).toEqual(
      DEFAULT_MAP_STYLE.streets.ranges[1],
    );
  });
});
