/**
 * Composition tests: diagnostics and signals sinks wired into the log path.
 *
 * Covers:
 *  - diagnostics.record() is called on every log call with value-free data.
 *  - signals.emit(logError, record) is called only for error-level records.
 *  - Sink failures do not propagate to the caller.
 *  - child() loggers share the same sinks.
 *  - loggerPlugin() forwards both sinks.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDiagnosticsRecorder } from '../../src/diagnostics/recorder.js';
import { runExtensions } from '../../src/extensions/index.js';
import { createInterceptorRegistry } from '../../src/extensions/interceptors.js';
import { memoryChannel } from '../../src/logging/channels.js';
import { logError } from '../../src/logging/events.js';
import { createLogger } from '../../src/logging/logger.js';
import { loggerPlugin, loggerToken } from '../../src/logging/plugin.js';
import type { LogRecord } from '../../src/logging/types.js';
import { createSignalBus } from '../../src/signals/signal-bus.js';

import type { DiagnosticsRecorder } from '../../src/diagnostics/recorder.js';
import type { SignalBus } from '../../src/signals/signal-bus.js';

// -- helpers ------------------------------------------------------------------

/**
 * Build a logger with a memory channel and optional diagnostics / signals sinks.
 * Returns the logger and a way to read back what was written/recorded/emitted.
 */
function makeSinkLogger(options?: {
  readonly diagnostics?: DiagnosticsRecorder;
  readonly signals?: SignalBus;
}) {
  const mem = memoryChannel({ minLevel: 'debug' });
  const clock = (() => {
    let t = 0;
    return () => ++t;
  })();
  const logger = createLogger({
    channels: [mem],
    clock,
    diagnostics: options?.diagnostics,
    signals: options?.signals,
  });
  return { logger, mem, clock };
}

// -- diagnostics sink ---------------------------------------------------------

describe('diagnostics sink', () => {
  it('calls diagnostics.record({ type: "log", data: { level, message } }) on every log call', () => {
    const diag = createDiagnosticsRecorder();
    const { logger } = makeSinkLogger({ diagnostics: diag });

    logger.debug('debug msg');
    logger.info('info msg');
    logger.warn('warn msg');
    logger.error('error msg');

    const entries = diag.entries({ type: 'log' });
    assert.equal(entries.length, 4);

    const levels = entries.map((e) => e.data?.level);
    assert.deepEqual(levels, ['debug', 'info', 'warn', 'error']);

    const messages = entries.map((e) => e.data?.message);
    assert.deepEqual(messages, ['debug msg', 'info msg', 'warn msg', 'error msg']);
  });

  it('diagnostics entry is value-free — no context payload leaked into data', () => {
    const diag = createDiagnosticsRecorder();
    const { logger } = makeSinkLogger({ diagnostics: diag });

    // Log with potentially secret context — diagnostics must not leak it.
    logger.info('auth event', { token: 'secret-token', userId: 42 });

    const entries = diag.entries({ type: 'log' });
    assert.equal(entries.length, 1);

    const entry = entries[0]!;
    assert.equal(entry.type, 'log');
    assert.ok(entry.data !== undefined);

    // TypeScript narrows data after the assertion above.
    const data = entry.data;

    // data must contain only level and message, never context keys.
    assert.equal(data.level, 'info');
    assert.equal(data.message, 'auth event');
    assert.equal('token' in data, false, 'diagnostics data must not leak secret context');
    assert.equal('userId' in data, false, 'diagnostics data must not leak context keys');
    // Only the two expected keys should be present.
    assert.deepEqual(Object.keys(data).sort(), ['level', 'message']);
  });

  it('does not throw when diagnostics is not wired', () => {
    const { logger } = makeSinkLogger();

    // Must not throw — undefined diagnostics is handled gracefully.
    logger.info('no diag');
    logger.error('no diag error');
  });
});

// -- signals emit -------------------------------------------------------------

describe('signals sink', () => {
  it('emits logError for every error-level record with the full LogRecord', async () => {
    const registry = createInterceptorRegistry();
    const signals = createSignalBus(registry);
    const { logger } = makeSinkLogger({ signals });

    const emitted: LogRecord[] = [];
    registry.observe(logError, (payload) => {
      emitted.push(payload);
    });

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('first error', { code: 500, path: '/api' });
    logger.error('second error');

    // emit is async — wait for microtasks to flush.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(emitted.length, 2);

    const [r0, r1] = emitted;
    assert.equal(r0!.level, 'error');
    assert.equal(r0!.message, 'first error');
    assert.equal(r0!.context.code, 500);
    assert.equal(r0!.context.path, '/api');

    assert.equal(r1!.level, 'error');
    assert.equal(r1!.message, 'second error');
  });

  it('does NOT emit logError for non-error levels', async () => {
    const registry = createInterceptorRegistry();
    const signals = createSignalBus(registry);
    const { logger } = makeSinkLogger({ signals });

    let emitCount = 0;
    registry.observe(logError, () => {
      emitCount++;
    });

    logger.debug('d');
    logger.info('i');
    logger.warn('w');

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(emitCount, 0);
  });

  it('does not throw when signals is not wired', () => {
    const { logger } = makeSinkLogger();

    logger.error('error without signals');
  });

  it('a throwing signals observer does not propagate to the caller', async () => {
    const registry = createInterceptorRegistry();
    const signals = createSignalBus(registry);
    const { logger } = makeSinkLogger({ signals });

    let secondObserved = false;
    registry.observe(logError, () => {
      throw new Error('observer-failure');
    });
    registry.observe(logError, () => {
      secondObserved = true;
    });

    // Must not throw despite the throwing observer.
    logger.error('error with throwing observer');

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondObserved, true);
  });
});

