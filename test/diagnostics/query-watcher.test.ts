/**
 * Query watcher tests: recording diagnostic entries via an injected onQuery
 * subscriber. Verifies parameterized SQL, bindingCount (bindings never
 * stored), slow flag threshold, and unsubscribe behaviour.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DiagnosticsEntry } from '../../src/diagnostics/recorder.js';
import type { WatcherContext } from '../../src/diagnostics/watchers.js';
import { createQueryWatcher, type QueryEvent } from '../../src/diagnostics/watchers/query.js';

function makeFakeOnQuery() {
  let callback: ((event: QueryEvent) => void) | null = null;

  const onQuery = (fn: (event: QueryEvent) => void): (() => void) => {
    callback = fn;
    return () => {
      callback = null;
    };
  };

  const emit = (event: QueryEvent): void => {
    callback?.(event);
  };

  return { onQuery, emit };
}

function setup() {
  const { onQuery, emit } = makeFakeOnQuery();

  const recorded: DiagnosticsEntry[] = [];
  const now = (): number => Date.now();

  const ctx: WatcherContext = {
    record: (entry) => recorded.push(entry as DiagnosticsEntry),
    now,
  };

  const watcher = createQueryWatcher({ onQuery });
  const unsub = watcher.register(ctx);

  return { recorded, emit, unsub };
}

describe('createQueryWatcher', () => {
  it('records a query with sql, bindingCount, and slow', () => {
    const { recorded, emit } = setup();

    emit({ sql: 'SELECT * FROM users WHERE id = ?', bindings: [42], durationMs: 50 });

    assert.equal(recorded.length, 1);
    const entry = recorded[0]!;
    assert.equal(entry.type, 'query');
    assert.deepEqual(entry.data, {
      sql: 'SELECT * FROM users WHERE id = ?',
      bindingCount: 1,
      slow: false,
    });
  });

  it('sets slow to true when durationMs meets or exceeds slowMs (default 100)', () => {
    const { recorded, emit } = setup();

    emit({ sql: 'SELECT 1', durationMs: 100 });

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.data?.slow, true);
  });

  it('sets slow to false when durationMs is under slowMs (default 100)', () => {
    const { recorded, emit } = setup();

    emit({ sql: 'SELECT 1', durationMs: 99 });

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.data?.slow, false);
  });

  it('respects a custom slowMs threshold', () => {
    let cb: ((event: QueryEvent) => void) | undefined;
    const onQuery = (fn: (event: QueryEvent) => void): (() => void) => {
      cb = fn;
      return () => {
        cb = undefined;
      };
    };
    const emit = (event: QueryEvent) => {
      cb?.(event);
    };

    const recorded: DiagnosticsEntry[] = [];
    const watcher = createQueryWatcher({ onQuery, slowMs: 50 });
    watcher.register({
      record: (e) => recorded.push(e as DiagnosticsEntry),
      now: () => Date.now(),
    });

    emit({ sql: 'SELECT 1', durationMs: 50 });
    assert.equal(recorded[0]!.data?.slow, true);

    emit({ sql: 'SELECT 1', durationMs: 49 });
    assert.equal(recorded[1]!.data?.slow, false);
  });

  it('never records bindings in the data', () => {
    const { recorded, emit } = setup();

    emit({
      sql: 'INSERT INTO users (name, email) VALUES (?, ?)',
      bindings: ['Alice', 'alice@example.com'],
      durationMs: 10,
    });

    const data = recorded[0]!.data!;
    assert.ok(!Object.hasOwn(data, 'bindings'));
    assert.ok(!Object.hasOwn(data, 'values'));

    const keys = Object.keys(data).sort();
    assert.deepEqual(keys, ['bindingCount', 'slow', 'sql']);
  });

  it('records bindingCount of 0 when bindings is undefined', () => {
    const { recorded, emit } = setup();

    emit({ sql: 'SELECT 1', durationMs: 5 });

    assert.equal(recorded[0]!.data?.bindingCount, 0);
  });

  it('records bindingCount of 0 when bindings is empty array', () => {
    const { recorded, emit } = setup();

    emit({ sql: 'BEGIN', bindings: [], durationMs: 1 });

    assert.equal(recorded[0]!.data?.bindingCount, 0);
  });

  it('unsubscribe stops further recording', () => {
    const { recorded, emit, unsub } = setup();

    emit({ sql: 'SELECT 1', durationMs: 10 });
    assert.equal(recorded.length, 1);

    unsub();

    emit({ sql: 'SELECT 2', durationMs: 20 });
    assert.equal(recorded.length, 1);
  });

  it('continuously records multiple events before unsub', () => {
    const { recorded, emit } = setup();

    emit({ sql: 'SELECT 1', durationMs: 10 });
    emit({ sql: 'SELECT 2', bindings: [1, 2, 3], durationMs: 150 });
    emit({ sql: 'SELECT 3', durationMs: 5 });

    assert.equal(recorded.length, 3);
    assert.equal(recorded[0]!.data?.sql, 'SELECT 1');
    assert.equal(recorded[1]!.data?.sql, 'SELECT 2');
    assert.equal(recorded[1]!.data?.bindingCount, 3);
    assert.equal(recorded[1]!.data?.slow, true);
    assert.equal(recorded[2]!.data?.sql, 'SELECT 3');
  });
});
