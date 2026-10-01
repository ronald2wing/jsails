/**
 * Tests for overlap control middleware: mutex-backed prevention of concurrent
 * scheduled job runs via the per-job middleware seam.
 *
 * All tests run against the same fake in-memory adapter as the chain and
 * batch tests, so no Redis/Valkey or BullMQ connection is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { createMemoryMutexStore, type MutexStore } from '../../src/cache/mutex.js';
import { createJobRegistry, defineJob } from '../../src/jobs/registry.js';
import {
  createJobsRuntime,
  type JobDispatchOptions,
  type JobsRuntimeAdapter,
  type ProcessJob,
  type RuntimeJob,
  type RuntimeProducer,
} from '../../src/jobs/runtime.js';
import { createOverlapMiddleware, OVERLAP_OPTION_KEY } from '../../src/jobs/overlap.js';
import { isOverlapDescriptor } from '../../src/jobs/scheduler.js';

// ---------------------------------------------------------------------------
// Fake adapter (same pattern as chain.test.ts and batch.test.ts)
// ---------------------------------------------------------------------------

interface FakeState {
  producerCreates: number;
  workerCreates: number;
  dispatched: Array<{ name: string; data: unknown; options: JobDispatchOptions }>;
  processJob: ProcessJob | undefined;
  handlerCalls: string[];
}

function fakeAdapter(): { adapter: JobsRuntimeAdapter; state: FakeState } {
  const state: FakeState = {
    producerCreates: 0,
    workerCreates: 0,
    dispatched: [],
    processJob: undefined,
    handlerCalls: [],
  };

  const adapter: JobsRuntimeAdapter = {
    name: 'fake',
    createProducer() {
      state.producerCreates += 1;
      return Promise.resolve({
        dispatch(name, data, dispatchOptions) {
          state.dispatched.push({ name, data, options: dispatchOptions });
          return Promise.resolve({ queued: name });
        },
        close() {
          return Promise.resolve();
        },
      } satisfies RuntimeProducer);
    },
    createWorker(_context, processJob) {
      state.workerCreates += 1;
      state.processJob = processJob;
      return Promise.resolve({
        close() {
          return Promise.resolve();
        },
      });
    },
  };

  return { adapter, state };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runtimeJob(overrides: Partial<RuntimeJob> = {}): RuntimeJob {
  return {
    name: 'testJob',
    id: 'job-1',
    data: { n: 1 },
    attemptsMade: 0,
    attemptsStarted: 1,
    log: async () => undefined,
    updateProgress: async () => undefined,
    ...overrides,
  };
}

/** Build dispatch options carrying an overlap descriptor. */
function overlapOpts(key: string, ttlMs: number): Record<string, unknown> {
  return { [OVERLAP_OPTION_KEY]: { key, ttlMs } };
}

// ---------------------------------------------------------------------------
// Registry: a job that records every handler invocation.
// ---------------------------------------------------------------------------

interface RecordingRegistry {
  registry: ReturnType<typeof createJobRegistry>;
  calls: Array<{ name: string; data: unknown }>;
}

