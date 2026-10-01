/**
 * Job batching: fan out N independent jobs and observe completion through an
 * in-process coordinator driven by a per-job middleware (Slice 1 seam).
 *
 * ## Model
 *
 * The neutral runtime has no completion event and the adapter owns execution
 * semantics, so completion is observed by middleware that records each item's
 * outcome into an in-process coordinator. When every item in the batch has
 * been recorded the coordinator fires settlement callbacks (`then`/`catch`/
 * `finally`).
 *
 * A batch descriptor `{ id, total, index }` rides in dispatch options under
 * {@link BATCH_OPTION_KEY}, mirroring the chain pattern. The `index` field
 * makes recording **idempotent per item**: the coordinator tracks recorded
 * indices in a `Set`, so a duplicate index is ignored. This protects against
 * at-least-once redelivery — a retried job whose first attempt already
 * recorded cannot double-fire settlement callbacks.
 *
 * ## In-process limitation
 *
 * The `BatchCoordinator` is an **in-process** data structure. In a deployment
 * where the producer and worker run in separate processes (e.g. `jsails work`
 * in a real BullMQ setup), the coordinator must be backed by a shared store
 * (Redis, PostgreSQL, etc.) so both sides see the same batch progress. The
 * built-in `createBatchCoordinator()` uses an in-memory `Map` — callbacks
 * will silently never fire in a multi-process deployment unless a shared-store
 * coordinator is supplied. This is the same at-least-once/in-process caveat
 * the failed-job store documents.
 *
 * ## Wiring
 *
 * ```ts
 * import { createJobsRuntime } from 'jsails';
 * import { createBatchCoordinator, createBatchMiddleware } from 'jsails/jobs';
 *
 * const coordinator = createBatchCoordinator();
 * const runtime = createJobsRuntime({
 *   registry,
 *   adapter,
 *   middleware: {
 *     jobA: [createBatchMiddleware(coordinator)],
 *     jobB: [createBatchMiddleware(coordinator)],
 *   },
 * });
 *
 * const batch = createJobBatch(runtime, coordinator, items, {
 *   then(summary) { ... },
 *   catch(summary) { ... },
 *   finally(summary) { ... },
 * });
 * ```
 */

import { type JobMiddleware, type JobMiddlewareContext } from './middleware.js';
import type { JobsRuntime } from './runtime.js';

// ---------------------------------------------------------------------------
// Reserved option key
// ---------------------------------------------------------------------------

/** Reserved dispatch-option key that carries the batch descriptor. */
export const BATCH_OPTION_KEY = '__jsailsBatch';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** One item in a batch. */
export interface BatchItem {
  /** Name of the job to dispatch, matching a registry key. */
  readonly job: string;
  /** Payload for the item, validated against the job's schema. */
  readonly data: unknown;
  /** Optional dispatch options forwarded to `runtime.dispatch`. */
  readonly opts?: unknown;
}

/** Summary after a batch settles. */
export interface BatchSummary {
  /** The batch identifier. */
  readonly id: string;
  /** Total items in this batch. */
  readonly total: number;
  /** Number of items that succeeded. */
  readonly succeeded: number;
  /** Number of items that failed. */
  readonly failed: number;
}

/** A single item failure. Error is value-free: the message only, never a payload or stack. */
export interface BatchFailure {
  /** The job name that failed. */
  readonly job: string;
  /** The error message (never a stack trace or raw cause). */
  readonly error: string;
}

/** Summary when at least one item failed. */
export interface BatchFailedSummary extends BatchSummary {
  /** Every item failure, in recording order. */
  readonly failures: readonly BatchFailure[];
}

/** Settlement callbacks registered when the batch is created. */
export interface BatchCallbacks {
  /** Fires once, only when every item succeeds. */
  readonly then?: (summary: BatchSummary) => Promise<void> | void;
  /** Fires once, only when at least one item fails. */
  readonly catch?: (summary: BatchFailedSummary) => Promise<void> | void;
  /**
   * Fires once after `then`/`catch`, in every outcome.
   * Receives a plain summary (no `failures`).
   */
  readonly finally?: (summary: BatchSummary) => Promise<void> | void;
}

