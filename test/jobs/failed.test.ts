import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createFailedJobStore,
  FailedJobNotFoundError,
  type FailedJobEntry,
} from '../../src/jobs/failed.js';

/**
 * Unit tests for the bounded in-memory failed-job store: add, list, get,
 * remove, retry (with injected dispatch), clear, eviction, and error
 * behaviour.
 */

const now = new Date();

function entry(overrides: Partial<FailedJobEntry> = {}): FailedJobEntry {
  return {
    id: overrides.id ?? 'a',
    name: overrides.name ?? 'sendEmail',
    data: overrides.data,
    error: overrides.error ?? 'connection refused',
    failedAt: overrides.failedAt ?? now,
    attempts: overrides.attempts ?? 3,
    tags: overrides.tags,
  };
}

describe('createFailedJobStore', () => {
  // -----------------------------------------------------------------------
  // basic operations
  // -----------------------------------------------------------------------

  it('adds, lists, and gets entries', () => {
    const store = createFailedJobStore();

    store.add(entry({ id: '1', name: 'jobA' }));
    store.add(entry({ id: '2', name: 'jobB' }));

    const list = store.list();
    assert.equal(list.length, 2);
    assert.equal(list[0]!.id, '1');
    assert.equal(list[1]!.id, '2');

    const found = store.get('1');
    assert.ok(found !== undefined);
    assert.equal(found.id, '1');
    assert.equal(found.name, 'jobA');
  });

  it('list returns a stable copy (mutations do not corrupt the store)', () => {
    const store = createFailedJobStore();
    store.add(entry({ id: '1' }));

    const snapshot = store.list();
    (snapshot as FailedJobEntry[]).length = 0;

    assert.equal(store.list().length, 1);
  });

  it('get returns undefined for a missing id', () => {
    const store = createFailedJobStore();
    assert.equal(store.get('nope'), undefined);
  });

  it('remove by id returns true and removes exactly one entry', () => {
    const store = createFailedJobStore();
    store.add(entry({ id: '1' }));
    store.add(entry({ id: '2' }));

    const removed = store.remove('1');
    assert.equal(removed, true);
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0]!.id, '2');
  });

  it('remove returns false for a missing id', () => {
    const store = createFailedJobStore();
    store.add(entry({ id: '1' }));
    assert.equal(store.remove('2'), false);
    assert.equal(store.list().length, 1);
  });

  it('clear empties the store', () => {
    const store = createFailedJobStore();
    store.add(entry({ id: '1' }));
    store.add(entry({ id: '2' }));

    store.clear();
    assert.equal(store.list().length, 0);
    assert.equal(store.get('1'), undefined);
  });

  // -----------------------------------------------------------------------
  // ring-buffer eviction
  // -----------------------------------------------------------------------

  it('evicts the oldest entry when the store is full', () => {
    const store = createFailedJobStore({ maxEntries: 2 });

    store.add(entry({ id: '1' }));
    store.add(entry({ id: '2' }));
    store.add(entry({ id: '3' }));

    const list = store.list();
    assert.equal(list.length, 2);
    // Oldest ('1') should be gone.
    assert.equal(list[0]!.id, '2');
    assert.equal(list[1]!.id, '3');
    assert.equal(store.get('1'), undefined);
  });

  it('defaults maxEntries to 100', () => {
    const store = createFailedJobStore();
    for (let i = 0; i < 150; i++) {
      store.add(entry({ id: String(i) }));
    }
    assert.equal(store.list().length, 100);
    // Earliest entries 0..49 should be evicted.
    assert.equal(store.get('0'), undefined);
    assert.equal(store.get('49'), undefined);
    assert.ok(store.get('50') !== undefined);
    assert.ok(store.get('149') !== undefined);
  });

  it('rejects invalid maxEntries', () => {
    assert.throws(() => createFailedJobStore({ maxEntries: 0 }), TypeError);
    assert.throws(() => createFailedJobStore({ maxEntries: -1 }), TypeError);
    assert.throws(() => createFailedJobStore({ maxEntries: 1.5 }), TypeError);
  });

  // -----------------------------------------------------------------------
  // retry
  // -----------------------------------------------------------------------

  it('retry calls dispatch and removes the entry on success', async () => {
    const store = createFailedJobStore();
    store.add(entry({ id: '1', name: 'sendEmail' }));

    let calledWith: FailedJobEntry | undefined;
    const dispatch = async (e: FailedJobEntry) => {
      calledWith = e;
    };

    await store.retry('1', dispatch);

    assert.ok(calledWith !== undefined);
    assert.equal(calledWith.id, '1');
    assert.equal(calledWith.name, 'sendEmail');
    assert.equal(store.list().length, 0);
  });

  it('retry throws FailedJobNotFoundError when id is missing', async () => {
    const store = createFailedJobStore();
    const dispatch = async () => {};

    await assert.rejects(
      () => store.retry('nope', dispatch),
      (err: unknown) => {
        assert.ok(err instanceof FailedJobNotFoundError);
        assert.match(err.message, /"nope"/);
        return true;
      },
    );
  });

  it('retry keeps the entry when dispatch fails', async () => {
    const store = createFailedJobStore();
    store.add(entry({ id: '1', name: 'sendEmail' }));

    const dispatchError = new Error('redis down');
    const dispatch = async () => {
      throw dispatchError;
    };

    await assert.rejects(
      () => store.retry('1', dispatch),
      (err: unknown) => err === dispatchError,
    );

    // The entry should still be present.
    assert.equal(store.list().length, 1);
    assert.equal(store.get('1')!.id, '1');
  });

  it('retry on a removed entry throws', async () => {
    const store = createFailedJobStore();
    store.add(entry({ id: '1' }));
    store.remove('1');

    await assert.rejects(() => store.retry('1', async () => {}), FailedJobNotFoundError);
  });
});

