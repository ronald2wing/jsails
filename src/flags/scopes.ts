/**
 * Flag scopes — A/B-testing and gradual-rollout primitives (the Laravel Pennant
 * analog).
 *
 * A {@link FlagScope} maps a `scope` (a user id, tenant id, request id, …) to a
 * boolean "should this variant be active". Buckets are derived from a
 * **deterministic hash** of `key + scope`, so the same scope always lands in the
 * same bucket — a user's A/B cohort is stable across requests and sessions,
 * never flapping between variants.
 *
 * Pure and browser-safe: no `node:*`, no store, no I/O. Compose a scope with
 * the boolean-gate store via {@link resolveFeature} or {@link when}.
 */

import { FeatureFlagError } from './flags.js';

// ---------------------------------------------------------------------------
// Deterministic bucketing
// ---------------------------------------------------------------------------

/**
 * Map `key + scope` to a stable integer in `[0, 2^32)`. FNV-1a over the UTF-8
 * bytes, so bucketing is byte-for-byte reproducible and dependency-free.
 */
function hashScope(key: string, scope: string): number {
  let hash = 0x811c9dc5;
  const text = `${key}\u0000${scope}`;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A `scope` → boolean variant selector. */
export type FlagScope = (scope: string) => boolean;

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * Activate a variant for a stable percentage of scopes. A `scope` whose bucketed
 * hash falls under `percent` (0–100) is in; every other scope is out. The same
 * scope always resolves the same way (deterministic hashing, not random).
 *
 * `percent` must be within `[0, 100]`; `key` separates one experiment's buckets
 * from another's.
 */
export function coverage(percent: number, key: string): FlagScope {
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new FeatureFlagError('coverage percent must be a finite number in [0, 100]');
  }
  const bucketMax = Math.floor((percent / 100) * 0x100000000);
  return (scope) => {
    if (scope.length === 0) return false;
    return hashScope(key, scope) < bucketMax;
  };
}

/** `coverage(100, key)` — activate the variant for every scope. */
export function everyone(key: string): FlagScope {
  return coverage(100, key);
}

/** `coverage(0, key)` — activate the variant for no scope. */
export function nobody(key: string): FlagScope {
  return coverage(0, key);
}

// ---------------------------------------------------------------------------
// Before/after ordering (canary the new impl)
// ---------------------------------------------------------------------------

/**
 * Pick a variant by an ordered rollout step (the Pennant `BeforeAfterOrdering`
 * analog). `step` in `[0, before.length - 1]` selects which bucket is "after"
 * (the new behavior); scopes hashing below that bucket's threshold get the new
 * variant, the rest stay "before".
 *
 * Buckets are split evenly across `[0, 2^32)`, so `step = 1` of 10 means the
 * first 10% of scopes are on the new variant.
 */
export function beforeAfter(key: string, before: number, step = 1): FlagScope {
  if (!Number.isInteger(before) || before < 1) {
    throw new FeatureFlagError('before count must be a positive integer');
  }
  if (!Number.isInteger(step) || step < 0 || step > before) {
    throw new FeatureFlagError('step must be an integer in [0, before]');
  }
  const bucketMax = Math.floor((step / before) * 0x100000000);
  return (scope) => {
    if (scope.length === 0) return false;
    return hashScope(key, scope) < bucketMax;
  };
}

// ---------------------------------------------------------------------------
// Shipped
// ---------------------------------------------------------------------------

/** A scope that is always active (the Pennant `Shipped` "on forever" marker). */
export function shipped(_scope: string): boolean {
  return true;
}

// ---------------------------------------------------------------------------
// When — branch helper over a scope
// ---------------------------------------------------------------------------

/**
 * Branch between two values by a scope: `when(scope, scopeValue, activeValue,
 * inactiveValue)`. Returns `activeValue` when the scope resolves true for
 * `scopeValue`, else `inactiveValue`. The unused branch is never evaluated
 * (pass thunks for expensive values).
 */
export function when<T>(
  scope: FlagScope,
  scopeValue: string,
  activeValue: T | (() => T),
  inactiveValue: T | (() => T),
): T {
  const active = scope(scopeValue);
  return active
    ? typeof activeValue === 'function'
      ? (activeValue as () => T)()
      : activeValue
    : typeof inactiveValue === 'function'
      ? (inactiveValue as () => T)()
      : inactiveValue;
}
