import type { Building, CityModel } from './types';

/**
 * A tile looks for replacing placements this far (degrees, ~300 m) beyond its
 * box: a building near the edge belongs to one tile while the placement point
 * (its centre) may fall in the next. The tile version (gis-service) and the
 * compiler (twin-builder) use the same box.
 */
export const REPLACE_MARGIN_DEG = 0.003;

export function replaceSearchBox(
  bbox: [number, number, number, number],
): [number, number, number, number] {
  const m = REPLACE_MARGIN_DEG;
  return [bbox[0] - m, bbox[1] - m, bbox[2] + m, bbox[3] + m];
}

/**
 * Keys a placed model can name a generated building by: canonical entity id,
 * source ref, OSM id (the DT's building key is `ref ?? osmId`). Synthetic
 * buildings have none: their ids change with every build.
 */
export function buildingKeys(b: Building): string[] {
  return [b.entity, b.ref, b.osmId !== undefined ? String(b.osmId) : undefined].filter(
    (k): k is string => typeof k === 'string' && k.length > 0,
  );
}

/**
 * Drops the buildings that placed models replace (city_placements.replaces_key),
 * with what hangs on them (roof clutter). The plot keeps its yard, fence and gate:
 * the model stands where the building stood. Removing after compilation keeps
 * block infill from filling the plot with a synthetic building.
 */
export function removeReplacedBuildings(model: CityModel, replaced: Iterable<string>): number {
  const keys = new Set(replaced);
  if (keys.size === 0) return 0;
  const dropped = new Set<string>();
  model.buildings = model.buildings.filter((b) => {
    const hit = buildingKeys(b).some((k) => keys.has(k));
    if (hit) dropped.add(b.id);
    return !hit;
  });
  if (dropped.size === 0) return 0;
  model.props = model.props.filter((p) => !p.buildingId || !dropped.has(p.buildingId));
  model.stats = { ...model.stats, buildingsReplaced: dropped.size };
  return dropped.size;
}
