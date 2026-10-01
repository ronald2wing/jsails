/**
 * Admin resource columns: the list-table column and infolist type definitions,
 * their validation, and their deep-freezing.
 *
 * Columns carry optional list-table affordances: a `format` (`badge`,
 * `boolean`, or `date`) with an optional `colors` value map, a `sortable`
 * flag, a `searchable` flag, and a `filter` (a set of select options rendered
 * as a drop-down filter). Cell values are user data and are always rendered as
 * escaped text; `colors` values are author-supplied (trusted) styling hooks.
 *
 * The module is ORM-free: it imports only the resource error and the shared
 * select-option type, and performs no I/O.
 */

import { ResourceError } from './error.js';
import type { ResourceSelectOption } from './fields.js';

/** List-table cell formats (shared by columns and infolist entries). */
export type ResourceColumnFormat =
  'badge' | 'boolean' | 'date' | 'image' | 'icon' | 'color' | 'tags';

/** Resolve a relation column's display labels for one row. */
export type ResourceRelationResolver = (
  row: Record<string, unknown>,
) => readonly string[] | Promise<readonly string[]>;

/** A list-table column. */
export interface ResourceColumn {
  /** Row key the cell reads from (`row[name]`). */
  readonly name: string;
  /** Column header label. */
  readonly label: string;
  /** `'relation'` renders labels resolved from the row; otherwise a plain value cell. */
  readonly type?: 'relation';
  /**
   * Resolve the related labels for a row; required and only valid for a
   * `'relation'` column. The returned labels are rendered as escaped text.
   */
  readonly resolve?: ResourceRelationResolver;
  /** Cell rendering format. */
  readonly format?: ResourceColumnFormat;
  /**
   * Author-supplied value-to-color map for `badge` (keyed by stringified cell
   * value) or `boolean` (keyed by `"true"`/`"false"`). Trusted styling only.
   */
  readonly colors?: Readonly<Record<string, string>>;
  /** When `true`, the header renders a `sort`/`direction` link. */
  readonly sortable?: boolean;
  /** When `true`, the column participates in the `search` text query. */
  readonly searchable?: boolean;
  /** When present, the column renders as a `f_<name>` select filter. */
  readonly filter?: readonly ResourceSelectOption[];
  /** Base URL prefix for `image` format cells. Only valid when `format` is `'image'`. */
  readonly imageBaseUrl?: string;
  /** Separator for `tags` format cells; defaults to `','`. Only valid when `format` is `'tags'`. */
  readonly tagSeparator?: string;
}

/** One read-only detail row in a resource's infolist. */
export interface ResourceInfolistEntry {
  /** Record key the entry reads from (`record[name]`). */
  readonly name: string;
  /** Human label rendered next to the value. */
  readonly label: string;
  /** Value rendering format, mirroring a column's `format`. */
  readonly format?: ResourceColumnFormat;
  /** Badge/boolean value-to-color map (same shape as a column's `colors`). */
  readonly colors?: Readonly<Record<string, string>>;
}

/** A read-only detail section rendered above the edit form. */
export interface ResourceInfolist {
  /** Section heading. */
  readonly label: string;
  /** The detail rows, rendered in order. */
  readonly entries: readonly ResourceInfolistEntry[];
}

const COLUMN_FORMATS: ReadonlySet<string> = new Set([
  'badge',
  'boolean',
  'date',
  'image',
  'icon',
  'color',
  'tags',
]);

/** Validate the list columns, requiring a non-empty array of valid entries. */
export function validateColumns(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ResourceError('resource columns must be a non-empty array');
  }
  const seen = new Set<string>();
  for (const column of value) {
    if (column === null || typeof column !== 'object') {
      throw new ResourceError('resource column must be an object');
    }
    validateColumn(column as ResourceColumn, seen);
  }
}

/** Validate one column: name, label, and the optional format/sort/filter fields. */
function validateColumn(column: ResourceColumn, seen: Set<string>): void {
  if (typeof column.name !== 'string' || column.name.trim() === '') {
    throw new ResourceError('resource column name must be a non-empty string');
  }
  if (typeof column.label !== 'string' || column.label.trim() === '') {
    throw new ResourceError('resource column label must be a non-empty string');
  }
  if (seen.has(column.name)) {
    throw new ResourceError('resource column names must be unique');
  }
  seen.add(column.name);
  if (column.type !== undefined && column.type !== 'relation') {
    throw new ResourceError('resource column type is not supported');
  }
  if (column.type === 'relation') {
    if (typeof column.resolve !== 'function') {
      throw new ResourceError('relation column must define a resolve function');
    }
    if (
      column.format !== undefined ||
      column.colors !== undefined ||
      column.sortable !== undefined ||
      column.searchable !== undefined ||
      column.filter !== undefined
    ) {
      throw new ResourceError('relation column must not declare value cell affordances');
    }
  } else if (column.resolve !== undefined) {
    throw new ResourceError('column resolve is only valid for relation columns');
  }
  if (column.format !== undefined && !COLUMN_FORMATS.has(column.format)) {
    throw new ResourceError('resource column format is not supported');
  }
  if (column.format === 'image') {
    if (typeof column.imageBaseUrl !== 'string' || column.imageBaseUrl === '') {
      throw new ResourceError('image column must define a non-empty imageBaseUrl');
    }
  } else if (column.imageBaseUrl !== undefined) {
    throw new ResourceError('imageBaseUrl is only valid for image format columns');
  }
  if (column.format === 'tags') {
    if (
      column.tagSeparator !== undefined &&
      (typeof column.tagSeparator !== 'string' || column.tagSeparator === '')
    ) {
      throw new ResourceError('tagSeparator must be a non-empty string');
    }
  } else if (column.tagSeparator !== undefined) {
    throw new ResourceError('tagSeparator is only valid for tags format columns');
  }
  if (column.sortable !== undefined && typeof column.sortable !== 'boolean') {
    throw new ResourceError('resource column sortable must be a boolean');
  }
  if (column.searchable !== undefined && typeof column.searchable !== 'boolean') {
    throw new ResourceError('resource column searchable must be a boolean');
  }
  if (column.colors !== undefined) {
    validateColumnColors(column);
  }
  if (column.filter !== undefined) {
    validateFilterOptions(column.filter);
  }
}

