/**
 * Schema editor: translates logical migration operations into concrete DDL
 * through a TypeORM QueryRunner.
 *
 * Portable scalar types map to concrete driver types:
 *   integer  -> integer (postgres, sqlite) / int (mysql, mariadb)
 *   varchar  -> character varying(n) (postgres) / varchar(n) (mysql, mariadb, sqlite)
 *   text     -> text
 *   boolean  -> boolean (postgres, sqlite) / tinyint (mysql, mariadb)
 *   datetime -> timestamp without time zone (postgres) / datetime (mysql, mariadb, sqlite)
 *
 * Scalar literal defaults are escaped into safe SQL literals: single quotes are
 * doubled so a hostile default cannot inject raw SQL. Backslashes (U+005C) and
 * control characters (U+0000-001F/007F) are rejected here and in core
 * normalization, because MySQL treats a backslash as an escape and no single
 * doubling rule is safe across drivers; defaults containing them must be set
 * from application code instead. A generated integer primary key maps to the
 * increment generation strategy (SERIAL / AUTO_INCREMENT / AUTOINCREMENT).
 *
 * Alteration uses QueryRunner.changeColumn, which on some drivers drops and
 * recreates the column and can discard existing data. This module does not
 * promise data preservation; the caller is responsible for surfacing that risk.
 */

import { Table, TableColumn } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import type { TableColumnOptions } from 'typeorm';
import {
  type ColumnDefinition,
  MigrationError,
  type ScalarColumnType,
  type ScalarLiteral,
  type TableDefinition,
  assertPortableStringLiteral,
} from '../migrations/schema-state.js';
import { type Operation, validateOperation } from '../migrations/operations.js';

/** SQL dialects this editor maps portable types for. */
export type SchemaEditorDriver = 'postgres' | 'mysql' | 'mariadb' | 'sqlite';

const SUPPORTED_DRIVERS: ReadonlySet<string> = new Set<SchemaEditorDriver>([
  'postgres',
  'mysql',
  'mariadb',
  'sqlite',
]);

function assertDriver(driver: unknown): asserts driver is SchemaEditorDriver {
  if (typeof driver !== 'string' || !SUPPORTED_DRIVERS.has(driver)) {
    throw new MigrationError(
      `unsupported schema driver ${JSON.stringify(driver)}; ` +
        'expected one of postgres, mysql, mariadb, sqlite',
    );
  }
}

/** Map a portable scalar type to the concrete column type for a driver. */
export function mapScalarType(type: ScalarColumnType, driver: SchemaEditorDriver): string {
  switch (type) {
    case 'integer':
      return driver === 'postgres' || driver === 'sqlite' ? 'integer' : 'int';
    case 'varchar':
      return driver === 'postgres' ? 'character varying' : 'varchar';
    case 'text':
      return 'text';
    case 'boolean':
      return driver === 'postgres' || driver === 'sqlite' ? 'boolean' : 'tinyint';
    case 'datetime':
      return driver === 'postgres' ? 'timestamp without time zone' : 'datetime';
  }
}

/**
 * Render a scalar literal as a safe SQL literal. Strings are single-quoted with
 * embedded quotes doubled, numbers are emitted bare, and booleans become
 * true/false (postgres) or 1/0 (mysql, mariadb, sqlite). Caller-controlled raw
 * SQL is never emitted. Strings containing a backslash or control character are
 * rejected here as well as in core normalization, so a direct call cannot
 * bypass the portable-default restriction.
 */
export function quoteLiteral(value: ScalarLiteral, driver: SchemaEditorDriver): string {
  if (typeof value === 'string') {
    assertPortableStringLiteral(value, 'string default');
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return driver === 'postgres' ? (value ? 'true' : 'false') : value ? '1' : '0';
}

function buildColumnOptions(
  column: ColumnDefinition,
  driver: SchemaEditorDriver,
): TableColumnOptions {
  const options: TableColumnOptions = {
    name: column.name,
    type: mapScalarType(column.type, driver),
    isNullable: column.nullable,
    isPrimary: column.primaryKey === true,
  };
  if (column.type === 'varchar') {
    options.length = String(column.length);
  }
  if (column.primaryKey) {
    options.isGenerated = true;
    options.generationStrategy = 'increment';
  }
  if (column.default !== undefined) {
    options.default = quoteLiteral(column.default, driver);
  }
  return options;
}

/** Convert a portable column definition to a concrete TypeORM column. */
export function columnToTableColumn(
  column: ColumnDefinition,
  driver: SchemaEditorDriver,
): TableColumn {
  return new TableColumn(buildColumnOptions(column, driver));
}

/** Convert a portable table definition to a concrete TypeORM table. */
export function tableToTable(table: TableDefinition, driver: SchemaEditorDriver): Table {
  return new Table({
    name: table.name,
    columns: table.columns.map((column) => buildColumnOptions(column, driver)),
  });
}

/**
 * Validate a single operation and the driver before any DDL, returning a
 * normalized copy. Malformed operations, unsupported types, and invalid
 * defaults throw {@link MigrationError} without touching the database. State
 * preconditions (existence, uniqueness) are validated separately by the
 * migration core.
 */
export function preflightSchemaOperation(
  operation: Operation,
  driver: SchemaEditorDriver,
): Operation {
  assertDriver(driver);
  return validateOperation(operation);
}

/**
 * Validate every operation before any is applied, returning normalized copies.
 * Pure: performs no database or query-runner work.
 */
export function preflightSchemaOperations(
  operations: Operation[],
  driver: SchemaEditorDriver,
): Operation[] {
  assertDriver(driver);
  return operations.map((operation) => validateOperation(operation));
}

/**
 * Apply a single logical operation as DDL. The operation and driver are
 * validated before the query runner is invoked, so an invalid operation never
 * touches the database.
 */
export async function executeSchemaOperation(
  queryRunner: QueryRunner,
  operation: Operation,
  driver: SchemaEditorDriver,
): Promise<void> {
  const op = preflightSchemaOperation(operation, driver);
  switch (op.kind) {
    case 'create_table':
      await queryRunner.createTable(tableToTable(op.table, driver));
      return;
    case 'drop_table':
      await queryRunner.dropTable(op.table.name);
      return;
    case 'add_column':
      await queryRunner.addColumn(op.table, columnToTableColumn(op.column, driver));
      return;
    case 'drop_column':
      await queryRunner.dropColumn(op.table, op.column.name);
      return;
    case 'rename_column':
      await queryRunner.renameColumn(op.table, op.from, op.to);
      return;
    case 'alter_column':
      // changeColumn may drop and recreate the column on some drivers; see the
      // module docstring — no data-preservation promise is made here.
      await queryRunner.changeColumn(
        op.table,
        columnToTableColumn(op.previous, driver),
        columnToTableColumn(op.column, driver),
      );
      return;
  }
}
