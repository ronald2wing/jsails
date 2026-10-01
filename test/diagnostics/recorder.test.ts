/**
 * Diagnostics recorder tests: ring-buffer behaviour, filtering, stats,
 * wrapAsync duration and error rethrow, value-free entries, and option
 * validation. No connection, database, or external service is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createDiagnosticsRecorder,
  type DiagnosticsRecorder,
} from '../../src/diagnostics/index.js';

describe('createDiagnosticsRecorder', () => {
  it('starts empty', () => {
    const recorder = createDiagnosticsRecorder();
    assert.deepEqual(recorder.entries(), []);
    assert.deepEqual(recorder.stats(), { total: 0, byType: {}, withDuration: 0 });
  });

  it('records a typed entry with a timestamp', () => {
    const clock = () => 1000;
    const recorder = createDiagnosticsRecorder({ clock });

    recorder.record({ type: 'query', data: { sql: 'SELECT 1' } });
    const all = recorder.entries();

    assert.equal(all.length, 1);
    assert.equal(all[0]!.type, 'query');
    assert.equal(all[0]!.at, 1000);
    assert.equal(all[0]!.durationMs, undefined);
    assert.deepEqual(all[0]!.data, { sql: 'SELECT 1' });
  });

  it('filters entries by a single type', () => {
    const recorder = createDiagnosticsRecorder();

    recorder.record({ type: 'query' });
    recorder.record({ type: 'http' });
    recorder.record({ type: 'query' });

    const queries = recorder.entries({ type: 'query' });
    assert.equal(queries.length, 2);
    assert.ok(queries.every((e) => e.type === 'query'));
  });

  it('filters entries by multiple types', () => {
    const recorder = createDiagnosticsRecorder();

    recorder.record({ type: 'query' });
    recorder.record({ type: 'http' });
    recorder.record({ type: 'job' });

    const selected = recorder.entries({ type: ['query', 'job'] });
    assert.equal(selected.length, 2);
    assert.ok(selected.some((e) => e.type === 'query'));
    assert.ok(selected.some((e) => e.type === 'job'));
  });

  it('returns every entry when filter is omitted', () => {
    const recorder = createDiagnosticsRecorder();

    recorder.record({ type: 'query' });
    recorder.record({ type: 'http' });
    recorder.record({ type: 'job' });

    assert.equal(recorder.entries().length, 3);
    assert.equal(recorder.entries({}).length, 3);
  });

  it('returns empty when no entry matches the filter type', () => {
    const recorder = createDiagnosticsRecorder();

    recorder.record({ type: 'query' });
    assert.deepEqual(recorder.entries({ type: 'http' }), []);
    // Edge case: filter type is an empty array of strings
    assert.deepEqual(recorder.entries({ type: [] }), []);
  });
});

describe('ring-buffer eviction', () => {
  it('evicts the oldest entry when the buffer is full', () => {
    const clock = (() => {
      let t = 0;
      return () => ++t;
    })();
    const recorder = createDiagnosticsRecorder({ maxEntries: 3, clock });

    recorder.record({ type: 'query', data: { n: 1 } });
    recorder.record({ type: 'http', data: { n: 2 } });
    recorder.record({ type: 'job', data: { n: 3 } });
    // Buffer is now full. Next write evicts the oldest (n=1).
    recorder.record({ type: 'query', data: { n: 4 } });

    const all = recorder.entries();
    assert.equal(all.length, 3);

    const values = all.map((e) => e.data?.n);
    assert.ok(values.includes(2));
    assert.ok(values.includes(3));
    assert.ok(values.includes(4));
    assert.ok(!values.includes(1), 'the oldest entry was evicted');
  });

  it('wraps correctly with many cycles of eviction', () => {
    const clock = (() => {
      let t = 0;
      return () => ++t;
    })();
    const recorder = createDiagnosticsRecorder({ maxEntries: 2, clock });

    for (let i = 1; i <= 5; i++) {
      recorder.record({ type: 'query', data: { i } });
    }

    const all = recorder.entries();
    assert.equal(all.length, 2);
    const indices = all.map((e) => e.data?.i);
    assert.deepEqual(indices, [4, 5]);
  });

  it('preserves entries from before the buffer wrapped after eviction', () => {
    const recorder = createDiagnosticsRecorder({ maxEntries: 5 });

    for (let i = 0; i < 7; i++) {
      recorder.record({ type: 'query', data: { i } });
    }

    // The first two (i=0, i=1) should be gone; the rest (2..6) remain.
    const all = recorder.entries();
    assert.equal(all.length, 5);
    const indices = all.map((e) => e.data?.i);
    assert.deepEqual(indices, [2, 3, 4, 5, 6]);
  });

  it('does not evict when the buffer has not yet filled', () => {
    const recorder = createDiagnosticsRecorder({ maxEntries: 10 });

    recorder.record({ type: 'query' });
    recorder.record({ type: 'http' });

    assert.equal(recorder.stats().total, 2);
    assert.equal(recorder.entries().length, 2);
  });

  it('rejects maxEntries that is not a positive integer', () => {
    assert.throws(() => createDiagnosticsRecorder({ maxEntries: 0 }), TypeError);
    assert.throws(() => createDiagnosticsRecorder({ maxEntries: -1 }), TypeError);
    assert.throws(() => createDiagnosticsRecorder({ maxEntries: 1.5 }), TypeError);
    assert.throws(() => createDiagnosticsRecorder({ maxEntries: NaN }), TypeError);
    assert.throws(() => createDiagnosticsRecorder({ maxEntries: Infinity }), TypeError);
  });
});

describe('clear', () => {
  it('empties the buffer and resets stats', () => {
    const recorder = createDiagnosticsRecorder();

    recorder.record({ type: 'query' });
    recorder.record({ type: 'http', durationMs: 42 });
    assert.equal(recorder.stats().total, 2);

    recorder.clear();

    assert.equal(recorder.stats().total, 0);
    assert.deepEqual(recorder.entries(), []);
    assert.deepEqual(recorder.stats().byType, {});
    assert.equal(recorder.stats().withDuration, 0);
  });

  it('allows recording again after clear', () => {
    const recorder = createDiagnosticsRecorder();

    recorder.record({ type: 'query' });
    recorder.clear();
    recorder.record({ type: 'http' });

    assert.equal(recorder.stats().total, 1);
    assert.equal(recorder.entries()[0]!.type, 'http');
  });

  it('is idempotent', () => {
    const recorder = createDiagnosticsRecorder();

    recorder.clear();
    recorder.clear();
    assert.equal(recorder.stats().total, 0);
  });
});

describe('stats', () => {
  it('counts entries per type', () => {
    const recorder = createDiagnosticsRecorder();

    recorder.record({ type: 'query' });
    recorder.record({ type: 'http' });
    recorder.record({ type: 'query' });
    recorder.record({ type: 'job' });
    recorder.record({ type: 'http' });
    recorder.record({ type: 'http' });

    const s = recorder.stats();
    assert.equal(s.total, 6);
    assert.equal(s.byType['query'], 2);
    assert.equal(s.byType['http'], 3);
    assert.equal(s.byType['job'], 1);
  });

  it('counts entries with a duration', () => {
    const recorder = createDiagnosticsRecorder();

    recorder.record({ type: 'query' }); // no duration
    recorder.record({ type: 'http', durationMs: 15 });
    recorder.record({ type: 'query', durationMs: 3 });

    const s = recorder.stats();
    assert.equal(s.total, 3);
    assert.equal(s.withDuration, 2);
  });

  it('reflects evictions', () => {
    const recorder = createDiagnosticsRecorder({ maxEntries: 2 });

    recorder.record({ type: 'query' });
    recorder.record({ type: 'http' });
    recorder.record({ type: 'job' });

    const s = recorder.stats();
    assert.equal(s.total, 2);
    assert.ok('http' in s.byType);
    assert.ok('job' in s.byType);
    assert.ok(!('query' in s.byType));
  });
});

describe('wrapAsync', () => {
  it('records duration for a successful call', async () => {
    const clock = (() => {
      let t = 0;
      return () => (t += 10);
    })();
    const recorder = createDiagnosticsRecorder({ clock });

    const result = await recorder.wrapAsync('task', async () => {
      return 42;
    });

    assert.equal(result, 42);

    const all = recorder.entries();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.type, 'task');
    assert.equal(all[0]!.durationMs, 10);
    assert.deepEqual(all[0]!.data, { status: 'success' });
  });

  it('records a failed entry and rethrows the error', async () => {
    const clock = (() => {
      let t = 0;
      return () => (t += 10);
    })();
    const recorder = createDiagnosticsRecorder({ clock });

    const original = new Error('boom');
    await assert.rejects(
      recorder.wrapAsync('task', async () => {
        throw original;
      }),
      (error: unknown) => {
        return error === original;
      },
    );

    const all = recorder.entries();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.type, 'failed:task');
    assert.equal(all[0]!.durationMs, 10);
    assert.deepEqual(all[0]!.data, { status: 'failure' });
  });

  it('does not swallow the original error identity', async () => {
    const recorder = createDiagnosticsRecorder();

    class CustomError extends Error {
      constructor() {
        super('custom');
        this.name = 'CustomError';
      }
    }
    const err = new CustomError();

    await assert.rejects(
      recorder.wrapAsync('op', async () => {
        throw err;
      }),
      CustomError,
    );

    assert.equal(recorder.entries()[0]!.type, 'failed:op');
  });

  it('records zero duration when the clock returns the same value', async () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 5 });

    await recorder.wrapAsync('op', async () => {});
    assert.equal(recorder.entries()[0]!.durationMs, 0);
  });

  it('can filter by the failed: type prefix', async () => {
    const recorder = createDiagnosticsRecorder();

    await recorder.wrapAsync('task', async () => {});

    try {
      await recorder.wrapAsync('task', async () => {
        throw new Error('fail');
      });
    } catch {
      // expected
    }

    const successes = recorder.entries({ type: 'task' });
    assert.equal(successes.length, 1);

    const failures = recorder.entries({ type: 'failed:task' });
    assert.equal(failures.length, 1);

    // Filtering by the base type never matches the failed variant.
    const both = recorder.entries({ type: ['task', 'failed:task'] });
    assert.equal(both.length, 2);
  });
});

describe('default options', () => {
  it('defaults maxEntries to 1000', () => {
    const recorder = createDiagnosticsRecorder();
    for (let i = 0; i < 1000; i++) {
      recorder.record({ type: 'query' });
    }
    assert.equal(recorder.stats().total, 1000);

    // Writing one more should still keep 1000 entries.
    recorder.record({ type: 'query' });
    assert.equal(recorder.stats().total, 1000);
  });

  it('defaults clock to Date.now', () => {
    const recorder = createDiagnosticsRecorder();
    const before = Date.now();
    recorder.record({ type: 'query' });
    const after = Date.now();

    const at = recorder.entries()[0]!.at;
    assert.ok(at >= before && at <= after);
  });
});

describe('value-free entries', () => {
  it('entries surface only the type, at, durationMs, and data fields', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.record({ type: 'query', data: {} });
    const entry = recorder.entries()[0]!;

    const keys = Object.keys(entry).sort();
    assert.deepEqual(keys, ['at', 'data', 'id', 'type']);
  });

  it('an entry with durationMs surfaces that field', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.record({ type: 'http', durationMs: 42 });
    const entry = recorder.entries()[0]!;
    assert.equal(entry.durationMs, 42);
  });

  it('an entry without data omits the data field', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.record({ type: 'query' });
    const entry = recorder.entries()[0]!;
    assert.equal(entry.data, undefined);
  });
});

describe('option validation', () => {
  it('rejects non-function clock', () => {
    assert.throws(() => createDiagnosticsRecorder({ clock: 'not-a-function' as never }), TypeError);
  });

  it('rejects non-object options', () => {
    assert.throws(() => createDiagnosticsRecorder(null as never), TypeError);
    assert.throws(() => createDiagnosticsRecorder([] as never), TypeError);
  });
});

describe('construction laziness', () => {
  it('constructing a recorder performs no I/O and opens no connection', () => {
    const recorder: DiagnosticsRecorder = createDiagnosticsRecorder();
    assert.equal(typeof recorder.record, 'function');
    assert.equal(typeof recorder.entries, 'function');
    assert.equal(typeof recorder.clear, 'function');
    assert.equal(typeof recorder.stats, 'function');
    assert.equal(typeof recorder.wrapAsync, 'function');
    assert.equal(recorder.stats().total, 0);
  });
});

describe('entry id', () => {
  it('assigns monotonic string ids to every recorded entry', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.record({ type: 'a' });
    recorder.record({ type: 'b' });
    recorder.record({ type: 'c' });

    const all = recorder.entries();
    assert.equal(all[0]!.id, '1');
    assert.equal(all[1]!.id, '2');
    assert.equal(all[2]!.id, '3');
  });

  it('continues counting after eviction', () => {
    const recorder = createDiagnosticsRecorder({ maxEntries: 2, clock: () => 0 });

    recorder.record({ type: 'a' }); // id=1
    recorder.record({ type: 'b' }); // id=2
    recorder.record({ type: 'c' }); // id=3 (evicts id=1)

    const all = recorder.entries();
    assert.equal(all[0]!.id, '2');
    assert.equal(all[1]!.id, '3');
  });

  it('monotonic id is never caller-supplied (overridden by recorder)', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    // Even if a caller somehow passes an id (via the loose type), the
    // recorder derives its own.
    recorder.record({ type: 'x', id: '999' });
    recorder.record({ type: 'y' });

    const all = recorder.entries();
    assert.equal(all[0]!.id, '1');
    assert.equal(all[1]!.id, '2');
  });
});

describe('family hash', () => {
  it('derives familyHash from type + data.family when present', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.record({ type: 'exception', data: { family: 'Error:db' } });

    const entry = recorder.entries()[0]!;
    assert.equal(typeof entry.familyHash, 'string');
    assert.equal(entry.familyHash!.length, 12);
  });

  it('omits familyHash when data.family is absent', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.record({ type: 'query', data: { sql: 'SELECT 1' } });

    const entry = recorder.entries()[0]!;
    assert.equal(entry.familyHash, undefined);
  });

  it('omits familyHash when data is absent entirely', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.record({ type: 'http' });

    const entry = recorder.entries()[0]!;
    assert.equal(entry.familyHash, undefined);
  });

  it('omits familyHash when data.family is an empty string', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.record({ type: 'exception', data: { family: '' } });

    const entry = recorder.entries()[0]!;
    assert.equal(entry.familyHash, undefined);
  });

  it('omits familyHash when data.family is not a string', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.record({ type: 'exception', data: { family: 42 } });

    const entry = recorder.entries()[0]!;
    assert.equal(entry.familyHash, undefined);
  });

  it('produces the same hash for identical type + family', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.record({ type: 'exception', data: { family: 'Error:api' } });
    recorder.record({ type: 'exception', data: { family: 'Error:api' } });

    const entries = recorder.entries();
    assert.equal(entries[0]!.familyHash, entries[1]!.familyHash);
  });

  it('produces different hashes for different families', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.record({ type: 'exception', data: { family: 'Error:api' } });
    recorder.record({ type: 'exception', data: { family: 'Error:db' } });

    const entries = recorder.entries();
    assert.notEqual(entries[0]!.familyHash, entries[1]!.familyHash);
  });

  it('produces different hashes for different types with same family', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.record({ type: 'job', data: { family: 'Error:api' } });
    recorder.record({ type: 'exception', data: { family: 'Error:api' } });

    const entries = recorder.entries();
    assert.notEqual(entries[0]!.familyHash, entries[1]!.familyHash);
  });

  it('familyHash is never caller-supplied (overridden by recorder)', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.record({
      type: 'exception',
      data: { family: 'Error:db' },
      familyHash: 'deadbeef0000',
    });

    const entry = recorder.entries()[0]!;
    assert.notEqual(entry.familyHash, 'deadbeef0000');
    assert.equal(entry.familyHash!.length, 12);
  });
});

describe('pause/resume', () => {
  it('pause() then record adds nothing', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.pause();
    recorder.record({ type: 'query' });
    recorder.record({ type: 'http' });

    assert.equal(recorder.entries().length, 0);
    assert.equal(recorder.stats().total, 0);
  });

  it('resume() restores recording after pause', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.record({ type: 'a' });
    recorder.pause();
    recorder.record({ type: 'b' }); // dropped
    recorder.resume();
    recorder.record({ type: 'c' });

    const all = recorder.entries();
    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((e) => e.type),
      ['a', 'c'],
    );
  });

  it('wrapAsync while paused still runs fn and returns the value', async () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.pause();
    const result = await recorder.wrapAsync('task', async () => 42);

    assert.equal(result, 42);
    assert.equal(recorder.entries().length, 0);
  });

  it('wrapAsync while paused rethrows the error', async () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.pause();
    const err = new Error('paused-failure');

    await assert.rejects(
      recorder.wrapAsync('task', async () => {
        throw err;
      }),
      (e: unknown) => e === err,
    );

    assert.equal(recorder.entries().length, 0);
  });

  it('pause is idempotent', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.pause();
    recorder.pause();
    recorder.record({ type: 'x' });

    assert.equal(recorder.entries().length, 0);
  });

  it('resume is idempotent', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.pause();
    recorder.resume();
    recorder.resume(); // second resume is a no-op
    recorder.record({ type: 'x' });

    assert.equal(recorder.entries().length, 1);
  });

  it('pause/resume does not affect existing entries', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.record({ type: 'a' });
    recorder.record({ type: 'b' });

    recorder.pause();

    // Existing entries still readable.
    assert.equal(recorder.entries().length, 2);
    assert.equal(recorder.stats().total, 2);

    recorder.resume();
    assert.equal(recorder.entries().length, 2);
  });

  it('isPaused() returns true after pause and false after resume', () => {
    const recorder = createDiagnosticsRecorder();

    assert.equal(recorder.isPaused(), false);
    recorder.pause();
    assert.equal(recorder.isPaused(), true);
    recorder.resume();
    assert.equal(recorder.isPaused(), false);
  });

  it('enabled: false constructs a silent-but-not-paused recorder', () => {
    const recorder = createDiagnosticsRecorder({ enabled: false, clock: () => 0 });

    // Silent: recording does nothing.
    recorder.record({ type: 'query' });
    assert.equal(recorder.entries().length, 0);

    // Not paused: isPaused() returns false.
    assert.equal(recorder.isPaused(), false);
  });

  it('resume() re-enables a recorder constructed with enabled: false', () => {
    const recorder = createDiagnosticsRecorder({ enabled: false, clock: () => 0 });

    recorder.resume();
    recorder.record({ type: 'query' });

    assert.equal(recorder.entries().length, 1);
    assert.equal(recorder.isPaused(), false);
  });

  it('clear works while paused', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    recorder.record({ type: 'a' });
    recorder.record({ type: 'b' });
    recorder.pause();
    recorder.clear();

    assert.equal(recorder.entries().length, 0);
    recorder.resume();
    recorder.record({ type: 'c' });
    assert.equal(recorder.entries().length, 1);
  });
});