/** Validate a column's color map: a plain object of string values, badge/boolean only. */
function validateColumnColors(column: ResourceColumn): void {
  validateColorMap(column.format, column.colors);
}

/** Validate a color map: plain object of string values, only for badge/boolean. */
function validateColorMap(
  format: ResourceColumnFormat | undefined,
  colors: Readonly<Record<string, string>> | undefined,
): void {
  if (format !== 'badge' && format !== 'boolean') {
    throw new ResourceError('resource colors are only valid for badge or boolean formats');
  }
  if (colors === null || typeof colors !== 'object' || Array.isArray(colors)) {
    throw new ResourceError('resource colors must be an object');
  }
  for (const [key, value] of Object.entries(colors as Record<string, unknown>)) {
    if (key in Object.prototype) {
      throw new ResourceError('resource colors must not shadow an inherited property');
    }
    if (typeof value !== 'string') {
      throw new ResourceError('resource colors must map strings to strings');
    }
  }
}

/** Validate the optional infolist: a labeled, non-empty, well-formed entry list. */
export function validateInfolist(infolist: ResourceInfolist): void {
  if (infolist === null || typeof infolist !== 'object' || Array.isArray(infolist)) {
    throw new ResourceError('resource infolist must be an object');
  }
  if (typeof infolist.label !== 'string' || infolist.label.trim() === '') {
    throw new ResourceError('infolist label must be a non-empty string');
  }
  if (!Array.isArray(infolist.entries) || infolist.entries.length === 0) {
    throw new ResourceError('infolist entries must be a non-empty array');
  }
  const seen = new Set<string>();
  for (const entry of infolist.entries) {
    if (entry === null || typeof entry !== 'object') {
      throw new ResourceError('infolist entry must be an object');
    }
    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
      throw new ResourceError('infolist entry name must be a non-empty string');
    }
    if (typeof entry.label !== 'string' || entry.label.trim() === '') {
      throw new ResourceError('infolist entry label must be a non-empty string');
    }
    if (seen.has(entry.name)) {
      throw new ResourceError('infolist entry names must be unique');
    }
    seen.add(entry.name);
    if (entry.format !== undefined && !COLUMN_FORMATS.has(entry.format)) {
      throw new ResourceError('infolist entry format is not supported');
    }
    if (entry.colors !== undefined) {
      validateColorMap(entry.format, entry.colors);
    }
  }
}

/** Validate a column's select-filter options (same shape as select options). */
function validateFilterOptions(options: unknown): void {
  if (!Array.isArray(options) || options.length === 0) {
    throw new ResourceError('column filter options must be a non-empty array');
  }
  const seen = new Set<string>();
  for (const option of options) {
    if (option === null || typeof option !== 'object') {
      throw new ResourceError('filter option must be an object');
    }
    const value = (option as ResourceSelectOption).value;
    const label = (option as ResourceSelectOption).label;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ResourceError('filter option value must be a non-empty string');
    }
    if (typeof label !== 'string' || label.trim() === '') {
      throw new ResourceError('filter option label must be a non-empty string');
    }
    if (seen.has(value)) {
      throw new ResourceError('filter option values must be unique');
    }
    seen.add(value);
  }
}

/** Deep-freeze a defensive copy of the columns. */
export function freezeColumns(columns: readonly ResourceColumn[]): readonly ResourceColumn[] {
  return Object.freeze(
    columns.map((column) =>
      Object.freeze({
        name: column.name,
        label: column.label,
        ...(column.type === undefined ? {} : { type: column.type }),
        ...(column.resolve === undefined ? {} : { resolve: column.resolve }),
        ...(column.format === undefined ? {} : { format: column.format }),
        ...(column.colors === undefined ? {} : { colors: Object.freeze({ ...column.colors }) }),
        ...(column.sortable === undefined ? {} : { sortable: column.sortable }),
        ...(column.searchable === undefined ? {} : { searchable: column.searchable }),
        ...(column.imageBaseUrl === undefined ? {} : { imageBaseUrl: column.imageBaseUrl }),
        ...(column.tagSeparator === undefined ? {} : { tagSeparator: column.tagSeparator }),
        ...(column.filter === undefined
          ? {}
          : {
              filter: Object.freeze(
                column.filter.map((option) =>
                  Object.freeze({ value: option.value, label: option.label }),
                ),
              ),
            }),
      }),
    ),
  );
}

/** Deep-freeze a defensive copy of the infolist. */
export function freezeInfolist(infolist: ResourceInfolist): ResourceInfolist {
  return Object.freeze({
    label: infolist.label,
    entries: Object.freeze(
      infolist.entries.map((entry) =>
        Object.freeze({
          name: entry.name,
          label: entry.label,
          ...(entry.format === undefined ? {} : { format: entry.format }),
          ...(entry.colors === undefined ? {} : { colors: Object.freeze({ ...entry.colors }) }),
        }),
      ),
    ),
  });
}
