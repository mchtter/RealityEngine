/// <reference lib="webworker" />
import type { CityModel } from '@opentwin/city-core';
import { buildTilePayload } from './engine/tile-build';

/**
 * Downloads, decompresses, parses and meshes one compiled city tile off the
 * main thread; posts back transferable buffers the engine only has to wrap.
 */
self.onmessage = async (
  event: MessageEvent<{ id: number; url: string; headers?: Record<string, string> }>,
) => {
  const { id, url, headers } = event.data;
  try {
    const t0 = performance.now();
    const res = await fetch(url, { headers });
    if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
    const text = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
    const model = JSON.parse(text) as CityModel;
    const t1 = performance.now();
    const { payload, transfer } = buildTilePayload(model);
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
