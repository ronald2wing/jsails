/**
 * Exception watcher: captures unhandled errors through a caller-provided
 * `capture` hook and the optional request-failed signal, recording value-free
 * diagnostic entries for every exception family.
 *
 * Every entry carries `type: 'exception'` and `data` with `class`, `file`,
 * `line`, `frames` (a frame count only — the raw stack is never stored), and
 * an optional `context`. A `family` discriminator is built from the error
 * class and any caller-provided `context.family` so the recorder can derive a
 * stable `DiagnosticsEntry.familyHash` for deduplication.
 *
 * The watcher owns a bounded `Map` keyed by the same family hash, exposing
 * occurrence counts via `counts()`.
 */

import { createHash } from 'node:crypto';

import type { Watcher, WatcherContext } from '../watchers.js';
import type { SignalBus } from '../../signals/signal-bus.js';
import { requestFailed, type RequestSignalPayload } from '../../signals/request-signals.js';

// ---- Options & types ----

/** A handler that receives a captured error and returns nothing. */
export type CapturedErrorHandler = (captured: CapturedError) => void;

/**
 * Registers a captured-error handler and returns an unsubscribe function.
 * The returned function is called on teardown.
 */
export type ErrorSubscribe = (fn: CapturedErrorHandler) => () => void;

/** Options for {@link createExceptionWatcher}. */
export interface ExceptionWatcherOptions {
  /**
   * The shared signal bus. When present the watcher observes the
   * {@link requestFailed} event as an additional capture source.
   */
  readonly signals?: SignalBus;
  /**
   * Register the watcher's handler with the error-capture channel.
   * Called during `register` with the watcher's handler; the returned
   * function unsubscribes on teardown.
   */
  readonly capture: ErrorSubscribe;
  /**
   * Maximum distinct exception families the dedup map holds before it evicts
   * the oldest entry. Defaults to 1000.
   */
  readonly maxFamilies?: number;
}

/** An error the watcher processes, with optional caller-provided context. */
export interface CapturedError {
  /** The thrown value (an `Error` instance or any unknown throwable). */
  readonly error: unknown;
  /** Value-free context attached by the capture source. */
  readonly context?: Readonly<Record<string, unknown>>;
}

/** A {@link Watcher} that additionally exposes family occurrence counts. */
export interface ExceptionWatcher extends Watcher {
  /**
   * Return a frozen snapshot of the dedup counts, keyed by the 12-char
   * family hash.
   */
  counts(): ReadonlyMap<string, number>;
}

// ---- Internal helpers ----

const DEFAULT_MAX_FAMILIES = 1000;

/**
 * Extract the error class name. Falls back to `'Error'` for non-Error
 * throwables.
 */
function errorName(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'name' in error) {
    const name = (error as Record<string, unknown>).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return 'Error';
}

/** Match the first stack frame: `"    at FuncName (file:line:col)"` or `"    at file:line:col"`. */
const STACK_FRAME_RE = /^\s*at\s+(?:(?:.*?)\s+\((.+?):(\d+):\d+\)|(.+?):(\d+):\d+)\s*$/;

/**
 * Parse the first stack frame from `error.stack` without storing the raw
 * stack. Returns `{ file, line, frames }` where `frames` is a count of
 * stack lines.
 */
function parseStack(stack: unknown): {
  file: string | undefined;
  line: number | undefined;
  frames: number;
} {
  if (typeof stack !== 'string' || stack.length === 0) {
    return { file: undefined, line: undefined, frames: 0 };
  }

  const lines = stack.split('\n');
  let frames = 0;
  let file: string | undefined;
  let line: number | undefined;

  for (const ln of lines) {
    const match = ln.match(STACK_FRAME_RE);
    if (match) {
      frames++;
      if (file === undefined && line === undefined) {
        // First frame: file is match[1] (named) or match[3] (anonymous).
        file = match[1] ?? match[3] ?? undefined;
        const lineStr = match[2] ?? match[4];
        if (lineStr !== undefined) {
          const parsed = parseInt(lineStr, 10);
          if (!isNaN(parsed)) line = parsed;
        }
      }
    }
  }

  return { file, line, frames };
}

/** Build the family discriminator string from class name and context.family. */
function buildFamily(className: string, context?: Readonly<Record<string, unknown>>): string {
  const contextFamily = context?.family;
  if (typeof contextFamily === 'string' && contextFamily.length > 0) {
    return `${className}:${contextFamily}`;
  }
  return className;
}

/** Compute the 12-char hex family hash (same derivation as the recorder). */
function familyHash(family: string): string {
  return createHash('sha1').update('exception').update(family).digest('hex').slice(0, 12);
}

// ---- Factory ----

/**
 * Create an exception watcher: a {@link Watcher} that subscribes to the
 * caller's error-capture channel and (optionally) the request-failed signal,
 * recording value-free `exception` entries keyed by family hash.
 */
export function createExceptionWatcher(options: ExceptionWatcherOptions): ExceptionWatcher {
  const maxFamilies = options.maxFamilies ?? DEFAULT_MAX_FAMILIES;

  // Bounded LRU-like dedup map: insertion-ordered key list + value map.
  // When the map grows beyond maxFamilies, the oldest key is evicted.
  const countMap = new Map<string, number>();
  const keyOrder: string[] = [];

  const bumpCount = (hash: string): void => {
    const prev = countMap.get(hash) ?? 0;
    countMap.set(hash, prev + 1);

    // Move key to the end (most-recently-used).
    const idx = keyOrder.indexOf(hash);
    if (idx !== -1) keyOrder.splice(idx, 1);
    keyOrder.push(hash);

    // Evict oldest key when over capacity.
    while (keyOrder.length > maxFamilies) {
      const oldest = keyOrder.shift();
      if (oldest !== undefined) countMap.delete(oldest);
    }
  };

  const processError = (ctx: WatcherContext, captured: CapturedError): void => {
    const className = errorName(captured.error);
    const stack = (captured.error as Record<string, unknown> | null)?.stack;
    const { file, line, frames } = parseStack(stack);
    const family = buildFamily(className, captured.context);
    const hash = familyHash(family);

    bumpCount(hash);

    // Build value-free entry data — the raw stack string is never included.
    const data: Record<string, unknown> = {
      class: className,
      frames,
      family,
    };
    if (file !== undefined) data.file = file;
    if (line !== undefined) data.line = line;
    if (captured.context !== undefined && Object.keys(captured.context).length > 0) {
      data.context = captured.context;
    }

    try {
      ctx.record({ type: 'exception', data });
    } catch {
      // diagnostics must not throw into the observed path
    }
  };

  const register = (ctx: WatcherContext): (() => void) => {
    const unsubscribes: Array<() => void> = [];

    // Subscribe to the capture channel with the watcher's handler.
    const unsub = options.capture((captured: CapturedError): void => {
      processError(ctx, captured);
    });
    if (typeof unsub === 'function') {
      unsubscribes.push(unsub);
    }

    // Observe the request-failed signal when a signal bus is provided.
    if (options.signals !== undefined) {
      options.signals.observe(requestFailed, (payload: RequestSignalPayload) => {
        const context: Record<string, unknown> = {
          route: payload.route,
          method: payload.method,
        };
        processError(ctx, {
          error: payload.error,
          context,
        });
      });
    }

    return () => {
      for (const unsub of unsubscribes) {
        unsub();
      }
    };
  };

  return {
    name: 'exception',
    register,
    counts: (): ReadonlyMap<string, number> => {
      return new Map(countMap);
    },
  };
}
