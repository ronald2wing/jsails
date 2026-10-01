/**
 * Fake HTTP client for tests (`jsails/http`).
 *
 * `createFakeHttp()` returns an `HttpClient`-shaped object backed by a
 * `respond` handler seam. Inert construction — no connection, no state
 * until `respond` is configured.
 *
 * The handler receives `{ method, path, body? }` and must return
 * `{ status, body? }`. A non-2xx status raises a value-free
 * `HttpClientError`; an unmatched route raises one with status `0`.
 */

import { HttpClientError } from './client.js';
import type { HttpClient, RequestOptions } from './client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single fake-route handler. */
export interface FakeHttpHandler {
  (request: FakeHttpRequest): FakeHttpResponse | Promise<FakeHttpResponse>;
}

/** The request a handler receives. Never carries headers or URL details. */
export interface FakeHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

/** The response a handler returns. */
export interface FakeHttpResponse {
  readonly status: number;
  readonly body?: unknown;
}

// ---------------------------------------------------------------------------
// Client shape (HttpClient compat)
// ---------------------------------------------------------------------------

/** A fake HTTP client that dispatches every request through a single handler. */
export interface FakeHttpClient extends HttpClient {
  /**
   * Register the route handler. Only one handler is active at a time —
   * calling `respond` again replaces the previous handler.
   */
  respond(handler: FakeHttpHandler): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fake HTTP client for use in tests and demos.
 *
 * ```ts
 * const fake = createFakeHttp();
 * fake.respond(({ method, path }) => {
 *   if (method === 'GET' && path === '/users/1') {
 *     return { status: 200, body: { id: 1, name: 'Alice' } };
 *   }
 *   return { status: 404 };
 * });
 * const user = await fake.get<User>('/users/1');
 * ```
 */
export function createFakeHttp(): FakeHttpClient {
  let handler: FakeHttpHandler | null = null;

  /** Dispatch a single request through the handler, mapping results to
   *  `HttpClientError` where needed. */
  async function dispatch(method: string, path: string, body?: unknown): Promise<unknown> {
    if (handler === null) {
      throw new HttpClientError('No fake HTTP handler configured.', 0);
    }

    let result: FakeHttpResponse;
    try {
      result = await handler({ method, path, body });
    } catch {
      throw new HttpClientError('Fake HTTP handler threw.', 0);
    }

    if (result.status < 200 || result.status >= 300) {
      throw new HttpClientError(`HTTP ${String(result.status)}: request failed.`, result.status);
    }

    return result.body;
  }

  const client: FakeHttpClient = {
    respond(next: FakeHttpHandler): void {
      handler = next;
    },

    get<T = unknown>(path: string, _opts?: RequestOptions): Promise<T> {
      return dispatch('GET', path) as Promise<T>;
    },
    post<T = unknown>(path: string, body?: unknown, _opts?: RequestOptions): Promise<T> {
      return dispatch('POST', path, body) as Promise<T>;
    },
    put<T = unknown>(path: string, body?: unknown, _opts?: RequestOptions): Promise<T> {
      return dispatch('PUT', path, body) as Promise<T>;
    },
    patch<T = unknown>(path: string, body?: unknown, _opts?: RequestOptions): Promise<T> {
      return dispatch('PATCH', path, body) as Promise<T>;
    },
    delete<T = unknown>(path: string, _opts?: RequestOptions): Promise<T> {
      return dispatch('DELETE', path) as Promise<T>;
    },
  };

  return client;
}
