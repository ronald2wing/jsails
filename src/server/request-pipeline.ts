/**
 * Shared request-pipeline primitives for the HTTP assembly.
 *
 * This module is the leaf of the `server` package's dependency graph: the
 * assembly (`app.ts`), the filesystem API registration (`api-routes.ts`), and
 * the page registration (`page-routes.ts`) all import from it, while it never
 * imports back (its only reference to `app.ts` is the type-only
 * `Authorize`/`RenderPage`/`ResolveSession` contract, erased at compile time).
 * It holds the API method/CSRF constants, per-request {@link RequestContext}
 * construction, session resolution, and the sanitized JSON error envelope, so
 * no route module has to import the assembly that imports it.
 */

import { ValidationError } from '../api/validation.js';
import type { HttpExtensionHook } from '../extensions/extension.js';
import type { ServiceRegistry } from '../extensions/services.js';
import {
  HttpError,
  type AssetUrlResolver,
  type Authorize,
  type RenderPage,
  type RequestContext,
  type ResolveSession,
  type Session,
} from '../contracts/http.js';
import type { PageRenderer } from '../contracts/render.js';
import type { RouteManifest } from '../routing/routes.js';
import type { AppContext, AppMiddlewareHandler, HttpVariables } from './env.js';

// CSRF primitives for the per-route middleware factory.
import { assertCsrfToken } from '../auth/csrf.js';
import { isSameOriginRequest } from '../internal/trusted-mutation.js';

/** HTTP method names recognized as API handler exports. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;

/** Request header carrying the session-bound CSRF token on mutations. */
export const CSRF_HEADER = 'X-CSRF-Token';

import type { IntrospectRouteConfig } from '../introspect/route.js';
import type { SeoRuntimeOptions } from '../seo/metadata.js';

// (other imports remain)

/** Options resolved and validated by `createApp`; shared by every route module. */
export interface ResolvedOptions {
  readonly manifest: RouteManifest;
  readonly authorize: Authorize | undefined;
  readonly resolveSession: ResolveSession | undefined;
  readonly renderPage: RenderPage | undefined;
  readonly renderer: PageRenderer | undefined;
  readonly services: ServiceRegistry | undefined;
  readonly httpHooks: readonly HttpExtensionHook[];
  readonly maxBodyBytes: number;
  readonly publicOrigin: string | undefined;
  readonly assetUrl: AssetUrlResolver | undefined;
  readonly healthPath: string | undefined;
  readonly storagePath: string | undefined;
  readonly seo: SeoRuntimeOptions | undefined;
  readonly introspect: IntrospectRouteConfig | undefined;
  /** Optional system-check registry for the deep health probe. */
  readonly systemChecks?: import('../database/system-checks.js').SystemCheckRegistry;
  /**
   * Resolved global middleware chain, applied to every request after the
   * authorize gates and before per-route middleware. Built by the application
   * layer from config `globalMiddleware` refs (resolved against the named
   * registry) followed by extension `configureMiddleware` handlers in setup
   * order. An empty array means no global middleware runs.
   */
  readonly globalMiddleware: readonly AppMiddlewareHandler[];
  /**
   * Named middleware map for resolving string refs at registration time.
   * Built by the application layer from config `middleware` entries.
   */
  readonly middlewareMap: Readonly<Record<string, AppMiddlewareHandler>>;
  /** Locale-prefixed routing: locales to register as `/{locale}` aliases. */
  readonly localeOptions?: { readonly locales: readonly string[]; readonly defaultLocale?: string };
}

/** Inputs to {@link createRequestContext}; each field maps to one context field. */
interface BuildContextInput {
  readonly request: Request;
  readonly url: URL;
  readonly params: Record<string, string>;
  readonly session: Session | null;
  readonly publicOrigin?: string;
  readonly services?: ServiceRegistry;
  readonly assetUrl?: AssetUrlResolver;
  readonly storagePath?: string;
  readonly seo?: SeoRuntimeOptions;
  readonly locale?: string;
}

/**
 * Build a {@link RequestContext} from a resolved request, URL, params, and
 * session, attaching the optional `publicOrigin`/`services`/`assetUrl`/
 * `storagePath` fields only when they are defined. The API pipeline omits
 * `publicOrigin`; page and server-component contexts carry it when configured.
 */
export function createRequestContext(input: BuildContextInput): RequestContext {
  return {
    request: input.request,
    url: input.url,
    params: input.params,
    session: input.session,
    ...(input.publicOrigin === undefined ? {} : { publicOrigin: input.publicOrigin }),
    ...(input.services === undefined ? {} : { services: input.services }),
    ...(input.assetUrl === undefined ? {} : { assetUrl: input.assetUrl }),
    ...(input.storagePath === undefined ? {} : { storagePath: input.storagePath }),
    ...(input.seo === undefined ? {} : { seo: input.seo }),
    ...(input.locale === undefined ? {} : { locale: input.locale }),
  };
}

