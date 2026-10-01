/**
 * Query watcher: records 'query' diagnostic entries via an injected subscriber.
 *
 * Value-free by construction: only the parameterized SQL, a count of
 * bindings, and a computed `slow` flag are stored. Bindings themselves
 * never appear in any entry. No TypeORM import or connection is required.
 */

import type { Watcher, WatcherContext } from '../watchers.js';

/** An observed query event produced by the caller's TypeORM hook. */
export interface QueryEvent {
  /** Parameterized SQL. */
  readonly sql: string;
  /** Bound parameter values (counted, never stored). */
  readonly bindings?: readonly unknown[];
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
}

/** Options for the query watcher. */
export interface QueryWatcherOptions {
  /**
   * Subscribe to query events. Receives a recording callback and returns
   * an unsubscribe function.
   */
  readonly onQuery: (fn: (event: QueryEvent) => void) => () => void;
  /**
   * Duration threshold in milliseconds at and above which a query is
   * flagged as slow. Defaults to 100.
   */
  readonly slowMs?: number;
}

const DEFAULT_QUERY_SLOW_MS = 100;

/**
 * Build a query data payload for a {@link DiagnosticsEntry}. Only `sql`,
 * `bindingCount`, and `slow` are recorded — bindings themselves are never
 * included.
 */
function buildQueryData(
  event: QueryEvent,
  slowThreshold: number,
): Readonly<Record<string, unknown>> {
  return {
    sql: event.sql,
    bindingCount: event.bindings?.length ?? 0,
    slow: event.durationMs >= slowThreshold,
  };
}

/**
 * Create a diagnostic watcher that records every database query through the
 * injected `onQuery` subscriber. No TypeORM import or connection is required —
 * the caller wires the subscriber to its data source outside this module.
 */
export function createQueryWatcher(options: QueryWatcherOptions): Watcher {
  const slowThreshold = options.slowMs ?? DEFAULT_QUERY_SLOW_MS;

  return {
    name: 'query',

    register(ctx: WatcherContext): () => void {
      let detached = false;

      const unsub = options.onQuery((event: QueryEvent): void => {
        if (detached) return;
        ctx.record({
          type: 'query',
          data: buildQueryData(event, slowThreshold),
        });
      });

      return () => {
        detached = true;
        unsub();
      };
    },
  };
}
