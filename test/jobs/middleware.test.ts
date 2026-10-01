/**
 * Tests for per-job middleware: composition order, short-circuiting,
 * double-next rejection, error propagation, eager validation, payload/unknown
 * gating, context dispatch, and the no-middleware regression path.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  composeMiddleware,
  JobMiddlewareError,
  type JobMiddleware,
} from '../../src/jobs/middleware.js';
import {
  createJobRegistry,
  defineJob,
  JobNotRegisteredError,
  JobPayloadError,
} from '../../src/jobs/registry.js';
import {
  createJobsRuntime,
  type JobDispatchOptions,
  type JobsRuntimeAdapter,
  type ProcessJob,
  type RuntimeJob,
} from '../../src/jobs/runtime.js';

// ---------------------------------------------------------------------------
// Fake adapter (same pattern as jobs-adapter.test.ts)
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

/** Extract processJob from fake state, throwing if the worker wasn't started. */
function ensureProcessJob(state: FakeState): ProcessJob {
  if (state.processJob === undefined) {
    throw new Error('worker was not started — call runtime.startWorker() first');
  }
  return state.processJob;
}

// ---------------------------------------------------------------------------
// composeMiddleware unit tests
// ---------------------------------------------------------------------------

describe('composeMiddleware', () => {
  it('runs middleware in declared order before the handler', async () => {
    const sequence: string[] = [];

    const a: JobMiddleware = async (_data, _ctx, next) => {
      sequence.push('a-before');
      const result = await next();
      sequence.push('a-after');
      return result;
    };
    const b: JobMiddleware = async (_data, _ctx, next) => {
      sequence.push('b-before');
      const result = await next();
      sequence.push('b-after');
      return result;
    };
    const handler = async () => {
      sequence.push('handler');
    };

    const composed = composeMiddleware([a, b], handler);
    await composed(
      {},
      { name: 'test', jobId: undefined, options: undefined, dispatch: async () => {} },
    );

    assert.deepEqual(sequence, ['a-before', 'b-before', 'handler', 'b-after', 'a-after']);
  });

  it('short-circuits when a middleware does not call next()', async () => {
    const sequence: string[] = [];

    const a: JobMiddleware = async (_data, _ctx, _next) => {
      sequence.push('a');
      return 'short-circuited';
    };
    const b: JobMiddleware = async (_data, _ctx, next) => {
      sequence.push('b');
      return next();
    };
    const handler = async () => {
      sequence.push('handler');
    };

    const composed = composeMiddleware([a, b], handler);
    const result = await composed(
      {},
      { name: 'test', jobId: undefined, options: undefined, dispatch: async () => {} },
    );

    assert.deepEqual(sequence, ['a']);
    assert.equal(result, 'short-circuited');
  });

  it('throws when next() is called twice', async () => {
    const mw: JobMiddleware = async (_data, _ctx, next) => {
      await next();
      await next();
    };

    const composed = composeMiddleware([mw], async () => {});
    await assert.rejects(
      composed(
        {},
        { name: 'test', jobId: undefined, options: undefined, dispatch: async () => {} },
      ),
      (err: unknown) => {
        assert.ok(err instanceof JobMiddlewareError);
        assert.equal(err.code, 'middleware_threw');
        return true;
      },
    );
  });

  it('propagates handler errors unwrapped through middleware', async () => {
    const handlerError = new Error('handler failed');
    const mw: JobMiddleware = async (_data, _ctx, next) => {
      return next();
    };

    const composed = composeMiddleware([mw], async () => {
      throw handlerError;
    });

    await assert.rejects(
      composed(
        {},
        { name: 'test', jobId: undefined, options: undefined, dispatch: async () => {} },
      ),
      (err: unknown) => err === handlerError,
    );
  });

  it('returns the handler directly when the middleware array is empty', async () => {
    const handler = async () => 'result';
    const composed = composeMiddleware([], handler);

    assert.strictEqual(composed, handler, 'empty middleware returns the handler unchanged');
  });
});

// ---------------------------------------------------------------------------
// Runtime integration tests
// ---------------------------------------------------------------------------

