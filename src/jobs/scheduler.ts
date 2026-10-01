/**
 * Worker and schedule registration.
 *
 * `startJobWorker` builds a BullMQ `Worker` (worker connection:
 * `maxRetriesPerRequest: null`), wires each incoming job through the registry
 * (payload validated again on the worker side), and returns a handle whose
 * `close()` shuts the worker down — draining in-flight jobs first, then
 * closing the Redis the worker owns. The library never registers a
 * `process.on` signal handler: the caller owns signals and calls `close()`.
 *
 * `upsertSchedules` registers cron/interval schedules via BullMQ's
 * `Queue.upsertJobScheduler`. Every property this module can check locally —
 * bounds, duplicate ids, unknown jobs, interval/cron exclusivity, timezone,
 * and payload — is validated before the first registration call. Cron
 * *patterns* are not parsed here: BullMQ validates them per call, and an
 * engine/network failure can also surface mid-loop, so registration is not
 * transactional — a failure may leave earlier schedules registered and they
 * are not rolled back. Ids are stable, so re-running the same list is a safe
 * idempotent retry. Timezones are validated locally with `Intl`.
 *
 * Scheduling is **at-least-once**, not exactly-once: BullMQ deduplicates
 * scheduler registration, not execution. It does not guarantee non-overlap of
 * runs or catch-up of missed runs, so handlers must be idempotent.
 */

import { Worker } from 'bullmq';
import type {
  ConnectionOptions,
  JobSchedulerTemplateOptions,
  RepeatOptions,
  WorkerOptions,
} from 'bullmq';

import {
  attachErrorHandler,
  buildConnectionOptions,
  DEFAULT_PREFIX,
  DEFAULT_QUEUE_NAME,
  defaultErrorLogger,
  type JobErrorHandler,
} from './connection.js';
import { JobUnknownError, validatePayload, type JobContext, type JobRegistry } from './registry.js';

/** Default IANA timezone for cron schedules. */
export const DEFAULT_TIMEZONE = 'UTC';

/** Upper bound on the number of schedules accepted in one call. */
export const MAX_SCHEDULES = 100;

/** Minimum interval (ms) for `everyMs` schedules; prevents pathological loops. */
export const MIN_INTERVAL_MS = 1000;

/** The schedule-registration surface a queue must provide. A BullMQ `Queue` satisfies it. */
export interface SchedulerQueue {
  upsertJobScheduler(
    jobSchedulerId: string,
    repeatOpts: Omit<RepeatOptions, 'key'>,
    jobTemplate?: {
      name?: string;
      data?: unknown;
      opts?: JobSchedulerTemplateOptions;
    },
  ): Promise<unknown>;
}

/** A single schedule to register. Exactly one of `everyMs` or `cron` is required. */
export interface ScheduleSpec {
  /** Stable, unique schedule id (reused across restarts; idempotent upsert). */
  id: string;
  /** Job name; must exist in the registry. */
  job: string;
  /** Run every N milliseconds (exclusive with `cron`). */
  everyMs?: number;
  /** Cron pattern, e.g. `"0 * * * *"` (exclusive with `everyMs`). Validated by BullMQ. */
  cron?: string;
  /** IANA timezone for cron schedules. Defaults to UTC. Ignored for intervals. */
  timezone?: string;
  /** Payload passed to the job; validated against the registry schema. */
  data?: unknown;
}

/** Raised for invalid schedule input this module rejects locally, before any registration call. */
export class ScheduleError extends Error {
  readonly scheduleId: string | undefined;

  constructor(message: string, scheduleId?: string) {
    super(message);
    this.name = 'ScheduleError';
    this.scheduleId = scheduleId;
  }
}

/** The minimal job surface the worker processor consumes. */
export interface WorkerJob {
  readonly name: string;
  readonly id?: string;
  readonly data: unknown;
  readonly attemptsMade: number;
  readonly attemptsStarted: number;
  log(message: string): Promise<unknown>;
  updateProgress(progress: number | Record<string, unknown>): Promise<void>;
}

