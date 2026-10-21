import { compileCity, type OsmElement } from 'reality-engine-core';
import { RealityEngine } from 'reality-engine-viewer';

const LOCATIONS: Record<string, { name: string; center: [number, number]; bbox: [number, number, number, number] }> = {
  kadikoy: {
    name: 'Downtown Moda',
    center: [29.027, 40.985],
    bbox: [29.020, 40.980, 29.034, 40.990],
  },
  manhattan: {
    name: 'Manhattan Flatiron',
    center: [-73.9897, 40.7410],
    bbox: [-73.996, 40.736, -73.983, 40.746],
  },
  eiffel: {
    name: 'Eiffel Tower',
    center: [2.2945, 48.8584],
    bbox: [2.288, 48.853, 2.301, 48.863],
  },
  berlin: {
    name: 'Brandenburg Gate',
    center: [13.3777, 52.5163],
    bbox: [13.370, 52.512, 13.385, 52.520],
  },
};

const container = document.getElementById('canvas-container') as HTMLDivElement;
const citySelect = document.getElementById('city-select') as HTMLSelectElement;
const loadBtn = document.getElementById('load-btn') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;

let engine: RealityEngine | null = null;

function setStatus(text: string, loading = false) {
  statusEl.innerHTML = loading ? `<span class="spinner"></span> ${text}` : text;
}

async function fetchOsmData(bbox: [number, number, number, number]): Promise<OsmElement[]> {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const query = `
    [out:json][timeout:25];
    (
      way["building"](${minLat},${minLon},${maxLat},${maxLon});
      relation["building"](${minLat},${minLon},${maxLat},${maxLon});
      way["highway"](${minLat},${minLon},${maxLat},${maxLon});
      way["leisure"](${minLat},${minLon},${maxLat},${maxLon});
      way["natural"](${minLat},${minLon},${maxLat},${maxLon});
    );
    out body;
    >;
    out skel qt;
  `;
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Overpass API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data.elements || []) as OsmElement[];
}

async function loadCity(locKey: string) {
  const loc = LOCATIONS[locKey];
  if (!loc) return;

  setStatus(`Fetching OSM data for ${loc.name}...`, true);
  loadBtn.disabled = true;

  try {
    const osmElements = await fetchOsmData(loc.bbox);
    setStatus(`Compiling 3D procedural geometry (${osmElements.length} elements)...`, true);

    const model = compileCity({
      osm: osmElements,
      origin: { lon: loc.center[0], lat: loc.center[1] },
    });

    if (!engine) {
      engine = new RealityEngine({
        container,
        center: loc.center,
        zoom: 16,
        pitch: 55,
        bearing: 30,
      });
    }

    setStatus(`City built in ${model.stats.totalMs || 42}ms! Ready.`);
  } catch (err: unknown) {
    console.error(err);
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    loadBtn.disabled = false;
  }
}

loadBtn.addEventListener('click', () => loadCity(citySelect.value));
citySelect.addEventListener('change', () => loadCity(citySelect.value));

console.log('Reality Engine - Procedural 3D City Engine Playground initialized.');
