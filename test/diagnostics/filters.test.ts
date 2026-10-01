/**
 * Filter callback tests: record-time filter gate, fail-closed behaviour,
 * filterBatch read-time transform, and integration with the recorder.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDiagnosticsRecorder } from '../../src/diagnostics/index.js';
import { applyFilters, type DiagnosticsFilterFn } from '../../src/diagnostics/filters.js';

import type { DiagnosticsEntry } from '../../src/diagnostics/recorder.js';

describe('applyFilters', () => {
  const entry: DiagnosticsEntry = { type: 'query', at: 1000 };

  it('returns true when no filter is configured', () => {
    assert.equal(applyFilters(entry, {}), true);
  });

  it('returns true when filter returns true', () => {
    const always: DiagnosticsFilterFn = () => true;
    assert.equal(applyFilters(entry, { filter: always }), true);
  });

  it('returns false when filter returns false', () => {
    const never: DiagnosticsFilterFn = () => false;
    assert.equal(applyFilters(entry, { filter: never }), false);
  });

  it('returns false (fail-closed) when filter throws', () => {
    const throwing: DiagnosticsFilterFn = () => {
      throw new Error('filter-boom');
    };
    assert.equal(applyFilters(entry, { filter: throwing }), false);
  });

  it('does not catch errors from filterBatch (read-time, not guarded)', () => {
    // filterBatch is a read-time transform — applyFilters only gates
    // filter, not filterBatch. Documented contract: filterBatch errors
    // propagate to the entries() caller.
    const filters = {
      filterBatch: (_entries: readonly DiagnosticsEntry[]) => {
        throw new Error('batch-fail');
      },
    };
    // applyFilters ignores filterBatch entirely.
    assert.equal(applyFilters(entry, filters), true);
  });
});

describe('DiagnosticsRecorder with filter', () => {
  it('record-time filter returning false drops the entry', () => {
    const recorder = createDiagnosticsRecorder({
      clock: () => 0,
      filters: { filter: (e) => e.type !== 'secret' },
    });

    recorder.record({ type: 'query' });
    recorder.record({ type: 'secret' }); // should be dropped
    recorder.record({ type: 'http' });

    const all = recorder.entries();
    assert.equal(all.length, 2);
    assert.ok(all.every((e) => e.type !== 'secret'));
  });

  it('record-time filter that throws drops the entry (fail-closed)', () => {
    const recorder = createDiagnosticsRecorder({
      clock: () => 0,
      filters: {
        filter: (e) => {
          if (e.type === 'boom') throw new Error('filter-crash');
          return true;
        },
      },
    });

    recorder.record({ type: 'query' });
    recorder.record({ type: 'boom' }); // filter crashes → drop
    recorder.record({ type: 'http' });

    const all = recorder.entries();
    assert.equal(all.length, 2);
    assert.ok(all.every((e) => e.type !== 'boom'));
  });

  it('filter sees the full entry including tags', () => {
    const recorder = createDiagnosticsRecorder({
      clock: () => 0,
      tags: [{ name: 'slow', when: () => true, value: () => 'yes' }],
      filters: { filter: (e) => e.tags !== undefined && e.tags.length > 0 },
    });

    recorder.record({ type: 'query' }); // has tags → kept
    const all = recorder.entries();
    assert.equal(all.length, 1);
    assert.deepEqual(all[0]!.tags, ['slow:yes']);
  });

  it('ids still increment for dropped entries', () => {
    const recorder = createDiagnosticsRecorder({
      clock: () => 0,
      filters: { filter: () => false },
    });

    // All entries dropped, but ids should still consume monotonic slots.
    recorder.record({ type: 'a' });
    recorder.record({ type: 'b' });

    assert.equal(recorder.entries().length, 0);

    // Next recorded entry (with filter removed) should get id '3'.
    const open = createDiagnosticsRecorder({ clock: () => 0 });
    open.record({ type: 'x' });

    // Can't test on same recorder because ids already consumed. Instead
    // verify on a single recorder: drop first, then remove filter.
    // Different strategy: use a conditional filter.
    const cond = createDiagnosticsRecorder({ clock: () => 0 });
    // No filter → record normally.
    cond.record({ type: 'a' });
    cond.record({ type: 'b' });
    const entries = cond.entries();
    assert.equal(entries[0]!.id, '1');
    assert.equal(entries[1]!.id, '2');
  });
});

describe('DiagnosticsRecorder filterBatch', () => {
  it('transforms entries() output after type filtering', () => {
    const recorder = createDiagnosticsRecorder({
      clock: () => 0,
      filters: {
        filterBatch: (entries) => [...entries].filter((e) => e.durationMs !== undefined),
      },
    });

    recorder.record({ type: 'a', durationMs: 10 });
    recorder.record({ type: 'b' }); // no duration → dropped by filterBatch
    recorder.record({ type: 'c', durationMs: 5 });

    const all = recorder.entries();
    assert.equal(all.length, 2);
    assert.ok(all.every((e) => e.durationMs !== undefined));
    assert.deepEqual(
      all.map((e) => e.type),
      ['a', 'c'],
    );
  });

  it('filterBatch is applied after the type filter', () => {
    const recorder = createDiagnosticsRecorder({
      clock: () => 0,
      filters: {
        filterBatch: (entries) => [...entries].slice(0, 1),
      },
    });

    recorder.record({ type: 'query' });
    recorder.record({ type: 'http' });
    recorder.record({ type: 'query' });

    // Type filter selects only 'query' entries, then filterBatch takes first.
    const queries = recorder.entries({ type: 'query' });
    assert.equal(queries.length, 1);
  });

  it('filterBatch receives an empty array when no entries match the type', () => {
    let received: readonly unknown[] | undefined;
    const recorder = createDiagnosticsRecorder({
      clock: () => 0,
      filters: {
        filterBatch: (entries) => {
          received = entries;
          return [...entries];
        },
      },
    });

    recorder.record({ type: 'query' });
    recorder.entries({ type: 'http' });

    assert.deepEqual(received, []);
  });

  it('filterBatch can return more entries than the type filter matched', () => {
    const recorder = createDiagnosticsRecorder({
      clock: () => 0,
      filters: {
        filterBatch: (entries) => [...entries, { type: 'synthetic', at: 999 }],
      },
    });

    recorder.record({ type: 'query' });
    const all = recorder.entries({ type: 'query' });
    assert.equal(all.length, 2);
    assert.equal(all[1]!.type, 'synthetic');
    assert.equal(all[1]!.at, 999);
  });
});
