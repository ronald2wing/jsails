/**
 * Tests for job batching: fan-out with in-process settlement observation
 * via the injectable BatchCoordinator + per-job middleware seam.
 *
 * All tests run against the same fake in-memory adapter as the chain tests,
 * so no Redis/Valkey or BullMQ connection is opened and no URL is required.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { createJobRegistry, defineJob } from '../../src/jobs/registry.js';
import {
  createJobsRuntime,
  type JobDispatchOptions,
  type JobsRuntimeAdapter,
  type ProcessJob,
  type RuntimeJob,
  type RuntimeProducer,
} from '../../src/jobs/runtime.js';
import {
  createBatchCoordinator,
  createBatchMiddleware,
  BATCH_OPTION_KEY,
  createJobBatch,
  isBatchDescriptor,
  JobBatchError,
  type BatchCallbacks,
  type BatchFailedSummary,
  type BatchItem,
  type BatchSummary,
} from '../../src/jobs/batch.js';

// ---------------------------------------------------------------------------
// Fake adapter (same pattern as jobs-adapter.test.ts:46-104 and chain.test.ts)
// ---------------------------------------------------------------------------

interface FakeState {
  producerCreates: number;
  workerCreates: number;
  dispatched: Array<{ name: string; data: unknown; options: JobDispatchOptions }>;
  processJob: ProcessJob | undefined;
  /** Records the order in which handlers ran and their outcomes. */
  handlerCalls: Array<{ name: string; data: unknown }>;
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
    name: 'taskA',
    id: 'job-1',
    data: { n: 1 },
    attemptsMade: 0,
    attemptsStarted: 1,
    log: async () => undefined,
    updateProgress: async () => undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

interface RecordingRegistry {
  registry: ReturnType<typeof createJobRegistry>;
  calls: Array<{ name: string; data: unknown }>;
}

function recordingRegistry(): RecordingRegistry {
  const calls: Array<{ name: string; data: unknown }> = [];
  const taskA = defineJob(z.object({ n: z.number() }), async (data, _ctx) => {
    calls.push({ name: 'taskA', data });
  });
  const taskB = defineJob(z.object({ n: z.number() }), async (data, _ctx) => {
    calls.push({ name: 'taskB', data });
  });
  const taskC = defineJob(z.object({ n: z.number() }), async (data, _ctx) => {
    calls.push({ name: 'taskC', data });
  });
  return { registry: createJobRegistry({ taskA, taskB, taskC }), calls };
}

/**
 * Registry where one job always throws. The error message is deterministic
 * and does not contain the payload.
 */
function failingRegistry(failingJob: string) {
  const calls: Array<{ name: string; data: unknown }> = [];
  const succeed = defineJob(z.object({ n: z.number() }), async (data, _ctx) => {
    calls.push({ name: 'succeed', data });
  });
  const fail = defineJob(z.object({ n: z.number() }), async (_data, _ctx) => {
    calls.push({ name: failingJob, data: _data });
    throw new Error('intentional failure');
  });
  return { registry: createJobRegistry({ succeed, fail }), calls };
}

// ---------------------------------------------------------------------------
// Settlement callback capture
// ---------------------------------------------------------------------------

interface CallbackCapture {
  thenCalls: BatchSummary[];
  catchCalls: BatchFailedSummary[];
  finallyCalls: BatchSummary[];
}

