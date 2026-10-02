#!/usr/bin/env node
/**
 * Builds a DT development fixture: OSM features (one Overpass request) plus a
 * terrain height grid sampled from the Copernicus GLO-30 DEM (public AWS open
 * data, COG range reads). Output is a single JSON consumed by `compileCity`.
 *
 * Usage: node tools/fetch-fixture.mjs [out.json]
 *
 * Data licences: OSM © OpenStreetMap contributors (ODbL);
 * Copernicus DEM © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH
 * 2014-2018 provided under COPERNICUS by the European Union and ESA.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fromUrl } from 'geotiff';

const AREA = {
  name: 'Zonguldak merkez',
  // ~1.4 km x 1.2 km: harbour coast (west), Gazipaşa valley centre, hillside quarters
  bbox: [31.7815, 41.4465, 31.7985, 41.4575],
};
const MARGIN_DEG = 0.004;
const OVERPASS = 'https://overpass-api.de/api/interpreter';

const out = resolve(process.argv[2] ?? 'test/fixtures/zonguldak-merkez.json');

function overpassQuery([w, s, e, n]) {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:90];
(
  way["highway"](${b});
  way["building"](${b});
  relation["building"](${b});
  way["building:part"](${b});
  node["natural"="tree"](${b});
  node["highway"~"^(street_lamp|traffic_signals|crossing|bus_stop|stop|give_way)$"](${b});
  node["public_transport"](${b});
  node["amenity"~"^(bench|waste_basket|bicycle_parking|fountain|post_box|telephone)$"](${b});
  node["power"~"^(pole|tower)$"](${b});
  node["entrance"](${b});
  way["landuse"](${b});
  way["leisure"](${b});
  way["natural"](${b});
  way["amenity"~"^(parking|school|hospital|place_of_worship|university|marketplace)$"](${b});
  way["man_made"~"^(pier|breakwater|bridge)$"](${b});
  way["waterway"](${b});
  way["barrier"~"^(wall|retaining_wall|fence)$"](${b});
  relation["landuse"](${b});
  relation["leisure"](${b});
  relation["natural"](${b});
);
out geom;`;
}

const r7 = (v) => Math.round(v * 1e7) / 1e7;

function compact(el) {
  const base = { type: el.type, id: el.id, tags: el.tags ?? {} };
  if (el.type === 'node') return { ...base, lon: r7(el.lon), lat: r7(el.lat) };
  if (el.type === 'way') {
    return {
      ...base,
      nodes: el.nodes,
      geometry: (el.geometry ?? []).map((p) => [r7(p.lon), r7(p.lat)]),
    };
  }
  return {
    ...base,
    members: (el.members ?? [])
      .filter((m) => m.type === 'way' && m.geometry)
      .map((m) => ({
        ref: m.ref,
        role: m.role,
        geometry: m.geometry.map((p) => [r7(p.lon), r7(p.lat)]),
      })),
  };
}

async function fetchOsm(bbox) {
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'opentwin-dt-fixture/0.1',
    },
    body: new URLSearchParams({ data: overpassQuery(bbox) }),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return json.elements.map(compact);
}

function copernicusUrl(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  const la = String(Math.abs(Math.floor(lat))).padStart(2, '0');
  const lo = String(Math.abs(Math.floor(lon))).padStart(3, '0');
  const name = `Copernicus_DSM_COG_10_${ns}${la}_00_${ew}${lo}_00_DEM`;
  return `https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/${name}/${name}.tif`;
}

async function fetchTerrain([w, s, e, n]) {
  const tiff = await fromUrl(copernicusUrl(s, w));
  const image = await tiff.getImage();
  const [x0, y0, x1, y1] = image.getBoundingBox();
  const width = image.getWidth();
  const height = image.getHeight();
  const px = (lon) => ((lon - x0) / (x1 - x0)) * width;
  const py = (lat) => ((y1 - lat) / (y1 - y0)) * height;
  const window = [Math.floor(px(w)), Math.floor(py(n)), Math.ceil(px(e)) + 1, Math.ceil(py(s)) + 1];
  const [data] = await image.readRasters({ window });
  const cols = window[2] - window[0];
  const rows = window[3] - window[1];
  const lonAt = (c) => x0 + ((window[0] + c + 0.5) / width) * (x1 - x0);
  const latAt = (r) => y1 - ((window[1] + r + 0.5) / height) * (y1 - y0);
  return {
    source: 'Copernicus GLO-30 DSM',
    // pixel-centre bounds of the grid, row 0 = north
    west: lonAt(0),
    east: lonAt(cols - 1),
    north: latAt(0),
    south: latAt(rows - 1),
    cols,
    rows,
    heights: Array.from(data, (h) => Math.round(h * 10) / 10),
  };
}

const [w, s, e, n] = AREA.bbox;
const terrainBox = [w - MARGIN_DEG, s - MARGIN_DEG, e + MARGIN_DEG, n + MARGIN_DEG];
console.log(`Overpass: ${AREA.name} ${AREA.bbox.join(',')}`);
const elements = await fetchOsm(AREA.bbox);
console.log(`  ${elements.length} elements`);
console.log('Copernicus DEM window');
const terrain = await fetchTerrain(terrainBox);
console.log(`  ${terrain.cols}x${terrain.rows} samples`);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({
    name: AREA.name,
    bbox: AREA.bbox,
    fetchedAt: new Date().toISOString(),
    attribution: [
      '© OpenStreetMap contributors (ODbL)',
      'Copernicus DEM GLO-30 © DLR e.V. / Airbus Defence and Space, provided under COPERNICUS by the EU and ESA',
    ],
    osm: elements,
    terrain,
  }),
);
console.log(`wrote ${out}`);