/**
 * Build a sovereign {@link RequestContext} from a Hono {@link AppContext} and
 * the per-request variables stored on `c.var` by the pipeline middleware.
 *
 * This is the SINGLE terminal adapter — every page and API handler sees
 * {@link RequestContext}, never Hono's `Context`.
 */
export function createRequestContextFromStore(c: AppContext, vars: HttpVariables): RequestContext {
  return createRequestContext({
    request: c.req.raw,
    url: new URL(c.req.url),
    params: { ...c.req.param() },
    session: vars.session,
    services: vars.services,
    assetUrl: vars.assetUrl,
    storagePath: vars.storagePath,
    seo: vars.seo,
    publicOrigin: vars.publicOrigin,
    locale: vars.locale,
  });
}

/** Resolve the session for a request, failing closed to `null`. */
export async function resolveSessionOrNull(
  resolveSession: ResolveSession | undefined,
  request: Request,
): Promise<Session | null> {
  if (resolveSession === undefined) return null;
  try {
    return (await resolveSession(request)) ?? null;
  } catch {
    return null;
  }
}

interface ErrorBody {
  error: { status: number; code: string; message: string; [key: string]: unknown };
}

/** Build a JSON error-envelope response without ever echoing raw error text. */
export function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  const body: ErrorBody = { error: { status, code, message, ...extra } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** Map a thrown authorization/CSRF error to a sanitized response. */
export function toAuthErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonError(error.status, error.code, error.message);
  }
  return jsonError(403, 'forbidden', 'Forbidden');
}

/** Reduce any thrown error to the generic JSON envelope. */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof ValidationError) {
    return jsonError(400, 'validation_error', 'Validation failed', {
      issues: error.issues.map((issue) => ({
        path: [...issue.path],
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  if (error instanceof HttpError) {
    return jsonError(error.status, error.code, error.message);
  }
  return jsonError(500, 'internal_error', 'Internal Server Error');
}

/**
 * Build the shared 405 response with a matching `Allow` header and body field,
 * used by both the `methodNotAllowed` middleware and the HEAD-only GET fallback
 * so the two never disagree on the advertised methods.
 */
export function methodNotAllowedResponse(allow: string): Response {
  return jsonError(405, 'method_not_allowed', 'Method Not Allowed', { allow }, { allow });
}

/**
 * Build a per-route CSRF middleware for API routes. Applied only to mutating
 * methods (POST/PUT/PATCH/DELETE) when a session is present. The middleware
 * checks same-origin and CSRF-token match; for a non-mutating method or a null
 * session it passes through without blocking. A rejection returns a 403 JSON
 * envelope and short-circuits the chain.
 */
export function createCsrfMiddleware(publicOrigin: string | undefined): AppMiddlewareHandler {
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  return async (c, next) => {
    const session = c.var.session;
    if (session === null || session === undefined) return next();
    if (!MUTATING.has(c.req.method)) return next();
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const origin = publicOrigin ?? url.origin;
    if (!isSameOriginRequest(request, origin)) {
      return jsonError(403, 'origin-mismatch', 'Cross-origin request rejected');
    }
    try {
      assertCsrfToken(session, request.headers.get(CSRF_HEADER));
    } catch (error) {
      return toAuthErrorResponse(error);
    }
    return next();
  };
}

/**
 * Build an authorization-gate middleware: it calls `authorize(context)` where
 * `context` is built from Hono's `c.var`. A result of exactly `true` allows the
 * chain to continue; any other result (false, throw, rejection, truthy
 * non-boolean) short-circuits with a 403 JSON envelope. A missing `authorize`
 * (default-deny) always short-circuits.
 */
export function createAuthorizeMiddleware(authorize: Authorize | undefined): AppMiddlewareHandler {
  if (authorize === undefined) {
    return async (_c, _next) => jsonError(403, 'forbidden', 'Forbidden');
  }
  return async (c, next) => {
    const ctx = createRequestContextFromStore(c, c.var);
    try {
      const allowed = await authorize(ctx);
      if (allowed !== true) {
        return jsonError(403, 'forbidden', 'Forbidden');
      }
    } catch {
      return jsonError(403, 'forbidden', 'Forbidden');
    }
    return next();
  };
}

/**
 * Adapt a sovereign API handler `(request, context) => Response` into a Hono
 * {@link AppMiddlewareHandler} so it can terminate a Hono middleware chain.
 * The handler receives {@link RequestContext} built from `c.var`, never the
 * raw Hono `Context`.
 */
export function adaptApiHandler(
  handler: (request: Request, context: RequestContext) => Response | Promise<Response>,
): AppMiddlewareHandler {
  return async (c, _next) => {
    const ctx = createRequestContextFromStore(c, c.var);
    return handler(c.req.raw, ctx);
  };
}
