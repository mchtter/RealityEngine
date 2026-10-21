import { type AreaKind, type CityModel, orientedBox, pointInRing } from '@kavra/core';
import * as THREE from 'three/webgpu';
import { summerAridity } from './climate';

/**
 * Colour of the open ground (what no road, yard or building covers), as a
 * picture of the tile the terrain is textured with (ground-atlas.ts), the
 * way the ground looks on a satellite view: a patchwork of parcels, each in
 * one tone. Painted in layers, each over the one before:
 *
 *  1. open land everywhere, in irregular cells (~140 m, Voronoi on UTM metres:
 *     they run on across tile borders);
 *  2. general land use (residential / industrial grounds) where no street block is;
 *  3. street blocks — built-up ones trodden urban ground, empty ones vacant land;
 *  4. specific land use (woods, parks, lawns, campuses, yards), least specific first.
 *
 * Blocks and areas are divided like land is: cut across their long axis,
 * slightly askew, again and again until the parts are field-sized, so the
 * parts keep the outline's own edges (a wedge between two roads stays a
 * wedge). Each part takes one tone of its class's palette by its id — the
 * same on every load. Palettes are sampled from satellite views of Izmir (dry
 * summer) and the Black Sea coast (wet summer); the region's summer dryness
 * (climate.ts) blends the two. Drawn at twice the resolution and averaged
 * down, so parcel edges are smooth.
 */

/**
 * Pixels per side of an atlas slot. The picture fills GROUND_INNER of them
 * inside a GROUND_PAD border that repeats its edge, so the atlas mipmaps do
 * not bleed a neighbouring slot's colours along the tile's edges (shimmering
 * bands at the tile borders from afar).
 */
export const GROUND_SIZE = 256;
export const GROUND_PAD = 8;
export const GROUND_INNER = GROUND_SIZE - 2 * GROUND_PAD;

type Klass =
  | 'vacant'
  | 'urban'
  | 'industrial'
  | 'park'
  | 'grass'
  | 'wood'
  | 'playground'
  | 'campus'
  | 'yard'
  | 'water';

const CLASS_OF: Partial<Record<AreaKind, Klass>> = {
  forest: 'wood',
  park: 'park',
  playground: 'playground',
  grass: 'grass',
  school: 'campus',
  religious: 'yard',
  plaza: 'yard',
  parking: 'yard',
  industrial: 'industrial',
  residential: 'urban',
  water: 'water',
  // Under their own surfaces (turf, tartan, concrete); this is only their edge's blend.
  pitch: 'park',
  track: 'playground',
  stadium: 'yard',
  bus_station: 'yard',
};
/** Overlapping areas: the more specific wins (a park inside a residential area). */
const RANK: Record<Klass, number> = {
  wood: 6,
  park: 6,
  playground: 6,
  water: 6,
  grass: 5,
  campus: 4,
  yard: 4,
  industrial: 2,
  urban: 1,
  vacant: 0,
};

