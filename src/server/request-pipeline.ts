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
import type { MiddlewareRegistry, RouteMiddleware } from '../routing/middleware.js';
import type { RouteManifest } from '../routing/routes.js';

/** HTTP method names recognized as API handler exports. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;

/** Request header carrying the session-bound CSRF token on mutations. */
export const CSRF_HEADER = 'X-CSRF-Token';

import type { IntrospectRouteConfig } from '../introspect/route.js';

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
  readonly introspect: IntrospectRouteConfig | undefined;
  /**
   * Resolved global middleware chain, applied to every API request after the
   * authorize gates and before per-route middleware. Built by the application
   * layer from config `globalMiddleware` refs (resolved against the named
   * registry) followed by extension `configureMiddleware` handlers in setup
   * order. An empty array means no global middleware runs.
   */
  readonly globalMiddleware: readonly RouteMiddleware[];
  /** Named middleware registry for resolving string refs in route exports. */
  readonly middlewareRegistry: MiddlewareRegistry;
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
  };
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
