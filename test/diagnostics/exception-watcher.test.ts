/**
 * Exception watcher tests: stack parsing, family-hash dedup, bounded map,
 * re-entrancy guard, and value-free entry data (raw stack never stored).
 * No connections or external services are used.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDiagnosticsRecorder } from '../../src/diagnostics/index.js';
import {
  createExceptionWatcher,
  type CapturedError,
  type CapturedErrorHandler,
  type ErrorSubscribe,
} from '../../src/diagnostics/watchers/exception.js';
import type { WatcherContext } from '../../src/diagnostics/watchers.js';

/** Build a capture and fire helper for testing exception watchers. */
function createTestCapture() {
  const subscribers = new Set<CapturedErrorHandler>();

  const capture: ErrorSubscribe = (handler) => {
    subscribers.add(handler);
    return () => {
      subscribers.delete(handler);
    };
  };

  const fire = (e: CapturedError): void => {
    for (const sub of subscribers) {
      sub(e);
    }
  };

  return { capture, fire };
}

describe('createExceptionWatcher', () => {
  it('emits a watcher named "exception"', () => {
    const { capture } = createTestCapture();

    const watcher = createExceptionWatcher({ capture });
    assert.equal(watcher.name, 'exception');
    assert.equal(typeof watcher.register, 'function');
  });

  it('records exception entries with class, file, line, and frame count', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 5000 });

    const { capture, fire } = createTestCapture();
    const watcher = createExceptionWatcher({ capture });

    const ctx: WatcherContext = {
      record: (entry) => recorder.record(entry),
      now: () => 5000,
    };
    const unsub = watcher.register(ctx);

    const error = new Error('something broke');
    fire({ error, context: { family: 'db' } });

    unsub();

    const entries = recorder.entries({ type: 'exception' });
    assert.equal(entries.length, 1);

    const data = entries[0]!.data!;
    assert.equal(data['class'], 'Error');
    assert.equal(typeof data['frames'], 'number');
    assert.ok((data['frames'] as number) >= 1);
    assert.equal(typeof data['file'], 'string');
    assert.ok((data['file'] as string).length > 0);
    assert.equal(typeof data['line'], 'number');
    assert.ok((data['line'] as number) >= 1);
    assert.equal(data['family'], 'Error:db');
    assert.deepEqual(data['context'], { family: 'db' });
  });

  it('never includes the raw stack string in the entry data', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    const { capture, fire } = createTestCapture();
    const watcher = createExceptionWatcher({ capture });

    const ctx: WatcherContext = {
      record: (entry) => recorder.record(entry),
      now: () => 0,
    };
    const unsub = watcher.register(ctx);

    const error = new Error('test');
    fire({ error });

    unsub();

    const entries = recorder.entries({ type: 'exception' });
    assert.equal(entries.length, 1);

    const data = entries[0]!.data!;

    // Ensure no value in the data object contains the raw stack.
    for (const value of Object.values(data)) {
      if (typeof value === 'string') {
        assert.ok(
          !value.includes('at '),
          `raw stack frame leaked into data field: ${String(value).slice(0, 80)}`,
        );
      }
    }

    // The `stack` key must not be present.
    assert.equal('stack' in data, false);
  });

  it('produces consistent familyHash for same class + context.family', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    const { capture, fire } = createTestCapture();
    const watcher = createExceptionWatcher({ capture });

    const ctx: WatcherContext = {
      record: (entry) => recorder.record(entry),
      now: () => 0,
    };
    const unsub = watcher.register(ctx);

    fire({ error: new TypeError('a'), context: { family: 'api' } });
    fire({ error: new TypeError('b'), context: { family: 'api' } });

    unsub();

    const entries = recorder.entries({ type: 'exception' });
    assert.equal(entries.length, 2);

    const hash0 = entries[0]!.familyHash;
    const hash1 = entries[1]!.familyHash;

    assert.equal(typeof hash0, 'string');
    assert.equal(hash0!.length, 12);
    assert.equal(hash0, hash1);
  });

  it('produces different familyHash for different context.family', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    const { capture, fire } = createTestCapture();
    const watcher = createExceptionWatcher({ capture });

    const ctx: WatcherContext = {
      record: (entry) => recorder.record(entry),
      now: () => 0,
    };
    const unsub = watcher.register(ctx);

    fire({ error: new Error('a'), context: { family: 'api' } });
    fire({ error: new Error('a'), context: { family: 'db' } });

    unsub();

    const entries = recorder.entries({ type: 'exception' });
    assert.equal(entries.length, 2);
    assert.notEqual(entries[0]!.familyHash, entries[1]!.familyHash);
  });

  it('tracks rising occurrence counts for the same family', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    const { capture, fire } = createTestCapture();
    const watcher = createExceptionWatcher({ capture });

    const ctx: WatcherContext = {
      record: (entry) => recorder.record(entry),
      now: () => 0,
    };
    const unsub = watcher.register(ctx);

    fire({ error: new Error('boom'), context: { family: 'queue' } });
    assert.equal(watcher.counts().size, 1);
    const hash = [...watcher.counts().keys()][0]!;
    assert.equal(watcher.counts().get(hash), 1);

    fire({ error: new Error('boom'), context: { family: 'queue' } });
    assert.equal(watcher.counts().size, 1);
    assert.equal(watcher.counts().get(hash), 2);

    unsub();
  });

  it('separates counts by family', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    const { capture, fire } = createTestCapture();
    const watcher = createExceptionWatcher({ capture });

    const ctx: WatcherContext = {
      record: (entry) => recorder.record(entry),
      now: () => 0,
    };
    const unsub = watcher.register(ctx);

    fire({ error: new TypeError('a'), context: { family: 'api' } });
    fire({ error: new TypeError('a'), context: { family: 'api' } });
    fire({ error: new SyntaxError('b'), context: { family: 'db' } });

    const counts = watcher.counts();
    assert.equal(counts.size, 2);

    const apiHash = [...counts.keys()].find((k) => counts.get(k) === 2);
    const dbHash = [...counts.keys()].find((k) => counts.get(k) === 1);
    assert.ok(apiHash !== undefined);
    assert.ok(dbHash !== undefined);

    unsub();
  });

  it('uses class-only family discriminator when context.family is absent', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    const { capture, fire } = createTestCapture();
    const watcher = createExceptionWatcher({ capture });

    const ctx: WatcherContext = {
      record: (entry) => recorder.record(entry),
      now: () => 0,
    };
    const unsub = watcher.register(ctx);

    const err = new RangeError('out of bounds');
    fire({ error: err });

    unsub();

    const data = recorder.entries()[0]!.data!;
    assert.equal(data['family'], 'RangeError');
    assert.equal(data['context'], undefined);
  });

  it('falls back to Error class for non-Error throwables', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    const { capture, fire } = createTestCapture();
    const watcher = createExceptionWatcher({ capture });

    const ctx: WatcherContext = {
      record: (entry) => recorder.record(entry),
      now: () => 0,
    };
    const unsub = watcher.register(ctx);

    fire({ error: 'just a string' });

    unsub();

    const data = recorder.entries()[0]!.data!;
    assert.equal(data['class'], 'Error');
    assert.equal(data['family'], 'Error');
  });

  it('handles errors with no stack (fallback to zero frames)', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    const { capture, fire } = createTestCapture();
    const watcher = createExceptionWatcher({ capture });

    const ctx: WatcherContext = {
      record: (entry) => recorder.record(entry),
      now: () => 0,
    };
    const unsub = watcher.register(ctx);

    fire({ error: {} });

    unsub();

    const data = recorder.entries()[0]!.data!;
    assert.equal(data['frames'], 0);
    assert.equal(data['file'], undefined);
    assert.equal(data['line'], undefined);
  });

  it('enforces maxFamilies by evicting the oldest family', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    const { capture, fire } = createTestCapture();
    const watcher = createExceptionWatcher({
      capture,
      maxFamilies: 2,
    });

    const ctx: WatcherContext = {
      record: (entry) => recorder.record(entry),
      now: () => 0,
    };
    const unsub = watcher.register(ctx);

    fire({ error: new Error('a'), context: { family: 'f1' } });
    fire({ error: new Error('b'), context: { family: 'f2' } });
    // Map is now full (2 families).
    assert.equal(watcher.counts().size, 2);

    // Evicts the oldest ("f1").
    fire({ error: new Error('c'), context: { family: 'f3' } });
    assert.equal(watcher.counts().size, 2);

    unsub();
  });
});

