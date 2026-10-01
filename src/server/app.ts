/**
 * Hono-backed HTTP application builder.
 *
 * `createApp` turns a route {@link RouteManifest} into a Hono app without
 * opening a port or connecting to any external service: the returned `Hono`
 * instance is handed to {@link createHttpServer} (or any Fetch-compatible
 * host) by the caller, who also owns listening and shutdown.
 *
 * Route discovery is manifest-driven, never a central registry. Every `api`
 * entry is imported eagerly at setup and its named HTTP-method exports
 * (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD`) are treated as
 * handlers of the shape `(request, context) => Response`. There is no default
 * export guessing: a module with only a `default` export serves no methods,
 * and a method name exported as a non-function value is rejected at setup.
 *
 * HEAD is not registered as its own route: Hono rewrites HEAD dispatch to GET
 * before matching, so an `app.on('HEAD', ...)` route is unreachable. Instead
 * the GET route inspects the ORIGINAL request method (`c.req.raw.method`) and,
 * for a HEAD request, dispatches to the module's `HEAD` export, falling back to
 * `GET` when none exists. A module exposing only `HEAD` is still served (its
 * GET route answers a real GET with 405 and `Allow: HEAD`).
 *
 * Middleware pipeline ordering (each registered via `app.use` in this order):
 *
 *   1. request-id       — `X-Request-Id` on every response
 *   2. security-headers — the JSails default header set (see `security-headers.ts`)
 *   3. app-scope        — opens the ambient facade scope around the request
 *   4. body-limit       — caps request body size (skipped for component uploads)
 *   5. method-not-allowed — 405 for unrecognized methods
 *   6. compress         — response compression per Accept-Encoding
 *   7. etag             — ETag / 304 for GET/HEAD
 *   8. cache-control    — default-deny: `private, no-store` unless handler sets
 *   9. session          — resolves session via `resolveSession`; stores in `c.var.session`
 *
 * After the global middleware, infrastructure routes (health, introspect),
 * extension HTTP hooks, and server-component routes are registered. Then
 * filesystem API and page routes are registered with per-route middleware
 * chains: for API routes, CSRF + global-authorize + module-authorize +
 * global-middleware + per-route-middleware → handler; for pages,
 * global-middleware + per-route-middleware → handler.
 *
 * Security posture:
 * - API authorization is default-deny: with no `authorize` callback every API
 *   request is rejected. Authorization succeeds only when the callback resolves
 *   to exactly `true` — truthy non-boolean values, throws, and rejections all
 *   deny. A per-module `authorize` can only further restrict.
 * - `resolveSession` is the trusted application seam for reading the session
 *   cookie; when absent the context carries `session: null`.
 * - Cookie-authenticated mutations (`POST`/`PUT`/`PATCH`/`DELETE` with a
 *   non-null session) require a same-origin `Origin` header and a matching
 *   `X-CSRF-Token` header. This is enforced per-route for filesystem API routes
 *   through Hono middleware.
 * - Pages are public and the loader owns its authorization decision.
 * - Extension hooks are trusted application code; routes they install own their
 *   own authorization.
 * - Errors are reduced to a generic JSON envelope; `ValidationError` maps to
 *   400 with structured issues, `AuthError` to its status, and everything else
 *   to a bare 500. Raw payloads, stack traces, and file paths never leak.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';
import { etag } from 'hono/etag';
import { methodNotAllowed } from 'hono/method-not-allowed';
import { requestId } from 'hono/request-id';

import { ValidationError } from '../api/validation.js';
import { withAppScope } from '../facades/app-scope.js';
import { withLocale } from '../i18n/request-locale.js';
import { i18nToken, type I18nService } from '../i18n/plugin.js';
import type { HttpExtensionHook } from '../extensions/extension.js';
import type { ServiceRegistry } from '../extensions/services.js';
import type { RouteManifest } from '../routing/routes.js';
import type { AssetUrlResolver } from '../contracts/http.js';
import type { PageRenderer } from '../contracts/render.js';

import type { Authorize, RenderPage, ResolveSession } from '../contracts/http.js';
import type { SystemCheckRegistry } from '../database/system-checks.js';

import {
  assertNoIntrospectRouteCollision,
  registerIntrospectRoute,
  type IntrospectRouteConfig,
} from '../introspect/index.js';
import { DEFAULT_SECURITY_HEADERS } from './security-headers.js';
import { applyDefaultCacheControl } from './cache-control.js';
import { serverComponentsToken } from '../server-components/extension.js';
import {
  COMPONENT_DOWNLOAD_ENDPOINT,
  COMPONENT_UPDATE_ENDPOINT,
  COMPONENT_UPLOAD_ENDPOINT,
} from '../server-components/protocol.js';
import type { ServerComponentsRuntime } from '../server-components/runtime/index.js';
import { registerApiRoutes } from './api-routes.js';
import {
  createRequestContext,
  CSRF_HEADER,
  HTTP_METHODS,
  jsonError,
  methodNotAllowedResponse,
  resolveSessionOrNull,
  toErrorResponse,
  type ResolvedOptions,
} from './request-pipeline.js';
import { registerPageRoute, registerRendererPageRoute } from './page-routes.js';
import type { SeoRuntimeOptions } from '../seo/metadata.js';
import type { AppMiddlewareHandler, AppEnv } from './env.js';

export { CSRF_HEADER, HTTP_METHODS };

/** The typed Hono app used throughout the server assembly. */
type App = Hono<AppEnv>;

