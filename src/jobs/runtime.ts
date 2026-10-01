/**
 * Provider-neutral job runtime controller.
 *
 * `createJobsRuntime` binds a {@link JobRegistry} to a {@link JobsRuntimeAdapter}
 * — a small, transport-specific implementation (a BullMQ bridge, an in-memory
 * test adapter, or any other queue). The controller owns the job-level policy
 * that must hold for every provider:
 *
 * - payloads are validated against the registry schema on dispatch AND on
 *   processing, so a bad payload never reaches a handler unvalidated;
 * - dispatch options go through the same allowlist as the built-in queue;
 * - schedules are validated locally (ids, known jobs, interval/cron
 *   exclusivity, timezone, payload) before any provider call;
 * - producer and worker handles are created lazily on first use and closed
 *   idempotently.
 *
 * The adapter — not this module — owns the connection, protocol, retry, and
 * execution semantics. This module exposes no BullMQ/ioredis types in its
 * public signatures, so a custom adapter can target any backend without
 * depending on the built-in stack. A custom adapter needs no connection URL at
 * all: `createJobsRuntime` never receives one.
 *
 * Scheduling is **at-least-once**: no exactly-once, non-overlap, or catch-up
 * guarantee is provided; handlers must be idempotent.
 */

import { DEFAULT_PREFIX, DEFAULT_QUEUE_NAME } from './connection.js';
import { jobCompleted, jobFailed, jobPushed, jobRetried } from './events.js';
import {
  composeMiddleware,
  JobMiddlewareError,
  type JobMiddleware,
  type JobMiddlewareContext,
} from './middleware.js';
import { type SignalBus } from '../signals/signal-bus.js';
import { type PausedScheduleStore } from './paused-schedules.js';
import { validateJobOptions } from './queue.js';
import {
  JobNotRegisteredError,
  validatePayload,
  type JobContext,
  type JobRegistry,
} from './registry.js';
import {
  prepareSchedules,
  type OverlapDescriptor,
  type PreparedSchedule,
  type ScheduleDefinition,
} from './scheduler.js';
import { type Awaitable } from '../internal/types.js';

/** Validated options handed to a provider's `dispatch`. */
export type JobDispatchOptions = Record<string, unknown>;

/** Neutral context describing the queue a runtime adapter binds to. */
export interface JobAdapterContext {
  readonly queueName: string;
  readonly prefix: string;
  readonly concurrency: number;
  readonly registry: JobRegistry;
}

/** Read-only queue metrics, normalized across transport backends. */
export interface QueueCounts {
  /** Jobs waiting to be processed. */
  readonly waiting: number;
  /** Jobs currently being processed. */
  readonly active: number;
  /** Jobs finished successfully. */
  readonly completed: number;
  /** Jobs finished with an error after exhausting retries. */
  readonly failed: number;
  /** Jobs scheduled to run later. */
  readonly delayed: number;
}

/** The producer surface a runtime adapter must provide. */
export interface RuntimeProducer {
  /** Enqueue a payload already validated by the controller. */
  dispatch(name: string, data: unknown, options: JobDispatchOptions): Promise<unknown>;
  /** Close the producer and its owned resources. Idempotent. */
  close(): Promise<void>;
  /**
   * Read queue metrics when the underlying transport supports them. Absent on
   * backends without a countable queue (a capability, not a requirement).
   */
  readCounts?(): Promise<QueueCounts>;
  /**
   * Pause the queue so no new jobs are processed. Non-durable and
   * process-scoped: the provider owns the pause state, and a restarted
   * process sees the provider's own default. Absent on backends without a
   * pausable queue (a capability, not a requirement).
   */
  pause?(): Promise<void>;
  /**
   * Resume a paused queue so jobs are processed again. Non-durable and
   * process-scoped: the provider owns the resume state. Absent on backends
   * without a pausable queue (a capability, not a requirement).
   */
  resume?(): Promise<void>;
}

