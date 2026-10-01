/**
 * Migration operations: the unit of change applied to a {@link SchemaState}.
 *
 * Every operation carries enough information to be inverted: destructive
 * operations retain the previous definition (the full table or column they
 * remove), and `alter_column` retains both the old and new column definitions.
 */

import {
  type CheckDefinition,
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
  normalizeCheck,
  normalizeColumn,
  normalizeForeignKey,
  normalizeIndex,
  normalizeInheritance,
  normalizePolymorphic,
  normalizeTable,
  normalizeUnique,
  polymorphicEqual,
  tablesEqual,
  uniquesEqual,
  validateIdentifier,
} from './schema-state.js';

export interface CreateTableOperation {
  kind: 'create_table';
  table: TableDefinition;
}

export interface DropTableOperation {
  kind: 'drop_table';
  /** Full definition retained so the drop can be inverted. */
  table: TableDefinition;
}

export interface AddColumnOperation {
  kind: 'add_column';
  table: string;
  column: ColumnDefinition;
}

export interface DropColumnOperation {
  kind: 'drop_column';
  table: string;
  /** Full definition retained so the drop can be inverted. */
  column: ColumnDefinition;
}

export interface RenameColumnOperation {
  kind: 'rename_column';
  table: string;
  from: string;
  to: string;
}

export interface RenameTableOperation {
  kind: 'rename_table';
  from: string;
  to: string;
}

export interface AlterColumnOperation {
  kind: 'alter_column';
  table: string;
  /** New definition. */
  column: ColumnDefinition;
  /** Previous definition, retained so the alteration can be inverted. */
  previous: ColumnDefinition;
}

/**
 * Change a table's single-table-inheritance descriptor. This is metadata-only:
 * the discriminator column is a physical column managed by column operations,
 * so no DDL is emitted. The operation exists so replay reconstructs the
 * descriptor (e.g. a new child's discriminator value) exactly.
 */
export interface AlterInheritanceOperation {
  kind: 'alter_inheritance';
  table: string;
  /** New descriptor, or undefined to remove inheritance metadata. */
  inheritance: TableDefinition['inheritance'];
  /** Previous descriptor, retained so the alteration can be inverted. */
  previous: TableDefinition['inheritance'];
}

/**
 * Change a table's polymorphic-relation descriptor. This is metadata-only:
 * the type and id columns are physical columns managed by column operations,
 * so no DDL is emitted. The operation exists so replay reconstructs the
 * descriptor (e.g. a new polymorphic target) exactly.
 */
export interface AlterPolymorphicOperation {
  kind: 'alter_polymorphic';
  table: string;
  /** New descriptor, or undefined to remove polymorphic metadata. */
  polymorphic: TableDefinition['polymorphic'];
  /** Previous descriptor, retained so the alteration can be inverted. */
  previous: TableDefinition['polymorphic'];
}

export interface AddIndexOperation {
  kind: 'add_index';
  table: string;
  index: IndexDefinition;
}

export interface DropIndexOperation {
  kind: 'drop_index';
  table: string;
  /** Full definition retained so the drop can be inverted. */
  index: IndexDefinition;
}

export interface AddUniqueOperation {
  kind: 'add_unique';
  table: string;
  unique: UniqueDefinition;
}

export interface DropUniqueOperation {
  kind: 'drop_unique';
  table: string;
  /** Full definition retained so the drop can be inverted. */
  unique: UniqueDefinition;
}

export interface AddForeignKeyOperation {
  kind: 'add_fk';
  table: string;
  foreignKey: ForeignKeyDefinition;
}

export interface DropForeignKeyOperation {
  kind: 'drop_fk';
  table: string;
  /** Full definition retained so the drop can be inverted. */
  foreignKey: ForeignKeyDefinition;
}

export interface AddCheckOperation {
  kind: 'add_check';
  table: string;
  check: CheckDefinition;
}

export interface DropCheckOperation {
  kind: 'drop_check';
  table: string;
  /** Full definition retained so the drop can be inverted. */
  check: CheckDefinition;
}

