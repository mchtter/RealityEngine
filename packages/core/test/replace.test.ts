import { describe, expect, it } from 'vitest';
import { removeReplacedBuildings } from '../src/replace';
import type { CityModel } from '../src/types';

const model = (): CityModel =>
  ({
    buildings: [
      { id: 'b1', entity: 'e-1', ref: 'maks:1', source: 'maks' },
      { id: 'b2', ref: 'osm:w7', osmId: 7, source: 'osm' },
      { id: 'b3', source: 'synthetic' },
    ],
    props: [
      { id: 'p1', kind: 'chimney', buildingId: 'b1' },
      { id: 'p2', kind: 'chimney', buildingId: 'b3' },
      { id: 'p3', kind: 'tree' },
    ],
    stats: { buildingsObserved: 2 },
  }) as unknown as CityModel;

describe('removeReplacedBuildings', () => {
  it('drops buildings named by entity, ref or osm id with their roof props', () => {
    const m = model();
    expect(removeReplacedBuildings(m, ['e-1', '7'])).toBe(2);
    expect(m.buildings.map((b) => b.id)).toEqual(['b3']);
    expect(m.props.map((p) => p.id)).toEqual(['p2', 'p3']);
    expect(m.stats.buildingsReplaced).toBe(2);
  });

  it('leaves the model alone when nothing matches', () => {
    const m = model();
    expect(removeReplacedBuildings(m, ['nope'])).toBe(0);
    expect(m.buildings).toHaveLength(3);
    expect(m.stats.buildingsReplaced).toBeUndefined();
  });
});
