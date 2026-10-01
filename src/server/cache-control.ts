/**
 * Default-deny HTTP cache-control middleware.
 *
 * Every framework-owned response receives `Cache-Control: private, no-store`
 * unless a route module explicitly declares itself cacheable via an exported
 * `cacheControl` object. A route that opts in to public caching emits
 * `Cache-Control: public, max-age=0, s-maxage=<n>, stale-while-revalidate=<n>`
 * plus `Surrogate-Control: max-age=<n>, stale-while-revalidate=<n>` and
 * `Vary: Accept-Encoding` (never `Vary: Cookie`, which would fragment a shared
 * cache key). A response carrying a `Set-Cookie` header (session-derived data)
 * is always private, overriding any route-level declaration — stale user data
 * must never be served from a shared cache.
 *
 * The middleware runs after handlers so an explicit `Cache-Control` header set
 * by a route or extension is never overwritten, following the same discipline
 * as the security-headers middleware — with one exception: a response carrying
 * a `Set-Cookie` header is always forced private (overriding any public
 * declaration and dropping the surrogate directive), because stale session
 * data must never be served from a shared cache.
 *
 * Non-GET requests (POST/PUT/PATCH/DELETE) are never eligible for public
 * caching regardless of the route's declaration, matching the HTTP caching
 * spec and the Web Cache Deception guard.
 */

/**
 * A route module's declarative cache-control export.
 *
 * Example:
 * ```
 * export const cacheControl = { maxAge: 300, staleWhileRevalidate: 60 };
 * ```
 */
export interface CacheControlDeclaration {
  /** Seconds for s-maxage (shared cache TTL). Must be a positive integer. */
  maxAge: number;
  /** Seconds for stale-while-revalidate. Defaults to 0 when omitted. */
  staleWhileRevalidate?: number;
}

/** The resolved cache-control policy for a response. */
export interface CacheControlDecision {
  readonly value: string;
  readonly vary?: string;
  readonly surrogateControl?: string;
}

/** Default-deny: private, no reuse by any cache. Never varies by Cookie. */
export const DEFAULT_CACHE_CONTROL: Readonly<CacheControlDecision> = Object.freeze({
  value: 'private, no-store',
});

/** Default-deny when a session cookie is present: private + fragment by Cookie. */
const DEFAULT_WITH_COOKIE: Readonly<CacheControlDecision> = Object.freeze({
  value: 'private, no-store',
  vary: 'Cookie',
});

/**
 * Build the public-caching decision from a route's declaration.
 * Never includes `Vary: Cookie` — a public cache key must not fragment by user.
 */
function publicDecision(declaration: CacheControlDeclaration): CacheControlDecision {
  const swr = declaration.staleWhileRevalidate ?? 0;
  return Object.freeze({
    value: `public, max-age=0, s-maxage=${declaration.maxAge}, stale-while-revalidate=${swr}`,
    surrogateControl: `max-age=${declaration.maxAge}, stale-while-revalidate=${swr}`,
    vary: 'Accept-Encoding',
  });
}

/**
 * Resolve the cache-control policy for a response.
 *
 * @param declaration - The route's `cacheControl` export, or undefined.
 * @param method - The request method (only GET/HEAD are eligible for public caching).
 * @param hasSetCookie - Whether the response carries a `Set-Cookie` header.
 */
export function resolveCacheControl(
  declaration: CacheControlDeclaration | undefined,
  method: string,
  hasSetCookie: boolean,
): CacheControlDecision {
  // Non-GET requests are never publicly cached — the HTTP caching spec
  // limits cache eligibility to GET and HEAD, and allowing POST caching
  // would open a Web Cache Deception surface.
  if (method !== 'GET' && method !== 'HEAD') {
    return DEFAULT_CACHE_CONTROL;
  }

  // A session cookie overrides any route declaration — stale user data
  // must never be served from a shared cache, even for a page that
  // declared itself public.
  if (hasSetCookie) {
    return DEFAULT_WITH_COOKIE;
  }

  // The route opted in to public caching: emit s-maxage for shared caches
  // and stale-while-revalidate for async revalidation.
  if (declaration !== undefined) {
    return publicDecision(declaration);
  }

  return DEFAULT_CACHE_CONTROL;
}

/**
 * Apply a cache-control decision to response headers, preserving any explicit
 * header already set by the route (same discipline as security headers).
 */
