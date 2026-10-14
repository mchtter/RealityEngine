import { AIRFIELD_CLASSES, layAirfield } from './airfield';
import type { SourceRoad } from './osm';
import { bufferPolyline } from './poly';
import type { AirfieldLight, Marking, Polygon, Prop, RailLine, Road } from './types';

/**
 * Lines with a width that are not roads, carried in the road theme (class
 * `rail` / `subway` / `tram` / `runway` / `taxiway`): they stay out of the
 * street network and are laid here instead.
 */
export const GUIDEWAY_CLASSES: ReadonlySet<string> = new Set([
  'rail',
  'subway',
  'tram',
  ...AIRFIELD_CLASSES,
]);

/** Id prefix of a rail bridge's deck (a bridge built for a rail line). */
export const RAIL_DECK = 'rl-deck:';

/** Tracks of a rail line without a count in the data. */
const TRACKS: Record<string, number> = { rail: 2, subway: 2, tram: 1 };
/** Track spacing, centre to centre (m). */
export const TRACK_SPACING = 4.2;

export interface Guideways {
  rails: RailLine[];
  /**
   * The decks of rail bridges, as road-like lines for the bridge builder (it
   * gives them their height, piers and the clearance over what they cross);
   * the rail is then laid on them (`RailLine.profile`).
   */
  decks: Road[];
  /** Runway / taxiway / stopway pavement. */
  airfield: Polygon[];
  /** Airfield paint (airfield.ts). */
  markings: Marking[];
  /** Runway, approach and taxiway lights. */
  lights: AirfieldLight[];
  /** Windsocks. */
  props: Prop[];
  /** Ground the lines take (rail beds, airfield): no trees, no infill there. */
  footprint: Polygon[];
}

/**
 * Rail lines from the road-theme lines of those classes; the airfield ways
 * (runways, taxiways, stopways, stands) are laid by airfield.ts. `aprons`
 * keep taxiway edge lines and lights off the aprons.
 */
export function layGuideways(sources: SourceRoad[], aprons: Polygon[] = []): Guideways {
  const rails: RailLine[] = [];
  const footprint: Polygon[] = [];
  const decks: Road[] = [];
  const field = layAirfield(sources, aprons);
  footprint.push(...field.pavement);
  for (const r of sources) {
    const cls = r.tags.highway ?? '';
    if (!GUIDEWAY_CLASSES.has(cls) || AIRFIELD_CLASSES.has(cls) || r.points.length < 2) continue;
    const tunnel = !!r.tags.tunnel && r.tags.tunnel !== 'no';
    // Underground stretches (metro, the İZBAN tunnel) are not drawn.
    if (tunnel) continue;
    const bridge = !!r.tags.bridge && r.tags.bridge !== 'no';
    const lanes = Number.parseInt(r.tags.lanes ?? '', 10);
    const tracks = Number.isFinite(lanes) && lanes > 0 && lanes <= 6 ? lanes : TRACKS[cls];
    const bed = tracks * TRACK_SPACING + (cls === 'tram' ? 0.6 : 1.2);
    rails.push({
      id: `rl:${r.ref}`,
      ref: r.ref,
      kind: cls as RailLine['kind'],
      grade: bridge ? 'bridge' : 'ground',
      tracks,
      width: bed,
      points: r.points,
      ...(r.tags.name ? { name: r.tags.name } : {}),
      provenance: 'observed',
    });
    if (!bridge) footprint.push(...bufferPolyline(r.points, bed / 2, false));
    else {
      const layer = Number.parseInt(r.tags.layer ?? '', 10);
      decks.push({
        id: `${RAIL_DECK}${r.ref}`,
        ref: r.ref,
        cls: 'service',
        grade: 'bridge',
        layer: Number.isFinite(layer) && layer > 0 ? layer : 1,
        centerline: r.points,
        width: bed,
        sidewalk: 0,
        lanes: 1,
        oneway: true,
        formsBlocks: false,
        provenance: { width: 'inferred', lanes: 'inferred' },
      });
    }
  }
  return {
    rails,
    decks,
    airfield: field.pavement,
    markings: field.markings,
    lights: field.lights,
    props: field.props,
    footprint,
  };
}