/** A received job as seen by the neutral processor. */
export interface RuntimeJob {
  readonly name: string;
  readonly id?: string;
  readonly data: unknown;
  readonly attemptsMade: number;
  readonly attemptsStarted: number;
  /**
   * Raw dispatch options as set at enqueue time. BullMQ surfaces these as
   * `job.opts`; a custom adapter may omit them. Framework features such as
   * job chaining read reserved keys from this field.
   */
  readonly opts?: unknown;
  log(message: string): Promise<unknown>;
  updateProgress(progress: number | Record<string, unknown>): Promise<void>;
}

/** Process one received job: validate it, then invoke the registry handler. */
export type ProcessJob = (job: RuntimeJob) => Promise<unknown>;

/** The worker surface a runtime adapter must provide. */
export interface RuntimeWorker {
  /** Shut the worker down; `force` skips draining in-flight jobs. Idempotent. */
  close(force?: boolean): Promise<void>;
}

/**
 * A read-only view of one registered schedule, normalized across backends.
 */
export interface ScheduleInfo {
  /** The schedule id. */
  readonly id: string;
  /** The job name the schedule dispatches. */
  readonly job: string;
  /** A human-readable repeat description (e.g. `every 5000ms` or a cron pattern). */
  readonly repeat: string;
  /** Epoch milliseconds of the next run, when the backend can report it. */
  readonly nextRunAt?: number;
  /** The resolved overlap descriptor, when the schedule opts into overlap control. */
  readonly overlap?: OverlapDescriptor;
}

/**
 * The pluggable adapter contract. `createProducer`/`createWorker` are lazy:
 * the controller calls them only on first use. An adapter that throws from
 * either call owns the cleanup of whatever it partially created.
 */
export interface JobsRuntimeAdapter {
  /** Diagnostic label, never used for identity or routing. */
  readonly name: string;
  createProducer(context: JobAdapterContext): Awaitable<RuntimeProducer>;
  createWorker(context: JobAdapterContext, processJob: ProcessJob): Awaitable<RuntimeWorker>;
  /**
   * Optional scheduler capability. Receives the producer handle this runtime
   * created (so a stateful adapter can recover its native queue) plus fully
   * validated, provider-neutral schedules. When absent, `upsertSchedules`
   * throws instead of silently doing nothing.
   */
  upsertSchedules?(
    producer: RuntimeProducer,
    schedules: readonly PreparedSchedule[],
  ): Promise<void>;
  /**
   * Optional schedule-inspection capability. Returns a value-free view of the
   * schedules registered on the producer this runtime created. When absent,
   * `listSchedules` throws instead of silently returning an empty list.
   */
  listSchedules?(producer: RuntimeProducer): Promise<readonly ScheduleInfo[]>;
  /**
   * Optional schedule-pause capability. Removes the named schedules so they stop
   * firing. Non-durable: a later `work` start re-registers them. When absent,
   * `pauseSchedules` throws.
   */
  pauseSchedules?(producer: RuntimeProducer, ids: readonly string[]): Promise<void>;
}

/** Raised for an invalid adapter or a runtime-level misuse. */
export class JobsRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobsRuntimeError';
  }
}

/** Raised when an operation is attempted after {@link JobsRuntime.close}. */
export class JobsRuntimeClosedError extends JobsRuntimeError {
  constructor() {
    super('the job runtime is closed');
    this.name = 'JobsRuntimeClosedError';
  }
}

