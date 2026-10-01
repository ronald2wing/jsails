/**
 * Provider-neutral job runtime controller.
 *
 * {@link JobsRuntimeImpl} binds a {@link JobRegistry} to a {@link JobsRuntimeAdapter}
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
 * all: `JobsRuntimeImpl` never receives one.
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
import { type Awaitable } from '../internal/awaitable.js';
import type { ServiceRegistry } from '../extensions/services.js';
import { withAppScope } from '../facades/app-scope.js';

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

/** Options accepted by {@link JobsRuntimeImpl}. */
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
  /**
   * Ambient service registry borrowed from a CLI-level `runExtensions()` call.
   * When present, every job execution (handler + per-job middleware) runs inside
   * `withAppScope(serviceRegistry, ...)` so `facade()` calls resolve.
   * `undefined` (the default) leaves behaviour byte-identical to today: no
   * scope is opened, and a `facade()` call throws `FacadeError('no_app_scope')`.
   *
   * The runtime never closes or clears the registry — it is borrowed from the
   * CLI layer, which owns its lifecycle.
   */
  readonly serviceRegistry?: ServiceRegistry;
}

/** The controller returned by {@link JobsRuntimeImpl}. */
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
 * before it ever reaches this controller; {@link JobsRuntimeImpl} reuses the same
 * check so the two never disagree about the contract.
 */
