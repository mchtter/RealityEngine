import type { TileLevel } from './engine/city-tile';
import type { TilePayload } from './engine/tile-payload';
import { sessionHeadersFor } from '@/lib/api/session-auth';

export interface TileJob {
  key: string;
  url: string;
  /** Detail level to build the tile at. */
  level: TileLevel;
  /** Lower = sooner (distance to the camera target, metres). */
  priority: number;
}

/** One job per tile url and level. */
export const jobId = (j: Pick<TileJob, 'url' | 'level'>) => `${j.url}|${j.level}`;

export interface LoadedTile {
  key: string;
  url: string;
  level: TileLevel;
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
          this.pending.delete(jobId(job));
          if (e.data.payload)
            this.onLoaded({
              key: job.key,
              url: job.url,
              level: job.level,
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

  /** True while the job is queued or being built. */
  has(job: Pick<TileJob, 'url' | 'level'>): boolean {
    return this.pending.has(jobId(job));
  }

  enqueue(job: TileJob): void {
    const id = jobId(job);
    if (this.pending.has(id)) {
      const queued = this.queue.find((j) => jobId(j) === id);
      if (queued) queued.priority = job.priority;
      return;
    }
    this.pending.add(id);
    this.queue.push(job);
  }

  /** Drops queued jobs the predicate rejects (tiles no longer wanted). */
  retain(keep: (job: TileJob) => boolean): void {
    this.queue = this.queue.filter((j) => {
      if (keep(j)) return true;
      this.pending.delete(jobId(j));
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
      // Tiles are the tenant's files: the worker fetches them with the session token.
      slot.worker.postMessage({ id, url: job.url, headers: sessionHeadersFor(job.url) });
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
