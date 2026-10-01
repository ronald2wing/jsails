/**
 * Pruning tests: pure pruneEntries function and recorder.prune integration.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDiagnosticsRecorder } from '../../src/diagnostics/index.js';
import { pruneEntries } from '../../src/diagnostics/prune.js';

import type { DiagnosticsEntry } from '../../src/diagnostics/recorder.js';

function entry(
  overrides: Partial<DiagnosticsEntry> & { type: string; at: number },
): DiagnosticsEntry {
  const { type, at, ...rest } = overrides;
  return { type, at, ...rest };
}

describe('pruneEntries', () => {
  const now = 10_000_000;

  it('keeps all entries when none are older than hours', () => {
    const entries = [entry({ type: 'query', at: now - 60_000 }), entry({ type: 'http', at: now })];
    const result = pruneEntries(entries, { hours: 1, keepExceptions: 0 }, now);
    assert.equal(result.length, 2);
  });

  it('drops entries older than the hour threshold', () => {
    const entries = [
      entry({ type: 'query', at: now - 7_200_000 }), // 2 hours ago → drop
      entry({ type: 'http', at: now - 60_000 }), // 1 minute ago → keep
    ];
    const result = pruneEntries(entries, { hours: 1, keepExceptions: 0 }, now);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.type, 'http');
  });

  it('keeps the newest keepExceptions exception entries regardless of age', () => {
    const entries = [
      entry({ type: 'exception', at: now - 14_400_000 }), // 4 hours ago → aged
      entry({ type: 'exception', at: now - 10_800_000 }), // 3 hours ago → aged
      entry({ type: 'exception', at: now - 7_200_000 }), // 2 hours ago → aged
      entry({ type: 'query', at: now - 60_000 }), // 1 minute ago → recent
    ];
    const result = pruneEntries(entries, { hours: 1, keepExceptions: 2 }, now);

    assert.equal(result.length, 3); // 1 recent query + 2 newest exceptions
    const types = result.map((e) => e.type);
    assert.equal(types.filter((t) => t === 'query').length, 1);
    assert.equal(types.filter((t) => t === 'exception').length, 2);

    // The kept exceptions should be the two newest aged ones
    // (at -10_800_000 and -7_200_000).
    const keptExceptionAts = result.filter((e) => e.type === 'exception').map((e) => e.at);
    assert.ok(keptExceptionAts.includes(now - 10_800_000));
    assert.ok(keptExceptionAts.includes(now - 7_200_000));
    assert.ok(!keptExceptionAts.includes(now - 14_400_000));
  });

  it('returns sorted by at ascending', () => {
    const entries = [
      entry({ type: 'http', at: now - 500 }),
      entry({ type: 'query', at: now - 1000 }),
      entry({ type: 'job', at: now }),
    ];
    const result = pruneEntries(entries, { hours: 1, keepExceptions: 0 }, now);
    const ats = result.map((e) => e.at);
    assert.deepEqual(ats, [now - 1000, now - 500, now]);
  });

  it('keepExceptions = 0 never retains aged exceptions', () => {
    const entries = [
      entry({ type: 'exception', at: now - 7_200_000 }), // aged
      entry({ type: 'query', at: now }),
    ];
    const result = pruneEntries(entries, { hours: 1, keepExceptions: 0 }, now);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.type, 'query');
  });

  it('only keeps exceptions, not other aged types', () => {
    const entries = [
      entry({ type: 'exception', at: now - 14_400_000 }),
      entry({ type: 'query', at: now - 14_400_000 }),
      entry({ type: 'http', at: now }),
    ];
    const result = pruneEntries(entries, { hours: 1, keepExceptions: 1 }, now);
    assert.equal(result.length, 2);
    const types = result.map((e) => e.type);
    assert.ok(types.includes('http'));
    assert.ok(types.includes('exception'));
    assert.ok(!types.includes('query'));
  });

  it('returns all aged exceptions when keepExceptions exceeds count', () => {
    const entries = [
      entry({ type: 'exception', at: now - 7_200_000 }),
      entry({ type: 'http', at: now }),
    ];
    const result = pruneEntries(entries, { hours: 1, keepExceptions: 10 }, now);
    assert.equal(result.length, 2);
    assert.equal(result.filter((e) => e.type === 'exception').length, 1);
  });

  it('returns empty when all entries are aged and no exceptions kept', () => {
    const entries = [entry({ type: 'query', at: now - 7_200_000 })];
    const result = pruneEntries(entries, { hours: 1, keepExceptions: 0 }, now);
    assert.equal(result.length, 0);
  });

  it('returns empty for empty input', () => {
    assert.equal(pruneEntries([], { hours: 1, keepExceptions: 5 }, now).length, 0);
  });
});

describe('DiagnosticsRecorder.prune', () => {
  const now = 10_000_000;

  it('prunes aged entries in place and returns removed count', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => now });

    recorder.record({ type: 'query' }); // at = now → recent

    const removed = recorder.prune({ hours: 1, keepExceptions: 0 }, now + 7_200_000);
    // The entry is now 2 hours old relative to the new "now" → pruned.
    assert.equal(removed, 1);
    assert.equal(recorder.entries().length, 0);
  });

  it('keeps entry that is within the hour range', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => now });

    recorder.record({ type: 'query' });

    const removed = recorder.prune({ hours: 1, keepExceptions: 0 }, now + 60_000);
    // The entry is only 1 minute old → kept.
    assert.equal(removed, 0);
    assert.equal(recorder.entries().length, 1);
  });

  it('defaults now to the recorder clock', () => {
    let clockValue = now;
    const recorder = createDiagnosticsRecorder({ clock: () => clockValue });

    recorder.record({ type: 'query' });

    // Advance the clock so the entry ages beyond the threshold.
    clockValue = now + 7_200_000;

    const removed = recorder.prune({ hours: 1, keepExceptions: 0 });
    assert.equal(removed, 1);
    assert.equal(recorder.entries().length, 0);
  });

  it('keeps exception entries when keepExceptions > 0', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => now });

    recorder.record({ type: 'exception' });
    recorder.record({ type: 'query' });

    const removed = recorder.prune({ hours: 1, keepExceptions: 1 }, now + 7_200_000);
    // query is aged → dropped. exception → kept via keepExceptions.
    assert.equal(removed, 1);
    const remaining = recorder.entries();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.type, 'exception');
  });

  it('returns 0 when nothing is pruned', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => now });

    recorder.record({ type: 'query' });

    const removed = recorder.prune({ hours: 24, keepExceptions: 0 });
    assert.equal(removed, 0);
    assert.equal(recorder.entries().length, 1);
  });

  it('pruned entries are gone from entries() and stats()', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => now });

    recorder.record({ type: 'query' });
    recorder.record({ type: 'http' });
    recorder.record({ type: 'query' });

    assert.equal(recorder.stats().total, 3);

    const removed = recorder.prune({ hours: 1, keepExceptions: 0 }, now + 7_200_000);
    assert.equal(removed, 3);
    assert.equal(recorder.stats().total, 0);
  });

  it('prune does not affect entries added after prune', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => now });

    recorder.record({ type: 'old' });

    // Prune: pass a future "now" so the existing entry is aged.
    recorder.prune({ hours: 1, keepExceptions: 0 }, now + 7_200_000);

    // After prune, record a new entry at the current (non-advanced) clock.
    recorder.record({ type: 'new' });

    const all = recorder.entries();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.type, 'new');
  });
});
