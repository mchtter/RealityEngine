import type { TilePayload } from './engine/tile-payload';

export interface TileJob {
  key: string;
  url: string;
  /** Lower = sooner (distance to the camera target, metres). */
  priority: number;
}

export interface LoadedTile {
  key: string;
  url: string;
  payload: TilePayload;
  timings: { fetchParseMs: number; meshMs: number };
}

/**
 * Pool of tile workers: download + parse + mesh run off the main thread,
 * nearest tiles first. Jobs that fall out of range before they start are
 * dropped by `retain`.
 */
export class TileLoader {
  private readonly workers: { worker: Worker; busy: boolean }[];
  private queue: TileJob[] = [];
  private readonly inFlight = new Map<number, TileJob>();
  private readonly pending = new Set<string>();
  private seq = 0;

  constructor(
    size: number,
    private readonly onLoaded: (tile: LoadedTile) => void,
    private readonly onError: (key: string, message: string) => void,
  ) {
    this.workers = Array.from({ length: size }, () => {
      const worker = new Worker(new URL('./tile.worker.ts', import.meta.url));
      const slot = { worker, busy: false };
      worker.onmessage = (
        e: MessageEvent<{
          id: number;
          payload?: TilePayload;
          error?: string;
          timings?: LoadedTile['timings'];
        }>,
      ) => {
        const job = this.inFlight.get(e.data.id);
        this.inFlight.delete(e.data.id);
        slot.busy = false;
        if (job) {
          this.pending.delete(job.url);
          if (e.data.payload)
            this.onLoaded({
              key: job.key,
              url: job.url,
              payload: e.data.payload,
              timings: e.data.timings!,
            });
          else this.onError(job.key, e.data.error ?? 'tile worker failed');
        }
        this.pump();
      };
      return slot;
    });
  }

  /** True while the url is queued or being built. */
  has(url: string): boolean {
    return this.pending.has(url);
  }

  enqueue(job: TileJob): void {
    if (this.pending.has(job.url)) {
      const queued = this.queue.find((j) => j.url === job.url);
      if (queued) queued.priority = job.priority;
      return;
    }
    this.pending.add(job.url);
    this.queue.push(job);
  }

  /** Drops queued jobs the predicate rejects (tiles no longer wanted). */
  retain(keep: (job: TileJob) => boolean): void {
    this.queue = this.queue.filter((j) => {
      if (keep(j)) return true;
      this.pending.delete(j.url);
      return false;
    });
  }

  pump(): void {
    this.queue.sort((a, b) => a.priority - b.priority);
    for (const slot of this.workers) {
      if (slot.busy) continue;
      const job = this.queue.shift();
      if (!job) return;
      slot.busy = true;
      const id = ++this.seq;
      this.inFlight.set(id, job);
      slot.worker.postMessage({ id, url: job.url });
    }
  }

  get backlog(): number {
    return this.queue.length + this.inFlight.size;
  }

  dispose(): void {
    for (const s of this.workers) s.worker.terminate();
    this.queue = [];
    this.inFlight.clear();
    this.pending.clear();
  }
}