function recordingRegistry(): RecordingRegistry {
  const calls: Array<{ name: string; data: unknown }> = [];
  const testJob = defineJob(z.object({ n: z.number() }), async (data, _ctx) => {
    calls.push({ name: 'testJob', data });
  });
  return { registry: createJobRegistry({ testJob }), calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('overlap middleware', () => {
  // --- No descriptor: pass through ---

  it('runs the handler normally when no overlap descriptor is present in options', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const mutex = createMemoryMutexStore();

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(mutex)] },
    });
    await runtime.startWorker();

    // Dispatch without any overlap descriptor.
    await runtime.dispatch('testJob', { n: 1 });

    await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { name: 'testJob', data: { n: 1 } });
  });

  it('passes through next() result when no overlap descriptor is present (no side effect)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const mutex = createMemoryMutexStore();

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(mutex)] },
    });
    await runtime.startWorker();

    // Dispatch without any overlap descriptor.
    await runtime.dispatch('testJob', { n: 1 });

    const result = await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    // The middleware calls next() whose result is void (the handler returns void).
    assert.equal(result, undefined);
    assert.equal(calls.length, 1, 'handler ran through the middleware');
  });

  // --- Malformed descriptor: fail safe ---

  it('runs handler normally when descriptor has a non-string key (fail safe)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const mutex = createMemoryMutexStore();

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(mutex)] },
    });
    await runtime.startWorker();

    // Malformed: key is not a string.
    const malformed = { [OVERLAP_OPTION_KEY]: { key: 1, ttlMs: 5000 } };
    await runtime.dispatch('testJob', { n: 1 }, malformed);

    await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(calls.length, 1, 'handler ran despite malformed descriptor');
    assert.deepEqual(calls[0], { name: 'testJob', data: { n: 1 } });
  });

  it('runs handler normally when descriptor has a zero ttlMs (fail safe)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const mutex = createMemoryMutexStore();

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(mutex)] },
    });
    await runtime.startWorker();

    // Malformed: ttlMs is zero (not positive).
    const malformed = { [OVERLAP_OPTION_KEY]: { key: 'schedule:x', ttlMs: 0 } };
    await runtime.dispatch('testJob', { n: 1 }, malformed);

    await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(calls.length, 1, 'handler ran despite zero ttlMs');
  });

  it('runs handler normally when raw descriptor is null (fail safe)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const mutex = createMemoryMutexStore();

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(mutex)] },
    });
    await runtime.startWorker();

    const malformed = { [OVERLAP_OPTION_KEY]: null };
    await runtime.dispatch('testJob', { n: 1 }, malformed);

    await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(calls.length, 1, 'handler ran despite null descriptor');
  });

  it('runs handler normally when raw descriptor is a string (fail safe)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const mutex = createMemoryMutexStore();

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(mutex)] },
    });
    await runtime.startWorker();

    const malformed = { [OVERLAP_OPTION_KEY]: 'not-an-object' };
    await runtime.dispatch('testJob', { n: 1 }, malformed);

    await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(calls.length, 1, 'handler ran despite string descriptor');
  });

  it('runs handler normally when raw descriptor has an empty key (fail safe)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const mutex = createMemoryMutexStore();

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(mutex)] },
    });
    await runtime.startWorker();

    const malformed = { [OVERLAP_OPTION_KEY]: { key: '  ', ttlMs: 5000 } };
    await runtime.dispatch('testJob', { n: 1 }, malformed);

    await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(calls.length, 1, 'handler ran despite empty key');
  });

  it('runs handler normally when raw descriptor is missing the key field (fail safe)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const mutex = createMemoryMutexStore();

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(mutex)] },
    });
    await runtime.startWorker();

    const malformed = { [OVERLAP_OPTION_KEY]: { ttlMs: 5000 } };
    await runtime.dispatch('testJob', { n: 1 }, malformed);

    await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(calls.length, 1);
  });

  // --- Descriptor present, acquires mutex ---

  it('acquires mutex, runs handler, releases mutex when descriptor is valid', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const mutex = createMemoryMutexStore();

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(mutex)] },
    });
    await runtime.startWorker();

    const opts = overlapOpts('schedule:test', 5000);
    await runtime.dispatch('testJob', { n: 1 }, opts);

    await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(calls.length, 1, 'handler should have run');
    assert.deepEqual(calls[0], { name: 'testJob', data: { n: 1 } });

    // After release, another job should be able to acquire the same key
    // (the lock was released).
    const acquired = await mutex.acquire('schedule:test', 1000);
    assert.equal(acquired, true, 'mutex should be released after the handler completes');
  });

  // --- Mutex already held: skip ---

  it('skips invocation without calling handler when mutex is already held', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const mutex = createMemoryMutexStore();

    // Pre-acquire the mutex so the middleware cannot get it.
    const preAcquired = await mutex.acquire('schedule:locked', 60000);
    assert.equal(preAcquired, true, 'pre-acquire should succeed');

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(mutex)] },
    });
    await runtime.startWorker();

    const opts = overlapOpts('schedule:locked', 5000);
    await runtime.dispatch('testJob', { n: 1 }, opts);

    // The handler must not be called — the mutex is held.
    const result = await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(calls.length, 0, 'handler must not run when mutex is held');
    assert.equal(result, undefined, 'skipped invocation returns undefined');
  });

  it('returns undefined without throwing when mutex is held (not a failure)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const mutex = createMemoryMutexStore();

    // Pre-acquire the mutex.
    await mutex.acquire('schedule:held', 60000);

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(mutex)] },
    });
    await runtime.startWorker();

    const opts = overlapOpts('schedule:held', 5000);
    await runtime.dispatch('testJob', { n: 1 }, opts);

    // processJob must resolve (not reject) — the skip is not a failure.
    const result = await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(result, undefined);
    assert.equal(calls.length, 0);
  });

  // --- Handler throws: mutex still released ---

  it('releases mutex even when handler throws, and error propagates unchanged', async () => {
    const registry = createJobRegistry({
      testJob: defineJob(z.object({ n: z.number() }), async (_data, _ctx) => {
        throw new Error('handler failed');
      }),
    });
    const { adapter, state } = fakeAdapter();
    const mutex = createMemoryMutexStore();

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(mutex)] },
    });
    await runtime.startWorker();

    const opts = overlapOpts('schedule:throwing', 5000);
    await runtime.dispatch('testJob', { n: 1 }, opts);

    await assert.rejects(
      state.processJob!(
        runtimeJob({
          name: 'testJob',
          data: { n: 1 },
          opts: state.dispatched[0]!.options,
        }),
      ),
      /handler failed/,
      'the handler error must propagate to the caller',
    );

    // After the throw, the mutex must be released — another job should be
    // able to acquire the same key.
    const acquired = await mutex.acquire('schedule:throwing', 1000);
    assert.equal(
      acquired,
      true,
      'mutex must be released after handler throws so subsequent runs are not blocked',
    );
  });

  // --- Release throws: error swallowed, handler result propagates ---

  it('does not throw when release fails after a successful handler run', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();

    // Mutex store whose release always throws.
    const brokenMutex: MutexStore = {
      async acquire(_key, _ttlMs) {
        return true;
      },
      async release(_key) {
        throw new Error('release failed');
      },
      async close() {},
    };

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(brokenMutex)] },
    });
    await runtime.startWorker();

    const opts = overlapOpts('schedule:x', 5000);
    await runtime.dispatch('testJob', { n: 1 }, opts);

    // processJob must resolve normally — the release failure is swallowed.
    const result = await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(result, undefined);
    assert.equal(calls.length, 1, 'handler ran despite release failure');
  });

  it('propagates handler error unchanged when release throws', async () => {
    const registry = createJobRegistry({
      testJob: defineJob(z.object({ n: z.number() }), async (_data, _ctx) => {
        throw new Error('handler failed');
      }),
    });
    const { adapter, state } = fakeAdapter();

    // Mutex store whose release always throws.
    const brokenMutex: MutexStore = {
      async acquire(_key, _ttlMs) {
        return true;
      },
      async release(_key) {
        throw new Error('release failed');
      },
      async close() {},
    };

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(brokenMutex)] },
    });
    await runtime.startWorker();

    const opts = overlapOpts('schedule:x', 5000);
    await runtime.dispatch('testJob', { n: 1 }, opts);

    await assert.rejects(
      state.processJob!(
        runtimeJob({
          name: 'testJob',
          data: { n: 1 },
          opts: state.dispatched[0]!.options,
        }),
      ),
      /handler failed/,
      'the handler error, not the release error, must propagate',
    );
  });

  // --- Integration: two sequential runs with real memory mutex ---

  it('skips second run while first holds the lock (deferred handler)', async () => {
    const wrapped: Array<{ name: string }> = [];

    // Create a deferred promise so the first handler can be held while we
    // attempt a second run.
    let finishFirst: () => void;
    const firstDone = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });

    const registry = createJobRegistry({
      testJob: defineJob(z.object({ n: z.number() }), async (data, _ctx) => {
        wrapped.push({ name: `run-${data.n}` });
        if (data.n === 1) {
          // Hold handler 1 until we explicitly release it.
          await firstDone;
        }
      }),
    });

    const { adapter, state } = fakeAdapter();
    const mutex = createMemoryMutexStore();

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(mutex)] },
    });
    await runtime.startWorker();

    // Dispatch two runs with the same overlap key.
    const opts = overlapOpts('schedule:sequential', 30000);
    await runtime.dispatch('testJob', { n: 1 }, opts);
    await runtime.dispatch('testJob', { n: 2 }, opts);

    // Start processing run 1 — it will block on the deferred promise.
    const run1Promise = state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    // Process run 2 while run 1 is still in flight. It should be skipped.
    const run2Result = await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 2 },
        opts: state.dispatched[1]!.options,
      }),
    );

    assert.equal(run2Result, undefined, 'run 2 should be skipped');
    assert.deepEqual(wrapped, [{ name: 'run-1' }], 'only run 1 handler started');

    // Release run 1.
    finishFirst!();
    await run1Promise;

    assert.deepEqual(wrapped, [{ name: 'run-1' }], 'run 2 was never called');

    // After both complete, the mutex should be released (run 1 released it).
    const acquired = await mutex.acquire('schedule:sequential', 1000);
    assert.equal(acquired, true, 'mutex released after run 1 completes');
  });

  // --- Option allowlist: OVERLAP_OPTION_KEY survives validateJobOptions ---

  it('OVERLAP_OPTION_KEY survives the option allowlist and reaches middleware context', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const mutex = createMemoryMutexStore();

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { testJob: [createOverlapMiddleware(mutex)] },
    });
    await runtime.startWorker();

    // Dispatch with the overlap key — validateJobOptions must not reject it.
    const opts = overlapOpts('schedule:allowlist', 5000);
    await runtime.dispatch('testJob', { n: 1 }, opts);

    // The descriptor should be present in the dispatched options.
    const dispatchedOpts = state.dispatched[0]!.options;
    const raw = dispatchedOpts[OVERLAP_OPTION_KEY];
    assert.ok(
      isOverlapDescriptor(raw),
      'descriptor survives validateJobOptions and reaches dispatch options',
    );

    assert.equal(raw.key, 'schedule:allowlist');
    assert.equal(raw.ttlMs, 5000);

    // Process the job — handler runs normally.
    await state.processJob!(
      runtimeJob({
        name: 'testJob',
        data: { n: 1 },
        opts: dispatchedOpts,
      }),
    );

    assert.equal(calls.length, 1);
  });
});

