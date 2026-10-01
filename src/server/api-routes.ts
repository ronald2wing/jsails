/**
 * Filesystem API route registration.
 *
 * Imports each compiled API module eagerly and registers its named HTTP-method
 * exports. Every handler runs through the shared pipeline: session resolution,
 * origin/CSRF checks for mutating methods, two-phase authorization (global then
 * module), then the module's middleware chain before the method handler. The
 * pipeline is default-deny — a request is allowed only when the global
 * `authorize` (and, when present, the module `authorize`) resolves to exactly
 * `true`.
 */

import type { Context, Hono } from 'hono';

import { assertCsrfToken } from '../auth/csrf.js';
import { isSameOriginRequest } from '../internal/trusted-mutation.js';
import type { ApiHandler, ApiMethod, Authorize, RequestContext } from '../contracts/http.js';
import {
  resolveMiddlewareRefs,
  runMiddleware,
  validateMiddlewareList,
  type RouteMiddleware,
} from '../routing/middleware.js';
import type { RouteManifestEntry } from '../routing/routes.js';
import {
  signalsToken,
  requestFailed,
  requestFinished,
  requestStarted,
  type SignalBus,
} from '../signals/index.js';
import {
  createRequestContext,
  CSRF_HEADER,
  HTTP_METHODS,
  jsonError,
  methodNotAllowedResponse,
  resolveSessionOrNull,
  toAuthErrorResponse,
  type ResolvedOptions,
} from './request-pipeline.js';

/** Methods that mutate server state and therefore require CSRF/origin checks. */
const MUTATING_METHODS: ReadonlySet<ApiMethod> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Import one API module and register each of its HTTP-method exports. */
export async function registerApiRoutes(
  app: Hono,
  entry: RouteManifestEntry,
  opts: ResolvedOptions,
): Promise<void> {
  const mod = (await import(entry.file)) as Record<string, unknown>;
  const moduleAuthorize = extractAuthorize(entry, mod);
  const rawModuleMiddleware = extractMiddleware(entry, mod);

  // Resolve string refs at registration time so an unknown name fails at
  // assembly rather than at request time. The module's `middleware` export may
  // contain string refs that need looking up in the named registry.
  const moduleMiddleware = rawModuleMiddleware
    ? resolveMiddlewareRefs(rawModuleMiddleware, opts.middlewareRegistry, (message) => {
        // The index in `resolveMiddlewareRefs` pinpoints the bad entry position
        // without echoing the name or handler, keeping the error value-free.
        throw new Error(`API route "${entry.route}" ${message}`);
      })
    : undefined;

  const handlers = new Map<ApiMethod, ApiHandler>();
  for (const method of HTTP_METHODS) {
    const exported = mod[method];
    if (exported === undefined) continue;
    if (typeof exported !== 'function') {
      throw new Error(`API route "${entry.route}" exports "${method}" as a non-function value`);
    }
    handlers.set(method, exported as ApiHandler);
  }

  // HEAD is not registered as a route: Hono rewrites HEAD dispatch to GET, so an
  // `app.on('HEAD', ...)` route is never matched. HEAD is served from the GET
  // route by inspecting the ORIGINAL request method (`c.req.raw.method`), which
  // Hono preserves even though it matches the request as GET. A HEAD request
  // prefers the module's HEAD export and falls back to GET; a module exposing
  // only HEAD still registers a GET route (so HEAD is reachable) that answers a
  // real GET with 405 and `Allow: HEAD`.
  const getHandler = handlers.get('GET');
  const headHandler = handlers.get('HEAD');
  if (getHandler !== undefined || headHandler !== undefined) {
    app.on('GET', entry.route, (c) => {
      if (c.req.raw.method === 'HEAD') {
        const handler = headHandler ?? getHandler;
        if (handler !== undefined) {
          return runApiHandler(c, opts, moduleAuthorize, moduleMiddleware, 'HEAD', handler);
        }
      }
      if (getHandler === undefined) {
        return methodNotAllowedResponse('HEAD');
      }
      return runApiHandler(c, opts, moduleAuthorize, moduleMiddleware, 'GET', getHandler);
    });
  }

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
    const handler = handlers.get(method);
    if (handler === undefined) continue;
    app.on(method, entry.route, (c) =>
      runApiHandler(c, opts, moduleAuthorize, moduleMiddleware, method, handler),
    );
  }
}

/**
 * Wrap an API handler with the shared request pipeline: session resolution,
 * origin/CSRF checks for mutating methods, the two-phase authorization (global
 * then module), then the module's middleware chain before the method handler.
 * Returns the handler's (or middleware's) `Response` directly.
 */
