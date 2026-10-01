/**
 * Tests for job chaining: sequential on-success continuation via the
 * chainMiddleware + per-job middleware seam.
 *
 * All tests run against the same fake in-memory adapter as the adapter tests,
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
  chainMiddleware,
  CHAIN_OPTION_KEY,
  createJobChain,
  isChainDescriptor,
  JobChainError,
  type ChainStep,
} from '../../src/jobs/chain.js';

// ---------------------------------------------------------------------------
// Fake adapter (same pattern as jobs-adapter.test.ts:46-104)
// ---------------------------------------------------------------------------

interface FakeState {
  producerCreates: number;
  workerCreates: number;
  dispatched: Array<{ name: string; data: unknown; options: JobDispatchOptions }>;
  processJob: ProcessJob | undefined;
  /** Records the order in which handlers ran. */
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
    name: 'stepA',
    id: 'job-1',
    data: { n: 1 },
    attemptsMade: 0,
    attemptsStarted: 1,
    log: async () => undefined,
    updateProgress: async () => undefined,
    ...overrides,
  };
}

/** Build a chain descriptor as it would appear in dispatch options. */
function chainOpts(remaining: readonly ChainStep[]): Record<string, unknown> {
  return { [CHAIN_OPTION_KEY]: { remaining } };
}

// ---------------------------------------------------------------------------
// Registry: three simple step jobs, each recording its handler invocation.
// ---------------------------------------------------------------------------

interface RecordingRegistry {
  registry: ReturnType<typeof createJobRegistry>;
  calls: string[];
}

function recordingRegistry(): RecordingRegistry {
  const calls: string[] = [];
  const stepA = defineJob(z.object({ n: z.number() }), async (_data, _ctx) => {
    calls.push('stepA');
  });
  const stepB = defineJob(z.object({ n: z.number() }), async (_data, _ctx) => {
    calls.push('stepB');
  });
  const stepC = defineJob(z.object({ n: z.number() }), async (_data, _ctx) => {
    calls.push('stepC');
  });
  return { registry: createJobRegistry({ stepA, stepB, stepC }), calls };
}

