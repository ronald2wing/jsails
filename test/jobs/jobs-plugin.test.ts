/**
 * Tests for the first-party `jobs` plugin: the dispatch-only service exposed
 * under `jobsToken`, its fully lazy construction, delegation to the neutral
 * runtime, idempotent cleanup, and value-free construction errors. Everything
 * runs against an in-memory adapter, so no Valkey/Redis or BullMQ connection is
 * opened and no URL is required.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { runExtensions } from '../../src/extensions/extension.js';
import { createJobRegistry, defineJob } from '../../src/jobs/registry.js';
import { jobsPlugin, jobsToken, type JobsService } from '../../src/jobs/plugin.js';
import type { JobDispatchOptions, JobsRuntimeAdapter } from '../../src/jobs/runtime.js';

interface FakeState {
  producerCreates: number;
  producerCloses: number;
  dispatched: Array<{ name: string; data: unknown; options: JobDispatchOptions }>;
}

/** A minimal in-memory adapter; no backend, no URL, no connection. */
function fakeAdapter(): { adapter: JobsRuntimeAdapter; state: FakeState } {
  const state: FakeState = { producerCreates: 0, producerCloses: 0, dispatched: [] };
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
          state.producerCloses += 1;
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

const registry = createJobRegistry({
  sendEmail: defineJob(z.object({ to: z.string(), subject: z.string() }), async () => undefined),
});

describe('jobsPlugin', () => {
  it('constructs no runtime until the first dispatch', async () => {
    const { adapter, state } = fakeAdapter();
    const runtime = await runExtensions([jobsPlugin({ registry, adapter })]);
    try {
      assert.equal(state.producerCreates, 0);
      const service = runtime.services.get(jobsToken);
      assert.equal(typeof service.dispatch, 'function');
      assert.equal(state.producerCreates, 0, 'setup never constructs the runtime');
    } finally {
      await runtime.close();
    }
  });

  it('dispatches through the runtime and reuses the producer across calls', async () => {
    const { adapter, state } = fakeAdapter();
    const runtime = await runExtensions([jobsPlugin({ registry, adapter })]);
    try {
      const service: JobsService = runtime.services.get(jobsToken);
      const result = await service.dispatch(
        'sendEmail',
        { to: 'a@b.co', subject: 'hi' },
        { jobId: 'id-1' },
      );
      assert.deepEqual(result, { queued: 'sendEmail' });
      assert.equal(state.producerCreates, 1);
      assert.deepEqual(state.dispatched, [
        {
          name: 'sendEmail',
          data: { to: 'a@b.co', subject: 'hi' },
          options: { jobId: 'id-1' },
        },
      ]);

      await service.dispatch('sendEmail', { to: 'c@d.co', subject: 'yo' });
      assert.equal(state.producerCreates, 1, 'the producer handle is reused');
      assert.equal(state.dispatched.length, 2);
    } finally {
      await runtime.close();
    }
  });

  it('closes the runtime exactly once, and is a no-op when never constructed', async () => {
    // Never dispatched: close is a no-op with nothing to tear down.
    const idle = await runExtensions([jobsPlugin({ registry, adapter: fakeAdapter().adapter })]);
    await idle.close();
    await idle.close();

    // Dispatched once, then closed twice: the producer closes exactly once.
    const { adapter, state } = fakeAdapter();
    const runtime = await runExtensions([jobsPlugin({ registry, adapter })]);
    await runtime.services.get(jobsToken).dispatch('sendEmail', { to: 'a@b.co', subject: 'hi' });
    await runtime.close();
    await runtime.close();
    assert.equal(state.producerCloses, 1);
    assert.equal(state.producerCreates, 1);
  });

  it('rejects a missing or non-object registry at construction', () => {
    assert.throws(() => jobsPlugin({} as never), TypeError);
    assert.throws(() => jobsPlugin({ registry: null } as never), TypeError);
    assert.throws(() => jobsPlugin(null as never), TypeError);
  });

  it('exposes a stable jobsToken singleton', async () => {
    assert.equal(jobsToken.name, 'jobs');
    const again = await import('../../src/jobs/plugin.js');
    assert.equal(again.jobsToken, jobsToken);
  });
});
