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
 * Deferrable constraints (INITIALLY_IMMEDIATE, INITIALLY_DEFERRED) are
 * Postgres-only; non-postgres drivers reject them with a {@link MigrationError}.
 * NOT_DEFERRABLE is the default and is omitted from the DDL.
 *
 * Alteration uses QueryRunner.changeColumn, which on some drivers drops and
 * recreates the column and can discard existing data. This module does not
 * promise data preservation; the caller is responsible for surfacing that risk.
 */

import { Table, TableCheck, TableColumn, TableForeignKey, TableIndex, TableUnique } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import type { TableColumnOptions, TableForeignKeyOptions, TableOptions } from 'typeorm';
import {
  type CheckDefinition,
  type ColumnDefinition,
  type Deferrable,
  type ForeignKeyAction,
  type ForeignKeyDefinition,
  type IndexDefinition,
  MigrationError,
  type ScalarColumnType,
  type ScalarLiteral,
  type TableDefinition,
  type UniqueDefinition,
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
    case 'decimal':
      return 'decimal';
    case 'float':
      return driver === 'postgres' ? 'double precision' : 'double';
    case 'bigint':
      return 'bigint';
    case 'uuid':
      return driver === 'postgres' ? 'uuid' : 'varchar';
    case 'json':
      return driver === 'postgres' ? 'jsonb' : driver === 'sqlite' ? 'text' : 'json';
    case 'date':
      return 'date';
    case 'time':
      return 'time';
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
  isGenerated: boolean,
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
  if (column.type === 'uuid' && driver !== 'postgres') {
    options.length = '36';
  }
  if (column.type === 'decimal') {
    options.precision = column.precision;
    if (column.scale !== undefined) {
      options.scale = column.scale;
    }
  }
  if (isGenerated) {
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
  isGenerated?: boolean,
): TableColumn {
  return new TableColumn(buildColumnOptions(column, driver, isGenerated === true));
}

/** Convert a portable index definition to a concrete TypeORM index. */
function indexToTableIndex(index: IndexDefinition): TableIndex {
  return new TableIndex({
    name: index.name,
    columnNames: index.columns,
    isUnique: index.unique,
  });
}

/** Convert a portable unique constraint to a concrete TypeORM unique. */
function uniqueToTableUnique(unique: UniqueDefinition, driver: SchemaEditorDriver): TableUnique {
  const options: { name: string; columnNames: string[]; deferrable?: string } = {
    name: unique.name,
    columnNames: unique.columns,
  };
  if (unique.deferrable !== undefined) {
    const ddl = mapDeferrableForDdl(unique.deferrable, driver);
    if (ddl !== undefined) {
      options.deferrable = ddl;
    }
  }
  return new TableUnique(options);
}

/**
 * Map a portable {@link Deferrable} to TypeORM's native deferrable string.
 * Deferrable constraints are Postgres-only: non-postgres drivers reject them.
 */
export function mapDeferrableForDdl(
  deferrable: Deferrable,
  driver: SchemaEditorDriver,
): string | undefined {
  if (deferrable === 'NOT_DEFERRABLE') {
    return undefined;
  }
  if (driver !== 'postgres') {
    throw new MigrationError(
      `deferrable constraint "${deferrable}" requires Postgres; cannot apply on "${driver}"`,
    );
  }
  return deferrable === 'INITIALLY_IMMEDIATE' ? 'INITIALLY IMMEDIATE' : 'INITIALLY DEFERRED';
}

/** Map a portable referential action onto the driver's native SQL clause. */
export function mapForeignKeyAction(action: ForeignKeyAction): string {
  switch (action) {
    case 'cascade':
      return 'CASCADE';
    case 'restrict':
      return 'RESTRICT';
    case 'setNull':
      return 'SET NULL';
    case 'noAction':
      return 'NO ACTION';
  }
}

/** Convert a portable check constraint to a concrete TypeORM check. */
function checkToTableCheck(check: CheckDefinition): TableCheck {
  return new TableCheck({ name: check.name, expression: check.expression });
}

/** Convert a portable foreign key definition to a concrete TypeORM foreign key. */
export function foreignKeyToTableForeignKey(
  fk: ForeignKeyDefinition,
  driver: SchemaEditorDriver,
): TableForeignKey {
  const options: TableForeignKeyOptions = {
    name: fk.name,
    columnNames: fk.columns,
    referencedTableName: fk.referencedTable,
    referencedColumnNames: fk.referencedColumns,
  };
  if (fk.onDelete !== undefined) {
    options.onDelete = mapForeignKeyAction(fk.onDelete);
  }
  if (fk.onUpdate !== undefined) {
    options.onUpdate = mapForeignKeyAction(fk.onUpdate);
  }
  if (fk.deferrable !== undefined) {
    const ddl = mapDeferrableForDdl(fk.deferrable, driver);
    if (ddl !== undefined) {
      options.deferrable = ddl;
    }
  }
  return new TableForeignKey(options);
}

/** Convert a portable table definition to a concrete TypeORM table. */
export function tableToTable(table: TableDefinition, driver: SchemaEditorDriver): Table {
  const pkColumns = table.columns.filter((c) => c.primaryKey);
  // A single integer PK column is auto-generated; composite PK columns are not.
  const isSingleGeneratedPk =
    pkColumns.length === 1 && (pkColumns[0] as ColumnDefinition).type === 'integer';
  const generatedNames = new Set(
    isSingleGeneratedPk ? [(pkColumns[0] as ColumnDefinition).name] : [],
  );
  const options: TableOptions = {
    name: table.name,
    columns: table.columns.map((column) =>
      buildColumnOptions(column, driver, generatedNames.has(column.name)),
    ),
  };
  if (table.indexes && table.indexes.length > 0) {
    options.indices = table.indexes.map(indexToTableIndex);
  }
  if (table.uniques && table.uniques.length > 0) {
    options.uniques = table.uniques.map((unique) => uniqueToTableUnique(unique, driver));
  }
  if (table.foreignKeys && table.foreignKeys.length > 0) {
    options.foreignKeys = table.foreignKeys.map((fk) => foreignKeyToTableForeignKey(fk, driver));
  }
  if (table.checks && table.checks.length > 0) {
    options.checks = table.checks.map(checkToTableCheck);
  }
  return new Table(options);
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
    case 'rename_table':
      await queryRunner.renameTable(op.from, op.to);
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
    case 'alter_inheritance':
      // Metadata-only: the discriminator column is a physical column managed by
      // column operations, so changing the descriptor emits no DDL.
      return;
    case 'alter_polymorphic':
      // Metadata-only: the type and id columns are physical columns managed by
      // column operations, so changing the descriptor emits no DDL.
      return;
    case 'add_index':
      await queryRunner.createIndex(op.table, indexToTableIndex(op.index));
      return;
    case 'drop_index':
      await queryRunner.dropIndex(op.table, op.index.name);
      return;
    case 'add_unique':
      await queryRunner.createUniqueConstraint(op.table, uniqueToTableUnique(op.unique, driver));
      return;
    case 'drop_unique':
      await queryRunner.dropUniqueConstraint(op.table, op.unique.name);
      return;
    case 'add_fk':
      // SQLite ALTER TABLE cannot add a foreign key in place; TypeORM's sqlite
      // query runner recreates the table to apply it, so this delegation is
      // driver-uniform.
      await queryRunner.createForeignKey(
        op.table,
        foreignKeyToTableForeignKey(op.foreignKey, driver),
      );
      return;
    case 'drop_fk':
      // SQLite drops a foreign key by recreating the table, same as above.
      await queryRunner.dropForeignKey(op.table, op.foreignKey.name);
      return;
    case 'add_check':
      await queryRunner.createCheckConstraint(op.table, checkToTableCheck(op.check));
      return;
    case 'drop_check':
      await queryRunner.dropCheckConstraint(op.table, op.check.name);
      return;
  }
}
