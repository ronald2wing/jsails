/**
 * Schema autodetector: compares the schema materialized from a migration
 * history against a desired schema and emits the operations needed to reach it.
 *
 * The diff is conservative by design:
 * - destructive changes (drop table/column, type alterations, making a column
 *   required, primary key changes) require `allowDestructive`;
 * - column renames are never inferred from a drop+add pair; an explicit rename
 *   hint is required, otherwise the removal is treated as destructive;
 * - a required new column without a default on an existing table is rejected.
 */

import {
  type ColumnDefinition,
  MigrationError,
  type SchemaState,
  type TableDefinition,
  columnsEqual,
  normalizeSchemaState,
  validateIdentifier,
} from './schema-state.js';
import type { Operation } from './operations.js';
import {
  type MigrationDefinition,
  replayOrderedHistory,
  resolveMigrationOrder,
} from './history.js';

export interface ColumnRenameHint {
  table: string;
  from: string;
  to: string;
}

export interface AutodetectOptions {
  /** Permit destructive operations (drops, type/restrictive alterations). */
  allowDestructive?: boolean;
  /** Explicit column rename hints applied before add/drop detection. */
  renames?: ColumnRenameHint[];
}

function requireDestructive(options: AutodetectOptions, what: string): void {
  if (!options.allowDestructive) {
    throw new MigrationError(
      `destructive change rejected: ${what} (set allowDestructive to permit)`,
    );
  }
}

function validateAlteration(
  current: ColumnDefinition,
  desired: ColumnDefinition,
  options: AutodetectOptions,
  columnLabel: string,
): void {
  if (current.type !== desired.type) {
    requireDestructive(
      options,
      `changing type of ${columnLabel} from ${current.type} to ${desired.type}`,
    );
  }
  if (current.type === 'varchar' && current.length !== desired.length) {
    // Widening and narrowing both drop and recreate the column on postgres,
    // mysql, and mariadb, discarding its data; neither is a safe in-place change.
    requireDestructive(
      options,
      `changing varchar length of ${columnLabel} from ${String(current.length)} to ${String(desired.length)}`,
    );
  }
  if (current.nullable && !desired.nullable) {
    requireDestructive(options, `making ${columnLabel} non-nullable`);
  }
  if (Boolean(current.primaryKey) !== Boolean(desired.primaryKey)) {
    requireDestructive(options, `changing primary key status of ${columnLabel}`);
  }
}

interface RenameResolution {
  ops: Operation[];
  removedSet: Set<string>;
  addedSet: Set<string>;
}

function resolveRenames(
  tableName: string,
  currentColumns: Map<string, ColumnDefinition>,
  desiredColumns: Map<string, ColumnDefinition>,
  removed: ColumnDefinition[],
  added: ColumnDefinition[],
  options: AutodetectOptions,
): RenameResolution {
  const removedSet = new Set(removed.map((column) => column.name));
  const addedSet = new Set(added.map((column) => column.name));
  const ops: Operation[] = [];

  for (const hint of options.renames ?? []) {
    const table = validateIdentifier(hint.table);
    const from = validateIdentifier(hint.from);
    const to = validateIdentifier(hint.to);
    if (table !== tableName) {
      continue;
    }
    if (from === to) {
      throw new MigrationError(`rename hint for table "${table}" maps a column to itself`);
    }
    if (!removedSet.has(from)) {
      throw new MigrationError(
        `rename hint for table "${table}" references "${from}", which is not being removed`,
      );
    }
    if (!addedSet.has(to)) {
      throw new MigrationError(
        `rename hint for table "${table}" references "${to}", which is not being added`,
      );
    }

    const fromColumn = currentColumns.get(from) as ColumnDefinition;
    const toColumn = desiredColumns.get(to) as ColumnDefinition;
    ops.push({ kind: 'rename_column', table, from, to });

    const renamed = { ...fromColumn, name: to };
    if (!columnsEqual(renamed, toColumn)) {
      validateAlteration(renamed, toColumn, options, `${table}.${to}`);
      ops.push({ kind: 'alter_column', table, column: toColumn, previous: renamed });
    }

    removedSet.delete(from);
    addedSet.delete(to);
  }

  return { ops, removedSet, addedSet };
}

