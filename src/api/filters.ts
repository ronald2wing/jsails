/**
 * Query-string filter/sort/search parsing over a store-agnostic adapter.
 *
 * `parseFilters` reads the recognized list-query parameters from a `URL` (or a
 * bare `URLSearchParams`) and returns a normalized {@link NormalizedQuery} that
 * any store can apply — there is no database coupling and no assumption about
 * how rows are ordered, searched, or filtered. The recognized forms are:
 *
 * - `?search=<term>` — a single, bounded free-text term (trimmed).
 * - `?sort=<field>` or `?sort=-<field>` — a leading `-` means descending. The
 *   parameter may be repeated and may carry a comma-separated list
 *   (`?sort=name,-age`); every clause field must be whitelisted.
 * - `?filter[<field>]=<value>` — the `eq` (equals) filter form. A field must
 *   be whitelisted and filterable; values are coerced to the field's declared
 *   type (string, integer, or boolean) with no implicit coercion. Repeating the
 *   same field keeps the last value.
 * - `?filter[<field>][]=<a>&filter[<field>][]=<b>` — accumulated array,
 *   operator `in`. Every element is coerced individually; the array is bounded
 *   per field by {@link FilterOptions.maxFilters}.
 * - `?filter[<field>][<op>]=<value>` — a named operator (`gt`, `gte`, `lt`,
 *   `lte`, `neq`, `in`, `nin`). The operator must appear in the field's
 *   {@link FilterFieldOptions.operators} whitelist; a field without an explicit
 *   whitelist accepts only `eq`.
 *
 * The result carries two filter projections:
 * 1. {@link NormalizedQuery.filters} — scalar only, the last `eq` value per
 *    field (backward-compatible).
 * 2. {@link NormalizedQuery.filterClauses} — every filter clause, including
 *    array and non-`eq` operator forms.
 *
 * Every bound is enforced before any value is accepted: search length, sort
 * count, filter count, and filter value length all carry explicit maxima so a
 * hostile query string cannot drive unbounded work. Errors are value-free
 * `ValidationError`s whose messages never echo a query value (field *names* are
 * structure, not data, and may appear), so a caller can map them to a `400`
 * exactly like the resource handlers do.
 */

import { ValidationError, type FieldPath, type ValidationIssue } from './validation.js';

/** Declared capabilities of one filterable/sortable field. */
export interface FilterFieldOptions {
  /** Whether the field may appear in `sort`. Defaults to `true`. */
  readonly sortable?: boolean;
  /** Whether the field may appear in `filter[...]`. Defaults to `true`. */
  readonly filterable?: boolean;
  /** Value coercion applied to `filter[...]` values. Defaults to `"string"`. */
  readonly type?: 'string' | 'integer' | 'boolean';
  /**
   * Allowed filter operators for this field. Defaults to `['eq']`; a field
   * without this whitelist cannot participate in array (`in`) or comparison
   * (`gt`/`gte`/`lt`/`lte`/`neq`/`nin`) filter forms.
   */
  readonly operators?: readonly FilterOperator[];
}

/** Options for {@link parseFilters}. */
export interface FilterOptions {
  /** Whitelist of fields; only declared fields may be sorted or filtered. */
  readonly fields: Readonly<Record<string, FilterFieldOptions>>;
  /** Maximum characters for `?search=`. Defaults to 200. */
  readonly maxSearchLength?: number;
  /** Maximum number of sort clauses. Defaults to 8. */
  readonly maxSorts?: number;
  /** Maximum number of distinct filter fields. Defaults to 32. */
  readonly maxFilters?: number;
  /** Maximum characters per filter value. Defaults to 200. */
  readonly maxFilterValueLength?: number;
}

