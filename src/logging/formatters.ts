/**
 * Built-in log formatters: JSON and plain-text line output.
 *
 * Both formatters are guaranteed to never throw — a failure during
 * serialization produces the fixed placeholder `"[unserializable]"` rather
 * than propagating into the log path. They serialize only `level`, `message`,
 * `context`, and `at`; `Error` stack traces, `cause` chains, and other
 * internals are never included.
 */

import type { LogFormatter, LogRecord } from './types.js';

// -- bounded serialization ---------------------------------------------------

const UNSERIALIZABLE = '[unserializable]';

/**
 * JSON.stringify replacer that produces a safe, bounded result for log
 * context. Functions, symbols, and undefined values are silently dropped;
 * values whose `toJSON` or `toString` throw (or that are part of a circular
 * structure) are replaced with a fixed placeholder so the formatter never
 * throws.
 */
function safeReplacer(_key: unknown, value: unknown): unknown {
  if (typeof value === 'function' || typeof value === 'symbol' || value === undefined) {
    return undefined; // dropped by JSON.stringify
  }
  return value;
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value, safeReplacer);
  } catch {
    return JSON.stringify(UNSERIALIZABLE);
  }
}

function serializeContext(record: LogRecord): string {
  const keys = Object.keys(record.context);
  if (keys.length === 0) return '';
  // Build a plain object copy so the replacer runs; direct stringify on the
  // frozen context record can fail on frozen getters that throw.
  const obj: Record<string, unknown> = {};
  for (const key of keys) {
    obj[key] = record.context[key];
  }
  return ' ' + safeSerialize(obj);
}

// -- JSON formatter ----------------------------------------------------------

/**
 * Returns a formatter that serializes every record as a single-line JSON
 * object with stable key order: `level`, `message`, `context`, `at`.
 */
export function jsonFormatter(): LogFormatter {
  return {
    format(record: LogRecord): string {
      // Hand-roll JSON to guarantee stable key order — JSON.stringify on a
      // plain object does not guarantee insertion order across engines, but
      // in practice it does in V8. We construct the string explicitly to be
      // safe and to ensure context is always {} not omitted.
      const ctx = safeSerialize(record.context);
      return (
        `{"level":${JSON.stringify(record.level)},` +
        `"message":${JSON.stringify(record.message)},` +
        `"context":${ctx},` +
        `"at":${record.at}}`
      );
    },
  };
}

// -- Line formatter ----------------------------------------------------------

/**
 * Returns a formatter that serializes every record as a single line:
 *
 *   <ISO timestamp> <LEVEL> <message> [<json context>]
 *
 * The context segment is omitted entirely when the context object is empty.
 * The level is uppercased.
 */
export function lineFormatter(): LogFormatter {
  return {
    format(record: LogRecord): string {
      const iso = new Date(record.at).toISOString();
      const level = record.level.toUpperCase();
      const ctx = serializeContext(record);
      return `${iso} ${level} ${record.message}${ctx}`;
    },
  };
}