async function runApiHandler(
  c: Context,
  opts: ResolvedOptions,
  moduleAuthorize: Authorize | undefined,
  moduleMiddleware: readonly RouteMiddleware[] | undefined,
  method: ApiMethod,
  handler: ApiHandler,
): Promise<Response> {
  const request = c.req.raw;
  const url = new URL(c.req.url);
  const params = { ...c.req.param() };
  const session = await resolveSessionOrNull(opts.resolveSession, request);
  const context = createRequestContext({
    request,
    url,
    params,
    session,
    services: opts.services,
    assetUrl: opts.assetUrl,
    storagePath: opts.storagePath,
  });

  const maybeSignals = opts.services?.tryGet(signalsToken);
  // A duck-typed mock service registry (e.g. in tests) may return an arbitrary
  // value for every token, so guard structurally: only an object with an `emit`
  // method is a real SignalBus.
  const signals: SignalBus | undefined =
    maybeSignals !== undefined &&
    typeof maybeSignals === 'object' &&
    maybeSignals !== null &&
    typeof (maybeSignals as unknown as { emit?: unknown }).emit === 'function'
      ? maybeSignals
      : undefined;
  const startTime = signals ? Date.now() : 0;

  if (signals) {
    // url.pathname is the best available route identifier at this level —
    // the compiled route pattern from the manifest is captured by the closure
    // but not threaded through runApiHandler's signature.
    const route = url.pathname;
    signals.emit(requestStarted, { request, url, params, session, method, route }).catch(() => {});
  }

  try {
    const response = await (async (): Promise<Response> => {
      if (MUTATING_METHODS.has(method) && session !== null) {
        if (!isSameOriginRequest(request, opts.publicOrigin ?? url.origin)) {
          return jsonError(403, 'origin-mismatch', 'Cross-origin request rejected');
        }
        try {
          assertCsrfToken(session, request.headers.get(CSRF_HEADER));
        } catch (error) {
          return toAuthErrorResponse(error);
        }
      }

      if (!(await authorizeAllows(context, opts.authorize))) {
        return jsonError(403, 'forbidden', 'Forbidden');
      }
      if (moduleAuthorize !== undefined && !(await authorizeAllows(context, moduleAuthorize))) {
        return jsonError(403, 'forbidden', 'Forbidden');
      }

      // Global middleware runs after the two-phase authorize and before per-route
      // middleware. This ordering ensures that a deny from authorize prevents the
      // global chain from running, and the global chain owns any short-circuit
      // response before per-route logic executes. When the global chain is empty,
      // `runMiddleware` drops straight through to the next chain — no extra wrapper
      // overhead at the call level.
      const globalChain = opts.globalMiddleware;
      const handlerCall = () => {
        if (moduleMiddleware !== undefined) {
          return runMiddleware(moduleMiddleware, context, () => handler(request, context));
        }
        return handler(request, context);
      };

      if (globalChain.length === 0 && moduleMiddleware === undefined) {
        return handler(request, context);
      }
      if (globalChain.length === 0) {
        return handlerCall();
      }
      return runMiddleware(globalChain, context, handlerCall);
    })();

    if (signals) {
      const route = url.pathname;
      signals
        .emit(requestFinished, {
          request,
          url,
          params,
          session,
          method,
          route,
          status: response.status,
          durationMs: Date.now() - startTime,
        })
        .catch(() => {});
    }

    return response;
  } catch (error) {
    if (signals) {
      const route = url.pathname;
      signals
        .emit(requestFailed, {
          request,
          url,
          params,
          session,
          method,
          route,
          error,
          durationMs: Date.now() - startTime,
        })
        .catch(() => {});
    }
    throw error;
  }
}

/** Validate and return a module's optional `authorize` export. */
function extractAuthorize(
  entry: RouteManifestEntry,
  mod: Record<string, unknown>,
): Authorize | undefined {
  const exported = mod['authorize'];
  if (exported === undefined) return undefined;
  if (typeof exported !== 'function') {
    throw new Error(`API route "${entry.route}" exports "authorize" as a non-function value`);
  }
  return exported as Authorize;
}

/**
 * Validate a module's optional `middleware` export structurally and return the
 * raw array that may contain string refs. The caller resolves strings via
 * {@link resolveMiddlewareRefs} against the named registry at registration time,
 * so an unknown name fails at assembly rather than per-request.
 */
function extractMiddleware(
  entry: RouteManifestEntry,
  mod: Record<string, unknown>,
): readonly (RouteMiddleware | string)[] | undefined {
  const list = validateMiddlewareList(mod['middleware'], (message) => {
    return new Error(`API route "${entry.route}" ${message}`);
  });
  return list;
}

/** True only when the authorize callback exists and resolves to exactly `true`. */
async function authorizeAllows(
  context: RequestContext,
  authorize: Authorize | undefined,
): Promise<boolean> {
  if (authorize === undefined) return false;
  try {
    return (await authorize(context)) === true;
  } catch {
    return false;
  }
}