describe('exception watcher re-entrancy', () => {
  it('survives a throwing recorder without propagating', () => {
    const { capture, fire } = createTestCapture();
    const watcher = createExceptionWatcher({ capture });

    let thrown = false;
    const ctx: WatcherContext = {
      record: () => {
        thrown = true;
        throw new Error('recorder failure');
      },
      now: () => 0,
    };

    const unsub = watcher.register(ctx);

    // This must not throw — the watcher swallows the recorder error.
    fire({ error: new Error('test') });
    assert.equal(thrown, true);

    unsub();
  });
});

describe('exception watcher signal integration', () => {
  it('observes requestFailed when signals is provided', () => {
    const recorder = createDiagnosticsRecorder({ clock: () => 0 });

    // Minimal fake signal bus that fires synchronously.
    const observers: Array<(p: unknown) => void> = [];
    const fakeSignals = {
      observe(_event: unknown, fn: (p: unknown) => void): void {
        observers.push(fn);
      },
      emit: async () => [],
    };

    const { capture } = createTestCapture();
    const watcher = createExceptionWatcher({
      capture,
      signals: fakeSignals as never,
    });

    const ctx: WatcherContext = {
      record: (entry) => recorder.record(entry),
      now: () => 0,
    };
    const unsub = watcher.register(ctx);

    // Simulate a requestFailed signal payload.
    const signalError = new Error('handler crash');
    for (const obs of observers) {
      obs({
        error: signalError,
        route: 'GET /api/users',
        method: 'GET',
        request: new Request('http://localhost/'),
        url: new URL('http://localhost/'),
        params: {},
        session: null,
        status: 500,
        durationMs: 42,
      });
    }

    unsub();

    const entries = recorder.entries({ type: 'exception' });
    assert.equal(entries.length, 1);

    const data = entries[0]!.data!;
    assert.equal(data['class'], 'Error');
    // The signal captures do not carry context.family, so family is just the class.
    assert.equal(data['family'], 'Error');
  });
});
