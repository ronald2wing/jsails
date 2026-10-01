/**
 * Logging plugin tests: service wiring through the extension runner, channel
 * propagation, option validation, and inert construction. No connection,
 * database, or external service is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runExtensions } from '../../src/extensions/index.js';
import { memoryChannel } from '../../src/logging/channels.js';
import { LoggerError } from '../../src/logging/errors.js';
import { loggerPlugin, loggerToken, type LoggerPluginOptions } from '../../src/logging/plugin.js';
import type { Logger, LogRecord } from '../../src/logging/types.js';

// -- helpers ------------------------------------------------------------------

/** Resolve a logger from a plugin and return it together with a teardown for cleanup. */
async function pluginLogger(
  options?: LoggerPluginOptions,
): Promise<{ logger: Logger; close(): Promise<void> }> {
  const runtime = await runExtensions([loggerPlugin(options)]);
  const logger: Logger = runtime.services.get(loggerToken);
  return { logger, close: () => runtime.close() };
}

describe('loggerPlugin', () => {
  it('has name "logger" and a stable token', () => {
    assert.equal(loggerToken.name, 'logger');
    assert.equal(loggerPlugin().name, 'logger');
  });

  it('provides a Logger service under the token', async () => {
    const { logger, close } = await pluginLogger();
    try {
      assert.equal(typeof logger.debug, 'function');
      assert.equal(typeof logger.info, 'function');
      assert.equal(typeof logger.warn, 'function');
      assert.equal(typeof logger.error, 'function');
      assert.equal(typeof logger.child, 'function');
    } finally {
      await close();
    }
  });

  it('logger service is usable — info/warn/error do not throw', async () => {
    // The default logger writes to process.stdout/stderr via consoleChannel().
    // We only assert the calls do not throw; we do not assert output content.
    const { logger, close } = await pluginLogger();
    try {
      logger.info('plugin test info');
      logger.warn('plugin test warn');
      logger.error('plugin test error');
    } finally {
      await close();
    }
  });

  it('provided channels are used verbatim — memory channel receives records', async () => {
    const mem = memoryChannel({ minLevel: 'debug' });
    const { logger, close } = await pluginLogger({ channels: [mem] });

    try {
      logger.info('hello from plugin', { key: 'val' });

      const records: readonly LogRecord[] = mem.records();
      assert.equal(records.length, 1);
      assert.equal(records[0]!.message, 'hello from plugin');
      assert.equal(records[0]!.level, 'info');
      assert.equal(records[0]!.context.key, 'val');
    } finally {
      await close();
    }
  });

  it('child loggers from the plugin service merge context correctly', async () => {
    const mem = memoryChannel({ minLevel: 'debug' });
    const { logger, close } = await pluginLogger({ channels: [mem] });

    try {
      const child = logger.child({ requestId: 'abc' });
      child.info('child log', { extra: 1 });

      const records = mem.records();
      assert.equal(records.length, 1);
      assert.equal(records[0]!.context.requestId, 'abc');
      assert.equal(records[0]!.context.extra, 1);
    } finally {
      await close();
    }
  });

  it('injectable clock is passed through to records', async () => {
    const mem = memoryChannel();
    const { logger, close } = await pluginLogger({
      channels: [mem],
      clock: () => 42,
    });

    try {
      logger.info('timed');
      assert.equal(mem.records()[0]!.at, 42);
    } finally {
      await close();
    }
  });

  it('construction is inert — loggerPlugin() performs no I/O', () => {
    const plugin = loggerPlugin();
    assert.equal(typeof plugin.name, 'string');
    assert.equal(typeof plugin.setup, 'function');

    // loggerPlugin() with no channels still creates consoleChannel() internally
    // during setup, but consoleChannel() only touches process inside write().
    // The plugin object itself is just a plain descriptor — no side effects.
    const pluginWithOpts = loggerPlugin({
      channels: [memoryChannel()],
      clock: () => 0,
    });
    assert.equal(pluginWithOpts.name, 'logger');
  });
});

describe('option validation', () => {
  it('throws LoggerError for non-array channels (validated by createLogger)', async () => {
    await assert.rejects(
      async () => {
        const runtime = await runExtensions([loggerPlugin({ channels: 'nope' as never })]);
        // cleanup should still run
        await runtime.close();
      },
      (err: unknown) => {
        assert.ok(err instanceof LoggerError);
        assert.equal(err.code, 'invalid_options');
        // The message should not echo the value 'nope'.
        assert.ok(!err.message.includes('nope'));
        return true;
      },
    );
  });

  it('throws LoggerError for a non-function clock', async () => {
    await assert.rejects(
      async () => {
        const runtime = await runExtensions([loggerPlugin({ clock: 123 as never })]);
        await runtime.close();
      },
      (err: unknown) => {
        assert.ok(err instanceof LoggerError);
        assert.equal(err.code, 'invalid_options');
        return true;
      },
    );
  });
});

describe('idempotent close', () => {
  it('closes idempotently with no handles held', async () => {
    const runtime = await runExtensions([loggerPlugin()]);
    await runtime.close();
    await runtime.close();
  });
});