/** A single resolved sort clause. */
export interface SortClause {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

/** A coerced filter value — scalar or, for `in`/`nin` operators, an array. */
export type FilterValue = string | number | boolean | readonly (string | number | boolean)[];

/** A filter operator: equality, comparison, or set membership. */
export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin';

/** A single resolved filter clause from the query string. */
export interface FilterClause {
  readonly field: string;
  readonly operator: FilterOperator;
  readonly value: FilterValue;
}

/** A normalized, store-ready query. */
export interface NormalizedQuery {
  /** The search term, or `null` when absent/blank. */
  readonly search: string | null;
  /** Resolved sort clauses in request order (deduplicated by field). */
  readonly sorts: readonly SortClause[];
  /**
   * Scalar filter values — the last `eq` value per field (backward-compatible).
   * Array and non-`eq` operator forms appear only in {@link filterClauses}.
   */
  readonly filters: Readonly<Record<string, FilterValue>>;
  /** Every resolved filter clause, including array and non-`eq` operator forms. */
  readonly filterClauses: readonly FilterClause[];
}

const DEFAULT_MAX_SEARCH_LENGTH = 200;
const DEFAULT_MAX_SORTS = 8;
const DEFAULT_MAX_FILTERS = 32;
const DEFAULT_MAX_FILTER_VALUE_LENGTH = 200;

/** Canonical signed integer: optional sign, then digits only. */
const INTEGER_RE = /^-?[0-9]+$/;
/** The three recognized filter-key forms. */
const FILTER_EQ_RE = /^filter\[([^\]]+)\]$/; // filter[field]=v  → eq
const FILTER_ARR_RE = /^filter\[([^\]]+)\]\[\]$/; // filter[field][]=v → accumulate (in)
const FILTER_OP_RE = /^filter\[([^\]]+)\]\[([^\]]+)\]$/; // filter[field][op]=v → named operator

/**
 * Parse list-query parameters into a normalized query. Throws a value-free
 * `ValidationError` on any out-of-whitelist field or exceeded bound.
 */
export function parseFilters(
  input: URL | URLSearchParams,
  options: FilterOptions,
): NormalizedQuery {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('parseFilters requires an options object');
  }
  if (
    options.fields === null ||
    typeof options.fields !== 'object' ||
    Array.isArray(options.fields)
  ) {
    throw new TypeError('fields must be an object of declared field options');
  }

  const params = toSearchParams(input);
  const fields = options.fields;
  const maxSearchLength = options.maxSearchLength ?? DEFAULT_MAX_SEARCH_LENGTH;
  const maxSorts = options.maxSorts ?? DEFAULT_MAX_SORTS;
  const maxFilters = options.maxFilters ?? DEFAULT_MAX_FILTERS;
  const maxFilterValueLength = options.maxFilterValueLength ?? DEFAULT_MAX_FILTER_VALUE_LENGTH;

  const search = parseSearch(params.get('search'), maxSearchLength);
  const sorts = parseSorts(params, fields, maxSorts);
  const { filters, filterClauses } = parseFieldFilters(
    params,
    fields,
    maxFilters,
    maxFilterValueLength,
  );

  return { search, sorts, filters, filterClauses };
}

/** `search` is optional, trimmed, and bounded; a blank value is treated as none. */
function parseSearch(raw: string | null, maxSearchLength: number): string | null {
  if (raw === null) {
    return null;
  }
  const term = raw.trim();
  if (term.length === 0) {
    return null;
  }
  if (term.length > maxSearchLength) {
    throw new ValidationError([
      filterIssue(
        [],
        'search_too_long',
        `Search term must be at most ${maxSearchLength} characters`,
      ),
    ]);
  }
  return term;
}

