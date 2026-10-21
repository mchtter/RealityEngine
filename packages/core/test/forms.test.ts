import { describe, expect, it } from 'vitest';
import { BLANK_FORMS, formLevels, formOf, undergroundBuilding } from '../src/forms';
import { Rng } from '../src/random';

describe('building forms', () => {
  it('reads the form from the building type', () => {
    expect(formOf({ building: 'mosque' }, 400)).toBe('mosque');
    expect(formOf({ building: 'yes', amenity: 'place_of_worship' }, 400)).toBe('mosque');
    expect(
      formOf({ building: 'yes', amenity: 'place_of_worship', religion: 'christian' }, 400),
    ).toBe('block');
    expect(formOf({ building: 'church' }, 400)).toBe('church');
    expect(formOf({ building: 'industrial' }, 3000)).toBe('shed');
    expect(formOf({ man_made: 'silo' }, 900)).toBe('silo');
    expect(formOf({ building: 'storage_tank' }, 300)).toBe('tank');
    expect(formOf({ building: 'parking' }, 2000)).toBe('carpark');
    expect(formOf({ building: 'apartments' }, 400)).toBe('block');
  });

  it('reads towers and transformer buildings', () => {
    expect(formOf({ building: 'yes', man_made: 'tower', 'tower:type': 'minaret' }, 9)).toBe(
      'minaret',
    );
    expect(formOf({ building: 'communication_tower' }, 100)).toBe('telecom');
    expect(formOf({ building: 'clock_tower' }, 36)).toBe('clock');
    expect(formOf({ building: 'yes', man_made: 'tower' }, 60)).toBe('tower');
    expect(formOf({ building: 'yes', power: 'substation' }, 40)).toBe('hut');
    expect(formOf({ building: 'substation' }, 900)).toBe('shed');
    expect(formOf({ building: 'train_station' }, 900)).toBe('box');
    // A tower without a height is slender, not a stub.
    expect(formLevels('tower', 33, new Rng(1))!.floorHeight).toBeGreaterThan(20);
  });

  it('makes tiny untagged buildings huts, roofs canopies — not a house with no levels', () => {
    expect(formOf({ building: 'yes' }, 9)).toBe('hut');
    expect(formOf({ building: 'yes', 'building:levels': '2' }, 9)).toBe('block');
    expect(formOf({ building: 'yes' }, 80)).toBe('block');
    expect(formOf({ building: 'shed' }, 40)).toBe('hut');
    expect(formOf({ building: 'roof' }, 300)).toBe('canopy');
    expect(formOf({ building: 'greenhouse' }, 500)).toBe('greenhouse');
    const hut = formLevels('hut', 9, new Rng('h'))!;
    expect(hut.levels * hut.floorHeight).toBeLessThan(3);
  });

  it('tells a building wholly under the ground', () => {
    expect(undergroundBuilding({ building: 'train_station', layer: '-1' })).toBe(true);
    // A sunken building with storeys above ground stays on the surface.
    expect(undergroundBuilding({ building: 'yes', layer: '-1', 'building:levels': '3' })).toBe(
      false,
    );
    expect(undergroundBuilding({ building: 'yes' })).toBe(false);
  });

  it('makes a mall a box, but not an office tower or a corner shop', () => {
    expect(formOf({ building: 'retail' }, 12000)).toBe('box');
    expect(formOf({ building: 'retail' }, 300)).toBe('block');
    expect(formOf({ building: 'commercial' }, 5000)).toBe('block');
    expect(formOf({ building: 'retail', 'building:levels': '20' }, 5000)).toBe('block');
    // A mall said so stays a mall however tall (City Hub AVM: 8.5 storeys).
    expect(formOf({ building: 'retail', shop: 'mall', 'building:levels': '8.5' }, 3000)).toBe(
      'box',
    );
  });

  it('gives sheds one or two high storeys and silos their height', () => {
    const shed = formLevels('shed', 2000, new Rng('a'))!;
    expect(shed.levels).toBe(1);
    expect(shed.floorHeight).toBeGreaterThanOrEqual(5.5);
    const silo = formLevels('silo', 900, new Rng('b'))!;
    expect(silo.levels * silo.floorHeight).toBeGreaterThan(30);
    expect(formLevels('block', 400, new Rng('c'))).toBeNull();
    expect(BLANK_FORMS.has('shed')).toBe(true);
    expect(BLANK_FORMS.has('mosque')).toBe(false);
  });
});