describe('tag filter', () => {
  it('entry with tags round-trips through add then list', () => {
    const store = createFailedJobStore();
    const e = entry({ id: '1', tags: ['a', 'b'] });
    store.add(e);

    const list = store.list();
    assert.equal(list.length, 1);
    assert.deepEqual(list[0]!.tags, ['a', 'b']);
  });

  it('entry without tags has undefined tags', () => {
    const store = createFailedJobStore();
    store.add(entry({ id: '1' }));

    const list = store.list();
    assert.equal(list[0]!.tags, undefined);
  });

  it('list({ tags: ["a"] }) returns only entries carrying the requested tag', () => {
    const store = createFailedJobStore();
    store.add(entry({ id: '1', tags: ['a'] }));
    store.add(entry({ id: '2', tags: ['a', 'b'] }));
    store.add(entry({ id: '3', tags: ['b'] }));
    store.add(entry({ id: '4', tags: undefined }));

    const filtered = store.list({ tags: ['a'] });
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0]!.id, '1');
    assert.equal(filtered[1]!.id, '2');
  });

  it('list({ tags: ["a", "b"] }) returns only entries with both tags', () => {
    const store = createFailedJobStore();
    store.add(entry({ id: '1', tags: ['a'] }));
    store.add(entry({ id: '2', tags: ['a', 'b', 'c'] }));
    store.add(entry({ id: '3', tags: ['b', 'c'] }));

    const filtered = store.list({ tags: ['a', 'b'] });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]!.id, '2');
  });

  it('list({ tags: ["x"] }) returns empty when no entry matches', () => {
    const store = createFailedJobStore();
    store.add(entry({ id: '1', tags: ['a'] }));

    const filtered = store.list({ tags: ['x'] });
    assert.equal(filtered.length, 0);
  });

  it('list with empty tags returns all entries (no filter applied)', () => {
    const store = createFailedJobStore();
    store.add(entry({ id: '1', tags: ['a'] }));
    store.add(entry({ id: '2', tags: undefined }));

    const filtered = store.list({ tags: [] });
    assert.equal(filtered.length, 2);
  });

  it('list with no filter returns all entries', () => {
    const store = createFailedJobStore();
    store.add(entry({ id: '1', tags: ['a'] }));
    store.add(entry({ id: '2', tags: undefined }));

    const all = store.list();
    assert.equal(all.length, 2);
  });
});

// -----------------------------------------------------------------------
// age retention
// -----------------------------------------------------------------------

