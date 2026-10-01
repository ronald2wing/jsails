/**
 * Fixed-window rate limiting over a {@link CacheStore}.
 *
 * {@link createRateLimiter} counts requests per key inside a fixed time window.
 * Each window maps to its own counter key derived from `now`, so the window is
 * fixed (not sliding): a request in the next window starts a fresh counter and
 * the previous counter expires on its own TTL.
 *
 * This is an approximation, not an exactly-once primitive. `check` performs a
 * non-atomic read-then-write, so concurrent processes (or concurrent callers
 * racing on the same key) may over- or under-count by a request. That is
 * acceptable for rate limiting; do not use it where an exact count is required.
 */

import type { CacheStore } from './store.js';

/** The outcome of a rate-limit check. */
export interface RateLimitResult {
  /** Whether the request is allowed. */
  readonly allowed: boolean;
  /** Requests remaining in the current window when allowed; `0` when blocked. */
  readonly remaining: number;
  /** Epoch milliseconds at which the window resets (derived from `now`). */
  readonly resetAt: number;
}

/** A fixed-window rate limiter. */
export interface RateLimiter {
  check(key: string): Promise<RateLimitResult>;
}

/** Options for {@link createRateLimiter}. */
export interface RateLimiterOptions {
  /** The store persisting window counters. */
  readonly store: CacheStore;
  /** Maximum allowed requests per window. Must be a positive integer. */
  readonly limit: number;
  /** Window length in milliseconds. Must be a positive integer. */
  readonly windowMs: number;
  /** Injectable clock returning epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Create a fixed-window rate limiter. The clock must agree with the store's
 * clock (pass the same `now` to both when one is injected) so that a counter's
 * TTL aligns with the window boundary.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createRateLimiter requires an options object');
  }
  if (options.store === null || typeof options.store !== 'object') {
    throw new TypeError('store must be a cache store');
  }
  if (typeof options.store.get !== 'function' || typeof options.store.set !== 'function') {
    throw new TypeError('store must provide get and set');
  }
  if (typeof options.limit !== 'number' || !Number.isInteger(options.limit) || options.limit < 1) {
    throw new TypeError('limit must be a positive integer');
  }
  if (
    typeof options.windowMs !== 'number' ||
    !Number.isInteger(options.windowMs) ||
    options.windowMs < 1
  ) {
    throw new TypeError('windowMs must be a positive integer');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('now must be a function');
  }

  const { store, limit, windowMs } = options;
  const now = options.now ?? (() => Date.now());

  return {
    async check(key) {
      const current = now();
      const windowStart = Math.floor(current / windowMs) * windowMs;
      const resetAt = windowStart + windowMs;
      const bucketKey = `${key}:${windowStart}`;
      const raw = await store.get(bucketKey);
      const count = raw === null ? 0 : parseCount(raw);
      if (count >= limit) {
        return { allowed: false, remaining: 0, resetAt };
      }
      const next = count + 1;
      await store.set(bucketKey, String(next), resetAt - current);
      return { allowed: true, remaining: limit - next, resetAt };
    },
  };
}

/** Parse a stored counter; a malformed value counts as zero (never throws). */
function parseCount(value: string): number {
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

/**
 * Build a value-free `429 Too Many Requests` response. The body and headers
 * carry no request details. An optional `retryAfterSeconds` sets the
 * `Retry-After` header; a non-finite value is omitted.
 */
export function rateLimitResponse(retryAfterSeconds?: number): Response {
  const headers = new Headers();
  headers.set('content-type', 'text/plain; charset=utf-8');
  headers.set('cache-control', 'no-store');
  if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)) {
    headers.set('retry-after', String(Math.max(0, Math.ceil(retryAfterSeconds))));
  }
  return new Response('Too Many Requests', { status: 429, headers });
}

/**
 * A Hono-agnostic rate-limit guard: a middleware-shaped function that calls
 * `next` when the limiter allows the key derived from `context`, and returns a
 * value-free `429` otherwise. It imports no HTTP framework — the caller supplies
 * `keyFn` and `next`, so it composes with Hono, a plain handler, or any other
 * request model.
 *
 * The blocked response carries no `Retry-After`, because the guard does not own
 * a clock. A caller that wants one can bypass the guard, call `limiter.check`
 * directly, and pass the seconds until `resetAt` to {@link rateLimitResponse}.
 */
export function guardRateLimit<TContext>(
  limiter: RateLimiter,
  keyFn: (context: TContext) => string,
  next: (context: TContext) => Response | Promise<Response>,
): (context: TContext) => Promise<Response> {
  return async (context) => {
    const result = await limiter.check(keyFn(context));
    if (!result.allowed) {
      return rateLimitResponse();
    }
    return next(context);
  };
}
