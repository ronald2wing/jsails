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
 * Security posture:
 * - API authorization is default-deny: with no `authorize` callback every API
 *   request is rejected. Authorization succeeds only when the callback resolves
 *   to exactly `true` — truthy non-boolean values, throws, and rejections all
 *   deny. A per-module `authorize` can only further restrict — it never
 *   bypasses the global default.
 * - `resolveSession` is the trusted application seam for reading the session
 *   cookie; when absent the context carries `session: null`. A throwing or
 *   rejecting resolver fails closed to `null`.
 * - Cookie-authenticated mutations (`POST`/`PUT`/`PATCH`/`DELETE` with a
 *   non-null session) require a same-origin `Origin` header and a matching
 *   `X-CSRF-Token` header (verified against `session.csrfToken` via the node
 *   session primitive `assertCsrfToken`). Invalid requests are denied before
 *   the handler runs. Behind a TLS-terminating proxy the request URL is the
 *   proxy's plain HTTP address, so set `publicOrigin` to the public HTTPS
 *   origin and the `Origin` check compares against that instead of the request
 *   URL. Forwarded headers (`x-forwarded-*`) are never trusted for this check.
 * - Pages are served only through the injected `renderPage` callback or the
 *   structured `renderer`. Page rendering is public and the loader owns its
 *   authorization decision. For the structured renderer, the page module is
 *   imported lazily so an optional `middleware` export runs before rendering;
 *   a middleware handler may short-circuit with a `Response` (used as-is). The
 *   `renderPage` callback remains module-free. A renderer returns an HTML
 *   string that is wrapped in a `text/html; charset=utf-8` response; a
 *   non-string result is a contract violation and is reduced to the generic
 *   500 envelope.
 * - A compiled route module (API or page) may export `middleware`, an array of
 *   handlers `(context, next) => Response | Promise<Response>` run in declared
 *   order. For API routes they run after the default-deny/CSRF gates and before
 *   the method handler; a returned `Response` short-circuits the chain. The
 *   export is validated structurally at setup (API) or module load (page), and
 *   `next()` is callable at most once per handler.
 * - HTTP extension hooks run once, in declaration order, during `createApp`
 *   after the body-limit/405 middleware and before the filesystem routes. They
 *   receive the maintained Hono app directly, so hook routes and middleware
 *   reuse Hono. Hooks are trusted application code: routes a hook installs own
 *   their own authorization and are not covered by the default-deny API
 *   pipeline, which applies only to filesystem API routes.
 * - Errors are reduced to a generic JSON envelope; `ValidationError` maps to
 *   400 with structured issues, `AuthError` to its status, and everything else
 *   to a bare 500. Raw payloads, stack traces, and file paths never leak.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { methodNotAllowed } from 'hono/method-not-allowed';

import { ValidationError } from '../api/validation.js';
import type { HttpExtensionHook } from '../extensions/extension.js';
import type { ServiceRegistry } from '../extensions/services.js';
import type { MiddlewareRegistry, RouteMiddleware } from '../routing/middleware.js';
import type { RouteManifest } from '../routing/routes.js';
import type { AssetUrlResolver } from '../contracts/http.js';
import type { PageRenderer } from '../contracts/render.js';

import type { Authorize, ResolveSession, RenderPage } from '../contracts/http.js';

import {
  assertNoIntrospectRouteCollision,
  registerIntrospectRoute,
  type IntrospectRouteConfig,
} from '../introspect/index.js';
import { serverComponentsToken } from '../server-components/extension.js';
import {
  COMPONENT_DOWNLOAD_ENDPOINT,
  COMPONENT_UPDATE_ENDPOINT,
  COMPONENT_UPLOAD_ENDPOINT,
} from '../server-components/protocol.js';
import type { ServerComponentsRuntime } from '../server-components/runtime.js';
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

