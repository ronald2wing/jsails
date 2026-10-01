/**
 * Redis connection options and error routing for BullMQ producers and workers.
 *
 * A single `redisUrl` is turned into role-specific connection options:
 *
 * - **producer** (web-facing): a finite command-retry budget plus
 *   `enableOfflineQueue: false`, so `dispatch` fails fast instead of hanging a
 *   request while Redis is unreachable.
 * - **worker**: `maxRetriesPerRequest: null`, so the blocking pop the worker
 *   performs never gives up (a worker must outlive transient Redis blips).
 *
 * Error surfacing is non-silent by design. BullMQ re-emits backend errors on
 * its `Queue`/`Worker` `'error'` event, but drops them when no listener is
 * attached. Every queue/worker created by this library therefore gets an
 * `'error'` listener that routes to the caller's `onError` callback, or to a
 * default logger that prints `name: message` — never a job payload.
 */

import type { RedisOptions } from 'bullmq';

/** Role of a connection: shapes retry and offline-queue behavior. */
export type JobRole = 'producer' | 'worker';

/** Default queue name when none is supplied. */
export const DEFAULT_QUEUE_NAME = 'default';

/** Default Redis key prefix when none is supplied. */
export const DEFAULT_PREFIX = 'bull';

/**
 * Command-retry budget for producer connections. Commands that exhaust this
 * budget reject immediately, so a web producer fails fast rather than retrying
 * a command indefinitely.
 */
export const PRODUCER_MAX_RETRIES_PER_REQUEST = 3;

/**
 * Build the BullMQ `connection` options for a role.
 *
 * The returned options are passed straight through to BullMQ, which owns the
 * resulting Redis client(s) and closes them when the queue/worker closes.
 * Only `{ url, maxRetriesPerRequest }` is shaped here; no client is created,
 * so building options (and importing this module) never connects.
 */
export function buildConnectionOptions(redisUrl: string, role: JobRole): RedisOptions {
  if (role === 'worker') {
    return { url: redisUrl, maxRetriesPerRequest: null };
  }
  return {
    url: redisUrl,
    maxRetriesPerRequest: PRODUCER_MAX_RETRIES_PER_REQUEST,
    enableOfflineQueue: false,
  };
}

/** Receives connection and processing errors surfaced by a queue or worker. */
export type JobErrorHandler = (error: Error) => void;

/**
 * Default payload-free error logger used when the caller omits `onError`.
 * Logs only the error class and message; it never logs a job's data, so
 * payloads (which may carry secrets) cannot leak into logs.
 */
export function defaultErrorLogger(component: string, name: string): JobErrorHandler {
  return (error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`[jsails:jobs] ${component} "${name}" error: ${err.name}: ${err.message}`);
  };
}

/**
 * Attach an `'error'` listener that routes to `onError` or, when absent, to
 * `fallback`. This guarantees a queue/worker never emits an unhandled Redis
 * error even when the caller forgets to pass `onError`.
 */
export function attachErrorHandler(
  target: { on(eventName: 'error', listener: (error: Error) => void): unknown },
  onError: JobErrorHandler | undefined,
  fallback: JobErrorHandler,
): void {
  target.on('error', (error) => {
    (onError ?? fallback)(error);
  });
}
