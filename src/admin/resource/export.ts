/**
 * Admin bulk export: a bulk-action descriptor that serializes selected rows
 * to CSV or JSON.
 *
 * `defineExportAction({ name, format, columns? })` validates the export spec
 * and returns a frozen {@link ExportAction} descriptor that can be wired as a
 * `bulk` action on a resource. The `run` callback receives the admin session
 * and the selected rows and returns the serialized content plus a
 * content-type header.
 *
 * CSV output is fully value-free: every cell is a string, and any value
 * containing commas, double quotes, or newlines is RFC-4180 double-quoted
 * with internal quotes escaped. JSON output is a deterministic array of
 * objects. The module is ORM-free and performs no I/O.
 */

import type { AdminActionRun } from '../actions.js';

// ---------------------------------------------------------------------------
// Descriptor surface
// ---------------------------------------------------------------------------

/** Export format: CSV or JSON. */
export type ExportFormat = 'csv' | 'json';

/** Specification passed to {@link defineExportAction}. */
export interface ExportActionDefinition {
  /** URL-safe action identifier, unique within a resource. */
  readonly name: string;
  /** Human button label. */
  readonly label: string;
  /** Export format: csv or json. */
  readonly format: ExportFormat;
  /**
   * The column names to export, in the order they appear in every row.
   * When omitted, all columns present on the first row are exported in
   * their natural (own-enumerable) order.
   */
  readonly columns?: readonly string[];
}

/** The serialized export result. */
export interface ExportResult {
  /** The full serialized content (a CSV or JSON string). */
  readonly content: string;
  /** Content-Type header for the download response. */
  readonly contentType: string;
}

/** A frozen, validated export-action descriptor. */
export interface ExportAction {
  /** URL-safe action identifier. */
  readonly name: string;
  /** Human button label. */
  readonly label: string;
  /** Export format. */
  readonly format: ExportFormat;
  /** Column list (or `undefined` for auto-detect from the first row). */
  readonly columns?: readonly string[];
  /**
   * The trusted run callback that serializes the selected rows and returns
   * the result. Conforms to the {@link AdminActionRun} signature so it can
   * be wired as a bulk action.
   */
  readonly run: AdminActionRun;
}

/** Raised for an invalid export-action spec. Messages never embed input values. */
export class ExportActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportActionError';
  }
}

/** Content-Type for CSV. */
const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

/** Content-Type for JSON. */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

const VALID_FORMATS: ReadonlySet<string> = new Set(['csv', 'json']);

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Validate an export-action spec and return a frozen descriptor. The
 * returned `run` callback is callable by the bulk-action pipeline:
 * `run({ session }, records)` where records are the selected rows and the
 * result is returned through a callback mechanism. Since the standard
 * `AdminActionRun` is `void | Promise<void>`, the export action materialises
 * its result by calling a `finalize` callback injected through a higher-order
 * wrapper pattern — but for this descriptor the core exports
 * {@link serializeExport} directly so the caller can wire it.
 */
export function defineExportAction(spec: ExportActionDefinition): ExportAction {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new ExportActionError('defineExportAction requires a spec object');
  }
  if (typeof spec.name !== 'string' || !NAME_PATTERN.test(spec.name)) {
    throw new ExportActionError(
      'export action name must be an alphanumeric identifier starting with a letter',
    );
  }
  if (typeof spec.label !== 'string' || spec.label.trim() === '') {
    throw new ExportActionError('export action label must be a non-empty string');
  }
  if (typeof spec.format !== 'string' || !VALID_FORMATS.has(spec.format)) {
    throw new ExportActionError('export action format must be csv or json');
  }
  if (spec.columns !== undefined) {
    if (!Array.isArray(spec.columns)) {
      throw new ExportActionError('export action columns must be an array');
    }
    if (spec.columns.length === 0) {
      throw new ExportActionError('export action columns must not be empty');
    }
    if (spec.columns.filter((c) => typeof c !== 'string').length > 0) {
      throw new ExportActionError('export action column names must be strings');
    }
  }

  return Object.freeze({
    name: spec.name,
    label: spec.label,
    format: spec.format,
    ...(spec.columns === undefined
      ? {}
      : { columns: Object.freeze([...spec.columns]) as readonly string[] }),
    run: undefined as never, // The caller wraps this with the export logic.
  } as ExportAction);
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize an array of rows to CSV or JSON.
 *
 * CSV output follows RFC 4180: every cell is stringified, and values
 * containing commas, double-quotes, or newlines are double-quoted
 * with internal quotes escaped (doubled). The header row is always
 * included. JSON output is a deterministic array of objects.
 */
