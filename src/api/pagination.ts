/**
 * Bounded pagination core. No database coupling: pagination validates and
 * normalizes `page`/`pageSize` (capping `pageSize` at an upper bound) and
 * computes numeric `next`/`previous` page links rather than URLs, so it makes
 * no assumptions about routing or hostnames.
 */

import { ValidationError } from './validation.js';

export const DEFAULT_PAGE_SIZE = 20;
export const DEFAULT_MAX_PAGE_SIZE = 100;

export interface PaginationOptions {
  /** Upper bound for the applied page size. Defaults to 100. */
  maxPageSize?: number;
  /** Page size applied when the request omits `pageSize`. Defaults to 20. */
  defaultPageSize?: number;
}

/** A single page of results plus cursor-free navigation metadata. */
export interface Page<T> {
  /** Total number of items across all pages. */
  count: number;
  /** The items on the current page. */
  results: T[];
  /** The current page number (1-based). */
  page: number;
  /** The applied page size (already capped). */
  pageSize: number;
  /** Next page number, or `null` when there is no next page. */
  next: number | null;
  /** Previous page number, or `null` when there is no previous page. */
  previous: number | null;
}

/**
 * A bounded query interface an API worker can implement on top of any store.
 * Optional: pagination itself never depends on a concrete database.
 */
export interface QueryAdapter<T> {
  count(): Promise<number>;
  list(offset: number, limit: number): Promise<T[]>;
}

/** A validated, normalized pagination pair. */
export interface NormalizedPagination {
  page: number;
  pageSize: number;
}

/**
 * Validates and normalizes untrusted pagination parameters. `page` and
 * `pageSize` must be positive integers (no string coercion); `pageSize` is
 * capped at `maxPageSize`. Out-of-range pages are not an error — the pager
 * returns an empty result set.
 */
export function normalizePagination(
  params: unknown,
  options: PaginationOptions = {},
): NormalizedPagination {
  const maxPageSize = options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;

  if (!Number.isInteger(maxPageSize) || maxPageSize < 1) {
    throw new Error('maxPageSize must be a positive integer');
  }
  if (!Number.isInteger(defaultPageSize) || defaultPageSize < 1) {
    throw new Error('defaultPageSize must be a positive integer');
  }

  const source =
    params !== null && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};

  const page = readPositiveInteger(source, 'page', 1);
  const pageSize = Math.min(readPositiveInteger(source, 'pageSize', defaultPageSize), maxPageSize);
  return { page, pageSize };
}

function readPositiveInteger(
  source: Record<string, unknown>,
  key: 'page' | 'pageSize',
  fallback: number,
): number {
  const raw = source[key];
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new ValidationError([
      {
        path: [key],
        code: key === 'page' ? 'invalid_page' : 'invalid_page_size',
        message: `${key} must be a positive integer`,
      },
    ]);
  }
  return raw;
}

function computeLinks(
  count: number,
  page: number,
  pageSize: number,
): {
  next: number | null;
  previous: number | null;
} {
  const totalPages = count === 0 ? 0 : Math.ceil(count / pageSize);
  const next = page < totalPages ? page + 1 : null;
  const previous = page > 1 && totalPages > 0 ? Math.min(page - 1, totalPages) : null;
  return { next, previous };
}

/** Paginates an in-memory array. Useful for tests and adapters without a DB. */
export function paginateArray<T>(
  items: readonly T[],
  params: unknown,
  options: PaginationOptions = {},
): Page<T> {
  const { page, pageSize } = normalizePagination(params, options);
  const count = items.length;
  const start = (page - 1) * pageSize;
  const results = start >= count ? [] : items.slice(start, start + pageSize);
  const { next, previous } = computeLinks(count, page, pageSize);
  return { count, results, page, pageSize, next, previous };
}

/** Paginates via a bounded query adapter, fetching only the current window. */
export async function paginate<T>(
  adapter: QueryAdapter<T>,
  params: unknown,
  options: PaginationOptions = {},
): Promise<Page<T>> {
  const { page, pageSize } = normalizePagination(params, options);
  const count = await adapter.count();
  const results = await adapter.list((page - 1) * pageSize, pageSize);
  const { next, previous } = computeLinks(count, page, pageSize);
  return { count, results, page, pageSize, next, previous };
}