describe('retention', () => {
  const BASE = 1_700_000_000_000; // deterministic epoch

  it('rejects maxAgeMs <= 0', () => {
    assert.throws(() => createFailedJobStore({ maxAgeMs: 0 }), TypeError);
    assert.throws(() => createFailedJobStore({ maxAgeMs: -1 }), TypeError);
    assert.throws(() => createFailedJobStore({ maxAgeMs: -100 }), TypeError);
  });

  it('rejects non-finite maxAgeMs', () => {
    assert.throws(() => createFailedJobStore({ maxAgeMs: Infinity }), TypeError);
    assert.throws(() => createFailedJobStore({ maxAgeMs: -Infinity }), TypeError);
    assert.throws(() => createFailedJobStore({ maxAgeMs: NaN }), TypeError);
  });

  it('drops entries older than maxAgeMs on add', () => {
    let tick = BASE;
    const clock = () => tick;

    const store = createFailedJobStore({ maxAgeMs: 60_000, now: clock });

    // entry at BASE
    store.add(entry({ id: '1', failedAt: new Date(BASE) }));
    assert.equal(store.list().length, 1);

    // advance clock past maxAgeMs for entry 1
    tick = BASE + 70_000;

    // add a fresh entry — this triggers pruneAged, dropping entry 1
    store.add(entry({ id: '2', failedAt: new Date(tick) }));

    const result = store.list();
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, '2');
    assert.equal(store.get('1'), undefined);
  });

  it('drops aged entries lazily on list', () => {
    let tick = BASE;
    const clock = () => tick;

    const store = createFailedJobStore({ maxAgeMs: 60_000, now: clock });

    store.add(entry({ id: '1', failedAt: new Date(BASE) }));
    store.add(entry({ id: '2', failedAt: new Date(BASE + 30_000) }));

    assert.equal(store.list().length, 2);

    // advance clock so entry 1 is aged out, entry 2 is still fresh
    tick = BASE + 65_000;

    const result = store.list();
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, '2');
    assert.equal(store.get('1'), undefined);
  });

  it('maxEntries still bounds count when age is unset', () => {
    const store = createFailedJobStore({ maxEntries: 3 });

    store.add(entry({ id: '1' }));
    store.add(entry({ id: '2' }));
    store.add(entry({ id: '3' }));
    store.add(entry({ id: '4' }));

    assert.equal(store.list().length, 3);
    assert.equal(store.get('1'), undefined);
    assert.equal(store.get('2')!.id, '2');
    assert.equal(store.get('4')!.id, '4');
  });

  it('both bounds set — age trim then count cap', () => {
    let tick = BASE;
    const clock = () => tick;

    const store = createFailedJobStore({ maxEntries: 3, maxAgeMs: 60_000, now: clock });

    // add three entries at BASE
    store.add(entry({ id: '1', failedAt: new Date(BASE) }));
    store.add(entry({ id: '2', failedAt: new Date(BASE) }));
    store.add(entry({ id: '3', failedAt: new Date(BASE) }));
    assert.equal(store.list().length, 3);

    // advance past maxAgeMs — all three are now aged
    tick = BASE + 70_000;

    // adding a fourth entry: pruneAged drops all three, then maxEntries
    // bound is satisfied (0 entries, no shift needed)
    store.add(entry({ id: '4', failedAt: new Date(tick) }));

    const result = store.list();
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, '4');
    assert.equal(store.get('1'), undefined);
    assert.equal(store.get('2'), undefined);
    assert.equal(store.get('3'), undefined);
  });

  it('age doesnt evict entries within maxAgeMs window', () => {
    let tick = BASE;
    const clock = () => tick;

    const store = createFailedJobStore({ maxAgeMs: 120_000, now: clock });

    store.add(entry({ id: '1', failedAt: new Date(BASE) }));
    store.add(entry({ id: '2', failedAt: new Date(BASE + 80_000) }));

    // advance just past the first entry's age if we'd used 60s —
    // but maxAgeMs is 120s, so both stay
    tick = BASE + 100_000;

    const result = store.list();
    assert.equal(result.length, 2);
  });

  it('age trim preserves insertion order of remaining entries', () => {
    let tick = BASE;
    const clock = () => tick;

    const store = createFailedJobStore({ maxAgeMs: 60_000, now: clock });

    store.add(entry({ id: '1', failedAt: new Date(BASE) }));
    store.add(entry({ id: '2', failedAt: new Date(BASE + 10_000) }));
    store.add(entry({ id: '3', failedAt: new Date(BASE + 20_000) }));

    // advance so only entries 2 and 3 survive
    tick = BASE + 65_000;

    const result = store.list();
    assert.equal(result.length, 2);
    assert.equal(result[0]!.id, '2');
    assert.equal(result[1]!.id, '3');
  });

  it('tag filter still works after age pruning', () => {
    let tick = BASE;
    const clock = () => tick;

    const store = createFailedJobStore({ maxAgeMs: 60_000, now: clock });

    store.add(entry({ id: '1', tags: ['a'], failedAt: new Date(BASE) }));
    store.add(entry({ id: '2', tags: ['a'], failedAt: new Date(BASE + 70_000) }));
    store.add(entry({ id: '3', tags: ['b'], failedAt: new Date(BASE + 70_000) }));

    // entry 1 aged out; 2 and 3 survive
    tick = BASE + 80_000;

    const filtered = store.list({ tags: ['a'] });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]!.id, '2');
  });
});
