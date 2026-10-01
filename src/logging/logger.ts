/**
 * Record-first structured logging: {@link RecordLogger} is the concrete
 * {@link Logger} implementation. Every method builds a frozen {@link LogRecord}
 * and writes it to every channel whose `minLevel` is at or below the record's
 * level.
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
import { logError } from './events.js';
import type { LogChannel, LogLevel, Logger, LogRecord } from './log-types.js';

// Options must be imported as `type` so the class accepts optional sinks
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
    throw new TypeError(
      `Invalid log level for ${label}. Accepted levels: debug, info, warn, error.`,
    );
  }
}

function validateChannel(channel: unknown, index: number): asserts channel is LogChannel {
  if (channel === null || typeof channel !== 'object') {
    throw new TypeError(`Channel at index ${index} is not an object.`);
  }

  const ch = channel as Record<string, unknown>;

  if (typeof ch.name !== 'string' || ch.name === '') {
    throw new TypeError(`Channel at index ${index} has an invalid or empty name.`);
  }

  if (typeof ch.minLevel !== 'string') {
    throw new TypeError(`Channel at index ${index} is missing a valid minLevel.`);
  }

  validateLevel(`channel[${index}].minLevel`, ch.minLevel);

  if (typeof ch.write !== 'function') {
    throw new TypeError(`Channel at index ${index} is missing a write function.`);
  }
}

function validateOptions(options: LoggerOptions): void {
  if (options.channels !== undefined) {
    if (!Array.isArray(options.channels)) {
      throw new TypeError('Logger channels must be an array.');
    }
    for (let i = 0; i < options.channels.length; i++) {
      validateChannel(options.channels[i], i);
    }
  }

  if (options.clock !== undefined && typeof options.clock !== 'function') {
    throw new TypeError('Logger clock must be a function.');
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

// -- logger -------------------------------------------------------------------

/**
 * The concrete {@link Logger} adapter: a record-first logger backed by the
 * given options.
 *
 * With no options, the logger writes to a single `consoleChannel()` (which
 * lazily resolves `process.stdout.write` inside `write()` — no process access
 * at construction time), uses `Date.now` as its clock, and has no diagnostics
 * or signals sinks wired.
 */
export class RecordLogger implements Logger {
  readonly #channels: readonly LogChannel[];
  readonly #clock: () => number;
  #boundCtx: Readonly<Record<string, unknown>>;
  readonly #diagnostics: DiagnosticsRecorder | undefined;
  readonly #signals: SignalBus | undefined;

  constructor(options?: LoggerOptions) {
    const opts = options ?? {};

    validateOptions(opts);

    this.#channels = opts.channels ?? [consoleChannel()];
    this.#clock = opts.clock ?? Date.now.bind(Date);

    // Bound context starts empty and frozen.
    this.#boundCtx = Object.freeze(Object.create(null));

    this.#diagnostics = opts.diagnostics;
    this.#signals = opts.signals;
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.#writeRecord('debug', message, context ?? {});
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.#writeRecord('info', message, context ?? {});
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.#writeRecord('warn', message, context ?? {});
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.#writeRecord('error', message, context ?? {});
  }

  child(childCtx: Record<string, unknown>): Logger {
    const merged = mergeContext(this.#boundCtx, childCtx);
    // Children share the same sinks — a child's error still emits logError
    // and records into the same diagnostics buffer.
    const child = new RecordLogger({
      channels: this.#channels,
      clock: this.#clock,
      diagnostics: this.#diagnostics,
      signals: this.#signals,
    });
    child.#boundCtx = merged;
    return child;
  }

  /**
   * Build a frozen {@link LogRecord}, then write it to every channel whose
   * `minLevel` is at or below `level`, then notify the optional diagnostics
   * and signals sinks.
   *
   * Channel writes and sink calls are isolated — a throwing channel or sink
   * never prevents the record from reaching other destinations. Log calls are
   * fire-and-forget by contract.
   */
  #writeRecord(level: LogLevel, message: string, context: Record<string, unknown>): void {
    const at = this.#clock();

    // Build the merged context: bound context first, then caller-supplied
    // context overrides on collision. Freeze the result so the caller cannot
    // mutate it after the call.
    const mergedCtx =
      Object.keys(context).length === 0 ? this.#boundCtx : mergeContext(this.#boundCtx, context);

    const record: LogRecord = { level, message, context: mergedCtx, at };

    // Write to each channel whose threshold is met. Isolate errors.
    for (let i = 0; i < this.#channels.length; i++) {
      const ch = this.#channels[i]!;
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
    if (this.#diagnostics !== undefined) {
      try {
        this.#diagnostics.record({ type: 'log', data: { level, message } });
      } catch {
        // Diagnostics failure must never propagate to the caller.
      }
    }

    // Signals emit: error-level records fire the shared logError event so an
    // observer can react (alerting, metrics, etc.) without coupling to a
    // channel. Non-error levels do not emit.
    if (this.#signals !== undefined && level === 'error') {
      try {
        // SignalBus.emit already isolates observer errors and never rejects;
        // .catch() guards against a mis-wired bus whose emit() rejects.
        this.#signals.emit(logError, record).catch(() => {});
      } catch {
        // Guard the synchronous emit call itself — emit could throw before
        // returning a promise (e.g. it's not callable).
      }
    }
  }
}
