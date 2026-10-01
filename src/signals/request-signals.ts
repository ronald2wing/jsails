/**
 * Request lifecycle signal payload and event tokens.
 *
 * These events are emitted by the built-in API pipeline at well-defined
 * boundaries — before the CSRF/authorize gates, after the handler returns, and
 * on handler/middleware throw — so a plugin can observe every request through
 * the shared signal bus without touching the Hono pipeline.
 *
 * Payloads are deliberately value-free: no request body, no headers, no
 * cookies. The `session` field carries the resolved session object (may be
 * null); it is server-only and must never reach the browser boundary.
 */

import { defineEvent } from '../extensions/interceptors.js';

/** Snapshot of a request at the point a lifecycle signal fires. */
export interface RequestSignalPayload {
  /** The native {@link Request} (body is never read or buffered). */
  readonly request: Request;
  /** Parsed URL; query parameters are available but never parsed by the signal. */
  readonly url: URL;
  /** Route parameters (e.g. `{ id: '42' }`). */
  readonly params: Readonly<Record<string, string>>;
  /** Resolved session object (null when no session resolver is configured). */
  readonly session: unknown;
  /** HTTP method (e.g. `'GET'`, `'POST'`). */
  readonly method: string;
  /** Best available route identifier for the request. */
  readonly route: string;
  /** Response status (present only on `requestFinished`). */
  readonly status?: number;
  /** Wall-clock duration in milliseconds from `requestStarted` to this event. */
  readonly durationMs?: number;
  /** The thrown error (present only on `requestFailed`; never echoes its message). */
  readonly error?: unknown;
}

/** Emitted once per API request, after session resolution and before the CSRF/authorize gates. */
export const requestStarted = defineEvent<RequestSignalPayload>('request.started');

/** Emitted when the handler (or any intermediate gate) returns a Response successfully. */
export const requestFinished = defineEvent<RequestSignalPayload>('request.finished');

/** Emitted when the handler or middleware throws, before re-throwing to the 500 envelope. */
export const requestFailed = defineEvent<RequestSignalPayload>('request.failed');
