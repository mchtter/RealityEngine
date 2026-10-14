/**
 * The twin's model of a live object's class (ontology id, e.g.
 * `aviation.aircraft`). Any class not listed is drawn as a marker pin.
 */

export type LiveKind = 'aircraft' | 'bus' | 'vessel' | 'rail' | 'cctv' | 'parking' | 'marker';

const KIND_BY_CLASS: Record<string, LiveKind> = {
  'aviation.aircraft': 'aircraft',
  'transit.bus': 'bus',
  'maritime.vessel': 'vessel',
  'transit.tram': 'rail',
  'transit.metro_train': 'rail',
  'transit.train': 'rail',
  'safety.cctv': 'cctv',
  'mobility.parking': 'parking',
};

/** The twin's model of a class (unknown classes: a marker). */
export const liveKindOf = (classId: string): LiveKind => KIND_BY_CLASS[classId] ?? 'marker';

/** Marker colour of a class without its own model (hex). */
export function markerColorOf(classId: string): string {
  if (classId.startsWith('hazard.')) return '#f97316';
  if (classId.startsWith('safety.')) return '#ef4444';
  if (classId.startsWith('environment.')) return '#22c55e';
  return '#14b8a6';
}
