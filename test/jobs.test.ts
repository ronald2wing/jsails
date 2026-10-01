import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  buildConnectionOptions,
  PRODUCER_MAX_RETRIES_PER_REQUEST,
} from '../src/jobs/connection.js';
import {
  createRegistry,
  defineJob,
  JobPayloadError,
  JobUnknownError,
  validatePayload,
  type JobDefinition,
} from '../src/jobs/registry.js';
import {
  createJobQueue,
  DEFAULT_ATTEMPTS,
  DEFAULT_BACKOFF_MS,
  JobOptionsError,
  validateJobOptions,
  type JobQueue,
} from '../src/jobs/queue.js';
import {
  DEFAULT_TIMEZONE,
  MAX_SCHEDULES,
  ScheduleError,
  startJobWorker,
  upsertSchedules,
  type SchedulerQueue,
  type ScheduleSpec,
  type WorkerJob,
} from '../src/jobs/scheduler.js';

/**
 * BullMQ integration tests that never touch Redis: every Queue/Worker is a
 * thin mock injected through the factory seams. Assertions cover connection
 * options, payload validation on both sides, close ordering/idempotency, and
 * schedule validation-before-mutation.
 */

const EMAIL_JOB = defineJob(
  z.object({ to: z.string().email(), subject: z.string() }),
  async (_data) => {},
);

const EMAIL_REGISTRY = createRegistry({ sendEmail: EMAIL_JOB });

// ---------------------------------------------------------------------------
// connection options
// ---------------------------------------------------------------------------