describe('job runtime middleware', () => {
  it('rejects a non-function middleware entry at construction time', () => {
    const { registry } = recordingRegistry();
    const { adapter } = fakeAdapter();

    assert.throws(
      () =>
        createJobsRuntime({
          registry,
          adapter,
          middleware: { sendEmail: ['not a function' as unknown as JobMiddleware] },
        }),
      (err: unknown) => {
        assert.ok(err instanceof JobMiddlewareError);
        assert.equal(err.code, 'invalid_middleware');
        return true;
      },
    );
  });

  it('runs payload validation before middleware', async () => {
    const { registry, handled } = recordingRegistry();
    const middlewareCalls: string[] = [];

    const mw: JobMiddleware = async (_data, _ctx, next) => {
      middlewareCalls.push('mw');
      return next();
    };

    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { sendEmail: [mw] },
    });

    // A job with an invalid payload must never reach middleware.
    const badJob = runtimeJob({
      name: 'sendEmail',
      data: { to: 42, subject: 'hi' },
    });

    await runtime.startWorker();
    const processJob = ensureProcessJob(state);
    await assert.rejects(processJob(badJob), (err: unknown) => err instanceof JobPayloadError);

    assert.deepEqual(middlewareCalls, []);
    assert.equal(handled.length, 0);
  });

  it('rejects an unknown job before middleware', async () => {
    const { registry } = recordingRegistry();
    const middlewareCalls: string[] = [];

    const mw: JobMiddleware = async (_data, _ctx, next) => {
      middlewareCalls.push('mw');
      return next();
    };

    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { sendEmail: [mw] },
    });

    const unknownJob = runtimeJob({ name: 'missing', data: {} });

    await runtime.startWorker();
    const processJob = ensureProcessJob(state);
    await assert.rejects(
      processJob(unknownJob),
      (err: unknown) => err instanceof JobNotRegisteredError,
    );

    assert.deepEqual(middlewareCalls, []);
  });

  it('works correctly when middleware is configured for a job', async () => {
    const { registry, handled } = recordingRegistry();
    const sequence: string[] = [];

    const a: JobMiddleware = async (_data, _ctx, next) => {
      sequence.push('a');
      return next();
    };
    const b: JobMiddleware = async (_data, _ctx, next) => {
      sequence.push('b');
      return next();
    };

    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { sendEmail: [a, b] },
    });

    await runtime.startWorker();
    const processJob = ensureProcessJob(state);
    await processJob(runtimeJob());

    assert.deepEqual(sequence, ['a', 'b']);
    assert.equal(handled.length, 1);
    assert.deepEqual(handled[0]!.data, { to: 'a@b.co', subject: 'hi' });
  });

  it('short-circuits handler when middleware does not call next()', async () => {
    const { registry, handled } = recordingRegistry();

    const mw: JobMiddleware = async (_data, _ctx, _next) => {
      return 'short-circuited-value';
    };

    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { sendEmail: [mw] },
    });

    await runtime.startWorker();
    const processJob = ensureProcessJob(state);
    const result = await processJob(runtimeJob());

    assert.equal(result, 'short-circuited-value');
    assert.equal(handled.length, 0, 'handler must not be called');
  });

  it('exposes a working dispatch on the middleware context', async () => {
    const { registry, handled } = recordingRegistry();
    const dispatchCalls: Array<{ name: string; payload: unknown }> = [];

    const mw: JobMiddleware = async (_data, ctx, next) => {
      dispatchCalls.push({
        name: 'sendEmail',
        payload: { to: 'chain@x.co', subject: 'chained' },
      });
      await ctx.dispatch('sendEmail', { to: 'chain@x.co', subject: 'chained' });
      return next();
    };

    // Create a registry with both sendEmail and log jobs.
    const logJob = defineJob(z.object({ message: z.string() }), async (data, ctx) => {
      handled.push({ data, jobId: ctx.jobId, name: ctx.name });
    });
    const sendEmail = registry.sendEmail!;
    const fullRegistry = createJobRegistry({
      sendEmail,
      log: logJob,
    });

    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({
      registry: fullRegistry,
      adapter,
      middleware: { sendEmail: [mw] },
    });

    await runtime.startWorker();
    const processJob = ensureProcessJob(state);
    await processJob(runtimeJob());

    assert.equal(handled.length, 1, 'the original handler was called');
    assert.equal(dispatchCalls.length, 1);
    assert.equal(state.dispatched.length, 1);
    assert.equal(state.dispatched[0]!.name, 'sendEmail');
    assert.deepEqual(state.dispatched[0]!.data, {
      to: 'chain@x.co',
      subject: 'chained',
    });
  });

  it('runs the handler unchanged when no middleware is configured (regression)', async () => {
    const { registry, handled } = recordingRegistry();
    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({ registry, adapter });

    await runtime.startWorker();
    const processJob = ensureProcessJob(state);
    await processJob(runtimeJob());

    assert.equal(handled.length, 1);
    assert.deepEqual(handled[0]!.data, { to: 'a@b.co', subject: 'hi' });
    assert.equal(handled[0]!.name, 'sendEmail');
  });

  it('runs the handler unchanged when middleware map does not list the job', async () => {
    const { registry, handled } = recordingRegistry();
    const middlewareCalls: string[] = [];

    const mw: JobMiddleware = async (_data, _ctx, next) => {
      middlewareCalls.push('mw');
      return next();
    };

    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({
      registry,
      adapter,
      middleware: { otherJob: [mw] },
    });

    await runtime.startWorker();
    const processJob = ensureProcessJob(state);
    await processJob(runtimeJob());

    assert.equal(handled.length, 1);
    assert.deepEqual(middlewareCalls, [], 'middleware for a different job must not fire');
  });

  it('propagates handler errors unwrapped through middleware', async () => {
    const handlerError = new Error('handler failed');
    const failingJob = defineJob(z.object({ n: z.number() }), async () => {
      throw handlerError;
    });

    const mw: JobMiddleware = async (_data, _ctx, next) => {
      return next();
    };

    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({
      registry: createJobRegistry({ fail: failingJob }),
      adapter,
      middleware: { fail: [mw] },
    });

    await runtime.startWorker();
    const processJob = ensureProcessJob(state);
    await assert.rejects(
      processJob(runtimeJob({ name: 'fail', data: { n: 1 } })),
      (err: unknown) => err === handlerError,
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RecordedCall {
  data: unknown;
  jobId: string | undefined;
  name: string;
}

function recordingRegistry(): {
  registry: ReturnType<typeof createJobRegistry>;
  handled: RecordedCall[];
} {
  const handled: RecordedCall[] = [];
  const sendEmail = defineJob(
    z.object({ to: z.string(), subject: z.string() }),
    async (data, context) => {
      handled.push({ data, jobId: context.jobId, name: context.name });
    },
  );
  return { registry: createJobRegistry({ sendEmail }), handled };
}
