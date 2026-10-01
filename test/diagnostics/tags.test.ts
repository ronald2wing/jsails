/**
 * Tag callback tests: matching, non-matching, throwing callbacks, value/length
 * bounding, and monitored-count integration with the recorder.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDiagnosticsRecorder, type DiagnosticsEntry } from '../../src/diagnostics/index.js';
import { type TagCallback, createTagRegistry } from '../../src/diagnostics/tags.js';

describe('TagCallback', () => {
  const slowTag: TagCallback = {
    name: 'slow',
    when: (e: DiagnosticsEntry) => (e.durationMs ?? 0) > 100,
    value: () => 'true',
  };

  const typeTag: TagCallback = {
    name: 'kind',
    when: (e: DiagnosticsEntry) => e.type === 'query',
    value: (e: DiagnosticsEntry) => e.type,
  };

  it('a matching callback adds its tag', () => {
    const registry = createTagRegistry([slowTag]);
    const entry: DiagnosticsEntry = { type: 'http', at: 0, durationMs: 200 };
    const tags = registry.tag(entry);
    assert.deepEqual(tags, ['slow:true']);
  });

  it('a non-matching callback does not add a tag', () => {
    const registry = createTagRegistry([slowTag]);
    const entry: DiagnosticsEntry = { type: 'http', at: 0, durationMs: 50 };
    const tags = registry.tag(entry);
    assert.deepEqual(tags, []);
  });

  it('multiple matching callbacks add multiple tags', () => {
    const registry = createTagRegistry([slowTag, typeTag]);
    const entry: DiagnosticsEntry = { type: 'query', at: 0, durationMs: 200 };
    const tags = registry.tag(entry);
    assert.deepEqual(tags, ['slow:true', 'kind:query']);
  });

  it('a throwing callback is skipped and other callbacks still run', () => {
    const throwing: TagCallback = {
      name: 'bad',
      when: () => {
        throw new Error('boom');
      },
      value: () => 'never',
    };
    const registry = createTagRegistry([throwing, slowTag]);
    const entry: DiagnosticsEntry = { type: 'http', at: 0, durationMs: 200 };
    const tags = registry.tag(entry);
    assert.deepEqual(tags, ['slow:true']);
  });

  it('a throwing when predicate does not block subsequent callbacks', () => {
    const throwingWhen: TagCallback = {
      name: 'bad',
      when: () => {
        throw new Error('when-boom');
      },
      value: () => 'never',
    };
    const throwingValue: TagCallback = {
      name: 'bad2',
      when: () => true,
      value: () => {
        throw new Error('value-boom');
      },
    };
    const ok: TagCallback = {
      name: 'ok',
      when: () => true,
      value: () => 'yes',
    };
    const registry = createTagRegistry([throwingWhen, throwingValue, ok]);
    const entry: DiagnosticsEntry = { type: 'test', at: 0 };
    const tags = registry.tag(entry);
    assert.deepEqual(tags, ['ok:yes']);
  });

  it('caps tag values at MAX_TAG_LENGTH (64)', () => {
    const long: TagCallback = {
      name: 'x',
      when: () => true,
      value: () => 'a'.repeat(100),
    };
    const registry = createTagRegistry([long]);
    const entry: DiagnosticsEntry = { type: 'test', at: 0 };
    const tags = registry.tag(entry);
    assert.equal(tags.length, 1);
    const value = tags[0]!.slice(2); // skip "x:"
    assert.equal(value.length, 64);
  });

  it('caps total tags at MAX_TAGS (10)', () => {
    const callbacks: TagCallback[] = [];
    for (let i = 0; i < 15; i++) {
      callbacks.push({
        name: `tag${i}`,
        when: () => true,
        value: () => `v${i}`,
      });
    }
    const registry = createTagRegistry(callbacks);
    const entry: DiagnosticsEntry = { type: 'test', at: 0 };
    const tags = registry.tag(entry);
    assert.equal(tags.length, 10);
  });

  it('returns no tags when no callbacks are registered', () => {
    const registry = createTagRegistry([]);
    const entry: DiagnosticsEntry = { type: 'test', at: 0 };
    assert.deepEqual(registry.tag(entry), []);
  });
});

describe('DiagnosticsRecorder with tags', () => {
  const slowTag: TagCallback = {
    name: 'slow',
    when: (e: DiagnosticsEntry) => (e.durationMs ?? 0) > 100,
    value: () => 'true',
  };

  it('records derived tags on matching entries', () => {
    const recorder = createDiagnosticsRecorder({
      tags: [slowTag],
      clock: () => 0,
    });

    recorder.record({ type: 'http', durationMs: 200 });
    recorder.record({ type: 'http', durationMs: 50 });

    const all = recorder.entries();
    assert.equal(all.length, 2);
    assert.deepEqual(all[0]!.tags, ['slow:true']);
    assert.equal(all[1]!.tags, undefined);
  });

  it('records entries correctly even when a tag callback throws', () => {
    const throwing: TagCallback = {
      name: 'bad',
      when: () => {
        throw new Error('boom');
      },
      value: () => 'never',
    };
    const recorder = createDiagnosticsRecorder({
      tags: [throwing, slowTag],
      clock: () => 0,
    });

    recorder.record({ type: 'http', durationMs: 200 });
    const all = recorder.entries();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.type, 'http');
    assert.deepEqual(all[0]!.tags, ['slow:true']);
  });

  it('tags are recorder-derived, never caller-supplied', () => {
    const recorder = createDiagnosticsRecorder({
      tags: [slowTag],
      clock: () => 0,
    });

    // Caller attempts to pass tags — recorder derives its own.
    recorder.record({ type: 'http', durationMs: 200, tags: ['fake:tag'] });
    const entry = recorder.entries()[0]!;
    assert.deepEqual(entry.tags, ['slow:true']);
  });
});

describe('DiagnosticsRecorder monitoredCounts', () => {
  const slowTag: TagCallback = {
    name: 'slow',
    when: (e: DiagnosticsEntry) => (e.durationMs ?? 0) > 100,
    value: () => 'true',
  };

  const errorTag: TagCallback = {
    name: 'error',
    when: (e: DiagnosticsEntry) => e.type === 'failed:http',
    value: () => 'yes',
  };

  it('counts entries per monitored tag name', () => {
    const recorder = createDiagnosticsRecorder({
      tags: [slowTag, errorTag],
      monitored: ['slow', 'error'],
      clock: () => 0,
    });

    recorder.record({ type: 'http', durationMs: 200 }); // slow
    recorder.record({ type: 'http', durationMs: 200 }); // slow
    recorder.record({ type: 'http', durationMs: 50 }); // neither
    recorder.record({ type: 'failed:http' }); // error

    const s = recorder.stats();
    assert.equal(s.monitoredCounts!['slow'], 2);
    assert.equal(s.monitoredCounts!['error'], 1);
  });

  it('an entry with both tags counts for both monitored names', () => {
    const recorder = createDiagnosticsRecorder({
      tags: [slowTag, errorTag],
      monitored: ['slow', 'error'],
      clock: () => 0,
    });

    // Both tags match: type is 'failed:http' (matches error), durationMs > 100 (matches slow).
    recorder.record({ type: 'failed:http', durationMs: 200 });

    const s = recorder.stats();
    assert.equal(s.monitoredCounts!['slow'], 1);
    assert.equal(s.monitoredCounts!['error'], 1);
  });

  it('omits monitoredCounts when monitored is not set', () => {
    const recorder = createDiagnosticsRecorder({
      tags: [slowTag],
      clock: () => 0,
    });

    recorder.record({ type: 'http', durationMs: 200 });
    const s = recorder.stats();

    assert.equal(s.monitoredCounts, undefined);
    assert.ok('total' in s);
    assert.ok('byType' in s);
    assert.ok('withDuration' in s);
  });

  it('monitored with an empty array still produces an empty monitoredCounts', () => {
    const recorder = createDiagnosticsRecorder({
      tags: [slowTag],
      monitored: [],
      clock: () => 0,
    });

    recorder.record({ type: 'http', durationMs: 200 });
    const s = recorder.stats();
    assert.deepEqual(s.monitoredCounts, {});
  });

  it('monitored name with no matching entries yields zero', () => {
    const recorder = createDiagnosticsRecorder({
      tags: [slowTag],
      monitored: ['slow', 'missing'],
      clock: () => 0,
    });

    recorder.record({ type: 'http', durationMs: 200 }); // slow only
    const s = recorder.stats();
    assert.equal(s.monitoredCounts!['slow'], 1);
    assert.equal(s.monitoredCounts!['missing'], undefined);
  });
});
