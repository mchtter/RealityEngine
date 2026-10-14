import { CutGround } from './cuttings';
import { PolygonSet } from './spatial';
import { RoadSurface, terrainHeightAt } from './terrain';
import type { CityModel, Polygon, SurfaceKind } from './types';

/**
 * Height of each surface above what it lies on, metres: the whole layer
 * order (terrain < yard < … < sidewalk / island at kerb height). The viewer
 * drapes the surfaces with these lifts; everything that stands on a surface
 * (props, fences, steps) takes its height from GroundModel, which adds them.
 */
export const SURFACE_LIFT: Record<SurfaceKind, number> = {
  yard: 0.05,
  concrete: 0.06,
  parking: 0.08,
  playground: 0.09,
  pitch: 0.07,
  track: 0.07,
  cemetery: 0.07,
  earth: 0.06,
  quarry: 0.06,
  gravel: 0.06,
  airfield: 0.09,
  asphalt: 0.1,
  path: 0.13,
  paving: 0.16,
  sidewalk: 0.24,
  island: 0.24,
};

/** Street surfaces lie on the street surface (RoadSurface); the others on the terrain. */
export const STREET_SURFACES: ReadonlySet<SurfaceKind> = new Set([
  'asphalt',
  'sidewalk',
  'island',
  'paving',
]);

/** What a point stands on. */
export type Support =
  | SurfaceKind
  /** Bare ground: grass, soil, woods (no surface drawn). */
  | 'ground'
  | 'water'
  /** Floor of an underpass trench (the ramp road and its kerb strips). */
  | 'trench'
  /** Lid over a tunnel mouth. */
  | 'lid';

/**
 * The one ground of a compiled tile: for any point, the surface on top and
 * its height, from the same sources the viewer draws with (terrain, street
 * surface, trench floor, lid, surface lifts). Every class that stands on the
 * ground places itself with it, so two things meeting at a point agree on
 * its height.
 */
export class GroundModel {
  readonly cut: CutGround;
  readonly street: RoadSurface;
  /** Surface kinds, highest lying first (the first one containing a point is on top). */
  private readonly layers: { kind: SurfaceKind; set: PolygonSet }[];
  private readonly water: PolygonSet;

  constructor(
    readonly model: Pick<
      CityModel,
      'terrain' | 'terrainCut' | 'roads' | 'surfaces' | 'areas' | 'streetFill'
    >,
  ) {
    this.cut = new CutGround(model.terrain, model.terrainCut);
    this.street = new RoadSurface(
      model.roads
        .filter((r) => r.grade === 'ground' && r.profile)
        .map((r) => ({
          points: r.centerline,
          profile: r.profile!,
          halfWidth: r.width / 2 + r.sidewalk,
          carriage: r.width / 2,
        })),
      4,
      model.streetFill?.length ? new PolygonSet(model.streetFill) : undefined,
    );
    const byKind = new Map<SurfaceKind, Polygon[]>();
    for (const s of model.surfaces)
      byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), ...s.polygons]);
    this.layers = [...byKind]
      .sort((a, b) => SURFACE_LIFT[b[0]] - SURFACE_LIFT[a[0]])
      .map(([kind, polys]) => ({ kind, set: new PolygonSet(polys) }));
    this.water = new PolygonSet(
      model.areas.filter((a) => a.kind === 'water').map((a) => a.polygon),
    );
  }

  /** Ground under all surfaces (terrain, street surface, trench floor or lid). */
  baseAt(x: number, y: number): number {
    if (this.cut.inTrench(x, y) || this.cut.inLid(x, y)) return this.cut.heightAt(x, y);
    return terrainHeightAt(this.model.terrain, x, y);
  }

  /** Street surface height (corridors), terrain elsewhere. */
  streetAt(x: number, y: number): number {
    return this.street.heightAt(x, y) ?? terrainHeightAt(this.model.terrain, x, y);
  }

  /** Surface kind on top at a point (the highest-lying one where surfaces overlap). */
  supportAt(x: number, y: number): Support {
    if (this.cut.inTrench(x, y)) return 'trench';
    if (this.cut.inLid(x, y)) return 'lid';
    for (const l of this.layers) if (l.set.contains(x, y)) return l.kind;
    if (this.water.contains(x, y)) return 'water';
    return 'ground';
  }

  /** Height of the top surface at a point (what a foot / a pole base touches). */
  surfaceAt(x: number, y: number): { support: Support; z: number } {
    const support = this.supportAt(x, y);
    if (support === 'trench' || support === 'lid') return { support, z: this.cut.heightAt(x, y) };
    if (support === 'ground' || support === 'water') {
      return { support, z: terrainHeightAt(this.model.terrain, x, y) };
    }
    const base = STREET_SURFACES.has(support)
      ? this.streetAt(x, y)
      : terrainHeightAt(this.model.terrain, x, y);
    return { support, z: base + SURFACE_LIFT[support] };
  }
}
