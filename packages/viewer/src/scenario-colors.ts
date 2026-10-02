import { isParcelKeyColumn } from '@opentwin/shared';
import * as THREE from 'three/webgpu';
import type { BuildingInfo } from './engine/tile-payload';
import type { ResolvedOverlay } from '@/store/scenario.store';

/**
 * Join key → colour of a resolved scenario overlay, read back from its
 * MapLibre `['match', ['to-string', ['get', key]], k1, c1, …, default]`
 * expression (both categorical and choropleth overlays produce one).
 */
export function overlayKeyColors(expression: unknown): Map<string, THREE.Color> {
  const out = new Map<string, THREE.Color>();
  if (!Array.isArray(expression) || expression[0] !== 'match') return out;
  for (let i = 2; i + 1 < expression.length; i += 2) {
    const labels = expression[i] as unknown;
    const color = expression[i + 1];
    if (typeof color !== 'string' || /^rgba\(.*,\s*0\)$/.test(color)) continue;
    const c = new THREE.Color().setStyle(color.replace(/^rgba\((.*),[^,]*\)$/, 'rgb($1)'));
    for (const key of Array.isArray(labels) ? labels : [labels]) out.set(normalizeKey(key), c);
  }
  return out;
}

/** "4711", 4711 and "4711.0" are the same building number. */
function normalizeKey(v: unknown): string {
  const s = String(v).trim();
  return /^-?\d+\.0+$/.test(s) ? s.replace(/\.0+$/, '') : s;
}

/**
 * Colour lookup for DT buildings from the visible scenario overlays. The
 * overlay's join property decides which building identity it is compared to:
 *  - a parcel key (tapukimlik, parselKodu …) → the building's canonical
 *    parcel id, so parcel scenarios paint the buildings standing on the parcel;
 *  - anything else → the building's source column of that name (KIMLIKNO,
 *    case-insensitive) or, when it has no such column, its source id.
 * The first overlay that matches wins. Null when no overlay is visible.
 */
export function scenarioColorOf(
  overlays: ResolvedOverlay[],
): ((b: BuildingInfo) => THREE.Color | null) | null {
  const active = overlays
    .filter((o) => o.visible && o.layerKey)
    .map((o) => ({
      key: o.layerKey!.toLowerCase(),
      parcel: isParcelKeyColumn(o.layerKey!),
      colors: overlayKeyColors(o.expression),
    }))
    .filter((o) => o.colors.size > 0);
  if (!active.length) return null;
  return (b) => {
    for (const o of active) {
      if (o.parcel) {
        const hit = b.parcelRef ? o.colors.get(normalizeKey(b.parcelRef)) : undefined;
        if (hit) return hit;
        continue;
      }
      let value: string | undefined;
      if (b.attrs) {
        for (const [k, v] of Object.entries(b.attrs)) {
          if (k.toLowerCase() === o.key) {
            value = v;
            break;
          }
        }
      }
      // Source id ("maks:4711" → "4711") only when the building has no such
      // column: two different numbering schemes must not match by coincidence.
      const key = value ?? b.ref?.split(':').slice(1).join(':');
      const hit = key === undefined ? undefined : o.colors.get(normalizeKey(key));
      if (hit) return hit;
    }
    return null;
  };
}
