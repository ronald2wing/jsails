/**
 * Tests for the shared-store batch coordinator backed by a {@link CacheStore}.
 *
 * Uses an in-memory fake cache so no Redis/Valkey connection is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSharedBatchCoordinator } from '../../src/jobs/shared-batch-coordinator.js';
import type {
  BatchCallbacks,
  BatchCoordinator,
  BatchFailedSummary,
  BatchSummary,
} from '../../src/jobs/batch.js';
import type { CacheStore } from '../../src/cache/store.js';

// ---------------------------------------------------------------------------
// Fake cache store (shared Map so two coordinators see the same state)
// ---------------------------------------------------------------------------

function fakeCacheStore(): CacheStore & { _store: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    _store: map,
    async get(key: string): Promise<string | null> {
      return map.get(key) ?? null;
    },
    async set(key: string, value: string, _ttlMs: number): Promise<void> {
      map.set(key, value);
    },
    async delete(key: string): Promise<void> {
      map.delete(key);
    },
    async remember(key: string, _ttlMs: number, loader: () => Promise<string>): Promise<string> {
      const cached = map.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const value = await loader();
      map.set(key, value);
      return value;
    },
    async close(): Promise<void> {
      map.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
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

/** Serialised state stored by the coordinator under `jsails:batch:<id>`. */
interface SerialisedState {
  id: string;
  total: number;
  recorded: number[];
  succeeded: number;
  failed: number;
  failures: Array<{ job: string; error: string }>;
}

function readState(
  cache: CacheStore & { _store: Map<string, string> },
  id: string,
): SerialisedState {
  const raw = cache._store.get(`jsails:batch:${id}`);
  assert.ok(raw !== undefined, `expected key jsails:batch:${id} to exist`);
  return JSON.parse(raw) as SerialisedState;
}

