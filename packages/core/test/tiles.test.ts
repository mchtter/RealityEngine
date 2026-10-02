import { describe, expect, it } from 'vitest';
import {
  parseTileKey,
  tileFrame,
  tileKey,
  tilesForBBox,
  utmForward,
  utmInverse,
  utmZoneOf,
} from '../src/tiles';

// Reference values: PostGIS ST_Transform (PROJ) to EPSG:326xx, 2026-10-01.
const REFERENCE: [number, number, number, number][] = [
  [31.79, 41.45, 398931.4651, 4589419.7998],
  [33.0, 39.9, 500000.0, 4416658.2929],
  [30.01, 36.5, 232193.9165, 4043566.7535],
  [35.99, 42.1, 747248.1361, 4665206.4513],
  [28.97, 41.01, 665659.5703, 4541736.3432],
];

describe('UTM', () => {
  it('matches PROJ to the millimetre across the zone', () => {
    for (const [lon, lat, e, n] of REFERENCE) {
      const [x, y] = utmForward(lon, lat, utmZoneOf(lon));
      expect(Math.abs(x - e)).toBeLessThan(0.001);
      expect(Math.abs(y - n)).toBeLessThan(0.001);
    }
  });

  it('round-trips within ~1 mm (third-order series limit at zone edges)', () => {
    for (const [lon, lat] of REFERENCE) {
      const zone = utmZoneOf(lon);
      const [x, y] = utmForward(lon, lat, zone);
      const back = utmInverse(x, y, zone);
      expect(Math.abs(back.lon - lon)).toBeLessThan(1e-8);
      expect(Math.abs(back.lat - lat)).toBeLessThan(1e-8);
    }
  });
});

describe('tile grid', () => {
  it('keys, frames and bbox coverage', () => {
    expect(tileKey(36, 398, 4589)).toBe('utm36/398/4589');
    expect(parseTileKey('utm36/398/4589')).toEqual({ zone: 36, eKm: 398, nKm: 4589 });
    expect(parseTileKey('utm36/../4589')).toBeNull();
    expect(tileFrame('utm36/398/4589')).toMatchObject({
      zone: 36,
      originE: 398000,
      originN: 4589000,
      size: 1000,
    });
    const keys = tilesForBBox([31.785, 41.445, 31.795, 41.455]);
    expect(keys).toContain('utm36/398/4589');
    expect(keys.length).toBeGreaterThanOrEqual(2);
  });
});