export { CSRF_HEADER, HTTP_METHODS };

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
   * of the request URL's origin. Validated as an `http(s)` ORIGIN only (no
   * path, credentials, query, or fragment). The per-request `context.url`
   * remains the actual request URL; `publicOrigin` only moves the CSRF boundary.
   */
  publicOrigin?: string;
  /**
   * Resolver for public asset URLs, attached to every request context so pages,
   * server components, and API handlers can emit cache-busted asset URLs.
   * Omitted means the context field stays absent and callers use unversioned
   * paths. The resolver is trusted to never throw for an unresolved path.
   */
  assetUrl?: AssetUrlResolver;
  /**
   * Health endpoint path, registered as framework infrastructure ahead of every
   * extension hook and filesystem route. Omitted disables the endpoint. The
   * path is assumed already validated by the application config; only a light
   * non-empty-string check runs here.
   */
  healthPath?: string;
  /**
   * Absolute persistent-storage directory, attached to every request context as
   * `storagePath`. Omitted means the field stays absent. The directory is the
   * caller's to create; `createApp` never touches the filesystem.
   */
  storagePath?: string;
  /**
   * Resolved introspection config. Passed through from the application config
   * resolver: absent means the route is never registered.
   */
  introspect?: IntrospectRouteConfig;
  /**
   * Resolved global middleware chain, applied to every API request after the
   * authorize gates and before per-route middleware. Defaults to an empty array
   * (no global middleware runs). Built by the application layer from the config
   * `globalMiddleware` refs (resolved against the named registry) followed by
   * extension `configureMiddleware` handlers in setup order.
   */
  globalMiddleware?: readonly RouteMiddleware[];
  /**
   * Named middleware registry for resolving string refs in route `middleware`
   * exports. Defaults to an empty registry with no named handlers.
   */
  middlewareRegistry?: MiddlewareRegistry;
}

/**
 * Build a Hono app from a route manifest. Imports every API module eagerly,
 * rejecting malformed handler exports before the app is returned. Never opens
 * a port or a connection; the caller owns the server and its lifecycle.
 */
export async function createApp(options: AppOptions): Promise<Hono> {
  const opts = resolveOptions(options);

  const app = new Hono();

  // Middleware must be registered before routes: Hono prepends `*` middleware
  // to later-added route handlers, so this ordering guarantees the body cap and
  // the 405 transformer run ahead of every handler.
  //
  // The component-upload route carries a multipart body that legitimately
  // exceeds the JSON/API body cap (uploads are bounded by the store's streaming
  // byte limit instead), so the body limiter is skipped for that one endpoint.
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

  app.use(
    '*',
    methodNotAllowed({
      app,
      onMethodNotAllowed: (_c, methods) => methodNotAllowedResponse(methods.join(', ')),
    }),
  );

  // The health endpoint is framework infrastructure, registered before any
  // extension hook or filesystem route so none can shadow it. Hono rewrites
  // HEAD dispatch to GET before matching, so a single GET route answers both
  // methods (the static body is dropped automatically for HEAD).
  if (opts.healthPath !== undefined) {
    registerHealthRoute(app, opts.healthPath);
  }

  // The introspection endpoint is framework infrastructure, registered after the
  // body-limit/405 middleware and before any extension hook or filesystem route
  // so none can shadow it. It is independent of the default-deny API pipeline:
  // the route owns its own authorization boundary.
  if (opts.introspect !== undefined) {
    assertNoIntrospectRouteCollision(opts.manifest);
    registerIntrospectRoute(app, opts, opts.introspect);
  }

  // Extension hooks run once, in order, after the body-limit/405 middleware and
  // before the filesystem routes. They receive the maintained Hono app directly
  // so hook routes and middleware reuse Hono rather than a bespoke router. Hook
  // routes are trusted application code: they own their own authorization and
  // are not covered by the default-deny API pipeline below, which wraps only
  // filesystem API routes.
  for (const hook of opts.httpHooks) {
    await hook(app);
  }

  // The server-components transport mounts its own internal POST routes when a
  // runtime was registered by an extension. They are registered here (after the
  // body-limit/405 middleware, outside the extension-hook and filesystem
  // pipelines) so the runtime owns every origin/CSRF/signature/policy check.
  const componentRuntime =
    opts.services === undefined ? undefined : tryGetServerComponents(opts.services);
  if (componentRuntime !== undefined) {
    assertNoComponentRouteCollision(opts.manifest);
    registerComponentUpdateRoute(app, opts, componentRuntime);
    registerComponentUploadRoute(app, opts, componentRuntime);
    registerComponentDownloadRoute(app, opts, componentRuntime);
  }

  for (const entry of opts.manifest.entries) {
    if (entry.kind === 'api') {
      await registerApiRoutes(app, entry, opts);
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
        opts.globalMiddleware,
        opts.middlewareRegistry,
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
        opts.globalMiddleware,
      );
    }
  }

  app.notFound(() => jsonError(404, 'not_found', 'Not Found'));
  app.onError((error) => toErrorResponse(error));

  return app;
}

