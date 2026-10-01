/**
 * Tests for the neutral-runtime schedule-inspection surface: listSchedules,
 * pauseSchedules, adapter capability delegation, and error branches. Uses the
 * same in-memory fake-adapter pattern as jobs-adapter.test.ts, so no Redis/
 * Valkey or BullMQ connection is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { createJobRegistry, defineJob } from '../../src/jobs/registry.js';
import {
  createJobsRuntime,
  JobsRuntimeClosedError,
  JobsRuntimeError,
  validateJobsRuntimeAdapter,
  type JobDispatchOptions,
  type JobsRuntimeAdapter,
  type ProcessJob,
} from '../../src/jobs/runtime.js';

interface FakeState {
  producerCreates: number;
  dispatched: Array<{ name: string; data: unknown; options: JobDispatchOptions }>;
  listSchedulesCalledWith: unknown;
  pauseSchedulesCalledWith: { ids: readonly string[] } | undefined;
}

function fakeAdapter(options: { listSchedules?: boolean; pauseSchedules?: boolean } = {}): {
  adapter: JobsRuntimeAdapter;
  state: FakeState;
} {
  const state: FakeState = {
    producerCreates: 0,
    dispatched: [],
    listSchedulesCalledWith: undefined,
    pauseSchedulesCalledWith: undefined,
  };

  const adapter: JobsRuntimeAdapter = {
    name: 'fake',
    createProducer() {
      state.producerCreates += 1;
      return {
        dispatch(name, data, dispatchOptions) {
          state.dispatched.push({ name, data, options: dispatchOptions });
          return Promise.resolve({ queued: name });
        },
        close() {
          return Promise.resolve();
        },
      };
    },
    createWorker(_context, _processJob: ProcessJob) {
      return {
        close() {
          return Promise.resolve();
        },
      };
    },
    upsertSchedules(_producer, _schedules) {
      return Promise.resolve();
    },
  };

  if (options.listSchedules !== false) {
    adapter.listSchedules = (producer) => {
      state.listSchedulesCalledWith = producer;
      return Promise.resolve([
        {
          id: 'digest',
          job: 'sendEmail',
          repeat: 'every 5000ms',
          nextRunAt: 1740000000000,
          overlap: { key: 'schedule:digest', ttlMs: 300_000 },
        },
      ]);
    };
  }

  if (options.pauseSchedules !== false) {
    adapter.pauseSchedules = (_producer, ids) => {
      state.pauseSchedulesCalledWith = { ids };
      return Promise.resolve();
    };
  }

  return { adapter, state };
}

function recordingRegistry() {
  const sendEmail = defineJob(z.object({ to: z.string(), subject: z.string() }), async () => {});
  return createJobRegistry({ sendEmail });
}

describe('schedule inspection runtime surface', () => {
  it('listSchedules delegates to the adapter capability and returns its value', async () => {
    const { adapter, state } = fakeAdapter();
    const registry = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    const result = await runtime.listSchedules();
    assert.ok(result !== undefined);

    // Verify the values returned from the adapter.
    assert.equal(result.length, 1);
    const entry = result[0]!;
    assert.equal(entry.id, 'digest');
    assert.equal(entry.job, 'sendEmail');
    assert.equal(entry.repeat, 'every 5000ms');
    assert.equal(entry.nextRunAt, 1740000000000);
    assert.deepEqual(entry.overlap, { key: 'schedule:digest', ttlMs: 300_000 });

    // The adapter received the producer handle.
    assert.ok(state.listSchedulesCalledWith !== undefined);
    assert.equal(state.producerCreates, 1);

    await runtime.close();
  });

  it('listSchedules reuses an already-created producer handle', async () => {
    const { adapter, state } = fakeAdapter();
    const registry = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await runtime.dispatch('sendEmail', { to: 'a@b.co', subject: 'hi' });
    assert.equal(state.producerCreates, 1);

    await runtime.listSchedules();
    assert.equal(state.producerCreates, 1, 'the producer handle is reused');

    await runtime.close();
  });

  it('listSchedules throws JobsRuntimeError when the adapter lacks the capability', async () => {
    const { adapter } = fakeAdapter({ listSchedules: false });
    const registry = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await assert.rejects(runtime.listSchedules(), (error: unknown) => {
      assert.ok(error instanceof JobsRuntimeError);
      assert.match(error.message, /does not support listing schedules/);
      return true;
    });

    await runtime.close();
  });

  it('pauseSchedules delegates to the adapter capability with the ids', async () => {
    const { adapter, state } = fakeAdapter();
    const registry = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await runtime.pauseSchedules(['digest', 'report']);
    assert.deepEqual(state.pauseSchedulesCalledWith, { ids: ['digest', 'report'] });
    assert.equal(state.producerCreates, 1);

    await runtime.close();
  });

  it('pauseSchedules accepts an empty ids array', async () => {
    const { adapter, state } = fakeAdapter();
    const registry = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await runtime.pauseSchedules([]);
    assert.deepEqual(state.pauseSchedulesCalledWith, { ids: [] });

    await runtime.close();
  });

  it('pauseSchedules throws JobsRuntimeError when the adapter lacks the capability', async () => {
    const { adapter } = fakeAdapter({ pauseSchedules: false });
    const registry = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await assert.rejects(runtime.pauseSchedules(['digest']), (error: unknown) => {
      assert.ok(error instanceof JobsRuntimeError);
      assert.match(error.message, /does not support pausing schedules/);
      return true;
    });

    await runtime.close();
  });

  it('pauseSchedules rejects a non-array ids argument before touching the adapter', async () => {
    const { adapter, state } = fakeAdapter();
    const registry = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await assert.rejects(
      runtime.pauseSchedules(null as unknown as readonly string[]),
      JobsRuntimeError,
    );
    assert.equal(state.pauseSchedulesCalledWith, undefined, 'the adapter was never called');
    assert.equal(state.producerCreates, 0, 'no producer was created');

    await runtime.close();
  });

  it('pauseSchedules rejects an array with a non-string entry before touching the adapter', async () => {
    const { adapter, state } = fakeAdapter();
    const registry = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await assert.rejects(runtime.pauseSchedules(['ok', 1 as unknown as string]), JobsRuntimeError);
    assert.equal(state.pauseSchedulesCalledWith, undefined);

    await runtime.close();
  });

  it('pauseSchedules rejects an array with an empty string entry before touching the adapter', async () => {
    const { adapter, state } = fakeAdapter();
    const registry = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await assert.rejects(runtime.pauseSchedules(['ok', '']), JobsRuntimeError);
    assert.equal(state.pauseSchedulesCalledWith, undefined);

    await runtime.close();
  });

  it('listSchedules throws JobsRuntimeClosedError after close', async () => {
    const { adapter } = fakeAdapter();
    const registry = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await runtime.close();
    await assert.rejects(runtime.listSchedules(), JobsRuntimeClosedError);
  });

  it('pauseSchedules throws JobsRuntimeClosedError after close', async () => {
    const { adapter } = fakeAdapter();
    const registry = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await runtime.close();
    await assert.rejects(runtime.pauseSchedules(['digest']), JobsRuntimeClosedError);
  });

  it('validateJobsRuntimeAdapter accepts an adapter with listSchedules and pauseSchedules', () => {
    const adapter: JobsRuntimeAdapter = {
      name: 'test',
      createProducer() {
        return { dispatch: async () => 'ok', close: async () => undefined };
      },
      createWorker() {
        return { close: async () => undefined };
      },
      listSchedules: async () => [],
      pauseSchedules: async () => undefined,
    };
    validateJobsRuntimeAdapter(adapter);
    // No throw = pass.
  });

  it('validateJobsRuntimeAdapter rejects listSchedules when present but not a function', () => {
    const adapter = {
      name: 'test',
      createProducer() {
        return { dispatch: async () => 'ok', close: async () => undefined };
      },
      createWorker() {
        return { close: async () => undefined };
      },
      listSchedules: 'not a function',
    };

    assert.throws(
      () => validateJobsRuntimeAdapter(adapter),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.match(String(error), /listSchedules must be a function/);
        return true;
      },
    );
  });

  it('validateJobsRuntimeAdapter rejects pauseSchedules when present but not a function', () => {
    const adapter = {
      name: 'test',
      createProducer() {
        return { dispatch: async () => 'ok', close: async () => undefined };
      },
      createWorker() {
        return { close: async () => undefined };
      },
      pauseSchedules: 42,
    };

    assert.throws(
      () => validateJobsRuntimeAdapter(adapter),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.match(String(error), /pauseSchedules must be a function/);
        return true;
      },
    );
  });

  it('returns an empty schedule list from a working adapter', async () => {
    const { adapter, state } = fakeAdapter();
    // Override listSchedules to return empty.
    adapter.listSchedules = (_producer) => {
      state.listSchedulesCalledWith = _producer;
      return Promise.resolve([]);
    };
    const registry = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    const result = await runtime.listSchedules();
    assert.deepEqual(result, []);
    assert.equal(state.producerCreates, 1);

    await runtime.close();
  });

  it('listSchedules value-free error message never echoes the adapter name verbatim beyond the fixed pattern', async () => {
    // The error message pattern is fixed: includes the adapter name in quotes
    // but no dynamic user data. Confirm the message shape.
    const { adapter } = fakeAdapter({ listSchedules: false });
    const registry = recordingRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await assert.rejects(runtime.listSchedules(), (error: unknown) => {
      assert.ok(error instanceof JobsRuntimeError);
      // The adapter name appears in the message but it is a diagnostic label,
      // not user-controlled input.
      assert.match(error.message, /job adapter "fake" does not support listing schedules/);
      return true;
    });

    await runtime.close();
  });
});
