/**
 * Channel tests: memory buffer, null no-op, console routing, threshold
 * filtering, and option validation.
 *
 * No real stdout/stderr writes — the console channel is exercised through
 * injected writers only so the tests are deterministic and side-effect-free.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { consoleChannel, memoryChannel, nullChannel } from '../../src/logging/channels.js';
import { LoggerError } from '../../src/logging/errors.js';
import type { LogRecord } from '../../src/logging/types.js';

const BASE: LogRecord = {
  level: 'info',
  message: 'hello',
  context: {},
  at: 1700000000000,
};

function record(overrides: Partial<LogRecord>): LogRecord {
  return { ...BASE, ...overrides };
}

// -- memory channel ----------------------------------------------------------

describe('memoryChannel', () => {
  it('starts empty', () => {
    const ch = memoryChannel();
    assert.deepEqual(ch.records(), []);
  });

  it('records() returns raw LogRecord[], not formatted strings', () => {
    const ch = memoryChannel();
    ch.write(record({ level: 'debug', message: 'first' }));

    const all = ch.records();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.level, 'debug');
    assert.equal(all[0]!.message, 'first');
    assert.equal(all[0]!.at, 1700000000000);
  });

  it('clear() empties the buffer', () => {
    const ch = memoryChannel();
    ch.write(record({ message: 'a' }));
    ch.write(record({ message: 'b' }));
    assert.equal(ch.records().length, 2);

    ch.clear();
    assert.equal(ch.records().length, 0);
  });

  it('records snapshot is frozen (immutable)', () => {
    const ch = memoryChannel();
    ch.write(record({}));
    const snapshot = ch.records();

    assert.throws(() => {
      (snapshot as LogRecord[]).push(record({}));
    });
  });

  it('filters records below minLevel', () => {
    const ch = memoryChannel({ minLevel: 'warn' });
    ch.write(record({ level: 'debug' }));
    ch.write(record({ level: 'info' }));
    ch.write(record({ level: 'warn', message: 'kept' }));
    ch.write(record({ level: 'error', message: 'also kept' }));

    const all = ch.records();
    assert.equal(all.length, 2);
    assert.ok(all.every((r) => r.level === 'warn' || r.level === 'error'));
  });

  it('defaults minLevel to debug (accepts everything)', () => {
    const ch = memoryChannel();
    ch.write(record({ level: 'debug' }));
    assert.equal(ch.records().length, 1);
  });
});

// -- null channel ------------------------------------------------------------

describe('nullChannel', () => {
  it('write is a no-op and does not throw', () => {
    const ch = nullChannel();
    // Must not throw for any level.
    ch.write(record({ level: 'debug' }));
    ch.write(record({ level: 'info' }));
    ch.write(record({ level: 'warn' }));
    ch.write(record({ level: 'error' }));
  });

  it('has name "null"', () => {
    const ch = nullChannel();
    assert.equal(ch.name, 'null');
  });

  it('defaults minLevel to debug', () => {
    const ch = nullChannel();
    assert.equal(ch.minLevel, 'debug');
  });
});

// -- console channel ---------------------------------------------------------

describe('consoleChannel', () => {
  it('routes debug/info to stdout and warn/error to stderr', () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const ch = consoleChannel({
      stdout: (line) => stdoutLines.push(line),
      stderr: (line) => stderrLines.push(line),
      minLevel: 'debug',
    });

    ch.write(record({ level: 'debug', message: 'd' }));
    ch.write(record({ level: 'info', message: 'i' }));
    ch.write(record({ level: 'warn', message: 'w' }));
    ch.write(record({ level: 'error', message: 'e' }));

    assert.equal(stdoutLines.length, 2);
    assert.ok(stdoutLines.every((l) => l.includes('d') || l.includes('i')));
    assert.equal(stderrLines.length, 2);
    assert.ok(stderrLines.every((l) => l.includes('w') || l.includes('e')));
  });

  it('filters records below minLevel', () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const ch = consoleChannel({
      stdout: (line) => stdoutLines.push(line),
      stderr: (line) => stderrLines.push(line),
      minLevel: 'warn',
    });

    ch.write(record({ level: 'debug', message: 'd' }));
    ch.write(record({ level: 'info', message: 'i' }));
    ch.write(record({ level: 'warn', message: 'w' }));

    assert.equal(stdoutLines.length, 0);
    assert.equal(stderrLines.length, 1);
  });

  it('appends newline to each line', () => {
    const stdoutLines: string[] = [];
    const ch = consoleChannel({
      stdout: (line) => stdoutLines.push(line),
      minLevel: 'debug',
    });

    ch.write(record({ level: 'info', message: 'abc' }));
    assert.ok(stdoutLines[0]!.endsWith('\n'));
  });

  it('defaults formatter to lineFormatter', () => {
    const stdoutLines: string[] = [];
    const ch = consoleChannel({
      stdout: (line) => stdoutLines.push(line),
      minLevel: 'debug',
    });

    ch.write(record({ level: 'info', message: 'test', at: 1700000000000 }));
    const line = stdoutLines[0]!;
    // lineFormatter format: <ISO> <LEVEL> <message>
    assert.ok(line.includes('INFO test'));
    assert.ok(line.startsWith('2023'));
  });
});

// -- level validation --------------------------------------------------------

describe('minLevel validation', () => {
  it('throws LoggerError for invalid minLevel on memoryChannel', () => {
    assert.throws(
      () => memoryChannel({ minLevel: 'critical' as never }),
      (err: unknown) => {
        assert.ok(err instanceof LoggerError);
        // Value-free: the message must not echo 'critical'.
        assert.ok(!err.message.includes('critical'));
        assert.equal(err.code, 'invalid_level');
        assert.equal(err.name, 'LoggerError');
        return true;
      },
    );
  });

  it('throws LoggerError for invalid minLevel on consoleChannel', () => {
    assert.throws(
      () => consoleChannel({ minLevel: 'fatal' as never }),
      (err: unknown) => {
        assert.ok(err instanceof LoggerError);
        assert.equal(err.code, 'invalid_level');
        return true;
      },
    );
  });

  it('throws LoggerError for invalid minLevel on nullChannel', () => {
    assert.throws(
      () => nullChannel({ minLevel: 'verbose' as never }),
      (err: unknown) => {
        assert.ok(err instanceof LoggerError);
        assert.equal(err.code, 'invalid_level');
        return true;
      },
    );
  });
});

// -- option validation -------------------------------------------------------

describe('option validation', () => {
  it('throws LoggerError for non-function formatter', () => {
    assert.throws(
      () => consoleChannel({ formatter: { format: 'not-a-function' } as never }),
      (err: unknown) => {
        assert.ok(err instanceof LoggerError);
        assert.equal(err.code, 'invalid_options');
        return true;
      },
    );
  });

  it('throws LoggerError for non-function stdout', () => {
    assert.throws(
      () => consoleChannel({ stdout: 'not-a-function' as never }),
      (err: unknown) => {
        assert.ok(err instanceof LoggerError);
        assert.equal(err.code, 'invalid_options');
        return true;
      },
    );
  });

  it('throws LoggerError for non-function stderr', () => {
    assert.throws(
      () => consoleChannel({ stderr: 123 as never }),
      (err: unknown) => {
        assert.ok(err instanceof LoggerError);
        assert.equal(err.code, 'invalid_options');
        return true;
      },
    );
  });
});
