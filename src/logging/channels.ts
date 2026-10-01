/**
 * Built-in log channels: console, in-memory buffer, and null (no-op).
 *
 * Channels are the only place where side effects happen. The console channel
 * lazily resolves `process.stdout`/`process.stderr` inside `write()` so that
 * importing this module in a non-Node bundler is safe.
 */

import { LoggerError } from './errors.js';
import { lineFormatter } from './formatters.js';
import type { LogChannel, LogFormatter, LogLevel, LogRecord } from './types.js';

// -- level validation --------------------------------------------------------

const LEVELS: ReadonlySet<string> = new Set(['debug', 'info', 'warn', 'error']);

function validateLevel(label: string, level: string): asserts level is LogLevel {
  if (!LEVELS.has(level)) {
    throw new LoggerError(
      'invalid_level',
      `Invalid log level for ${label}. Accepted levels: debug, info, warn, error.`,
    );
  }
}

// -- level ordering (for threshold filtering) --------------------------------

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function levelMeetsThreshold(recordLevel: LogLevel, minLevel: LogLevel): boolean {
  return LEVEL_ORDER[recordLevel] >= LEVEL_ORDER[minLevel];
}

// -- console channel ---------------------------------------------------------

/** Options for {@link consoleChannel}. */
export interface ConsoleChannelOptions {
  /** Minimum severity level; records below this are ignored. Default `'info'`. */
  readonly minLevel?: LogLevel | undefined;
  /**
   * Formatter applied to every record before writing. Defaults to
   * {@link lineFormatter}().
   */
  readonly formatter?: LogFormatter | undefined;
  /** Writer for `debug`/`info` lines. Defaults to `process.stdout.write`. */
  readonly stdout?: ((line: string) => void) | undefined;
  /** Writer for `warn`/`error` lines. Defaults to `process.stderr.write`. */
  readonly stderr?: ((line: string) => void) | undefined;
}

/**
 * Returns a channel that writes formatted lines to stdout (debug/info) and
 * stderr (warn/error). The `process` globals are resolved lazily inside
 * `write()` so importing this module is safe in non-Node environments.
 */
export function consoleChannel(options?: ConsoleChannelOptions): LogChannel {
  const minLevel: LogLevel = options?.minLevel ?? 'info';
  validateLevel('consoleChannel.minLevel', minLevel);

  const formatter = options?.formatter ?? lineFormatter();
  if (typeof formatter.format !== 'function') {
    throw new LoggerError(
      'invalid_options',
      'consoleChannel formatter must have a format function.',
    );
  }

  const stdoutWriter = options?.stdout;
  const stderrWriter = options?.stderr;

  if (stdoutWriter !== undefined && typeof stdoutWriter !== 'function') {
    throw new LoggerError('invalid_options', 'consoleChannel stdout must be a function.');
  }
  if (stderrWriter !== undefined && typeof stderrWriter !== 'function') {
    throw new LoggerError('invalid_options', 'consoleChannel stderr must be a function.');
  }

  return {
    name: 'console',
    minLevel,

    write(record: LogRecord): void {
      if (!levelMeetsThreshold(record.level, minLevel)) return;

      const line = formatter.format(record) + '\n';

      // Lazily resolve process.stdout/stderr so importing this module never
      // touches the process global — safe for bundlers that may tree-shake.
      if (record.level === 'warn' || record.level === 'error') {
        const writer =
          stderrWriter ??
          ((l: string) => {
            process.stderr.write(l);
          });
        writer(line);
      } else {
        const writer =
          stdoutWriter ??
          ((l: string) => {
            process.stdout.write(l);
          });
        writer(line);
      }
    },
  };
}

// -- memory channel ----------------------------------------------------------

/** Options for {@link memoryChannel}. */
export interface MemoryChannelOptions {
  /** Minimum severity level; records below this are ignored. Default `'debug'`. */
  readonly minLevel?: LogLevel | undefined;
}

/**
 * A channel that accumulates records in an internal buffer. Each call to
 * `write` pushes the raw {@link LogRecord} (not a formatted string) onto the
 * buffer. Use {@link MemoryChannel.records} to read the buffer and
 * {@link MemoryChannel.clear} to empty it.
 */
export interface MemoryChannel extends LogChannel {
  /** Returns a frozen snapshot of all records currently in the buffer. */
  records(): readonly LogRecord[];
  /** Empties the buffer. */
  clear(): void;
}

export function memoryChannel(options?: MemoryChannelOptions): MemoryChannel {
  const minLevel: LogLevel = options?.minLevel ?? 'debug';
  validateLevel('memoryChannel.minLevel', minLevel);

  const buffer: LogRecord[] = [];

  return {
    name: 'memory',
    minLevel,

    write(record: LogRecord): void {
      if (!levelMeetsThreshold(record.level, minLevel)) return;
      buffer.push(record);
    },

    records(): readonly LogRecord[] {
      return Object.freeze([...buffer]);
    },

    clear(): void {
      buffer.length = 0;
    },
  };
}

// -- null channel ------------------------------------------------------------

/** Options for {@link nullChannel}. */
export interface NullChannelOptions {
  /** Minimum severity level. Unused since writes are no-ops, but stored for
   * consistency with the {@link LogChannel} contract. Default `'debug'`. */
  readonly minLevel?: LogLevel | undefined;
}

/**
 * Returns a channel whose `write` is a no-op. Useful as a default or fallback
 * when no real channel is configured.
 */
export function nullChannel(options?: NullChannelOptions): LogChannel {
  const minLevel: LogLevel = options?.minLevel ?? 'debug';
  validateLevel('nullChannel.minLevel', minLevel);

  return {
    name: 'null',
    minLevel,

    write(_record: LogRecord): void {
      // intentional no-op
    },
  };
}
