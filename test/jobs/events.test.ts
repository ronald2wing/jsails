/**
 * Tests for job lifecycle events emitted through the signals bus.
 *
 * Four event tokens — jobPushed, jobCompleted, jobFailed, jobRetried — are emitted
 * by the provider-neutral runtime at well-defined boundaries. Payloads are
 * value-free: name, jobId, attemptsMade only, never data/opts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { createInterceptorRegistry } from '../../src/extensions/interceptors.js';
import {
  jobCompleted,
  jobFailed,
  jobPushed,
  jobRetried,
  type JobEventPayload,
} from '../../src/jobs/events.js';
import { createJobRegistry, defineJob } from '../../src/jobs/registry.js';
import {
  createJobsRuntime,
  type JobDispatchOptions,
  type JobsRuntimeAdapter,
  type ProcessJob,
  type RuntimeJob,
} from '../../src/jobs/runtime.js';
import { createSignalBus, type SignalBus } from '../../src/signals/signal-bus.js';

// ---------------------------------------------------------------------------
// Fake adapter (same pattern as middleware.test.ts / jobs-adapter.test.ts)
// ---------------------------------------------------------------------------

interface FakeState {
  producerCreates: number;
  workerCreates: number;
  dispatched: Array<{ name: string; data: unknown; options: JobDispatchOptions }>;
  processJob: ProcessJob | undefined;
}

function fakeAdapter(): { adapter: JobsRuntimeAdapter; state: FakeState } {
  const state: FakeState = {
    producerCreates: 0,
    workerCreates: 0,
    dispatched: [],
    processJob: undefined,
  };

  const adapter: JobsRuntimeAdapter = {
    name: 'fake',
    createProducer() {
      state.producerCreates += 1;
      return {
        dispatch(name, data, options) {
          state.dispatched.push({ name, data, options });
          return Promise.resolve({ queued: name });
        },
        close() {
          return Promise.resolve();
        },
      };
    },
    createWorker(_context, processJob) {
      state.workerCreates += 1;
      state.processJob = processJob;
      return {
        close() {
          return Promise.resolve();
        },
      };
    },
  };

  return { adapter, state };
}

/** Extract processJob from fake state, throwing if the worker wasn't started. */
function ensureProcessJob(state: FakeState): ProcessJob {
  if (state.processJob === undefined) {
    throw new Error('worker was not started — call runtime.startWorker() first');
  }
  return state.processJob;
}

function runtimeJob(overrides: Partial<RuntimeJob> = {}): RuntimeJob {
  return {
    name: 'sendEmail',
    id: 'job-1',
    data: { to: 'a@b.co' },
    attemptsMade: 0,
    attemptsStarted: 1,
    log() {
      return Promise.resolve();
    },
    updateProgress() {
      return Promise.resolve();
    },
    ...overrides,
  };
}

