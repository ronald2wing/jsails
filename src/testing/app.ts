/**
 * In-process test application helper.
 *
 * `createTestApp(options?)` assembles a real {@link Application} over the same
 * Hono pipeline that `serve` uses, then exposes a small request surface so a
 * test can drive HTML pages, API routes, and public assets without ever
 * listening on a port or attaching broadcast. Every request is routed through
 * {@link Application.fetch}, which is in-process: no HTTP server is constructed,
 * no worker is spawned, and no external network is ever touched, regardless of
 * the request URL. Pages render through the built-in Preact renderer (or the
 * configured one), API routes go through the normal default-deny / session /
 * CSRF pipeline, and static files are served by the public-files middleware.
 *
 * The returned {@link TestApplication} exposes:
 *
 * - `fetch(request)` — route a native `Request` directly; the escape hatch for
 *   deliberately exercising a non-test origin in-process.
 * - `request(path, init?)` — build a `Request` pinned to the resolved `origin`
 *   and route it; returns the `Response` for any status, so negative-status
 *   assertions use it. A `path` that resolves to a different origin, carries
 *   credentials, or uses a non-`http(s)` scheme is rejected before any handler
 *   runs.
 * - `json(path, init?)` — `request` plus a 2xx check and JSON parse, rejecting
 *   with a {@link TestRequestError} that never embeds the response body, the
 *   underlying cause, or the URL.
 * - `close()` — idempotent teardown (delegates to {@link Application.close}).
 *
 * Config resolution mirrors the runtime: an explicit `config` object is passed
 * through {@link validateAppConfig}; otherwise {@link loadAppConfig} imports a
 * compiled config module (`configPath`, defaulting to `jsails.app.js`) resolved
 * against `cwd`. The two are mutually exclusive. The request origin is
 * `origin` (a validated `http(s)` override) when given, else the configured
 * `publicOrigin`, else the `TEST_ORIGIN` environment variable, else
 * `http://localhost`.
 *
 * There is no database sandbox. Loading a trusted app config module and running
 * its `setup`/extensions can open whatever connections the app config selects;
 * a test must point at an isolated config, fixture directories, and seeds it
 * owns. No provider state, external database, or mutable module global is
 * rolled back automatically. Services and the extension registry are freshly
 * created per call and torn down on `close`.
 */

import type { Application } from '../app/application.js';
import { createApplication } from '../app/application.js';
import {
  loadAppConfig,
  validateAppConfig,
  type JsailsAppConfig,
  type ResolvedAppConfig,
} from '../app/config.js';

/** Base origin used when neither `publicOrigin` nor `TEST_ORIGIN` is set. */
export const DEFAULT_TEST_ORIGIN = 'http://localhost';

/** Environment variable overriding the default test origin. */
export const TEST_ORIGIN_ENV = 'TEST_ORIGIN';

/**
 * Callback-registration surface compatible with `node:test`'s `TestContext`:
 * a `TestContext` is accepted directly as a `lifecycle`, and `after` runs the
 * registered callback once the test finishes.
 */
export interface TestingLifecycle {
  /** Register a callback to run after the current test completes. */
  after(callback: () => void | Promise<void>): void;
}

/** Options for {@link createTestApp}. */
export interface CreateTestAppOptions {
  /** Raw config object, validated by {@link validateAppConfig}. */
  readonly config?: JsailsAppConfig;
  /** Path to a compiled config module, loaded by {@link loadAppConfig}. */
  readonly configPath?: string;
  /** Working directory for relative config resolution; defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Hook surface (e.g. a `node:test` `t`) that auto-closes the app. */
  readonly lifecycle?: TestingLifecycle;
  /** Explicit request origin override; must be a valid `http(s)` origin. */
  readonly origin?: string;
}

/** A test application with an in-process request surface. */
export interface TestApplication {
  /** The underlying {@link Application}. */
  readonly application: Application;
  /** The resolved application config. */
  readonly config: ResolvedAppConfig;
  /** The origin requests are built against. */
  readonly origin: string;
  /** Route a native `Request` through the shared Hono pipeline. */
  fetch(request: Request): Promise<Response>;
  /**
   * Build a `Request` pinned to `origin` and route it; returns any status.
   * Rejects a path that resolves off-origin, carries credentials, or uses a
   * non-`http(s)` scheme before the handler runs.
   */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** `request` plus a 2xx check and JSON parse; rejects on bad status/body. */
  json<T = unknown>(path: string, init?: RequestInit): Promise<T>;
  /** Idempotently close the application. */
  close(): Promise<void>;
}