/** Default request-body cap when `maxBodyBytes` is omitted. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

/** Options for {@link createApp}. */
export interface AppOptions {
  /** The route manifest produced by `discoverRoutes`. */
  manifest: RouteManifest;
  /**
   * Global API authorization. Default-deny: omitted means every API request is
   * rejected. The request is allowed only when the callback resolves to exactly
   * `true`; any other value, a throw, or a rejection denies.
   */
  authorize?: Authorize;
  /** Resolve the session for each request. Omitted means `session: null`. */
  resolveSession?: ResolveSession;
  /** Render pages as a `Response`. Omitted means page routes are not served. */
  renderPage?: RenderPage;
  /**
   * Structured page renderer. Serves each page entry by rendering it to an HTML
   * string and wrapping it in a `text/html; charset=utf-8` response. Mutually
   * exclusive with `renderPage`; supplying both is rejected as ambiguous.
   */
  renderer?: PageRenderer;
  /**
   * Read-only services exposed to API and page `RequestContext`s. Omitted means
   * no registry is attached. The framework never starts or shares a global
   * registry; the caller owns the one it passes.
   */
  services?: ServiceRegistry;
  /**
   * Ordered HTTP extension hooks. Each is validated as a function and invoked
   * exactly once, awaited in order, during `createApp` — after the body-limit
   * middleware is installed and before the filesystem routes are registered.
   * Hooks receive the Hono app and are trusted application code; routes they
   * install own their own authorization.
   */
  httpHooks?: readonly HttpExtensionHook[];
  /** Request-body cap in bytes. Defaults to {@link DEFAULT_MAX_BODY_BYTES}. */
  maxBodyBytes?: number;
  /**
   * Public origin of the app, e.g. `"https://example.com"`, when it sits behind
   * a TLS-terminating proxy whose own request URL is plain HTTP. The CSRF
   * same-origin check compares the `Origin` header against this origin instead
   * of the request URL's origin. Validated as an `http(s)` ORIGIN only.
   */
  publicOrigin?: string;
  /**
   * Resolver for public asset URLs, attached to every request context so pages,
   * server components, and API handlers can emit cache-busted asset URLs.
   */
  assetUrl?: AssetUrlResolver;
  /**
   * Health endpoint path, registered as framework infrastructure ahead of every
   * extension hook and filesystem route.
   */
  healthPath?: string;
  /**
   * Absolute persistent-storage directory, attached to every request context as
   * `storagePath`.
   */
  storagePath?: string;
  /**
   * Resolved SEO runtime options, attached to every page request context as
   * `seo`.
   */
  seo?: SeoRuntimeOptions;
  /**
   * Resolved introspection config. Passed through from the application config
   * resolver: absent means the route is never registered.
   */
  introspect?: IntrospectRouteConfig;
  /**
   * Optional system-check registry for the deep health probe (`/up?deep=1`).
   * Absent keeps the health route a pure liveness probe.
   */
  systemChecks?: SystemCheckRegistry;
  /**
   * Resolved global middleware chain (concrete handlers — string refs already
   * resolved by the application layer), applied before per-route middleware.
   */
  globalMiddleware?: readonly AppMiddlewareHandler[];
  /**
   * Named middleware map (name → handler) for resolving string refs in route
   * `middleware` exports. Concrete handlers are resolved at registration time
   * by `registerApiRoutes` / `registerRendererPageRoute`.
   */
  middlewareMap?: Readonly<Record<string, AppMiddlewareHandler>>;
  /**
   * Locale-prefixed routing. When set, every page/API route is additionally
   * registered under `/{locale}/<route>` for each locale except `defaultLocale`,
   * and a leading locale segment sets the ambient request locale via the i18n
   * middleware.
   */
  localeOptions?: { readonly locales: readonly string[]; readonly defaultLocale?: string };
}