export type Operation =
  | CreateTableOperation
  | DropTableOperation
  | AddColumnOperation
  | DropColumnOperation
  | RenameColumnOperation
  | RenameTableOperation
  | AlterColumnOperation
  | AlterInheritanceOperation
  | AlterPolymorphicOperation
  | AddIndexOperation
  | DropIndexOperation
  | AddUniqueOperation
  | DropUniqueOperation
  | AddForeignKeyOperation
  | DropForeignKeyOperation
  | AddCheckOperation
  | DropCheckOperation;

/**
 * Runtime-validate an operation from untrusted data (e.g. migration JSON) and
 * return a normalized copy. Rejects unknown operation types and malformed
 * definitions.
 */
export function validateOperation(op: unknown): Operation {
  if (typeof op !== 'object' || op === null) {
    throw new MigrationError('operation must be an object');
  }
  const o = op as Record<string, unknown>;
  switch (o.kind) {
    case 'create_table':
      return { kind: 'create_table', table: normalizeTable(o.table as TableDefinition) };
    case 'drop_table':
      return { kind: 'drop_table', table: normalizeTable(o.table as TableDefinition) };
    case 'add_column':
      return {
        kind: 'add_column',
        table: validateIdentifier(o.table),
        column: normalizeColumn(o.column as ColumnDefinition),
      };
    case 'drop_column':
      return {
        kind: 'drop_column',
        table: validateIdentifier(o.table),
        column: normalizeColumn(o.column as ColumnDefinition),
      };
    case 'rename_column':
      return {
        kind: 'rename_column',
        table: validateIdentifier(o.table),
        from: validateIdentifier(o.from),
        to: validateIdentifier(o.to),
      };
    case 'alter_column':
      return {
        kind: 'alter_column',
        table: validateIdentifier(o.table),
        column: normalizeColumn(o.column as ColumnDefinition),
        previous: normalizeColumn(o.previous as ColumnDefinition),
      };
    case 'alter_inheritance':
      return {
        kind: 'alter_inheritance',
        table: validateIdentifier(o.table),
        inheritance: normalizeInheritance(o.inheritance, String(o.table)),
        previous: normalizeInheritance(o.previous, String(o.table)),
      };
    case 'alter_polymorphic':
      return {
        kind: 'alter_polymorphic',
        table: validateIdentifier(o.table),
        polymorphic: normalizePolymorphic(o.polymorphic, String(o.table)),
        previous: normalizePolymorphic(o.previous, String(o.table)),
      };
    case 'add_index':
      return {
        kind: 'add_index',
        table: validateIdentifier(o.table),
        index: normalizeIndex(o.index as IndexDefinition),
      };
    case 'drop_index':
      return {
        kind: 'drop_index',
        table: validateIdentifier(o.table),
        index: normalizeIndex(o.index as IndexDefinition),
      };
    case 'add_unique':
      return {
        kind: 'add_unique',
        table: validateIdentifier(o.table),
        unique: normalizeUnique(o.unique as UniqueDefinition),
      };
    case 'drop_unique':
      return {
        kind: 'drop_unique',
        table: validateIdentifier(o.table),
        unique: normalizeUnique(o.unique as UniqueDefinition),
      };
    case 'rename_table':
      return {
        kind: 'rename_table',
        from: validateIdentifier(o.from),
        to: validateIdentifier(o.to),
      };
    case 'add_fk':
      return {
        kind: 'add_fk',
        table: validateIdentifier(o.table),
        foreignKey: normalizeForeignKey(o.foreignKey as ForeignKeyDefinition),
      };
    case 'drop_fk':
      return {
        kind: 'drop_fk',
        table: validateIdentifier(o.table),
        foreignKey: normalizeForeignKey(o.foreignKey as ForeignKeyDefinition),
      };
    case 'add_check':
      return {
        kind: 'add_check',
        table: validateIdentifier(o.table),
        check: normalizeCheck(o.check as CheckDefinition),
      };
    case 'drop_check':
      return {
        kind: 'drop_check',
        table: validateIdentifier(o.table),
        check: normalizeCheck(o.check as CheckDefinition),
      };
    default:
      throw new MigrationError(`unknown operation type: ${JSON.stringify(o.kind)}`);
  }
}

