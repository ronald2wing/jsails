/**
 * Provider-neutral job runtime controller.
 *
 * `createJobsRuntime` binds a {@link JobRegistry} to a {@link JobRuntimeAdapter}
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
import { validateJobOptions } from './queue.js';
import { JobUnknownError, validatePayload, type JobContext, type JobRegistry } from './registry.js';
import { prepareSchedules, type PreparedSchedule, type ScheduleSpec } from './scheduler.js';

/** A value, or a promise of that value. */
export type MaybePromise<T> = T | Promise<T>;

/** Validated options handed to a provider's `dispatch`. */
export type JobDispatchOptions = Record<string, unknown>;

/** Neutral context describing the queue a runtime adapter binds to. */
export interface JobAdapterContext {
  readonly queueName: string;
  readonly prefix: string;
  readonly concurrency: number;
  readonly registry: JobRegistry;
}

/** The producer surface a runtime adapter must provide. */
export interface RuntimeProducer {
  /** Enqueue a payload already validated by the controller. */
  dispatch(name: string, data: unknown, options: JobDispatchOptions): Promise<unknown>;
  /** Close the producer and its owned resources. Idempotent. */
  close(): Promise<void>;
}

/** A received job as seen by the neutral processor. */
export interface RuntimeJob {
  readonly name: string;
  readonly id?: string;
  readonly data: unknown;
  readonly attemptsMade: number;
  readonly attemptsStarted: number;
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
 * The pluggable adapter contract. `createProducer`/`createWorker` are lazy:
 * the controller calls them only on first use. An adapter that throws from
 * either call owns the cleanup of whatever it partially created.
 */
export interface JobRuntimeAdapter {
  /** Diagnostic label, never used for identity or routing. */
  readonly name: string;
  createProducer(context: JobAdapterContext): MaybePromise<RuntimeProducer>;
  createWorker(context: JobAdapterContext, processJob: ProcessJob): MaybePromise<RuntimeWorker>;
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
}

/** Raised for an invalid adapter or a runtime-level misuse. */
export class JobRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobRuntimeError';
  }
}

/** Raised when an operation is attempted after {@link JobsRuntime.close}. */
export class JobRuntimeClosedError extends JobRuntimeError {
  constructor() {
    super('the job runtime is closed');
    this.name = 'JobRuntimeClosedError';
  }
}

/** Options accepted by {@link createJobsRuntime}. */
export interface CreateJobsRuntimeOptions {
  /** The registry naming the jobs this runtime may dispatch and process. */
  readonly registry: JobRegistry;
  /** The transport adapter. */
  readonly adapter: JobRuntimeAdapter;
  /** Queue name. Defaults to `"default"`. */
  readonly queueName?: string;
  /** Key prefix. Defaults to `"bull"`. */
  readonly prefix?: string;
  /** Worker concurrency. Defaults to 1. */
  readonly concurrency?: number;
}

/** The controller returned by {@link createJobsRuntime}. */
export interface JobsRuntime {
  /** Validate and enqueue a job. The result is the provider's own value. */
  dispatch(name: string, payload: unknown, opts?: unknown): Promise<unknown>;
  /** Lazily create the worker and begin processing. */
  startWorker(): Promise<void>;
  /** Validate and register schedules through the adapter's capability. */
  upsertSchedules(schedules: readonly ScheduleSpec[]): Promise<void>;
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
export function validateJobRuntimeAdapter(adapter: unknown): asserts adapter is JobRuntimeAdapter {
  if (adapter === null || typeof adapter !== 'object') {
    throw new TypeError('createJobsRuntime requires a JobRuntimeAdapter');
  }
  const name = (adapter as { name?: unknown }).name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('JobRuntimeAdapter must declare a non-empty name');
  }
  if (typeof (adapter as { createProducer?: unknown }).createProducer !== 'function') {
    throw new TypeError('JobRuntimeAdapter must declare a createProducer function');
  }
  if (typeof (adapter as { createWorker?: unknown }).createWorker !== 'function') {
    throw new TypeError('JobRuntimeAdapter must declare a createWorker function');
  }
  const schedule = (adapter as { upsertSchedules?: unknown }).upsertSchedules;
  if (schedule !== undefined && typeof schedule !== 'function') {
    throw new TypeError('JobRuntimeAdapter.upsertSchedules must be a function when present');
  }
}

function assertProducer(producer: unknown): asserts producer is RuntimeProducer {
  if (producer === null || typeof producer !== 'object') {
    throw new TypeError('JobRuntimeAdapter.createProducer must resolve to a producer object');
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
    throw new TypeError('JobRuntimeAdapter.createWorker must resolve to a worker object');
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

/** Build the processor: reject an unknown job, validate the payload, invoke. */
function makeProcessJob(registry: JobRegistry): ProcessJob {
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

/**
 * Create a runtime controller. Nothing connects or starts until the first
 * `dispatch`/`startWorker`/`upsertSchedules` call; the adapter's handles are
 * created lazily and reused thereafter.
 */
export function createJobsRuntime(options: CreateJobsRuntimeOptions): JobsRuntime {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createJobsRuntime requires an options object');
  }
  const { registry, adapter } = options;
  if (registry === null || typeof registry !== 'object') {
    throw new TypeError('createJobsRuntime requires a job registry');
  }
  validateJobRuntimeAdapter(adapter);

  const context: JobAdapterContext = {
    queueName: options.queueName ?? DEFAULT_QUEUE_NAME,
    prefix: options.prefix ?? DEFAULT_PREFIX,
    concurrency: validateConcurrency(options.concurrency),
    registry,
  };
  const processJob = makeProcessJob(registry);

  let closed = false;
  let producerPromise: Promise<RuntimeProducer> | undefined;
  let workerPromise: Promise<RuntimeWorker> | undefined;
  let closePromise: Promise<void> | undefined;

  function assertOpen(): void {
    if (closed) {
      throw new JobRuntimeClosedError();
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

  async function dispatch(name: string, payload: unknown, opts?: unknown): Promise<unknown> {
    assertOpen();
    const definition = registry[name];
    if (definition === undefined) {
      throw new JobUnknownError(name);
    }
    const data = validatePayload(definition.schema, name, payload);
    const dispatchOptions: JobDispatchOptions = { ...validateJobOptions(opts) };
    const producer = await ensureProducer();
    assertOpen();
    return producer.dispatch(name, data, dispatchOptions);
  }

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

  async function upsertSchedules(schedules: readonly ScheduleSpec[]): Promise<void> {
    assertOpen();
    const schedule = adapter.upsertSchedules;
    if (schedule === undefined) {
      throw new JobRuntimeError(`job adapter "${adapter.name}" does not support scheduling`);
    }
    // Validate the whole list before touching the provider.
    const prepared = prepareSchedules(registry, schedules);
    const producer = await ensureProducer();
    assertOpen();
    await schedule.call(adapter, producer, prepared);
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

  return { dispatch, startWorker, upsertSchedules, close };
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