/**
 * Build a Hono app from a route manifest. Imports every API module eagerly,
 * rejecting malformed handler exports before the app is returned. Never opens
 * a port or a connection; the caller owns the server and its lifecycle.
 */
export async function createApp(options: AppOptions): Promise<App> {
  const opts = resolveOptions(options);

  const app = new Hono<AppEnv>();

  // 1. Request ID — early so every response carries an id for correlation.
  app.use('*', requestId());

  // 2. Security headers — the JSails default header set, applied after handlers
  //    run so an explicit header set by a route or extension is never
  //    overwritten (the guard checks `c.res.headers.has(name)` before setting).
  //    Deliberately NOT `hono/secure-headers`: that built-in's defaults (CSP
  //    `default-src 'self'`, `Referrer-Policy: no-referrer`, obsolete
  //    `X-XSS-Protection`) contradict the framework's documented 3-header policy
  //    (see `security-headers.ts`) — a blind CSP would break inline styles/scripts
  //    in the starter, and the same 3-header set feeds the static-hosting deploy
  //    generators. A developer wanting stricter headers mounts `hono/secure-headers`
  //    via `configureHttp`.
  app.use('*', async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
      if (!c.res.headers.has(name)) {
        c.res.headers.set(name, value);
      }
    }
  });

  // 3. Open the ambient application scope around every request so facades
  //    resolve for the whole pipeline. Registered before all other middleware
  //    so every later handler (health, introspect, extension hooks, filesystem
  //    routes, component updates) has access to facades.
  if (opts.services !== undefined) {
    const services = opts.services;
    app.use('*', (_c, next) => withAppScope(services, () => next()));
  }

  // 4. Body limit — cap request body size. Skipped for component-upload routes
  //    (multipart uploads are bounded by the store's streaming byte limit
  //    instead).
  const bodyLimitMiddleware = bodyLimit({
    maxSize: opts.maxBodyBytes,
    onError: () => jsonError(413, 'payload_too_large', 'Request body too large'),
  });
  app.use('*', async (c, next) => {
    if (c.req.method === 'POST' && c.req.path === COMPONENT_UPLOAD_ENDPOINT) {
      return next();
    }
    return bodyLimitMiddleware(c, next);
  });

  // 5. Method not allowed — 405 for unrecognized methods.
  app.use(
    '*',
    methodNotAllowed({
      app,
      onMethodNotAllowed: (_c, methods) => methodNotAllowedResponse(methods.join(', ')),
    }),
  );

  // 6. Response compresssion per Accept-Encoding.
  app.use('*', compress());

  // 7. ETag / 304 for GET/HEAD responses.
  app.use('*', etag());

  // 8. Default-deny cache-control: every framework-owned response is
  //    `Cache-Control: private, no-store` unless a route handler set an
  //    explicit header.
  app.use('*', async (c, next) => {
    await next();
    applyDefaultCacheControl(c.res.headers);
  });

  // 9. Session resolution — resolves the session and stores it in
  //    `c.var.session` for downstream middleware and handlers. Fail-closed
  //    to `null`.
  const resolveSession = opts.resolveSession;
  if (resolveSession !== undefined) {
    app.use('*', async (c, next) => {
      const request = c.req.raw;
      c.set('session', await resolveSessionOrNull(resolveSession, request));
      return next();
    });
  } else {
    // No resolver — session is always null.
    app.use('*', async (c, next) => {
      c.set('session', null);
      return next();
    });
  }

  // i18n: resolve the request locale and make it ambient for the rest of the
  // pipeline. When the i18n plugin is active, the resolved locale is stored on
  // `c.var.locale` and every async continuation inside the request sees it via
  // the ambient scope. When the plugin is absent this step is skipped entirely.
  if (opts.services !== undefined) {
    const i18n = resolveI18nService(opts.services);
    if (i18n !== undefined) {
      const configuredLocales = opts.localeOptions?.locales;
      const localeSet = configuredLocales === undefined ? undefined : new Set(configuredLocales);
      app.use('*', async (c, next) => {
        // Locale-prefixed routing: a leading `/{locale}` segment (when the
        // locale is configured) wins over Accept-Language/cookie resolution.
        const prefixed = localeSet === undefined ? undefined : prefixLocale(c.req.path, localeSet);
        const resolved =
          prefixed ??
          (await i18n.resolveRequestLocale(c.req.raw, {
            url: new URL(c.req.url),
            params: { ...c.req.param() },
          }));
        c.set('locale', resolved);
        return withLocale(resolved, () => next());
      });
    }
  }

  // 10. Static per-app request-context values — services, publicOrigin,
  //     assetUrl, storagePath, seo. These do not vary per request; storing them
  //     in `c.var` gives the terminal adapter (createRequestContextFromStore)
  //     a single honest source for everything the sovereign RequestContext
  //     needs, alongside the per-request `session` set above.
  app.use('*', async (c, next) => {
    c.set('services', opts.services);
    c.set('publicOrigin', opts.publicOrigin);
    c.set('assetUrl', opts.assetUrl);
    c.set('storagePath', opts.storagePath);
    c.set('seo', opts.seo);
    return next();
  });

  // Infrastructure routes: health and introspection, registered before any
  // extension hook or filesystem route so none can shadow them.
  if (opts.healthPath !== undefined) {
    registerHealthRoute(app, opts.healthPath, opts.systemChecks);
  }

  if (opts.introspect !== undefined) {
    assertNoIntrospectRouteCollision(opts.manifest);
    registerIntrospectRoute(app, opts, opts.introspect);
  }

  // Extension hooks run once, in order, after the global middleware and before
  // the filesystem routes. They receive the maintained Hono app directly, so
  // hook routes and middleware reuse Hono. Hook routes are trusted application
  // code: they own their own authorization and are not covered by the
  // default-deny API pipeline below.
  for (const hook of opts.httpHooks) {
    await hook(app);
  }

  // Server-components transport: mounted after extension hooks, before
  // filesystem routes. The runtime owns every origin/CSRF/signature/policy
  // check — no global CSRF or authorize middleware applies here.
  const componentRuntime =
    opts.services === undefined ? undefined : tryGetServerComponents(opts.services);
  if (componentRuntime !== undefined) {
    assertNoComponentRouteCollision(opts.manifest);
    registerComponentUpdateRoute(app, opts, componentRuntime);
    registerComponentUploadRoute(app, opts, componentRuntime);
    registerComponentDownloadRoute(app, opts, componentRuntime);
  }

  // Filesystem routes: API and pages, each with per-route middleware chains.
  // API routes get: CSRF → global-authorize → module-authorize → global-mw →
  // per-route-mw → handler.  Page routes get: global-mw → per-route-mw →
  // handler.  String refs in module `middleware` exports are resolved at
  // registration time via `opts.middlewareMap`.
  for (const entry of opts.manifest.entries) {
    if (entry.kind === 'api') {
      await registerApiRoutes(app, entry, opts, opts.middlewareMap);
    } else if (opts.renderer !== undefined) {
      await registerRendererPageRoute(
        app,
        entry,
        opts.renderer,
        opts.resolveSession,
        opts.services,
        opts.publicOrigin,
        opts.assetUrl,
        opts.storagePath,
        opts.seo,
        opts.globalMiddleware,
        opts.middlewareMap,
        opts.localeOptions,
      );
    } else if (opts.renderPage !== undefined) {
      registerPageRoute(
        app,
        entry,
        opts.renderPage,
        opts.resolveSession,
        opts.services,
        opts.publicOrigin,
        opts.assetUrl,
        opts.storagePath,
        opts.seo,
        opts.globalMiddleware,
        opts.localeOptions,
      );
    }
  }

  app.notFound(() => jsonError(404, 'not_found', 'Not Found'));
  app.onError((error) => toErrorResponse(error));

  return app;
}