export function validateJobsRuntimeAdapter(
  adapter: unknown,
): asserts adapter is JobsRuntimeAdapter {
  if (adapter === null || typeof adapter !== 'object') {
    throw new TypeError('JobsRuntimeImpl requires a JobsRuntimeAdapter');
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
  serviceRegistry: ServiceRegistry | undefined,
): ProcessJob {
  const inner: ProcessJob = async (job) => {
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
        // Per-job error policy (the `retry_on`/`discard_on` analog). Evaluated
        // before the transport-level retry: `discardOn` swallows the throw as a
        // successful completion; `retryOn` returning false skips the retry
        // signal (the error still rethrows to the transport, which applies its
        // own attempt/backoff policy).
        const policy = definition.policy;
        if (policy?.discardOn !== undefined && policy.discardOn(error, context)) {
          if (signals) {
            signals.emit(jobCompleted, { name: job.name, jobId: job.id }).catch(() => {});
          }
          return;
        }
        if (signals) {
          signals
            .emit(jobFailed, { name: job.name, jobId: job.id, attemptsMade: job.attemptsMade })
            .catch(() => {});
          const retryEligible = policy?.retryOn === undefined || policy.retryOn(error, context);
          if (job.attemptsMade > 0 && retryEligible) {
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

  // When a service registry is supplied, wrap every job execution (handler +
  // middleware) in the ambient app scope so `facade()` calls resolve. The
  // registry is borrowed — the runtime never closes or clears it.
  return serviceRegistry === undefined
    ? inner
    : (job: RuntimeJob) => withAppScope(serviceRegistry, () => inner(job));
}

/**
 * Provider-neutral jobs runtime. Nothing connects or starts until the first
 * `dispatch`/`startWorker`/`upsertSchedules` call; the adapter's handles are
 * created lazily and reused thereafter.
 */
export class JobsRuntimeImpl implements JobsRuntime {
  readonly #registry: JobRegistry;
  readonly #adapter: JobsRuntimeAdapter;
  readonly #middleware: Readonly<Record<string, readonly JobMiddleware[]>> | undefined;
  readonly #signals: SignalBus | undefined;
  readonly #pausedSchedules: PausedScheduleStore | undefined;
  readonly #serviceRegistry: ServiceRegistry | undefined;
  readonly #context: JobAdapterContext;
  #closed = false;
  #producerPromise: Promise<RuntimeProducer> | undefined;
  #workerPromise: Promise<RuntimeWorker> | undefined;
  #closePromise: Promise<void> | undefined;
  readonly #processJob: ProcessJob;

  constructor(options: JobsRuntimeOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('JobsRuntimeImpl requires an options object');
    }
    const {
      registry,
      adapter,
      middleware: middlewareMap,
      signals,
      pausedSchedules,
      serviceRegistry,
    } = options;
    if (registry === null || typeof registry !== 'object') {
      throw new TypeError('JobsRuntimeImpl requires a job registry');
    }
    validateJobsRuntimeAdapter(adapter);

    this.#registry = registry;
    this.#adapter = adapter;
    this.#middleware = validateMiddlewareMap(middlewareMap);
    this.#signals = signals;
    this.#pausedSchedules = pausedSchedules;
    this.#serviceRegistry = serviceRegistry;

    this.#context = {
      queueName: options.queueName ?? DEFAULT_QUEUE_NAME,
      prefix: options.prefix ?? DEFAULT_PREFIX,
      concurrency: validateConcurrency(options.concurrency),
      registry,
    };

    this.#processJob = makeProcessJob(
      registry,
      (name, payload, opts) => this.#dispatch(name, payload, opts),
      this.#middleware,
      signals,
      this.#serviceRegistry,
    );
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new JobsRuntimeClosedError();
    }
  }

  async #createProducerHandle(): Promise<RuntimeProducer> {
    const producer = await this.#adapter.createProducer(this.#context);
    assertProducer(producer);
    return producer;
  }

  async #createWorkerHandle(): Promise<RuntimeWorker> {
    const worker = await this.#adapter.createWorker(this.#context, this.#processJob);
    assertWorker(worker);
    return worker;
  }

  #ensureProducer(): Promise<RuntimeProducer> {
    this.#assertOpen();
    if (this.#producerPromise === undefined) {
      const pending = this.#createProducerHandle();
      this.#producerPromise = pending;
      // A failed start must not wedge the runtime: clear the cache so a later
      // operation can retry. The adapter owns cleanup of partial resources.
      void pending.catch(() => {
        if (this.#producerPromise === pending) {
          this.#producerPromise = undefined;
        }
      });
    }
    return this.#producerPromise;
  }

  async #dispatch(name: string, payload: unknown, opts?: unknown): Promise<unknown> {
    this.#assertOpen();
    const definition = this.#registry[name];
    if (definition === undefined) {
      throw new JobNotRegisteredError(name);
    }
    const data = validatePayload(definition.schema, name, payload);
    const dispatchOptions: JobDispatchOptions = { ...validateJobOptions(opts) };
    const producer = await this.#ensureProducer();
    this.#assertOpen();
    const result = await producer.dispatch(name, data, dispatchOptions);
    if (this.#signals) {
      this.#signals.emit(jobPushed, { name, jobId: undefined }).catch(() => {});
    }
    return result;
  }

  async startWorker(): Promise<void> {
    this.#assertOpen();
    if (this.#workerPromise === undefined) {
      const pending = this.#createWorkerHandle();
      this.#workerPromise = pending;
      void pending.catch(() => {
        if (this.#workerPromise === pending) {
          this.#workerPromise = undefined;
        }
      });
    }
    await this.#workerPromise;
    this.#assertOpen();
  }

  async upsertSchedules(schedules: readonly ScheduleDefinition[]): Promise<void> {
    this.#assertOpen();
    const schedule = this.#adapter.upsertSchedules;
    if (schedule === undefined) {
      throw new JobsRuntimeError(`job adapter "${this.#adapter.name}" does not support scheduling`);
    }

    // When a durable pause store is present, skip re-registering schedules
    // that are paused. Pause state is read per-id (up to one store call per
    // schedule) — the caller owns the schedule count (bounded by
    // MAX_SCHEDULES), so this is a bounded scan, not an unbounded fan-out.
    let toRegister: readonly ScheduleDefinition[] = schedules;
    if (this.#pausedSchedules !== undefined) {
      const pausedIds = new Set<string>();
      for (const s of schedules) {
        if (await this.#pausedSchedules.isPaused(s.id)) {
          pausedIds.add(s.id);
        }
      }
      if (pausedIds.size > 0) {
        toRegister = schedules.filter((s) => !pausedIds.has(s.id));
      }
    }

    // Validate the whole list before touching the provider.
    const prepared = prepareSchedules(this.#registry, toRegister);
    const producer = await this.#ensureProducer();
    this.#assertOpen();
    await schedule.call(this.#adapter, producer, prepared);
  }

  async readCounts(): Promise<QueueCounts> {
    this.#assertOpen();
    const producer = await this.#ensureProducer();
    this.#assertOpen();
    if (typeof producer.readCounts !== 'function') {
      throw new JobsRuntimeError(
        `job adapter "${this.#adapter.name}" does not support queue metrics`,
      );
    }
    return producer.readCounts();
  }

  async pauseQueue(): Promise<void> {
    this.#assertOpen();
    const producer = await this.#ensureProducer();
    this.#assertOpen();
    if (typeof producer.pause !== 'function') {
      throw new JobsRuntimeError(
        `job adapter "${this.#adapter.name}" does not support pausing the queue`,
      );
    }
    await producer.pause();
  }

  async resumeQueue(): Promise<void> {
    this.#assertOpen();
    const producer = await this.#ensureProducer();
    this.#assertOpen();
    if (typeof producer.resume !== 'function') {
      throw new JobsRuntimeError(
        `job adapter "${this.#adapter.name}" does not support resuming the queue`,
      );
    }
    await producer.resume();
  }

  async listSchedules(): Promise<readonly ScheduleInfo[]> {
    this.#assertOpen();
    const listFn = this.#adapter.listSchedules;
    if (listFn === undefined) {
      throw new JobsRuntimeError(
        `job adapter "${this.#adapter.name}" does not support listing schedules`,
      );
    }
    const producer = await this.#ensureProducer();
    this.#assertOpen();
    return listFn.call(this.#adapter, producer);
  }

  async pauseSchedules(ids: readonly string[]): Promise<void> {
    this.#assertOpen();
    const pauseFn = this.#adapter.pauseSchedules;
    if (pauseFn === undefined) {
      throw new JobsRuntimeError(
        `job adapter "${this.#adapter.name}" does not support pausing schedules`,
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
    const producer = await this.#ensureProducer();
    this.#assertOpen();
    await pauseFn.call(this.#adapter, producer, ids);

    // Persist paused state when a store is configured so a later `work` start
    // (which calls `upsertSchedules`) skips re-registration. A store error
    // propagates — the adapter already removed the schedule, so the caller
    // sees a partial outcome and can retry the store write.
    if (this.#pausedSchedules !== undefined) {
      await this.#pausedSchedules.setPaused(ids);
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    this.#closed = true;
    this.#closePromise = this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    let firstError: unknown;
    const worker = await resolveHandle(this.#workerPromise);
    if (worker !== undefined) {
      try {
        await worker.close();
      } catch (error) {
        firstError = error;
      }
    }
    const producer = await resolveHandle(this.#producerPromise);
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

  /** Public accessor for dispatch, used by createJobChain / middleware contexts. */
  dispatch(name: string, payload: unknown, opts?: unknown): Promise<unknown> {
    return this.#dispatch(name, payload, opts);
  }
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
