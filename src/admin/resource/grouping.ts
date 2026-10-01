/**
 * Admin table grouping: deterministic grouping of list rows by a column
 * value.
 *
 * `groupRows(rows, { by })` partitions a flat row array into ordered groups,
 * each with a string key derived from the grouping column, a label, and the
 * rows that belong to it. The group order is the first-encountered order;
 * within each group rows keep their original relative order.
 *
 * The render helper `renderGroupedTable(...)` emits group headers and a
 * repeated table for the rows in each group. The module is ORM-free and
 * performs no I/O.
 */

import { h, type ComponentChild, type VNode } from 'preact';

import type { ResourceColumn } from '../resource.js';

// ---------------------------------------------------------------------------
// Data surface
// ---------------------------------------------------------------------------

/** One group of rows sharing the same grouping-key value. */
export interface RowGroup {
  /** The string key derived from the grouping column. */
  readonly key: string;
  /** The label rendered for this group header. */
  readonly label: string;
  /** Rows belonging to this group, in original relative order. */
  readonly rows: readonly Record<string, unknown>[];
}

/** Options for {@link groupRows}. */
export interface GroupRowsOptions {
  /** The column name to group by. */
  readonly by: string;
  /**
   * Optional label override for each group. Receives the derived key and the
   * column value; the default is the stringified key.
   */
  readonly label?: GroupLabelFn;
}

/** Derive a group's label from its key and the raw column value. */
export type GroupLabelFn = (key: string, rawValue: unknown) => string;

/** Raised for an invalid grouping spec. Messages never embed input values. */
export class GroupRowsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroupRowsError';
  }
}

/**
 * Partition rows into groups by a column value, preserving first-encountered
 * group order and relative row order within each group. An empty rows array
 * returns an empty groups array, not a group with no key.
 */
export function groupRows(
  rows: readonly Record<string, unknown>[],
  options: GroupRowsOptions,
): readonly RowGroup[] {
  if (typeof options.by !== 'string' || options.by.trim() === '') {
    throw new GroupRowsError('group by column name must be a non-empty string');
  }
  const labelFn = options.label ?? stringifyKey;

  const groups = new Map<string, { key: string; label: string; rows: Record<string, unknown>[] }>();
  for (const row of rows) {
    const raw = row[options.by];
    const key = raw === null || raw === undefined ? '' : String(raw);
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, label: labelFn(key, raw), rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }

  const result: RowGroup[] = [];
  for (const group of groups.values()) {
    result.push(
      Object.freeze({ key: group.key, label: group.label, rows: Object.freeze(group.rows) }),
    );
  }
  return Object.freeze(result);
}

/** Default label function: the key itself. */
function stringifyKey(key: string, _rawValue: unknown): string {
  return key;
}

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

/**
 * Render a grouped table: for each group, a `<h3>` header then a `<table>`
 * of the group's rows using the provided column definitions and a row
 * renderer. Row-level markup (actions, edit links) is the caller's
 * responsibility through `renderRow`.
 */
export function renderGroupedTable(
  groups: readonly RowGroup[],
  columns: readonly ResourceColumn[],
  renderRow: (row: Record<string, unknown>) => VNode<any>,
): VNode<any> {
  if (groups.length === 0) {
    return h('p', null, 'No records.');
  }

  const headerRow = h('tr', null, ...columns.map((column) => h('th', null, column.label)));

  const children: ComponentChild[] = [];
  for (const group of groups) {
    children.push(
      h('h3', { class: 'admin-group-header' }, group.label),
      h(
        'table',
        null,
        h('thead', null, headerRow),
        h('tbody', null, ...group.rows.map((row) => renderRow(row))),
      ),
    );
  }

  return h('div', { class: 'admin-grouped-table' }, ...children);
}