/** Register the health endpoint as framework infrastructure (GET and HEAD). */
function registerHealthRoute(app: Hono, healthPath: string): void {
  app.on('GET', healthPath, () => healthResponse());
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

/** Resolve the registered server-components runtime, if one was provided. */
function tryGetServerComponents(services: ServiceRegistry): ServerComponentsRuntime | undefined {
  try {
    return services.tryGet(serverComponentsToken);
  } catch {
    return undefined;
  }
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
 * filesystem pipelines, so the runtime — not the HTTP layer — owns every
 * origin/CSRF/signature/policy decision. Only the bounded JSON body is read
 * here; the session is resolved through the real `resolveSession` (failing
 * closed to `null`) and passed to the runtime, which enforces the boundary.
 */
function registerComponentUpdateRoute(
  app: Hono,
  opts: ResolvedOptions,
  runtime: ServerComponentsRuntime,
): void {
  app.on('POST', COMPONENT_UPDATE_ENDPOINT, async (c) => {
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const session = await resolveSessionOrNull(opts.resolveSession, request);
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
 * Register the internal component-upload POST route. Like the update route it is
 * registered outside the extension-hook and filesystem pipelines, so the runtime
 * owns every origin/CSRF/signature/policy decision. The raw multipart body is
 * passed through unread — the runtime's `handleUpload` parses it (and enforces
 * the upload byte cap), so this layer never buffers the file.
 */
function registerComponentUploadRoute(
  app: Hono,
  opts: ResolvedOptions,
  runtime: ServerComponentsRuntime,
): void {
  app.on('POST', COMPONENT_UPLOAD_ENDPOINT, async (c) => {
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const session = await resolveSessionOrNull(opts.resolveSession, request);
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
 * Register the internal component-download GET route. Like the upload route it is
 * registered outside the extension-hook and filesystem pipelines, so the runtime
 * owns every origin/signature/policy decision. The runtime verifies the signed
 * `?ref` query parameter, authorizes the component, opens the file from the
 * store, and streams it with `Content-Disposition: attachment`.
 */
function registerComponentDownloadRoute(
  app: Hono,
  opts: ResolvedOptions,
  runtime: ServerComponentsRuntime,
): void {
  app.on('GET', COMPONENT_DOWNLOAD_ENDPOINT, async (c) => {
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const session = await resolveSessionOrNull(opts.resolveSession, request);
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
    throw new TypeError('globalMiddleware must be an array of RouteMiddleware');
  }
  validateMiddlewareRegistry(options.middlewareRegistry);

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
    introspect: options.introspect,
    globalMiddleware: options.globalMiddleware ?? [],
    middlewareRegistry: options.middlewareRegistry ?? emptyMiddlewareRegistry,
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

/** An empty, no-op middleware registry returned when none is supplied. */
const emptyMiddlewareRegistry: MiddlewareRegistry = {
  has: () => false,
  get: () => undefined,
  names: () => [],
};

/** Validate an optional middleware registry, throwing TypeError for a bad shape. */
function validateMiddlewareRegistry(value: unknown): void {
  if (value === undefined) return;
  if (value === null || typeof value !== 'object') {
    throw new TypeError('middlewareRegistry must be a MiddlewareRegistry');
  }
  const registry = value as Record<string, unknown>;
  for (const method of ['has', 'get'] as const) {
    if (typeof registry[method] !== 'function') {
      throw new TypeError('middlewareRegistry must expose has and get');
    }
  }
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
