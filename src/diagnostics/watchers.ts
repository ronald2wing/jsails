/**
 * Watcher contract and registry: a setup-scoped abstraction for pluggable
 * diagnostic watchers.
 *
 * A {@link Watcher} owns its own subscription and returns an unsubscribe from
 * `register`. The {@link WatcherRegistry} collects watchers during setup,
 * starts them, and invokes every unsubscribe on stop. The registry is sealed
 * after {@link WatcherRegistry.start} — no new watchers can be added — matching
 * the interceptor-registry discipline ({@link ./interceptors.ts:InterceptorError | InterceptorError}).
 */

import type { DiagnosticsEntry } from './recorder.js';

// ---- Error ----

/** Machine-readable failure reason for {@link WatcherError}. */
export type WatcherErrorCode = 'sealed' | 'invalid_watcher';

/** Raised for every watcher-registry invariant (duplicate name, late registration). */
export class WatcherError extends Error {
  readonly code: WatcherErrorCode;

  constructor(code: WatcherErrorCode, message: string) {
    super(message);
    this.name = 'WatcherError';
    this.code = code;
  }
}

// ---- Interfaces ----

/** Context provided to each watcher's `register` method during {@link WatcherRegistry.start}. */
export interface WatcherContext {
  /** Record a diagnostic entry (the `at` timestamp is supplied by the caller). */
  readonly record: (entry: Omit<DiagnosticsEntry, 'at'>) => void;
  /** Monotonic clock returning milliseconds since epoch. */
  readonly now: () => number;
}

/**
 * A diagnostic watcher that subscribes to one or more sources (signals,
 * TypeORM subscribers, etc.) and records entries through {@link WatcherContext}.
 */
export interface Watcher {
  /** Unique name for this watcher (e.g. "request", "query", "exception"). */
  readonly name: string;
  /**
   * Subscribe to diagnostic sources and return an unsubscribe function.
   * Called exactly once during `start`.
   */
  register(ctx: WatcherContext): () => void;
}

/**
 * A setup-scoped registry of {@link Watcher} instances.
 *
 * - `add` registers a watcher; rejects duplicate names and additions
 *   after `start` with a value-free {@link WatcherError}.
 * - `start` runs every watcher's `register` in registration order,
 *   collecting the returned unsubscribes.
 * - `stop` invokes every collected unsubscribe. Idempotent — a second
 *   call is a no-op.
 * - `list` returns the registered names in registration order.
 */
export interface WatcherRegistry {
  add(watcher: Watcher): void;
  start(ctx: WatcherContext): void;
  stop(): void;
  list(): readonly string[];
}

// ---- Factory ----

/** Create an empty, unsealed {@link WatcherRegistry}. */
export function createWatcherRegistry(): WatcherRegistry {
  const watchers: Watcher[] = [];
  const registeredNames = new Set<string>();
  const unsubscribes: Array<() => void> = [];
  let isSealed = false;
  let isStopped = false;

  const add = (watcher: Watcher): void => {
    if (isSealed) {
      throw new WatcherError('sealed', 'WatcherRegistry is sealed; cannot add new watchers');
    }
    if (typeof watcher !== 'object' || watcher === null) {
      throw new WatcherError('invalid_watcher', 'Watcher must be an object');
    }
    const { name } = watcher;
    if (typeof name !== 'string' || name.length === 0) {
      throw new WatcherError('invalid_watcher', 'Watcher name must be a non-empty string');
    }
    if (typeof watcher.register !== 'function') {
      throw new WatcherError('invalid_watcher', 'Watcher.register must be a function');
    }
    if (registeredNames.has(name)) {
      throw new WatcherError(
        'invalid_watcher',
        `Duplicate watcher name "${name}". Each watcher must have a unique name.`,
      );
    }
    watchers.push(watcher);
    registeredNames.add(name);
  };

  const start = (ctx: WatcherContext): void => {
    for (const watcher of watchers) {
      const unsubscribe = watcher.register(ctx);
      if (typeof unsubscribe === 'function') {
        unsubscribes.push(unsubscribe);
      }
    }
    isSealed = true;
  };

  const stop = (): void => {
    if (isStopped) return;
    isStopped = true;
    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }
  };

  const list = (): readonly string[] => watchers.map((w) => w.name);

  return { add, start, stop, list };
}
