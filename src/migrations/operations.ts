/**
 * Migration operations: the unit of change applied to a {@link SchemaState}.
 *
 * Every operation carries enough information to be inverted: destructive
 * operations retain the previous definition (the full table or column they
 * remove), and `alter_column` retains both the old and new column definitions.
 */

import {
  type ColumnDefinition,
  MigrationError,
  type SchemaState,
  type TableDefinition,
  columnsEqual,
  normalizeColumn,
  normalizeTable,
  tablesEqual,
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

export interface AlterColumnOperation {
  kind: 'alter_column';
  table: string;
  /** New definition. */
  column: ColumnDefinition;
  /** Previous definition, retained so the alteration can be inverted. */
  previous: ColumnDefinition;
}

export type Operation =
  | CreateTableOperation
  | DropTableOperation
  | AddColumnOperation
  | DropColumnOperation
  | RenameColumnOperation
  | AlterColumnOperation;

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
      return replaceTable(state, index, { name: table.name, columns: [...table.columns, column] });
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
        name: table.name,
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
      return replaceTable(state, index, { name: table.name, columns });
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
      return replaceTable(state, index, { name: table.name, columns });
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
    case 'alter_column':
      return { kind: 'alter_column', table: op.table, column: op.previous, previous: op.column };
    default:
      throw new MigrationError(`unknown operation type: ${JSON.stringify((op as Operation).kind)}`);
  }
}
