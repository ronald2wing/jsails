/**
 * Producer queue: dispatch payloads to a BullMQ queue with bounded retries.
 *
 * `createJobQueue` builds a `Queue` from a `redisUrl` (producer connection:
 * finite retries, no offline queue), attaches non-silent error routing, and
 * returns a small handle: `dispatch(name, payload, opts)`, `close()`, and the
 * underlying `queue` (exposed so `upsertSchedules` can register schedulers).
 *
 * Importing this module never connects; only instantiating the queue does.
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

import { Queue } from 'bullmq';
import type { BackoffOptions, ConnectionOptions, JobsOptions, QueueOptions } from 'bullmq';

import {
  attachErrorHandler,
  buildConnectionOptions,
  DEFAULT_PREFIX,
  DEFAULT_QUEUE_NAME,
  defaultErrorLogger,
  type JobErrorHandler,
} from './connection.js';
import { JobUnknownError, validatePayload, type JobRegistry } from './registry.js';
import type { SchedulerQueue } from './scheduler.js';

/** Default number of attempts for a dispatched job. */
export const DEFAULT_ATTEMPTS = 3;

/** Base delay (ms) for the default exponential backoff. */
export const DEFAULT_BACKOFF_MS = 1000;

/** Upper bound on overridden `attempts`; prevents unbounded retries. */
export const MAX_ATTEMPTS = 25;

/** The underlying queue surface this library needs. A BullMQ `Queue` satisfies it. */
export interface JobQueue extends SchedulerQueue {
  add(name: string, data: unknown, opts?: JobsOptions): Promise<unknown>;
  close(): Promise<void>;
  on(eventName: 'error', listener: (error: Error) => void): unknown;
}

/** Dependency-injection seam: builds the underlying queue. Tests pass a mock. */
export type QueueFactory = (name: string, opts: QueueOptions<ConnectionOptions>) => JobQueue;

/** Options accepted by {@link createJobQueue}. */
export interface CreateJobQueueOptions {
  /** Redis connection URL (e.g. `redis://127.0.0.1:6379`). */
  redisUrl: string;
  /** Queue name. Defaults to `"default"`. */
  queueName?: string;
  /** Redis key prefix. Defaults to `"bull"`. */
  prefix?: string;
  /** The registry naming the jobs this queue may dispatch. */
  registry: JobRegistry;
  /** Optional error callback; when absent, errors are logged payload-free. */
  onError?: JobErrorHandler;
  /** Test seam: override the Queue construction. */
  queueFactory?: QueueFactory;
}

/** Handle returned by {@link createJobQueue}. */
export interface JobQueueHandle {
  /** The underlying queue, exposed for scheduler registration. */
  readonly queue: JobQueue;
  /** Validate and enqueue a job. Returns the BullMQ `add` result. */
  dispatch(name: string, payload: unknown, opts?: unknown): Promise<unknown>;
  /** Close the queue and its owned Redis connection. Idempotent. */
  close(): Promise<void>;
}

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

const defaultQueueFactory: QueueFactory = (name, opts) => new Queue(name, opts);

/**
 * Create a producer queue handle. Instantiates a BullMQ `Queue` immediately
 * (this is what connects); importing this module does not.
 */
export function createJobQueue(options: CreateJobQueueOptions): JobQueueHandle {
  const queueName = options.queueName ?? DEFAULT_QUEUE_NAME;
  const registry = options.registry;

  const queueOpts: QueueOptions<ConnectionOptions> = {
    connection: buildConnectionOptions(options.redisUrl, 'producer'),
    prefix: options.prefix ?? DEFAULT_PREFIX,
    // A web producer fails fast if Redis is not reachable, instead of
    // blocking the request on connection readiness.
    skipWaitingForReady: true,
    defaultJobOptions: defaultJobOptions(),
  };

  const queue = (options.queueFactory ?? defaultQueueFactory)(queueName, queueOpts);
  attachErrorHandler(queue, options.onError, defaultErrorLogger('queue', queueName));

  let closed = false;

  return {
    queue,

    async dispatch(name, payload, opts) {
      const definition = registry[name];
      if (definition === undefined) {
        throw new JobUnknownError(name);
      }
      const data = validatePayload(definition.schema, name, payload);
      const jobOptions = validateJobOptions(opts);
      return queue.add(name, data, { ...defaultJobOptions(), ...jobOptions });
    },

    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await queue.close();
    },
  };
}
