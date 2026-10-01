/**
 * Diagnostics exporter: an export-only, neutral seam for draining
 * {@link DiagnosticsEntry}s out of the in-memory recorder to an external
 * destination.
 *
 * The contract is deliberately narrow — a single `send` method that receives
 * a batch of read-only entries and resolves when the batch has been delivered
 * (or swallowed on failure). Every built-in exporter is value-free: a failing
 * exporter never throws back into recording.
 *
 * - {@link consoleExporter} writes one JSON line per entry to stdout.
 *   Mirrors the logging layer's {@link consoleChannel}.
 * - {@link HttpExporter} POSTs a JSON batch `{ entries }` to any HTTP/OTLP-
 *   compatible collector using an injectable `fetch`.
 * - {@link exportOnce} drains the recorder to an exporter once. There is no
 *   built-in timer or interval — the caller owns scheduling.
 */

import { type DiagnosticsEntry, type DiagnosticsRecorder } from './recorder.js';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * A diagnostics exporter accepts a batch of read-only entries and delivers
 * them to an external destination. Implementations must never throw back into
 * the caller — a delivery failure is an implementation concern that stays
 * internal (e.g. logged, reported via a callback, or silently swallowed).
 */
export interface DiagnosticsExporter {
  send(entries: readonly DiagnosticsEntry[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Discriminated codes for errors raised by the diagnostics exporter module. */
export type DiagnosticsExporterErrorCode = 'invalid_endpoint' | 'invalid_options';

/**
 * A value-free error raised by the diagnostics exporter module. The message
 * explains the condition that failed but never echoes a caller-supplied value
 * (endpoint URL, entry data, response body).
 */
export class DiagnosticsExporterError extends Error {
  readonly code: DiagnosticsExporterErrorCode;

  constructor(code: DiagnosticsExporterErrorCode, message: string) {
    super(message);
    this.name = 'DiagnosticsExporterError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// consoleExporter
// ---------------------------------------------------------------------------

/** Options for {@link consoleExporter}. */
export interface ConsoleExporterOptions {
  /**
   * Writer for each serialized line (one JSON entry + `\n`). Defaults to
   * `process.stdout.write` resolved lazily at `send()` time so importing this
   * module is safe in non-Node environments.
   */
  readonly write?: ((line: string) => void) | undefined;
}

/**
 * Returns an exporter that writes one JSON line per entry to stdout. Each
 * line is a complete JSON value (the entry serialized with `JSON.stringify`)
 * followed by a newline, so a collector can read it as newline-delimited JSON
 * (NDJSON).
 *
 * The writer is resolved lazily inside `send()` — importing this module never
 * touches `process.stdout`.
 */
export function consoleExporter(options?: ConsoleExporterOptions): DiagnosticsExporter {
  const writer = options?.write;

  if (writer !== undefined && typeof writer !== 'function') {
    throw new DiagnosticsExporterError(
      'invalid_options',
      'consoleExporter write must be a function.',
    );
  }

  return {
    async send(entries: readonly DiagnosticsEntry[]): Promise<void> {
      const writeLine =
        writer ??
        ((line: string) => {
          process.stdout.write(line);
        });

      for (const entry of entries) {
        // JSON.stringify never throws on a DiagnosticsEntry — all fields are
        // JSON-serialisable primitives (string, number, boolean, null, or
        // nested records/arrays of the same).
        const line = JSON.stringify(entry) + '\n';
        writeLine(line);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// HttpExporter
// ---------------------------------------------------------------------------

/** Options for {@link HttpExporter}. */
export interface HttpExporterOptions {
  /**
   * The collector endpoint URL. Must be a non-empty absolute http(s) URL.
   * The exporter POSTs a JSON body `{ entries: [...] }` to this endpoint.
   */
  readonly endpoint: string;

  /**
   * Injectable `fetch` function. Defaults to `globalThis.fetch`. Pass a stub
   * in tests to avoid network calls.
   */
  readonly fetch?: typeof globalThis.fetch | undefined;

  /**
   * Optional callback invoked when `send` fails (network error, non-2xx
   * response, or invalid JSON). The error is swallowed after the callback
   * runs — the exporter never throws back into the caller.
   *
   * The error carries only a fixed message; the endpoint URL, entry data,
   * and response body are never echoed.
   */
  readonly onError?: ((error: Error) => void) | undefined;

  /**
   * Request timeout in milliseconds. Defaults to `30_000` (30 seconds).
   * Set to `0` to disable the timeout.
   */
  readonly timeoutMs?: number | undefined;

  /**
   * Extra headers included with every POST. Defaults to
   * `{ 'content-type': 'application/json' }`.
   */
  readonly headers?: Record<string, string> | undefined;
}

/** Default request timeout. */
const DEFAULT_HTTP_EXPORTER_TIMEOUT_MS = 30_000;

/** Validate that the endpoint is a non-empty absolute http(s) URL. */
function validateHttpEndpoint(endpoint: unknown): asserts endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new DiagnosticsExporterError(
      'invalid_endpoint',
      'HttpExporter endpoint must be a non-empty string.',
    );
  }
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new DiagnosticsExporterError(
        'invalid_endpoint',
        'HttpExporter endpoint must use http or https.',
      );
    }
  } catch {
    throw new DiagnosticsExporterError(
      'invalid_endpoint',
      'HttpExporter endpoint must be a valid absolute URL.',
    );
  }
}

/**
 * An exporter that POSTs a JSON batch `{ entries }` to an HTTP collector
 * endpoint. The exporter is value-free on failure: network errors, non-2xx
 * responses, and JSON parse failures are all swallowed (after an optional
 * `onError` callback fires).
 *
 * ```ts
 * const exporter = new HttpExporter({
 *   endpoint: 'https://collector.example.com/v1/traces',
 *   onError: (err) => console.error('exporter error:', err.message),
 * });
 * await exportOnce(recorder, exporter);
 * ```
 */
export class HttpExporter implements DiagnosticsExporter {
  readonly #endpoint: string;
  readonly #fetchFn: typeof globalThis.fetch;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #timeoutMs: number;
  readonly #headers: Record<string, string>;

  constructor(options: HttpExporterOptions) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new DiagnosticsExporterError(
        'invalid_options',
        'HttpExporter options must be an object.',
      );
    }

    validateHttpEndpoint(options.endpoint);

    const fetchFn = options.fetch;
    if (fetchFn !== undefined && typeof fetchFn !== 'function') {
      throw new DiagnosticsExporterError(
        'invalid_options',
        'HttpExporter fetch must be a function.',
      );
    }

    const onError = options.onError;
    if (onError !== undefined && typeof onError !== 'function') {
      throw new DiagnosticsExporterError(
        'invalid_options',
        'HttpExporter onError must be a function.',
      );
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_EXPORTER_TIMEOUT_MS;
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new DiagnosticsExporterError(
        'invalid_options',
        'HttpExporter timeoutMs must be a non-negative finite number.',
      );
    }

    this.#endpoint = options.endpoint;
    this.#fetchFn = fetchFn ?? globalThis.fetch;
    this.#onError = onError;
    this.#timeoutMs = timeoutMs;
    this.#headers = options.headers ?? { 'content-type': 'application/json' };
  }

  async send(entries: readonly DiagnosticsEntry[]): Promise<void> {
    // Empty batch is a no-op — don't POST an empty array to a collector.
    if (entries.length === 0) return;

    try {
      const body = JSON.stringify({ entries });
      const init: RequestInit = {
        method: 'POST',
        headers: this.#headers,
        body,
      };

      let response: Response;
      if (this.#timeoutMs > 0) {
        const controller = new AbortController();
        init.signal = controller.signal;
        const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
        try {
          response = await this.#fetchFn(this.#endpoint, init);
        } finally {
          clearTimeout(timer);
        }
      } else {
        response = await this.#fetchFn(this.#endpoint, init);
      }

      if (!response.ok) {
        this.#reportError(new Error(`HTTP ${String(response.status)}: export request failed.`));
      }
    } catch (error: unknown) {
      const message =
        error instanceof DOMException && error.name === 'AbortError'
          ? 'Export request timed out.'
          : 'Export request failed.';
      this.#reportError(new Error(message));
    }
  }

  #reportError(error: Error): void {
    if (this.#onError !== undefined) {
      try {
        this.#onError(error);
      } catch {
        // onError callback threw — swallow so the exporter never propagates.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// exportOnce
// ---------------------------------------------------------------------------

/**
 * Drains every entry currently held in `recorder` to `exporter` exactly once.
 * The exporter's `send()` is called even when the recorder is empty (an empty
 * batch is a no-op in every built-in exporter).
 *
 * This is the only scheduling primitive — the module ships no timer or
 * interval. The caller owns the drain cadence (e.g. `setInterval`,
 * `process.on('beforeExit')`, or a request hook).
 *
 * Errors from the exporter are handled by the exporter itself and never
 * propagate from this function.
 *
 * ```ts
 * await exportOnce(recorder, exporter);
 * ```
 */
export async function exportOnce(
  recorder: DiagnosticsRecorder,
  exporter: DiagnosticsExporter,
): Promise<void> {
  const entries = recorder.entries();
  await exporter.send(entries);
}
