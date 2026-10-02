import type { Polygon, Vec2 } from './types';

/**
 * Raster of free land for block infill (0.5 m cells). Candidate lots are
 * tested by sampling instead of polygon clipping, which keeps infill linear
 * in the number of candidates. States: 0 blocked, 1 free, 2 taken by a lot.
 */
export class Occupancy {
  private readonly cols: number;
  private readonly rows: number;
  private readonly data: Uint8Array;

  constructor(
    private readonly minX: number,
    private readonly minY: number,
    maxX: number,
    maxY: number,
    private readonly res = 0.5,
  ) {
    this.cols = Math.max(1, Math.ceil((maxX - minX) / res));
    this.rows = Math.max(1, Math.ceil((maxY - minY) / res));
    this.data = new Uint8Array(this.cols * this.rows);
  }

  /** Scanline fill (even-odd over outer + holes) of cell centres with `value`. */
  fill(polys: Polygon[], value: number, onlyWhere?: number): void {
    for (const p of polys) {
      const rings = [p.outer, ...p.holes];
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const [, y] of p.outer) {
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
      const r0 = Math.max(0, Math.floor((y0 - this.minY) / this.res));
      const r1 = Math.min(this.rows - 1, Math.ceil((y1 - this.minY) / this.res));
      const xs: number[] = [];
      for (let r = r0; r <= r1; r++) {
        const cy = this.minY + (r + 0.5) * this.res;
        xs.length = 0;
        for (const ring of rings) {
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i];
            const [xj, yj] = ring[j];
            if (yi > cy !== yj > cy) xs.push(xi + ((cy - yi) * (xj - xi)) / (yj - yi));
          }
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const c0 = Math.max(0, Math.ceil((xs[k] - this.minX) / this.res - 0.5));
          const c1 = Math.min(this.cols - 1, Math.floor((xs[k + 1] - this.minX) / this.res - 0.5));
          for (let c = c0; c <= c1; c++) {
            const idx = r * this.cols + c;
            if (onlyWhere === undefined || this.data[idx] === onlyWhere) this.data[idx] = value;
          }
        }
      }
    }
  }

  /** Share of sample points of the quad (p0 + u·dir·w + v·inward·d) that are free. */
  freeShare(p0: Vec2, dir: Vec2, inward: Vec2, width: number, depth: number): number {
    const step = this.res;
    let total = 0;
    let free = 0;
    for (let u = step / 2; u < width; u += step) {
      for (let v = step / 2; v < depth; v += step) {
        const x = p0[0] + dir[0] * u + inward[0] * v;
        const y = p0[1] + dir[1] * u + inward[1] * v;
        const c = Math.floor((x - this.minX) / this.res);
        const r = Math.floor((y - this.minY) / this.res);
        total++;
        if (
          c >= 0 &&
          r >= 0 &&
          c < this.cols &&
          r < this.rows &&
          this.data[r * this.cols + c] === 1
        )
          free++;
      }
    }
    return total ? free / total : 0;
  }
}
