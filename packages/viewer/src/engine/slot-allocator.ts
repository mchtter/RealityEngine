/**
 * First-fit allocator of contiguous building slot ranges in the scenario
 * colour texture: each loaded tile layer takes one range, released when the
 * tile is unloaded. Slot 0 is never handed out (shells without a range use it,
 * and it always reads as "no data").
 */
export class SlotAllocator {
  private readonly free: { start: number; size: number }[];

  constructor(capacity: number) {
    this.free = [{ start: 1, size: capacity - 1 }];
  }

  /** Start of a free range of `size` slots, or null when the texture is full. */
  alloc(size: number): number | null {
    if (size <= 0) return null;
    const i = this.free.findIndex((r) => r.size >= size);
    if (i < 0) return null;
    const range = this.free[i];
    const start = range.start;
    range.start += size;
    range.size -= size;
    if (range.size === 0) this.free.splice(i, 1);
    return start;
  }

  release(start: number, size: number): void {
    if (size <= 0) return;
    let i = this.free.findIndex((r) => r.start > start);
    if (i < 0) i = this.free.length;
    this.free.splice(i, 0, { start, size });
    // Merge with the neighbours so the free list stays short.
    const next = this.free[i + 1];
    if (next && start + size === next.start) {
      this.free[i].size += next.size;
      this.free.splice(i + 1, 1);
    }
    const prev = this.free[i - 1];
    if (prev && prev.start + prev.size === start) {
      prev.size += this.free[i].size;
      this.free.splice(i, 1);
    }
  }
}
