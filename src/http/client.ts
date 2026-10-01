/**
 * Thin fetch-based HTTP client seam (`jsails/http`).
 *
 * `FetchHttpClient` is a `new`-able HTTP client with typed `get`/`post`/`put`/
 * `patch`/`delete` methods. Every method encodes and decodes JSON, enforces a
 * bounded timeout via AbortController, and surfaces failures as value-free
 * `HttpClientError`s whose messages never echo the request URL or response body.
 *
 * Pass an injectable `fetch` for testing: the client uses the native
 * `globalThis.fetch` by default, but a test can supply a stub.
 */

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** A value-free HTTP client error. Never echoes the request URL or body. */
export class HttpClientError extends Error {
  /** HTTP status code, or `0` when the request was aborted or a network error
   * occurred. */
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpClientError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for {@link FetchHttpClient}. */
export interface HttpClientOptions {
  /** Base URL prepended to every request path. Must not include credentials. */
  readonly baseUrl?: string;
  /** Headers included with every request. */
  readonly headers?: Record<string, string>;
  /**
   * Injectable `fetch` function. Defaults to `globalThis.fetch`. Pass a stub
   * in tests to avoid network calls.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Request timeout in milliseconds. Defaults to 30 000 (30 seconds).
   * Set to `0` to disable the timeout.
   */
  readonly timeoutMs?: number;
  /**
   * Maximum number of automatic retries after a retryable failure. Defaults
   * to `0` (no retries). Each retry issues a fresh fetch call.
   */
  readonly retries?: number;
  /**
   * HTTP status codes that trigger a retry. Defaults to
   * `[408, 429, 500, 502, 503, 504]`. Ignored when `retries` is `0`.
   */
  readonly retryStatuses?: readonly number[];
  /**
   * Optional predicate to determine whether a given response status and
   * attempt number (1-based) should trigger a retry. When set it overrides
   * the `retryStatuses` list for the decision. Ignored when `retries` is `0`.
   */
  readonly shouldRetry?: (status: number, attempt: number) => boolean;
  /**
   * Optional delay in milliseconds before each retry. Defaults to `0`
   * (immediate retry). Useful for simple backoff in tests.
   */
  readonly retryDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** An HTTP client with typed JSON methods. */
export interface HttpClient {
  /** Send a GET request. Returns JSON-decoded response body. */
  get<T = unknown>(path: string, options?: RequestOptions): Promise<T>;

  /** Send a POST request with a JSON body. Returns JSON-decoded response body. */
  post<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;

  /** Send a PUT request with a JSON body. Returns JSON-decoded response body. */
  put<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;

  /** Send a PATCH request with a JSON body. Returns JSON-decoded response body. */
  patch<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;

  /** Send a DELETE request. Returns JSON-decoded response body if any. */
  delete<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
}

/** Per-request overrides. */
export interface RequestOptions {
  /** Extra headers merged on top of the client defaults. */
  readonly headers?: Record<string, string>;
  /** Per-request timeout override in milliseconds. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_STATUSES: readonly number[] = [408, 429, 500, 502, 503, 504];

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * A fetch-based HTTP client with JSON encoding/decoding, bounded timeouts,
 * retries, and value-free error reporting.
 *
 * ```ts
 * const api = new FetchHttpClient({ baseUrl: 'https://api.example.com/v1' });
 * const user = await api.get<User>('/users/1');
 * ```
 */
export class FetchHttpClient implements HttpClient {
  #baseUrl: string;
  #defaultHeaders: Record<string, string>;
  #fetchFn: typeof globalThis.fetch;
  #timeoutMs: number;
  #retryCtx: RetryContext;

  constructor(options: HttpClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? '';
    this.#defaultHeaders = options.headers ?? {};
    this.#fetchFn = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = options.retries ?? 0;
    const retryStatuses = options.retryStatuses ?? DEFAULT_RETRY_STATUSES;
    const shouldRetry = options.shouldRetry ?? null;
    const retryDelayMs = options.retryDelayMs ?? 0;
    this.#retryCtx = { maxRetries, retryStatuses, shouldRetry, retryDelayMs };
  }

