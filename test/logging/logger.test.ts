/**
 * Logger tests: factory construction, level-threshold filtering, child()
 * context merging, clock injection, context immutability, option validation,
 * and inert construction.
 *
 * All assertions that depend on record contents use an explicit memory channel
 * so the tests are deterministic and side-effect-free.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { memoryChannel } from '../../src/logging/channels.js';
import { LoggerError } from '../../src/logging/errors.js';
import { createLogger } from '../../src/logging/logger.js';
import type { Logger, LogLevel, LogRecord } from '../../src/logging/types.js';

// -- helpers ------------------------------------------------------------------

function makeLogger(
  channels?: ReturnType<typeof memoryChannel>[],
  clock?: () => number,
): {
  logger: Logger;
  mem: ReturnType<typeof memoryChannel>;
} {
  const mem = channels?.[0] ?? memoryChannel();
  const logger = createLogger({ channels: [mem, ...(channels?.slice(1) ?? [])], clock });
  return { logger, mem };
}

function lastRecord(mem: ReturnType<typeof memoryChannel>): LogRecord {
  const all = mem.records();
  assert.ok(all.length > 0, 'expected at least one record');
  return all[all.length - 1]!;
}

// -- level-threshold filtering -----------------------------------------------

describe('createLogger', () => {
  describe('level-threshold filtering', () => {
    it('writes debug records when channel minLevel is debug', () => {
      const mem = memoryChannel({ minLevel: 'debug' });
      const { logger } = makeLogger([mem]);

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      assert.equal(mem.records().length, 4);
    });

    it('writes info and above when channel minLevel is info', () => {
      const mem = memoryChannel({ minLevel: 'info' });
      const { logger } = makeLogger([mem]);

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      const all = mem.records();
      assert.equal(all.length, 3);
      const levels = all.map((r) => r.level);
      assert.deepEqual(levels, ['info', 'warn', 'error']);
    });

    it('writes only warn and error when channel minLevel is warn', () => {
      const mem = memoryChannel({ minLevel: 'warn' });
      const { logger } = makeLogger([mem]);

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      const all = mem.records();
      assert.equal(all.length, 2);
      const levels = all.map((r) => r.level);
      assert.deepEqual(levels, ['warn', 'error']);
    });

    it('writes only error when channel minLevel is error', () => {
      const mem = memoryChannel({ minLevel: 'error' });
      const { logger } = makeLogger([mem]);

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      const all = mem.records();
      assert.equal(all.length, 1);
      assert.equal(all[0]!.level, 'error');
    });

    it('each channel filters independently by its own minLevel', () => {
      const memAll = memoryChannel({ minLevel: 'debug' });
      const memWarn = memoryChannel({ minLevel: 'warn' });

      const logger = createLogger({ channels: [memAll, memWarn] });

      logger.debug('d');
      logger.info('i');
      logger.error('e');

      assert.equal(memAll.records().length, 3);
      assert.equal(memWarn.records().length, 1);
    });
  });

  // -- child() context merging ------------------------------------------------

  describe('child() context merging', () => {
    it('bound context appears in every record', () => {
      const { logger, mem } = makeLogger();
      const child = logger.child({ userId: 42, traceId: 'abc' });

      child.info('first');
      child.warn('second');

      const all = mem.records();
      assert.equal(all.length, 2);
      for (const r of all) {
        assert.equal(r.context.userId, 42);
        assert.equal(r.context.traceId, 'abc');
      }
    });

    it('child key overrides parent on collision', () => {
      const { logger, mem } = makeLogger();
      const parent = logger.child({ env: 'prod', region: 'us-east' });
      const child = parent.child({ region: 'eu-west' });

      child.info('test');

      const rec = lastRecord(mem);
      assert.equal(rec.context.env, 'prod');
      // Child override wins.
      assert.equal(rec.context.region, 'eu-west');
    });

    it('nested child().child() merge order: parent -> child -> grandchild', () => {
      const { logger, mem } = makeLogger();
      const child = logger.child({ a: 1 });
      const grandchild = child.child({ b: 2, a: 99 });

      grandchild.info('test');

      const rec = lastRecord(mem);
      assert.equal(rec.context.a, 99); // grandchild overrides child
      assert.equal(rec.context.b, 2);
    });

    it('parent context is not mutated when creating a child', () => {
      const { logger, mem } = makeLogger();
      const parent = logger.child({ shared: 'original' });
      parent.child({ shared: 'override' });

      // Parent still writes with its own context.
      parent.info('after child creation');
      const rec = lastRecord(mem);
      assert.equal(rec.context.shared, 'original');
    });

    it('root logger context is empty', () => {
      const { logger, mem } = makeLogger();
      logger.info('bare');
      const rec = lastRecord(mem);
      assert.equal(Object.keys(rec.context).length, 0);
    });

    it('child context merges with per-call context (caller overrides child)', () => {
      const { logger, mem } = makeLogger();
      // Bound context is merged first, then caller-supplied context overrides.
      const child = logger.child({ repo: 'jsails', action: 'bound' });
      child.info('test', { action: 'called', extra: true });

      const rec = lastRecord(mem);
      assert.equal(rec.context.repo, 'jsails');
      assert.equal(rec.context.action, 'called');
      assert.equal(rec.context.extra, true);
    });
  });

  // -- clock injection --------------------------------------------------------

  describe('clock injection', () => {
    it('record.at comes from the injected clock', () => {
      const { logger, mem } = makeLogger(undefined, () => 999);
      logger.info('x');
      assert.equal(lastRecord(mem).at, 999);
    });

    it('default clock is Date.now (produces a realistic timestamp)', () => {
      const { logger, mem } = makeLogger();
      const before = Date.now();
      logger.info('x');
      const after = Date.now();
      const rec = lastRecord(mem);
      assert.ok(rec.at >= before, `at ${rec.at} < before ${before}`);
      assert.ok(rec.at <= after, `at ${rec.at} > after ${after}`);
    });
  });

  // -- context immutability ---------------------------------------------------

  describe('context immutability', () => {
    it('record.context is a frozen copy — mutating caller object does not change record', () => {
      const { logger, mem } = makeLogger();
      const ctx: Record<string, unknown> = { x: 1 };
      logger.info('msg', ctx);

      // Mutate caller's object after the call.
      ctx.x = 99;
      ctx.y = 2;

      const rec = lastRecord(mem);
      assert.equal(rec.context.x, 1); // original value preserved
      assert.equal(Object.keys(rec.context).length, 1); // no new keys leaked in
    });

    it('record.context is frozen', () => {
      const { logger, mem } = makeLogger();
      logger.info('msg', { x: 1 });

      const rec = lastRecord(mem);
      assert.throws(
        () => {
          (rec.context as Record<string, unknown>).x = 2;
        },
        { message: /frozen|read.only|immutable/i },
      );
    });

    it('per-call context = {} is not required', () => {
      const { logger, mem } = makeLogger();
      logger.info('no context');
      const rec = lastRecord(mem);
      assert.equal(Object.keys(rec.context).length, 0);
    });
  });

  // -- no-options default -----------------------------------------------------

  describe('default options', () => {
    it('createLogger() with no options does not throw', () => {
      const logger = createLogger();
      assert.ok(logger);
      assert.equal(typeof logger.info, 'function');
      assert.equal(typeof logger.debug, 'function');
      assert.equal(typeof logger.warn, 'function');
      assert.equal(typeof logger.error, 'function');
      assert.equal(typeof logger.child, 'function');
    });

    it('default logger does not throw on log call', () => {
      const logger = createLogger();
      // Debug defaults to the console channel whose minLevel is 'info', so a
      // debug call is a silent no-op. Info/warn/error write to stdout/stderr;
      // we only assert they do not throw.
      logger.debug('debug msg');
      logger.info('info msg');
      logger.warn('warn msg');
      logger.error('error msg');
    });
  });

  // -- inert construction -----------------------------------------------------

  describe('inert construction', () => {
    it('createLogger performs no I/O at construction', () => {
      // Construction with no channels listed still creates consoleChannel()
      // which only touches process inside write(). We verify that merely
      // calling createLogger() succeeds without side effects.
      const logger = createLogger();
      assert.ok(logger);
    });

    it('construction is pure — same options produce independently usable loggers', () => {
      const mem1 = memoryChannel();
      const mem2 = memoryChannel();
      const logger1 = createLogger({ channels: [mem1], clock: () => 1 });
      const logger2 = createLogger({ channels: [mem2], clock: () => 2 });

      logger1.info('a');
      logger2.info('b');

      assert.equal(mem1.records().length, 1);
      assert.equal(mem2.records().length, 1);
      assert.equal(mem1.records()[0]!.at, 1);
      assert.equal(mem2.records()[0]!.at, 2);
    });
  });

  // -- channel isolation ------------------------------------------------------

  describe('channel isolation', () => {
    it('a throwing channel does not prevent writes to other channels', () => {
      const mem = memoryChannel();
      const throwingChannel = {
        name: 'thrower',
        minLevel: 'debug' as LogLevel,
        write(_record: LogRecord): void {
          throw new Error('channel-failure');
        },
      };

      const logger = createLogger({ channels: [throwingChannel, mem] });

      // Must not throw.
      logger.info('hello');

      assert.equal(mem.records().length, 1);
    });

    it('a throwing channel does not propagate the error to caller', () => {
      const throwingChannel = {
        name: 'thrower',
        minLevel: 'debug' as LogLevel,
        write(_record: LogRecord): void {
          throw new Error('channel-failure');
        },
      };

      const logger = createLogger({ channels: [throwingChannel] });

      // Must not throw.
      logger.info('hello');
      logger.error('still no throw');
    });
  });

  // -- option validation ------------------------------------------------------

  describe('option validation', () => {
    it('throws LoggerError for non-array channels', () => {
      assert.throws(
        () => createLogger({ channels: 'not-an-array' as never }),
        (err: unknown) => {
          assert.ok(err instanceof LoggerError);
          assert.equal(err.code, 'invalid_options');
          assert.equal(err.name, 'LoggerError');
          return true;
        },
      );
    });

    it('throws LoggerError for a channel that is not an object', () => {
      assert.throws(
        () => createLogger({ channels: [null as never] }),
        (err: unknown) => {
          assert.ok(err instanceof LoggerError);
          assert.equal(err.code, 'invalid_options');
          return true;
        },
      );
    });

    it('throws LoggerError for a channel missing a name', () => {
      assert.throws(
        () =>
          createLogger({
            channels: [{ minLevel: 'debug', write: () => {} } as never],
          }),
        (err: unknown) => {
          assert.ok(err instanceof LoggerError);
          assert.equal(err.code, 'invalid_options');
          return true;
        },
      );
    });

    it('throws LoggerError for a channel with an empty name', () => {
      assert.throws(
        () =>
          createLogger({
            channels: [{ name: '', minLevel: 'debug', write: () => {} } as never],
          }),
        (err: unknown) => {
          assert.ok(err instanceof LoggerError);
          assert.equal(err.code, 'invalid_options');
          return true;
        },
      );
    });

    it('throws LoggerError for a channel missing write function', () => {
      assert.throws(
        () =>
          createLogger({
            channels: [{ name: 'ch', minLevel: 'debug' } as never],
          }),
        (err: unknown) => {
          assert.ok(err instanceof LoggerError);
          assert.equal(err.code, 'invalid_options');
          return true;
        },
      );
    });

    it('throws LoggerError for a channel with invalid minLevel', () => {
      assert.throws(
        () =>
          createLogger({
            channels: [{ name: 'ch', minLevel: 'fatal', write: () => {} } as never],
          }),
        (err: unknown) => {
          assert.ok(err instanceof LoggerError);
          assert.equal(err.code, 'invalid_level');
          return true;
        },
      );
    });

    it('throws LoggerError for a non-function clock', () => {
      assert.throws(
        () => createLogger({ clock: 123 as never }),
        (err: unknown) => {
          assert.ok(err instanceof LoggerError);
          assert.equal(err.code, 'invalid_options');
          return true;
        },
      );
    });

    it('value-free error messages — no caller values echoed', () => {
      assert.throws(
        () => createLogger({ channels: [123 as never] }),
        (err: unknown) => {
          assert.ok(err instanceof LoggerError);
          // The message must not contain the raw value '123'.
          assert.ok(!err.message.includes('123'));
          return true;
        },
      );
    });
  });
});
