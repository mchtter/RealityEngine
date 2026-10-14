/**
 * How dry open ground looks in summer (satellite / aerial view), 0 = lush
 * green (eastern Black Sea) … 1 = parched (south-east Anatolia), anywhere in
 * Turkey. A hand-made 1° grid after the country's climate zones — Black Sea
 * humid (Cfa / Cfb), Marmara transitional, Aegean and Mediterranean dry
 * summers (Csa), the Central Anatolian steppe (BSk), the south-east (BSh) and
 * the greener eastern highland pastures (Dsb) — not measured data: correct a
 * cell where the city does not look like its imagery. Bilinear between cells;
 * points outside the grid take its nearest edge.
 */

const LON0 = 26;
const LAT0 = 42;
// Rows from 42° N down to 36° N, columns from 26° E to 45° E.
const GRID: number[][] = [
  [
    0.55, 0.55, 0.5, 0.4, 0.3, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.3, 0.4,
    0.4,
  ],
  [
    0.6, 0.6, 0.55, 0.45, 0.3, 0.15, 0.15, 0.2, 0.25, 0.25, 0.2, 0.15, 0.1, 0.1, 0.1, 0.1, 0.15,
    0.4, 0.5, 0.5,
  ],
  [
    0.65, 0.65, 0.6, 0.55, 0.5, 0.6, 0.75, 0.8, 0.8, 0.75, 0.65, 0.55, 0.45, 0.5, 0.5, 0.5, 0.55,
    0.6, 0.6, 0.6,
  ],
  [
    0.75, 0.75, 0.78, 0.8, 0.85, 0.85, 0.9, 0.92, 0.9, 0.88, 0.82, 0.75, 0.7, 0.65, 0.6, 0.6, 0.62,
    0.6, 0.6, 0.6,
  ],
  [
    0.78, 0.75, 0.78, 0.82, 0.85, 0.88, 0.9, 0.92, 0.9, 0.88, 0.85, 0.88, 0.9, 0.88, 0.82, 0.75,
    0.75, 0.75, 0.75, 0.75,
  ],
  [
    0.75, 0.72, 0.72, 0.75, 0.78, 0.75, 0.8, 0.85, 0.85, 0.8, 0.8, 0.9, 0.95, 0.95, 0.92, 0.9, 0.88,
    0.85, 0.85, 0.85,
  ],
  [
    0.75, 0.72, 0.7, 0.7, 0.72, 0.72, 0.72, 0.72, 0.75, 0.75, 0.78, 0.92, 0.95, 0.95, 0.95, 0.92,
    0.9, 0.9, 0.9, 0.9,
  ],
];

export function summerAridity(lon: number, lat: number): number {
  const rows = GRID.length;
  const cols = GRID[0].length;
  const fx = Math.min(cols - 1, Math.max(0, lon - LON0));
  const fy = Math.min(rows - 1, Math.max(0, LAT0 - lat));
  const x0 = Math.min(cols - 2, Math.floor(fx));
  const y0 = Math.min(rows - 2, Math.floor(fy));
  const tx = fx - x0;
  const ty = fy - y0;
  const top = GRID[y0][x0] * (1 - tx) + GRID[y0][x0 + 1] * tx;
  const bottom = GRID[y0 + 1][x0] * (1 - tx) + GRID[y0 + 1][x0 + 1] * tx;
  return top * (1 - ty) + bottom * ty;
}
