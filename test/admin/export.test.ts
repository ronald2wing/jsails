/**
 * Admin bulk export tests: descriptor validation, CSV/JSON serialization,
 * column resolution, and export-action wiring.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ExportActionError,
  defineExportAction,
  serializeExport,
  resolveExportColumns,
  createExportRun,
  wireExportAction,
  type ExportActionDefinition,
  type ExportFormat,
  type ExportResult,
} from '../../src/admin/resource/export.js';

// ---------------------------------------------------------------------------
// Descriptor validation
// ---------------------------------------------------------------------------

describe('defineExportAction validation', () => {
  it('accepts a valid csv export spec', () => {
    const spec: ExportActionDefinition = {
      name: 'exportCsv',
      label: 'Export CSV',
      format: 'csv',
      columns: ['id', 'title'],
    };
    const action = defineExportAction(spec);
    assert.equal(action.name, 'exportCsv');
    assert.equal(action.label, 'Export CSV');
    assert.equal(action.format, 'csv');
    assert.deepEqual(action.columns, ['id', 'title']);
    assert.ok(Object.isFrozen(action));
  });

  it('accepts a valid json export spec without columns', () => {
    const spec: ExportActionDefinition = {
      name: 'exportJson',
      label: 'Export JSON',
      format: 'json',
    };
    const action = defineExportAction(spec);
    assert.equal(action.format, 'json');
    assert.equal(action.columns, undefined);
  });

  it('rejects a non-object spec', () => {
    assert.throws(() => defineExportAction(null as never), ExportActionError);
    assert.throws(() => defineExportAction([] as never), ExportActionError);
  });

  it('rejects an empty name', () => {
    assert.throws(
      () => defineExportAction({ name: '', label: 'A', format: 'csv' }),
      ExportActionError,
    );
  });

  it('rejects a name with non-alphanumeric chars', () => {
    assert.throws(
      () => defineExportAction({ name: '123x', label: 'A', format: 'csv' }),
      ExportActionError,
    );
    assert.throws(
      () => defineExportAction({ name: 'x y', label: 'A', format: 'csv' }),
      ExportActionError,
    );
  });

  it('rejects an empty label', () => {
    assert.throws(
      () => defineExportAction({ name: 'export', label: '  ', format: 'csv' }),
      ExportActionError,
    );
  });

  it('rejects an invalid format', () => {
    assert.throws(
      () => defineExportAction({ name: 'export', label: 'E', format: 'xml' as ExportFormat }),
      ExportActionError,
    );
  });

  it('rejects empty columns array', () => {
    assert.throws(
      () => defineExportAction({ name: 'export', label: 'E', format: 'csv', columns: [] }),
      ExportActionError,
    );
  });

  it('rejects non-string column names', () => {
    assert.throws(
      () =>
        defineExportAction({ name: 'export', label: 'E', format: 'csv', columns: [1 as never] }),
      ExportActionError,
    );
  });
});

// ---------------------------------------------------------------------------
// Column resolution
// ---------------------------------------------------------------------------

describe('resolveExportColumns', () => {
  it('returns explicit columns when provided', () => {
    const columns = resolveExportColumns(['id', 'title'], [{ id: '1', title: 'A', extra: 'x' }]);
    assert.deepEqual(columns, ['id', 'title']);
  });

  it('falls back to own-enumerable keys of the first row', () => {
    const columns = resolveExportColumns(undefined, [{ id: '1', title: 'A', extra: 'x' }]);
    assert.deepEqual(columns, ['id', 'title', 'extra']);
  });

  it('returns empty array for empty rows', () => {
    const columns = resolveExportColumns(undefined, []);
    assert.deepEqual(columns, []);
  });

  it('returns explicit columns even when rows are empty', () => {
    const columns = resolveExportColumns(['id'], []);
    assert.deepEqual(columns, ['id']);
  });
});

// ---------------------------------------------------------------------------
// CSV serialization
// ---------------------------------------------------------------------------

describe('serializeExport (csv)', () => {
  it('serializes rows to RFC-4180 CSV with headers', () => {
    const result = serializeExport(
      'csv',
      ['id', 'title'],
      [
        { id: '1', title: 'Hello' },
        { id: '2', title: 'World' },
      ],
    );
    assert.equal(result.contentType, 'text/csv; charset=utf-8');
    assert.equal(result.content, 'id,title\r\n1,Hello\r\n2,World\r\n');
  });

  it('double-quotes fields with commas', () => {
    const result = serializeExport('csv', ['name'], [{ name: 'Doe, John' }]);
    assert.equal(result.content, 'name\r\n"Doe, John"\r\n');
  });

  it('double-quotes fields with double quotes and escapes internal quotes', () => {
    const result = serializeExport('csv', ['name'], [{ name: 'He said "hello"' }]);
    assert.equal(result.content, 'name\r\n"He said ""hello"""\r\n');
  });

  it('double-quotes fields with newlines', () => {
    const result = serializeExport('csv', ['body'], [{ body: 'line1\nline2' }]);
    assert.equal(result.content, 'body\r\n"line1\nline2"\r\n');
  });

  it('renders null/undefined as empty string', () => {
    const result = serializeExport('csv', ['id', 'extra'], [{ id: '1', extra: null }]);
    assert.equal(result.content, 'id,extra\r\n1,\r\n');
  });

  it('stringifies non-string values', () => {
    const result = serializeExport('csv', ['id', 'active'], [{ id: 1, active: true }]);
    assert.equal(result.content, 'id,active\r\n1,true\r\n');
  });

  it('produces an empty body for empty rows', () => {
    const result = serializeExport('csv', ['id', 'title'], []);
    assert.equal(result.content, 'id,title\r\n');
  });
});

// ---------------------------------------------------------------------------
// JSON serialization
// ---------------------------------------------------------------------------

describe('serializeExport (json)', () => {
  it('serializes rows to a JSON array of objects', () => {
    const result = serializeExport(
      'json',
      ['id', 'title'],
      [
        { id: '1', title: 'Hello' },
        { id: '2', title: 'World' },
      ],
    );
    assert.equal(result.contentType, 'application/json; charset=utf-8');
    const parsed = JSON.parse(result.content);
    assert.deepEqual(parsed, [
      { id: '1', title: 'Hello' },
      { id: '2', title: 'World' },
    ]);
  });

  it('maps missing values to null', () => {
    const result = serializeExport('json', ['id', 'extra'], [{ id: '1' }]);
    const parsed = JSON.parse(result.content);
    assert.deepEqual(parsed, [{ id: '1', extra: null }]);
  });

  it('includes only the declared columns, maintaining order', () => {
    const result = serializeExport(
      'json',
      ['title', 'id'],
      [{ id: '1', title: 'Hello', extra: 'x' }],
    );
    const parsed = JSON.parse(result.content);
    const keys = Object.keys(parsed[0]);
    // Ordered: title then id.
    assert.deepEqual(keys, ['title', 'id']);
  });

  it('produces an empty array for empty rows', () => {
    const result = serializeExport('json', ['id'], []);
    assert.equal(result.content, '[]');
  });
});

// ---------------------------------------------------------------------------
// Export action wiring
// ---------------------------------------------------------------------------

describe('createExportRun', () => {
  it('serializes records through a holder', () => {
    const holder: { result?: ExportResult | null } = {};
    const run = createExportRun('csv', ['id', 'title'], holder);
    run({ session: { id: 's1', csrfToken: 'c', data: {}, expiresAt: 9e12 }, path: '/admin' }, [
      { id: '1', title: 'A' },
      { id: '2', title: 'B' },
    ]);
    assert.ok(holder.result != null);
    assert.equal(holder.result.content, 'id,title\r\n1,A\r\n2,B\r\n');
  });

  it('resolves columns from the first row when no explicit columns', () => {
    const holder: { result?: ExportResult | null } = {};
    const run = createExportRun('json', undefined, holder);
    run({ session: { id: 's1', csrfToken: 'c', data: {}, expiresAt: 9e12 }, path: '/admin' }, [
      { id: '1', title: 'A' },
    ]);
    assert.ok(holder.result != null);
    const parsed = JSON.parse(holder.result.content);
    assert.deepEqual(parsed, [{ id: '1', title: 'A' }]);
  });

  it('returns empty content for empty rows with no explicit columns', () => {
    const holder: { result?: ExportResult | null } = {};
    const run = createExportRun('csv', undefined, holder);
    run({ session: { id: 's1', csrfToken: 'c', data: {}, expiresAt: 9e12 }, path: '/admin' }, []);
    assert.equal(holder.result!.content, '');
    assert.equal(holder.result!.contentType, 'text/plain; charset=utf-8');
  });
});

describe('wireExportAction', () => {
  it('returns a wired action with name, label, run, and a holder', () => {
    const { action, holder } = wireExportAction({
      name: 'exportCsv',
      label: 'Export CSV',
      format: 'csv',
      columns: ['id'],
    });
    assert.equal(action.name, 'exportCsv');
    assert.equal(action.label, 'Export CSV');
    assert.equal(typeof action.run, 'function');
    assert.deepEqual(holder, {});

    // Run the action.
    action.run(
      { session: { id: 's1', csrfToken: 'c', data: {}, expiresAt: 9e12 }, path: '/admin' },
      [{ id: '1' }, { id: '2' }],
    );
    assert.equal(holder.result!.content, 'id\r\n1\r\n2\r\n');
    assert.equal(holder.result!.contentType, 'text/csv; charset=utf-8');
  });

  it('wires json exports correctly', () => {
    const { action, holder } = wireExportAction({
      name: 'exportJson',
      label: 'Export JSON',
      format: 'json',
    });
    action.run(
      { session: { id: 's1', csrfToken: 'c', data: {}, expiresAt: 9e12 }, path: '/admin' },
      [
        { id: '1', title: 'A' },
        { id: '2', title: 'B' },
      ],
    );
    const parsed = JSON.parse(holder.result!.content);
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0], { id: '1', title: 'A' });
  });
});