/** Options accepted by {@link createJobsRuntime}. */
export interface JobsRuntimeOptions {
  /** The registry naming the jobs this runtime may dispatch and process. */
  readonly registry: JobRegistry;
  /** The transport adapter. */
  readonly adapter: JobsRuntimeAdapter;
  /** Queue name. Defaults to `"default"`. */
  readonly queueName?: string;
  /** Key prefix. Defaults to `"bull"`. */
  readonly prefix?: string;
  /** Worker concurrency. Defaults to 1. */
  readonly concurrency?: number;
  /** Per-job middleware, keyed by job name. Each array runs in declared order. */
  readonly middleware?: Readonly<Record<string, readonly JobMiddleware[]>>;
  /**
   * Optional signal bus for job lifecycle events. When present, the runtime
   * emits `jobPushed` / `jobCompleted` / `jobFailed` / `jobRetried`. Absent
   * leaves behaviour byte-identical (no emission, no error).
   */
  readonly signals?: SignalBus;
  /**
   * Optional durable schedule-pause store. When present, `pauseSchedules`
   * persists the paused ids (making pause durable across restarts) and
   * `upsertSchedules` skips their re-registration on a later `work` start.
   * When absent, pause is non-durable: the adapter removes the schedules and
   * the next `work` start re-registers everything (today's behaviour).
   *
   * Durability is the store's contract: an in-memory store is process-scoped;
   * a Valkey-backed {@link import('./paused-schedules.js').CachePausedScheduleStore}
   * is multi-process.
   */
  readonly pausedSchedules?: PausedScheduleStore;
}

/** The controller returned by {@link createJobsRuntime}. */
export interface JobsRuntime {
  /** Validate and enqueue a job. The result is the provider's own value. */
  dispatch(name: string, payload: unknown, opts?: unknown): Promise<unknown>;
  /** Lazily create the worker and begin processing. */
  startWorker(): Promise<void>;
  /**
   * Pause the queue so no new jobs are processed. Non-durable and
   * process-scoped: the provider owns the pause state, and a restarted
   * process sees the provider's own default. Requires a producer whose
   * transport supports pausing; otherwise throws {@link JobsRuntimeError}.
   */
  pauseQueue(): Promise<void>;
  /**
   * Resume a paused queue so jobs are processed again. Non-durable and
   * process-scoped: the provider owns the resume state. Requires a producer
   * whose transport supports pausing; otherwise throws {@link JobsRuntimeError}.
   */
  resumeQueue(): Promise<void>;
  /** Validate and register schedules through the adapter's capability. */
  upsertSchedules(schedules: readonly ScheduleDefinition[]): Promise<void>;
  /** Read queue metrics through the producer's transport capability. */
  readCounts?(): Promise<QueueCounts>;
  /** List registered schedules through the adapter's capability. */
  listSchedules(): Promise<readonly ScheduleInfo[]>;
  /**
   * Pause (remove) the named schedules so they stop firing. Non-durable:
   * a later `work` start re-registers them. There is no `resumeSchedules`
   * runtime method — resuming is done by calling `upsertSchedules` again.
   */
  pauseSchedules(ids: readonly string[]): Promise<void>;
  /** Close the worker and producer (in that order). Idempotent. */
  close(): Promise<void>;
}

/**
 * Validate an adapter's shape — non-empty `name`, `createProducer`,
 * `createWorker`, and (when present) `upsertSchedules` — without invoking any
 * factory. Exported so config validation can reject a malformed custom adapter
 * before it ever reaches this controller; `createJobsRuntime` reuses the same
 * check so the two never disagree about the contract.
 */
export function validateJobsRuntimeAdapter(
  adapter: unknown,
): asserts adapter is JobsRuntimeAdapter {
  if (adapter === null || typeof adapter !== 'object') {
    throw new TypeError('createJobsRuntime requires a JobsRuntimeAdapter');
  }
  const name = (adapter as { name?: unknown }).name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('JobsRuntimeAdapter must declare a non-empty name');
  }
  if (typeof (adapter as { createProducer?: unknown }).createProducer !== 'function') {
    throw new TypeError('JobsRuntimeAdapter must declare a createProducer function');
  }
  if (typeof (adapter as { createWorker?: unknown }).createWorker !== 'function') {
    throw new TypeError('JobsRuntimeAdapter must declare a createWorker function');
  }
  const schedule = (adapter as { upsertSchedules?: unknown }).upsertSchedules;
  if (schedule !== undefined && typeof schedule !== 'function') {
    throw new TypeError('JobsRuntimeAdapter.upsertSchedules must be a function when present');
  }
  const listFn = (adapter as { listSchedules?: unknown }).listSchedules;
  if (listFn !== undefined && typeof listFn !== 'function') {
    throw new TypeError('JobsRuntimeAdapter.listSchedules must be a function when present');
  }
  const pauseFn = (adapter as { pauseSchedules?: unknown }).pauseSchedules;
  if (pauseFn !== undefined && typeof pauseFn !== 'function') {
    throw new TypeError('JobsRuntimeAdapter.pauseSchedules must be a function when present');
  }
}

