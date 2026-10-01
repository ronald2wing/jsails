/**
 * Producer queue surface and shared job-option policy.
 *
 * This module owns the pieces every BullMQ job path shares: the {@link JobQueue}
 * structural contract (a BullMQ `Queue` satisfies it), the bounded
 * dispatch-option allowlist (`validateJobOptions`), and the default job options
 * (`defaultJobOptions`). The built-in BullMQ adapter (`./bullmq-adapter.js`) and
 * the neutral runtime (`./runtime.js`) consume these; importing this module
 * opens no connection — only instantiating a queue/worker does.
 *
 * Bounded, safe defaults:
 * - Every dispatched job gets `attempts: 3` and exponential backoff (1000ms
 *   base) unless overridden.
 * - Overridden job options are validated against an allowlist; `attempts` is
 *   capped so a caller cannot request unbounded retries.
 * - `jobId` is an optional idempotency hint, not an exactly-once guarantee:
 *   BullMQ skips adding a job whose id already exists, but redelivery after a
 *   worker crash is at-least-once.
 */

import type {
  BackoffOptions,
  ConnectionOptions,
  JobSchedulerJson,
  JobsOptions,
  JobSchedulerTemplateOptions,
  JobType,
  QueueOptions,
  RepeatOptions,
} from 'bullmq';

/** Default number of attempts for a dispatched job. */
export const DEFAULT_ATTEMPTS = 3;

/** Base delay (ms) for the default exponential backoff. */
export const DEFAULT_BACKOFF_MS = 1000;

/** Upper bound on overridden `attempts`; prevents unbounded retries. */
export const MAX_ATTEMPTS = 25;

/** The underlying queue surface this library needs. A BullMQ `Queue` satisfies it. */
export interface JobQueue {
  add(name: string, data: unknown, opts?: JobsOptions): Promise<unknown>;
  close(): Promise<void>;
  on(eventName: 'error', listener: (error: Error) => void): unknown;
  upsertJobScheduler(
    jobSchedulerId: string,
    repeatOpts: Omit<RepeatOptions, 'key'>,
    jobTemplate?: {
      name?: string;
      data?: unknown;
      opts?: JobSchedulerTemplateOptions;
    },
  ): Promise<unknown>;
  /**
   * Read per-type job counts for the requested states. Present on the built-in
   * BullMQ `Queue`; a mock/alternate queue may omit it (a capability, not a
   * requirement of the producer contract).
   */
  getJobCounts?(...types: JobType[]): Promise<{ [index: string]: number }>;
  /**
   * List registered job schedulers. Present on the built-in BullMQ `Queue`; a
   * mock/alternate queue may omit it (a capability, not a requirement).
   */
  getJobSchedulers?(): Promise<readonly JobSchedulerJson[]>;
  /**
   * Remove a job scheduler by id. Present on the built-in BullMQ `Queue`; a
   * mock/alternate queue may omit it (a capability, not a requirement).
   */
  removeJobScheduler?(jobSchedulerId: string): Promise<boolean>;
  /**
   * Pause the queue so no new jobs are processed. Non-durable and
   * process-scoped: the provider owns the pause state, and a restarted
   * process sees the provider's own default. Present on the built-in BullMQ
   * `Queue`; a mock/alternate queue may omit it (a capability, not a
   * requirement).
   */
  pause?(): Promise<void>;
  /**
   * Resume a paused queue so jobs are processed again. Non-durable and
   * process-scoped: the provider owns the resume state. Present on the
   * built-in BullMQ `Queue`; a mock/alternate queue may omit it (a
   * capability, not a requirement).
   */
  resume?(): Promise<void>;
}

/** Dependency-injection seam: builds the underlying queue. Tests pass a mock. */
export type QueueFactory = (name: string, opts: QueueOptions<ConnectionOptions>) => JobQueue;

/** Raised when overridden job options are not in the allowlist or unbounded. */
export class JobOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobOptionsError';
  }
}

/** The only job-option keys a dispatch may override. Everything else is rejected. */
const ALLOWED_JOB_OPTIONS = new Set([
  'jobId',
  'delay',
  'priority',
  'lifo',
  'attempts',
  'backoff',
  'removeOnComplete',
  'removeOnFail',
  'keepLogs',
  'stackTraceLimit',
  'sizeLimit',
  // Framework-reserved key for job chaining. A caller who can dispatch can
  // already dispatch any registered job — the descriptor grants no new
  // capability. The descriptor is stored verbatim in dispatch options; the
  // chain middleware validates the descriptor structurally on the worker
  // side and fails safe (returns the handler result unchanged) on a
  // malformed descriptor. See src/jobs/chain.ts.
  '__jsailsChain',
  // Framework-reserved key for job batching. Same trust model as chaining:
  // the batch middleware validates the descriptor structurally on the
  // worker side and fails safe. See src/jobs/batch.ts.
  '__jsailsBatch',
  // Framework-reserved key for overlap control. Same trust model as
  // chaining/batching: the overlap middleware validates the descriptor
  // structurally on the worker side and fails safe. See src/jobs/overlap.ts.
  '__jsailsOverlap',
  // Framework-reserved key for job tags. Same trust model as other
  // reserved keys: the value is forwarded verbatim so the worker-side
  // reader can normalize and attach it to metrics/failed-store entries.
  // See src/jobs/tags.ts.
  '__jsailsTags',
]);

