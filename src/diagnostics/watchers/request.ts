/**
 * Request lifecycle watcher: records 'request' / 'failed:request' diagnostic
 * entries by observing requestFinished and requestFailed signals.
 *
 * Value-free by construction: only method, route, status, durationMs, and a
 * computed `slow` flag are recorded. Headers, body, url, params, and session
 * details never appear in entries.
 */

import { requestFailed, requestFinished, type SignalBus } from '../../signals/index.js';
import type { RequestSignalPayload } from '../../signals/request-signals.js';
import type { Watcher, WatcherContext } from '../watchers.js';

/** Options for the request watcher. */
export interface RequestWatcherOptions {
  /** Signal bus carrying request lifecycle events. */
  readonly signals: SignalBus;
  /**
   * Duration threshold in milliseconds at and above which a request is
   * flagged as slow. Defaults to 1000.
   */
  readonly slowMs?: number;
}

const DEFAULT_SLOW_MS = 1000;

/**
 * Build a request data payload for a {@link DiagnosticsEntry}. Only the five
 * value-free fields are recorded — headers, body, url, and params are
 * deliberately excluded.
 */
function buildRequestData(
  payload: RequestSignalPayload,
  slowThreshold: number,
): Readonly<Record<string, unknown>> {
  return {
    method: payload.method,
    route: payload.route,
    status: payload.status,
    durationMs: payload.durationMs,
    slow: (payload.durationMs ?? 0) >= slowThreshold,
  };
}

/**
 * Create a diagnostic watcher that records every finished and failed HTTP
 * request through the provided signal bus.
 *
 * `register(ctx)` subscribes to `requestFinished` and `requestFailed` on the
 * bus and returns an unsubscribe that detaches both. Because the signal bus
 * does not support observer removal, "detach" is implemented via a flag so
 * the observers become no-ops.
 */
export function createRequestWatcher(options: RequestWatcherOptions): Watcher {
  const slowThreshold = options.slowMs ?? DEFAULT_SLOW_MS;

  return {
    name: 'request',

    register(ctx: WatcherContext): () => void {
      let detached = false;

      options.signals.observe(requestFinished, (payload: RequestSignalPayload) => {
        if (detached) return;
        ctx.record({
          type: 'request',
          data: buildRequestData(payload, slowThreshold),
        });
      });

      options.signals.observe(requestFailed, (payload: RequestSignalPayload) => {
        if (detached) return;
        ctx.record({
          type: 'failed:request',
          data: buildRequestData(payload, slowThreshold),
        });
      });

      return () => {
        detached = true;
      };
    },
  };
}