function assertProducer(producer: unknown): asserts producer is RuntimeProducer {
  if (producer === null || typeof producer !== 'object') {
    throw new TypeError('JobsRuntimeAdapter.createProducer must resolve to a producer object');
  }
  if (typeof (producer as { dispatch?: unknown }).dispatch !== 'function') {
    throw new TypeError('runtime producer must declare a dispatch function');
  }
  if (typeof (producer as { close?: unknown }).close !== 'function') {
    throw new TypeError('runtime producer must declare a close function');
  }
}

function assertWorker(worker: unknown): asserts worker is RuntimeWorker {
  if (worker === null || typeof worker !== 'object') {
    throw new TypeError('JobsRuntimeAdapter.createWorker must resolve to a worker object');
  }
  if (typeof (worker as { close?: unknown }).close !== 'function') {
    throw new TypeError('runtime worker must declare a close function');
  }
}

function validateConcurrency(value: unknown): number {
  if (value === undefined) {
    return 1;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError('concurrency must be a positive integer');
  }
  return value;
}

/**
 * Validate that every middleware entry is a function, throwing eagerly so a
 * non-function is caught at construction time, not at process time.
 */
function validateMiddlewareMap(
  map: Readonly<Record<string, readonly JobMiddleware[]>> | undefined,
): Readonly<Record<string, readonly JobMiddleware[]>> | undefined {
  if (map === undefined) {
    return undefined;
  }
  for (const mws of Object.values(map)) {
    for (const mw of mws) {
      if (typeof mw !== 'function') {
        throw new JobMiddlewareError('invalid_middleware');
      }
    }
  }
  return map;
}

/**
 * Build the processor: reject an unknown job, validate the payload, then
 * compose any per-job middleware around the handler. Unknown-job rejection and
 * payload validation always run BEFORE middleware, so a bad payload never
 * reaches a middleware function.
 */
