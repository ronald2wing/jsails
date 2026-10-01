import qs from 'qs';

import { SupportError } from './errors.js';

// ---------------------------------------------------------------------------
// Domain error
// ---------------------------------------------------------------------------

export class UrlError extends SupportError {
  readonly code = 'invalid_argument';
}

// ---------------------------------------------------------------------------
// Internal helpers (value-free — never echo the offending value)
// ---------------------------------------------------------------------------

function assertString(value: unknown, operation: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new UrlError(`Url.${operation}: expected a string`);
  }
}

function assertValidUrl(url: string, operation: string): URL {
  assertString(url, operation);
  try {
    return new URL(url);
  } catch {
    throw new UrlError(`Url.${operation}: invalid URL`);
  }
}

// ---------------------------------------------------------------------------
// Native: URLSearchParams — flat query
// ---------------------------------------------------------------------------

/**
 * Parse a flat query string into a `Record<string, string>`.
 *
 * Uses the platform `URLSearchParams`. Repeated keys take the last value.
 */
export function parseQuery(input: string | URLSearchParams): Record<string, string> {
  if (input instanceof URLSearchParams) {
    const result: Record<string, string> = {};
    for (const [key, value] of input) {
      result[key] = value;
    }
    return result;
  }

  assertString(input, 'parseQuery');
  const params = new URLSearchParams(input);
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    result[key] = value;
  }
  return result;
}

/**
 * Build a flat query string from a record.
 *
 * `null` and `undefined` values are omitted. Uses the platform `URLSearchParams`.
 */
export function buildQuery(
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    searchParams.set(key, String(value));
  }

  return searchParams.toString();
}

// ---------------------------------------------------------------------------
// Wraps: qs — nested query
// ---------------------------------------------------------------------------

/**
 * Parse a deeply nested query string into a `Record<string, unknown>`.
 *
 * Wraps `qs.parse`. Supports nested objects (`a[b]=c`) and arrays (`a[]=1&a[]=2`).
 */
export function parseQueryDeep(input: string): Record<string, unknown> {
  assertString(input, 'parseQueryDeep');
  return qs.parse(input);
}

/** Options for `buildQueryDeep`. */
export type QsOptions = {
  /** Add `'[]'` suffix to array keys. Default `false`. */
  addArraySuffix?: boolean;
  /** Use `indices` for array keys (`a[0]=1`). Default `false`. */
  arrayIndices?: boolean;
  /** Custom encoder function. */
  encoder?: (value: unknown) => string;
};

/**
 * Build a deeply nested query string from a record.
 *
 * Wraps `qs.stringify`. Supports nested objects and arrays.
 */
export function buildQueryDeep(params: Record<string, unknown>, options?: QsOptions): string {
  const qsOptions: Record<string, unknown> = {};

  if (options?.addArraySuffix === true) {
    qsOptions.arrayFormat = 'brackets';
  }
  if (options?.arrayIndices === true) {
    qsOptions.arrayFormat = 'indices';
  }
  if (options?.encoder !== undefined) {
    qsOptions.encoder = options.encoder;
  }

  return qs.stringify(params, qsOptions);
}

// ---------------------------------------------------------------------------
// Own: URL manipulation (over platform URL)
// ---------------------------------------------------------------------------

/**
 * Join a base URL with one or more path segments.
 *
 * Uses the platform `URL` constructor to resolve relative paths correctly.
 * An absolute path segment replaces the base path entirely.
 */
export function join(base: string, ...segments: readonly string[]): string {
  assertValidUrl(base, 'join');

  if (segments.length === 0) return base;

  const url = new URL(base);

  for (const segment of segments) {
    assertString(segment, 'join');

    if (segment.startsWith('/')) {
      // Absolute path — replace the entire pathname.
      url.pathname = segment;
    } else if (segment.startsWith('?')) {
      // Query-only segment.
      url.search = segment;
    } else if (segment.startsWith('#')) {
      // Hash-only segment.
      url.hash = segment;
    } else if (url.pathname.endsWith('/')) {
      url.pathname += segment;
    } else {
      url.pathname += '/' + segment;
    }
  }

  return url.toString();
}

/**
 * Add or overwrite query parameters on a URL.
 *
 * Returns a new URL string. Existing parameters not in `params` are preserved;
 * parameters in `params` are overwritten.
 */
export function addParams(url: string, params: Record<string, string>): string {
  const parsed = assertValidUrl(url, 'addParams');

  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, value);
  }

  return parsed.toString();
}

/**
 * Remove query parameters from a URL.
 *
 * Returns a new URL string. Parameters not listed in `keys` are preserved.
 */
export function removeParams(url: string, keys: readonly string[]): string {
  const parsed = assertValidUrl(url, 'removeParams');

  for (const key of keys) {
    parsed.searchParams.delete(key);
  }

  return parsed.toString();
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

export const Url = Object.freeze({
  parseQuery,
  buildQuery,
  parseQueryDeep,
  buildQueryDeep,
  join,
  addParams,
  removeParams,
});
