/// <reference lib="webworker" />
import type { CityModel } from '@opentwin/city-core';
import type { TileLevel } from './engine/city-tile';
import { buildTilePayload, buildUtilityPayload } from './engine/tile-build';

/**
 * The last parsed models (by url): a tile's far build, its full build and its
 * utilities read one download (the loader sends them to the same worker).
 */
const models = new Map<string, CityModel>();
const KEEP_MODELS = 2;

async function modelOf(url: string, headers?: Record<string, string>): Promise<CityModel> {
  const hit = models.get(url);
  if (hit) {
    models.delete(url);
    models.set(url, hit);
    return hit;
  }
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
  const model = JSON.parse(text) as CityModel;
  models.set(url, model);
  while (models.size > KEEP_MODELS) models.delete(models.keys().next().value!);
  return model;
}

/**
 * Downloads, decompresses, parses and meshes one compiled city tile off the
 * main thread; posts back transferable buffers the engine only has to wrap.
 */
self.onmessage = async (
  event: MessageEvent<{
    id: number;
    url: string;
    headers?: Record<string, string>;
    /** `utilities`: only the buried networks (underground view). */
    part?: 'tile' | 'utilities';
    level?: TileLevel;
  }>,
) => {
  const { id, url, headers, part, level } = event.data;
  try {
    const t0 = performance.now();
    const model = await modelOf(url, headers);
    const t1 = performance.now();
    if (part === 'utilities') {
      const { meshes, transfer } = buildUtilityPayload(model);
      (self as unknown as Worker).postMessage({ id, utilities: meshes }, transfer);
      return;
    }
    const { payload, transfer } = buildTilePayload(model, { far: level === 'far' });
    const t2 = performance.now();
    (self as unknown as Worker).postMessage(
      { id, payload, timings: { fetchParseMs: Math.round(t1 - t0), meshMs: Math.round(t2 - t1) } },
      transfer,
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