/** The default job options: bounded attempts with exponential backoff. */
export function defaultJobOptions(): JobsOptions {
  return {
    attempts: DEFAULT_ATTEMPTS,
    backoff: { type: 'exponential', delay: DEFAULT_BACKOFF_MS },
  };
}

/**
 * Validate overridden job options against the allowlist, bounding `attempts`
 * and `backoff` so a caller cannot request unbounded retries.
 */
export function validateJobOptions(opts: unknown): JobsOptions {
  if (opts === undefined) {
    return {};
  }
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new JobOptionsError('job options must be an object');
  }

  const source = opts as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!ALLOWED_JOB_OPTIONS.has(key)) {
      throw new JobOptionsError(`unsupported job option "${key}"`);
    }
  }

  const result: JobsOptions = {};

  if (source.jobId !== undefined) {
    if (typeof source.jobId !== 'string' || source.jobId === '') {
      throw new JobOptionsError('jobId must be a non-empty string');
    }
    result.jobId = source.jobId;
  }
  if (source.delay !== undefined) {
    if (typeof source.delay !== 'number' || !Number.isFinite(source.delay) || source.delay < 0) {
      throw new JobOptionsError('delay must be a non-negative number of milliseconds');
    }
    result.delay = source.delay;
  }
  if (source.priority !== undefined) {
    if (typeof source.priority !== 'number' || !Number.isInteger(source.priority)) {
      throw new JobOptionsError('priority must be an integer');
    }
    result.priority = source.priority;
  }
  if (source.lifo !== undefined) {
    if (typeof source.lifo !== 'boolean') {
      throw new JobOptionsError('lifo must be a boolean');
    }
    result.lifo = source.lifo;
  }
  if (source.attempts !== undefined) {
    if (
      typeof source.attempts !== 'number' ||
      !Number.isInteger(source.attempts) ||
      source.attempts < 1 ||
      source.attempts > MAX_ATTEMPTS
    ) {
      throw new JobOptionsError(`attempts must be an integer between 1 and ${MAX_ATTEMPTS}`);
    }
    result.attempts = source.attempts;
  }
  if (source.backoff !== undefined) {
    result.backoff = validateBackoff(source.backoff);
  }

  // Framework-reserved key for job chaining: passed through verbatim so the
  // chain middleware can read it from job.opts on the worker side. A caller
  // who can dispatch can already dispatch any registered job, so the
  // descriptor grants no new capability. The middleware validates the
  // descriptor structurally and fails safe on a malformed one.
  if (source.__jsailsChain !== undefined) {
    (result as Record<string, unknown>).__jsailsChain = source.__jsailsChain;
  }

  // Framework-reserved key for job batching: same trust model as chaining.
  // The batch middleware validates the descriptor structurally and fails safe.
  if (source.__jsailsBatch !== undefined) {
    (result as Record<string, unknown>).__jsailsBatch = source.__jsailsBatch;
  }

  // Framework-reserved key for overlap control: same trust model.
  // The overlap middleware validates the descriptor structurally and fails safe.
  if (source.__jsailsOverlap !== undefined) {
    (result as Record<string, unknown>).__jsailsOverlap = source.__jsailsOverlap;
  }

  // Framework-reserved key for job tags: same trust model as other reserved
  // keys. The value is forwarded verbatim; the worker-side reader normalizes
  // and attaches it to metrics and failed-job store entries.
  if (source.__jsailsTags !== undefined) {
    (result as Record<string, unknown>).__jsailsTags = source.__jsailsTags;
  }

  // These keys are safe to forward verbatim; BullMQ validates their values.
  for (const key of [
    'removeOnComplete',
    'removeOnFail',
    'keepLogs',
    'stackTraceLimit',
    'sizeLimit',
  ] as const) {
    const value = source[key];
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }

  return result;
}

function validateBackoff(value: unknown): number | BackoffOptions {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new JobOptionsError('backoff must be a non-negative number of milliseconds');
    }
    return value;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const backoff = value as Record<string, unknown>;
    const type = backoff.type;
    if (type !== 'fixed' && type !== 'exponential') {
      throw new JobOptionsError('backoff.type must be "fixed" or "exponential"');
    }
    const delay = backoff.delay;
    if (
      delay !== undefined &&
      (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0)
    ) {
      throw new JobOptionsError('backoff.delay must be a non-negative number of milliseconds');
    }
    return { type, delay };
  }
  throw new JobOptionsError('backoff must be a number or a { type, delay } object');
}