/** The worker surface the handle needs. A BullMQ `Worker` satisfies it. */
export interface JobWorker {
  close(force?: boolean): Promise<void>;
  on(eventName: 'error', listener: (error: Error) => void): unknown;
}

/** Dependency-injection seam: builds the underlying worker. Tests pass a mock. */
export type WorkerFactory = (
  queueName: string,
  processor: (job: WorkerJob) => Promise<unknown>,
  opts: WorkerOptions<ConnectionOptions>,
) => JobWorker;

/** Options accepted by {@link startJobWorker}. */
export interface StartJobWorkerOptions {
  /** Redis connection URL. */
  redisUrl: string;
  /** Queue name to process. Defaults to `"default"`. */
  queueName?: string;
  /** Redis key prefix. Defaults to `"bull"`. */
  prefix?: string;
  /** The registry naming the jobs this worker handles. */
  registry: JobRegistry;
  /** Concurrent jobs processed at once. Defaults to 1. */
  concurrency?: number;
  /** Optional error callback; when absent, errors are logged payload-free. */
  onError?: JobErrorHandler;
  /** Test seam: override the Worker construction. */
  workerFactory?: WorkerFactory;
}

/** Handle returned by {@link startJobWorker}. */
export interface JobWorkerHandle {
  /** The underlying worker. */
  readonly worker: JobWorker;
  /**
   * Gracefully shut down: closes the worker first (waiting for in-flight jobs
   * to finalize), then its owned Redis connection. Idempotent.
   */
  close(force?: boolean): Promise<void>;
}

/** Build the worker's processor: validate the payload, then call the handler. */
function makeProcessor(registry: JobRegistry): (job: WorkerJob) => Promise<unknown> {
  return async (job) => {
    const definition = registry[job.name];
    if (definition === undefined) {
      throw new JobUnknownError(job.name);
    }
    const data = validatePayload(definition.schema, job.name, job.data);
    const context: JobContext = {
      jobId: job.id,
      name: job.name,
      attemptsMade: job.attemptsMade,
      attemptsStarted: job.attemptsStarted,
      log: (message) => job.log(message).then(() => undefined),
      updateProgress: (progress) => job.updateProgress(progress),
    };
    return definition.handler(data, context);
  };
}

const defaultWorkerFactory: WorkerFactory = (queueName, processor, opts) =>
  new Worker(queueName, processor, opts);

/**
 * Start a worker that processes `queueName` against `registry`. Instantiates a
 * BullMQ `Worker` immediately (this is what connects); importing this module
 * does not. The returned handle's `close()` is the shutdown path; the library
 * never installs a `process.on` signal handler.
 */
export function startJobWorker(options: StartJobWorkerOptions): JobWorkerHandle {
  const queueName = options.queueName ?? DEFAULT_QUEUE_NAME;
  const processor = makeProcessor(options.registry);

  const workerOpts: WorkerOptions<ConnectionOptions> = {
    connection: buildConnectionOptions(options.redisUrl, 'worker'),
    prefix: options.prefix ?? DEFAULT_PREFIX,
    concurrency: options.concurrency ?? 1,
  };

  const worker = (options.workerFactory ?? defaultWorkerFactory)(queueName, processor, workerOpts);
  attachErrorHandler(worker, options.onError, defaultErrorLogger('worker', queueName));

  let closed = false;

  return {
    worker,

    async close(force) {
      if (closed) {
        return;
      }
      closed = true;
      // Close the worker first (draining in-flight jobs), then its owned
      // Redis connection — the order BullMQ's close() enforces internally.
      await worker.close(force);
    },
  };
}

/**
 * A schedule after local validation: provider-neutral fields plus a resolved
 * repeat. A queue provider (or the neutral job runtime) converts `repeat` to
 * its own protocol; no provider types leak out of this module.
 */
export interface PreparedSchedule {
  readonly id: string;
  readonly job: string;
  readonly repeat: { readonly every: number } | { readonly pattern: string; readonly tz: string };
  readonly data: unknown;
}