/**
 * Raised by {@link TestApplication.json} when the response is not 2xx or its
 * body is not valid JSON. The message never embeds the response body, the
 * underlying parse/rejection cause, or any part of the request URL (which may
 * carry secrets in its query string).
 */
export class TestRequestError extends Error {
  /** The HTTP status of the failed response. */
  readonly status: number;
  /** The operation that failed (`'json'`). */
  readonly operation: string;

  constructor(operation: string, status: number, message: string) {
    super(message);
    this.name = 'TestRequestError';
    this.operation = operation;
    this.status = status;
  }
}

/**
 * Assemble a test application from the given options. See the module docs for
 * the request surface and the config/origin resolution rules.
 */
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestApplication> {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createTestApp requires an options object');
  }
  if (options.config !== undefined && options.configPath !== undefined) {
    throw new TypeError('config and configPath are mutually exclusive');
  }
  if (options.configPath !== undefined && typeof options.configPath !== 'string') {
    throw new TypeError('configPath must be a string');
  }
  if (options.cwd !== undefined && typeof options.cwd !== 'string') {
    throw new TypeError('cwd must be a string');
  }

  const config =
    options.config !== undefined
      ? validateAppConfig(options.config, { cwd: options.cwd })
      : await loadAppConfig(options.configPath, { cwd: options.cwd });

  const origin = resolveTestOrigin(options.origin, config.publicOrigin);

  const application = await createApplication(config);

  const request = (path: string, init?: RequestInit): Promise<Response> =>
    application.fetch(buildTestRequest(origin, path, init));

  const json = async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
    const response = await request(path, init);
    if (response.status < 200 || response.status >= 300) {
      throw new TestRequestError(
        'json',
        response.status,
        `request did not succeed (status ${response.status})`,
      );
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new TestRequestError('json', response.status, 'response body is not valid JSON');
    }
  };

  const testApplication: TestApplication = {
    application,
    config,
    origin,
    fetch: (request: Request) => application.fetch(request),
    request,
    json,
    close: () => application.close(),
  };

  if (options.lifecycle !== undefined) {
    try {
      options.lifecycle.after(() => application.close());
    } catch (error) {
      // Registration failed: dispose the already-created application so it never
      // leaks resources, then propagate the registration error.
      let closeError: unknown;
      try {
        await application.close();
      } catch (cleanupError) {
        closeError = cleanupError;
      }
      if (closeError === undefined) throw error;
      throw new AggregateError([error, closeError], 'test application registration failed', {
        cause: error,
      });
    }
  }

  return testApplication;
}

/** Resolve the request origin: explicit override, then `publicOrigin`, then env. */
function resolveTestOrigin(override: string | undefined, publicOrigin: string | undefined): string {
  if (override !== undefined) {
    if (typeof override !== 'string') {
      throw new TypeError('origin must be a string');
    }
    return validateHttpOrigin(override);
  }
  if (publicOrigin !== undefined) return publicOrigin;
  return validateHttpOrigin(process.env[TEST_ORIGIN_ENV] ?? DEFAULT_TEST_ORIGIN);
}

/** Validate an `http(s)` origin (no credentials, path, query, or fragment). */
function validateHttpOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('test origin must be a valid http(s) origin');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('test origin must use the http or https scheme');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('test origin must not contain credentials');
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new TypeError('test origin must be an origin only (no path, query, or fragment)');
  }
  return url.origin;
}

/**
 * Build a native `Request` for `path`, resolved against `origin`.
 *
 * The resolved URL is pinned to `origin`: a `path` that resolves to a different
 * origin, carries credentials, or uses a scheme other than `http(s)` is
 * rejected before any handler runs. Error messages never embed the path, the
 * `init`, or the underlying cause (all may carry secrets). Use `fetch` to route
 * an arbitrary `Request` explicitly.
 */
function buildTestRequest(origin: string, path: string, init?: RequestInit): Request {
  let expectedOrigin: string;
  let url: URL;
  try {
    expectedOrigin = new URL(origin).origin;
    url = new URL(path, origin);
  } catch {
    throw new TypeError('request path must resolve to a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('request path must use the http or https scheme');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('request path must not contain credentials');
  }
  if (url.origin !== expectedOrigin) {
    throw new TypeError('request path must resolve to the configured test origin');
  }
  try {
    return new Request(url, init);
  } catch {
    throw new TypeError('request could not be constructed from the given path and init');
  }
}