/** Wait one tick so fire-and-forget async work settles. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSharedBatchCoordinator', () => {
  // --- register persists ---

  it('register persists the initial serialised state under the batch key', () => {
    const cache = fakeCacheStore();
    const coordinator = createSharedBatchCoordinator(cache);

    coordinator.register('batch-1', 3, {});

    const state = readState(cache, 'batch-1');
    assert.equal(state.id, 'batch-1');
    assert.equal(state.total, 3);
    assert.deepEqual(state.recorded, []);
    assert.equal(state.succeeded, 0);
    assert.equal(state.failed, 0);
    assert.deepEqual(state.failures, []);
  });

  it('register includes a TTL on the persisted entry (via cache.set)', () => {
    const ttlValues: number[] = [];
    const cache: CacheStore = {
      get: async () => null,
      set: async (_key: string, _value: string, ttlMs: number) => {
        ttlValues.push(ttlMs);
      },
      delete: async () => undefined,
      remember: async (_key, _ttlMs, loader) => loader(),
      close: async () => undefined,
    };

    // Custom TTL.
    const a = createSharedBatchCoordinator(cache, { ttlMs: 60_000 });
    a.register('a', 1, {});
    assert.equal(ttlValues[ttlValues.length - 1], 60_000);

    // Default TTL (1 hour).
    const b = createSharedBatchCoordinator(cache);
    b.register('b', 1, {});
    assert.equal(ttlValues[ttlValues.length - 1], 3_600_000);
  });

  // --- record idempotent per index ---

  it('record is idempotent for the same index — duplicate is ignored', async () => {
    const cache = fakeCacheStore();
    const coordinator = createSharedBatchCoordinator(cache);

    coordinator.register('batch-1', 2, {});

    // Record index 0 — success.
    coordinator.record('batch-1', 'jobA', 0, undefined);
    await tick();

    let state = readState(cache, 'batch-1');
    assert.deepEqual(state.recorded, [0]);
    assert.equal(state.succeeded, 1);
    assert.equal(state.failed, 0);

    // Record index 0 again — must be ignored.
    coordinator.record('batch-1', 'jobA', 0, 'duplicate error');
    await tick();

    state = readState(cache, 'batch-1');
    // recorded still has exactly one entry, succeeded still 1.
    assert.deepEqual(state.recorded, [0]);
    assert.equal(state.succeeded, 1);
    assert.equal(state.failed, 0);
    assert.deepEqual(state.failures, []);
  });

  it('record tracks failure separately from success', async () => {
    const cache = fakeCacheStore();
    const coordinator = createSharedBatchCoordinator(cache);

    coordinator.register('batch-1', 2, {});

    coordinator.record('batch-1', 'jobA', 0, undefined);
    coordinator.record('batch-1', 'jobB', 1, 'boom');
    await tick();

    const state = readState(cache, 'batch-1');
    assert.deepEqual(state.recorded, [0, 1]);
    assert.equal(state.succeeded, 1);
    assert.equal(state.failed, 1);
    assert.equal(state.failures.length, 1);
    assert.equal(state.failures[0]!.job, 'jobB');
    assert.equal(state.failures[0]!.error, 'boom');
  });

  // --- All succeed: then + finally fire ---

  it('fires then and finally when all items succeed; catch not called', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = createSharedBatchCoordinator(cache);

    coordinator.register('batch-1', 3, callbacks);
    coordinator.record('batch-1', 'taskA', 0, undefined);
    coordinator.record('batch-1', 'taskB', 1, undefined);
    coordinator.record('batch-1', 'taskC', 2, undefined);
    await tick();

    // then called exactly once.
    assert.equal(capture.thenCalls.length, 1);
    const thenSummary = capture.thenCalls[0]!;
    assert.equal(thenSummary.id, 'batch-1');
    assert.equal(thenSummary.total, 3);
    assert.equal(thenSummary.succeeded, 3);
    assert.equal(thenSummary.failed, 0);

    // catch not called.
    assert.equal(capture.catchCalls.length, 0);

    // finally called exactly once.
    assert.equal(capture.finallyCalls.length, 1);
    const finallySummary = capture.finallyCalls[0]!;
    assert.equal(finallySummary.id, 'batch-1');
    assert.equal(finallySummary.succeeded, 3);
    assert.equal(finallySummary.failed, 0);
  });

  // --- Any failure: catch + finally fire ---

  it('fires catch and finally when any item fails; then not called', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = createSharedBatchCoordinator(cache);

    coordinator.register('batch-1', 3, callbacks);
    coordinator.record('batch-1', 'taskA', 0, undefined);
    coordinator.record('batch-1', 'taskB', 1, 'intentional failure');
    coordinator.record('batch-1', 'taskC', 2, undefined);
    await tick();

    // then not called.
    assert.equal(capture.thenCalls.length, 0);

    // catch called exactly once.
    assert.equal(capture.catchCalls.length, 1);
    const catchSummary = capture.catchCalls[0]!;
    assert.equal(catchSummary.id, 'batch-1');
    assert.equal(catchSummary.total, 3);
    assert.equal(catchSummary.succeeded, 2);
    assert.equal(catchSummary.failed, 1);
    assert.equal(catchSummary.failures.length, 1);
    assert.equal(catchSummary.failures[0]!.job, 'taskB');
    assert.equal(catchSummary.failures[0]!.error, 'intentional failure');

    // finally called exactly once.
    assert.equal(capture.finallyCalls.length, 1);
    assert.equal(capture.finallyCalls[0]!.succeeded, 2);
    assert.equal(capture.finallyCalls[0]!.failed, 1);
  });

  // --- Settlement single-fire ---

  it('fires settlement exactly once even when multiple records observe completion', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = createSharedBatchCoordinator(cache);

    coordinator.register('batch-1', 1, callbacks);

    // Record the same (only) index multiple times.
    coordinator.record('batch-1', 'taskA', 0, undefined);
    coordinator.record('batch-1', 'taskA', 0, undefined);
    coordinator.record('batch-1', 'taskA', 0, undefined);
    await tick();

    assert.equal(capture.thenCalls.length, 1);
    assert.equal(capture.finallyCalls.length, 1);
  });

  // --- remove deletes the key ---

  it('remove deletes the persisted key and in-process callbacks', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = createSharedBatchCoordinator(cache);

    coordinator.register('batch-1', 1, callbacks);
    assert.ok(cache._store.has('jsails:batch:batch-1'));

    coordinator.remove('batch-1');
    await tick();

    // Key is deleted from the cache.
    assert.equal(cache._store.has('jsails:batch:batch-1'), false);

    // A subsequent record is a no-op — no callbacks, no persisted state.
    coordinator.record('batch-1', 'taskA', 0, undefined);
    await tick();
    assert.equal(capture.thenCalls.length, 0);
  });

  // --- Cross-process visibility ---

  it('two coordinator instances over the same cache share persisted progress', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();

    // Two coordinators — simulating producer and worker processes.
    const coordinatorA = createSharedBatchCoordinator(cache);
    const coordinatorB = createSharedBatchCoordinator(cache);

    // Process A registers the batch (has the callbacks).
    coordinatorA.register('batch-1', 3, callbacks);

    // Process B records indices 0 and 1 (worker process).
    coordinatorB.record('batch-1', 'taskA', 0, undefined);
    coordinatorB.record('batch-1', 'taskB', 1, undefined);
    await tick();

    // Cache now has recorded=[0,1] from B's writes.
    const stateAfterB = readState(cache, 'batch-1');
    assert.deepEqual(stateAfterB.recorded, [0, 1]);
    assert.equal(stateAfterB.succeeded, 2);

    // Settlement has NOT fired yet — process A hasn't observed completion.
    assert.equal(capture.thenCalls.length, 0);

    // Process A records the last index.
    // A reads the cache, sees recorded=[0,1], adds 2, writes back,
    // observes all 3 recorded, and fires settlement.
    coordinatorA.record('batch-1', 'taskC', 2, undefined);
    await tick();

    assert.equal(capture.thenCalls.length, 1);
    assert.equal(capture.thenCalls[0]!.succeeded, 3);

    // The persisted state carries all three indices.
    const finalState = readState(cache, 'batch-1');
    assert.deepEqual(finalState.recorded, [0, 1, 2]);
  });

  it('settlement does not fire in a process that did not register the batch', async () => {
    const cache = fakeCacheStore();

    const coordinatorA = createSharedBatchCoordinator(cache);
    const coordinatorB = createSharedBatchCoordinator(cache);

    const { capture: captureA, callbacks: cbA } = captureCallbacks();
    const { capture: captureB, callbacks: _cbB } = captureCallbacks();

    // Only A registers the batch.
    coordinatorA.register('batch-1', 2, cbA);

    // B records both indices but has no callbacks.
    coordinatorB.record('batch-1', 'taskA', 0, undefined);
    coordinatorB.record('batch-1', 'taskB', 1, undefined);
    await tick();

    // B's callbacks never fire — B did not register this batch.
    assert.equal(captureB.thenCalls.length, 0);
    assert.equal(captureB.catchCalls.length, 0);
    assert.equal(captureB.finallyCalls.length, 0);

    // A's callbacks also haven't fired — A never observed completion
    // (A never called `record`).
    assert.equal(captureA.thenCalls.length, 0);

    // A records an already-seen index. It is a duplicate, so the idempotency
    // guard ignores it and no settlement fires in A — completion is not
    // re-observed through a duplicate record. This is the documented
    // registration-locality limit: only a fresh record in the registering
    // process would surface settlement.
    coordinatorA.record('batch-1', 'taskA', 0, undefined);
    await tick();

    assert.equal(captureA.thenCalls.length, 0);
  });

  // --- BatchFailure.error is value-free ---

  it('persisted failures carry only the error message, never the payload', async () => {
    const cache = fakeCacheStore();
    const coordinator = createSharedBatchCoordinator(cache);

    coordinator.register('batch-1', 1, {});
    // The error message is the only thing persisted — no stack, no payload.
    coordinator.record('batch-1', 'secretJob', 0, 'boom');
    await tick();

    const state = readState(cache, 'batch-1');
    assert.equal(state.failures.length, 1);
    assert.equal(state.failures[0]!.job, 'secretJob');
    assert.equal(state.failures[0]!.error, 'boom');

    // The failure record must never contain fields beyond job + error.
    const keys = Object.keys(state.failures[0]!);
    assert.deepEqual(keys.sort(), ['error', 'job']);
  });

  // --- Rejects invalid arguments ---

  it('throws for a non-object cache argument', () => {
    assert.throws(() => {
      (createSharedBatchCoordinator as (c: unknown, o?: unknown) => BatchCoordinator)(null!);
    }, /invalid_cache/);

    assert.throws(() => {
      (createSharedBatchCoordinator as (c: unknown, o?: unknown) => BatchCoordinator)(undefined!);
    }, /invalid_cache/);
  });

  it('throws for a non-object options argument', () => {
    const cache = fakeCacheStore();
    assert.throws(() => {
      createSharedBatchCoordinator(cache, 'bad' as unknown as { ttlMs?: number });
    }, /options must be an object/);
  });

  // --- Graceful when entry is missing from cache ---

  it('record is a no-op when the cache entry has been removed or expired', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = createSharedBatchCoordinator(cache);

    coordinator.register('batch-1', 2, callbacks);

    // Manually delete the entry (simulating expiry or external removal).
    cache._store.delete('jsails:batch:batch-1');

    coordinator.record('batch-1', 'taskA', 0, undefined);
    await tick();

    // No state was written, no callbacks fired.
    assert.equal(cache._store.has('jsails:batch:batch-1'), false);
    assert.equal(capture.thenCalls.length, 0);
  });

  // --- In-process entry cleanup after settlement ---

  it('in-process entry is removed after settlement; subsequent record is a no-op', async () => {
    const cache = fakeCacheStore();
    const { capture, callbacks } = captureCallbacks();
    const coordinator = createSharedBatchCoordinator(cache);

    coordinator.register('batch-1', 1, callbacks);
    coordinator.record('batch-1', 'taskA', 0, undefined);
    await tick();

    // Settlement fired (then + finally).
    assert.equal(capture.thenCalls.length, 1);
    assert.equal(capture.finallyCalls.length, 1);

    // A subsequent record for the same id should not re-fire callbacks.
    // The in-process entry was removed in the finally block of runCallbacks.
    coordinator.record('batch-1', 'taskA', 0, 'late error');
    await tick();

    // Callbacks still only fired once.
    assert.equal(capture.thenCalls.length, 1);
    assert.equal(capture.catchCalls.length, 0);
  });
});
