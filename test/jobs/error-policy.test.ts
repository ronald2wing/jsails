/**
 * Per-job error policy (`retryOn` / `discardOn`) — the `retry_on`/`discard_on`
 * analog — plus registry validation of malformed policies.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { defineJob, createJobRegistry } from '../../src/jobs/registry.js';
import {
  JobsRuntimeImpl,
  type JobsRuntimeAdapter,
  type ProcessJob,
  type RuntimeJob,
} from '../../src/jobs/runtime.js';

// ---------------------------------------------------------------------------
// Fake adapter (same pattern as middleware.test.ts)
// ---------------------------------------------------------------------------

interface FakeState {
  processJob: ProcessJob | undefined;
}

function fakeAdapter(): { adapter: JobsRuntimeAdapter; state: FakeState } {
  const state: FakeState = { processJob: undefined };
  const adapter: JobsRuntimeAdapter = {
    name: 'fake',
    createProducer() {
      return {
        dispatch(name, data, options) {
          return Promise.resolve({ queued: name, data, options });
        },
        close: () => Promise.resolve(),
      };
    },
    createWorker(_context, processJob) {
      state.processJob = processJob;
      return { close: () => Promise.resolve() };
    },
  };
  return { adapter, state };
}

function runtimeJob(overrides: Partial<RuntimeJob> = {}): RuntimeJob {
  return {
    name: 'work',
    id: 'job-1',
    data: {},
    attemptsMade: 0,
    attemptsStarted: 1,
    log: async () => undefined,
    updateProgress: async () => undefined,
    ...overrides,
  };
}

function ensureProcessJob(state: FakeState): ProcessJob {
  if (state.processJob === undefined) throw new Error('worker not started');
  return state.processJob;
}

async function runJob(
  definition: ReturnType<typeof defineJob>,
  signal?: { completed: string[]; failed: string[] },
): Promise<{ state: FakeState; error: unknown }> {
  const { adapter, state } = fakeAdapter();
  const runtime = new JobsRuntimeImpl({
    registry: createJobRegistry({ work: definition }),
    adapter,
  });
  await runtime.startWorker();
  const processJob = ensureProcessJob(state);
  let error: unknown;
  try {
    await processJob(runtimeJob());
  } catch (caught) {
    error = caught;
  }
  return { state, error };
  void signal;
}

describe('job error policy', () => {
  it('discardOn swallows a matching error so the job completes (no rethrow)', async () => {
    const job = defineJob(
      z.object({}),
      async () => {
        throw new Error('nothing to do');
      },
      {
        onError: {
          discardOn: (error) => error instanceof Error && error.message === 'nothing to do',
        },
      },
    );
    const { error } = await runJob(job);
    assert.equal(error, undefined);
  });

  it('retryOn rethrows a matching error so the transport can retry', async () => {
    const job = defineJob(
      z.object({}),
      async () => {
        throw new Error('transient');
      },
      { onError: { retryOn: (error) => error instanceof Error } },
    );
    const { error } = await runJob(job);
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'transient');
  });

  it('a non-matching discardOn does not swallow (error rethrows)', async () => {
    const job = defineJob(
      z.object({}),
      async () => {
        throw new Error('different');
      },
      { onError: { discardOn: (error) => error instanceof Error && error.message === 'nothing' } },
    );
    const { error } = await runJob(job);
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'different');
  });

  it('accepts a policy-aware job and validates malformed policies at registry build', () => {
    // A malformed predicate (non-function) is rejected eagerly.
    assert.throws(
      () =>
        createJobRegistry({
          work: defineJob(z.object({}), async () => {}, {
            onError: { retryOn: 'nope' as unknown as (e: unknown) => boolean },
          }),
        }),
      /retryOn must be a function/,
    );
  });
});