describe('connection options', () => {
  it('gives producers finite retries and no offline queue (fast-fail)', () => {
    const opts = buildConnectionOptions('redis://host:6379', 'producer');
    assert.equal(opts.url, 'redis://host:6379');
    assert.equal(opts.maxRetriesPerRequest, PRODUCER_MAX_RETRIES_PER_REQUEST);
    assert.equal(opts.enableOfflineQueue, false);
  });

  it('gives workers null retries so blocking pops never give up', () => {
    const opts = buildConnectionOptions('redis://host:6379', 'worker');
    assert.equal(opts.url, 'redis://host:6379');
    assert.equal(opts.maxRetriesPerRequest, null);
  });
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

describe('registry', () => {
  it('defineJob infers the handler payload type from the schema', () => {
    const job = defineJob(z.object({ n: z.number() }), async (data) => {
      // Compile-time check: data is typed; asserted at runtime for safety.
      assert.equal(typeof data.n, 'number');
    });
    assert.equal(typeof job.handler, 'function');
  });

  it('createRegistry rejects a missing handler', () => {
    const broken = {
      broken: { schema: z.object({}), handler: undefined },
    } as unknown as Record<string, JobDefinition>;
    assert.throws(() => createRegistry(broken), /must define a schema and a handler/);
  });

  it('redacts unrecognized payload field names from validation errors', () => {
    const schema = z.object({ to: z.string() }).strict();
    const sensitiveKey = 'super-secret-api-key';

    assert.throws(
      () => validatePayload(schema, 'sendEmail', { to: 'a@b.co', [sensitiveKey]: 'leak' }),
      (error: unknown) => {
        assert.ok(error instanceof JobPayloadError);
        assert.ok(
          !error.message.includes(sensitiveKey),
          'error must not echo the payload-provided field name',
        );
        assert.match(error.message, /unknown field/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// dispatch (producer) — payload and option validation, no add on failure
// ---------------------------------------------------------------------------

interface AddCall {
  name: string;
  data: unknown;
  opts?: unknown;
}

function makeQueueMock(): { queue: JobQueue; calls: AddCall[]; closed: () => number } {
  const calls: AddCall[] = [];
  let closeCount = 0;
  const queue = {
    async add(name: string, data: unknown, opts?: unknown) {
      calls.push({ name, data, opts });
      return { id: 'job-1' };
    },
    async close() {
      closeCount += 1;
    },
    on(_eventName: 'error', _listener: (error: Error) => void) {
      return undefined;
    },
    async upsertJobScheduler() {
      return { id: 'sched' };
    },
    async getJobScheduler() {
      return undefined;
    },
  } as unknown as JobQueue;
  return { queue, calls, closed: () => closeCount };
}

describe('createJobQueue dispatch', () => {
  it('passes producer connection options and bounded defaults to the Queue', () => {
    let captured: { name: string; opts: Record<string, unknown> } | undefined;
    const { queue } = makeQueueMock();
    const handle = createJobQueue({
      redisUrl: 'redis://h:6379',
      queueName: 'mailer',
      prefix: 'custom',
      registry: EMAIL_REGISTRY,
      queueFactory: (name, opts) => {
        captured = { name, opts: opts as unknown as Record<string, unknown> };
        return queue;
      },
    });
    void handle;

    assert.equal(captured?.name, 'mailer');
    const connection = captured?.opts.connection as Record<string, unknown>;
    assert.equal(connection.url, 'redis://h:6379');
    assert.equal(connection.maxRetriesPerRequest, PRODUCER_MAX_RETRIES_PER_REQUEST);
    assert.equal(captured?.opts.prefix, 'custom');
    assert.equal(captured?.opts.skipWaitingForReady, true);
    const defaults = captured?.opts.defaultJobOptions as Record<string, unknown>;
    assert.equal(defaults.attempts, DEFAULT_ATTEMPTS);
    assert.deepEqual(defaults.backoff, { type: 'exponential', delay: DEFAULT_BACKOFF_MS });
  });

  it('does not add when the payload is invalid', async () => {
    const { queue, calls } = makeQueueMock();
    const handle = createJobQueue({
      redisUrl: 'redis://h:6379',
      registry: EMAIL_REGISTRY,
      queueFactory: () => queue,
    });

    await assert.rejects(
      handle.dispatch('sendEmail', { to: 'not-an-email' }),
      (error: unknown) => error instanceof JobPayloadError,
    );
    assert.equal(calls.length, 0, 'queue.add must not be called on invalid payload');
  });

  it('does not add for an unknown job name', async () => {
    const { queue, calls } = makeQueueMock();
    const handle = createJobQueue({
      redisUrl: 'redis://h:6379',
      registry: EMAIL_REGISTRY,
      queueFactory: () => queue,
    });

    await assert.rejects(handle.dispatch('nope', {}), JobUnknownError);
    assert.equal(calls.length, 0);
  });

  it('adds the validated payload with bounded default options', async () => {
    const { queue, calls } = makeQueueMock();
    const handle = createJobQueue({
      redisUrl: 'redis://h:6379',
      registry: EMAIL_REGISTRY,
      queueFactory: () => queue,
    });

    await handle.dispatch('sendEmail', { to: 'a@b.co', subject: 'hi' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, 'sendEmail');
    assert.deepEqual(calls[0]?.data, { to: 'a@b.co', subject: 'hi' });
    const opts = calls[0]?.opts as Record<string, unknown>;
    assert.equal(opts.attempts, DEFAULT_ATTEMPTS);
    assert.deepEqual(opts.backoff, { type: 'exponential', delay: DEFAULT_BACKOFF_MS });
  });

  it('allows bounded overrides but rejects unknown option keys', async () => {
    const { queue, calls } = makeQueueMock();
    const handle = createJobQueue({
      redisUrl: 'redis://h:6379',
      registry: EMAIL_REGISTRY,
      queueFactory: () => queue,
    });

    await handle.dispatch(
      'sendEmail',
      { to: 'a@b.co', subject: 'hi' },
      { attempts: 5, jobId: 'idem-1' },
    );
    const opts = calls[0]?.opts as Record<string, unknown>;
    assert.equal(opts.attempts, 5);
    assert.equal(opts.jobId, 'idem-1');

    await assert.rejects(
      handle.dispatch('sendEmail', { to: 'a@b.co', subject: 'hi' }, { repeat: { every: 1 } }),
      JobOptionsError,
    );
  });
});

describe('validateJobOptions', () => {
  it('rejects unbounded attempts', () => {
    assert.throws(() => validateJobOptions({ attempts: 1000000 }), JobOptionsError);
    assert.throws(() => validateJobOptions({ attempts: 0 }), JobOptionsError);
    assert.throws(() => validateJobOptions({ attempts: 1.5 }), JobOptionsError);
  });

  it('rejects dangerous backoff shapes', () => {
    assert.throws(() => validateJobOptions({ backoff: { type: 'custom' } }), JobOptionsError);
    assert.throws(
      () => validateJobOptions({ backoff: { type: 'fixed', delay: -1 } }),
      JobOptionsError,
    );
  });

  it('passes allowlisted options through', () => {
    const result = validateJobOptions({
      attempts: 3,
      backoff: { type: 'fixed', delay: 100 },
      delay: 10,
    });
    assert.equal(result.attempts, 3);
    assert.deepEqual(result.backoff, { type: 'fixed', delay: 100 });
    assert.equal(result.delay, 10);
  });
});

describe('createJobQueue close', () => {
  it('closes the queue once and is idempotent', async () => {
    const { queue, closed } = makeQueueMock();
    const handle = createJobQueue({
      redisUrl: 'redis://h:6379',
      registry: EMAIL_REGISTRY,
      queueFactory: () => queue,
    });

    await handle.close();
    await handle.close();
    assert.equal(closed(), 1);
  });
});

// ---------------------------------------------------------------------------
// worker — dispatch validation and close ordering
// ---------------------------------------------------------------------------

function makeWorkerMock() {
  const closeCalls: Array<boolean | undefined> = [];
  return {
    closeCalls,
    worker: {
      async close(force?: boolean) {
        closeCalls.push(force);
      },
      on(_eventName: 'error', _listener: (error: Error) => void) {
        return undefined;
      },
    },
  };
}

describe('startJobWorker', () => {
  it('passes worker connection options (null retries) to the Worker', () => {
    let captured: { name: string; opts: Record<string, unknown> } | undefined;
    const { worker } = makeWorkerMock();
    const handle = startJobWorker({
      redisUrl: 'redis://h:6379',
      queueName: 'mailer',
      registry: EMAIL_REGISTRY,
      workerFactory: (name, _processor, opts) => {
        captured = { name, opts: opts as unknown as Record<string, unknown> };
        return worker;
      },
    });
    void handle;

    assert.equal(captured?.name, 'mailer');
    const connection = captured?.opts.connection as Record<string, unknown>;
    assert.equal(connection.url, 'redis://h:6379');
    assert.equal(connection.maxRetriesPerRequest, null);
  });

  it('validates the received payload before invoking the handler', async () => {
    let received: unknown;
    const registry = createRegistry({
      sendEmail: defineJob(z.object({ to: z.string().email() }), async (data) => {
        received = data;
      }),
    });

    let processor: ((job: WorkerJob) => Promise<unknown>) | undefined;
    const { worker } = makeWorkerMock();
    startJobWorker({
      redisUrl: 'redis://h:6379',
      registry,
      workerFactory: (_name, proc, _opts) => {
        processor = proc;
        return worker;
      },
    });
    assert.ok(processor, 'processor must be captured');

    const job: WorkerJob = {
      name: 'sendEmail',
      id: 'job-9',
      data: { to: 'not-an-email' },
      attemptsMade: 0,
      attemptsStarted: 1,
      log: async () => 1,
      updateProgress: async () => {},
    };

    await assert.rejects(processor(job), JobPayloadError);
    assert.equal(received, undefined, 'handler must not run on invalid payload');

    await processor({ ...job, data: { to: 'a@b.co' } });
    assert.deepEqual(received, { to: 'a@b.co' });
  });

  it('rejects an unknown job name at processing time', async () => {
    let processor: ((job: WorkerJob) => Promise<unknown>) | undefined;
    const { worker } = makeWorkerMock();
    startJobWorker({
      redisUrl: 'redis://h:6379',
      registry: EMAIL_REGISTRY,
      workerFactory: (_name, proc, _opts) => {
        processor = proc;
        return worker;
      },
    });

    const job: WorkerJob = {
      name: 'unknown',
      data: {},
      attemptsMade: 0,
      attemptsStarted: 1,
      log: async () => 1,
      updateProgress: async () => {},
    };
    await assert.rejects(processor!(job), JobUnknownError);
  });

  it('closes the worker once and is idempotent', async () => {
    const { worker, closeCalls } = makeWorkerMock();
    const handle = startJobWorker({
      redisUrl: 'redis://h:6379',
      registry: EMAIL_REGISTRY,
      workerFactory: () => worker,
    });

    await handle.close(true);
    await handle.close(false);
    assert.deepEqual(closeCalls, [true]);
  });
});

// ---------------------------------------------------------------------------
// schedule registration
// ---------------------------------------------------------------------------

interface UpsertCall {
  id: string;
  repeatOpts: Record<string, unknown>;
  template: Record<string, unknown> | undefined;
}

function makeSchedulerMock() {
  const upserts: UpsertCall[] = [];
  const queue: SchedulerQueue = {
    async upsertJobScheduler(id, repeatOpts, template) {
      upserts.push({
        id,
        repeatOpts: repeatOpts,
        template: template,
      });
      return { id };
    },
  };
  return { queue, upserts };
}

describe('upsertSchedules', () => {
  it('registers a cron schedule with a stable id and default UTC timezone', async () => {
    const { queue, upserts } = makeSchedulerMock();
    const schedules: ScheduleSpec[] = [
      {
        id: 'nightly-digest',
        job: 'sendEmail',
        cron: '0 3 * * *',
        data: { to: 'a@b.co', subject: 'digest' },
      },
    ];

    await upsertSchedules(queue, EMAIL_REGISTRY, schedules);

    assert.equal(upserts.length, 1);
    assert.equal(upserts[0]?.id, 'nightly-digest');
    assert.deepEqual(upserts[0]?.repeatOpts, { pattern: '0 3 * * *', tz: DEFAULT_TIMEZONE });
    assert.deepEqual(upserts[0]?.template, {
      name: 'sendEmail',
      data: { to: 'a@b.co', subject: 'digest' },
    });
  });

  it('honors a custom IANA timezone', async () => {
    const { queue, upserts } = makeSchedulerMock();
    await upsertSchedules(queue, EMAIL_REGISTRY, [
      { id: 's', job: 'sendEmail', cron: '0 3 * * *', timezone: 'America/New_York' },
    ]);
    assert.deepEqual(upserts[0]?.repeatOpts, { pattern: '0 3 * * *', tz: 'America/New_York' });
  });

  it('registers an interval schedule with everyMs and no timezone', async () => {
    const { queue, upserts } = makeSchedulerMock();
    await upsertSchedules(queue, EMAIL_REGISTRY, [
      { id: 'poll', job: 'sendEmail', everyMs: 60000 },
    ]);
    assert.deepEqual(upserts[0]?.repeatOpts, { every: 60000 });
    assert.equal(upserts[0]?.template?.name, 'sendEmail');
  });

  it('rejects duplicate schedule ids before any mutation', async () => {
    const { queue, upserts } = makeSchedulerMock();
    const schedules: ScheduleSpec[] = [
      { id: 'dup', job: 'sendEmail', everyMs: 60000 },
      { id: 'dup', job: 'sendEmail', everyMs: 60000 },
    ];

    await assert.rejects(
      upsertSchedules(queue, EMAIL_REGISTRY, schedules),
      /duplicate schedule id/,
    );
    assert.equal(upserts.length, 0);
  });

  it('rejects an unknown job before any mutation', async () => {
    const { queue, upserts } = makeSchedulerMock();
    await assert.rejects(
      upsertSchedules(queue, EMAIL_REGISTRY, [{ id: 's', job: 'ghost', everyMs: 60000 }]),
      /unknown job/,
    );
    assert.equal(upserts.length, 0);
  });

  it('rejects a schedule with invalid data before any mutation', async () => {
    const { queue, upserts } = makeSchedulerMock();
    await assert.rejects(
      upsertSchedules(queue, EMAIL_REGISTRY, [
        { id: 's', job: 'sendEmail', everyMs: 60000, data: { to: 'bad' } },
      ]),
      JobPayloadError,
    );
    assert.equal(upserts.length, 0);
  });

  it('validates the whole list before any registration call', async () => {
    const { queue, upserts } = makeSchedulerMock();
    const schedules: ScheduleSpec[] = [
      { id: 'valid', job: 'sendEmail', everyMs: 60000 },
      { id: 'also-valid', job: 'sendEmail', everyMs: 60000 },
      { id: 'broken', job: 'sendEmail', everyMs: 1 }, // below MIN_INTERVAL_MS
    ];

    await assert.rejects(upsertSchedules(queue, EMAIL_REGISTRY, schedules), ScheduleError);
    assert.equal(upserts.length, 0, 'no schedule may be registered after a validation failure');
  });

  it('surfaces a mid-registration engine failure without rolling back earlier upserts', async () => {
    const upserts: UpsertCall[] = [];
    const queue: SchedulerQueue = {
      async upsertJobScheduler(id, repeatOpts, template) {
        if (id === 'second') {
          throw new Error('engine unavailable');
        }
        upserts.push({
          id,
          repeatOpts: repeatOpts,
          template: template,
        });
        return { id };
      },
    };

    // Locally valid list: the failure can only come from the engine, after the
    // first registration already succeeded.
    await assert.rejects(
      upsertSchedules(queue, EMAIL_REGISTRY, [
        { id: 'first', job: 'sendEmail', everyMs: 60000 },
        { id: 'second', job: 'sendEmail', everyMs: 60000 },
      ]),
      /engine unavailable/,
    );

    // The first upsert stands — there is no transactional rollback, so a retry
    // with the same stable ids is the recovery path.
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0]?.id, 'first');
  });

  it('requires exactly one of everyMs or cron', async () => {
    const { queue, upserts } = makeSchedulerMock();
    await assert.rejects(
      upsertSchedules(queue, EMAIL_REGISTRY, [
        { id: 'both', job: 'sendEmail', everyMs: 60000, cron: '0 * * * *' },
      ]),
      /exactly one of everyMs or cron/,
    );
    await assert.rejects(
      upsertSchedules(queue, EMAIL_REGISTRY, [{ id: 'none', job: 'sendEmail' }]),
      /exactly one of everyMs or cron/,
    );
    assert.equal(upserts.length, 0);
  });

  it('rejects an invalid timezone', async () => {
    const { queue, upserts } = makeSchedulerMock();
    await assert.rejects(
      upsertSchedules(queue, EMAIL_REGISTRY, [
        { id: 'tz', job: 'sendEmail', cron: '0 * * * *', timezone: 'Not/AZone' },
      ]),
      /invalid timezone/,
    );
    assert.equal(upserts.length, 0);
  });

  it('bounds the number of schedules', async () => {
    const { queue, upserts } = makeSchedulerMock();
    const tooMany: ScheduleSpec[] = Array.from({ length: MAX_SCHEDULES + 1 }, (_, i) => ({
      id: `s${i}`,
      job: 'sendEmail',
      everyMs: 60000,
    }));
    await assert.rejects(upsertSchedules(queue, EMAIL_REGISTRY, tooMany), /at most/);
    assert.equal(upserts.length, 0);
  });
});