function diffTableColumns(
  tableName: string,
  current: TableDefinition,
  desired: TableDefinition,
  options: AutodetectOptions,
): Operation[] {
  const currentColumns = new Map(current.columns.map((column) => [column.name, column]));
  const desiredColumns = new Map(desired.columns.map((column) => [column.name, column]));

  const removed = current.columns.filter((column) => !desiredColumns.has(column.name));
  const added = desired.columns.filter((column) => !currentColumns.has(column.name));

  const { ops, removedSet, addedSet } = resolveRenames(
    tableName,
    currentColumns,
    desiredColumns,
    removed,
    added,
    options,
  );

  for (const column of removed) {
    if (!removedSet.has(column.name)) {
      continue; // consumed by a rename hint
    }
    if (!options.allowDestructive) {
      const plausibleRename = added.some(
        (addedColumn) => addedSet.has(addedColumn.name) && addedColumn.type === column.type,
      );
      if (plausibleRename) {
        throw new MigrationError(
          `ambiguous removal in table "${tableName}": column "${column.name}" was removed ` +
            `while a column of the same type was added; provide a rename hint or set allowDestructive`,
        );
      }
      requireDestructive(options, `dropping column ${tableName}.${column.name}`);
    }
    ops.push({ kind: 'drop_column', table: tableName, column });
  }

  for (const column of added) {
    if (!addedSet.has(column.name)) {
      continue; // consumed by a rename hint
    }
    if (!column.nullable && column.default === undefined) {
      throw new MigrationError(
        `cannot add required column "${tableName}.${column.name}" without a default ` +
          `to an existing table`,
      );
    }
    ops.push({ kind: 'add_column', table: tableName, column });
  }

  for (const column of current.columns) {
    const desiredColumn = desiredColumns.get(column.name);
    if (!desiredColumn || columnsEqual(column, desiredColumn)) {
      continue;
    }
    validateAlteration(column, desiredColumn, options, `${tableName}.${column.name}`);
    ops.push({ kind: 'alter_column', table: tableName, column: desiredColumn, previous: column });
  }

  return ops;
}

function diffSchemas(
  current: SchemaState,
  desired: SchemaState,
  options: AutodetectOptions,
): Operation[] {
  const currentTables = new Map(current.tables.map((table) => [table.name, table]));
  const desiredTables = new Map(desired.tables.map((table) => [table.name, table]));

  const tableNames = [
    ...new Set([
      ...current.tables.map((table) => table.name),
      ...desired.tables.map((table) => table.name),
    ]),
  ].sort();

  const operations: Operation[] = [];
  for (const tableName of tableNames) {
    const currentTable = currentTables.get(tableName);
    const desiredTable = desiredTables.get(tableName);
    if (currentTable && !desiredTable) {
      requireDestructive(options, `dropping table "${tableName}"`);
      operations.push({ kind: 'drop_table', table: currentTable });
    } else if (!currentTable && desiredTable) {
      operations.push({ kind: 'create_table', table: desiredTable });
    } else if (currentTable && desiredTable) {
      operations.push(...diffTableColumns(tableName, currentTable, desiredTable, options));
    }
  }
  return operations;
}

/**
 * Generate a migration that transforms the schema materialized from `history`
 * into `desiredSchema`. Returns `null` when the schemas are already equivalent.
 * The new migration depends on the last migration of the resolved chain (or
 * nothing when the history is empty), preserving the linear-chain invariant.
 */
export function generateMigration(
  name: string,
  history: MigrationDefinition[],
  desiredSchema: SchemaState,
  options: AutodetectOptions = {},
): MigrationDefinition | null {
  const migrationName = validateIdentifier(name);
  const desired = normalizeSchemaState(desiredSchema);
  const ordered = resolveMigrationOrder(history);
  const current = replayOrderedHistory(ordered);

  const operations = diffSchemas(current, desired, options);
  if (operations.length === 0) {
    return null;
  }

  const last = ordered[ordered.length - 1];
  const dependencies = last ? [last.name] : [];
  return { name: migrationName, dependencies, operations };
}
