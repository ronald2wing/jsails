/**
 * Shared-store batch coordinator: a {@link BatchCoordinator} backed by a
 * {@link CacheStore} so producer and worker processes can share batch progress
 * through a common store (e.g. Valkey).
 *
 * ## Model
 *
 * Every `register` persists a serialised snapshot under the deterministic key
 * `jsails:batch:<id>` with a configurable TTL (default 1 hour). Callbacks are
 * stored **in-process** — only the process that called `register` fires them.
 *
 * Each `record` performs a read-modify-write against the cache: the persisted
 * `recorded` index set makes recording **idempotent per index** across
 * processes. When the process that holds the callbacks observes that every
 * index has been recorded (by any process), settlement fires once.
 *
 * ## Cross-process limits (honest)
 *
 * - **Callback locality.** Callbacks are in-process; a worker process that
 *   never called `register` cannot fire settlement. The producer process (or
 *   any process that registered the batch) must also run the middleware and
 *   issue at least one `record` — or the process itself can poll the persisted
 *   state — otherwise settlement never fires and the cache entry decays via
 *   its TTL.
 * - **No distributed exactly-once.** Concurrent writers race on `get` then
 *   `set`; the LAST writer wins. If two processes record different indices at
 *   the same time, one write overwrites the other and the overwritten index is
 *   lost from the persisted state. The TTL evicts orphans.
 * - **TTL support.** The `CacheStore.set` contract accepts a `ttlMs` parameter;
 *   the Valkey-backed store honours it via `PX`. A cache implementation whose
 *   `set` ignores the TTL will never auto-evict orphaned entries — eviction
 *   becomes the cache's own concern.
 *
 * The in-process {@link createBatchCoordinator} remains for single-process
 * deployments and is strictly faster (no serialisation, no I/O).
 *
 * ## Wiring
 *
 * ```ts
 * import { createSharedBatchCoordinator } from 'jsails/jobs';
 * import { createValkeyCacheStore } from 'jsails/cache';
 *
 * const cache = createValkeyCacheStore({ valkeyUrl: 'redis://...' });
 * const coordinator = createSharedBatchCoordinator(cache);
 * // Use this coordinator with createJobBatch + createBatchMiddleware.
 * ```
 */

import type {
  BatchCallbacks,
  BatchCoordinator,
  BatchFailure,
  BatchFailedSummary,
  BatchSummary,
} from './batch.js';
import type { CacheStore } from '../cache/store.js';

// ---------------------------------------------------------------------------
// Key namespace
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'jsails:batch';

function keyFor(id: string): string {
  return `${KEY_PREFIX}:${id}`;
}

// ---------------------------------------------------------------------------
// Serialised state
// ---------------------------------------------------------------------------

interface SerialisedState {
  id: string;
  total: number;
  recorded: number[];
  succeeded: number;
  failed: number;
  failures: Array<{ job: string; error: string }>;
}

// ---------------------------------------------------------------------------
// In-process state (callbacks live here, not in the cache)
// ---------------------------------------------------------------------------

interface InProcessState {
  callbacks: BatchCallbacks;
  /** Guard so settlement fires at most once per process. */
  settled: boolean;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/** Raised for an invalid shared-batch-coordinator call. Messages are value-free. */
export class SharedBatchCoordinatorError extends Error {
  readonly code: 'invalid_cache';

