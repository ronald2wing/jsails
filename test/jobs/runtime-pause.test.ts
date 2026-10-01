/**
 * Tests for producer-side queue pause/resume through the neutral runtime.
 * Everything runs against simple in-memory adapters, so no Redis/Valkey or
 * BullMQ connection is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { createJobRegistry, defineJob } from '../../src/jobs/registry.js';
import {
  createJobsRuntime,
  JobsRuntimeClosedError,
  JobsRuntimeError,
  type JobsRuntimeAdapter,
} from '../../src/jobs/runtime.js';

interface PauseState {
  pauseCalls: number;
  resumeCalls: number;
  closeCalls: number;
}

/** A minimal in-memory adapter whose producer exposes pause/resume. */
function pauseAdapter(): { adapter: JobsRuntimeAdapter; state: PauseState } {
  const state: PauseState = { pauseCalls: 0, resumeCalls: 0, closeCalls: 0 };

  const adapter: JobsRuntimeAdapter = {
    name: 'pause',
    createProducer() {
      return {
        dispatch(_name: string, _data: unknown) {
          return Promise.resolve({ queued: _name });
        },
        pause() {
          state.pauseCalls += 1;
          return Promise.resolve();
        },
        resume() {
          state.resumeCalls += 1;
          return Promise.resolve();
        },
        close() {
          state.closeCalls += 1;
          return Promise.resolve();
        },
      };
    },
    createWorker() {
      return { close: () => Promise.resolve() };
    },
  };

  return { adapter, state };
}

/** A minimal in-memory adapter whose producer lacks pause/resume. */
function noPauseAdapter(): { adapter: JobsRuntimeAdapter } {
  return {
    adapter: {
      name: 'no-pause',
      createProducer() {
        return {
          dispatch(_name: string, _data: unknown) {
            return Promise.resolve({ queued: _name });
          },
          close() {
            return Promise.resolve();
          },
        };
      },
      createWorker() {
        return { close: () => Promise.resolve() };
      },
    },
  };
}

function testRegistry() {
  const ping = defineJob(z.object({ x: z.number() }), async () => {});
  return createJobRegistry({ ping });
}

describe('runtime pause/resume', () => {
  it('pauseQueue calls through to producer.pause', async () => {
    const { adapter, state } = pauseAdapter();
    const registry = testRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await runtime.pauseQueue();

    assert.equal(state.pauseCalls, 1);
    assert.equal(state.resumeCalls, 0);
  });

  it('resumeQueue calls through to producer.resume', async () => {
    const { adapter, state } = pauseAdapter();
    const registry = testRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await runtime.resumeQueue();

    assert.equal(state.resumeCalls, 1);
    assert.equal(state.pauseCalls, 0);
  });

  it('pauseQueue throws JobsRuntimeError when producer lacks pause', async () => {
    const { adapter } = noPauseAdapter();
    const registry = testRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await assert.rejects(
      async () => runtime.pauseQueue(),
      (err: unknown) => {
        assert.ok(err instanceof JobsRuntimeError);
        assert.match(err.message, /does not support pausing the queue/);
        return true;
      },
    );
  });

  it('resumeQueue throws JobsRuntimeError when producer lacks resume', async () => {
    const { adapter } = noPauseAdapter();
    const registry = testRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await assert.rejects(
      async () => runtime.resumeQueue(),
      (err: unknown) => {
        assert.ok(err instanceof JobsRuntimeError);
        assert.match(err.message, /does not support resuming the queue/);
        return true;
      },
    );
  });

  it('pauseQueue throws JobsRuntimeClosedError when runtime is closed', async () => {
    const { adapter } = pauseAdapter();
    const registry = testRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await runtime.close();

    await assert.rejects(
      async () => runtime.pauseQueue(),
      (err: unknown) => {
        assert.ok(err instanceof JobsRuntimeClosedError);
        return true;
      },
    );
  });

  it('resumeQueue throws JobsRuntimeClosedError when runtime is closed', async () => {
    const { adapter } = pauseAdapter();
    const registry = testRegistry();
    const runtime = createJobsRuntime({ registry, adapter });

    await runtime.close();

    await assert.rejects(
      async () => runtime.resumeQueue(),
      (err: unknown) => {
        assert.ok(err instanceof JobsRuntimeClosedError);
        return true;
      },
    );
  });
});