/** Resolves every `sort` parameter (repeated and comma-separated) into clauses. */
function parseSorts(
  params: URLSearchParams,
  fields: Readonly<Record<string, FilterFieldOptions>>,
  maxSorts: number,
): SortClause[] {
  const clauses: SortClause[] = [];
  const seen = new Set<string>();
  for (const raw of params.getAll('sort')) {
    for (const token of raw.split(',')) {
      const clause = token.trim();
      if (clause.length === 0) {
        throw new ValidationError([filterIssue([], 'invalid_sort', 'Invalid sort clause')]);
      }
      const direction: 'asc' | 'desc' = clause.startsWith('-') ? 'desc' : 'asc';
      const field = direction === 'desc' ? clause.slice(1) : clause;
      if (field.length === 0) {
        throw new ValidationError([filterIssue([], 'invalid_sort', 'Invalid sort clause')]);
      }
      const declared = fields[field];
      if (declared === undefined) {
        throw new ValidationError([
          filterIssue(['sort'], 'unknown_sort_field', `Unknown sort field "${field}"`),
        ]);
      }
      if (declared.sortable === false) {
        throw new ValidationError([
          filterIssue(['sort'], 'unsortable_field', `Field "${field}" is not sortable`),
        ]);
      }
      if (seen.has(field)) {
        continue; // first occurrence wins; later duplicates are ignored
      }
      seen.add(field);
      clauses.push({ field, direction });
      if (clauses.length > maxSorts) {
        throw new ValidationError([
          filterIssue(['sort'], 'too_many_sorts', `Too many sort clauses (max ${maxSorts})`),
        ]);
      }
    }
  }
  return clauses;
}

/**
 * Resolves `filter[field]`, `filter[field][]`, and `filter[field][op]`
 * parameters into a clause list and a backward-compatible scalar filter map.
 */
function parseFieldFilters(
  params: URLSearchParams,
  fields: Readonly<Record<string, FilterFieldOptions>>,
  maxFilters: number,
  maxFilterValueLength: number,
): { filters: Readonly<Record<string, FilterValue>>; filterClauses: readonly FilterClause[] } {
  // Phase 1: classify every entry by (field, operator) and accumulate raw values.
  // Composite key: `${field}\x00${operator}`.
  const rawAccum = new Map<string, { field: string; operator: string; values: string[] }>();
  for (const [key, value] of params) {
    let parsed: { field: string; operator: string } | undefined;

    const arrMatch = FILTER_ARR_RE.exec(key);
    if (arrMatch !== null) {
      const f = arrMatch[1];
      if (f !== undefined) parsed = { field: f, operator: 'in' };
    } else {
      const opMatch = FILTER_OP_RE.exec(key);
      if (opMatch !== null) {
        const f = opMatch[1];
        const op = opMatch[2];
        if (f !== undefined && op !== undefined && op.length > 0) {
          parsed = { field: f, operator: op };
        }
      } else {
        const eqMatch = FILTER_EQ_RE.exec(key);
        if (eqMatch !== null) {
          const f = eqMatch[1];
          if (f !== undefined) parsed = { field: f, operator: 'eq' };
        }
      }
    }

    if (parsed === undefined) {
      continue;
    }

    if (parsed.field.length === 0) {
      throw new ValidationError([
        filterIssue(['filter'], 'invalid_filter', 'Invalid filter parameter'),
      ]);
    }

    const gk = `${parsed.field}\x00${parsed.operator}`;
    let group = rawAccum.get(gk);
    if (group === undefined) {
      group = { field: parsed.field, operator: parsed.operator, values: [] };
      rawAccum.set(gk, group);
    }
    group.values.push(value);
  }

  // Phase 2: validate and coerce.
  const distinctFields = new Set<string>();
  const clauses: FilterClause[] = [];
  const filterMap: Record<string, FilterValue> = {};

  for (const [, group] of rawAccum) {
    const { field, operator, values } = group;

    const declared = fields[field];
    if (declared === undefined) {
      throw new ValidationError([
        filterIssue(['filter'], 'unknown_filter_field', `Unknown filter field "${field}"`),
      ]);
    }
    if (declared.filterable === false) {
      throw new ValidationError([
        filterIssue(['filter'], 'unfilterable_field', `Field "${field}" is not filterable`),
      ]);
    }

    const allowedOps: readonly string[] = declared.operators ?? ['eq'];
    if (!allowedOps.includes(operator)) {
      throw new ValidationError([
        filterIssue(
          ['filter', field],
          'invalid_filter_operator',
          `Filter operator "${operator}" is not allowed for field "${field}"`,
        ),
      ]);
    }

    // Enforce distinct-field bound (maxFilters).
    if (!distinctFields.has(field)) {
      if (distinctFields.size >= maxFilters) {
        throw new ValidationError([
          filterIssue(['filter'], 'too_many_filters', `Too many filters (max ${maxFilters})`),
        ]);
      }
      distinctFields.add(field);
    }

    const type = declared.type ?? 'string';

    if (operator === 'in' || operator === 'nin') {
      // Per-field array element cap via maxFilters.
      if (values.length > maxFilters) {
        throw new ValidationError([
          filterIssue(
            ['filter', field],
            'too_many_filter_values',
            `Too many filter values for field "${field}" (max ${maxFilters})`,
          ),
        ]);
      }
      const coerced: (string | number | boolean)[] = [];
      for (const v of values) {
        coerced.push(coerceFilterValue(field, type, v, maxFilterValueLength));
      }
      clauses.push({ field, operator, value: coerced });
    } else {
      // eq / comparison operators: keep the last raw value.
      const lastValue = values[values.length - 1] ?? '';
      const coerced = coerceFilterValue(field, type, lastValue, maxFilterValueLength);
      clauses.push({ field, operator: operator as FilterOperator, value: coerced });
      if (operator === 'eq') {
        filterMap[field] = coerced;
      }
    }
  }

  return { filters: filterMap, filterClauses: clauses };
}