describe('isOverlapDescriptor', () => {
  it('returns false for null', () => {
    assert.equal(isOverlapDescriptor(null), false);
  });

  it('returns false for a plain empty object', () => {
    assert.equal(isOverlapDescriptor({}), false);
  });

  it('returns false when key is missing', () => {
    assert.equal(isOverlapDescriptor({ ttlMs: 5000 }), false);
  });

  it('returns false when key is an empty string (after trim)', () => {
    assert.equal(isOverlapDescriptor({ key: '  ', ttlMs: 5000 }), false);
  });

  it('returns false when key is a number', () => {
    assert.equal(isOverlapDescriptor({ key: 1, ttlMs: 5000 }), false);
  });

  it('returns false when ttlMs is missing', () => {
    assert.equal(isOverlapDescriptor({ key: 'schedule:x' }), false);
  });

  it('returns false when ttlMs is zero', () => {
    assert.equal(isOverlapDescriptor({ key: 'schedule:x', ttlMs: 0 }), false);
  });

  it('returns false when ttlMs is negative', () => {
    assert.equal(isOverlapDescriptor({ key: 'schedule:x', ttlMs: -1 }), false);
  });

  it('returns false when ttlMs is NaN', () => {
    assert.equal(isOverlapDescriptor({ key: 'schedule:x', ttlMs: NaN }), false);
  });

  it('returns false when ttlMs is Infinity', () => {
    assert.equal(isOverlapDescriptor({ key: 'schedule:x', ttlMs: Infinity }), false);
  });

  it('returns false when ttlMs is a string', () => {
    assert.equal(isOverlapDescriptor({ key: 'schedule:x', ttlMs: '5000' }), false);
  });

  it('returns true for a well-formed descriptor', () => {
    assert.equal(isOverlapDescriptor({ key: 'schedule:test', ttlMs: 5000 }), true);
  });

  it('returns true for a custom key (not just schedule: prefix)', () => {
    assert.equal(isOverlapDescriptor({ key: 'custom-lock', ttlMs: 1000 }), true);
  });
});
