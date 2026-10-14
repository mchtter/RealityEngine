import type { TileLevel } from './engine/city-tile';
import type { MeshPayload, TilePayload } from './engine/tile-payload';
import { sessionHeadersFor } from '@/lib/api/session-auth';

export interface TileJob {
  key: string;
  url: string;
  /** Detail level to build the tile at. */
  level: TileLevel;
  /** Lower = sooner (distance to the camera target, metres). */
  priority: number;
  /** `utilities`: the tile's buried networks only (built when the underground view opens). */
  part?: 'tile' | 'utilities';
  /** The tile is on screen already: a newer version (or another level) replaces it. */
  refresh?: boolean;
}

/** Jobs queued or being built, by kind (the loading indicator's detail). */
export interface TileWork {
  full: number;
  far: number;
  utilities: number;
  refresh: number;
}

/** One job per tile url, level and part. */
export const jobId = (j: Pick<TileJob, 'url' | 'level' | 'part'>) =>
  `${j.url}|${j.level}${j.part === 'utilities' ? '|utilities' : ''}`;

export interface LoadedTile {
  key: string;
  url: string;
  level: TileLevel;
  /** A tile job's content. */
  payload?: TilePayload;
  /** A utilities job's networks. */
  utilities?: MeshPayload[];
  timings?: { fetchParseMs: number; meshMs: number };
}

interface Slot {
  worker: Worker;
  busy: boolean;
  /** In-flight job id. */
  job: number | null;
}

/**
 * Pool of tile workers: download + parse + mesh run off the main thread,
 * nearest tiles first. Jobs that fall out of range before they start are
 * dropped by `retain`.
 */
export class TileLoader {
  private readonly workers: Slot[];
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
      const slot: Slot = { worker: null as unknown as Worker, busy: false, job: null };
      this.spawn(slot);
      return slot;
    });
  }

  /** A fresh worker in `slot` (also replacing one stopped mid-job). */
  private spawn(slot: Slot): void {
    const worker = new Worker(new URL('./tile.worker.ts', import.meta.url));
    slot.worker = worker;
    slot.busy = false;
    slot.job = null;
    worker.onmessage = (
      e: MessageEvent<{
        id: number;
        payload?: TilePayload;
        utilities?: MeshPayload[];
        error?: string;
        timings?: LoadedTile['timings'];
      }>,
    ) => {
      const job = this.inFlight.get(e.data.id);
      this.inFlight.delete(e.data.id);
      slot.busy = false;
      slot.job = null;
      if (job) {
        this.pending.delete(jobId(job));
        if (e.data.payload || e.data.utilities)
          this.onLoaded({
            key: job.key,
            url: job.url,
            level: job.level,
            payload: e.data.payload,
            utilities: e.data.utilities,
            timings: e.data.timings,
          });
        else this.onError(job.key, e.data.error ?? 'tile worker failed');
      }
      this.pump();
    };
  }

  /** True while the job is queued or being built. */
  has(job: Pick<TileJob, 'url' | 'level' | 'part'>): boolean {
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

  /**
   * Drops queued jobs the predicate rejects (tiles no longer wanted), and
   * stops the workers building such a tile: after a jump across the city
   * they spent 3–6 s finishing the old place's full tiles before the new
   * place's first tile could start (measured 2026-10-12).
   */
  retain(keep: (job: TileJob) => boolean): void {
    for (const slot of this.workers) {
      if (slot.job === null) continue;
      const job = this.inFlight.get(slot.job);
      if (!job || keep(job)) continue;
      this.inFlight.delete(slot.job);
      this.pending.delete(jobId(job));
      slot.worker.terminate();
      this.spawn(slot);
    }
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
      slot.job = id;
      this.inFlight.set(id, job);
      // Tiles are the tenant's files: the worker fetches them with the session token.
      slot.worker.postMessage({
        id,
        url: job.url,
        headers: sessionHeadersFor(job.url),
        part: job.part,
        level: job.level,
      });
    }
  }

  get backlog(): number {
    return this.queue.length + this.inFlight.size;
  }

  get work(): TileWork {
    const out: TileWork = { full: 0, far: 0, utilities: 0, refresh: 0 };
    for (const j of [...this.queue, ...this.inFlight.values()]) {
      if (j.part === 'utilities') {
        out.utilities++;
        continue;
      }
      out[j.level]++;
      if (j.refresh) out.refresh++;
    }
    return out;
  }

  dispose(): void {
    for (const s of this.workers) s.worker.terminate();
    this.queue = [];
    this.inFlight.clear();
    this.pending.clear();
  }
}