export function applyCacheControl(headers: Headers, decision: CacheControlDecision): void {
  // An explicit header set by a route or extension wins — the default-deny
  // middleware never clobbers an intentional override.
  if (headers.has('cache-control')) return;

  headers.set('cache-control', decision.value);

  // Surrogate-Control targets CDNs/surrogate servers; separate from
  // Cache-Control so a CDN config can override without touching the
  // origin header.
  if (decision.surrogateControl !== undefined) {
    headers.set('surrogate-control', decision.surrogateControl);
  }

  // Vary is set only when the decision calls for it and the route did not
  // already declare a different Vary policy.
  if (decision.vary !== undefined) {
    if (!headers.has('vary')) {
      headers.set('vary', decision.vary);
    }
  }
}

/**
 * Apply default-deny cache-control to a response that has not already declared
 * its own policy. Called by the global cache-control middleware after every
 * handler runs.
 *
 * - When the response carries a `Set-Cookie` header (session-derived data),
 *   forces `Cache-Control: private, no-store` and `Vary: Cookie` even if the
 *   route or a hook already set a public header, and drops `Surrogate-Control`
 *   so a shared cache never stores session data.
 * - Otherwise sets `Cache-Control: private, no-store` unless the handler already
 *   set one.
 */
export function applyDefaultCacheControl(headers: Headers): void {
  // Session-derived data must never be served from a shared cache, overriding
  // any route-level public declaration — the public `Vary: Accept-Encoding`
  // and `Surrogate-Control` set by wrapPublicResponse no longer apply.
  if (headers.has('set-cookie')) {
    headers.set('cache-control', 'private, no-store');
    headers.delete('surrogate-control');
    headers.set('vary', 'Cookie');
    return;
  }

  if (headers.has('cache-control')) return;

  headers.set('cache-control', 'private, no-store');
}

/**
 * Apply public caching headers to a response based on a route's
 * `cacheControl` declaration. Called by the route handler (not the global
 * middleware) when a page or API module exports `cacheControl`.
 *
 * Returns a new Response with updated headers. The original response is
 * never mutated. Does nothing for non-GET/HEAD requests, responses that
 * already set Cache-Control, or responses carrying a Set-Cookie header —
 * a session cookie always forces private, overriding any declaration.
 */
export function wrapPublicResponse(
  response: Response,
  declaration: CacheControlDeclaration,
  method: string,
): Response {
  // Only GET and HEAD are eligible for public shared-cache storage.
  if (method !== 'GET' && method !== 'HEAD') return response;

  // An explicit header set by the handler wins.
  if (response.headers.has('cache-control')) return response;

  // Session-derived data must never be served from a shared cache.
  if (response.headers.has('set-cookie')) return response;

  const swr = declaration.staleWhileRevalidate ?? 0;
  const headers = new Headers(response.headers);
  headers.set(
    'cache-control',
    `public, max-age=0, s-maxage=${declaration.maxAge}, stale-while-revalidate=${swr}`,
  );
  headers.set('surrogate-control', `max-age=${declaration.maxAge}, stale-while-revalidate=${swr}`);
  if (!headers.has('vary')) {
    headers.set('vary', 'Accept-Encoding');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Raised when a route module's `cacheControl` export is malformed.
 * Value-free: the message names the route and the failing field, never the
 * value itself. The `.code` is a stable machine-readable token.
 */
export class CacheControlError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CacheControlError';
    this.code = code;
  }
}

/**
 * Validate a page or API module's optional `cacheControl` export and return
 * the declaration, throwing a value-free error on a bad shape.
 *
 * The error message names the route and the field that fails, never echoing
 * the value itself. This matches the discipline of the module-level authorize
 * and middleware extractors in the route registration functions.
 */
export function extractCacheControlDeclaration(
  route: string,
  mod: Record<string, unknown>,
): CacheControlDeclaration | undefined {
  const exported = mod['cacheControl'];
  if (exported === undefined) return undefined;

  if (typeof exported !== 'object' || exported === null) {
    throw new CacheControlError(
      'non_object',
      `route "${route}" exports "cacheControl" as a non-object value`,
    );
  }

  const cc = exported as Record<string, unknown>;
  const maxAge = cc.maxAge;
  if (typeof maxAge !== 'number' || !Number.isInteger(maxAge) || maxAge <= 0) {
    throw new CacheControlError(
      'invalid_max_age',
      `route "${route}" cacheControl.maxAge must be a positive integer`,
    );
  }

  const swr = cc.staleWhileRevalidate;
  if (swr !== undefined) {
    if (typeof swr !== 'number' || !Number.isInteger(swr) || swr < 0) {
      throw new CacheControlError(
        'invalid_stale_while_revalidate',
        `route "${route}" cacheControl.staleWhileRevalidate must be a non-negative integer`,
      );
    }
  }

  return { maxAge, staleWhileRevalidate: swr };
}
