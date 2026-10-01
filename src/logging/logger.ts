/**
 * Logger factory: record-first construction that enforces the {@link Logger}
 * contract. Every method builds a frozen {@link LogRecord} and writes it to
 * every channel whose `minLevel` is at or below the record's level.
 *
 * Construction is inert — no I/O, no `process` access, no timers fire until a
 * log method is called. Channels, clock, diagnostics, and signals are injected
 * so the logger is fully testable without process-level mocking.
 *
 * When a {@link DiagnosticsRecorder} is wired, every log call records a
 * value-free `{ type: 'log', data: { level, message } }` entry — context is
 * intentionally excluded (it is caller-owned and may carry secrets). When a
 * {@link SignalBus} is wired, `error`-level records emit the shared
 * {@link logError} event. Both sinks are fire-and-forget by contract — a
 * throwing sink never propagates to the caller.
 */

import { consoleChannel } from './channels.js';
import { LoggerError } from './errors.js';
import { logError } from './events.js';
import type { LogChannel, LogLevel, Logger, LogRecord } from './types.js';

// Options must be imported as `type` so the factory accepts optional sinks
// without pulling in their full runtime modules.
import type { DiagnosticsRecorder } from '../diagnostics/recorder.js';
import type { SignalBus } from '../signals/signal-bus.js';

// -- level ordering -----------------------------------------------------------

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Valid log level strings kept in sync with the {@link LogLevel} type. */
const LEVELS: ReadonlySet<string> = new Set(Object.keys(LEVEL_ORDER));

function meetsThreshold(recordLevel: LogLevel, minLevel: LogLevel): boolean {
  return LEVEL_ORDER[recordLevel] >= LEVEL_ORDER[minLevel];
}

// -- options ------------------------------------------------------------------

export interface LoggerOptions {
  /**
   * Channels to write to on every log call. Each channel filters records
   * independently by its own `minLevel`. Default: `[consoleChannel()]`.
   */
  readonly channels?: readonly LogChannel[];
  /**
   * Clock returning milliseconds since epoch. Every record carries the
   * timestamp from this clock so formatters never fall back to `Date.now()`.
   * Default: `Date.now`.
   */
  readonly clock?: () => number;
  /**
   * Optional diagnostics recorder. When wired, every log call records a
   * value-free `{ type: 'log', data: { level, message } }` entry.
   */
  readonly diagnostics?: DiagnosticsRecorder;
  /**
   * Optional signal bus. When wired, `error`-level records emit the shared
   * {@link logError} event with the full {@link LogRecord} as payload.
   */
  readonly signals?: SignalBus;
}

// -- validation ---------------------------------------------------------------

function validateLevel(label: string, value: string): asserts value is LogLevel {
  if (!LEVELS.has(value)) {
    throw new LoggerError(
      'invalid_level',
      `Invalid log level for ${label}. Accepted levels: debug, info, warn, error.`,
    );
  }
}

function validateChannel(channel: unknown, index: number): asserts channel is LogChannel {
  if (channel === null || typeof channel !== 'object') {
    throw new LoggerError('invalid_options', `Channel at index ${index} is not an object.`);
  }

  const ch = channel as Record<string, unknown>;

  if (typeof ch.name !== 'string' || ch.name === '') {
    throw new LoggerError(
      'invalid_options',
      `Channel at index ${index} has an invalid or empty name.`,
    );
  }

  if (typeof ch.minLevel !== 'string') {
    throw new LoggerError(
      'invalid_options',
      `Channel at index ${index} is missing a valid minLevel.`,
    );
  }

  validateLevel(`channel[${index}].minLevel`, ch.minLevel);

  if (typeof ch.write !== 'function') {
    throw new LoggerError(
      'invalid_options',
      `Channel at index ${index} is missing a write function.`,
    );
  }
}

function validateOptions(options: LoggerOptions): void {
  if (options.channels !== undefined) {
    if (!Array.isArray(options.channels)) {
      throw new LoggerError('invalid_options', 'Logger channels must be an array.');
    }
    for (let i = 0; i < options.channels.length; i++) {
      validateChannel(options.channels[i], i);
    }
  }

  if (options.clock !== undefined && typeof options.clock !== 'function') {
    throw new LoggerError('invalid_options', 'Logger clock must be a function.');
  }
}

// -- context helpers ----------------------------------------------------------

/**
 * Merge parent and child context objects (parent first) into a single frozen
 * copy. The child's keys override the parent's on collision. Both inputs are
 * treated as plain own-enumerable data.
 */
