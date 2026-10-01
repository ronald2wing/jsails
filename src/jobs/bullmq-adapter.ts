/**
 * Built-in BullMQ job runtime adapter.
 *
 * Implements the provider-neutral {@link JobsRuntimeAdapter} contract from
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
import type {
  ConnectionOptions,
  JobSchedulerJson,
  JobsOptions,
  JobSchedulerTemplateOptions,
  QueueOptions,
  WorkerOptions,
} from 'bullmq';

import { createCleanup } from '../internal/cleanup.js';
import {
  attachErrorHandler,
  buildConnectionOptions,
  defaultErrorLogger,
  type JobErrorHandler,
} from './connection.js';
import { defaultJobOptions, type JobQueue, type QueueFactory } from './queue.js';
import { OVERLAP_OPTION_KEY } from './overlap.js';
import {
  isOverlapDescriptor,
  type JobWorker,
  type PreparedSchedule,
  type WorkerFactory,
  type WorkerJob,
} from './scheduler.js';
import type {
  JobAdapterContext,
  JobsRuntimeAdapter,
  ProcessJob,
  QueueCounts,
  RuntimeProducer,
  RuntimeWorker,
  ScheduleInfo,
} from './runtime.js';

/** Options accepted by {@link createBullMQAdapter}. */
export interface BullMQAdapterOptions {
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

function resolveOptions(options: BullMQAdapterOptions): ResolvedAdapterOptions {
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
 * Create the built-in BullMQ {@link JobsRuntimeAdapter}. Options are validated
 * synchronously (a bad URL fails fast) and nothing connects until the runtime
 * creates a producer or worker handle.
 */
export function createBullMQAdapter(options: BullMQAdapterOptions): JobsRuntimeAdapter {
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
      const closeOnce = createCleanup(() => queue.close());
      const producer: RuntimeProducer = {
        dispatch(name, data, dispatchOptions) {
          return queue.add(name, data, {
            ...defaultJobOptions(),
            ...(dispatchOptions as JobsOptions),
          });
        },
        async readCounts(): Promise<QueueCounts> {
          if (typeof queue.getJobCounts !== 'function') {
            throw new TypeError('bullmq adapter: the queue does not support job counts');
          }
          const counts = await queue.getJobCounts(
            'waiting',
            'active',
            'completed',
            'failed',
            'delayed',
          );
          return {
            waiting: counts['waiting'] ?? 0,
            active: counts['active'] ?? 0,
            completed: counts['completed'] ?? 0,
            failed: counts['failed'] ?? 0,
            delayed: counts['delayed'] ?? 0,
          };
        },
        async pause(): Promise<void> {
          if (typeof queue.pause !== 'function') {
            throw new TypeError('bullmq adapter: the queue does not support pause');
          }
          await queue.pause();
        },
        async resume(): Promise<void> {
          if (typeof queue.resume !== 'function') {
            throw new TypeError('bullmq adapter: the queue does not support resume');
          }
          await queue.resume();
        },
        async close() {
          await closeOnce();
        },
      };
      producerQueues.set(producer, queue);
      return producer;
    },

    createWorker(context, processJob): RuntimeWorker {
      const worker = makeWorker(context, processJob);
      // BullMQ closes the worker's owned Redis connection here, after draining
      // (or, with `force`, skipping) in-flight jobs. The first `force` value
      // wins; a later close joins the same teardown.
      let forceClose = false;
      const closeOnce = createCleanup(() => worker.close(forceClose));
      return {
        async close(force) {
          forceClose = force === true;
          await closeOnce();
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
        // The overlap descriptor rides in the scheduled job's `opts` so it
        // reaches the worker via `job.opts` → `JobMiddlewareContext.options`,
        // exactly like the chain/batch descriptors. BullMQ stores `opts`
        // verbatim on the job template, so the reserved key survives. The cast
        // is required because `JobSchedulerTemplateOptions` has no index
        // signature for framework-reserved keys.
        const opts =
          entry.overlap === undefined
            ? undefined
            : ({ [OVERLAP_OPTION_KEY]: entry.overlap } as JobSchedulerTemplateOptions);
        await queue.upsertJobScheduler(entry.id, entry.repeat, {
          name: entry.job,
          data: entry.data,
          opts,
        });
      }
    },

    async listSchedules(producer): Promise<readonly ScheduleInfo[]> {
      const queue = producerQueues.get(producer);
      if (queue === undefined) {
        throw new TypeError(
          'bullmq adapter: listing schedules requires a producer created by this adapter',
        );
      }
      if (typeof queue.getJobSchedulers !== 'function') {
        throw new TypeError('bullmq adapter: the queue does not support listing schedules');
      }
      const raw = await queue.getJobSchedulers();
      return raw.map((entry: JobSchedulerJson): ScheduleInfo => {
        const id = entry.id ?? entry.key;
        const job = entry.name;
        const repeat =
          entry.pattern !== undefined
            ? entry.pattern
            : entry.every !== undefined
              ? `every ${entry.every}ms`
              : 'unknown';
        // Include nextRunAt only when `next` is a finite number, so the
        // field is absent rather than set to `undefined` for unknown times.
        const nextFinite =
          typeof entry.next === 'number' && Number.isFinite(entry.next) ? entry.next : undefined;
        // Only surface the overlap descriptor when the raw opts carry a valid
        // one; a malformed/absent key is silently omitted (the scheduler
        // stored it, so corruption means the store was tampered with — but the
        // caller should not see it).
        const rawOverlap = (entry.template?.opts as Record<string, unknown> | undefined)?.[
          OVERLAP_OPTION_KEY
        ];
        const overlap = isOverlapDescriptor(rawOverlap) ? rawOverlap : undefined;
        const result: ScheduleInfo = { id, job, repeat };
        if (nextFinite !== undefined) {
          (result as unknown as Record<string, unknown>).nextRunAt = nextFinite;
        }
        if (overlap !== undefined) {
          (result as unknown as Record<string, unknown>).overlap = overlap;
        }
        return result;
      });
    },

    async pauseSchedules(producer, ids): Promise<void> {
      const queue = producerQueues.get(producer);
      if (queue === undefined) {
        throw new TypeError(
          'bullmq adapter: pausing schedules requires a producer created by this adapter',
        );
      }
      if (typeof queue.removeJobScheduler !== 'function') {
        throw new TypeError('bullmq adapter: the queue does not support pausing schedules');
      }
      // Removal is idempotent — BullMQ returns `false` for an unknown id.
      // A later `work` start re-registers the schedules via `upsertSchedules`,
      // so pausing is non-durable.
      for (const id of ids) {
        await queue.removeJobScheduler(id);
      }
    },
  };
}
