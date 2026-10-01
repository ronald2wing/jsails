/**
 * Job chaining: sequence multiple jobs so each step is enqueued only after the
 * previous one succeeds. Built on the per-job middleware seam (Slice 1).
 *
 * ## Model
 *
 * A chain is a linear list of {@link ChainStep}s. `createJobChain(runtime,
 * steps)` validates the list and returns a {@link JobChain} whose `dispatch()`
 * enqueues step 1. The {@link chainMiddleware}, registered on EVERY chained job
 * via `createJobsRuntime({ middleware: { [jobName]: [chainMiddleware] } })`,
 * reads the chain descriptor from the reserved dispatch-option key and, after
 * the handler succeeds, dispatches the next step with the remaining descriptor.
 *
 * Each step's payload is validated by the runtime on dispatch AND on the worker
 * side before the handler runs (the same pipeline as any other job). A handler
 * that throws stops the chain: the error propagates to the adapter, which owns
 * retry. A retried step re-runs the handler and, on success, continues the
 * chain from where it left off — handlers must be idempotent (at-least-once
 * semantics).
 *
 * ## Reserved option key
 *
 * The chain descriptor is carried in the dispatch options under
 * {@link CHAIN_OPTION_KEY}. It is stripped from the validated payload (the
 * handler never sees it) and read back by the middleware on the worker side
 * from `context.options`. The key is added to the job-option allowlist so it
 * survives `validateJobOptions` round-trip.
 *
 * ## Wiring
 *
 * ```ts
 * import { createJobsRuntime } from 'jsails';
 * import { chainMiddleware } from 'jsails/jobs';
 *
 * const runtime = createJobsRuntime({
 *   registry,
 *   adapter,
 *   middleware: {
 *     stepA: [chainMiddleware],
 *     stepB: [chainMiddleware],
 *     stepC: [chainMiddleware],
 *   },
 * });
 * ```
 */

import { type JobMiddleware, type JobMiddlewareContext } from './middleware.js';
import type { JobsRuntime } from './runtime.js';

/** Reserved dispatch-option key that carries the chain descriptor. */
export const CHAIN_OPTION_KEY = '__jsailsChain';

/** One step in a job chain. */
export interface ChainStep {
  /** Name of the job to dispatch, matching a registry key. */
  readonly job: string;
  /** Payload for the step, validated against the job's schema. */
  readonly data: unknown;
  /** Optional dispatch options forwarded to `runtime.dispatch`. */
  readonly opts?: unknown;
}

/**
 * Internal shape stored under {@link CHAIN_OPTION_KEY}. The first element is
 * the next step to dispatch; the rest follow.
 */
interface ChainDescriptor {
  readonly remaining: readonly ChainStep[];
}

/** A validated job chain whose `dispatch()` enqueues the first step. */
export interface JobChain {
  /**
   * Dispatch the first step of the chain. The return value is the producer's
   * own dispatch result. Subsequent steps are enqueued by the middleware after
   * each handler succeeds.
   */
  dispatch(): Promise<unknown>;
}

/**
 * Raised for an invalid chain: empty steps or a step missing a non-empty
 * `job` string. Messages are value-free — they never echo step data.
 */
export class JobChainError extends Error {
  readonly code: 'empty_chain' | 'invalid_step';

  constructor(code: 'empty_chain' | 'invalid_step') {
    super(code);
    this.name = 'JobChainError';
    this.code = code;
  }
}

/**
 * Validate and build a job chain against the given runtime. Eager validation:
 * an empty list or a step without a non-empty `job` string throws
 * {@link JobChainError}. The returned chain is inert until `dispatch()` is
 * called.
 */
export function createJobChain(runtime: JobsRuntime, steps: readonly ChainStep[]): JobChain {
  if (steps.length === 0) {
    throw new JobChainError('empty_chain');
  }
  for (const step of steps) {
    if (typeof step.job !== 'string' || step.job.trim() === '') {
      throw new JobChainError('invalid_step');
    }
  }

  return {
    async dispatch(): Promise<unknown> {
      // steps.length > 0 was validated eagerly, so head is guaranteed present.
      const head = steps[0]!;
      const remaining = steps.slice(1);
      const descriptor: ChainDescriptor = { remaining };
      const opts = {
        ...((head.opts as Record<string, unknown>) ?? {}),
        [CHAIN_OPTION_KEY]: descriptor,
      };
      return runtime.dispatch(head.job, head.data, opts);
    },
  };
}

/**
 * Per-job middleware that advances a chain. Register it on every chained job
 * via `createJobsRuntime({ middleware: { [jobName]: [chainMiddleware] } })`.
 *
 * After the handler succeeds the middleware reads the chain descriptor from
 * `context.options[CHAIN_OPTION_KEY]`. If there are remaining steps it
 * dispatches the next one with the updated descriptor; if the descriptor is
 * absent or empty it does nothing extra. A handler error propagates unchanged
 * and the next step is never dispatched.
 */
export const chainMiddleware: JobMiddleware = async (
  _data: unknown,
  context: JobMiddlewareContext,
  next: () => Promise<unknown>,
): Promise<unknown> => {
  // Run the handler first. If it throws, we never reach the dispatch below —
  // the chain stops and the error propagates to the adapter.
  const result = await next();

  const options = (context.options as Record<string, unknown>) ?? {};
  const raw = options[CHAIN_OPTION_KEY];

  if (raw === undefined) {
    return result;
  }

  // Validate the descriptor structurally before acting on it.
  // A malformed descriptor must never cause an arbitrary dispatch: the caller
  // who dispatched this job already has the ability to dispatch any registered
  // job, so failing-safe here (returning the handler result unchanged) grants
  // no new capability. We do NOT throw — throwing would fail the job and
  // trigger retries for a framework-internal consistency problem that retries
  // can never fix.
  if (!isChainDescriptor(raw)) {
    return result;
  }

  if (raw.remaining.length === 0) {
    return result;
  }

  // remaining is non-empty after the guard above. isChainDescriptor verified
  // every element has a non-empty string `job`.
  const head = raw.remaining[0]!;
  const further = raw.remaining.slice(1);
  const nextDescriptor: ChainDescriptor = { remaining: further };
  const opts = {
    ...((head.opts as Record<string, unknown>) ?? {}),
    [CHAIN_OPTION_KEY]: nextDescriptor,
  };

  // The runtime validates the payload and options on the next step.
  await context.dispatch(head.job, head.data, opts);

  return result;
};

/**
 * Structural check for a chain descriptor without assuming the concrete shape.
 * Exported so tests and adapters can verify round-trip without importing the
 * full chain module.
 */
export function isChainDescriptor(value: unknown): value is ChainDescriptor {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.remaining)) {
    return false;
  }
  return (obj.remaining as unknown[]).every(
    (step): step is ChainStep =>
      step !== null &&
      typeof step === 'object' &&
      typeof (step as Record<string, unknown>).job === 'string' &&
      ((step as Record<string, unknown>).job as string).length > 0,
  );
}