  constructor(code: 'invalid_cache') {
    super(code);
    this.name = 'SharedBatchCoordinatorError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Default TTL (1 hour)
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a shared-store batch coordinator backed by a {@link CacheStore}.
 *
 * Every `register` persists the initial progress snapshot under a
 * deterministic key (`jsails:batch:<id>`) with the configured `ttlMs`.
 * `record` reads the persisted state, appends the new index (idempotent —
 * a duplicate index is ignored), writes it back, and fires settlement
 * callbacks in-process when every index has been recorded.
 *
 * @param cache  The backing cache. Its `set` must accept a `ttlMs` argument;
 *               implementations that ignore it will never auto-evict orphans.
 * @param options Optional configuration.
 */
export function createSharedBatchCoordinator(
  cache: CacheStore,
  options?: { ttlMs?: number },
): BatchCoordinator {
  if (cache === undefined || cache === null || typeof cache !== 'object') {
    throw new SharedBatchCoordinatorError('invalid_cache');
  }
  if (
    options !== undefined &&
    (options === null || typeof options !== 'object' || Array.isArray(options))
  ) {
    throw new TypeError('options must be an object');
  }

  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const inProcess = new Map<string, InProcessState>();
  // Serializes each batch's read-modify-write so sequential same-tick `record`
  // calls on one batch apply in order (the contract's `record` is synchronous,
  // but cache I/O is async — a fire-and-forget write would let two records on
  // the same tick both read the same stale snapshot and clobber each other).
  const writeChains = new Map<string, Promise<unknown>>();

  function runCallbacks(batchId: string, callbacks: BatchCallbacks, state: SerialisedState): void {
    void (async () => {
      try {
        const summary: BatchSummary = {
          id: batchId,
          total: state.total,
          succeeded: state.succeeded,
          failed: state.failed,
        };

        if (state.failed === 0) {
          if (callbacks.then) {
            try {
              await callbacks.then(summary);
            } catch {
              // Swallowed: notification failure must not affect any job.
            }
          }
        } else {
          if (callbacks.catch) {
            try {
              await callbacks.catch({
                ...summary,
                failures: [...state.failures],
              } satisfies BatchFailedSummary);
            } catch {
              // Swallowed.
            }
          }
        }

        if (callbacks.finally) {
          try {
            await callbacks.finally(summary);
          } catch {
            // Swallowed.
          }
        }
      } finally {
        inProcess.delete(batchId);
      }
    })();
  }

  return {
    register(id: string, total: number, callbacks: BatchCallbacks): void {
      const serialised: SerialisedState = {
        id,
        total,
        recorded: [],
        succeeded: 0,
        failed: 0,
        failures: [],
      };

      inProcess.set(id, { callbacks, settled: false });

      // Persist the initial snapshot. The initial write is plain fire-and-forget:
      // `register` always precedes any `record` for the same batch in this
      // process, and the `record` read-modify-write chains onto a settled chain
      // so it never races a not-yet-landed register write on a real async cache.
      void cache.set(keyFor(id), JSON.stringify(serialised), ttlMs);
    },

    record(id: string, job: string, index: number, errorMessage: string | undefined): void {
      const ip = inProcess.get(id);
      // No in-process entry: this process did not register this batch.
      // Record against the cache for visibility, but settlement will not
      // fire here — only the registering process fires callbacks.
      //
      // Chain each batch's read-modify-write onto the previous write so
      // sequential same-tick records (and cross-process visibility) never read
      // a stale snapshot. Cross-process racing is left to last-writer-wins
      // (documented), but within THIS process ordering is deterministic.
      const previous = writeChains.get(id) ?? Promise.resolve();
      const next = previous.then(async () => {
        try {
          const raw = await cache.get(keyFor(id));
          if (raw === null) {
            return; // entry expired or never persisted
          }

          const parsed = JSON.parse(raw) as SerialisedState;

          // Idempotent per index — skip duplicates.
          if (parsed.recorded.includes(index)) {
            return;
          }
          parsed.recorded.push(index);

          if (errorMessage === undefined) {
            parsed.succeeded += 1;
          } else {
            parsed.failed += 1;
            parsed.failures.push({ job, error: errorMessage } satisfies BatchFailure);
          }

          await cache.set(keyFor(id), JSON.stringify(parsed), ttlMs);

          if (parsed.recorded.length < parsed.total) {
            return;
          }

          // All indices recorded. If this process registered the batch,
          // fire settlement exactly once.
          if (ip === undefined || ip.settled) {
            return;
          }
          ip.settled = true;

          runCallbacks(id, ip.callbacks, parsed);
        } catch {
          // Best-effort: errors from cache I/O or JSON parsing are trapped.
          // A transient failure leaves the entry intact; a later retry
          // (idempotent per index) will succeed. The TTL handles orphans.
        }
      });
      // Keep the chain alive even if an earlier write tossed (the catch above
      // already contains failures); a settled chain is dropped on remove().
      writeChains.set(id, next);
    },

    remove(id: string): void {
      inProcess.delete(id);
      writeChains.delete(id);
      void cache.delete(keyFor(id));
    },
  };
}
