/**
 * Built-in BullMQ job runtime adapter.
 *
 * Implements the provider-neutral {@link JobRuntimeAdapter} contract from
 * `./runtime.js` on top of BullMQ's `Queue` and `Worker`. This is the only
 * module that maps the neutral runtime onto BullMQ; the neutral controller
 * performs all job-level policy (payload validation on both sides, dispatch
 * option allowlisting, schedule preparation) and this adapter owns the
 * transport semantics only.
 *
 * Lazy construction: `createBullMQAdapter` validates its options and returns an
 * adapter, but builds no `Queue`/`Worker` and opens no Redis connection. The
 * native handles are constructed inside `createProducer`/`createWorker`, which
 * the runtime calls on first use. Importing this module never connects.
 *
 * Connections are owned by BullMQ: each `Queue`/`Worker` is given
 * `buildConnectionOptions` (producer: finite retries; worker:
 * `maxRetriesPerRequest: null`) and closes its own Redis client on `close()`.
 * Every handle's `close()` is idempotent, and a constructor/error-listener
 * failure never leaks a half-built handle.
 *
 * Scheduling reuses the neutral `PreparedSchedule[]` (already validated by the
 * runtime) and maps it directly to `Queue.upsertJobScheduler`; the native queue
 * is recovered from a `WeakMap` keyed by the producer handle this adapter
 * created, so no queue engine is cloned.
 */

import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions, JobsOptions, QueueOptions, WorkerOptions } from 'bullmq';

import {
  attachErrorHandler,
  buildConnectionOptions,
  defaultErrorLogger,
  type JobErrorHandler,
} from './connection.js';
import { defaultJobOptions, type JobQueue, type QueueFactory } from './queue.js';
import type { JobWorker, PreparedSchedule, WorkerFactory, WorkerJob } from './scheduler.js';
import type {
  JobAdapterContext,
  JobRuntimeAdapter,
  ProcessJob,
  RuntimeProducer,
  RuntimeWorker,
} from './runtime.js';

/** Options accepted by {@link createBullMQAdapter}. */
export interface CreateBullMQAdapterOptions {
  /** Redis connection URL (e.g. `redis://127.0.0.1:6379`). */
  readonly redisUrl: string;
  /** Optional error callback; when absent, errors are logged payload-free. */
  readonly onError?: JobErrorHandler;
  /** Test seam: override the `Queue` construction. */
  readonly queueFactory?: QueueFactory;
  /** Test seam: override the `Worker` construction. */
  readonly workerFactory?: WorkerFactory;
}

/** Build a real BullMQ `Queue`. Reached only from `createProducer`. */
const defaultQueueFactory: QueueFactory = (name, opts) => new Queue(name, opts);

/** Build a real BullMQ `Worker`. Reached only from `createWorker`. */
const defaultWorkerFactory: WorkerFactory = (name, processor, opts) =>
  new Worker(name, processor, opts);

/**
 * Validate a connection URL is an explicit `redis://` or `rediss://` URL. The
 * value is never included in the error message: a URL may embed a password.
 * Kept local (rather than importing `runtime-config`) so the future central
 * runtime can import this factory without a cycle.
 */
function assertRedisUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(
      'the Valkey/Redis connection URL must be a non-empty redis:// or rediss:// URL',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(
      'the Valkey/Redis connection URL must be a valid redis:// or rediss:// URL',
    );
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new TypeError(
      'the Valkey/Redis connection URL must use the redis:// or rediss:// scheme',
    );
  }
  return value;
}

interface ResolvedAdapterOptions {
  readonly redisUrl: string;
  readonly onError: JobErrorHandler | undefined;
  readonly queueFactory: QueueFactory | undefined;
  readonly workerFactory: WorkerFactory | undefined;
}

