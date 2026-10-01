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
  type ForeignKeyDefinition,
  type IndexDefinition,
  MigrationError,
  type SchemaState,
  type TableDefinition,
  type UniqueDefinition,
  checksEqual,
  columnsEqual,
  foreignKeysEqual,
  indexesEqual,
  inheritanceEqual,
  normalizeSchemaState,
  polymorphicEqual,
  uniquesEqual,
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

export interface TableRenameHint {
  from: string;
  to: string;
}

export interface AutodetectOptions {
  /** Permit destructive operations (drops, type/restrictive alterations). */
  allowDestructive?: boolean;
  /** Explicit column rename hints applied before add/drop detection. */
  renames?: ColumnRenameHint[];
  /** Explicit table rename hints applied before drop/create detection. */
  tableRenames?: TableRenameHint[];
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
  if (
    current.type === 'decimal' &&
    (current.precision !== desired.precision || current.scale !== desired.scale)
  ) {
    requireDestructive(
      options,
      `changing decimal precision/scale of ${columnLabel} from ` +
        `${String(current.precision)}/${String(current.scale ?? 'default')} to ` +
        `${String(desired.precision)}/${String(desired.scale ?? 'default')}`,
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
  /** Renamed columns (from -> to), used to reconcile index/unique references. */
  renameMap: Map<string, string>;
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
  const renameMap = new Map<string, string>();
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
    renameMap.set(from, to);

    const renamed = { ...fromColumn, name: to };
    if (!columnsEqual(renamed, toColumn)) {
      validateAlteration(renamed, toColumn, options, `${table}.${to}`);
      ops.push({ kind: 'alter_column', table, column: toColumn, previous: renamed });
    }

    removedSet.delete(from);
    addedSet.delete(to);
  }

  return { ops, removedSet, addedSet, renameMap };
}

interface ColumnDiffResult {
  ops: Operation[];
  renameMap: Map<string, string>;
}

function diffTableColumns(
  tableName: string,
  current: TableDefinition,
  desired: TableDefinition,
  options: AutodetectOptions,
): ColumnDiffResult {
  const currentColumns = new Map(current.columns.map((column) => [column.name, column]));
  const desiredColumns = new Map(desired.columns.map((column) => [column.name, column]));

  const removed = current.columns.filter((column) => !desiredColumns.has(column.name));
  const added = desired.columns.filter((column) => !currentColumns.has(column.name));

  const { ops, removedSet, addedSet, renameMap } = resolveRenames(
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

  return { ops, renameMap };
}

/** Rewrite a constraint's column list through a rename map (from -> to). */
function applyRenameMap(columns: string[], renameMap: ReadonlyMap<string, string>): string[] {
  return columns.map((column) => renameMap.get(column) ?? column);
}

interface ConstraintDiff {
  drops: Operation[];
  adds: Operation[];
}

/**
 * Diff a list of named column-list constraints (indexes or uniques) by name.
 * Removals and definition changes are destructive and require the opt-in; adds
 * are safe. Drops and adds are returned separately so the caller can order them
 * around column drops/adds: a constraint on a column must be dropped before the
 * column and added after the column.
 */
function diffConstraints<T extends { name: string; columns: string[] }>(
  tableName: string,
  what: string,
  current: T[],
  desired: T[],
  renameMap: ReadonlyMap<string, string>,
  equal: (a: T, b: T) => boolean,
  makeOperation: (constraint: T, drop: boolean) => Operation,
  options: AutodetectOptions,
): ConstraintDiff {
  const currentByName = new Map(current.map((constraint) => [constraint.name, constraint]));
  const desiredByName = new Map(desired.map((constraint) => [constraint.name, constraint]));

  const drops: Operation[] = [];
  const adds: Operation[] = [];

  for (const constraint of current) {
    if (!desiredByName.has(constraint.name)) {
      requireDestructive(options, `dropping ${what} ${tableName}.${constraint.name}`);
      drops.push(makeOperation(constraint, true));
    }
  }

  for (const constraint of desired) {
    if (!currentByName.has(constraint.name)) {
      adds.push(makeOperation(constraint, false));
    }
  }

  for (const constraint of current) {
    const desiredConstraint = desiredByName.get(constraint.name);
    if (desiredConstraint === undefined) {
      continue; // already handled as a removal
    }
    const reconciled = { ...constraint, columns: applyRenameMap(constraint.columns, renameMap) };
    if (!equal(reconciled, desiredConstraint)) {
      requireDestructive(options, `changing ${what} ${tableName}.${constraint.name}`);
      drops.push(makeOperation(constraint, true));
      adds.push(makeOperation(desiredConstraint, false));
    }
  }

  return { drops, adds };
}

interface TableDiff {
  ops: Operation[];
  renameMap: Map<string, string>;
}

/**
 * Diff two tables by columns, indexes, uniques, and the inheritance descriptor.
 * Table-level metadata `primaryKeyName` is NOT compared: it is a driver hint,
 * not a structural change. A change to the inheritance descriptor (e.g. a new
 * discriminator value when a child entity is added) emits an `alter_inheritance`
 * operation, which carries no DDL but keeps replay equal to the desired state.
 */
function diffTable(
  tableName: string,
  current: TableDefinition,
  desired: TableDefinition,
  options: AutodetectOptions,
): TableDiff {
  const { ops: columnOps, renameMap } = diffTableColumns(tableName, current, desired, options);

  const indexDiff = diffConstraints<IndexDefinition>(
    tableName,
    'index',
    current.indexes ?? [],
    desired.indexes ?? [],
    renameMap,
    indexesEqual,
    (constraint, drop) =>
      drop
        ? { kind: 'drop_index', table: tableName, index: constraint }
        : { kind: 'add_index', table: tableName, index: constraint },
    options,
  );

  const uniqueDiff = diffConstraints<UniqueDefinition>(
    tableName,
    'unique constraint',
    current.uniques ?? [],
    desired.uniques ?? [],
    renameMap,
    uniquesEqual,
    (constraint, drop) =>
      drop
        ? { kind: 'drop_unique', table: tableName, unique: constraint }
        : { kind: 'add_unique', table: tableName, unique: constraint },
    options,
  );

  // Check constraints are diffed by name. Drops are destructive; adds are safe.
  const currentChecksByName = new Map((current.checks ?? []).map((check) => [check.name, check]));
  const desiredChecksByName = new Map((desired.checks ?? []).map((check) => [check.name, check]));
  const checkDrops: Operation[] = [];
  const checkAdds: Operation[] = [];
  for (const check of current.checks ?? []) {
    if (!desiredChecksByName.has(check.name)) {
      requireDestructive(options, `dropping check ${tableName}.${check.name}`);
      checkDrops.push({ kind: 'drop_check', table: tableName, check });
    }
  }
  for (const check of desired.checks ?? []) {
    if (!currentChecksByName.has(check.name)) {
      checkAdds.push({ kind: 'add_check', table: tableName, check });
    }
  }
  for (const check of current.checks ?? []) {
    const desiredCheck = desiredChecksByName.get(check.name);
    if (desiredCheck === undefined) {
      continue;
    }
    if (!checksEqual(check, desiredCheck)) {
      requireDestructive(options, `changing check ${tableName}.${check.name}`);
      checkDrops.push({ kind: 'drop_check', table: tableName, check });
      checkAdds.push({ kind: 'add_check', table: tableName, check: desiredCheck });
    }
  }

  // Constraints must be dropped before their columns and added after them, so a
  // constraint on a renamed/dropped/added column is never dangling.
  const ops: Operation[] = [
    ...indexDiff.drops,
    ...uniqueDiff.drops,
    ...checkDrops,
    ...columnOps,
    ...indexDiff.adds,
    ...uniqueDiff.adds,
    ...checkAdds,
  ];

  // A discriminator-value change (e.g. a new child entity) needs no DDL, but the
  // descriptor is part of the schema state, so replay must reconstruct it.
  if (!inheritanceEqual(current.inheritance, desired.inheritance)) {
    ops.push({
      kind: 'alter_inheritance',
      table: tableName,
      inheritance: desired.inheritance,
      previous: current.inheritance,
    });
  }

  // A polymorphic-target set change (e.g. a new target table) needs no DDL,
  // but the descriptor is part of the schema state, so replay must reconstruct it.
  if (!polymorphicEqual(current.polymorphic, desired.polymorphic)) {
    ops.push({
      kind: 'alter_polymorphic',
      table: tableName,
      polymorphic: desired.polymorphic,
      previous: current.polymorphic,
    });
  }

  return { ops, renameMap };
}

/** A table definition with its foreign keys removed (for inline `create_table`). */
function stripForeignKeys(table: TableDefinition): TableDefinition {
  if (table.foreignKeys === undefined) {
    return table;
  }
  const stripped: TableDefinition = { name: table.name, columns: table.columns };
  if (table.indexes) {
    stripped.indexes = table.indexes;
  }
  if (table.uniques) {
    stripped.uniques = table.uniques;
  }
  if (table.primaryKeyName !== undefined) {
    stripped.primaryKeyName = table.primaryKeyName;
  }
  if (table.inheritance !== undefined) {
    stripped.inheritance = table.inheritance;
  }
  if (table.polymorphic !== undefined) {
    stripped.polymorphic = table.polymorphic;
  }
  if (table.checks) {
    stripped.checks = table.checks;
  }
  return stripped;
}

/**
 * Rewrite a foreign key's column references through the rename maps: local
 * columns through the owner table's map, referenced columns through the
 * referenced table's map, and the referenced table name through the table
 * rename map. A rename elsewhere must not surface as a spurious FK definition
 * change.
 */
function reconcileForeignKey(
  foreignKey: ForeignKeyDefinition,
  ownerTable: string,
  renameMaps: ReadonlyMap<string, ReadonlyMap<string, string>>,
  tableRenameMap: ReadonlyMap<string, string>,
): ForeignKeyDefinition {
  const localMap = renameMaps.get(ownerTable);
  const referencedTable =
    tableRenameMap.get(foreignKey.referencedTable) ?? foreignKey.referencedTable;
  const referencedMap = renameMaps.get(referencedTable);
  const columns = foreignKey.columns.map((column) => localMap?.get(column) ?? column);
  const referencedColumns = foreignKey.referencedColumns.map(
    (column) => referencedMap?.get(column) ?? column,
  );
  const tableRefChanged = referencedTable !== foreignKey.referencedTable;
  // Compare every column — a rename of any column in a composite FK must be
  // reflected, not just the first one.
  const columnsChanged = columns.some((c, i) => c !== foreignKey.columns[i]);
  const referencedChanged = referencedColumns.some((c, i) => c !== foreignKey.referencedColumns[i]);
  if (!columnsChanged && !referencedChanged && !tableRefChanged) {
    return foreignKey;
  }
  const result: ForeignKeyDefinition = { ...foreignKey, columns, referencedColumns };
  if (tableRefChanged) {
    result.referencedTable = referencedTable;
  }
  return result;
}

interface ForeignKeyDiff {
  drops: Operation[];
  adds: Operation[];
}

/**
 * Diff foreign keys across the whole schema. Drops (and drop+re-add definition
 * changes) are destructive; adds are safe. FKs are identified by name within
 * their owning table.
 */
function diffForeignKeys(
  current: SchemaState,
  desired: SchemaState,
  renameMaps: ReadonlyMap<string, ReadonlyMap<string, string>>,
  tableRenameMap: ReadonlyMap<string, string>,
  options: AutodetectOptions,
): ForeignKeyDiff {
  const desiredTables = new Map(desired.tables.map((table) => [table.name, table]));
  const currentTables = new Map(current.tables.map((table) => [table.name, table]));

  const drops: Operation[] = [];
  const adds: Operation[] = [];

  for (const table of current.tables) {
    const desiredFks = new Map(
      (desiredTables.get(table.name)?.foreignKeys ?? []).map((fk) => [fk.name, fk]),
    );
    for (const foreignKey of table.foreignKeys ?? []) {
      const desiredFk = desiredFks.get(foreignKey.name);
      if (desiredFk === undefined) {
        requireDestructive(options, `dropping foreign key ${table.name}.${foreignKey.name}`);
        drops.push({ kind: 'drop_fk', table: table.name, foreignKey });
      } else if (
        !foreignKeysEqual(
          reconcileForeignKey(foreignKey, table.name, renameMaps, tableRenameMap),
          desiredFk,
        )
      ) {
        requireDestructive(options, `changing foreign key ${table.name}.${foreignKey.name}`);
        drops.push({ kind: 'drop_fk', table: table.name, foreignKey });
        adds.push({ kind: 'add_fk', table: table.name, foreignKey: desiredFk });
      }
    }
  }

  for (const table of desired.tables) {
    const currentNames = new Set(
      (currentTables.get(table.name)?.foreignKeys ?? []).map((fk) => fk.name),
    );
    for (const foreignKey of table.foreignKeys ?? []) {
      if (!currentNames.has(foreignKey.name)) {
        adds.push({ kind: 'add_fk', table: table.name, foreignKey });
      }
    }
  }

  return { drops, adds };
}

function resolveTableRenames(
  current: SchemaState,
  desired: SchemaState,
  options: AutodetectOptions,
): Map<string, string> {
  const currentNames = new Set(current.tables.map((table) => table.name));
  const desiredNames = new Set(desired.tables.map((table) => table.name));
  const tableRenameMap = new Map<string, string>();

  for (const hint of options.tableRenames ?? []) {
    const from = validateIdentifier(hint.from);
    const to = validateIdentifier(hint.to);
    if (from === to) {
      throw new MigrationError(`table rename hint maps "${from}" to itself`);
    }
    if (!currentNames.has(from)) {
      throw new MigrationError(
        `table rename hint references "${from}", which is not in the current schema`,
      );
    }
    if (!desiredNames.has(to)) {
      throw new MigrationError(
        `table rename hint references "${to}", which is not in the desired schema`,
      );
    }
    tableRenameMap.set(from, to);
  }

  return tableRenameMap;
}

function diffSchemas(
  current: SchemaState,
  desired: SchemaState,
  options: AutodetectOptions,
): Operation[] {
  const currentTables = new Map(current.tables.map((table) => [table.name, table]));
  const desiredTables = new Map(desired.tables.map((table) => [table.name, table]));
  const tableRenameMap = resolveTableRenames(current, desired, options);
  const renamedTo = new Set(tableRenameMap.values());

  const tableNames = [
    ...new Set([
      ...current.tables.map((table) => table.name),
      ...desired.tables.map((table) => table.name),
    ]),
  ].sort();

  // Structural (table/column/index/unique) changes, without foreign keys, so
  // foreign keys can be dropped before any referenced table/column disappears
  // and added after every referenced table/column exists.
  const structuralOps: Operation[] = [];
  const renameMaps = new Map<string, ReadonlyMap<string, string>>();
  for (const tableName of tableNames) {
    const currentTable = currentTables.get(tableName);
    const desiredTable = desiredTables.get(tableName);
    if (currentTable && !desiredTable) {
      const renameTo = tableRenameMap.get(tableName);
      if (renameTo !== undefined) {
        const desiredRenamed = desiredTables.get(renameTo) as TableDefinition;
        structuralOps.push({ kind: 'rename_table', from: tableName, to: renameTo });
        const renamed: TableDefinition = { ...currentTable, name: renameTo };
        const { ops, renameMap } = diffTable(renameTo, renamed, desiredRenamed, options);
        structuralOps.push(...ops);
        renameMaps.set(tableName, renameMap);
        renameMaps.set(renameTo, renameMap);
      } else {
        requireDestructive(options, `dropping table "${tableName}"`);
        structuralOps.push({ kind: 'drop_table', table: currentTable });
        renameMaps.set(tableName, new Map());
      }
    } else if (!currentTable && desiredTable) {
      if (renamedTo.has(tableName)) {
        // Consumed by a rename hint; the old name's branch already emitted the diff.
        continue;
      }
      structuralOps.push({ kind: 'create_table', table: stripForeignKeys(desiredTable) });
      renameMaps.set(tableName, new Map());
    } else if (currentTable && desiredTable) {
      const { ops, renameMap } = diffTable(tableName, currentTable, desiredTable, options);
      structuralOps.push(...ops);
      renameMaps.set(tableName, renameMap);
    }
  }

  const { drops: fkDrops, adds: fkAdds } = diffForeignKeys(
    current,
    desired,
    renameMaps,
    tableRenameMap,
    options,
  );

  return [...fkDrops, ...structuralOps, ...fkAdds];
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
