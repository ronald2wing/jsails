/**
 * Tests for the provider-neutral job runtime controller: lazy handle creation,
 * dispatch/worker payload validation on both sides, schedule validation and
 * delegation, idempotent close, and failure/closed-state behavior. Everything
 * runs against a simple in-memory adapter, so no Redis/Valkey or BullMQ
 * connection is opened and no URL is required.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  createRegistry,
  defineJob,
  JobPayloadError,
  JobUnknownError,
} from '../src/jobs/registry.js';
import { ScheduleError, type PreparedSchedule, type ScheduleSpec } from '../src/jobs/scheduler.js';
import {
  createJobsRuntime,
  JobRuntimeClosedError,
  type JobDispatchOptions,
  type JobRuntimeAdapter,
  type ProcessJob,
  type RuntimeJob,
  type RuntimeProducer,
  type RuntimeWorker,
} from '../src/jobs/runtime.js';

interface FakeState {
  producerCreates: number;
  workerCreates: number;
  producerCloses: number;
  workerCloses: number;
  dispatched: Array<{ name: string; data: unknown; options: JobDispatchOptions }>;
  processJob: ProcessJob | undefined;
  schedules: readonly PreparedSchedule[] | undefined;
}

/** A minimal in-memory adapter; no backend, no URL, no connection. */
function fakeAdapter(
  options: { schedule?: boolean; failProducerOnce?: boolean; failWorkerOnce?: boolean } = {},
): { adapter: JobRuntimeAdapter; state: FakeState } {
  const state: FakeState = {
    producerCreates: 0,
    workerCreates: 0,
    producerCloses: 0,
    workerCloses: 0,
    dispatched: [],
    processJob: undefined,
    schedules: undefined,
  };
  let failProducer = options.failProducerOnce ?? false;
  let failWorker = options.failWorkerOnce ?? false;

  const adapter: JobRuntimeAdapter = {
    name: 'fake',
    createProducer() {
      state.producerCreates += 1;
      if (failProducer) {
        failProducer = false;
        return Promise.reject(new Error('producer start failed'));
      }
      return {
        dispatch(name, data, dispatchOptions) {
          state.dispatched.push({ name, data, options: dispatchOptions });
          return Promise.resolve({ queued: name });
        },
        close() {
          state.producerCloses += 1;
          return Promise.resolve();
        },
      };
    },
    createWorker(_context, processJob) {
      state.workerCreates += 1;
      if (failWorker) {
        failWorker = false;
        return Promise.reject(new Error('worker start failed'));
      }
      state.processJob = processJob;
      return {
        close() {
          state.workerCloses += 1;
          return Promise.resolve();
        },
      };
    },
  };

  if (options.schedule !== false) {
    adapter.upsertSchedules = (_producer, schedules) => {
      state.schedules = schedules;
      return Promise.resolve();
    };
  }

  return { adapter, state };
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

function runtimeJob(overrides: Partial<RuntimeJob> = {}): RuntimeJob {
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

describe('job runtime adapter', () => {
  it('creates no handles until the first operation', () => {
    const { adapter, state } = fakeAdapter();
    const { registry } = recordingRegistry();

    createJobsRuntime({ registry, adapter });

    assert.equal(state.producerCreates, 0);
    assert.equal(state.workerCreates, 0);
  });

  it('validates the dispatch payload, then forwards data and options', async () => {
    const { adapter, state } = fakeAdapter();
    const { registry } = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    const result = await runtime.dispatch(
      'sendEmail',
      { to: 'a@b.co', subject: 'hi' },
      { jobId: 'idempotent-1' },
    );

    assert.deepEqual(result, { queued: 'sendEmail' });
    assert.equal(state.producerCreates, 1);
    assert.deepEqual(state.dispatched, [
      {
        name: 'sendEmail',
        data: { to: 'a@b.co', subject: 'hi' },
        options: { jobId: 'idempotent-1' },
      },
    ]);

    await runtime.dispatch('sendEmail', { to: 'c@d.co', subject: 'yo' });
    assert.equal(state.producerCreates, 1, 'the producer handle is reused');
    assert.equal(state.dispatched.length, 2);
  });

  it('rejects unknown jobs, bad payloads, and bad options before creating a producer', async () => {
    const { adapter, state } = fakeAdapter();
    const { registry } = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await assert.rejects(runtime.dispatch('missing', {}), JobUnknownError);
    await assert.rejects(runtime.dispatch('sendEmail', { to: 42, subject: 'hi' }), JobPayloadError);
    await assert.rejects(
      runtime.dispatch('sendEmail', { to: 'a@b.co', subject: 'hi' }, { nope: true }),
      /unsupported job option/,
    );

    assert.equal(state.producerCreates, 0);
    assert.equal(state.dispatched.length, 0);
  });

  it('processes jobs through the registry handler after worker-side validation', async () => {
    const { adapter, state } = fakeAdapter();
    const { registry, handled } = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await runtime.startWorker();
    assert.equal(state.workerCreates, 1);
    assert.ok(state.processJob);

    const result = await state.processJob(runtimeJob());
    assert.equal(result, undefined);
    assert.deepEqual(handled, [
      { data: { to: 'a@b.co', subject: 'hi' }, jobId: 'job-1', name: 'sendEmail' },
    ]);

    await runtime.startWorker();
    assert.equal(state.workerCreates, 1, 'the worker handle is reused');
  });

  it('rejects unknown jobs and bad payloads on the worker side without invoking the handler', async () => {
    const { adapter, state } = fakeAdapter();
    const { registry, handled } = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });
    await runtime.startWorker();

    await assert.rejects(state.processJob!(runtimeJob({ name: 'missing' })), JobUnknownError);
    await assert.rejects(
      state.processJob!(runtimeJob({ data: { to: 1, subject: 'x' } })),
      JobPayloadError,
    );
    assert.equal(handled.length, 0);
  });

  it('throws an explicit error when the adapter cannot schedule', async () => {
    const { adapter, state } = fakeAdapter({ schedule: false });
    const { registry } = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await assert.rejects(
      runtime.upsertSchedules([{ id: 's', job: 'sendEmail', everyMs: 5000 }]),
      /does not support scheduling/,
    );
    assert.equal(state.producerCreates, 0);
    assert.equal(state.schedules, undefined);
  });

  it('validates schedules and forwards neutral prepared entries', async () => {
    const { adapter, state } = fakeAdapter();
    const { registry } = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await runtime.upsertSchedules([
      { id: 'interval', job: 'sendEmail', everyMs: 5000, data: { to: 'a@b.co', subject: 'hi' } },
      { id: 'cron', job: 'sendEmail', cron: '0 3 * * *', timezone: 'America/New_York' },
    ]);

    assert.equal(state.producerCreates, 1);
    assert.deepEqual(state.schedules, [
      {
        id: 'interval',
        job: 'sendEmail',
        repeat: { every: 5000 },
        data: { to: 'a@b.co', subject: 'hi' },
      },
      {
        id: 'cron',
        job: 'sendEmail',
        repeat: { pattern: '0 3 * * *', tz: 'America/New_York' },
        data: undefined,
      },
    ]);
  });

  it('rejects invalid schedules before touching the provider', async () => {
    const { adapter, state } = fakeAdapter();
    const { registry } = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    const unknownJob: ScheduleSpec[] = [{ id: 'a', job: 'missing', everyMs: 5000 }];
    await assert.rejects(runtime.upsertSchedules(unknownJob), ScheduleError);
    await assert.rejects(
      runtime.upsertSchedules([{ id: 'a', job: 'sendEmail', everyMs: 5000, cron: '0 * * * *' }]),
      ScheduleError,
    );
    await assert.rejects(
      runtime.upsertSchedules([
        { id: 'a', job: 'sendEmail', cron: '0 0 * * *', timezone: 'Not/AZone' },
      ]),
      ScheduleError,
    );
    await assert.rejects(
      runtime.upsertSchedules([
        { id: 'a', job: 'sendEmail', everyMs: 5000, data: { to: 1, subject: 'x' } },
      ]),
      JobPayloadError,
    );
    await assert.rejects(
      runtime.upsertSchedules([{ id: 'a', job: 'sendEmail', everyMs: 5 }]),
      ScheduleError,
    );

    assert.equal(state.schedules, undefined);
    assert.equal(state.producerCreates, 0);
  });

  it('closes the worker then the producer exactly once for concurrent callers', async () => {
    const { adapter, state } = fakeAdapter();
    const { registry } = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await runtime.startWorker();
    await runtime.dispatch('sendEmail', { to: 'a@b.co', subject: 'hi' });

    await Promise.all([runtime.close(), runtime.close(), runtime.close()]);
    assert.equal(state.workerCloses, 1);
    assert.equal(state.producerCloses, 1);

    await runtime.close();
    assert.equal(state.workerCloses, 1);
    assert.equal(state.producerCloses, 1);
  });

  it('rejects new operations once closed', async () => {
    const { adapter } = fakeAdapter();
    const { registry } = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await runtime.close();

    await assert.rejects(
      runtime.dispatch('sendEmail', { to: 'a@b.co', subject: 'hi' }),
      JobRuntimeClosedError,
    );
    await assert.rejects(runtime.startWorker(), JobRuntimeClosedError);
    await assert.rejects(runtime.upsertSchedules([]), JobRuntimeClosedError);
  });

  it('does not cache a failed worker start, so a later start can succeed', async () => {
    const { adapter, state } = fakeAdapter({ failWorkerOnce: true });
    const { registry } = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await assert.rejects(runtime.startWorker(), /worker start failed/);
    assert.equal(state.workerCreates, 1);

    await runtime.startWorker();
    assert.equal(state.workerCreates, 2);
    assert.ok(state.processJob);

    await runtime.close();
  });

  it('rejects a startWorker racing close with delayed creation and disposes the worker once', async () => {
    let releaseWorker!: (worker: RuntimeWorker) => void;
    let workerCreates = 0;
    let workerCloses = 0;
    const adapter: JobRuntimeAdapter = {
      name: 'slow',
      createProducer() {
        return { dispatch: async () => 'ok', close: async () => undefined };
      },
      createWorker() {
        workerCreates += 1;
        return new Promise<RuntimeWorker>((resolve) => {
          releaseWorker = resolve;
        });
      },
    };
    const { registry } = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    const started = runtime.startWorker();
    const closing = runtime.close();
    releaseWorker({
      close: async () => {
        workerCloses += 1;
      },
    });

    await assert.rejects(started, JobRuntimeClosedError);
    await closing;
    assert.equal(workerCreates, 1);
    assert.equal(workerCloses, 1, 'the raced worker is disposed exactly once');
  });

  it('does not cache a failed producer start, so a later dispatch can succeed', async () => {
    const { adapter, state } = fakeAdapter({ failProducerOnce: true });
    const { registry } = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await assert.rejects(
      runtime.dispatch('sendEmail', { to: 'a@b.co', subject: 'hi' }),
      /producer start failed/,
    );
    assert.equal(state.producerCreates, 1);

    const result = await runtime.dispatch('sendEmail', { to: 'a@b.co', subject: 'hi' });
    assert.deepEqual(result, { queued: 'sendEmail' });
    assert.equal(state.producerCreates, 2);

    await runtime.close();
  });

  it('passes the neutral queue context to the adapter', async () => {
    let seen: { queueName: string; prefix: string; concurrency: number } | undefined;
    const adapter: JobRuntimeAdapter = {
      name: 'capture',
      createProducer(context) {
        seen = context;
        return { dispatch: async () => 'ok', close: async () => undefined };
      },
      createWorker() {
        return { close: async () => undefined };
      },
    };
    const { registry } = recordingRegistry();
    const runtime = createJobsRuntime({
      registry,
      adapter,
      queueName: 'emails',
      prefix: 'app',
      concurrency: 4,
    });

    await runtime.dispatch('sendEmail', { to: 'a@b.co', subject: 'hi' });
    assert.deepEqual(seen, { queueName: 'emails', prefix: 'app', concurrency: 4, registry });

    await runtime.close();
  });

  it('validates the adapter shape and the produced handles', async () => {
    const { registry } = recordingRegistry();

    assert.throws(
      () => createJobsRuntime({ registry, adapter: null as unknown as JobRuntimeAdapter }),
      TypeError,
    );
    assert.throws(
      () =>
        createJobsRuntime({
          registry,
          adapter: {
            createProducer: () => ({}) as RuntimeProducer,
            createWorker: () => ({}) as RuntimeWorker,
          } as unknown as JobRuntimeAdapter,
        }),
      /name/,
    );
    assert.throws(
      () =>
        createJobsRuntime({
          registry,
          adapter: {
            name: 'x',
            createWorker: () => ({}) as RuntimeWorker,
          } as unknown as JobRuntimeAdapter,
        }),
      /createProducer/,
    );
    assert.throws(
      () =>
        createJobsRuntime({
          registry,
          adapter: {
            name: 'x',
            createProducer: () => ({}) as RuntimeProducer,
          } as unknown as JobRuntimeAdapter,
        }),
      /createWorker/,
    );
    assert.throws(
      () => createJobsRuntime({ registry, adapter: fakeAdapter().adapter, concurrency: 0 }),
      /concurrency/,
    );

    const badProducer = createJobsRuntime({
      registry,
      adapter: {
        name: 'x',
        createProducer: () => ({}) as RuntimeProducer,
        createWorker: () => ({ close: async () => undefined }),
      },
    });
    await assert.rejects(
      badProducer.dispatch('sendEmail', { to: 'a@b.co', subject: 'hi' }),
      /producer must declare a dispatch function/,
    );

    const badWorker = createJobsRuntime({
      registry,
      adapter: {
        name: 'x',
        createProducer: () => ({ dispatch: async () => 1, close: async () => undefined }),
        createWorker: () => ({}) as RuntimeWorker,
      },
    });
    await assert.rejects(badWorker.startWorker(), /worker must declare a close function/);
  });
});
