import { isParcelKeyColumn, normalizeJoinKey } from '@kavra/core';
import * as THREE from 'three/webgpu';
import type { ScenarioPaintOf } from './engine/DtEngine';

export interface ResolvedOverlay {
  scenarioId: string;
  layerId: string;
  layerKey?: string;
  visible: boolean;
  expression: unknown;
}

export interface JoinableBuilding {
  attrs?: Record<string, string>;
  ref?: string;
  parcelRef?: string | null;
}

export function buildingJoinValue(b: JoinableBuilding, layerKey: string): string | undefined {
  if (isParcelKeyColumn(layerKey)) return b.parcelRef ?? undefined;
  const wanted = layerKey.toLowerCase();
  if (b.attrs) {
    for (const [k, v] of Object.entries(b.attrs)) if (k.toLowerCase() === wanted) return v;
  }
  return b.ref?.includes(':') ? b.ref.split(':').slice(1).join(':') : undefined;
}

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
    for (const key of Array.isArray(labels) ? labels : [labels]) out.set(normalizeJoinKey(key), c);
  }
  return out;
}

/** Stable id of a resolved overlay (scenario + base layer). */
export const overlayId = (o: Pick<ResolvedOverlay, 'scenarioId' | 'layerId'>) =>
  `${o.scenarioId}:${o.layerId}`;

/**
 * Scenario paint for DT buildings from the visible scenario overlays — the
 * same buildings and colours as the 2D map. The overlay's join property
 * decides which building identity it is compared to:
 *  - a parcel key (tapukimlik, parselKodu …) → the building's canonical
 *    parcel id, so parcel scenarios paint the buildings standing on the parcel;
 *  - anything else → the building's source column of that name (KIMLIKNO,
 *    case-insensitive) or, when it has no such column, its source id.
 * With an area filter, only keys inside the selected areas paint (as in 2D).
 * The first overlay that matches wins. Null when no overlay is visible.
 */
export function scenarioColorOf(
  overlays: ResolvedOverlay[],
  areaKeys?: Record<string, string[]> | null,
): ScenarioPaintOf | null {
  const active = overlays
    .filter((o) => o.visible && o.layerKey)
    .map((o) => {
      const inArea = areaKeys?.[o.layerId];
      return {
        id: overlayId(o),
        layerKey: o.layerKey!,
        colors: overlayKeyColors(o.expression),
        inArea: inArea ? new Set(inArea.map((k) => normalizeJoinKey(k))) : null,
      };
    })
    .filter((o) => o.colors.size > 0);
  if (!active.length) return null;
  const paint = (o: (typeof active)[number], raw: string | undefined) => {
    if (raw === undefined) return null;
    const key = normalizeJoinKey(raw);
    if (o.inArea && !o.inArea.has(key)) return null;
    const color = o.colors.get(key);
    return color ? { color, key, overlay: o.id } : null;
  };
  return (b) => {
    for (const o of active) {
      const hit = paint(o, buildingJoinValue(b, o.layerKey));
      if (hit) return hit;
    }
    return null;
  };
}