type RGB = [number, number, number];
/** [wet summer, dry summer] palettes, sRGB 0–255 as on satellite imagery. */
const PALETTE: Record<Klass, [RGB[], RGB[]]> = {
  vacant: [
    [
      [96, 122, 70],
      [110, 130, 80],
      [86, 110, 64],
      [122, 128, 90],
      [104, 118, 82],
    ],
    // Mostly olive-brown dry grass and scrub (the commonest tone on Izmir's
    // imagery), some bleached stubble and bare, cleared plots.
    [
      [137, 121, 106],
      [140, 125, 108],
      [132, 129, 115],
      [128, 120, 104],
      [153, 143, 132],
      [175, 161, 140],
      [190, 171, 148],
      [146, 132, 112],
    ],
  ],
  grass: [
    [
      [92, 120, 66],
      [104, 128, 74],
    ],
    [
      [128, 126, 104],
      [118, 122, 104],
      [137, 124, 108],
    ],
  ],
  park: [
    [
      [78, 108, 58],
      [70, 98, 52],
    ],
    [
      [90, 104, 84],
      [97, 114, 92],
      [82, 96, 78],
    ],
  ],
  playground: [[[120, 108, 92]], [[150, 132, 112]]],
  wood: [
    [
      [52, 76, 44],
      [60, 82, 48],
    ],
    [
      [66, 84, 70],
      [72, 88, 68],
    ],
  ],
  urban: [
    [
      [118, 124, 102],
      [128, 130, 112],
    ],
    [
      [150, 145, 135],
      [134, 130, 120],
      [160, 152, 140],
    ],
  ],
  industrial: [
    [
      [140, 138, 130],
      [128, 126, 120],
    ],
    [
      [165, 158, 148],
      [146, 141, 133],
    ],
  ],
  // Schools, universities, hospitals: lawns and trees between paved yards
  // (Ege University's campus on the imagery), lot by lot.
  campus: [
    [
      [92, 120, 66],
      [86, 110, 62],
      [138, 134, 122],
    ],
    [
      [97, 114, 92],
      [118, 122, 104],
      [88, 104, 84],
      [160, 152, 140],
    ],
  ],
  yard: [[[138, 134, 122]], [[160, 152, 140]]],
  water: [[[70, 90, 96]], [[70, 90, 96]]],
};
/**
 * Satellite sRGB → albedo for this renderer (linear, before light, AO and
 * the tone curve), so open ground renders near the imagery's value
 * (calibrated on Izmir, 2026-10-12).
 */
const ALBEDO_GAIN = 1.6;
const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** Stable 0–1 hash of a string (FNV-1a). */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** 0–1 hash of up to three integers (parcel seeds; no strings per sample). */
function mix3(a: number, b: number, c = 0): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

type Ring = [number, number][];

/** Ring clipped to the half-plane n·p ≤ d (Sutherland–Hodgman; a concave ring stays one ring). */
function clipHalf(ring: Ring, nx: number, ny: number, d: number): Ring {
  const out: Ring = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    const da = a[0] * nx + a[1] * ny - d;
    const db = b[0] * nx + b[1] * ny - d;
    if (da <= 0) out.push(a);
    if (da <= 0 !== db <= 0) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function ringArea(r: Ring): number {
  let a = 0;
  for (let k = 0, m = r.length - 1; k < r.length; m = k++)
    a += (r[m][0] - r[k][0]) * (r[m][1] + r[k][1]);
  return Math.abs(a) / 2;
}

const seedOf = (id: string) => Math.floor(hash(id) * 0x7fffffff);
const child = (seed: number, k: number) => Math.floor(mix3(seed, k, 101) * 0x7fffffff);

/**
 * Parcels of a polygon, the way land is divided: cut across its long axis at
 * 35–65 % of its length, the cut turned up to ±12°, and again in each part,
 * until a part is under 3,000–9,000 m² (by its seed) or five cuts deep. The
 * parts keep the polygon's own edges: a wedge between two roads stays a wedge.
 */
function parcels(ring: Ring, seed: number, out: { ring: Ring; seed: number }[] = [], depth = 0) {
  if (ring.length < 3) return out;
  const area = ringArea(ring);
  if (area < 3000 + mix3(seed, 11) * 6000 || depth >= 5) {
    out.push({ ring, seed });
    return out;
  }
  const ob = orientedBox(ring);
  const t = 0.35 + mix3(seed, 3) * 0.3;
  const turn = (mix3(seed, 5) - 0.5) * ((24 * Math.PI) / 180);
  const nx = ob.axis[0] * Math.cos(turn) - ob.axis[1] * Math.sin(turn);
  const ny = ob.axis[0] * Math.sin(turn) + ob.axis[1] * Math.cos(turn);
  const along = (t * 2 - 1) * ob.halfLength;
  const d = (ob.center[0] + ob.axis[0] * along) * nx + (ob.center[1] + ob.axis[1] * along) * ny;
  parcels(clipHalf(ring, nx, ny, d), child(seed, 1), out, depth + 1);
  parcels(clipHalf(ring, -nx, -ny, -d), child(seed, 2), out, depth + 1);
  return out;
}

/** Pixel rows each polygon covers: calls `span(row, i0, i1)` (inclusive) per filled run, even–odd. */
function scanFill(
  rings: readonly (readonly (readonly number[])[])[],
  n: number,
  size: number,
  span: (row: number, i0: number, i1: number) => void,
): void {
  const cs = size / n;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const r of rings)
    for (const q of r) {
      y0 = Math.min(y0, q[1]);
      y1 = Math.max(y1, q[1]);
    }
  const j0 = Math.max(0, Math.floor(y0 / cs - 0.5));
  const j1 = Math.min(n - 1, Math.ceil(y1 / cs - 0.5));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const y = (j + 0.5) * cs;
    xs.length = 0;
    for (const r of rings) {
      for (let k = 0, m = r.length - 1; k < r.length; m = k++) {
        const a = r[m];
        const b = r[k];
        if (a[1] > y !== b[1] > y) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] / cs - 0.5));
      const i1 = Math.min(n - 1, Math.floor(xs[k + 1] / cs - 0.5));
      if (i1 >= i0) span(j, i0, i1);
    }
  }
}