/** A validated batch whose `dispatch()` fans out every item. */
export interface JobBatch {
  /** The batch identifier, carried in every item's descriptor. */
  readonly id: string;
  /**
   * Fan out every item. Resolves once all items are enqueued via
   * `Promise.all`. If any enqueue rejects, the rejection propagates —
   * an enqueue failure does NOT settle the batch.
   */
  dispatch(): Promise<void>;
}

/** Injectable coordinator that tracks batch progress across producer and middleware. */
export interface BatchCoordinator {
  /** Register a batch's progress under its id. */
  register(id: string, total: number, callbacks: BatchCallbacks): void;
  /** Record one item's outcome; settles when all items are recorded. */
  record(id: string, job: string, index: number, errorMessage: string | undefined): void;
  /** Remove a batch's progress (called after settlement). */
  remove(id: string): void;
}

// ---------------------------------------------------------------------------
// Internal descriptor
// ---------------------------------------------------------------------------

/**
 * Carried in dispatch options under {@link BATCH_OPTION_KEY}.
 * `index` is the per-item position (0-based) that makes recording idempotent:
 * the coordinator tracks a `Set<index>` so a duplicate index from a redelivered
 * job is ignored.
 */
interface BatchDescriptor {
  readonly id: string;
  readonly total: number;
  readonly index: number;
}

// ---------------------------------------------------------------------------
// In-process coordinator (private Map, closure-scoped)
// ---------------------------------------------------------------------------

interface BatchProgress {
  readonly total: number;
  readonly callbacks: BatchCallbacks;
  succeeded: number;
  failed: number;
  /** Indices already recorded (idempotent per item). */
  recorded: Set<number>;
  /** Failure details, in order of recording. */
  failures: BatchFailure[];
  /** Guards settlement so it fires at most once. */
  settled: boolean;
}

/**
 * Create an in-process batch coordinator. Every call returns a fresh,
 * isolated coordinator whose state is closure-scoped — there is no
 * module-level Map and no shared state between coordinators.
 *
 * In a multi-process deployment (separate producer and worker processes),
 * this in-memory coordinator will not see the worker's recordings because
 * each process has its own copy. Supply a coordinator backed by a shared
 * store in that scenario.
 */
