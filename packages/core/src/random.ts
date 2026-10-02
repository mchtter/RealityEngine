/** 32-bit FNV-1a hash of a string — stable seeds from feature ids. */
export function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic PRNG (mulberry32). The same seed always yields the same city,
 * so a building keeps its colours and layout across sessions and machines.
 */
export class Rng {
  private state: number;

  constructor(seed: number | string) {
    this.state = (typeof seed === 'string' ? hashString(seed) : seed) >>> 0;
  }

  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Weighted pick from [value, weight] pairs. */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [v, w] of items) {
      r -= w;
      if (r <= 0) return v;
    }
    return items[items.length - 1][0];
  }
}
