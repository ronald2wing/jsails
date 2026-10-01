/**
 * Overlap control middleware: prevent concurrent executions of the same
 * scheduled job using a {@link MutexStore}. The overlap descriptor is carried
 * in dispatch options under {@link OVERLAP_OPTION_KEY} and resolved by
 * `prepareSchedules` in `./scheduler.js`.
 *
 * ## Model
 *
 * A scheduled job that opts into overlap control carries a resolved
 * `OverlapDescriptor` (`{ key, ttlMs }`) in its dispatch options. The
 * middleware, registered on the job via
 * `createJobsRuntime({ middleware: { [jobName]: [createOverlapMiddleware(mutex)] } })`,
 * acquires a mutex for `descriptor.key` before running the handler and releases
 * it after. If the mutex is already held (the previous run is still in flight),
 * the middleware skips this invocation — it returns `undefined` without calling
 * the handler and without throwing.
 *
 * A skipped run is a normal outcome, not a failure. Throwing or returning
 * an error would trigger adapter retries and defeat overlap control:
 * the scheduler would retry the job, the mutex would still be held (by the
 * previous run), and the retry cycle would repeat until the lock expires.
 *
 * ## Fail-safe discipline
 *
 * A malformed or absent descriptor is treated as a no-op: the middleware calls
 * `next()` and returns its result unchanged. A framework-internal descriptor
 * problem — a corrupt option value wired by the scheduler itself — must never
 * fail the job and trigger retries. The handler result propagates as if the
 * middleware were not present.
 *
 * ## Release safety
 *
 * The mutex `release` is wrapped in a try/catch with the error swallowed.
 * A release failure (e.g. the lock already expired via TTL, or the backend is
 * unreachable) must not corrupt the job outcome: the handler result or error
 * always propagates unchanged. The TTL acts as a safety net — the key expires
 * automatically and the next scheduled tick can acquire it.
 *
 * ## In-process limitation
 *
 * A `createMemoryMutexStore` guarantees mutual exclusion within a single
 * process only. In a multi-process deployment (separate worker processes), use
 * `createValkeyMutexStore` (shared backend) so all workers see the same lock
 * state. The middleware itself is store-agnostic — it calls `acquire`/`release`
 * on whatever `MutexStore` is injected.
 *
 * ## Option allowlist
 *
 * {@link OVERLAP_OPTION_KEY} is added to `ALLOWED_JOB_OPTIONS` in
 * `./queue.js` so the descriptor survives the `validateJobOptions` round-trip.
 * The trust model is the same as `CHAIN_OPTION_KEY` / `BATCH_OPTION_KEY`: a
 * caller who can dispatch can already dispatch any registered job with any
 * valid payload; the descriptor grants no new capability.
 *
 * ## Wiring
 *
 * ```ts
 * import { createJobsRuntime } from 'jsails';
 * import { createOverlapMiddleware } from 'jsails/jobs';
 * import { createMemoryMutexStore } from 'jsails';
 *
 * const mutex = createMemoryMutexStore();
 * const runtime = createJobsRuntime({
 *   registry,
 *   adapter,
 *   middleware: {
 *     digest: [createOverlapMiddleware(mutex)],
 *   },
 * });
 * ```
 */

import type { MutexStore } from '../cache/mutex.js';
import { type JobMiddleware, type JobMiddlewareContext } from './middleware.js';
import { isOverlapDescriptor } from './scheduler.js';

/** Reserved dispatch-option key carrying the resolved overlap descriptor. */
export const OVERLAP_OPTION_KEY = '__jsailsOverlap';

/**
 * Build a per-job middleware that prevents overlapping runs using a mutex.
 * The overlap descriptor rides in the scheduled job's options under
 * {@link OVERLAP_OPTION_KEY}.
 *
 * Register it on every job that opts into overlap control via
 * `createJobsRuntime({ middleware: { [jobName]: [createOverlapMiddleware(mutex)] } })`.
 *
 * @param mutex - The mutex store backing acquire/release. For single-process
 *   deployments use `createMemoryMutexStore()`; for multi-process deployments
 *   use `createValkeyMutexStore({ valkeyUrl })`.
 */
export function createOverlapMiddleware(mutex: MutexStore): JobMiddleware {
  return async (
    _data: unknown,
    context: JobMiddlewareContext,
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const options = (context.options as Record<string, unknown>) ?? {};
    const raw = options[OVERLAP_OPTION_KEY];

    // Fail safe: no descriptor or a malformed one means the scheduler did not
    // opt this job into overlap control (or the descriptor was corrupted).
    // A framework-internal descriptor problem must not fail the job and trigger
    // retries — the handler result propagates unchanged.
    if (raw === undefined || !isOverlapDescriptor(raw)) {
      return next();
    }

    const descriptor = raw;

    const acquired = await mutex.acquire(descriptor.key, descriptor.ttlMs);

    if (!acquired) {
      // The previous run is still in flight. Skip this invocation without
      // calling the handler and without throwing — a skipped run is a normal
      // outcome, not a failure. Throwing would trigger adapter retries, which
      // would re-enter this check and skip again, defeating overlap control.
      return undefined;
    }

    // Acquired: run the handler. Always release the mutex in finally so a
    // handler failure does not hold the lock until TTL.
    try {
      return await next();
    } finally {
      // A release failure (lock already expired via TTL, backend unreachable)
      // must not corrupt the job outcome. The handler's result or error always
      // propagates unchanged. The TTL acts as a safety net — the key expires
      // automatically, so the next scheduled tick can still acquire it.
      try {
        await mutex.release(descriptor.key);
      } catch {
        // Swallowed: a release failure is a cleanup issue, not a job failure.
      }
    }
  };
}