/** Register the health endpoint as framework infrastructure (GET and HEAD). */
/** Register the health endpoint. `GET/HEAD <path>` is a fast liveness probe;
 *  `?deep=1` runs the app's optional {@link SystemCheckRegistry} and reports
 *  per-check results (503 when any check is `error`-severity). */
function registerHealthRoute(
  app: App,
  healthPath: string,
  systemChecks?: SystemCheckRegistry,
): void {
  app.on(['GET', 'HEAD'], healthPath, (c) => {
    if (c.req.query('deep') !== '1' || systemChecks === undefined) {
      return healthResponse();
    }
    return deepHealthResponse(systemChecks);
  });
}

/** The static health response: plain-text `OK`, never cached. */
function healthResponse(): Response {
  return new Response('OK', {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/** Run the system checks and report them as JSON; 503 when any `error` check fails. */
function deepHealthResponse(systemChecks: SystemCheckRegistry): Response {
  const checks = systemChecks.run();
  const failed = checks.some((check) => check.severity === 'error');
  const body = JSON.stringify({
    status: failed ? 'error' : 'ok',
    checks: checks.map((check) => ({
      id: check.id,
      severity: check.severity,
      message: check.message,
    })),
  });
  return new Response(body, {
    status: failed ? 503 : 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/** Extract the leading `/{locale}` segment of a path when it is a configured
 *  locale, otherwise `undefined`. Prefix routing reads the first path segment. */
function prefixLocale(path: string, locales: ReadonlySet<string>): string | undefined {
  const second = path.indexOf('/', 1);
  const firstSegment = second === -1 ? path.slice(1) : path.slice(1, second);
  if (firstSegment.length === 0) return undefined;
  return locales.has(firstSegment) ? firstSegment : undefined;
}

/** Resolve the registered server-components runtime, if one was provided. */
function tryGetServerComponents(services: ServiceRegistry): ServerComponentsRuntime | undefined {
  try {
    return services.tryGet(serverComponentsToken);
  } catch {
    return undefined;
  }
}

/** Resolve the registered i18n service, if one was provided. Structural
 *  guard: a `tryGet` that returns a non-service value (e.g. a test fake that
 *  echoes a constant) is rejected, so the i18n middleware never treats a
 *  non-`I18nService` as one. */
function resolveI18nService(services: ServiceRegistry | undefined): I18nService | undefined {
  if (services === undefined) return undefined;
  let maybe: unknown;
  try {
    maybe = services.tryGet(i18nToken);
  } catch {
    return undefined;
  }
  if (maybe === undefined || maybe === null || typeof maybe !== 'object') {
    return undefined;
  }
  const candidate = maybe as { resolveRequestLocale?: unknown };
  if (typeof candidate.resolveRequestLocale !== 'function') {
    return undefined;
  }
  return maybe as I18nService;
}

/** Reject a filesystem route that would shadow the server-components endpoint. */
function assertNoComponentRouteCollision(manifest: RouteManifest): void {
  for (const entry of manifest.entries) {
    if (
      entry.route === COMPONENT_UPDATE_ENDPOINT ||
      entry.route === COMPONENT_UPLOAD_ENDPOINT ||
      entry.route === COMPONENT_DOWNLOAD_ENDPOINT
    ) {
      throw new Error(
        `route "${entry.route}" collides with the reserved server-components endpoint`,
      );
    }
  }
}

/**
 * Register the internal component-update POST route. The route is registered
 * after the body-limit/405 middleware and outside the extension-hook and
 * filesystem pipelines, so the runtime owns every origin/CSRF/signature/policy
 * decision.
 */
function registerComponentUpdateRoute(
  app: App,
  opts: ResolvedOptions,
  runtime: ServerComponentsRuntime,
): void {
  app.on('POST', COMPONENT_UPDATE_ENDPOINT, async (c) => {
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const session = c.var.session ?? (await resolveSessionOrNull(opts.resolveSession, request));
    const context = createRequestContext({
      request,
      url,
      params: {},
      session,
      publicOrigin: opts.publicOrigin,
      services: opts.services,
      assetUrl: opts.assetUrl,
      storagePath: opts.storagePath,
    });

    let payload: unknown;
    try {
      payload = await readJson(request);
    } catch (error) {
      return noStore(toErrorResponse(error));
    }

    try {
      const result = await runtime.update(payload, context, {
        origin: opts.publicOrigin ?? url.origin,
      });
      return noStore(
        new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      );
    } catch {
      return noStore(jsonError(500, 'internal_error', 'Internal Server Error'));
    }
  });
}

/**
 * Register the internal component-upload POST route. Like the update route, the
 * runtime owns every security decision.
 */
function registerComponentUploadRoute(
  app: App,
  opts: ResolvedOptions,
  runtime: ServerComponentsRuntime,
): void {
  app.on('POST', COMPONENT_UPLOAD_ENDPOINT, async (c) => {
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const session = c.var.session ?? (await resolveSessionOrNull(opts.resolveSession, request));
    const context = createRequestContext({
      request,
      url,
      params: {},
      session,
      publicOrigin: opts.publicOrigin,
      services: opts.services,
      assetUrl: opts.assetUrl,
      storagePath: opts.storagePath,
    });

    try {
      const result = await runtime.handleUpload(request, context, {
        origin: opts.publicOrigin ?? url.origin,
      });
      return noStore(
        new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      );
    } catch {
      return noStore(jsonError(500, 'internal_error', 'Internal Server Error'));
    }
  });
}

/**
 * Register the internal component-download GET route. Like the upload route, the
 * runtime owns every security decision.
 */
function registerComponentDownloadRoute(
  app: App,
  opts: ResolvedOptions,
  runtime: ServerComponentsRuntime,
): void {
  app.on('GET', COMPONENT_DOWNLOAD_ENDPOINT, async (c) => {
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const session = c.var.session ?? (await resolveSessionOrNull(opts.resolveSession, request));
    const context = createRequestContext({
      request,
      url,
      params: {},
      session,
      publicOrigin: opts.publicOrigin,
      services: opts.services,
      assetUrl: opts.assetUrl,
      storagePath: opts.storagePath,
    });

    try {
      const result = await runtime.handleDownload(request, context, {
        origin: opts.publicOrigin ?? url.origin,
      });

      if (
        result.status === 200 &&
        result.stream !== undefined &&
        result.contentType !== undefined
      ) {
        return new Response(result.stream as never, {
          status: 200,
          headers: {
            'content-type': result.contentType,
            'content-disposition': `attachment; filename="${result.filename ?? 'download'}"`,
            'cache-control': 'no-store',
          },
        });
      }

      return noStore(
        new Response(JSON.stringify(result.body ?? {}), {
          status: result.status,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      );
    } catch {
      return noStore(jsonError(500, 'internal_error', 'Internal Server Error'));
    }
  });
}

/** Attach a `Cache-Control: no-store` header to an existing response. */
function noStore(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    headers: {
      ...Object.fromEntries(response.headers.entries()),
      'cache-control': 'no-store',
    },
  });
}

function resolveOptions(options: AppOptions): ResolvedOptions {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createApp requires an options object');
  }
  const { manifest } = options;
  if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.entries)) {
    throw new TypeError('createApp requires a manifest with an entries array');
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (typeof maxBodyBytes !== 'number' || !Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new TypeError('maxBodyBytes must be a positive integer');
  }
  if (options.renderer !== undefined && options.renderPage !== undefined) {
    throw new TypeError('renderer and renderPage are mutually exclusive');
  }
  if (
    options.healthPath !== undefined &&
    (typeof options.healthPath !== 'string' || options.healthPath === '')
  ) {
    throw new TypeError('healthPath must be a non-empty string');
  }
  if (options.storagePath !== undefined && typeof options.storagePath !== 'string') {
    throw new TypeError('storagePath must be a string');
  }
  for (const [name, value] of [
    ['authorize', options.authorize],
    ['resolveSession', options.resolveSession],
    ['renderPage', options.renderPage],
    ['assetUrl', options.assetUrl],
  ] as const) {
    if (value !== undefined && typeof value !== 'function') {
      throw new TypeError(`${name} must be a function`);
    }
  }
  if (options.globalMiddleware !== undefined && !Array.isArray(options.globalMiddleware)) {
    throw new TypeError('globalMiddleware must be an array of middleware handlers');
  }

  return {
    manifest,
    authorize: options.authorize,
    resolveSession: options.resolveSession,
    renderPage: options.renderPage,
    renderer: resolveRenderer(options.renderer),
    services: resolveServices(options.services),
    httpHooks: resolveHttpHooks(options.httpHooks),
    maxBodyBytes,
    publicOrigin: resolvePublicOrigin(options.publicOrigin),
    assetUrl: options.assetUrl,
    healthPath: options.healthPath,
    storagePath: options.storagePath,
    seo: options.seo,
    introspect: options.introspect,
    ...(options.systemChecks !== undefined ? { systemChecks: options.systemChecks } : {}),
    globalMiddleware: options.globalMiddleware ?? [],
    middlewareMap: options.middlewareMap ?? {},
    ...(options.localeOptions !== undefined ? { localeOptions: options.localeOptions } : {}),
  };
}

/** Validate an optional structured renderer exposing a `render` function. */
function resolveRenderer(value: unknown): PageRenderer | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    throw new TypeError('renderer must be an object implementing render(entry, context, options)');
  }
  if (typeof (value as { render?: unknown }).render !== 'function') {
    throw new TypeError('renderer must implement render(entry, context, options)');
  }
  return value as PageRenderer;
}

/** Validate an optional read-only service registry by its read methods. */
function resolveServices(value: unknown): ServiceRegistry | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    throw new TypeError('services must be a service registry');
  }
  const registry = value as Record<string, unknown>;
  for (const method of ['has', 'tryGet', 'get'] as const) {
    if (typeof registry[method] !== 'function') {
      throw new TypeError('services must expose has, tryGet, and get');
    }
  }
  return value as ServiceRegistry;
}

