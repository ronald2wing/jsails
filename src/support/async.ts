import { debounce as esDebounce, memoize as esMemoize, throttle as esThrottle } from 'es-toolkit';
import pLimit from 'p-limit';
import pMap from 'p-map';
import pRetry from 'p-retry';

import { SupportError } from './errors.js';

// ---------------------------------------------------------------------------
// Domain error
// ---------------------------------------------------------------------------

export class AsyncError extends SupportError {
  readonly code = 'invalid_argument';
}

// ---------------------------------------------------------------------------
// Validation helpers (value-free — never echo the offending value)
// ---------------------------------------------------------------------------

function assertFunction(value: unknown, operation: string): asserts value is Function {
  if (typeof value !== 'function') {
    throw new AsyncError(`Async.${operation}: expected a function`);
  }
}

function assertNonNegativeNumber(value: unknown, operation: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new AsyncError(`Async.${operation}: expected a non-negative finite number`);
  }
}

function assertPositiveInteger(value: unknown, operation: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 1 ||
    !Number.isInteger(value)
  ) {
    throw new AsyncError(`Async.${operation}: expected a positive integer`);
  }
}

function assertNonNegativeInteger(value: unknown, operation: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isInteger(value)
  ) {
    throw new AsyncError(`Async.${operation}: expected a non-negative integer`);
  }
}

// ---------------------------------------------------------------------------
// Own helpers
// ---------------------------------------------------------------------------

/**
 * Resolves after `ms` milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  assertNonNegativeNumber(ms, 'sleep');
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Alias of `sleep`. */
export function delay(ms: number): Promise<void> {
  return sleep(ms);
}

/**
 * Wraps a function so it runs at most once.
 * Subsequent calls return the first call's result.
 */
export function once<F extends (...args: never[]) => unknown>(fn: F): F {
  assertFunction(fn, 'once');
  let called = false;
  let result: ReturnType<F>;
  return ((...args: never[]) => {
    if (!called) {
      called = true;
      result = fn(...args) as ReturnType<F>;
    }
    return result;
  }) as unknown as F;
}

// ---------------------------------------------------------------------------
// Wraps: es-toolkit (debounce / throttle / memoize)
// ---------------------------------------------------------------------------

export interface DebounceOptions {
  leading?: boolean;
  trailing?: boolean;
}

export interface ThrottleOptions {
  leading?: boolean;
  trailing?: boolean;
}

function toEsDebounceOptions(opts?: DebounceOptions): Record<string, unknown> {
  if (!opts) return {};
  const edges: string[] = [];
  if (opts.leading) edges.push('leading');
  if (opts.trailing !== false) edges.push('trailing');
  return { edges };
}

function toEsThrottleOptions(opts?: ThrottleOptions): Record<string, unknown> {
  if (!opts) return {};
  const edges: string[] = [];
  if (opts.leading !== false) edges.push('leading');
  if (opts.trailing !== false) edges.push('trailing');
  return { edges };
}

export function debounce<F extends (...args: never[]) => void>(
  fn: F,
  waitMs: number,
  options?: DebounceOptions,
): F & { cancel: () => void } {
  assertFunction(fn, 'debounce');
  assertNonNegativeNumber(waitMs, 'debounce');
  return esDebounce(
    fn as unknown as (...args: unknown[]) => void,
    waitMs,
    toEsDebounceOptions(options),
  ) as unknown as F & {
    cancel: () => void;
  };
}

export function throttle<F extends (...args: never[]) => void>(
  fn: F,
  waitMs: number,
  options?: ThrottleOptions,
): F & { cancel: () => void } {
  assertFunction(fn, 'throttle');
  assertNonNegativeNumber(waitMs, 'throttle');
  return esThrottle(
    fn as unknown as (...args: unknown[]) => void,
    waitMs,
    toEsThrottleOptions(options),
  ) as unknown as F & {
    cancel: () => void;
  };
}

export function memoize<F extends (...args: never[]) => unknown>(
  fn: F,
  options?: { cache?: Map<unknown, ReturnType<F>> },
): F & { cache: Map<unknown, ReturnType<F>> } {
  assertFunction(fn, 'memoize');
  // es-toolkit's generic constraint `F extends (...args: any) => any` differs
  // from our stricter constraint. The runtime behavior is identical; cast
  // through unknown to bridge.
  return (esMemoize as unknown as (f: Function, o?: unknown) => Function)(
    fn,
    options,
  ) as unknown as F & {
    cache: Map<unknown, ReturnType<F>>;
  };
}

// ---------------------------------------------------------------------------
// Wraps: p-retry
// ---------------------------------------------------------------------------

export interface RetryOptions {
  retries?: number;
  factor?: number;
  minTimeout?: number;
  maxTimeout?: number;
  randomize?: boolean;
  onFailedAttempt?: (error: unknown) => void;
}

export function retry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  assertFunction(fn, 'retry');
  if (options?.retries !== undefined) {
    assertNonNegativeInteger(options.retries, 'retry');
  }
  return pRetry<T>(fn, options);
}

// ---------------------------------------------------------------------------
// Wraps: p-limit
// ---------------------------------------------------------------------------

export function limit<T>(concurrency: number): (fn: () => Promise<T>) => Promise<T> {
  assertPositiveInteger(concurrency, 'limit');
  return pLimit(concurrency);
}

// ---------------------------------------------------------------------------
// Wraps: p-map
// ---------------------------------------------------------------------------

export interface MapConcurrentOptions {
  concurrency?: number;
  stopOnError?: boolean;
}

export function mapConcurrent<T, U>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<U>,
  options?: MapConcurrentOptions,
): Promise<U[]> {
  if (!Array.isArray(items)) {
    throw new AsyncError('Async.mapConcurrent: items must be an array');
  }
  assertFunction(mapper, 'mapConcurrent');
  if (options?.concurrency !== undefined) {
    assertPositiveInteger(options.concurrency, 'mapConcurrent');
  }
  return pMap(items, mapper, options);
}

// ---------------------------------------------------------------------------
// Native
// ---------------------------------------------------------------------------

export function timeout(ms: number): AbortSignal {
  assertNonNegativeNumber(ms, 'timeout');
  return AbortSignal.timeout(ms);
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

export const Async = Object.freeze({
  sleep,
  delay,
  once,
  debounce,
  throttle,
  memoize,
  retry,
  limit,
  mapConcurrent,
  timeout,
});