function makeProcessJob(
  registry: JobRegistry,
  dispatch: (name: string, payload: unknown, opts?: unknown) => Promise<unknown>,
  middleware: Readonly<Record<string, readonly JobMiddleware[]>> | undefined,
  signals: SignalBus | undefined,
): ProcessJob {
  return async (job) => {
    const definition = registry[job.name];
    if (definition === undefined) {
      throw new JobNotRegisteredError(job.name);
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

    const handleWithSignals = async (handlerData: unknown): Promise<void> => {
      try {
        await definition.handler(handlerData, context);
        if (signals) {
          signals.emit(jobCompleted, { name: job.name, jobId: job.id }).catch(() => {});
        }
      } catch (error) {
        if (signals) {
          signals
            .emit(jobFailed, { name: job.name, jobId: job.id, attemptsMade: job.attemptsMade })
            .catch(() => {});
          if (job.attemptsMade > 0) {
            signals
              .emit(jobRetried, { name: job.name, jobId: job.id, attemptsMade: job.attemptsMade })
              .catch(() => {});
          }
        }
        throw error;
      }
    };

    const jobMiddleware = middleware?.[job.name];
    if (jobMiddleware !== undefined && jobMiddleware.length > 0) {
      const mwContext: JobMiddlewareContext = {
        name: job.name,
        jobId: job.id,
        options: job.opts,
        dispatch: (name, payload, opts) => dispatch(name, payload, opts),
      };
      const composed = composeMiddleware(jobMiddleware, async (mwData, _mwCtx) => {
        await handleWithSignals(mwData);
      });
      return composed(data, mwContext);
    }

    return handleWithSignals(data);
  };
}

/**
 * Create a runtime controller. Nothing connects or starts until the first
 * `dispatch`/`startWorker`/`upsertSchedules` call; the adapter's handles are
 * created lazily and reused thereafter.
 */
export function createJobsRuntime(options: JobsRuntimeOptions): JobsRuntime {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createJobsRuntime requires an options object');
  }
  const { registry, adapter, middleware: middlewareMap, signals, pausedSchedules } = options;
  if (registry === null || typeof registry !== 'object') {
    throw new TypeError('createJobsRuntime requires a job registry');
  }
  validateJobsRuntimeAdapter(adapter);

  // Validate middleware eagerly so a non-function entry fails at construction
  // time, never at process time.
  const middleware = validateMiddlewareMap(middlewareMap);

  const context: JobAdapterContext = {
    queueName: options.queueName ?? DEFAULT_QUEUE_NAME,
    prefix: options.prefix ?? DEFAULT_PREFIX,
    concurrency: validateConcurrency(options.concurrency),
    registry,
  };

  let closed = false;
  let producerPromise: Promise<RuntimeProducer> | undefined;
  let workerPromise: Promise<RuntimeWorker> | undefined;
  let closePromise: Promise<void> | undefined;

  function assertOpen(): void {
    if (closed) {
      throw new JobsRuntimeClosedError();
    }
  }

  async function createProducerHandle(): Promise<RuntimeProducer> {
    const producer = await adapter.createProducer(context);
    assertProducer(producer);
    return producer;
  }

  async function createWorkerHandle(): Promise<RuntimeWorker> {
    const worker = await adapter.createWorker(context, processJob);
    assertWorker(worker);
    return worker;
  }

  function ensureProducer(): Promise<RuntimeProducer> {
    assertOpen();
    if (producerPromise === undefined) {
      const pending = createProducerHandle();
      producerPromise = pending;
      // A failed start must not wedge the runtime: clear the cache so a later
      // operation can retry. The adapter owns cleanup of partial resources.
      void pending.catch(() => {
        if (producerPromise === pending) {
          producerPromise = undefined;
        }
      });
    }
    return producerPromise;
  }

  // Define dispatch before processJob so makeProcessJob can capture the
  // runtime's dispatch for the middleware context.
  async function dispatch(name: string, payload: unknown, opts?: unknown): Promise<unknown> {
    assertOpen();
    const definition = registry[name];
    if (definition === undefined) {
      throw new JobNotRegisteredError(name);
    }
    const data = validatePayload(definition.schema, name, payload);
    const dispatchOptions: JobDispatchOptions = { ...validateJobOptions(opts) };
    const producer = await ensureProducer();
    assertOpen();
    const result = await producer.dispatch(name, data, dispatchOptions);
    if (signals) {
      signals.emit(jobPushed, { name, jobId: undefined }).catch(() => {});
    }
    return result;
  }

  const processJob = makeProcessJob(registry, dispatch, middleware, signals);

  async function startWorker(): Promise<void> {
    assertOpen();
    if (workerPromise === undefined) {
      const pending = createWorkerHandle();
      workerPromise = pending;
      void pending.catch(() => {
        if (workerPromise === pending) {
          workerPromise = undefined;
        }
      });
    }
    await workerPromise;
    assertOpen();
  }

  async function upsertSchedules(schedules: readonly ScheduleDefinition[]): Promise<void> {
    assertOpen();
    const schedule = adapter.upsertSchedules;
    if (schedule === undefined) {
      throw new JobsRuntimeError(`job adapter "${adapter.name}" does not support scheduling`);
    }

    // When a durable pause store is present, skip re-registering schedules
    // that are paused. Pause state is read per-id (up to one store call per
    // schedule) — the caller owns the schedule count (bounded by
    // MAX_SCHEDULES), so this is a bounded scan, not an unbounded fan-out.
    let toRegister: readonly ScheduleDefinition[] = schedules;
    if (pausedSchedules !== undefined) {
      const pausedIds = new Set<string>();
      for (const s of schedules) {
        if (await pausedSchedules.isPaused(s.id)) {
          pausedIds.add(s.id);
        }
      }
      if (pausedIds.size > 0) {
        toRegister = schedules.filter((s) => !pausedIds.has(s.id));
      }
    }

    // Validate the whole list before touching the provider.
    const prepared = prepareSchedules(registry, toRegister);
    const producer = await ensureProducer();
    assertOpen();
    await schedule.call(adapter, producer, prepared);
  }

  async function readCounts(): Promise<QueueCounts> {
    assertOpen();
    const producer = await ensureProducer();
    assertOpen();
    if (typeof producer.readCounts !== 'function') {
      throw new JobsRuntimeError(`job adapter "${adapter.name}" does not support queue metrics`);
    }
    return producer.readCounts();
  }

  async function pauseQueue(): Promise<void> {
    assertOpen();
    const producer = await ensureProducer();
    assertOpen();
    if (typeof producer.pause !== 'function') {
      throw new JobsRuntimeError(
        `job adapter "${adapter.name}" does not support pausing the queue`,
      );
    }
    await producer.pause();
  }

  async function resumeQueue(): Promise<void> {
    assertOpen();
    const producer = await ensureProducer();
    assertOpen();
    if (typeof producer.resume !== 'function') {
      throw new JobsRuntimeError(
        `job adapter "${adapter.name}" does not support resuming the queue`,
      );
    }
    await producer.resume();
  }

  async function listSchedules(): Promise<readonly ScheduleInfo[]> {
    assertOpen();
    const listFn = adapter.listSchedules;
    if (listFn === undefined) {
      throw new JobsRuntimeError(
        `job adapter "${adapter.name}" does not support listing schedules`,
      );
    }
    const producer = await ensureProducer();
    assertOpen();
    return listFn.call(adapter, producer);
  }

  async function pauseSchedules(ids: readonly string[]): Promise<void> {
    assertOpen();
    const pauseFn = adapter.pauseSchedules;
    if (pauseFn === undefined) {
      throw new JobsRuntimeError(
        `job adapter "${adapter.name}" does not support pausing schedules`,
      );
    }
    if (!Array.isArray(ids)) {
      throw new JobsRuntimeError('pauseSchedules ids must be an array of non-empty strings');
    }
    for (const id of ids) {
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw new JobsRuntimeError('pauseSchedules ids must be an array of non-empty strings');
      }
    }
    const producer = await ensureProducer();
    assertOpen();
    await pauseFn.call(adapter, producer, ids);

    // Persist paused state when a store is configured so a later `work` start
    // (which calls `upsertSchedules`) skips re-registration. A store error
    // propagates — the adapter already removed the schedule, so the caller
    // sees a partial outcome and can retry the store write.
    if (pausedSchedules !== undefined) {
      await pausedSchedules.setPaused(ids);
    }
  }

  async function close(): Promise<void> {
    if (closePromise !== undefined) {
      return closePromise;
    }
    closed = true;
    closePromise = performClose();
    return closePromise;
  }

  async function performClose(): Promise<void> {
    let firstError: unknown;
    const worker = await resolveHandle(workerPromise);
    if (worker !== undefined) {
      try {
        await worker.close();
      } catch (error) {
        firstError = error;
      }
    }
    const producer = await resolveHandle(producerPromise);
    if (producer !== undefined) {
      try {
        await producer.close();
      } catch (error) {
        if (firstError === undefined) {
          firstError = error;
        }
      }
    }
    if (firstError !== undefined) {
      throw firstError;
    }
  }

  return {
    dispatch,
    startWorker,
    pauseQueue,
    resumeQueue,
    upsertSchedules,
    readCounts,
    listSchedules,
    pauseSchedules,
    close,
  };
}

/**
 * Await a lazily created handle, swallowing a creation failure: a handle that
 * could not be created has nothing to close.
 */
async function resolveHandle<T>(promise: Promise<T> | undefined): Promise<T | undefined> {
  if (promise === undefined) {
    return undefined;
  }
  try {
    return await promise;
  } catch {
    return undefined;
  }
}