function resolveOptions(options: CreateBullMQAdapterOptions): ResolvedAdapterOptions {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createBullMQAdapter requires an options object');
  }
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new TypeError('onError must be a function');
  }
  if (options.queueFactory !== undefined && typeof options.queueFactory !== 'function') {
    throw new TypeError('queueFactory must be a function');
  }
  if (options.workerFactory !== undefined && typeof options.workerFactory !== 'function') {
    throw new TypeError('workerFactory must be a function');
  }
  return {
    redisUrl: assertRedisUrl(options.redisUrl),
    onError: options.onError,
    queueFactory: options.queueFactory,
    workerFactory: options.workerFactory,
  };
}

/**
 * Create the built-in BullMQ {@link JobRuntimeAdapter}. Options are validated
 * synchronously (a bad URL fails fast) and nothing connects until the runtime
 * creates a producer or worker handle.
 */
export function createBullMQAdapter(options: CreateBullMQAdapterOptions): JobRuntimeAdapter {
  const opts = resolveOptions(options);
  // Recovers the native queue for a producer handle without exposing BullMQ
  // types through the neutral contract. Scoped per adapter instance.
  const producerQueues = new WeakMap<RuntimeProducer, JobQueue>();

  function makeQueue(context: JobAdapterContext): JobQueue {
    const queue = (opts.queueFactory ?? defaultQueueFactory)(context.queueName, {
      connection: buildConnectionOptions(opts.redisUrl, 'producer'),
      prefix: context.prefix,
      // A web-facing producer fails fast instead of blocking on readiness.
      skipWaitingForReady: true,
      defaultJobOptions: defaultJobOptions(),
    } satisfies QueueOptions<ConnectionOptions>);
    try {
      attachErrorHandler(queue, opts.onError, defaultErrorLogger('queue', context.queueName));
    } catch (error) {
      // A partially built queue must not leak its owned connection.
      void queue.close().catch(() => {});
      throw error;
    }
    return queue;
  }

  function makeWorker(context: JobAdapterContext, processJob: ProcessJob): JobWorker {
    const processor = (job: WorkerJob): Promise<unknown> => processJob(job);
    const worker = (opts.workerFactory ?? defaultWorkerFactory)(context.queueName, processor, {
      connection: buildConnectionOptions(opts.redisUrl, 'worker'),
      prefix: context.prefix,
      concurrency: context.concurrency,
    } satisfies WorkerOptions<ConnectionOptions>);
    try {
      attachErrorHandler(worker, opts.onError, defaultErrorLogger('worker', context.queueName));
    } catch (error) {
      void worker.close().catch(() => {});
      throw error;
    }
    return worker;
  }

  return {
    name: 'bullmq',

    createProducer(context): RuntimeProducer {
      const queue = makeQueue(context);
      let closed = false;
      const producer: RuntimeProducer = {
        dispatch(name, data, dispatchOptions) {
          return queue.add(name, data, {
            ...defaultJobOptions(),
            ...(dispatchOptions as JobsOptions),
          });
        },
        async close() {
          if (closed) {
            return;
          }
          closed = true;
          await queue.close();
        },
      };
      producerQueues.set(producer, queue);
      return producer;
    },

    createWorker(context, processJob): RuntimeWorker {
      const worker = makeWorker(context, processJob);
      let closed = false;
      return {
        async close(force) {
          if (closed) {
            return;
          }
          closed = true;
          // BullMQ closes the worker's owned Redis connection here, after
          // draining (or, with `force`, skipping) in-flight jobs.
          await worker.close(force);
        },
      };
    },

    async upsertSchedules(producer, schedules: readonly PreparedSchedule[]): Promise<void> {
      const queue = producerQueues.get(producer);
      if (queue === undefined) {
        throw new TypeError(
          'bullmq adapter: scheduling requires a producer created by this adapter',
        );
      }
      for (const entry of schedules) {
        await queue.upsertJobScheduler(entry.id, entry.repeat, {
          name: entry.job,
          data: entry.data,
        });
      }
    },
  };
}
