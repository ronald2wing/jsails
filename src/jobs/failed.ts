/**
 * In-memory failed-job store with bounded ring buffer and retry capability.
 *
 * `InMemoryFailedJobStore` holds a fixed-size collection of failed job entries.
 * When the store is full a new entry evicts the oldest one silently. Entries
 * are plain objects — no ORM, no connection — so the store is suitable for a
 * diagnostics recorder or an admin dashboard that polls it on its own cadence.
 *
 * `retry(id, dispatch)` calls an injected dispatch function and removes the
 * entry on success. On failure the entry stays, so the caller can inspect it
 * and try again. The dispatch function receives the full entry; the caller
 * owns serialization, validation, and idempotency.
 *
 * Inspired by Horizon's failed-job list with per-entry retry.
 */

/** A single failed-job entry. Errors are value-free (message only). */
export interface FailedJobEntry {
  /** Unique identifier for this failure record. */
  readonly id: string;
  /** The job name this failure belongs to. */
  readonly name: string;
  /** The original job payload, when available. */
  readonly data?: unknown;
  /** The error message (never a stack trace or raw cause). */
  readonly error: string;
  /** When the job failed. */
  readonly failedAt: Date;
  /** How many attempts had been made (including this final failure). */
  readonly attempts: number;
  /** Normalized monitoring tags, when the job carried them. */
  readonly tags?: readonly string[];
}

/** Options accepted by {@link InMemoryFailedJobStore}. */
export interface FailedJobStoreOptions {
  /**
   * Maximum entries. Defaults to 100. Must be at least 1. When the store is
   * full the oldest entry is evicted before the new one is added.
   */
  readonly maxEntries?: number;

  /**
   * Maximum age in milliseconds an entry may remain in the store. Unset
   * disables age-based eviction. When set, entries older than this bound are
   * dropped on {@link add} and lazily pruned on {@link list}.
   */
  readonly maxAgeMs?: number;

  /**
   * Injectable clock returning the current time in milliseconds. Defaults to
   * `Date.now`. Used to compute entry age for retention.
   */
  readonly now?: () => number;
}

/** A bounded, in-memory store of failed jobs. */
export interface FailedJobStore {
  /** Add an entry, evicting the oldest if the store is full. */
  add(entry: FailedJobEntry): void;

  /**
   * Return entries in insertion order (oldest first). An optional `filter`
   * selects entries whose `tags` array contains every one of the requested
   * tags (entries with no tags always fail a tag filter).
   */
  list(filter?: { readonly tags?: readonly string[] }): ReadonlyArray<FailedJobEntry>;

  /** Find an entry by id, or undefined if not present. */
  get(id: string): FailedJobEntry | undefined;

  /** Remove an entry by id. Returns `true` when an entry was removed. */
  remove(id: string): boolean;

  /**
   * Attempt to re-dispatch a failed job through an injected `dispatch`
   * function. On success the entry is removed from the store; on failure it
   * stays so the caller can inspect and retry again.
   *
   * `dispatch` receives the entry the store held. It is the caller's
   * responsibility to validate the payload and make dispatch idempotent —
   * `retry` provides no exactly-once protection.
   *
   * Throws when `id` is not found (no entry to retry). Other dispatch errors
   * are re-thrown, and the entry is NOT removed.
   */
  retry(id: string, dispatch: (entry: FailedJobEntry) => Promise<void>): Promise<void>;

  /** Remove all entries. */
  clear(): void;
}

/** A bounded, in-memory failed-job store with ring-buffer eviction and retry. */
export class InMemoryFailedJobStore implements FailedJobStore {
  readonly #maxEntries: number;
  readonly #maxAgeMs: number | undefined;
  readonly #now: () => number;
  readonly #entries: FailedJobEntry[] = [];

  constructor(options: FailedJobStoreOptions = {}) {
    const rawMax = options.maxEntries ?? 100;
    if (!Number.isInteger(rawMax) || rawMax < 1) {
      throw new TypeError('maxEntries must be a positive integer');
    }
    this.#maxEntries = rawMax;

    if (options.maxAgeMs !== undefined) {
      if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs <= 0) {
        throw new TypeError('maxAgeMs must be a finite positive number');
      }
      this.#maxAgeMs = options.maxAgeMs;
    }

    this.#now = options.now ?? Date.now;
  }

  /** Drop every entry whose `failedAt` is older than `now() - maxAgeMs`. */
  #pruneAged(): void {
    if (this.#maxAgeMs === undefined) return;
    const cutoff = this.#now() - this.#maxAgeMs;
    let i = 0;
    while (i < this.#entries.length) {
      if (this.#entries[i]!.failedAt.getTime() < cutoff) {
        this.#entries.splice(i, 1);
      } else {
        i++;
      }
    }
  }

  add(entry: FailedJobEntry): void {
    this.#pruneAged();
    if (this.#entries.length >= this.#maxEntries) {
      this.#entries.shift();
    }
    this.#entries.push(entry);
  }

  list(filter?: { readonly tags?: readonly string[] }): ReadonlyArray<FailedJobEntry> {
    this.#pruneAged();
    if (filter?.tags !== undefined && filter.tags.length > 0) {
      return this.#entries.filter(
        (e) =>
          e.tags !== undefined &&
          Array.isArray(e.tags) &&
          Array.prototype.every.call(filter.tags, (t) => (e.tags as readonly string[]).includes(t)),
      );
    }
    return [...this.#entries];
  }

  get(id: string): FailedJobEntry | undefined {
    return this.#entries.find((e) => e.id === id);
  }

  remove(id: string): boolean {
    const index = this.#entries.findIndex((e) => e.id === id);
    if (index === -1) {
      return false;
    }
    this.#entries.splice(index, 1);
    return true;
  }

  async retry(id: string, dispatch: (entry: FailedJobEntry) => Promise<void>): Promise<void> {
    const index = this.#entries.findIndex((e) => e.id === id);
    if (index === -1) {
      throw new FailedJobNotFoundError(id);
    }
    const entry = this.#entries[index]!;
    await dispatch(entry);
    this.#entries.splice(index, 1);
  }

  clear(): void {
    this.#entries.length = 0;
  }
}

/** Raised when retry is called with an id not in the store. */
export class FailedJobNotFoundError extends Error {
  constructor(id: string) {
    super(`failed job "${id}" not found`);
    this.name = 'FailedJobNotFoundError';
  }
}