  async get<T = unknown>(path: string, opts?: RequestOptions): Promise<T> {
    return this.#request<T>({ method: 'GET', path, headers: this.#defaultHeaders }, opts);
  }

  async post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.#request<T>({ method: 'POST', path, body, headers: this.#defaultHeaders }, opts);
  }

  async put<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.#request<T>({ method: 'PUT', path, body, headers: this.#defaultHeaders }, opts);
  }

  async patch<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.#request<T>({ method: 'PATCH', path, body, headers: this.#defaultHeaders }, opts);
  }

  async delete<T = unknown>(path: string, opts?: RequestOptions): Promise<T> {
    return this.#request<T>({ method: 'DELETE', path, headers: this.#defaultHeaders }, opts);
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  async #request<T>(
    internal: Omit<InternalRequest, 'baseUrl' | 'fetchFn' | 'timeoutMs'>,
    opts?: RequestOptions,
  ): Promise<T> {
    const maxRetries = this.#retryCtx.maxRetries;

    let lastError: HttpClientError | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.#attemptRequest<T>(internal, opts);
      } catch (error: unknown) {
        lastError =
          error instanceof HttpClientError
            ? error
            : new HttpClientError(error instanceof Error ? error.message : 'Request failed.', 0);

        // Network errors and timeouts (status 0) never retry.
        if (lastError.status === 0) {
          throw lastError;
        }

        if (attempt >= maxRetries || !this.#shouldRetryAttempt(lastError.status, attempt + 1)) {
          throw lastError;
        }

        if (this.#retryCtx.retryDelayMs > 0) {
          await delay(this.#retryCtx.retryDelayMs);
        }
      }
    }

    // Exhausted retries — surface the last error.
    throw lastError!;
  }

  async #attemptRequest<T>(
    internal: Omit<InternalRequest, 'baseUrl' | 'fetchFn' | 'timeoutMs'>,
    opts?: RequestOptions,
  ): Promise<T> {
    const url = `${this.#baseUrl}${internal.path}`;
    const headers: Record<string, string> = { ...internal.headers, ...opts?.headers };

    if (internal.body !== undefined) {
      headers['content-type'] = headers['content-type'] ?? 'application/json';
    }

    const init: RequestInit = {
      method: internal.method,
      headers,
    };

    if (internal.body !== undefined) {
      init.body = JSON.stringify(internal.body);
    }

    const requestTimeoutMs = opts?.timeoutMs ?? this.#timeoutMs;

    let response: Response;
    try {
      if (requestTimeoutMs > 0) {
        const controller = new AbortController();
        init.signal = controller.signal;
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
          response = await this.#fetchFn(url, init);
        } finally {
          clearTimeout(timer);
        }
      } else {
        response = await this.#fetchFn(url, init);
      }
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new HttpClientError('Request timed out.', 0);
      }
      throw new HttpClientError('Network request failed.', 0);
    }

    if (!response.ok) {
      throw new HttpClientError(
        `HTTP ${String(response.status)}: request failed.`,
        response.status,
      );
    }

    const text = await response.text();

    if (text.length === 0) {
      return undefined as unknown as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpClientError('Invalid JSON response.', response.status);
    }
  }

  #shouldRetryAttempt(status: number, attempt: number): boolean {
    if (this.#retryCtx.shouldRetry !== null) {
      return this.#retryCtx.shouldRetry(status, attempt);
    }
    return this.#retryCtx.retryStatuses.includes(status);
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

interface InternalRequest {
  method: string;
  path: string;
  body?: unknown;
  baseUrl: string;
  headers: Record<string, string>;
  fetchFn: typeof globalThis.fetch;
  timeoutMs: number;
}

interface RetryContext {
  maxRetries: number;
  retryStatuses: readonly number[];
  shouldRetry: ((status: number, attempt: number) => boolean) | null;
  retryDelayMs: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