// -- sink failure isolation ---------------------------------------------------

describe('sink failure isolation', () => {
  it('a throwing diagnostics.record does not propagate to the caller', () => {
    const throwingDiagnostics: DiagnosticsRecorder = {
      record(): void {
        throw new Error('diag-failure');
      },
      entries: () => [],
      clear: () => {},
      stats: () => ({ total: 0, byType: {}, withDuration: 0 }),
      wrapAsync: async (_type, fn) => fn(),
      pause: () => {},
      resume: () => {},
      isPaused: () => false,
      prune: () => 0,
    };

    const mem = memoryChannel({ minLevel: 'debug' });
    const logger = createLogger({
      channels: [mem],
      diagnostics: throwingDiagnostics,
    });

    // Must not throw — log call returns normally.
    logger.info('still works');

    // Channel still received the record.
    assert.equal(mem.records().length, 1);
    assert.equal(mem.records()[0]!.message, 'still works');
  });

  it('a thrown signal in the emit call itself (not an observer) does not propagate', async () => {
    // SignalBus.emit already isolates observer errors, but a caller-supplied
    // bus could throw on the emit call itself (e.g. a mis-wired mock).
    // The logger must guard that case too.
    const throwingSignals: SignalBus = {
      observe: () => {},
      emit: async () => {
        throw new Error('bus-failure');
      },
    };

    const mem = memoryChannel({ minLevel: 'debug' });
    const logger = createLogger({
      channels: [mem],
      signals: throwingSignals,
    });

    // Must not throw.
    logger.error('error with throwing bus');

    // Channel still received the record — the sink failure is isolated.
    assert.equal(mem.records().length, 1);
    assert.equal(mem.records()[0]!.message, 'error with throwing bus');
  });
});

// -- child loggers share sinks ------------------------------------------------

describe('child loggers share sinks', () => {
  it('a child logger error still emits logError', async () => {
    const registry = createInterceptorRegistry();
    const signals = createSignalBus(registry);
    const { logger } = makeSinkLogger({ signals });

    let emitted = false;
    registry.observe(logError, () => {
      emitted = true;
    });

    const child = logger.child({ requestId: 'abc' });
    child.error('child error');

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(emitted, true);
  });

  it('a child logger still records into the same diagnostics', () => {
    const diag = createDiagnosticsRecorder();
    const { logger } = makeSinkLogger({ diagnostics: diag });

    const child = logger.child({ component: 'api' });
    child.info('child info');

    const entries = diag.entries({ type: 'log' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.data!.level, 'info');
    assert.equal(entries[0]!.data!.message, 'child info');
  });

  it('nested child loggers all share the same sinks', async () => {
    const registry = createInterceptorRegistry();
    const signals = createSignalBus(registry);
    const diag = createDiagnosticsRecorder();
    const { logger } = makeSinkLogger({ signals, diagnostics: diag });

    let emitCount = 0;
    registry.observe(logError, () => {
      emitCount++;
    });

    const child = logger.child({ a: 1 });
    const grandchild = child.child({ b: 2 });
    grandchild.error('grandchild error');

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(emitCount, 1);
    assert.equal(diag.entries({ type: 'log' }).length, 1);
  });
});

// -- loggerPlugin forwards sinks ----------------------------------------------

describe('loggerPlugin forwards sinks', () => {
  it('loggerPlugin({ diagnostics }) wires the recorder', async () => {
    const diag = createDiagnosticsRecorder();
    const runtime = await runExtensions([loggerPlugin({ diagnostics: diag })]);
    const logger = runtime.services.get(loggerToken);

    try {
      logger.info('plugin info');
      logger.error('plugin error');

      const entries = diag.entries({ type: 'log' });
      assert.equal(entries.length, 2);

      // Verify value-free — no context leaked.
      for (const e of entries) {
        assert.ok(e.data !== undefined);
        const data = e.data;
        assert.equal('level' in data, true);
        assert.equal('message' in data, true);
        // Only the two expected keys.
        assert.equal(Object.keys(data).length, 2);
      }
    } finally {
      await runtime.close();
    }
  });

  it('loggerPlugin({ signals }) wires the signal bus', async () => {
    const registry = createInterceptorRegistry();
    const signals = createSignalBus(registry);

    let observed = false;
    registry.observe(logError, () => {
      observed = true;
    });

    const runtime = await runExtensions([loggerPlugin({ signals })]);
    const logger = runtime.services.get(loggerToken);

    try {
      logger.error('plugin error');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(observed, true);

      // Non-error levels do not emit.
      observed = false;
      logger.info('plugin info');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(observed, false);
    } finally {
      await runtime.close();
    }
  });

  it('loggerPlugin({ diagnostics, signals }) forwards both', async () => {
    const diag = createDiagnosticsRecorder();
    const registry = createInterceptorRegistry();
    const signals = createSignalBus(registry);

    let emitCount = 0;
    registry.observe(logError, () => {
      emitCount++;
    });

    const runtime = await runExtensions([loggerPlugin({ diagnostics: diag, signals })]);
    const logger = runtime.services.get(loggerToken);

    try {
      logger.info('info');
      logger.error('error');

      await new Promise((resolve) => setImmediate(resolve));

      // Diagnostics recorded both.
      assert.equal(diag.entries({ type: 'log' }).length, 2);
      // Only error emitted.
      assert.equal(emitCount, 1);
    } finally {
      await runtime.close();
    }
  });
});
