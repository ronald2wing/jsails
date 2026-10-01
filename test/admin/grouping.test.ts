/**
 * Admin table grouping tests: row grouping and grouped-table rendering.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { h } from 'preact';

import {
  GroupRowsError,
  groupRows,
  renderGroupedTable,
} from '../../src/admin/resource/grouping.js';
import type { ResourceColumn } from '../../src/admin/resource.js';
import { renderToString } from '../../src/jsx/render-to-string.js';

// ---------------------------------------------------------------------------
// Row grouping
// ---------------------------------------------------------------------------

describe('groupRows', () => {
  it('groups rows by a column, preserving first-encountered order', () => {
    const rows = [
      { id: '1', status: 'active', title: 'A' },
      { id: '2', status: 'inactive', title: 'B' },
      { id: '3', status: 'active', title: 'C' },
      { id: '4', status: 'inactive', title: 'D' },
    ];
    const groups = groupRows(rows, { by: 'status' });
    assert.equal(groups.length, 2);
    assert.equal(groups[0]!.key, 'active');
    assert.equal(groups[0]!.label, 'active');
    assert.equal(groups[0]!.rows.length, 2);
    assert.equal(groups[0]!.rows[0]!.id, '1');
    assert.equal(groups[0]!.rows[1]!.id, '3');
    assert.equal(groups[1]!.key, 'inactive');
    assert.equal(groups[1]!.rows.length, 2);
    assert.equal(groups[1]!.rows[0]!.id, '2');
    assert.equal(groups[1]!.rows[1]!.id, '4');
  });

  it('returns an empty array for empty rows', () => {
    const groups = groupRows([], { by: 'status' });
    assert.equal(groups.length, 0);
  });

  it('treats null and undefined as empty string key', () => {
    const rows = [
      { id: '1', status: null },
      { id: '2', status: undefined },
      { id: '3', status: 'active' },
    ];
    const groups = groupRows(rows, { by: 'status' });
    assert.equal(groups.length, 2);
    // Null and undefined -> empty key.
    assert.equal(groups[0]!.key, '');
    assert.equal(groups[0]!.rows.length, 2);
    assert.equal(groups[1]!.key, 'active');
  });

  it('handles a custom label function', () => {
    const rows = [
      { id: '1', status: 'active', title: 'A' },
      { id: '2', status: 'inactive', title: 'B' },
    ];
    const groups = groupRows(rows, {
      by: 'status',
      label: (key, raw) => `${key}:${String(raw)}`,
    });
    assert.equal(groups[0]!.label, 'active:active');
  });

  it('rejects an empty group-by column name', () => {
    assert.throws(() => groupRows([], { by: '' }), GroupRowsError);
    assert.throws(() => groupRows([], { by: '  ' }), GroupRowsError);
  });

  it('preserves relative row order within each group', () => {
    const rows = [
      { id: 'a', cat: 'x', val: 1 },
      { id: 'b', cat: 'y', val: 2 },
      { id: 'c', cat: 'x', val: 3 },
      { id: 'd', cat: 'y', val: 4 },
      { id: 'e', cat: 'x', val: 5 },
    ];
    const groups = groupRows(rows, { by: 'cat' });
    assert.equal(groups[0]!.key, 'x');
    assert.deepEqual(
      groups[0]!.rows.map((r) => r.val),
      [1, 3, 5],
    );
    assert.equal(groups[1]!.key, 'y');
    assert.deepEqual(
      groups[1]!.rows.map((r) => r.val),
      [2, 4],
    );
  });

  it('treats all values as strings for key comparison', () => {
    const rows = [
      { id: '1', count: 5 },
      { id: '2', count: '5' },
      { id: '3', count: 5 },
    ];
    const groups = groupRows(rows, { by: 'count' });
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.key, '5');
    assert.equal(groups[0]!.rows.length, 3);
  });

  it('returns frozen groups and rows', () => {
    const rows = [{ id: '1', status: 'active' }];
    const groups = groupRows(rows, { by: 'status' });
    assert.ok(Object.isFrozen(groups));
    assert.ok(Object.isFrozen(groups[0]!));
    assert.ok(Object.isFrozen(groups[0]!.rows));
  });
});

// ---------------------------------------------------------------------------
// Grouped table rendering
// ---------------------------------------------------------------------------

describe('renderGroupedTable', () => {
  const COLUMNS: readonly ResourceColumn[] = [
    { name: 'id', label: 'ID' },
    { name: 'title', label: 'Title' },
    { name: 'status', label: 'Status' },
  ];

  const rows = [
    { id: '1', title: 'Alpha', status: 'active' },
    { id: '2', title: 'Beta', status: 'active' },
    { id: '3', title: 'Gamma', status: 'inactive' },
  ];

  const groups = groupRows(rows, { by: 'status' });

  it('renders group headers and per-group tables', () => {
    const html = renderToString(
      renderGroupedTable(groups, COLUMNS, (row) =>
        h('tr', null, ...COLUMNS.map((col) => h('td', null, String(row[col.name])))),
      ),
    );
    assert.match(html, /admin-grouped-table/);
    assert.match(html, /admin-group-header/);
    assert.match(html, />active</);
    assert.match(html, />inactive</);
    // Two tables.
    const tableCount = (html.match(/<table>/g) ?? []).length;
    assert.equal(tableCount, 2);
    assert.match(html, />Alpha</);
    assert.match(html, />Beta</);
    assert.match(html, />Gamma</);
  });

  it('renders "No records." for empty groups', () => {
    const html = renderToString(
      renderGroupedTable([], COLUMNS, () => h('tr', null, h('td', null, ''))),
    );
    assert.match(html, /No records/);
  });

  it('renders column headers in each group table', () => {
    const html = renderToString(
      renderGroupedTable(groups, COLUMNS, (row) =>
        h('tr', null, ...COLUMNS.map((col) => h('td', null, String(row[col.name])))),
      ),
    );
    // Column headers should appear.
    assert.match(html, />ID</);
    assert.match(html, />Title</);
    assert.match(html, />Status</);
  });

  it('escapes hostile group labels through Preact', () => {
    const hostileRows = [{ id: '1', status: '<script>alert(1)</script>', title: 'A' }];
    const hostileGroups = groupRows(hostileRows, { by: 'status' });
    const html = renderToString(
      renderGroupedTable(hostileGroups, COLUMNS, (row) =>
        h('tr', null, ...COLUMNS.map((col) => h('td', null, String(row[col.name])))),
      ),
    );
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script/);
  });
});