function findTable(state: SchemaState, name: string): TableDefinition | undefined {
  return state.tables.find((table) => table.name === name);
}

function replaceTable(state: SchemaState, index: number, table: TableDefinition): SchemaState {
  const tables = state.tables.slice();
  tables[index] = table;
  return { tables };
}

/** Every index/unique column must name a real column of the table at apply time. */
function assertConstraintColumnsExist(
  table: TableDefinition,
  constraint: { name: string; columns: string[] },
  kind: string,
): void {
  const columnNames = new Set(table.columns.map((column) => column.name));
  for (const column of constraint.columns) {
    if (!columnNames.has(column)) {
      throw new MigrationError(
        `${kind} "${constraint.name}" in table "${table.name}" references unknown column "${column}"`,
      );
    }
  }
}

/**
 * Apply a single operation to a schema state, returning a new state. The input
 * is never mutated. Preconditions (existence, uniqueness, recorded-definition
 * agreement) are validated and throw {@link MigrationError} on violation.
 */
export function applyOperation(state: SchemaState, op: Operation): SchemaState {
  switch (op.kind) {
    case 'create_table': {
      if (findTable(state, op.table.name)) {
        throw new MigrationError(`cannot create table "${op.table.name}": it already exists`);
      }
      return { tables: [...state.tables, normalizeTable(op.table)] };
    }
    case 'drop_table': {
      const index = state.tables.findIndex((table) => table.name === op.table.name);
      if (index === -1) {
        throw new MigrationError(`cannot drop table "${op.table.name}": it does not exist`);
      }
      const current = state.tables[index] as TableDefinition;
      if (!tablesEqual(current, op.table)) {
        throw new MigrationError(
          `cannot drop table "${op.table.name}": recorded definition does not match state`,
        );
      }
      return { tables: state.tables.filter((_, i) => i !== index) };
    }
    case 'add_column': {
      const index = state.tables.findIndex((table) => table.name === op.table);
      if (index === -1) {
        throw new MigrationError(`cannot add column to table "${op.table}": it does not exist`);
      }
      const table = state.tables[index] as TableDefinition;
      if (table.columns.some((column) => column.name === op.column.name)) {
        throw new MigrationError(
          `cannot add column "${op.column.name}" to table "${op.table}": it already exists`,
        );
      }
      const column = normalizeColumn(op.column);
      return replaceTable(state, index, { ...table, columns: [...table.columns, column] });
    }
    case 'drop_column': {
      const index = state.tables.findIndex((table) => table.name === op.table);
      if (index === -1) {
        throw new MigrationError(`cannot drop column from table "${op.table}": it does not exist`);
      }
      const table = state.tables[index] as TableDefinition;
      const columnIndex = table.columns.findIndex((column) => column.name === op.column.name);
      if (columnIndex === -1) {
        throw new MigrationError(
          `cannot drop column "${op.column.name}" from table "${op.table}": it does not exist`,
        );
      }
      const current = table.columns[columnIndex] as ColumnDefinition;
      if (!columnsEqual(current, op.column)) {
        throw new MigrationError(
          `cannot drop column "${op.column.name}" from table "${op.table}": recorded definition does not match state`,
        );
      }
      return replaceTable(state, index, {
        ...table,
        columns: table.columns.filter((_, i) => i !== columnIndex),
      });
    }
    case 'rename_column': {
      const index = state.tables.findIndex((table) => table.name === op.table);
      if (index === -1) {
        throw new MigrationError(`cannot rename column in table "${op.table}": it does not exist`);
      }
      const table = state.tables[index] as TableDefinition;
      if (!table.columns.some((column) => column.name === op.from)) {
        throw new MigrationError(
          `cannot rename column "${op.from}" in table "${op.table}": it does not exist`,
        );
      }
      if (table.columns.some((column) => column.name === op.to)) {
        throw new MigrationError(
          `cannot rename column to "${op.to}" in table "${op.table}": it already exists`,
        );
      }
      const columns = table.columns.map((column) =>
        column.name === op.from ? { ...column, name: op.to } : column,
      );
      // A rename also rewrites any index/unique reference to the old name so the
      // constraints keep pointing at the same physical column.
      const renameIn = <T extends { columns: string[] }>(constraint: T): T => ({
        ...constraint,
        columns: constraint.columns.map((column) => (column === op.from ? op.to : column)),
      });
      // A foreign key's local columns live on this table; its referenced columns
      // live on whatever table it points at, so the referenced side is rewritten
      // across the whole schema below.
      const renamed: TableDefinition = { ...table, columns };
      if (table.indexes) {
        renamed.indexes = table.indexes.map(renameIn);
      }
      if (table.uniques) {
        renamed.uniques = table.uniques.map(renameIn);
      }
      if (table.foreignKeys) {
        renamed.foreignKeys = table.foreignKeys.map((foreignKey) => renameIn(foreignKey));
      }
      // Cross-table: any foreign key on another table referencing this table's
      // renamed column must follow the rename. The renamed table itself replaces
      // its previous definition (carrying the rewritten constraints).
      const tables = state.tables.map((other, otherIndex) => {
        if (otherIndex === index) {
          return renamed;
        }
        if (other.foreignKeys === undefined) {
          return other;
        }
        const foreignKeys = other.foreignKeys.map((foreignKey) =>
          foreignKey.referencedTable === op.table
            ? {
                ...foreignKey,
                referencedColumns: foreignKey.referencedColumns.map((column) =>
                  column === op.from ? op.to : column,
                ),
              }
            : foreignKey,
        );
        return { ...other, foreignKeys };
      });
      return { tables };
    }
    case 'rename_table': {
      if (op.from === op.to) {
        throw new MigrationError(`cannot rename table "${op.from}" to itself`);
      }
      const index = state.tables.findIndex((table) => table.name === op.from);
      if (index === -1) {
        throw new MigrationError(`cannot rename table "${op.from}": it does not exist`);
      }
      if (findTable(state, op.to)) {
        throw new MigrationError(`cannot rename table to "${op.to}": it already exists`);
      }
      const source = state.tables[index] as TableDefinition;
      const renamed: TableDefinition = { ...source, name: op.to };
      // Rewrite every foreign key referencing the old table name across all tables.
      const tables = state.tables.map((other, otherIndex) => {
        if (otherIndex === index) {
          return renamed;
        }
        if (other.foreignKeys === undefined) {
          return other;
        }
        const foreignKeys = other.foreignKeys.map((foreignKey) =>
          foreignKey.referencedTable === op.from
            ? { ...foreignKey, referencedTable: op.to }
            : foreignKey,
        );
        return { ...other, foreignKeys };
      });
      return { tables };
    }
    case 'alter_column': {
      const index = state.tables.findIndex((table) => table.name === op.table);
      if (index === -1) {
        throw new MigrationError(`cannot alter column in table "${op.table}": it does not exist`);
      }
      const table = state.tables[index] as TableDefinition;
      const columnIndex = table.columns.findIndex((column) => column.name === op.column.name);
      if (columnIndex === -1) {
        throw new MigrationError(
          `cannot alter column "${op.column.name}" in table "${op.table}": it does not exist`,
        );
      }
      const current = table.columns[columnIndex] as ColumnDefinition;
      if (!columnsEqual(current, op.previous)) {
        throw new MigrationError(
          `cannot alter column "${op.column.name}" in table "${op.table}": previous definition does not match state`,
        );
      }
      const columns = table.columns.slice();
      columns[columnIndex] = normalizeColumn(op.column);
      return replaceTable(state, index, { ...table, columns });
    }
    case 'alter_inheritance': {
      const index = state.tables.findIndex((table) => table.name === op.table);
      if (index === -1) {
        throw new MigrationError(
          `cannot alter inheritance on table "${op.table}": it does not exist`,
        );
      }
      const table = state.tables[index] as TableDefinition;
      if (!inheritanceEqual(table.inheritance, op.previous)) {
        throw new MigrationError(
          `cannot alter inheritance on table "${op.table}": previous descriptor does not match state`,
        );
      }
      const updated: TableDefinition = { ...table };
      if (op.inheritance === undefined) {
        delete updated.inheritance;
      } else {
        updated.inheritance = normalizeInheritance(
          op.inheritance,
          op.table,
          new Set(table.columns.map((column) => column.name)),
        );
      }
      return replaceTable(state, index, updated);
    }
    case 'alter_polymorphic': {
      const index = state.tables.findIndex((table) => table.name === op.table);
      if (index === -1) {
        throw new MigrationError(
          `cannot alter polymorphic descriptor on table "${op.table}": it does not exist`,
        );
      }
      const table = state.tables[index] as TableDefinition;
      if (!polymorphicEqual(table.polymorphic, op.previous)) {
        throw new MigrationError(
          `cannot alter polymorphic descriptor on table "${op.table}": previous descriptor does not match state`,
        );
      }
      const updated: TableDefinition = { ...table };
      if (op.polymorphic === undefined) {
        delete updated.polymorphic;
      } else {
        const columnNames = new Set(table.columns.map((column) => column.name));
        updated.polymorphic = normalizePolymorphic(op.polymorphic, op.table, columnNames);
      }
      return replaceTable(state, index, updated);
    }
    case 'add_index': {
      const index = state.tables.findIndex((table) => table.name === op.table);
      if (index === -1) {
        throw new MigrationError(`cannot add index to table "${op.table}": it does not exist`);
      }
      const table = state.tables[index] as TableDefinition;
      if ((table.indexes ?? []).some((existing) => existing.name === op.index.name)) {
        throw new MigrationError(
          `cannot add index "${op.index.name}" to table "${op.table}": it already exists`,
        );
      }
      const normalized = normalizeIndex(op.index);
      assertConstraintColumnsExist(table, normalized, 'index');
      const updated: TableDefinition = {
        ...table,
        columns: table.columns,
        indexes: [...(table.indexes ?? []), normalized],
      };
      return replaceTable(state, index, updated);
    }
    case 'drop_index': {
      const index = state.tables.findIndex((table) => table.name === op.table);
      if (index === -1) {
        throw new MigrationError(`cannot drop index from table "${op.table}": it does not exist`);
      }
      const table = state.tables[index] as TableDefinition;
      const current = (table.indexes ?? []).find((existing) => existing.name === op.index.name);
      if (current === undefined) {
        throw new MigrationError(
          `cannot drop index "${op.index.name}" from table "${op.table}": it does not exist`,
        );
      }
      if (!indexesEqual(current, op.index)) {
        throw new MigrationError(
          `cannot drop index "${op.index.name}" from table "${op.table}": recorded definition does not match state`,
        );
      }
      const indexes = (table.indexes ?? []).filter((existing) => existing.name !== op.index.name);
      const updated: TableDefinition = { ...table, columns: table.columns };
      if (indexes.length > 0) {
        updated.indexes = indexes;
      } else {
        delete updated.indexes;
      }
      return replaceTable(state, index, updated);
    }
    case 'add_unique': {
      const index = state.tables.findIndex((table) => table.name === op.table);
      if (index === -1) {
        throw new MigrationError(
          `cannot add unique constraint to table "${op.table}": it does not exist`,
        );
      }
      const table = state.tables[index] as TableDefinition;
      if ((table.uniques ?? []).some((existing) => existing.name === op.unique.name)) {
        throw new MigrationError(
          `cannot add unique constraint "${op.unique.name}" to table "${op.table}": it already exists`,
        );
      }
      const normalized = normalizeUnique(op.unique);
      assertConstraintColumnsExist(table, normalized, 'unique constraint');
      const updated: TableDefinition = {
        ...table,
        columns: table.columns,
        uniques: [...(table.uniques ?? []), normalized],
      };
      return replaceTable(state, index, updated);
    }
    case 'drop_unique': {
      const index = state.tables.findIndex((table) => table.name === op.table);
      if (index === -1) {
        throw new MigrationError(
          `cannot drop unique constraint from table "${op.table}": it does not exist`,
        );
      }
      const table = state.tables[index] as TableDefinition;
      const current = (table.uniques ?? []).find((existing) => existing.name === op.unique.name);
      if (current === undefined) {
        throw new MigrationError(
          `cannot drop unique constraint "${op.unique.name}" from table "${op.table}": it does not exist`,
        );
      }
      if (!uniquesEqual(current, op.unique)) {
        throw new MigrationError(
          `cannot drop unique constraint "${op.unique.name}" from table "${op.table}": recorded definition does not match state`,
        );
      }
      const uniques = (table.uniques ?? []).filter((existing) => existing.name !== op.unique.name);
      const updated: TableDefinition = { ...table, columns: table.columns };
      if (uniques.length > 0) {
        updated.uniques = uniques;
      } else {
        delete updated.uniques;
      }
      return replaceTable(state, index, updated);
    }
    case 'add_fk': {
      const index = state.tables.findIndex((table) => table.name === op.table);
      if (index === -1) {
        throw new MigrationError(
          `cannot add foreign key to table "${op.table}": it does not exist`,
        );
      }
      const table = state.tables[index] as TableDefinition;
      if ((table.foreignKeys ?? []).some((existing) => existing.name === op.foreignKey.name)) {
        throw new MigrationError(
          `cannot add foreign key "${op.foreignKey.name}" to table "${op.table}": it already exists`,
        );
      }
      const normalized = normalizeForeignKey(op.foreignKey);
      assertConstraintColumnsExist(table, normalized, 'foreign key');

      const referenced = findTable(state, normalized.referencedTable);
      if (referenced === undefined) {
        throw new MigrationError(
          `cannot add foreign key "${normalized.name}" to table "${op.table}": it references ` +
            `unknown table "${normalized.referencedTable}"`,
        );
      }
      const referencedColumns = new Set(referenced.columns.map((column) => column.name));
      for (const column of normalized.referencedColumns) {
        if (!referencedColumns.has(column)) {
          throw new MigrationError(
            `cannot add foreign key "${normalized.name}" to table "${op.table}": it references ` +
              `unknown column "${normalized.referencedTable}.${column}"`,
          );
        }
      }

      const updated: TableDefinition = {
        ...table,
        columns: table.columns,
        foreignKeys: [...(table.foreignKeys ?? []), normalized],
      };
      return replaceTable(state, index, updated);
    }
    case 'drop_fk': {
      const index = state.tables.findIndex((table) => table.name === op.table);
      if (index === -1) {
        throw new MigrationError(
          `cannot drop foreign key from table "${op.table}": it does not exist`,
        );
      }
      const table = state.tables[index] as TableDefinition;
      const current = (table.foreignKeys ?? []).find(
        (existing) => existing.name === op.foreignKey.name,
      );
      if (current === undefined) {
        throw new MigrationError(
          `cannot drop foreign key "${op.foreignKey.name}" from table "${op.table}": it does not exist`,
        );
      }
      if (!foreignKeysEqual(current, op.foreignKey)) {
        throw new MigrationError(
          `cannot drop foreign key "${op.foreignKey.name}" from table "${op.table}": recorded definition does not match state`,
        );
      }
      const foreignKeys = (table.foreignKeys ?? []).filter(
        (existing) => existing.name !== op.foreignKey.name,
      );
      const updated: TableDefinition = { ...table, columns: table.columns };
      if (foreignKeys.length > 0) {
        updated.foreignKeys = foreignKeys;
      } else {
        delete updated.foreignKeys;
      }
      return replaceTable(state, index, updated);
    }
    case 'add_check': {
      const index = state.tables.findIndex((table) => table.name === op.table);
      if (index === -1) {
        throw new MigrationError(
          `cannot add check constraint to table "${op.table}": it does not exist`,
        );
      }
      const table = state.tables[index] as TableDefinition;
      if ((table.checks ?? []).some((existing) => existing.name === op.check.name)) {
        throw new MigrationError(
          `cannot add check constraint "${op.check.name}" to table "${op.table}": it already exists`,
        );
      }
      const normalized = normalizeCheck(op.check);
      const updated: TableDefinition = {
        ...table,
        columns: table.columns,
        checks: [...(table.checks ?? []), normalized],
      };
      return replaceTable(state, index, updated);
    }
    case 'drop_check': {
      const index = state.tables.findIndex((table) => table.name === op.table);
      if (index === -1) {
        throw new MigrationError(
          `cannot drop check constraint from table "${op.table}": it does not exist`,
        );
      }
      const table = state.tables[index] as TableDefinition;
      const currentCheck = (table.checks ?? []).find((existing) => existing.name === op.check.name);
      if (currentCheck === undefined) {
        throw new MigrationError(
          `cannot drop check constraint "${op.check.name}" from table "${op.table}": it does not exist`,
        );
      }
      if (!checksEqual(currentCheck, op.check)) {
        throw new MigrationError(
          `cannot drop check constraint "${op.check.name}" from table "${op.table}": recorded definition does not match state`,
        );
      }
      const checkList = (table.checks ?? []).filter((existing) => existing.name !== op.check.name);
      const updated: TableDefinition = { ...table, columns: table.columns };
      if (checkList.length > 0) {
        updated.checks = checkList;
      } else {
        delete updated.checks;
      }
      return replaceTable(state, index, updated);
    }
    default:
      throw new MigrationError(`unknown operation type: ${JSON.stringify((op as Operation).kind)}`);
  }
}