export function createBatchCoordinator(): BatchCoordinator {
  const batches = new Map<string, BatchProgress>();

  function runCallbacks(batchId: string, progress: BatchProgress): void {
    // Fire callbacks synchronously (but non-blocking for the caller).
    // Callback errors are swallowed: a batch callback is a notification, not
    // part of any job's success path. A throwing callback would fail a job
    // that already succeeded, or mask a real failure, so the error is dropped.
    void (async () => {
      try {
        const summary: BatchSummary = {
          id: batchId,
          total: progress.total,
          succeeded: progress.succeeded,
          failed: progress.failed,
        };

        if (progress.failed === 0) {
          if (progress.callbacks.then) {
            try {
              await progress.callbacks.then(summary);
            } catch {
              // Swallowed: notification failure must not affect any job.
            }
          }
        } else {
          if (progress.callbacks.catch) {
            try {
              await progress.callbacks.catch({
                ...summary,
                failures: [...progress.failures],
              });
            } catch {
              // Swallowed: notification failure must not affect any job.
            }
          }
        }

        if (progress.callbacks.finally) {
          try {
            await progress.callbacks.finally(summary);
          } catch {
            // Swallowed: notification failure must not affect any job.
          }
        }
      } finally {
        batches.delete(batchId);
      }
    })();
  }

  return {
    register(id: string, total: number, callbacks: BatchCallbacks): void {
      const progress: BatchProgress = {
        total,
        callbacks,
        succeeded: 0,
        failed: 0,
        recorded: new Set(),
        failures: [],
        settled: false,
      };
      batches.set(id, progress);
    },

    record(id: string, job: string, index: number, errorMessage: string | undefined): void {
      const progress = batches.get(id);
      if (progress === undefined) {
        return;
      }

      // Idempotent per item: skip if this index was already recorded.
      if (progress.recorded.has(index)) {
        return;
      }
      progress.recorded.add(index);

      if (errorMessage === undefined) {
        progress.succeeded += 1;
      } else {
        progress.failed += 1;
        progress.failures.push({ job, error: errorMessage });
      }

      if (progress.recorded.size < progress.total) {
        return;
      }

      // Single-fire guard: concurrent record calls may race.
      if (progress.settled) {
        return;
      }
      progress.settled = true;

      runCallbacks(id, progress);
    },

    remove(id: string): void {
      batches.delete(id);
    },
  };
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/** Raised for an invalid batch. Messages are value-free. */
export class JobBatchError extends Error {
  readonly code: 'empty_batch' | 'invalid_item';

  constructor(code: 'empty_batch' | 'invalid_item') {
    super(code);
    this.name = 'JobBatchError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Structural check
// ---------------------------------------------------------------------------

/**
 * Structural check for a batch descriptor. Exported so tests and adapters
 * can verify round-trip without importing the full batch module.
 */
export function isBatchDescriptor(value: unknown): value is BatchDescriptor {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    obj.id.length > 0 &&
    typeof obj.total === 'number' &&
    Number.isInteger(obj.total) &&
    obj.total > 0 &&
    typeof obj.index === 'number' &&
    Number.isInteger(obj.index) &&
    obj.index >= 0 &&
    obj.index < obj.total
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a job batch. Eager validation: an empty `items` list or an item
 * missing a non-empty `job` string throws {@link JobBatchError}.
 *
 * The returned batch is inert until `dispatch()` is called. Settlement
 * callbacks fire when the last item's result is recorded by the middleware
 * created from the same `coordinator`, which must be registered on every job
 * in the batch.
 *
 * Callback errors are **swallowed**: a batch callback is a notification, not
 * part of any job's success path. A throwing callback would fail a job that
 * already succeeded, or mask a failure, so the error is dropped.
 */
export function createJobBatch(
  runtime: JobsRuntime,
  coordinator: BatchCoordinator,
  items: readonly BatchItem[],
  callbacks?: BatchCallbacks,
): JobBatch {
  if (items.length === 0) {
    throw new JobBatchError('empty_batch');
  }
  for (const item of items) {
    if (typeof item.job !== 'string' || item.job.trim() === '') {
      throw new JobBatchError('invalid_item');
    }
  }

  const id = crypto.randomUUID();
  const total = items.length;

  coordinator.register(id, total, callbacks ?? {});

  return {
    id,
    async dispatch(): Promise<void> {
      const jobs = items.map((item, index) => {
        const descriptor: BatchDescriptor = { id, total, index };
        const opts = {
          ...((item.opts as Record<string, unknown>) ?? {}),
          [BATCH_OPTION_KEY]: descriptor,
        };
        return runtime.dispatch(item.job, item.data, opts);
      });
      await Promise.all(jobs);
    },
  };
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Create a per-job middleware that records the item's outcome into the
 * supplied coordinator. Register it on every batched job via
 * `createJobsRuntime({ middleware: { [jobName]: [createBatchMiddleware(coordinator)] } })`.
 *
 * - On handler success: records success and returns the result.
 * - On handler failure: records the failure (error message only) and
 *   **re-throws** so the adapter still sees the failure and can retry.
 * - A malformed or absent descriptor is ignored (fail-safe): the handler
 *   runs normally and no recording occurs.
 */
export function createBatchMiddleware(coordinator: BatchCoordinator): JobMiddleware {
  return async (
    _data: unknown,
    context: JobMiddlewareContext,
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const options = (context.options as Record<string, unknown>) ?? {};
    const raw = options[BATCH_OPTION_KEY];

    // Fail-safe: no descriptor -> run handler normally, no recording.
    if (raw === undefined || !isBatchDescriptor(raw)) {
      return next();
    }

    const descriptor = raw;

    try {
      const result = await next();
      coordinator.record(descriptor.id, context.name, descriptor.index, undefined);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      coordinator.record(descriptor.id, context.name, descriptor.index, message);
      throw error;
    }
  };
}