/**
 * Validate a whole schedule list once, before any registration call. Every
 * locally checkable property — count bound, duplicate ids, known jobs,
 * interval/cron exclusivity, timezone, and payload — is checked here. Cron
 * pattern validity is delegated to the provider and is checked per call.
 */
export function prepareSchedules(
  registry: JobRegistry,
  schedules: readonly ScheduleSpec[],
): PreparedSchedule[] {
  if (schedules.length > MAX_SCHEDULES) {
    throw new ScheduleError(
      `at most ${MAX_SCHEDULES} schedules are supported, got ${schedules.length}`,
    );
  }

  const prepared: PreparedSchedule[] = [];
  const seen = new Set<string>();

  for (const schedule of schedules) {
    if (typeof schedule.id !== 'string' || schedule.id.trim() === '') {
      throw new ScheduleError('schedule id must be a non-empty string');
    }
    if (seen.has(schedule.id)) {
      throw new ScheduleError(`duplicate schedule id "${schedule.id}"`, schedule.id);
    }
    seen.add(schedule.id);

    const definition = registry[schedule.job];
    if (definition === undefined) {
      throw new ScheduleError(
        `schedule "${schedule.id}" references unknown job "${schedule.job}"`,
        schedule.id,
      );
    }

    const hasEvery = schedule.everyMs !== undefined;
    const hasCron = schedule.cron !== undefined;
    if (hasEvery === hasCron) {
      throw new ScheduleError(
        `schedule "${schedule.id}" must specify exactly one of everyMs or cron`,
        schedule.id,
      );
    }

    let repeat: PreparedSchedule['repeat'];
    if (hasEvery) {
      if (schedule.timezone !== undefined) {
        throw new ScheduleError(
          `schedule "${schedule.id}" timezone is only valid with cron schedules`,
          schedule.id,
        );
      }
      const everyMs = schedule.everyMs;
      if (typeof everyMs !== 'number' || !Number.isInteger(everyMs) || everyMs < MIN_INTERVAL_MS) {
        throw new ScheduleError(
          `schedule "${schedule.id}" everyMs must be an integer >= ${MIN_INTERVAL_MS}`,
          schedule.id,
        );
      }
      repeat = { every: everyMs };
    } else {
      const cron = schedule.cron;
      if (typeof cron !== 'string' || cron.trim() === '') {
        throw new ScheduleError(
          `schedule "${schedule.id}" cron must be a non-empty string`,
          schedule.id,
        );
      }
      repeat = { pattern: cron, tz: validateTimezone(schedule.timezone, schedule.id) };
    }

    const data =
      schedule.data === undefined
        ? undefined
        : validatePayload(definition.schema, schedule.job, schedule.data);

    prepared.push({ id: schedule.id, job: schedule.job, repeat, data });
  }

  return prepared;
}

/**
 * Register every schedule via `Queue.upsertJobScheduler`. The list is fully
 * validated by {@link prepareSchedules} before the first registration call.
 * Cron pattern validity is delegated to BullMQ and is checked per call, so a
 * bad pattern or an engine/network failure can still occur after earlier
 * schedules were registered; those are not rolled back. Re-running the same
 * list is a safe retry because ids are stable.
 */
export async function upsertSchedules(
  queue: SchedulerQueue,
  registry: JobRegistry,
  schedules: readonly ScheduleSpec[],
): Promise<void> {
  for (const entry of prepareSchedules(registry, schedules)) {
    await queue.upsertJobScheduler(entry.id, entry.repeat, {
      name: entry.job,
      data: entry.data,
    });
  }
}

/** Validate an IANA timezone with `Intl`, defaulting to UTC. */
function validateTimezone(timezone: string | undefined, scheduleId: string): string {
  const tz = timezone ?? DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new ScheduleError(`schedule "${scheduleId}" has invalid timezone "${tz}"`, scheduleId);
  }
  return tz;
}