/** Validate optional HTTP hooks; every entry must be a function. */
function resolveHttpHooks(value: unknown): readonly HttpExtensionHook[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError('httpHooks must be an array of functions');
  }
  for (const hook of value) {
    if (typeof hook !== 'function') {
      throw new TypeError('httpHooks entries must be functions');
    }
  }
  return value as readonly HttpExtensionHook[];
}

/**
 * Validate and canonicalize the optional `publicOrigin`: an `http(s)` ORIGIN
 * only. Rejects credentials, any path beyond `/`, and query/fragment. Returns
 * the canonical origin (lowercased host, no trailing slash) for comparison.
 */
function resolvePublicOrigin(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new TypeError('publicOrigin must be an http(s) origin string');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('publicOrigin must be a valid http(s) origin URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('publicOrigin must use the http or https scheme');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('publicOrigin must not contain credentials');
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new TypeError('publicOrigin must be an origin only (no path, query, or fragment)');
  }
  return url.origin;
}

/**
 * Read and parse a JSON request body, throwing {@link ValidationError} (which
 * maps to a 400) on an unreadable, empty, or malformed body. Handlers should
 * pass the result to their own schema for field validation.
 */
export async function readJson(request: Request): Promise<unknown> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new ValidationError([
      { path: [], code: 'invalid_json', message: 'Request body could not be read' },
    ]);
  }
  if (text.trim() === '') {
    throw new ValidationError([
      { path: [], code: 'invalid_json', message: 'Request body is empty' },
    ]);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError([
      { path: [], code: 'invalid_json', message: 'Request body is not valid JSON' },
    ]);
  }
}