const toSrgb = (v: number) => {
  const c = Math.min(1, Math.max(0, v));
  return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
};

/** Open land cells (m): irregular, from a jittered grid in UTM metres, so they run on across tiles. */
const OPEN_CELL = 140;
/** Samples per pixel side: the picture is drawn at this multiple and averaged down (smooth edges). */
const SUPERSAMPLE = 2;

/**
 * The tile's ground picture for its atlas slot: GROUND_SIZE² RGBA, sRGB, row
 * 0 at the tile's south edge; the tile's `size` metres fill the inner
 * GROUND_INNER² pixels, the GROUND_PAD border repeats their edge.
 */
export function groundRaster(model: CityModel, size = 1000): Uint8Array {
  const dry = THREE.MathUtils.smoothstep(
    summerAridity(model.origin.lon, model.origin.lat),
    0.25,
    0.85,
  );
  // Albedo of every palette entry for this climate, computed once.
  const tones = new Map<Klass, RGB[]>();
  for (const [klass, [wet, arid]] of Object.entries(PALETTE) as [Klass, [RGB[], RGB[]]][]) {
    const count = Math.max(wet.length, arid.length);
    tones.set(
      klass,
      Array.from({ length: count }, (_, k) => {
        const a = wet[k % wet.length];
        const b = arid[k % arid.length];
        return [0, 1, 2].map((i) => lin(a[i] + (b[i] - a[i]) * dry) * ALBEDO_GAIN) as RGB;
      }),
    );
  }
  const tone = (klass: Klass, seed: number): RGB => {
    const list = tones.get(klass)!;
    const s = mix3(seed, 17);
    const c = list[Math.floor(s * list.length) % list.length];
    const k = 1 + (mix3(seed, 19) - 0.5) * 0.12;
    return [c[0] * k, c[1] * k, c[2] * k];
  };

  const m = GROUND_INNER * SUPERSAMPLE;
  const cs = size / m;
  const buf = new Float32Array(m * m * 3);
  const paint = (rings: readonly (readonly (readonly number[])[])[], c: RGB) =>
    scanFill(rings, m, size, (j, i0, i1) => {
      for (let i = i0; i <= i1; i++) {
        const o = (j * m + i) * 3;
        buf[o] = c[0];
        buf[o + 1] = c[1];
        buf[o + 2] = c[2];
        painted[j * m + i] = 1;
      }
    });

  // 1. Open land everywhere: irregular cells (Voronoi on UTM metres, so they
  //    run on across tiles); coloured last, where nothing else is painted.
  const frame = model.frame;
  const e0 = frame?.originE ?? 0;
  const n0 = frame?.originN ?? 0;
  const cellOf = new Int32Array(m * m);
  const seeds = new Map<number, [number, number]>();
  for (let j = 0; j < m; j++) {
    const gy = (n0 + (j + 0.5) * cs) / OPEN_CELL;
    for (let i = 0; i < m; i++) {
      const gx = (e0 + (i + 0.5) * cs) / OPEN_CELL;
      const cx = Math.floor(gx);
      const cy = Math.floor(gy);
      let best = Infinity;
      let id = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const px = cx + dx;
          const py = cy + dy;
          const qx = px + 0.1 + mix3(px, py, 1) * 0.8;
          const qy = py + 0.1 + mix3(px, py, 2) * 0.8;
          const dd = (qx - gx) ** 2 + (qy - gy) ** 2;
          if (dd < best) {
            best = dd;
            id = Math.floor(mix3(px, py, 3) * 0x7fffffff);
            if (!seeds.has(id)) seeds.set(id, [qx * OPEN_CELL, qy * OPEN_CELL]);
          }
        }
      cellOf[j * m + i] = id;
    }
  }
  const painted = new Uint8Array(m * m);
  // Streets split the open land: a cell crossed by a road is one patch on each side.
  const street = new Uint8Array(m * m);
  for (const sf of model.surfaces)
    for (const poly of sf.polygons)
      scanFill([poly.outer, ...poly.holes], m, size, (j, i0, i1) =>
        street.fill(1, j * m + i0, j * m + i1 + 1),
      );

  // 2. General land use without a street block around (residential / industrial grounds).
  const industrial = model.areas.filter((a) => a.kind === 'industrial');
  for (const a of model.areas) {
    const klass = CLASS_OF[a.kind];
    if (!klass || RANK[klass] > RANK.industrial || a.polygon.outer.length < 3) continue;
    for (const p of parcels(a.polygon.outer as Ring, seedOf(a.id)))
      paint([p.ring], tone(klass, p.seed));
  }

  // 3. Street blocks, parcel by parcel: built-up ones trodden urban ground, empty ones vacant.
  for (const k of model.blocks) {
    const ring = k.polygon.outer as Ring;
    if (ring.length < 3) continue;
    const built = k.observedCoverage > 0.12 || k.syntheticBuildings > 0;
    const c = orientedBox(ring).center as [number, number];
    const klass: Klass = industrial.some((a) => pointInRing(c, a.polygon.outer))
      ? 'industrial'
      : built
        ? 'urban'
        : 'vacant';
    for (const p of parcels(ring, seedOf(k.id))) paint([p.ring], tone(klass, p.seed));
  }

  // 4. Specific land use over all of it, least specific first: parks and woods
  //    as one canopy, lawns / campuses / yards lot by lot.
  const specific = model.areas
    .map((a) => ({ a, klass: CLASS_OF[a.kind] }))
    .filter((x) => x.klass && RANK[x.klass] > RANK.industrial && x.a.polygon.outer.length >= 3)
    .sort((x, y) => RANK[x.klass!] - RANK[y.klass!]);
  for (const { a, klass } of specific) {
    const seed = seedOf(a.id);
    if (klass === 'park' || klass === 'wood' || klass === 'water') {
      paint([a.polygon.outer, ...a.polygon.holes], tone(klass!, seed));
    } else {
      for (const p of parcels(a.polygon.outer as Ring, seed)) paint([p.ring], tone(klass!, p.seed));
    }
  }

  // Open land: each piece of a cell between streets takes a tone; the piece
  // holding the cell's seed point the cell's own, the others one by where
  // they come nearest to it (in UTM metres: the same on both sides of a tile border).
  const seen = new Uint8Array(m * m);
  const stack: number[] = [];
  const piece: number[] = [];
  const setTone = (idx: number, c: RGB) => {
    const o = idx * 3;
    buf[o] = c[0];
    buf[o + 1] = c[1];
    buf[o + 2] = c[2];
  };
  for (let start = 0; start < m * m; start++) {
    if (painted[start] || seen[start]) continue;
    const id = cellOf[start];
    if (street[start]) {
      seen[start] = 1;
      setTone(start, tone('vacant', id));
      continue;
    }
    piece.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      piece.push(p);
      const pi = p % m;
      const pj = (p - pi) / m;
      for (const q of [
        pi > 0 ? p - 1 : -1,
        pi < m - 1 ? p + 1 : -1,
        pj > 0 ? p - m : -1,
        pj < m - 1 ? p + m : -1,
      ]) {
        if (q < 0 || seen[q] || painted[q] || street[q] || cellOf[q] !== id) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    const seed = seeds.get(id)!;
    let near = Infinity;
    let at = [0, 0];
    for (const p of piece) {
      const pi = p % m;
      const x = e0 + (pi + 0.5) * cs;
      const y = n0 + ((p - pi) / m + 0.5) * cs;
      const dd = (x - seed[0]) ** 2 + (y - seed[1]) ** 2;
      if (dd < near) {
        near = dd;
        at = [x, y];
      }
    }
    const own = near <= cs * cs;
    const c = tone(
      'vacant',
      own ? id : mix3(id, Math.round(at[0] / 25), Math.round(at[1] / 25)) * 0x7fffffff,
    );
    for (const p of piece) setTone(p, c);
  }

  // Average down (linear light), encode, and pad the slot by repeating the edge.
  const out = new Uint8Array(GROUND_SIZE * GROUND_SIZE * 4);
  const w = 1 / (SUPERSAMPLE * SUPERSAMPLE);
  for (let j = 0; j < GROUND_INNER; j++) {
    for (let i = 0; i < GROUND_INNER; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sj = 0; sj < SUPERSAMPLE; sj++)
        for (let si = 0; si < SUPERSAMPLE; si++) {
          const o = ((j * SUPERSAMPLE + sj) * m + i * SUPERSAMPLE + si) * 3;
          r += buf[o];
          g += buf[o + 1];
          b += buf[o + 2];
        }
      const o = ((j + GROUND_PAD) * GROUND_SIZE + i + GROUND_PAD) * 4;
      out[o] = toSrgb(r * w);
      out[o + 1] = toSrgb(g * w);
      out[o + 2] = toSrgb(b * w);
      out[o + 3] = 255;
    }
  }
  for (let j = 0; j < GROUND_SIZE; j++) {
    const sj = Math.min(GROUND_SIZE - GROUND_PAD - 1, Math.max(GROUND_PAD, j));
    for (let i = 0; i < GROUND_SIZE; i++) {
      const si = Math.min(GROUND_SIZE - GROUND_PAD - 1, Math.max(GROUND_PAD, i));
      if (si === i && sj === j) continue;
      const from = (sj * GROUND_SIZE + si) * 4;
      const to = (j * GROUND_SIZE + i) * 4;
      out[to] = out[from];
      out[to + 1] = out[from + 1];
      out[to + 2] = out[from + 2];
      out[to + 3] = 255;
    }
  }
  return out;
}

/** Albedo of plain open land in a region (the backdrop beyond the loaded tiles). */
export function openLandAlbedo(lon: number, lat: number): [number, number, number] {
  const dry = THREE.MathUtils.smoothstep(summerAridity(lon, lat), 0.25, 0.85);
  const [wet, arid] = PALETTE.vacant;
  const mean = (list: RGB[]) =>
    [0, 1, 2].map((i) => list.reduce((s, c) => s + c[i], 0) / list.length) as RGB;
  const a = mean(wet);
  const b = mean(arid);
  return [0, 1, 2].map((i) => Math.min(1, lin(a[i] + (b[i] - a[i]) * dry) * ALBEDO_GAIN)) as [
    number,
    number,
    number,
  ];
}
