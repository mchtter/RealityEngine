/**
 * Any Turkish city's delivery package from OpenStreetMap alone — the generic
 * part of İzmir's (tools/city/izmir/build-package.ts), same file names, so
 * the platform imports it the same way.
 *
 *   npx tsx tools/city/osm-city.ts --city ankara --name "Ankara" [--districts "Çankaya,Keçiören"]
 *
 * Reads (under data/demo/<city>/raw/osm/, or --data <dir>/<city>/raw/osm/):
 *   <city>.geojsonseq            osmium export of the city extract
 *   <city>-districts.geojson     district polygons (OSM boundary=administrative,
 *                                admin_level=6; properties.name)
 * Writes data/demo/<city>/package/: idari_sinir_ilce, yapi_osm, yol_osm,
 * yaya_gecidi_osm, agac_osm, alan_osm, kent_donatisi_osm, ilgi_noktasi_osm
 * (.geojson) and RAPOR.json. The area is the --districts given (by name, Turkish
 * case-insensitive), or every district.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  type District,
  districtLocator,
  type Geometry,
  osmLayers,
  PackageWriter,
  writeDistricts,
} from './osm/osm-package';

export const OSM_ATTRIBUTION = '© OpenStreetMap katkıcıları (ODbL)';

const lower = (s: string) => s.trim().toLocaleLowerCase('tr-TR');

/**
 * The districts of a district file: polygons with a name, admin_level 6 when
 * the file says (a broader export also carries the province and neighbourhoods),
 * one per name, ordered by name (stable ids across re-exports).
 */
export function readDistricts(fc: {
  features: { properties?: Record<string, unknown> | null; geometry?: Geometry | null }[];
}): { districts: District[]; dropped: Record<string, number> } {
  const dropped: Record<string, number> = {};
  const bump = (why: string) => (dropped[why] = (dropped[why] ?? 0) + 1);
  const byName = new Map<string, District>();
  for (const f of fc.features) {
    const p = f.properties ?? {};
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    const g = f.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) bump('poligon değil');
    else if (p.admin_level !== undefined && String(p.admin_level) !== '6') bump('admin_level ≠ 6');
    else if (!name) bump('adı yok');
    else if (byName.has(lower(name))) bump('aynı ad (ilki alındı)');
    else byName.set(lower(name), { key: name, name, geometry: g });
  }
  const districts = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  return { districts, dropped };
}

/** The area: the named districts (all when none are named); throws on an unknown name. */
export function selectArea(districts: District[], names?: string[]): District[] {
  if (!names?.length) return districts;
  const wanted = new Set(names.map(lower));
  const area = districts.filter((d) => wanted.has(lower(d.name)));
  const found = new Set(area.map((d) => lower(d.name)));
  const missing = names.filter((n) => !found.has(lower(n)));
  if (missing.length)
    throw new Error(
      `districts not found: ${missing.join(', ')} (the file has: ${districts.map((d) => d.name).join(', ')})`,
    );
  return area;
}

async function main() {
  const { values } = parseArgs({
    options: {
      city: { type: 'string' },
      name: { type: 'string' },
      districts: { type: 'string' },
      data: { type: 'string' },
    },
  });
  const city = values.city?.trim();
  if (!city || !/^[a-z0-9-]+$/.test(city))
    throw new Error(
      'usage: npx tsx tools/city/osm-city.ts --city <slug, a-z0-9-> --name "<Name>" [--districts "A,B"] [--data <dir>]',
    );
  const name = values.name?.trim() || city;
  const DATA = values.data ?? join(__dirname, '..', '..', 'data', 'demo');
  const osmDir = join(DATA, city, 'raw', 'osm');
  const seq = `${city}.geojsonseq`;
  const districtFile = `${city}-districts.geojson`;

  const writer = new PackageWriter(join(DATA, city, 'package'), OSM_ATTRIBUTION);
  const { districts, dropped } = readDistricts(
    JSON.parse(readFileSync(join(osmDir, districtFile), 'utf8')),
  );
  if (!districts.length) throw new Error(`${districtFile}: no districts`);
  const idPrefix = city.replace(/-/g, '_').toUpperCase();
  writeDistricts(
    writer,
    idPrefix,
    districts,
    `OpenStreetMap (ODbL) · ${name} · ${districtFile}`,
    dropped,
  );

  const names = values.districts
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const area = selectArea(districts, names);
  const inArea = districtLocator(area);
  await osmLayers(writer, {
    files: [join(osmDir, seq)],
    inside: (p) => !!inArea(p),
    source: `OpenStreetMap (ODbL) · ${name} · ${seq}`,
  });
  writer.writeReport(area.map((d) => d.name));
  writer.printSummary();
}

if (require.main === module)
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