/** Apply operations in order, folding over {@link applyOperation}. */
export function applyOperations(state: SchemaState, operations: Operation[]): SchemaState {
  return operations.reduce(applyOperation, state);
}

/** Return the operation that undoes this one. */
export function invertOperation(op: Operation): Operation {
  switch (op.kind) {
    case 'create_table':
      return { kind: 'drop_table', table: op.table };
    case 'drop_table':
      return { kind: 'create_table', table: op.table };
    case 'add_column':
      return { kind: 'drop_column', table: op.table, column: op.column };
    case 'drop_column':
      return { kind: 'add_column', table: op.table, column: op.column };
    case 'rename_column':
      return { kind: 'rename_column', table: op.table, from: op.to, to: op.from };
    case 'rename_table':
      return { kind: 'rename_table', from: op.to, to: op.from };
    case 'alter_column':
      return { kind: 'alter_column', table: op.table, column: op.previous, previous: op.column };
    case 'alter_inheritance':
      return {
        kind: 'alter_inheritance',
        table: op.table,
        inheritance: op.previous,
        previous: op.inheritance,
      };
    case 'alter_polymorphic':
      return {
        kind: 'alter_polymorphic',
        table: op.table,
        polymorphic: op.previous,
        previous: op.polymorphic,
      };
    case 'add_index':
      return { kind: 'drop_index', table: op.table, index: op.index };
    case 'drop_index':
      return { kind: 'add_index', table: op.table, index: op.index };
    case 'add_unique':
      return { kind: 'drop_unique', table: op.table, unique: op.unique };
    case 'drop_unique':
      return { kind: 'add_unique', table: op.table, unique: op.unique };
    case 'add_fk':
      return { kind: 'drop_fk', table: op.table, foreignKey: op.foreignKey };
    case 'drop_fk':
      return { kind: 'add_fk', table: op.table, foreignKey: op.foreignKey };
    case 'add_check':
      return { kind: 'drop_check', table: op.table, check: op.check };
    case 'drop_check':
      return { kind: 'add_check', table: op.table, check: op.check };
    default:
      throw new MigrationError(`unknown operation type: ${JSON.stringify((op as Operation).kind)}`);
  }
}
