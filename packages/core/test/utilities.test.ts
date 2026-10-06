import { describe, expect, it } from 'vitest';
import type { SourceLine, SourcePoint } from '../src/osm';
import type { Vec2 } from '../src/types';
import {
  UTILITY_CLEARANCE,
  UTILITY_SPECS,
  buildUtilities,
  utilityClashes,
  utilityKindOf,
} from '../src/utilities';

const line = (ref: string, tags: Record<string, string>, points: Vec2[]): SourceLine =>
  ({ ref, source: 'test', priority: 0, tags, points }) as SourceLine;

const flat = () => 100;

describe('buried networks', () => {
  it('reads the network from OSM-style tags', () => {
    expect(utilityKindOf({ man_made: 'pipeline', substance: 'gas' })).toBe('gas');
    expect(utilityKindOf({ man_made: 'pipeline', substance: 'sewage' })).toBe('sewer');
    expect(utilityKindOf({ power: 'cable', location: 'underground' })).toBe('power');
    expect(utilityKindOf({ telecom: 'line' })).toBe('telecom');
    expect(
      utilityKindOf({ man_made: 'pipeline', substance: 'water', location: 'overground' }),
    ).toBe(null);
    expect(utilityKindOf({ natural: 'cliff' })).toBe(null);
  });

  it('lays a run at its cover below the surface (diameter in mm)', () => {
    const { utilities } = buildUtilities(
      [
        line('w', { man_made: 'pipeline', substance: 'water', diameter: '200', depth: '1.5' }, [
          [0, 0],
          [10, 0],
        ]),
      ],
      [],
      flat,
    );
    expect(utilities[0].diameter).toBeCloseTo(0.2);
    for (const p of utilities[0].path) expect(p[2]).toBeCloseTo(100 - 1.5 - 0.1);
  });

  it('moves the smaller of two crossing networks clear of the other', () => {
    const { utilities } = buildUtilities(
      [
        line('w', { man_made: 'pipeline', substance: 'water', diameter: '200', depth: '1.0' }, [
          [-20, 0],
          [20, 0],
        ]),
        line('g', { man_made: 'pipeline', substance: 'gas', diameter: '110', depth: '1.0' }, [
          [0, -20],
          [0, 20],
        ]),
      ],
      [],
      flat,
    );
    expect(utilityClashes(utilities)).toEqual([]);
    const gas = utilities.find((u) => u.kind === 'gas')!;
    const water = utilities.find((u) => u.kind === 'water')!;
    expect(gas.rerouted).toBe(1);
    expect(water.rerouted).toBeUndefined();
    // Over the water main it would keep only ~0.6 m cover: it passes under.
    const atCross = gas.path.reduce((a, b) => (Math.abs(b[1]) < Math.abs(a[1]) ? b : a));
    const waterZ = water.path[0][2];
    expect(waterZ - atCross[2]).toBeGreaterThanOrEqual(0.1 + 0.055 + UTILITY_CLEARANCE - 1e-6);
    // Away from the crossing it keeps its depth.
    expect(gas.path[0][2]).toBeCloseTo(100 - 1.0 - 0.055);
  });

  it('never moves a gravity sewer: the other network gives way', () => {
    const { utilities } = buildUtilities(
      [
        line('s', { man_made: 'pipeline', substance: 'sewage', diameter: '150', depth: '1.2' }, [
          [-20, 0],
          [20, 0],
        ]),
        line('w', { man_made: 'pipeline', substance: 'water', diameter: '300', depth: '1.2' }, [
          [0, -20],
          [0, 20],
        ]),
      ],
      [],
      flat,
    );
    expect(utilities.find((u) => u.kind === 'sewer')!.rerouted).toBeUndefined();
    expect(utilities.find((u) => u.kind === 'water')!.rerouted).toBe(1);
    expect(utilityClashes(utilities)).toEqual([]);
  });

  it('joins a service line to its main at the main height', () => {
    const { utilities } = buildUtilities(
      [
        line('main', { man_made: 'pipeline', substance: 'sewage', diameter: '500', depth: '2.5' }, [
          [-20, 0],
          [20, 0],
        ]),
        line(
          'svc',
          {
            man_made: 'pipeline',
            substance: 'sewage',
            diameter: '160',
            depth: '1.2',
            service: 'yes',
          },
          [
            [0, 12],
            [0, 0.4],
          ],
        ),
      ],
      [],
      flat,
    );
    const main = utilities.find((u) => u.ref === 'main')!;
    const svc = utilities.find((u) => u.ref === 'svc')!;
    expect(svc.path[svc.path.length - 1][2]).toBeCloseTo(main.path[0][2], 1);
    expect(svc.path[0][2]).toBeCloseTo(100 - 1.2 - 0.08);
  });

  it('sinks a manhole down to the bottom of its network', () => {
    const { nodes } = buildUtilities(
      [
        line('s', { man_made: 'pipeline', substance: 'sewage', diameter: '500', depth: '2.5' }, [
          [-20, 0],
          [20, 0],
        ]),
      ],
      [
        {
          ref: 'm',
          source: 'test',
          priority: 0,
          tags: { man_made: 'manhole', manhole: 'sewer' },
          p: [0, 0],
        } as SourcePoint,
      ],
      flat,
    );
    expect(nodes[0].kind).toBe('sewer');
    expect(nodes[0].depth).toBeCloseTo(2.5 + 0.5 + 0.3);
    expect(UTILITY_SPECS.sewer.minCover).toBeLessThan(2.5);
  });

  it('links a street cabinet to the nearest main of its network with a conduit', () => {
    const { utilities } = buildUtilities(
      [
        line('fibre', { telecom: 'line', diameter: '63', depth: '0.6' }, [
          [-30, 0],
          [30, 0],
        ]),
        line('gas', { man_made: 'pipeline', substance: 'gas', depth: '0.9' }, [
          [-30, 3],
          [30, 3],
        ]),
      ],
      [],
      flat,
      [{ ref: 'p:cab', p: [5, 6], kind: 'telecom' }],
    );
    const link = utilities.find((u) => u.id === 'u:p:cab~link')!;
    expect(link.provenance).toBe('inferred');
    expect(link.kind).toBe('telecom');
    const end = link.path[link.path.length - 1];
    expect(end[0]).toBeCloseTo(5);
    expect(end[1]).toBeCloseTo(0);
    // Joins the fibre main at its height; crosses the gas main clear of it.
    const fibre = utilities.find((u) => u.ref === 'fibre')!;
    expect(end[2]).toBeCloseTo(fibre.path[0][2], 1);
    expect(utilityClashes(utilities)).toEqual([]);
  });
});
