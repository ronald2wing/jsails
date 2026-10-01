/**
 * Durable schedule-pause store.
 *
 * `PausedScheduleStore` records which scheduled jobs have been paused so a
 * later `work` start can skip their re-registration. Two implementations ship:
 *
 * - {@link createMemoryPausedScheduleStore} — an in-process `Set`-keyed `Map`,
 *   suitable for tests and single-process deployments.
 * - {@link createCachePausedScheduleStore} — persists paused ids through the
 *   existing {@link import('../../src/cache/store.js').CacheStore} contract
 *   (`get`/`set`/`delete`), so a Valkey-backed `CacheStore` makes pause state
 *   durable across process restarts.
 *
 * Both stores are idempotent: `setPaused` on already-paused ids is a no-op;
 * `clearPaused` on not-paused ids is a no-op. Construction is inert — nothing
 * connects and no key is read or written until a method is called.
 */

import type { CacheStore } from '../cache/store.js';

/** Default key prefix for the cache-backed store. */
const DEFAULT_PAUSED_SCHEDULE_PREFIX = 'jsails:paused-schedule';

/** Raised for every paused-schedule store failure that reaches the caller. */
export class PausedScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PausedScheduleError';
  }
}

/**
 * A named-schedule pause store. Implementations own their persistence; the
 * caller holds a reference and never closes it.
 */
export interface PausedScheduleStore {
  /** Whether the schedule identified by `id` is currently paused. */
  isPaused(id: string): Promise<boolean>;
  /** Mark the given schedule ids as paused. Idempotent: already-paused ids are
   *  a no-op. */
  setPaused(ids: readonly string[]): Promise<void>;
  /** Remove the pause marker for the given schedule ids so a future
   *  `upsertSchedules` re-registers them. Idempotent: not-paused ids are a
   *  no-op. */
  clearPaused(ids: readonly string[]): Promise<void>;
}

/**
 * Create an in-memory paused-schedule store backed by a `Set`. It holds no
 * external resources and is never closed.
 */
export function createMemoryPausedScheduleStore(): PausedScheduleStore {
  const paused = new Set<string>();

  return {
    async isPaused(id: string): Promise<boolean> {
      return paused.has(id);
    },
    async setPaused(ids: readonly string[]): Promise<void> {
      for (const id of ids) {
        paused.add(id);
      }
    },
    async clearPaused(ids: readonly string[]): Promise<void> {
      for (const id of ids) {
        paused.delete(id);
      }
    },
  };
}

/** Options for {@link createCachePausedScheduleStore}. */
export interface CachePausedScheduleStoreOptions {
  /** Key prefix. Defaults to {@link DEFAULT_PAUSED_SCHEDULE_PREFIX}. */
  readonly prefix?: string;
}

/**
 * Create a paused-schedule store backed by a {@link CacheStore}.
 *
 * Paused ids are persisted under `{prefix}-{id}` keys via `cache.set` (with a
 * small sentinel value) and looked up via `cache.get`. `clearPaused` calls
 * `cache.delete`. Every backend failure surfaces as a value-free
 * {@link PausedScheduleError} — the key is never echoed.
 *
 * Durability is the store's contract: a Valkey `CacheStore` makes pause state
 * multi-process by construction; a memory `CacheStore` is process-scoped.
 */
export function createCachePausedScheduleStore(
  cache: CacheStore,
  options: CachePausedScheduleStoreOptions = {},
): PausedScheduleStore {
  if (cache === null || typeof cache !== 'object') {
    throw new PausedScheduleError('cache store must be a CacheStore object');
  }
  if (
    typeof cache.get !== 'function' ||
    typeof cache.set !== 'function' ||
    typeof cache.delete !== 'function'
  ) {
    throw new PausedScheduleError('cache store must implement get, set, and delete');
  }

  const prefix = options.prefix ?? DEFAULT_PAUSED_SCHEDULE_PREFIX;

  const keyFor = (id: string): string => `${prefix}-${id}`;

  return {
    async isPaused(id: string): Promise<boolean> {
      try {
        const value = await cache.get(keyFor(id));
        return value !== null;
      } catch (_error) {
        throw new PausedScheduleError('failed to read paused schedule state from cache store');
      }
    },
    async setPaused(ids: readonly string[]): Promise<void> {
      for (const id of ids) {
        try {
          await cache.set(keyFor(id), '1', ONE_DAY_MS);
        } catch (_error) {
          throw new PausedScheduleError('failed to persist paused schedule state to cache store');
        }
      }
    },
    async clearPaused(ids: readonly string[]): Promise<void> {
      for (const id of ids) {
        try {
          await cache.delete(keyFor(id));
        } catch (_error) {
          throw new PausedScheduleError('failed to remove paused schedule state from cache store');
        }
      }
    },
  };
}

/** Sentinel TTL: pause state is indefinite but the entry needs a bound. */
const ONE_DAY_MS = 86_400_000;