function mergeContext(
  parent: Readonly<Record<string, unknown>>,
  child: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const merged: Record<string, unknown> = Object.assign({}, parent);
  for (const key in child) {
    if (Object.prototype.hasOwnProperty.call(child, key)) {
      merged[key] = child[key];
    }
  }
  return Object.freeze(merged);
}

// -- log methods --------------------------------------------------------------

/**
 * Build a frozen {@link LogRecord}, then write it to every channel whose
 * `minLevel` is at or below `level`, then notify the optional diagnostics
 * and signals sinks.
 *
 * Channel writes and sink calls are isolated — a throwing channel or sink
 * never prevents the record from reaching other destinations. Log calls are
 * fire-and-forget by contract.
 */
function writeRecord(
  channels: readonly LogChannel[],
  clock: () => number,
  boundCtx: Readonly<Record<string, unknown>>,
  diagnostics: DiagnosticsRecorder | undefined,
  signals: SignalBus | undefined,
  level: LogLevel,
  message: string,
  context: Record<string, unknown>,
): void {
  const at = clock();

  // Build the merged context: bound context first, then caller-supplied
  // context overrides on collision. Freeze the result so the caller cannot
  // mutate it after the call.
  const mergedCtx = Object.keys(context).length === 0 ? boundCtx : mergeContext(boundCtx, context);

  const record: LogRecord = { level, message, context: mergedCtx, at };

  // Write to each channel whose threshold is met. Isolate errors.
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i]!;
    if (!meetsThreshold(level, ch.minLevel)) continue;
    try {
      ch.write(record);
    } catch {
      // Channel write failure must never propagate to the caller — log calls
      // are fire-and-forget by contract.
    }
  }

  // Diagnostics sink: record a value-free entry. Context is intentionally
  // excluded — it is caller-owned and may carry secrets, while diagnostics
  // entries stay value-free by contract.
  if (diagnostics !== undefined) {
    try {
      diagnostics.record({ type: 'log', data: { level, message } });
    } catch {
      // Diagnostics failure must never propagate to the caller.
    }
  }

  // Signals emit: error-level records fire the shared logError event so an
  // observer can react (alerting, metrics, etc.) without coupling to a
  // channel. Non-error levels do not emit.
  if (signals !== undefined && level === 'error') {
    try {
      // SignalBus.emit already isolates observer errors and never rejects;
      // .catch() guards against a mis-wired bus whose emit() rejects.
      signals.emit(logError, record).catch(() => {});
    } catch {
      // Guard the synchronous emit call itself — emit could throw before
      // returning a promise (e.g. it's not callable).
    }
  }
}

// -- recursive child builder --------------------------------------------------

/**
 * Recursive child logger builder for arbitrary nesting depth. Each level
 * merges the parent's bound context with the child's.
 */
function buildChildLogger(
  channels: readonly LogChannel[],
  clock: () => number,
  boundCtx: Readonly<Record<string, unknown>>,
  diagnostics: DiagnosticsRecorder | undefined,
  signals: SignalBus | undefined,
): Logger {
  function makeLogFn(level: LogLevel) {
    return (message: string, context?: Record<string, unknown>) =>
      writeRecord(channels, clock, boundCtx, diagnostics, signals, level, message, context ?? {});
  }

  return {
    debug: makeLogFn('debug'),
    info: makeLogFn('info'),
    warn: makeLogFn('warn'),
    error: makeLogFn('error'),
    child(childCtx: Record<string, unknown>): Logger {
      const merged = mergeContext(boundCtx, childCtx);
      // Children share the same sinks — a child's error still emits logError
      // and records into the same diagnostics buffer.
      return buildChildLogger(channels, clock, merged, diagnostics, signals);
    },
  };
}

// -- factory ------------------------------------------------------------------

/**
 * Returns a fully-constructed {@link Logger} backed by the given options.
 *
 * With no options, the logger writes to a single `consoleChannel()` (which
 * lazily resolves `process.stdout.write` inside `write()` — no process access
 * at construction time), uses `Date.now` as its clock, and has no diagnostics
 * or signals sinks wired.
 */
export function createLogger(options?: LoggerOptions): Logger {
  const opts = options ?? {};

  validateOptions(opts);

  const channels: readonly LogChannel[] = opts.channels ?? [consoleChannel()];
  const clock = opts.clock ?? Date.now.bind(Date);

  // Bound context starts empty and frozen.
  const boundCtx: Readonly<Record<string, unknown>> = Object.freeze(Object.create(null));

  return buildChildLogger(channels, clock, boundCtx, opts.diagnostics, opts.signals);
}