describe('job chaining', () => {
  // --- Creation validation ---

  it('rejects an empty chain with value-free error', () => {
    const { registry } = recordingRegistry();
    const { adapter } = fakeAdapter();
    const runtime = createJobsRuntime({ registry, adapter });

    try {
      createJobChain(runtime, []);
      assert.fail('expected JobChainError');
    } catch (error) {
      assert.ok(error instanceof JobChainError);
      assert.equal(error.code, 'empty_chain');
      assert.equal(error.message, 'empty_chain');
    }
  });

  it('rejects a step missing a job name', () => {
    const { registry } = recordingRegistry();
    const { adapter } = fakeAdapter();
    const runtime = createJobsRuntime({ registry, adapter });

    // Missing job field
    try {
      createJobChain(runtime, [{ data: { n: 1 } } as unknown as ChainStep]);
      assert.fail('expected JobChainError');
    } catch (error) {
      assert.ok(error instanceof JobChainError);
      assert.equal(error.code, 'invalid_step');
    }

    // Empty job string
    try {
      createJobChain(runtime, [{ job: '  ', data: { n: 1 } }]);
      assert.fail('expected JobChainError');
    } catch (error) {
      assert.ok(error instanceof JobChainError);
      assert.equal(error.code, 'invalid_step');
    }
  });

  it('never echoes step data in error messages', () => {
    const { registry } = recordingRegistry();
    const { adapter } = fakeAdapter();
    const runtime = createJobsRuntime({ registry, adapter });

    try {
      createJobChain(runtime, [{ data: { secret: 'abc' } } as unknown as ChainStep]);
      assert.fail('expected JobChainError');
    } catch (error) {
      assert.ok(error instanceof JobChainError);
      // Messages are value-free: the code name, never step data.
      assert.doesNotMatch(error.message, /secret/);
      assert.doesNotMatch(error.message, /abc/);
    }

    try {
      createJobChain(runtime, []);
      assert.fail('expected JobChainError');
    } catch (error) {
      assert.ok(error instanceof JobChainError);
      assert.equal(error.message, 'empty_chain');
    }
  });

  // --- dispatch() enqueues step 1 with chain descriptor ---

  it('dispatch() enqueues step 1 with the chain descriptor carrying remaining steps', async () => {
    const { registry } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({ registry, adapter });

    const steps: ChainStep[] = [
      { job: 'stepA', data: { n: 1 } },
      { job: 'stepB', data: { n: 2 } },
      { job: 'stepC', data: { n: 3 } },
    ];
    const chain = createJobChain(runtime, steps);
    const result = await chain.dispatch();

    assert.deepEqual(result, { queued: 'stepA' });
    assert.equal(state.dispatched.length, 1);
    assert.equal(state.dispatched[0]!.name, 'stepA');
    assert.deepEqual(state.dispatched[0]!.data, { n: 1 });

    // The first dispatch carries the remaining two steps.
    const options = state.dispatched[0]!.options;
    const descriptor = options[CHAIN_OPTION_KEY] as { remaining: readonly ChainStep[] };
    assert.ok(descriptor);
    assert.equal(descriptor.remaining.length, 2);
    assert.deepEqual(descriptor.remaining[0], { job: 'stepB', data: { n: 2 } });
    assert.deepEqual(descriptor.remaining[1], { job: 'stepC', data: { n: 3 } });
  });

  // --- Sequential execution ---

  it('executes steps sequentially: each step is dispatched only after the previous handler succeeds', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: {
        stepA: [chainMiddleware],
        stepB: [chainMiddleware],
        stepC: [chainMiddleware],
      },
    });

    await runtime.startWorker();
    assert.ok(state.processJob);

    // Dispatch step 1 directly (mimicking what createJobChain().dispatch() does)
    const steps: ChainStep[] = [
      { job: 'stepA', data: { n: 1 } },
      { job: 'stepB', data: { n: 2 } },
      { job: 'stepC', data: { n: 3 } },
    ];
    const [first, second, third] = steps;

    // Dispatch stepA with the chain descriptor.
    const descriptor = chainOpts([second!, third!]);
    await runtime.dispatch('stepA', first!.data, descriptor);

    assert.equal(state.dispatched.length, 1);
    assert.equal(state.dispatched[0]!.name, 'stepA');

    // Process stepA: the middleware should enqueue stepB on success.
    await state.processJob(
      runtimeJob({
        name: 'stepA',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'stepA');
    assert.equal(state.dispatched.length, 2);
    assert.equal(state.dispatched[1]!.name, 'stepB');
    // stepB carries only the final remaining step (stepC).
    const stepBOpts = state.dispatched[1]!.options;
    const stepBDescriptor = stepBOpts[CHAIN_OPTION_KEY] as { remaining: readonly ChainStep[] };
    assert.equal(stepBDescriptor.remaining.length, 1);
    assert.deepEqual(stepBDescriptor.remaining[0], { job: 'stepC', data: { n: 3 } });

    // Process stepB: the middleware should enqueue stepC.
    await state.processJob(
      runtimeJob({
        name: 'stepB',
        data: { n: 2 },
        opts: stepBOpts,
      }),
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[1], 'stepB');
    assert.equal(state.dispatched.length, 3);
    assert.equal(state.dispatched[2]!.name, 'stepC');
    // stepC carries an empty remaining array.
    const stepCOpts = state.dispatched[2]!.options;
    const stepCDescriptor = stepCOpts[CHAIN_OPTION_KEY] as { remaining: readonly ChainStep[] };
    assert.equal(stepCDescriptor.remaining.length, 0);

    // Process stepC: no more steps to dispatch.
    await state.processJob(
      runtimeJob({
        name: 'stepC',
        data: { n: 3 },
        opts: stepCOpts,
      }),
    );

    assert.equal(calls.length, 3);
    assert.equal(calls[2], 'stepC');
    assert.equal(state.dispatched.length, 3, 'no extra dispatch after the last step');
  });

  // --- Stop on failure ---

  it('stops the chain when a handler throws and does not dispatch the next step', async () => {
    // Registry where stepB's handler always throws.
    const failCalls: string[] = [];
    const stepA = defineJob(z.object({ n: z.number() }), async (_data, _ctx) => {
      failCalls.push('stepA');
    });
    const stepB = defineJob(z.object({ n: z.number() }), async (_data, _ctx) => {
      failCalls.push('stepB');
      throw new Error('stepB failed');
    });
    const stepC = defineJob(z.object({ n: z.number() }), async (_data, _ctx) => {
      failCalls.push('stepC');
    });
    const registry = createJobRegistry({ stepA, stepB, stepC });

    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: {
        stepA: [chainMiddleware],
        stepB: [chainMiddleware],
        stepC: [chainMiddleware],
      },
    });

    await runtime.startWorker();

    // Dispatch stepA with chain descriptor pointing to stepB then stepC.
    const steps: ChainStep[] = [
      { job: 'stepA', data: { n: 1 } },
      { job: 'stepB', data: { n: 2 } },
      { job: 'stepC', data: { n: 3 } },
    ];
    const [first, second, third] = steps;
    const descriptor = chainOpts([second!, third!]);
    await runtime.dispatch('stepA', first!.data, descriptor);

    // Process stepA — should succeed and enqueue stepB.
    await state.processJob!(
      runtimeJob({
        name: 'stepA',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );
    assert.deepEqual(failCalls, ['stepA']);
    assert.equal(state.dispatched.length, 2);
    assert.equal(state.dispatched[1]!.name, 'stepB');

    // Process stepB — its handler throws. The chain middleware must NOT
    // dispatch stepC, and the error must propagate.
    await assert.rejects(
      state.processJob!(
        runtimeJob({
          name: 'stepB',
          data: { n: 2 },
          opts: state.dispatched[1]!.options,
        }),
      ),
      /stepB failed/,
    );

    assert.deepEqual(failCalls, ['stepA', 'stepB']);
    // stepC must never be dispatched.
    assert.equal(state.dispatched.length, 2);
    const dispatchedNames = state.dispatched.map((d) => d.name);
    assert.ok(!dispatchedNames.includes('stepC'));
  });

  // --- Payload validation still applies ---

  it('validates each step payload on dispatch', async () => {
    const { registry } = recordingRegistry();
    const { adapter } = fakeAdapter();
    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: {
        stepA: [chainMiddleware],
        stepB: [chainMiddleware],
      },
    });

    // stepA expects { n: number }, not { n: 'bad' }.
    const steps: ChainStep[] = [
      { job: 'stepA', data: { n: 'bad' } },
      { job: 'stepB', data: { n: 2 } },
    ];
    const chain = createJobChain(runtime, steps);

    // `n` is not a number — payload validation rejects before the producer is called.
    await assert.rejects(chain.dispatch(), /invalid payload/);
  });

  // --- Single-step chain ---

  it('dispatches a single-step chain once and stops', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: {
        stepA: [chainMiddleware],
      },
    });

    await runtime.startWorker();

    const steps: ChainStep[] = [{ job: 'stepA', data: { n: 1 } }];
    const chain = createJobChain(runtime, steps);
    await chain.dispatch();

    assert.equal(state.dispatched.length, 1);
    assert.equal(state.dispatched[0]!.name, 'stepA');
    // A single-step chain carries an empty remaining array.
    const options = state.dispatched[0]!.options;
    const descriptor = options[CHAIN_OPTION_KEY] as { remaining: readonly ChainStep[] };
    assert.equal(descriptor.remaining.length, 0);

    // Process stepA — no further dispatch.
    await state.processJob!(
      runtimeJob({
        name: 'stepA',
        data: { n: 1 },
        opts: options,
      }),
    );

    assert.deepEqual(calls, ['stepA']);
    assert.equal(state.dispatched.length, 1, 'no extra dispatch for a single-step chain');
  });

  // --- Step-level dispatch options are forwarded ---

  it('forwards per-step dispatch options alongside the chain descriptor', async () => {
    const { registry } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: {
        stepA: [chainMiddleware],
        stepB: [chainMiddleware],
      },
    });

    const steps: ChainStep[] = [
      { job: 'stepA', data: { n: 1 }, opts: { delay: 5000 } },
      { job: 'stepB', data: { n: 2 }, opts: { priority: 10 } },
    ];
    const chain = createJobChain(runtime, steps);
    await chain.dispatch();

    assert.equal(state.dispatched.length, 1);
    // stepA carries its delay option.
    assert.equal(state.dispatched[0]!.options.delay, 5000);
    // Chain descriptor is present.
    assert.ok(state.dispatched[0]!.options[CHAIN_OPTION_KEY]);
  });

  // --- Malformed descriptor: fail safe ---

  it('does not dispatch next step when chain descriptor has a null element (fail safe)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { stepA: [chainMiddleware] },
    });
    await runtime.startWorker();

    // Malformed: remaining contains null instead of a step object.
    const malformed = { [CHAIN_OPTION_KEY]: { remaining: [null] } };
    await runtime.dispatch('stepA', { n: 1 }, malformed);

    assert.equal(state.dispatched.length, 1);
    assert.equal(state.dispatched[0]!.name, 'stepA');

    // Process stepA — handler must run, but no next step is dispatched.
    await state.processJob!(
      runtimeJob({
        name: 'stepA',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.deepEqual(calls, ['stepA']);
    assert.equal(state.dispatched.length, 1, 'no extra dispatch on malformed descriptor');
  });

  it('does not dispatch next step when a step has a non-string job (fail safe)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { stepA: [chainMiddleware] },
    });
    await runtime.startWorker();

    // Step object exists but job is a number instead of a string.
    const malformed = { [CHAIN_OPTION_KEY]: { remaining: [{ job: 123, data: { n: 2 } }] } };
    await runtime.dispatch('stepA', { n: 1 }, malformed);

    await state.processJob!(
      runtimeJob({
        name: 'stepA',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.deepEqual(calls, ['stepA']);
    assert.equal(state.dispatched.length, 1, 'no extra dispatch on step with non-string job');
  });

  it('does not dispatch next step when a step has an empty job string (fail safe)', async () => {
    const { registry, calls } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { stepA: [chainMiddleware] },
    });
    await runtime.startWorker();

    const malformed = { [CHAIN_OPTION_KEY]: { remaining: [{ job: '', data: { n: 2 } }] } };
    await runtime.dispatch('stepA', { n: 1 }, malformed);

    await state.processJob!(
      runtimeJob({
        name: 'stepA',
        data: { n: 1 },
        opts: state.dispatched[0]!.options,
      }),
    );

    assert.deepEqual(calls, ['stepA']);
    assert.equal(state.dispatched.length, 1, 'no extra dispatch on step with empty job');
  });
});

describe('isChainDescriptor', () => {
  it('returns false for null', () => {
    assert.equal(isChainDescriptor(null), false);
  });

  it('returns false for a plain empty object', () => {
    assert.equal(isChainDescriptor({}), false);
  });

  it('returns false when remaining is not an array', () => {
    assert.equal(isChainDescriptor({ remaining: 'x' }), false);
  });

  it('returns false when remaining contains null', () => {
    assert.equal(isChainDescriptor({ remaining: [null] }), false);
  });

  it('returns false when a step has an empty job string', () => {
    assert.equal(isChainDescriptor({ remaining: [{ job: '' }] }), false);
  });

  it('returns false when a step has no job field', () => {
    assert.equal(isChainDescriptor({ remaining: [{ data: { n: 1 } }] }), false);
  });

  it('returns false when a step has a non-string job', () => {
    assert.equal(isChainDescriptor({ remaining: [{ job: 123 }] }), false);
  });

  it('returns true for a well-formed descriptor', () => {
    assert.equal(isChainDescriptor({ remaining: [{ job: 'stepB', data: { n: 2 } }] }), true);
  });

  it('returns true for a descriptor with an empty remaining array', () => {
    assert.equal(isChainDescriptor({ remaining: [] }), true);
  });
});
