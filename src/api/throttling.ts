/**
 * API-facing rate limiting built on the fixed-window limiter from
 * `src/cache/limiter.ts`. `throttle` wraps {@link createRateLimiter} into a
 * one-shot decision helper: it checks the key against the store and returns
 * either an allow decision or a value-free `429 Too Many Requests` response with
 * a `Retry-After` header derived from the window's reset time.
 *
 * Composing with resource handlers is an early return in the handler:
 *
 * ```ts
 * const decision = await throttle({ key: `login:${sessionId}`, limit: 5, windowMs: 60_000, store });
 * if (!decision.allowed) return decision.response;
 * ```
 *
 * When `store` is omitted, a shared per-process in-memory store is used. That
 * default is convenient for tests, demos, and single-process deployments; a
 * multi-process deployment must pass a shared {@link CacheStore} (e.g. the
 * Valkey-backed store). When injecting `now` for a test, pass a `store` built
 * with the same clock so the counter's TTL aligns with the window boundary.
 */

import { createRateLimiter, rateLimitResponse } from '../cache/limiter.js';
import { createMemoryCacheStore } from '../cache/store.js';
import type { CacheStore } from '../cache/store.js';

/** Options for {@link throttle}. */
export interface ThrottleOptions {
  /** The rate-limit key (e.g. `login:<sessionId>` or `api:<ip>`). */
  readonly key: string;
  /** Maximum allowed requests per window. Must be a positive integer. */
  readonly limit: number;
  /** Window length in milliseconds. Must be a positive integer. */
  readonly windowMs: number;
  /** Persistence store for window counters. Defaults to a shared memory store. */
  readonly store?: CacheStore;
  /** Injectable clock. Pass a store sharing this clock when injecting one. */
  readonly now?: () => number;
}

/** The outcome of a throttle check. */
export interface ThrottleDecision {
  /** Whether the request is allowed. */
  readonly allowed: boolean;
  /** Requests remaining in the current window when allowed; `0` when blocked. */
  readonly remaining: number;
  /** Epoch milliseconds at which the window resets. */
  readonly resetAt: number;
  /**
   * A value-free `429 Too Many Requests` response carrying `Retry-After`, or
   * `null` when the request is allowed.
   */
  readonly response: Response | null;
}

/** Shared default store for `throttle` calls that omit `store`. */
let defaultStore: CacheStore | undefined;

/**
 * Check a rate-limit key and return a decision. Never throws for a normal
 * blocked request; invalid options throw a `TypeError` at call time.
 */
export async function throttle(options: ThrottleOptions): Promise<ThrottleDecision> {
  assertOptions(options);

  const { key, limit, windowMs } = options;
  const now = options.now ?? (() => Date.now());
  const store = options.store ?? getDefaultStore();

  const limiter = createRateLimiter({ store, limit, windowMs, now });
  const result = await limiter.check(key);

  if (result.allowed) {
    return { allowed: true, remaining: result.remaining, resetAt: result.resetAt, response: null };
  }

  const retryAfterSeconds = Math.max(0, (result.resetAt - now()) / 1000);
  return {
    allowed: false,
    remaining: 0,
    resetAt: result.resetAt,
    response: rateLimitResponse(retryAfterSeconds),
  };
}

function assertOptions(options: ThrottleOptions): void {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('throttle requires an options object');
  }
  if (typeof options.key !== 'string' || options.key.length === 0) {
    throw new TypeError('key must be a non-empty string');
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
}

function getDefaultStore(): CacheStore {
  defaultStore ??= createMemoryCacheStore();
  return defaultStore;
}