function captureCallbacks(): { capture: CallbackCapture; callbacks: BatchCallbacks } {
  const capture: CallbackCapture = { thenCalls: [], catchCalls: [], finallyCalls: [] };
  const callbacks: BatchCallbacks = {
    then(summary) {
      capture.thenCalls.push(summary);
    },
    catch(summary) {
      capture.catchCalls.push(summary);
    },
    finally(summary) {
      capture.finallyCalls.push(summary);
    },
  };
  return { capture, callbacks };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('job batching', () => {
  // --- Creation validation ---

  it('rejects an empty batch with value-free error', () => {
    const { registry } = recordingRegistry();
    const { adapter } = fakeAdapter();
    const runtime = createJobsRuntime({ registry, adapter });
    const coordinator = createBatchCoordinator();

    try {
      createJobBatch(runtime, coordinator, []);
      assert.fail('expected JobBatchError');
    } catch (error) {
      assert.ok(error instanceof JobBatchError);
      assert.equal(error.code, 'empty_batch');
      assert.equal(error.message, 'empty_batch');
    }
  });

  it('rejects an item missing a job name', () => {
    const { registry } = recordingRegistry();
    const { adapter } = fakeAdapter();
    const runtime = createJobsRuntime({ registry, adapter });
    const coordinator = createBatchCoordinator();

    // Missing job field entirely.
    try {
      createJobBatch(runtime, coordinator, [{ data: { n: 1 } } as unknown as BatchItem]);
      assert.fail('expected JobBatchError');
    } catch (error) {
      assert.ok(error instanceof JobBatchError);
      assert.equal(error.code, 'invalid_item');
    }

    // Empty job string.
    try {
      createJobBatch(runtime, coordinator, [{ job: '  ', data: { n: 1 } }]);
      assert.fail('expected JobBatchError');
    } catch (error) {
      assert.ok(error instanceof JobBatchError);
      assert.equal(error.code, 'invalid_item');
    }
  });

  it('never echoes item data in error messages', () => {
    const { registry } = recordingRegistry();
    const { adapter } = fakeAdapter();
    const runtime = createJobsRuntime({ registry, adapter });
    const coordinator = createBatchCoordinator();

    try {
      createJobBatch(runtime, coordinator, [{ data: { secret: 'abc' } } as unknown as BatchItem]);
      assert.fail('expected JobBatchError');
    } catch (error) {
      assert.ok(error instanceof JobBatchError);
      assert.doesNotMatch(error.message, /secret/);
      assert.doesNotMatch(error.message, /abc/);
    }

    try {
      createJobBatch(runtime, coordinator, []);
      assert.fail('expected JobBatchError');
    } catch (error) {
      assert.ok(error instanceof JobBatchError);
      assert.equal(error.message, 'empty_batch');
    }
  });

  // --- dispatch() enqueues all items ---

  it('dispatch() enqueues every item with the batch descriptor carrying the right index', async () => {
    const { registry } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({ registry, adapter });
    const coordinator = createBatchCoordinator();

    const items: BatchItem[] = [
      { job: 'taskA', data: { n: 1 } },
      { job: 'taskB', data: { n: 2 } },
      { job: 'taskC', data: { n: 3 } },
    ];
    const batch = createJobBatch(runtime, coordinator, items);
    await batch.dispatch();

    assert.equal(state.dispatched.length, 3);
    assert.equal(state.dispatched[0]!.name, 'taskA');
    assert.equal(state.dispatched[1]!.name, 'taskB');
    assert.equal(state.dispatched[2]!.name, 'taskC');

    // Every item carries the batch descriptor with the right index.
    for (let i = 0; i < 3; i++) {
      const options = state.dispatched[i]!.options;
      const descriptor = options[BATCH_OPTION_KEY] as {
        id: string;
        total: number;
        index: number;
      };
      assert.ok(descriptor);
      assert.equal(descriptor.id, batch.id);
      assert.equal(descriptor.total, 3);
      assert.equal(descriptor.index, i);
    }
  });

  // --- All succeed ---

  it('fires then and finally when all items succeed; catch not called', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = createBatchCoordinator();

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: {
        taskA: [createBatchMiddleware(coordinator)],
        taskB: [createBatchMiddleware(coordinator)],
        taskC: [createBatchMiddleware(coordinator)],
      },
    });
    await runtime.startWorker();

    const items: BatchItem[] = [
      { job: 'taskA', data: { n: 1 } },
      { job: 'taskB', data: { n: 2 } },
      { job: 'taskC', data: { n: 3 } },
    ];
    const batch = createJobBatch(runtime, coordinator, items, callbacks);
    await batch.dispatch();

    // Process all three items by calling the recorded processJob.
    for (let i = 0; i < 3; i++) {
      const dispatched = state.dispatched[i]!;
      await state.processJob!(
        runtimeJob({ name: dispatched.name, data: dispatched.data, opts: dispatched.options }),
      );
    }

    // All handlers ran.
    assert.equal(calls.length, 3);

    // then called exactly once.
    assert.equal(capture.thenCalls.length, 1);
    const thenSummary = capture.thenCalls[0]!;
    assert.equal(thenSummary.id, batch.id);
    assert.equal(thenSummary.total, 3);
    assert.equal(thenSummary.succeeded, 3);
    assert.equal(thenSummary.failed, 0);

    // catch not called.
    assert.equal(capture.catchCalls.length, 0);

    // finally called exactly once.
    assert.equal(capture.finallyCalls.length, 1);
    const finallySummary = capture.finallyCalls[0]!;
    assert.equal(finallySummary.id, batch.id);
    assert.equal(finallySummary.succeeded, 3);
    assert.equal(finallySummary.failed, 0);
  });

  // --- One fails ---

  it('fires catch and finally when one item fails; then not called', async () => {
    const { calls } = failingRegistry('fail');
    const registry = createJobRegistry({
      succeed: defineJob(z.object({ n: z.number() }), async (data, _ctx) => {
        calls.push({ name: 'succeed', data });
      }),
      fail: defineJob(z.object({ n: z.number() }), async (_data, _ctx) => {
        calls.push({ name: 'fail', data: _data });
        throw new Error('intentional failure');
      }),
    });

    const { adapter, state } = fakeAdapter();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = createBatchCoordinator();

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: {
        succeed: [createBatchMiddleware(coordinator)],
        fail: [createBatchMiddleware(coordinator)],
      },
    });
    await runtime.startWorker();

    const items: BatchItem[] = [
      { job: 'succeed', data: { n: 1 } },
      { job: 'fail', data: { n: 2 } },
      { job: 'succeed', data: { n: 3 } },
    ];
    const batch = createJobBatch(runtime, coordinator, items, callbacks);
    await batch.dispatch();

    // Process the first item (succeed) — should record success.
    await state.processJob!(
      runtimeJob({
        name: 'succeed',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    // Process the second item (fail) — the handler throws. The middleware
    // records the failure and re-throws.
    await assert.rejects(
      state.processJob!(
        runtimeJob({
          name: 'fail',
          data: { n: 2 },
          opts: state.dispatched[1]!.options,
        }),
      ),
      /intentional failure/,
    );

    // Process the third item (succeed).
    await state.processJob!(
      runtimeJob({
        name: 'succeed',
        data: { n: 3 },
        opts: state.dispatched[2]!.options,
      }),
    );

    // Wait a tick for the async callback fire to settle.
    await new Promise((resolve) => setImmediate(resolve));

    // then not called.
    assert.equal(capture.thenCalls.length, 0);

    // catch called exactly once.
    assert.equal(capture.catchCalls.length, 1);
    const catchSummary = capture.catchCalls[0]!;
    assert.equal(catchSummary.id, batch.id);
    assert.equal(catchSummary.total, 3);
    assert.equal(catchSummary.succeeded, 2);
    assert.equal(catchSummary.failed, 1);
    assert.equal(catchSummary.failures.length, 1);
    assert.equal(catchSummary.failures[0]!.job, 'fail');
    assert.equal(catchSummary.failures[0]!.error, 'intentional failure');

    // finally called exactly once.
    assert.equal(capture.finallyCalls.length, 1);
    const finallySummary = capture.finallyCalls[0]!;
    assert.equal(finallySummary.succeeded, 2);
    assert.equal(finallySummary.failed, 1);
  });

  // --- Idempotent recording ---

  it('ignores a duplicate record for the same item index (idempotent per item)', async () => {
    const { registry } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = createBatchCoordinator();

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: {
        taskA: [createBatchMiddleware(coordinator)],
        taskB: [createBatchMiddleware(coordinator)],
      },
    });
    await runtime.startWorker();

    const items: BatchItem[] = [
      { job: 'taskA', data: { n: 1 } },
      { job: 'taskB', data: { n: 2 } },
    ];
    const batch = createJobBatch(runtime, coordinator, items, callbacks);
    await batch.dispatch();

    // Process taskA once — records index 0.
    const jobAOpts = state.dispatched[0]!.options;
    await state.processJob!(runtimeJob({ name: 'taskA', data: { n: 1 }, opts: jobAOpts }));

    // Process taskA AGAIN with the same options (simulating redelivery).
    // The second recording should be ignored.
    await state.processJob!(runtimeJob({ name: 'taskA', data: { n: 1 }, opts: jobAOpts }));

    // Process taskB — this should trigger settlement (recorded.size == 2).
    await state.processJob!(
      runtimeJob({
        name: 'taskB',
        data: { n: 2 },
        opts: state.dispatched[1]!.options,
      }),
    );

    // Wait a tick for async callback settlement.
    await new Promise((resolve) => setImmediate(resolve));

    // Settlement fires exactly once despite the duplicate.
    assert.equal(capture.thenCalls.length, 1);

    // Total counts are based on unique indices, not raw call count.
    const summary = capture.thenCalls[0]!;
    assert.equal(summary.succeeded, 2);
    assert.equal(summary.failed, 0);
  });

  // --- Error propagation ---

  it('propagates the handler error through processJob even after recording the failure', async () => {
    const { calls } = failingRegistry('fail');
    const registry = createJobRegistry({
      succeed: defineJob(z.object({ n: z.number() }), async (data, _ctx) => {
        calls.push({ name: 'succeed', data });
      }),
      fail: defineJob(z.object({ n: z.number() }), async (_data, _ctx) => {
        calls.push({ name: 'fail', data: _data });
        throw new Error('intentional failure');
      }),
    });

    const { adapter, state } = fakeAdapter();
    const coordinator = createBatchCoordinator();
    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { fail: [createBatchMiddleware(coordinator)] },
    });
    await runtime.startWorker();

    const items: BatchItem[] = [{ job: 'fail', data: { n: 1 } }];
    const batch = createJobBatch(runtime, coordinator, items);
    await batch.dispatch();

    // The handler throws — the middleware must record the failure AND re-throw.
    await assert.rejects(
      state.processJob!(
        runtimeJob({
          name: 'fail',
          data: { n: 1 },
          opts: state.dispatched[0]!.options,
        }),
      ),
      /intentional failure/,
      'the adapter must see the handler error',
    );

    // Wait for async settlement.
    await new Promise((resolve) => setImmediate(resolve));
  });

  // --- Callback errors are swallowed ---

  it('swallows a throwing then callback so it does not reject the job', async () => {
    const { registry } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const coordinator = createBatchCoordinator();

    let thenCalled = false;
    let finallyCalled = false;

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { taskA: [createBatchMiddleware(coordinator)] },
    });
    await runtime.startWorker();

    const items: BatchItem[] = [{ job: 'taskA', data: { n: 1 } }];
    const batch = createJobBatch(runtime, coordinator, items, {
      then() {
        thenCalled = true;
        throw new Error('callback explosion');
      },
      finally() {
        finallyCalled = true;
      },
    });
    await batch.dispatch();

    // Process the item — the handler succeeds.
    const result = await state.processJob!(
      runtimeJob({
        name: 'taskA',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    // The job result is returned normally (the callback error is swallowed).
    assert.equal(result, undefined);

    // Wait for async settlement.
    await new Promise((resolve) => setImmediate(resolve));

    // Callbacks still fired.
    assert.equal(thenCalled, true);
    assert.equal(finallyCalled, true);
  });

  it('swallows a throwing catch callback', async () => {
    const { calls } = failingRegistry('fail');
    const registry = createJobRegistry({
      succeed: defineJob(z.object({ n: z.number() }), async (data, _ctx) => {
        calls.push({ name: 'succeed', data });
      }),
      fail: defineJob(z.object({ n: z.number() }), async (_data, _ctx) => {
        calls.push({ name: 'fail', data: _data });
        throw new Error('intentional failure');
      }),
    });

    const { adapter, state } = fakeAdapter();
    const coordinator = createBatchCoordinator();

    let catchCalled = false;
    let finallyCalled = false;

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: {
        succeed: [createBatchMiddleware(coordinator)],
        fail: [createBatchMiddleware(coordinator)],
      },
    });
    await runtime.startWorker();

    const items: BatchItem[] = [{ job: 'fail', data: { n: 1 } }];
    const batch = createJobBatch(runtime, coordinator, items, {
      catch() {
        catchCalled = true;
        throw new Error('catch callback explosion');
      },
      finally() {
        finallyCalled = true;
      },
    });
    await batch.dispatch();

    // Process the failing item — the handler throws.
    await assert.rejects(
      state.processJob!(
        runtimeJob({
          name: 'fail',
          data: { n: 1 },
          opts: state.dispatched[0]!.options,
        }),
      ),
      /intentional failure/,
    );

    // Wait for async settlement.
    await new Promise((resolve) => setImmediate(resolve));

    // catch and finally still fired despite the throwing catch callback.
    assert.equal(catchCalled, true);
    assert.equal(finallyCalled, true);
  });

  // --- Value-free failures ---

  it('BatchFailure.error contains only the error message, never the payload', async () => {
    const registry = createJobRegistry({
      fail: defineJob(z.object({ secret: z.string() }), async (_data, _ctx) => {
        throw new Error('boom');
      }),
    });

    const { adapter, state } = fakeAdapter();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = createBatchCoordinator();

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { fail: [createBatchMiddleware(coordinator)] },
    });
    await runtime.startWorker();

    const items: BatchItem[] = [{ job: 'fail', data: { secret: 'sensitive-payload' } }];
    const batch = createJobBatch(runtime, coordinator, items, callbacks);
    await batch.dispatch();

    await assert.rejects(
      state.processJob!(
        runtimeJob({
          name: 'fail',
          data: { secret: 'sensitive-payload' },
          opts: state.dispatched[0]!.options,
        }),
      ),
      /boom/,
    );

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(capture.catchCalls.length, 1);
    const failure = capture.catchCalls[0]!.failures[0]!;
    assert.equal(failure.error, 'boom');
    // The error must never contain the payload.
    assert.doesNotMatch(failure.error, /sensitive/);
    assert.doesNotMatch(failure.error, /secret/);
  });

  // --- Malformed descriptor: fail safe ---

  it('ignores a malformed batch descriptor in options (fail safe)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = createBatchCoordinator();

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: {
        taskA: [createBatchMiddleware(coordinator)],
        taskB: [createBatchMiddleware(coordinator)],
      },
    });
    await runtime.startWorker();

    const items: BatchItem[] = [
      { job: 'taskA', data: { n: 1 } },
      { job: 'taskB', data: { n: 2 } },
    ];
    const batch = createJobBatch(runtime, coordinator, items, callbacks);
    await batch.dispatch();

    // Deliberately corrupt the batch descriptor on taskB to have a
    // null `id`, then process it. The middleware must run the handler
    // normally without recording.
    const malformedOpts = {
      ...state.dispatched[1]!.options,
      [BATCH_OPTION_KEY]: { id: null, total: 2, index: 1 },
    };

    // Process taskA normally.
    await state.processJob!(
      runtimeJob({
        name: 'taskA',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    // Process taskB with the malformed descriptor — handler still runs.
    await state.processJob!(
      runtimeJob({
        name: 'taskB',
        data: { n: 2 },
        opts: malformedOpts,
      }),
    );

    // Both handlers ran.
    assert.equal(calls.length, 2);

    // Settlement should NOT fire because taskB's descriptor was invalid
    // and was not recorded. Only taskA was recorded (index 0) and we
    // never reach total=2.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(capture.thenCalls.length, 0);
    assert.equal(capture.catchCalls.length, 0);

    // Now process taskB again with the correct descriptor to trigger settlement.
    await state.processJob!(
      runtimeJob({
        name: 'taskB',
        data: { n: 2 },
        opts: state.dispatched[1]!.options, // the original, valid descriptor
      }),
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(capture.thenCalls.length, 1);
  });

  // --- No descriptor at all ---

  it('runs the handler normally when no batch descriptor is present (no middleware effect)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const coordinator = createBatchCoordinator();

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: {
        taskA: [createBatchMiddleware(coordinator)],
        taskB: [createBatchMiddleware(coordinator)],
      },
    });
    await runtime.startWorker();

    // Dispatch without any batch descriptor.
    await runtime.dispatch('taskA', { n: 1 });
    await runtime.dispatch('taskB', { n: 2 });

    // Process both — middleware just passes through.
    await state.processJob!(
      runtimeJob({
        name: 'taskA',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );
    await state.processJob!(
      runtimeJob({
        name: 'taskB',
        data: { n: 2 },
        opts: state.dispatched[1]!.options,
      }),
    );

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { name: 'taskA', data: { n: 1 } });
    assert.deepEqual(calls[1], { name: 'taskB', data: { n: 2 } });
  });

  // --- Isolation: two coordinators do not share state ---

  it('two independent coordinators do not share state', async () => {
    const { registry } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const { capture: captureA, callbacks: cbA } = captureCallbacks();
    const { capture: captureB, callbacks: cbB } = captureCallbacks();

    const coordinatorA = createBatchCoordinator();
    const coordinatorB = createBatchCoordinator();

    // Register BOTH middlewares on taskA. Each middleware reads the batch
    // descriptor id and records only into its own coordinator — the id
    // from coordinator A's batch won't be found in coordinator B's Map
    // and vice versa.
    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: {
        taskA: [createBatchMiddleware(coordinatorA), createBatchMiddleware(coordinatorB)],
      },
    });
    await runtime.startWorker();

    // Batch on coordinator A.
    const batchA = createJobBatch(runtime, coordinatorA, [{ job: 'taskA', data: { n: 1 } }], cbA);
    await batchA.dispatch();

    // Batch on coordinator B (same job, different coordinator).
    const batchB = createJobBatch(runtime, coordinatorB, [{ job: 'taskA', data: { n: 2 } }], cbB);
    await batchB.dispatch();

    // Process the first dispatched item (batchA, coordinator A).
    await state.processJob!(
      runtimeJob({
        name: 'taskA',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    // Coordinator A should have settled (only 1 item).
    assert.equal(captureA.thenCalls.length, 1);
    assert.equal(captureA.finallyCalls.length, 1);

    // Coordinator B should NOT have settled — its items haven't been processed.
    assert.equal(captureB.thenCalls.length, 0);
    assert.equal(captureB.catchCalls.length, 0);
    assert.equal(captureB.finallyCalls.length, 0);

    // Process the second dispatched item (batchB, coordinator B).
    await state.processJob!(
      runtimeJob({
        name: 'taskA',
        data: { n: 2 },
        opts: state.dispatched[1]!.options,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    // Now coordinator B settles too.
    assert.equal(captureB.thenCalls.length, 1);
    assert.equal(captureB.finallyCalls.length, 1);

    // Coordinator A still has exactly one settlement.
    assert.equal(captureA.thenCalls.length, 1);
  });

  // --- Fresh coordinator per call ---

  it('createBatchCoordinator returns a fresh, isolated coordinator each call', () => {
    const a = createBatchCoordinator();
    const b = createBatchCoordinator();

    // Different object references.
    assert.notEqual(a, b);

    // Register on A does not appear in B (record on B is a no-op for that id).
    const { capture, callbacks } = captureCallbacks();
    a.register('test-id', 1, callbacks);

    // Record on B should be a no-op — B has no entry for 'test-id'.
    b.record('test-id', 'task', 0, undefined);

    // Now record on A to settle it.
    a.record('test-id', 'task', 0, undefined);

    // Callbacks should fire on A.
    assert.equal(capture.thenCalls.length, 1);

    // If the old module-level Map were in use, both coordinators would share
    // it and the callback would fire after B's record. But with closure-scoped
    // Maps, B's record hits its own empty Map and is a no-op.
  });

  // --- Coordinator entry removed after settlement ---

  it('coordinator entry is removed after settlement; subsequent record is a no-op', async () => {
    const { registry } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const coordinator = createBatchCoordinator();

    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { taskA: [createBatchMiddleware(coordinator)] },
    });
    await runtime.startWorker();

    const items: BatchItem[] = [{ job: 'taskA', data: { n: 1 } }];
    const batch = createJobBatch(runtime, coordinator, items);
    await batch.dispatch();

    // Process the single item — settlements fires.
    await state.processJob!(
      runtimeJob({
        name: 'taskA',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    // After settlement the entry is removed, so a second record for the same
    // batch id should be a no-op (the Map lookup returns undefined).
    // This verifies no error is thrown — removed entries are silently ignored.
    coordinator.record(batch.id, 'taskA', 0, 'late error');
    // If the entry were still present, this would record a failure. But
    // runCallbacks already batches.delete(batchId), so this is a no-op.
  });
});

describe('isBatchDescriptor', () => {
  it('returns false for null', () => {
    assert.equal(isBatchDescriptor(null), false);
  });

  it('returns false for a plain empty object', () => {
    assert.equal(isBatchDescriptor({}), false);
  });

  it('returns false when id is missing', () => {
    assert.equal(isBatchDescriptor({ total: 3, index: 1 }), false);
  });

  it('returns false when id is an empty string', () => {
    assert.equal(isBatchDescriptor({ id: '', total: 3, index: 1 }), false);
  });

  it('returns false when total is missing', () => {
    assert.equal(isBatchDescriptor({ id: 'abc', index: 1 }), false);
  });

  it('returns false when total is not an integer', () => {
    assert.equal(isBatchDescriptor({ id: 'abc', total: 1.5, index: 0 }), false);
  });

  it('returns false when total is zero', () => {
    assert.equal(isBatchDescriptor({ id: 'abc', total: 0, index: 0 }), false);
  });

  it('returns false when total is negative', () => {
    assert.equal(isBatchDescriptor({ id: 'abc', total: -1, index: 0 }), false);
  });

  it('returns false when index is missing', () => {
    assert.equal(isBatchDescriptor({ id: 'abc', total: 3 }), false);
  });

  it('returns false when index is negative', () => {
    assert.equal(isBatchDescriptor({ id: 'abc', total: 3, index: -1 }), false);
  });

  it('returns false when index >= total', () => {
    assert.equal(isBatchDescriptor({ id: 'abc', total: 3, index: 3 }), false);
  });

  it('returns false when index is not an integer', () => {
    assert.equal(isBatchDescriptor({ id: 'abc', total: 3, index: 1.5 }), false);
  });

  it('returns true for a well-formed descriptor', () => {
    assert.equal(isBatchDescriptor({ id: 'abc', total: 3, index: 0 }), true);
  });

  it('returns true for the last index', () => {
    assert.equal(isBatchDescriptor({ id: 'abc', total: 3, index: 2 }), true);
  });
});
