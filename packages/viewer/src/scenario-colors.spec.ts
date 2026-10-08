import { describe, expect, it } from 'vitest';
import type { BuildingInfo } from './engine/tile-payload';
import { overlayKeyColors, scenarioColorOf } from './scenario-colors';
import type { ResolvedOverlay } from '@/store/scenario.store';

const overlay = (over: Partial<ResolvedOverlay> = {}): ResolvedOverlay => ({
  scenarioId: 's',
  scenarioName: 'S',
  layerId: 'l',
  layerKey: 'KIMLIKNO',
  expression: [
    'match',
    ['to-string', ['get', 'KIMLIKNO']],
    '1001',
    '#ff0000',
    '1002',
    '#00ff00',
    'rgba(0,0,0,0)',
  ],
  rowCount: 2,
  opacity: 0.8,
  visible: true,
  ...over,
});

const building = (over: Partial<BuildingInfo>): BuildingInfo =>
  ({ id: 'b', source: 'maks', fixIds: [], ...over }) as BuildingInfo;

describe('overlayKeyColors', () => {
  it('reads key → colour pairs and skips the transparent default', () => {
    const colors = overlayKeyColors(overlay().expression);
    expect([...colors.keys()]).toEqual(['1001', '1002']);
    expect(colors.get('1001')!.getHexString()).toBe('ff0000');
  });
});

describe('scenarioColorOf', () => {
  it('matches the join column case-insensitively, with numeric keys normalised', () => {
    const colorOf = scenarioColorOf([overlay()])!;
    expect(colorOf(building({ attrs: { kimlikno: '1002.0' } }))!.color.getHexString()).toBe(
      '00ff00',
    );
    expect(colorOf(building({ attrs: { KIMLIKNO: '9999' } }))).toBeNull();
  });

  it('falls back to the source id only when the building lacks the join column', () => {
    const colorOf = scenarioColorOf([overlay()])!;
    expect(colorOf(building({ ref: 'maks:1001' }))!.color.getHexString()).toBe('ff0000');
    // Another numbering scheme must not match by coincidence.
    expect(colorOf(building({ ref: 'maks:1001', attrs: { KIMLIKNO: '5' } }))).toBeNull();
  });

  it('matches parcel-keyed overlays on the canonical parcel id, never on the building id', () => {
    const colorOf = scenarioColorOf([overlay({ layerKey: 'tapukimlik' })])!;
    expect(colorOf(building({ parcelRef: '1001' }))!.color.getHexString()).toBe('ff0000');
    expect(colorOf(building({ ref: 'maks:1002', attrs: { kimlikno: '1002' } }))).toBeNull();
  });

  it('reports the matched key and the overlay that painted, for the legend counts', () => {
    const paint = scenarioColorOf([overlay()])!(building({ attrs: { KIMLIKNO: '1002' } }))!;
    expect(paint.key).toBe('1002');
    expect(paint.overlay).toBe('s:l');
  });

  it('paints only keys inside the selected areas when an area filter is on (as in 2D)', () => {
    const colorOf = scenarioColorOf([overlay()], { l: ['1001.0'] })!;
    expect(colorOf(building({ attrs: { KIMLIKNO: '1001' } }))!.color.getHexString()).toBe('ff0000');
    expect(colorOf(building({ attrs: { KIMLIKNO: '1002' } }))).toBeNull();
    // Another base layer's filter does not narrow this overlay.
    expect(
      scenarioColorOf([overlay()], { other: ['1001'] })!(building({ attrs: { KIMLIKNO: '1002' } })),
    ).not.toBeNull();
  });

  it('is off when no overlay is visible', () => {
    expect(scenarioColorOf([overlay({ visible: false })])).toBeNull();
    expect(scenarioColorOf([])).toBeNull();
  });
});