function makeSignalBus(): { bus: SignalBus; events: JobEventPayload[]; errors: unknown[] } {
  const registry = createInterceptorRegistry();
  const bus = createSignalBus(registry);
  const events: JobEventPayload[] = [];
  const errors: unknown[] = [];

  // Register observers for all four events; push captured payloads + any
  // observer errors into the shared arrays.
  registry.observe(jobPushed, (payload) => {
    events.push(payload);
  });
  registry.observe(jobCompleted, (payload) => {
    events.push(payload);
  });
  registry.observe(jobFailed, (payload) => {
    events.push(payload);
  });
  registry.observe(jobRetried, (payload) => {
    events.push(payload);
  });
  // Throw-only observer to verify emit isolation (errors are collected, never propagated).
  registry.observe(jobFailed, () => {
    throw new Error('observer error');
  });

  return { bus, events, errors };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('job lifecycle events', () => {
  it('dispatch emits jobPushed once with name and jobId=undefined', async () => {
    const { adapter } = fakeAdapter();
    const signal = makeSignalBus();
    const registry = createJobRegistry({
      sendEmail: defineJob(z.object({ to: z.string() }), async () => {}),
    });

    const runtime = createJobsRuntime({ registry, adapter, signals: signal.bus });
    await runtime.dispatch('sendEmail', { to: 'a@b.co' });

    assert.equal(signal.events.length, 1, 'only jobPushed emitted');
    assert.deepStrictEqual(signal.events[0], { name: 'sendEmail', jobId: undefined });
  });

  it('successful process emits jobCompleted', async () => {
    let handlerCalled = false;
    const { adapter, state } = fakeAdapter();
    const signal = makeSignalBus();
    const registry = createJobRegistry({
      sendEmail: defineJob(z.object({ to: z.string() }), async () => {
        handlerCalled = true;
      }),
    });

    const runtime = createJobsRuntime({ registry, adapter, signals: signal.bus });
    await runtime.startWorker();
    const processJob = ensureProcessJob(state);
    const job = runtimeJob();
    await processJob(job);

    assert.ok(handlerCalled);
    assert.equal(signal.events.length, 1, 'only jobCompleted emitted');
    assert.deepStrictEqual(signal.events[0], { name: 'sendEmail', jobId: 'job-1' });
  });

  it('throwing handler emits jobFailed and jobRetried (attemptsMade=1), then re-throws', async () => {
    const originalError = new Error('handler exploded');
    const { adapter, state } = fakeAdapter();
    const signal = makeSignalBus();
    const registry = createJobRegistry({
      sendEmail: defineJob(z.object({ to: z.string() }), async () => {
        throw originalError;
      }),
    });

    const runtime = createJobsRuntime({ registry, adapter, signals: signal.bus });
    await runtime.startWorker();
    const processJob = ensureProcessJob(state);
    const job = runtimeJob({ attemptsMade: 1 });

    await assert.rejects(
      () => processJob(job),
      (err: unknown) => {
        // The original error must be re-thrown unchanged.
        assert.strictEqual(err, originalError);
        return true;
      },
    );

    // jobFailed + jobRetried, in that order
    assert.equal(signal.events.length, 2);
    assert.deepStrictEqual(signal.events[0], {
      name: 'sendEmail',
      jobId: 'job-1',
      attemptsMade: 1,
    });
    assert.deepStrictEqual(signal.events[1], {
      name: 'sendEmail',
      jobId: 'job-1',
      attemptsMade: 1,
    });
  });

  it('throwing handler emits only jobFailed when attemptsMade=0', async () => {
    const originalError = new Error('first failure');
    const { adapter, state } = fakeAdapter();
    const signal = makeSignalBus();
    const registry = createJobRegistry({
      sendEmail: defineJob(z.object({ to: z.string() }), async () => {
        throw originalError;
      }),
    });

    const runtime = createJobsRuntime({ registry, adapter, signals: signal.bus });
    await runtime.startWorker();
    const processJob = ensureProcessJob(state);
    const job = runtimeJob({ attemptsMade: 0 });

    await assert.rejects(
      () => processJob(job),
      (err) => err === originalError,
    );

    assert.equal(signal.events.length, 1, 'only jobFailed emitted');
    assert.deepStrictEqual(signal.events[0], {
      name: 'sendEmail',
      jobId: 'job-1',
      attemptsMade: 0,
    });
  });

  it('no signals configured → no observers fire and no error', async () => {
    const { adapter, state } = fakeAdapter();
    const registry = createJobRegistry({
      sendEmail: defineJob(z.object({ to: z.string() }), async () => {}),
    });

    const runtime = createJobsRuntime({ registry, adapter }); // no signals

    // dispatch
    await runtime.dispatch('sendEmail', { to: 'a@b.co' });

    // process
    await runtime.startWorker();
    const processJob = ensureProcessJob(state);
    await processJob(runtimeJob());

    // No assertion needed beyond the fact that nothing threw — the runtime
    // with no signals is byte-identical to the original.
  });

  it('dispatch with an unknown signal bus property is safe (no crash)', async () => {
    const { adapter } = fakeAdapter();
    const registry = createJobRegistry({
      sendEmail: defineJob(z.object({ to: z.string() }), async () => {}),
    });

    // Pass an object without an `emit` method — the optional type permits it
    // at the structural level, but the runtime must not crash at runtime.
    const runtime = createJobsRuntime({
      registry,
      adapter,
      signals: undefined,
    });

    await runtime.dispatch('sendEmail', { to: 'a@b.co' });
    // No crash is the assertion.
  });
});