/** Coerce a raw query value to the field's declared type; never echoes the value. */
function coerceFilterValue(
  field: string,
  type: 'string' | 'integer' | 'boolean',
  value: string,
  maxFilterValueLength: number,
): string | number | boolean {
  switch (type) {
    case 'integer': {
      if (!INTEGER_RE.test(value)) {
        throw new ValidationError([
          filterIssue(['filter', field], 'invalid_filter_value', 'Expected an integer'),
        ]);
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) {
        throw new ValidationError([
          filterIssue(['filter', field], 'invalid_filter_value', 'Expected an integer'),
        ]);
      }
      return parsed;
    }
    case 'boolean': {
      if (value === 'true') {
        return true;
      }
      if (value === 'false') {
        return false;
      }
      throw new ValidationError([
        filterIssue(['filter', field], 'invalid_filter_value', 'Expected a boolean'),
      ]);
    }
    default:
      if (value.length > maxFilterValueLength) {
        throw new ValidationError([
          filterIssue(
            ['filter', field],
            'filter_value_too_long',
            `Filter value must be at most ${maxFilterValueLength} characters`,
          ),
        ]);
      }
      return value;
  }
}

function filterIssue(path: FieldPath, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

function toSearchParams(input: URL | URLSearchParams): URLSearchParams {
  return input instanceof URLSearchParams ? input : input.searchParams;
}

/**
 * In-memory search matcher: does `row` match `term` across the string values of
 * `fields`? Matching is case-insensitive substring; string, number, and boolean
 * values participate (via their string form), and anything else is skipped. A
 * blank or absent term always matches. Useful for stores backed by arrays and
 * for tests.
 */
export function matchesSearch(
  row: unknown,
  fields: readonly string[],
  term: string | null | undefined,
): boolean {
  if (term === null || term === undefined || term.trim().length === 0) {
    return true;
  }
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return false;
  }
  const needle = term.toLowerCase();
  const source = row as Record<string, unknown>;
  for (const field of fields) {
    const value = source[field];
    if (typeof value === 'string') {
      if (value.toLowerCase().includes(needle)) {
        return true;
      }
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      if (String(value).toLowerCase().includes(needle)) {
        return true;
      }
    }
  }
  return false;
}
