/**
 * Tests for the durable schedule-pause store and its integration with
 * `createJobsRuntime`: memory store CRUD, runtime with/without a store,
 * cache-backed persistence, and error branches.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { createMemoryCacheStore } from '../../src/cache/store.js';
import {
  createCachePausedScheduleStore,
  createMemoryPausedScheduleStore,
  PausedScheduleError,
} from '../../src/jobs/paused-schedules.js';
import { createJobRegistry, defineJob } from '../../src/jobs/registry.js';
import {
  createJobsRuntime,
  type JobDispatchOptions,
  type JobsRuntimeAdapter,
  type ProcessJob,
} from '../../src/jobs/runtime.js';

/** Fake adapter state shared across tests for schedule capture. */
interface FakeState {
  upsertSchedulesCalledWith: Array<{ id: string; job: string }> | undefined;
  pauseSchedulesCalledWith: { ids: readonly string[] } | undefined;
  producerCreates: number;
}

/**
 * Build a fake adapter that records what `upsertSchedules` and `pauseSchedules`
 * received. The adapter itself performs no real queue work.
 */
function fakeAdapter(): { adapter: JobsRuntimeAdapter; state: FakeState } {
  const state: FakeState = {
    upsertSchedulesCalledWith: undefined,
    pauseSchedulesCalledWith: undefined,
    producerCreates: 0,
  };

  const adapter: JobsRuntimeAdapter = {
    name: 'fake',
    createProducer() {
      state.producerCreates += 1;
      return {
        dispatch(_name, _data, _dispatchOptions: JobDispatchOptions) {
          return Promise.resolve({ queued: _name });
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
    upsertSchedules(_producer, schedules) {
      state.upsertSchedulesCalledWith = schedules.map((s) => ({
        id: s.id,
        job: s.job,
      }));
      return Promise.resolve();
    },
    pauseSchedules(_producer, ids) {
      state.pauseSchedulesCalledWith = { ids };
      return Promise.resolve();
    },
  };

  return { adapter, state };
}

function registry() {
  const digest = defineJob(z.object({ to: z.string(), subject: z.string() }), async () => {});
  const report = defineJob(z.object({ reportId: z.number() }), async () => {});
  return createJobRegistry({ digest, report });
}

// ---------------------------------------------------------------------------
// Memory store unit tests
// ---------------------------------------------------------------------------

describe('createMemoryPausedScheduleStore', () => {
  it('isPaused returns false for an unknown id', async () => {
    const store = createMemoryPausedScheduleStore();
    assert.equal(await store.isPaused('digest'), false);
  });

  it('setPaused then isPaused returns true', async () => {
    const store = createMemoryPausedScheduleStore();
    await store.setPaused(['digest']);
    assert.equal(await store.isPaused('digest'), true);
  });

  it('setPaused is idempotent', async () => {
    const store = createMemoryPausedScheduleStore();
    await store.setPaused(['digest']);
    await store.setPaused(['digest']);
    assert.equal(await store.isPaused('digest'), true);
  });

  it('clearPaused removes a paused id', async () => {
    const store = createMemoryPausedScheduleStore();
    await store.setPaused(['digest']);
    await store.clearPaused(['digest']);
    assert.equal(await store.isPaused('digest'), false);
  });

  it('clearPaused is a no-op on an unknown id', async () => {
    const store = createMemoryPausedScheduleStore();
    await store.clearPaused(['unknown']);
    assert.equal(await store.isPaused('unknown'), false);
  });

  it('setPaused and clearPaused on multiple ids', async () => {
    const store = createMemoryPausedScheduleStore();
    await store.setPaused(['a', 'b', 'c']);
    assert.equal(await store.isPaused('a'), true);
    assert.equal(await store.isPaused('b'), true);
    assert.equal(await store.isPaused('c'), true);

    await store.clearPaused(['a', 'c']);
    assert.equal(await store.isPaused('a'), false);
    assert.equal(await store.isPaused('b'), true);
    assert.equal(await store.isPaused('c'), false);
  });
});

// ---------------------------------------------------------------------------
// Runtime with a durable memory store
// ---------------------------------------------------------------------------

describe('durable schedule pause via JobsRuntime', () => {
  it('pauseSchedules persists paused ids to the store', async () => {
    const store = createMemoryPausedScheduleStore();
    const { adapter } = fakeAdapter();
    const runtime = createJobsRuntime({
      registry: registry(),
      adapter,
      pausedSchedules: store,
    });

    await runtime.pauseSchedules(['digest']);
    assert.equal(await store.isPaused('digest'), true);

    await runtime.close();
  });

  it('upsertSchedules skips paused ids when the store has them', async () => {
    const store = createMemoryPausedScheduleStore();
    await store.setPaused(['digest']);
    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({
      registry: registry(),
      adapter,
      pausedSchedules: store,
    });

    await runtime.upsertSchedules([
      { id: 'digest', job: 'digest', everyMs: 60000 },
      { id: 'report', job: 'report', everyMs: 60000 },
    ]);

    // Only `report` should have been passed through; `digest` is paused.
    assert.deepEqual(state.upsertSchedulesCalledWith, [{ id: 'report', job: 'report' }]);

    await runtime.close();
  });

  it('pauseSchedules then upsertSchedules: paused id stays skipped', async () => {
    const store = createMemoryPausedScheduleStore();
    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({
      registry: registry(),
      adapter,
      pausedSchedules: store,
    });

    // Pause digest via the runtime.
    await runtime.pauseSchedules(['digest']);
    assert.equal(await store.isPaused('digest'), true);

    // Now simulate a `work` restart: upsertSchedules re-evaluates.
    await runtime.upsertSchedules([
      { id: 'digest', job: 'digest', everyMs: 60000 },
      { id: 'report', job: 'report', everyMs: 60000 },
    ]);

    assert.deepEqual(state.upsertSchedulesCalledWith, [{ id: 'report', job: 'report' }]);

    await runtime.close();
  });
});

// ---------------------------------------------------------------------------
// Runtime WITHOUT a store (non-durable, existing behaviour)
// ---------------------------------------------------------------------------

describe('non-durable pause (no store)', () => {
  it('pauseSchedules calls the adapter but does not persist', async () => {
    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({ registry: registry(), adapter });

    await runtime.pauseSchedules(['digest']);
    assert.deepEqual(state.pauseSchedulesCalledWith, { ids: ['digest'] });

    await runtime.close();
  });

  it('upsertSchedules re-registers everything even after a pause (non-durable)', async () => {
    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({ registry: registry(), adapter });

    await runtime.pauseSchedules(['digest']);

    // With no store, upsertSchedules always passes the full list.
    await runtime.upsertSchedules([
      { id: 'digest', job: 'digest', everyMs: 60000 },
      { id: 'report', job: 'report', everyMs: 60000 },
    ]);

    assert.deepEqual(state.upsertSchedulesCalledWith, [
      { id: 'digest', job: 'digest' },
      { id: 'report', job: 'report' },
    ]);

    await runtime.close();
  });

  it('upsertSchedules with no store and an empty schedule list still calls the adapter', async () => {
    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({ registry: registry(), adapter });

    await runtime.upsertSchedules([]);
    assert.deepEqual(state.upsertSchedulesCalledWith, []);

    await runtime.close();
  });
});

// ---------------------------------------------------------------------------
// Cache-backed store via an injected CacheStore
// ---------------------------------------------------------------------------

describe('createCachePausedScheduleStore', () => {
  it('setPaused writes through the cache, isPaused reads from it', async () => {
    const cache = createMemoryCacheStore();
    const store = createCachePausedScheduleStore(cache);

    await store.setPaused(['digest']);
    assert.equal(await store.isPaused('digest'), true);
    assert.equal(await store.isPaused('unknown'), false);
  });

  it('clearPaused removes the cache entry', async () => {
    const cache = createMemoryCacheStore();
    const store = createCachePausedScheduleStore(cache);

    await store.setPaused(['digest']);
    assert.equal(await store.isPaused('digest'), true);

    await store.clearPaused(['digest']);
    assert.equal(await store.isPaused('digest'), false);
  });

  it('throws PausedScheduleError on a malformed cache store', () => {
    assert.throws(
      () =>
        createCachePausedScheduleStore(
          null as unknown as ReturnType<typeof createMemoryCacheStore>,
        ),
      PausedScheduleError,
    );
    assert.throws(
      () => createCachePausedScheduleStore({} as ReturnType<typeof createMemoryCacheStore>),
      PausedScheduleError,
    );
  });

  it('respects a custom prefix', async () => {
    const cache = createMemoryCacheStore();
    const store = createCachePausedScheduleStore(cache, { prefix: 'myapp:pause' });

    await store.setPaused(['digest']);
    assert.equal(await store.isPaused('digest'), true);

    // The default-prefix key should not be present.
    const rawDefault = await cache.get('jsails:paused-schedule-digest');
    assert.equal(rawDefault, null);

    // But the custom prefix should.
    const rawCustom = await cache.get('myapp:pause-digest');
    assert.equal(rawCustom, '1');
  });

  it('runtime with a cache-backed store: pauseSchedules persists, upsertSchedules filters', async () => {
    const cache = createMemoryCacheStore();
    const store = createCachePausedScheduleStore(cache);
    const { adapter, state } = fakeAdapter();
    const runtime = createJobsRuntime({
      registry: registry(),
      adapter,
      pausedSchedules: store,
    });

    await runtime.pauseSchedules(['digest']);
    // The store should reflect the paused state.
    assert.equal(await store.isPaused('digest'), true);

    // UpsertSchedules should skip digest.
    await runtime.upsertSchedules([
      { id: 'digest', job: 'digest', everyMs: 60000 },
      { id: 'report', job: 'report', everyMs: 60000 },
    ]);

    assert.deepEqual(state.upsertSchedulesCalledWith, [{ id: 'report', job: 'report' }]);

    await runtime.close();
  });
});
