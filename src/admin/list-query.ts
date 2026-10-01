/**
 * Admin list query: whitelisted parsing and canonical serialization of the
 * list-table state carried in a request's query string.
 *
 * `parseListState(url, resource)` reads the recognized `page`, `pageSize`,
 * `sort`, `direction`, `search`, and `f_<name>` parameters and reduces them to
 * a whitelisted {@link ListState}: `sort` is accepted only for a `sortable`
 * column, `search` only when a column is `searchable`, and each `f_<name>`
 * filter only when the value is one of the column's declared filter options.
 * Every bound (page, page size, search/filter length) is clamped, so a hostile
 * query string cannot drive unbounded work. `listQuery(state)` and
 * `buildQuery(state)` serialize that state back into a canonical query string,
 * and `canonicalizeBack` re-parses a submitted `_back` value through the same
 * whitelist so form/action redirects can only ever carry state that round-trips
 * cleanly. `readBulkIds` reads a bulk action's `ids` (repeated or
 * comma-separated), de-duplicated.
 *
 * The module is ORM-free and performs no I/O.
 */

import type { Resource } from './resource.js';
import { DEFAULT_PAGE_SIZE } from '../api/pagination.js';

export { DEFAULT_PAGE_SIZE };

/** Upper bound on a request-supplied `pageSize`. */
const MAX_PAGE_SIZE = 100;

/** Maximum characters accepted for a search term or a single filter value. */
const MAX_TEXT_LENGTH = 200;

/** Canonical positive-integer digits, so `Number()` cannot smuggle bad values. */
const DIGITS = /^[0-9]+$/;

/** Parsed, whitelisted list-table state carried in the query string. */
export interface ListState {
  readonly page: number;
  readonly pageSize: number;
  readonly sort?: string;
  readonly direction: 'asc' | 'desc';
  readonly search?: string;
  readonly filters: Record<string, string>;
}

/** Parse and whitelist the list-table state from a request URL. */
export function parseListState(url: URL, resource: Resource): ListState {
  const sortable = new Set(
    resource.columns.filter((column) => column.sortable === true).map((column) => column.name),
  );
  const filterable = new Map<string, Set<string>>();
  for (const column of resource.columns) {
    if (column.filter !== undefined) {
      filterable.set(column.name, new Set(column.filter.map((option) => option.value)));
    }
  }

  const rawSort = url.searchParams.get('sort');
  const sort = rawSort !== null && rawSort !== '' && sortable.has(rawSort) ? rawSort : undefined;
  const direction =
    url.searchParams.get('direction') === 'desc' ? ('desc' as const) : ('asc' as const);

  const hasSearchable = resource.columns.some((column) => column.searchable === true);
  const rawSearch = url.searchParams.get('search');
  const search =
    hasSearchable && rawSearch !== null && rawSearch !== ''
      ? rawSearch.slice(0, MAX_TEXT_LENGTH)
      : undefined;

  const filters: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (!key.startsWith('f_')) continue;
    const name = key.slice(2);
    const allowed = filterable.get(name);
    if (allowed === undefined || !allowed.has(value)) continue;
    filters[name] = value.slice(0, MAX_TEXT_LENGTH);
  }

  return {
    page: parsePositiveInt(url.searchParams.get('page'), 1),
    pageSize: parsePositiveInt(url.searchParams.get('pageSize'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    ...(sort === undefined ? {} : { sort }),
    direction,
    ...(search === undefined ? {} : { search }),
    filters,
  };
}

/** Serialize list-table state into a query string (no leading `?`). */
export function listQuery(state: ListState): string {
  const params = new URLSearchParams();
  if (state.page !== 1) params.set('page', String(state.page));
  if (state.pageSize !== DEFAULT_PAGE_SIZE) params.set('pageSize', String(state.pageSize));
  if (state.sort !== undefined) params.set('sort', state.sort);
  if (state.sort !== undefined && state.direction !== 'asc')
    params.set('direction', state.direction);
  if (state.search !== undefined) params.set('search', state.search);
  for (const [name, value] of Object.entries(state.filters)) {
    params.set(`f_${name}`, value);
  }
  return params.toString();
}

/** Serialize list-table state into a `?query` string (empty when nothing set). */
export function buildQuery(state: ListState): string {
  const query = listQuery(state);
  return query === '' ? '' : `?${query}`;
}

/** Canonicalize a submitted `_back` value through the same whitelist. */
export function canonicalizeBack(back: string | undefined, resource: Resource): string {
  if (back === undefined || back === '') return '';
  let url: URL;
  try {
    url = new URL(`http://admin.invalid?${back}`);
  } catch {
    return '';
  }
  return listQuery(parseListState(url, resource));
}

/** Read a bulk action's `ids` (repeated or comma-separated), de-duplicated. */
export function readBulkIds(url: URL): string[] {
  const ids: string[] = [];
  for (const value of url.searchParams.getAll('ids')) {
    for (const part of value.split(',')) {
      const trimmed = part.trim();
      if (trimmed !== '' && !ids.includes(trimmed)) ids.push(trimmed);
    }
  }
  return ids;
}

/** Parse a canonical positive integer, falling back on invalid/absent input. */
function parsePositiveInt(raw: string | null | undefined, fallback: number, max?: number): number {
  if (raw === null || raw === undefined || !DIGITS.test(raw)) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    return fallback;
  }
  return max === undefined ? value : Math.min(value, max);
}