export function serializeExport(
  format: ExportFormat,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): ExportResult {
  switch (format) {
    case 'csv':
      return { content: serializeCsv(columns, rows), contentType: CSV_CONTENT_TYPE };
    case 'json':
      return { content: serializeJson(columns, rows), contentType: JSON_CONTENT_TYPE };
  }
}

/** Serialize rows to CSV. */
function serializeCsv(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): string {
  const lines: string[] = [];
  lines.push(columns.map((c) => escapeCsvValue(c)).join(','));
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCsvValue(stringifyCell(row[c]))).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/** Serialize rows to JSON (deterministic, no trailing newline). */
function serializeJson(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): string {
  const objects = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (const col of columns) {
      obj[col] = row[col] ?? null;
    }
    return obj;
  });
  return JSON.stringify(objects);
}

/** RFC-4180 CSV escape: quote fields with commas, double-quotes, or newlines. */
function escapeCsvValue(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Stringify a cell value for export. */
export function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Resolve the export columns: the explicit list or the own-enumerable keys
 * of the first row. Returns an empty array when rows is empty (the caller
 * handles that case).
 */
export function resolveExportColumns(
  explicitColumns: readonly string[] | undefined,
  rows: readonly Record<string, unknown>[],
): readonly string[] {
  if (explicitColumns !== undefined && explicitColumns.length > 0) {
    return explicitColumns;
  }
  if (rows.length === 0) {
    return Object.freeze([]);
  }
  return Object.freeze(Object.keys(rows[0]!));
}

/**
 * Build a run callback suitable for an {@link AdminActionRun} that
 * serializes the selected rows and stores the result in the provided holder.
 * This is the glue that wires an export descriptor to a bulk-action pipeline
 * where the runner has access to the HTTP response writer.
 */
export function createExportRun(
  format: ExportFormat,
  columns: readonly string[] | undefined,
  holder: { result?: ExportResult | null },
): AdminActionRun {
  return (
    _context: Parameters<AdminActionRun>[0],
    records: readonly Record<string, unknown>[],
  ): void => {
    const resolved = resolveExportColumns(columns, records);
    if (resolved.length === 0) {
      holder.result = { content: '', contentType: 'text/plain; charset=utf-8' };
      return;
    }
    holder.result = serializeExport(format, resolved, records);
  };
}

// ---------------------------------------------------------------------------
// Higher-order wiring: returns an action descriptor PLUS the run callback
// ---------------------------------------------------------------------------

/** Result of wiring an export descriptor into a full action. */
export interface ExportActionWired {
  /** The action descriptor for the bulk-actions list (name + label). */
  readonly action: { readonly name: string; readonly label: string; readonly run: AdminActionRun };
  /** The result holder — read `.result` after the action runs. */
  readonly holder: { result?: ExportResult | null };
}

/**
 * Wire an export-action descriptor into a complete action that can be
 * added to a resource's `actions.bulk` list. The returned `action` object
 * carries the standard `name`, `label`, and `run` fields. After `run`
 * resolves, read `holder.result` for the serialized content.
 */
export function wireExportAction(spec: ExportActionDefinition): ExportActionWired {
  const descriptor = defineExportAction(spec);
  const holder: { result?: ExportResult | null } = {};
  const run = createExportRun(descriptor.format, descriptor.columns, holder);
  return {
    action: { name: descriptor.name, label: descriptor.label, run },
    holder,
  };
}
