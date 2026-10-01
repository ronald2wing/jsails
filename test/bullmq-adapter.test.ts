/**
 * Tests for the built-in BullMQ job runtime adapter: option/URL validation,
 * lazy Queue/Worker construction, connection and job-default shaping, the
 * neutral processor path (payload validation + handler), schedule mapping,
 * close ordering/idempotence, error routing, and constructor-failure cleanup.
 * Every case injects fake `queueFactory`/`workerFactory` instances, so no
 * Redis/Valkey connection is opened and no live server is required.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import type {
  ConnectionOptions,
  JobsOptions,
  QueueOptions,
  RepeatOptions,
  WorkerOptions,
} from 'bullmq';

import { createBullMQAdapter } from '../src/jobs/bullmq-adapter.js';
import type { JobQueue, QueueFactory } from '../src/jobs/queue.js';
import {
  createRegistry,
  defineJob,
  JobPayloadError,
  JobUnknownError,
} from '../src/jobs/registry.js';
import { createJobsRuntime, type RuntimeProducer } from '../src/jobs/runtime.js';
import type { JobWorker, WorkerFactory, WorkerJob } from '../src/jobs/scheduler.js';

const REDIS_URL = 'redis://127.0.0.1:6379';

interface RecordedAdd {
  name: string;
  data: unknown;
  opts: JobsOptions | undefined;
}

interface RecordedSchedule {
  id: string;
  repeat: Omit<RepeatOptions, 'key'>;
  template: { name?: string; data?: unknown } | undefined;
}

interface FakeQueue extends JobQueue {
  name: string;
  opts: QueueOptions<ConnectionOptions>;
  adds: RecordedAdd[];
  schedulers: RecordedSchedule[];
  closes: number;
  errorListeners: Array<(error: Error) => void>;
  failErrorListener: boolean;
}

interface FakeWorker extends JobWorker {
  name: string;
  opts: WorkerOptions<ConnectionOptions>;
  processor: (job: WorkerJob) => Promise<unknown>;
  closes: number;
  closeForces: Array<boolean | undefined>;
  errorListeners: Array<(error: Error) => void>;
  failErrorListener: boolean;
}

interface Fakes {
  queueFactory: QueueFactory;
  workerFactory: WorkerFactory;
  queues: FakeQueue[];
  workers: FakeWorker[];
}

function makeFakes(
  options: { failQueueListener?: boolean; failWorkerListener?: boolean } = {},
): Fakes {
  const queues: FakeQueue[] = [];
  const workers: FakeWorker[] = [];

  const queueFactory: QueueFactory = (name, opts) => {
    const queue: FakeQueue = {
      name,
      opts,
      adds: [],
      schedulers: [],
      closes: 0,
      errorListeners: [],
      failErrorListener: options.failQueueListener ?? false,
      add(addName, data, addOpts) {
        queue.adds.push({ name: addName, data, opts: addOpts });
        return Promise.resolve({ id: 'queued' });
      },
      close() {
        queue.closes += 1;
        return Promise.resolve();
      },
      on(eventName, listener) {
        if (eventName === 'error') {
          if (queue.failErrorListener) {
            throw new Error('queue error listener failed');
          }
          queue.errorListeners.push(listener);
        }
        return queue;
      },
      upsertJobScheduler(id, repeat, template) {
        queue.schedulers.push({ id, repeat, template });
        return Promise.resolve({ id });
      },
    };
    queues.push(queue);
    return queue;
  };

  const workerFactory: WorkerFactory = (name, processor, opts) => {
    const worker: FakeWorker = {
      name,
      opts,
      processor,
      closes: 0,
      closeForces: [],
      errorListeners: [],
      failErrorListener: options.failWorkerListener ?? false,
      close(force) {
        worker.closes += 1;
        worker.closeForces.push(force);
        return Promise.resolve();
      },
      on(eventName, listener) {
        if (eventName === 'error') {
          if (worker.failErrorListener) {
            throw new Error('worker error listener failed');
          }
          worker.errorListeners.push(listener);
        }
        return worker;
      },
    };
    workers.push(worker);
    return worker;
  };

  return { queueFactory, workerFactory, queues, workers };
}

interface RecordedCall {
  data: unknown;
  jobId: string | undefined;
  name: string;
}

function recordingRegistry(): {
  registry: ReturnType<typeof createRegistry>;
  handled: RecordedCall[];
} {
  const handled: RecordedCall[] = [];
  const sendEmail = defineJob(
    z.object({ to: z.string(), subject: z.string() }),
    async (data, context) => {
      handled.push({ data, jobId: context.jobId, name: context.name });
    },
  );
  return { registry: createRegistry({ sendEmail }), handled };
}

function workerJob(overrides: Partial<WorkerJob> = {}): WorkerJob {
  return {
    name: 'sendEmail',
    id: 'job-1',
    data: { to: 'a@b.co', subject: 'hi' },
    attemptsMade: 0,
    attemptsStarted: 1,
    log: async () => undefined,
    updateProgress: async () => undefined,
    ...overrides,
  };
}

describe('bullmq job runtime adapter', () => {
  it('validates options and never constructs a queue or worker', () => {
    const adapter = createBullMQAdapter({ redisUrl: REDIS_URL });
    assert.equal(adapter.name, 'bullmq');
    assert.equal(typeof adapter.createProducer, 'function');
    assert.equal(typeof adapter.createWorker, 'function');
    assert.equal(typeof adapter.upsertSchedules, 'function');

    assert.throws(() => createBullMQAdapter({} as { redisUrl: string }), TypeError);
    assert.throws(
      () => createBullMQAdapter({ redisUrl: '' }),
      /non-empty redis:\/\/ or rediss:\/\//,
    );
    assert.throws(
      () => createBullMQAdapter({ redisUrl: 'http://127.0.0.1:6379' }),
      /redis:\/\/ or rediss:\/\//,
    );
    assert.throws(
      () => createBullMQAdapter({ redisUrl: REDIS_URL, onError: 'nope' as unknown as () => void }),
      /onError/,
    );
    assert.throws(
      () =>
        createBullMQAdapter({ redisUrl: REDIS_URL, queueFactory: 1 as unknown as QueueFactory }),
      /queueFactory/,
    );
    assert.throws(
      () =>
        createBullMQAdapter({ redisUrl: REDIS_URL, workerFactory: 1 as unknown as WorkerFactory }),
      /workerFactory/,
    );
  });

  it('never echoes credentials from a rejected connection URL', () => {
    assert.throws(
      () => createBullMQAdapter({ redisUrl: 'http://user:sup3rsecret@host:6379' }),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.doesNotMatch(error.message, /sup3rsecret/);
        assert.doesNotMatch(error.message, /user/);
        return true;
      },
    );
  });

  it('constructs nothing until the first producer/worker/schedule operation', async () => {
    const fakes = makeFakes();
    const { registry } = recordingRegistry();
    const runtime = createJobsRuntime({
      registry,
      adapter: createBullMQAdapter({ redisUrl: REDIS_URL, ...fakes }),
    });

    assert.equal(fakes.queues.length, 0);
    assert.equal(fakes.workers.length, 0);

    // Closing an unused runtime must not have constructed anything either.
    await runtime.close();
    assert.equal(fakes.queues.length, 0);
    assert.equal(fakes.workers.length, 0);
  });

  it('honors queueName/prefix/concurrency and shapes connections and defaults', async () => {
    const fakes = makeFakes();
    const { registry } = recordingRegistry();
    const runtime = createJobsRuntime({
      registry,
      adapter: createBullMQAdapter({ redisUrl: REDIS_URL, ...fakes }),
      queueName: 'emails',
      prefix: 'app',
      concurrency: 4,
    });

    await runtime.dispatch('sendEmail', { to: 'a@b.co', subject: 'hi' }, { delay: 100 });
    assert.equal(fakes.queues.length, 1);
    const queue = fakes.queues[0]!;
    assert.equal(queue.name, 'emails');
    assert.equal(queue.opts.prefix, 'app');
    assert.equal(queue.opts.skipWaitingForReady, true);
    assert.deepEqual(queue.opts.connection, {
      url: REDIS_URL,
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
    });
    assert.deepEqual(queue.opts.defaultJobOptions, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    });
    assert.deepEqual(queue.adds, [
      {
        name: 'sendEmail',
        data: { to: 'a@b.co', subject: 'hi' },
        opts: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          delay: 100,
        },
      },
    ]);

    // A second dispatch reuses the producer handle: no second Queue.
    await runtime.dispatch('sendEmail', { to: 'c@d.co', subject: 'yo' });
    assert.equal(fakes.queues.length, 1);
    assert.equal(queue.adds.length, 2);

    await runtime.startWorker();
    assert.equal(fakes.workers.length, 1);
    const worker = fakes.workers[0]!;
    assert.equal(worker.name, 'emails');
    assert.equal(worker.opts.prefix, 'app');
    assert.equal(worker.opts.concurrency, 4);
    assert.deepEqual(worker.opts.connection, {
      url: REDIS_URL,
      maxRetriesPerRequest: null,
    });

    await runtime.startWorker();
    assert.equal(fakes.workers.length, 1, 'the worker handle is reused');

    await runtime.close();
  });

  it('passes a processor that runs neutral payload validation, then the handler', async () => {
    const fakes = makeFakes();
    const { registry, handled } = recordingRegistry();
    const runtime = createJobsRuntime({
      registry,
      adapter: createBullMQAdapter({ redisUrl: REDIS_URL, ...fakes }),
    });

    await runtime.startWorker();
    const processor = fakes.workers[0]!.processor;

    await processor(workerJob());
    assert.deepEqual(handled, [
      { data: { to: 'a@b.co', subject: 'hi' }, jobId: 'job-1', name: 'sendEmail' },
    ]);

    await assert.rejects(processor(workerJob({ name: 'missing' })), JobUnknownError);
    await assert.rejects(processor(workerJob({ data: { to: 1, subject: 'x' } })), JobPayloadError);
    assert.equal(handled.length, 1, 'invalid jobs never reach the handler');

    await runtime.close();
  });

  it('maps neutral prepared schedules to upsertJobScheduler after producer creation', async () => {
    const fakes = makeFakes();
    const { registry } = recordingRegistry();
    const runtime = createJobsRuntime({
      registry,
      adapter: createBullMQAdapter({ redisUrl: REDIS_URL, ...fakes }),
    });

    await runtime.upsertSchedules([
      { id: 'interval', job: 'sendEmail', everyMs: 5000, data: { to: 'a@b.co', subject: 'hi' } },
      { id: 'cron', job: 'sendEmail', cron: '0 3 * * *', timezone: 'America/New_York' },
    ]);

    assert.equal(fakes.queues.length, 1);
    assert.deepEqual(fakes.queues[0]!.schedulers, [
      {
        id: 'interval',
        repeat: { every: 5000 },
        template: { name: 'sendEmail', data: { to: 'a@b.co', subject: 'hi' } },
      },
      {
        id: 'cron',
        repeat: { pattern: '0 3 * * *', tz: 'America/New_York' },
        template: { name: 'sendEmail', data: undefined },
      },
    ]);

    await runtime.close();
  });

  it('rejects invalid schedules before any queue is constructed', async () => {
    const fakes = makeFakes();
    const { registry } = recordingRegistry();
    const runtime = createJobsRuntime({
      registry,
      adapter: createBullMQAdapter({ redisUrl: REDIS_URL, ...fakes }),
    });

    await assert.rejects(
      runtime.upsertSchedules([{ id: 'bad', job: 'missing', everyMs: 5000 }]),
      /unknown job/,
    );
    assert.equal(fakes.queues.length, 0);
    assert.equal(fakes.queues.flatMap((q) => q.schedulers).length, 0);
  });

  it('refuses to schedule a producer it did not create', async () => {
    const fakes = makeFakes();
    const adapter = createBullMQAdapter({ redisUrl: REDIS_URL, ...fakes });
    const foreign: RuntimeProducer = {
      dispatch: async () => 'ok',
      close: async () => undefined,
    };

    await assert.rejects(adapter.upsertSchedules!(foreign, []), /created by this adapter/);
  });

  it('closes the worker then the producer, idempotently', async () => {
    const fakes = makeFakes();
    const { registry } = recordingRegistry();
    const runtime = createJobsRuntime({
      registry,
      adapter: createBullMQAdapter({ redisUrl: REDIS_URL, ...fakes }),
    });

    await runtime.startWorker();
    await runtime.dispatch('sendEmail', { to: 'a@b.co', subject: 'hi' });

    const order: string[] = [];
    const queue = fakes.queues[0]!;
    const worker = fakes.workers[0]!;
    const originalQueueClose = queue.close.bind(queue);
    const originalWorkerClose = worker.close.bind(worker);
    queue.close = () => {
      order.push('producer');
      return originalQueueClose();
    };
    worker.close = (force?: boolean) => {
      order.push('worker');
      return originalWorkerClose(force);
    };

    await Promise.all([runtime.close(), runtime.close(), runtime.close()]);
    assert.deepEqual(order, ['worker', 'producer']);
    assert.equal(queue.closes, 1);
    assert.equal(worker.closes, 1);

    await runtime.close();
    assert.equal(queue.closes, 1);
    assert.equal(worker.closes, 1);
  });

  it('routes queue and worker errors to onError', async () => {
    const fakes = makeFakes();
    const { registry } = recordingRegistry();
    const seen: string[] = [];
    const runtime = createJobsRuntime({
      registry,
      adapter: createBullMQAdapter({
        redisUrl: REDIS_URL,
        onError: (error) => seen.push(error.message),
        ...fakes,
      }),
    });

    await runtime.dispatch('sendEmail', { to: 'a@b.co', subject: 'hi' });
    await runtime.startWorker();

    fakes.queues[0]!.errorListeners[0]!(new Error('queue boom'));
    fakes.workers[0]!.errorListeners[0]!(new Error('worker boom'));
    assert.deepEqual(seen, ['queue boom', 'worker boom']);

    await runtime.close();
  });

  it('closes a half-built handle when the error listener cannot attach', async () => {
    const queueFakes = makeFakes({ failQueueListener: true });
    const { registry } = recordingRegistry();
    const queueRuntime = createJobsRuntime({
      registry,
      adapter: createBullMQAdapter({ redisUrl: REDIS_URL, ...queueFakes }),
    });

    await assert.rejects(
      queueRuntime.dispatch('sendEmail', { to: 'a@b.co', subject: 'hi' }),
      /queue error listener failed/,
    );
    assert.equal(queueFakes.queues.length, 1);
    assert.equal(queueFakes.queues[0]!.closes, 1, 'the failed queue is closed, not leaked');

    const workerFakes = makeFakes({ failWorkerListener: true });
    const workerRuntime = createJobsRuntime({
      registry,
      adapter: createBullMQAdapter({ redisUrl: REDIS_URL, ...workerFakes }),
    });

    await assert.rejects(workerRuntime.startWorker(), /worker error listener failed/);
    assert.equal(workerFakes.workers.length, 1);
    assert.equal(workerFakes.workers[0]!.closes, 1, 'the failed worker is closed, not leaked');
  });
});
