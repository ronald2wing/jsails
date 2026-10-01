/**
 * Live database introspection: convert a connected TypeORM {@link QueryRunner}'s
 * result into a portable, normalized {@link SchemaState} that is byte-comparable
 * with the declared schema produced by {@link buildSchemaStateFromMetadatas}.
 *
 * ## Driver coverage
 *
 * Every supported driver (mariadb, postgres, mysql, sqlite) is handled through
 * the same code path. The mapping is driven by the raw TypeORM
 * {@link TableColumn.type} string, which each driver normalises differently:
 * MySQL/MariaDB report native names (`int`, `varchar`, `tinyint`, `longtext`);
 * Postgres reports `regtype` lowercased (`int4`, `bool`, `timestamptz`);
 * SQLite reports the declared type verbatim (`integer`, `boolean`).
 *
 * ## SQLite honesty
 *
 * SQLite fidelity is best-effort: types are string-matched, `alter_column` is
 * always destructive (a Phase 3 reconciler concern), and the underlying sqljs
 * driver is modern enough to support `RENAME COLUMN`. The introspection output
 * is as close to the declared schema as the driver allows; any remaining gap is
 * for the reconciler to close.
 *
 * ## Live-only object filtering
 *
 * Objects that have no declared counterpart (internal tables, partial indexes,
 * expression indexes, full-text/spatial indexes, computed columns, database
 * enums, function defaults) are filtered out rather than emitted, so they
 * never produce phantom diffs. See {@link isLiveOnlyObject}.
 *
 * ## Constraint name synthesis
 *
 * SQLite does not store constraint names for foreign keys (and in some cases
 * unique constraints), so a live introspection returns constraints with
 * `name === undefined`. The portable model requires every constraint to have a
 * name, so an unnamed constraint gets a name synthesized via TypeORM's
 * {@link DefaultNamingStrategy} — the same algorithm the declared side uses —
 * guaranteeing that the two schemas match byte-for-byte.
 */
import { DefaultNamingStrategy } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import type {
  Table as TypeOrmTable,
  TableCheck,
  TableColumn,
  TableForeignKey,
  TableIndex,
  TableUnique,
} from 'typeorm';

import { normalizeSchemaState } from '../migrations/schema-normalize.js';
import {
  type CheckDefinition,
  type ColumnDefinition,
  type Deferrable,
  type ForeignKeyAction,
  type ForeignKeyDefinition,
  type IndexDefinition,
  type ScalarColumnType,
  type ScalarLiteral,
  type SchemaState,
  type TableDefinition,
  type UniqueDefinition,
} from '../migrations/schema-types.js';
import { UnsupportedSchemaError } from './model-schema.js';

// ---------------------------------------------------------------------------
// Constraint name synthesis
// ---------------------------------------------------------------------------

/**
 * Shared naming strategy instance used to synthesize names for unnamed
 * constraints (FK on sqlite, unnamed unique constraints) so the introspected
 * schema matches the declared side byte-for-byte. This is the same algorithm
 * that TypeORM's {@link Table.create} and the declared-side metadata adapter
 * both use.
 */
const namingStrategy = new DefaultNamingStrategy();

/**
 * Synthesize a foreign key constraint name when the database driver does not
 * preserve it (sqlite). Uses the same {@link DefaultNamingStrategy} as the
 * declared side so the names match.
 */
function synthesizeFkName(tableName: string, columnNames: string[]): string {
  return namingStrategy.foreignKeyName(tableName, columnNames, undefined, undefined);
}

/**
 * Synthesize a unique constraint name when the database driver does not
 * preserve it. Uses the same {@link DefaultNamingStrategy} as the declared
 * side.
 */
function synthesizeUniqueName(tableName: string, columnNames: string[]): string {
  return namingStrategy.uniqueConstraintName(tableName, columnNames);
}

// ---------------------------------------------------------------------------
// Type mapping
// ---------------------------------------------------------------------------

/**
 * Map a raw TypeORM column type string (lowercased) to a portable scalar type.
 * Returns `null` when the type has no portable representation.
 *
 * Drivers report types differently:
 * - SQLite: the declared type verbatim (`integer`, `boolean`, `varchar`, etc.)
 * - MySQL/MariaDB: native SQL names (`int`, `bigint`, `tinyint`, `longtext`)
 * - Postgres: `regtype` lowered (`int4`, `bool`, `timestamptz`, `jsonb`)
 *
 * Ambiguities (`tinyint` vs boolean, `longtext` vs json) are left to the
 * Phase 3 reconciler; this mapper picks the literal portable name when one
 * exists and delegates otherwise.
 */
const TYPE_MAP: Readonly<Record<string, ScalarColumnType>> = {
  // Integer family
  int: 'integer',
  integer: 'integer',
  mediumint: 'integer',
  tinyint: 'integer', // MySQL/MariaDB remap this to boolean in mapColumnType
  int4: 'integer',

  // Bigint family
  bigint: 'bigint',
  int8: 'bigint',

  // Varchar family
  varchar: 'varchar',
  'character varying': 'varchar',

  // Text family
  text: 'text',
  longtext: 'text', // ambiguous (may be json); reconciler (Phase 3) decides
  mediumtext: 'text',
  tinytext: 'text',

  // Boolean family
  boolean: 'boolean',
  bool: 'boolean',

  // Datetime family
  datetime: 'datetime',
  timestamp: 'datetime',
  timestamptz: 'datetime',

  // Date / time
  date: 'date',
  time: 'time',

  // Decimal family
  decimal: 'decimal',
  numeric: 'decimal',

  // Float family
  float: 'float',
  double: 'float',
  float4: 'float',
  float8: 'float',
  'double precision': 'float',
  real: 'float',

  // UUID
  uuid: 'uuid',

  // JSON family
  json: 'json',
  jsonb: 'json',
};

function mapColumnType(
  rawType: string,
  driverType: 'mariadb' | 'postgres' | 'mysql' | 'sqlite',
): ScalarColumnType | null {
  const key = rawType.toLowerCase().trim();
  // MySQL/MariaDB have no native boolean: TypeORM emits `tinyint` for a
  // declared `boolean` column. The portable model has no small-integer type
  // (see `ScalarColumnType`), so a live `tinyint` in a JSails-managed database
  // can only have come from a declared boolean — map it back.
  if ((driverType === 'mysql' || driverType === 'mariadb') && key === 'tinyint') {
    return 'boolean';
  }
  const mapped = TYPE_MAP[key];
  if (mapped !== undefined) {
    return mapped;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Default canonicalization
// ---------------------------------------------------------------------------

/**
 * Regex matching function-llike defaults: `CURRENT_TIMESTAMP`, `(expr)`,
 * Postgres `::casts`, and bare SQL keywords like `NULL`, `TRUE`, `FALSE`.
 * Any match means the default is not representable as a portable literal.
 */
const FUNCTON_DEFAULT = /[()]|::/;

/** Strip surrounding single quotes from a raw default string. */
function stripQuotes(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Canonicalize a raw TypeORM default value (string, number, or boolean) into a
 * portable {@link ScalarLiteral}, or return `undefined` when the default is a
 * function call or otherwise unrepresentable.
 *
 * SQLite stores ALL defaults as strings (booleans come back as `"1"` / `"0"`,
 * datetimes as `"2024-01-01 00:00:00"` or `"CURRENT_TIMESTAMP"`). This
 * function converts each into the literal JavaScript value the portable model
 * expects, or filters the default when conversion would be lossy.
 */
function canonicalizeDefault(
  raw: unknown,
  scalarType: ScalarColumnType,
): ScalarLiteral | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }

  // TypeORM always reports defaults as strings from the database.
  if (typeof raw !== 'string') {
    // Non-string (number, boolean) is already canonical.
    return raw as ScalarLiteral;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  // MySQL's driver returns literal defaults single-quoted (e.g. `"'1'"` for a
  // tinyint default of 1, `"'0'"` for an integer 0), while MariaDB returns the
  // same values bare. Strip the surrounding quotes up front so the boolean /
  // integer / numeric coercion below sees the bare literal on every driver;
  // the trailing string branch would otherwise only unquote varchar/text.
  const unquoted = stripQuotes(trimmed);
  const bare = unquoted.trim();
  if (bare.length === 0) {
    return undefined;
  }

  // Function defaults and casts are not portable literals.
  if (FUNCTON_DEFAULT.test(bare)) {
    return undefined;
  }

  // Bare SQL keywords are function-default-ish. `TRUE`/`FALSE` are excluded
  // here for boolean columns: a Postgres/MySQL boolean `DEFAULT true` is
  // reported by TypeORM as the string `"true"`, which is a portable literal
  // (handled below) rather than a function default. Filtering it would drop
  // the default and emit a phantom `alter_column` on the next reconcile.
  const upper = bare.toUpperCase();
  const isBooleanKeyword = upper === 'TRUE' || upper === 'FALSE';
  if (
    upper === 'NULL' ||
    (isBooleanKeyword && scalarType !== 'boolean') ||
    upper === 'CURRENT_TIMESTAMP' ||
    upper === 'CURRENT_DATE' ||
    upper === 'CURRENT_TIME'
  ) {
    return undefined;
  }

  if (scalarType === 'boolean') {
    // SQLite stores booleans as "1"/"0"; MySQL/MariaDB may return "true"/"false".
    if (bare === '1' || upper === 'TRUE') return true;
    if (bare === '0' || upper === 'FALSE') return false;
    // Unrecognized boolean string — can't canonicalize.
    return undefined;
  }

  if (scalarType === 'integer' || scalarType === 'bigint') {
    const num = Number(bare);
    if (Number.isInteger(num) && Number.isFinite(num)) {
      return num;
    }
    return undefined;
  }

  if (scalarType === 'float' || scalarType === 'decimal') {
    const num = Number(bare);
    if (Number.isFinite(num) && !Number.isNaN(num)) {
      return num;
    }
    return undefined;
  }

  // varchar, text, json, uuid, datetime, date, time: keep as string
  return bare;
}

// ---------------------------------------------------------------------------
// Live-only object filtering
// ---------------------------------------------------------------------------

/** Reserved table names that must never appear in the portable schema. */
const RESERVED_TABLE_NAMES = new Set(['jsails_migrations']);

/**
 * Predicate that filters objects with no declared counterpart. These are live-
 * only artifacts from the database or from TypeORM introspection: internal
 * tables, partial/spatial/fulltext/expression indexes, computed columns,
 * database enums. Filtering them out prevents phantom diffs.
 */
function isLiveOnlyObject(
  tableName: string,
  object:
    | { kind: 'table' }
    | { kind: 'column'; column: TableColumn }
    | { kind: 'index'; index: TableIndex; columnNames: ReadonlySet<string> }
    | { kind: 'fk'; fk: TableForeignKey }
    | { kind: 'unique'; unique: TableUnique }
    | { kind: 'check'; check: TableCheck },
): boolean {
  switch (object.kind) {
    case 'table': {
      // SQLite internal tables (sqlite_sequence, sqlite_stat*, etc.)
      if (tableName.startsWith('sqlite_')) return true;
      // JSails migration tracking table
      if (RESERVED_TABLE_NAMES.has(tableName)) return true;
      return false;
    }

    case 'column': {
      const col = object.column;
      // Generated/computed columns have no declared counterpart.
      if (col.asExpression !== undefined && col.asExpression.length > 0) return true;
      // Database enums (Postgres `CREATE TYPE`) — the enum definition lives
      // outside the table and is not in the portable model.
      if (
        col.enum !== undefined &&
        col.enum.length > 0 &&
        col.enumName !== undefined &&
        col.enumName.length > 0
      ) {
        return true;
      }
      return false;
    }

    case 'index': {
      const idx = object.index;
      // Fulltext and spatial indexes are not portable.
      if (idx.isFulltext) return true;
      if (idx.isSpatial) return true;
      // Partial/filtered indexes have a WHERE clause.
      if (idx.where !== undefined && idx.where.length > 0) return true;
      // Expression indexes: empty column list or columns not on the table.
      if (idx.columnNames.length === 0) return true;
      for (const col of idx.columnNames) {
        if (!object.columnNames.has(col)) return true;
      }
      return false;
    }

    case 'fk':
    case 'unique':
    case 'check':
      // Foreign keys, unique constraints, and check constraints are all
      // portable — including deferrable ones.
      return false;
  }
}

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

/** Map a TypeORM {@link TableColumn} into a portable {@link ColumnDefinition}. */
function mapColumn(
  column: TableColumn,
  tableName: string,
  driverType: 'mariadb' | 'postgres' | 'mysql' | 'sqlite',
): ColumnDefinition {
  if (isLiveOnlyObject(tableName, { kind: 'column', column })) {
    // This should not happen for columns we want to emit — generated columns
    // are filtered before we get here. But if a column passes the table
    // filter and then fails the column filter, skip it.
    throw new UnsupportedSchemaError(
      `column "${column.name}" in table "${tableName}" is not representable`,
    );
  }

  const rawType = column.type;
  const portableType = mapColumnType(rawType, driverType);
  if (portableType === null) {
    throw new UnsupportedSchemaError(
      `column "${column.name}" in table "${tableName}" has unsupported type ` + `"${rawType}"`,
    );
  }

  // PRIMARY KEY column: non-nullable, no default, no length for integer PK.
  const isPk = column.isPrimary;
  const nullable = isPk ? false : column.isNullable;

  // Default: extract and canonicalize, then filter if it's a function default.
  let defaultLiteral: ScalarLiteral | undefined;
  if (column.default !== undefined && column.default !== null) {
    defaultLiteral = canonicalizeDefault(column.default, portableType);
  }

  // PK columns must not carry a default.
  if (isPk && defaultLiteral !== undefined) {
    defaultLiteral = undefined;
  }

  const def: ColumnDefinition = {
    name: column.name,
    type: portableType,
    nullable,
  };

  // Length: required for varchar, extracted from TableColumn.length (a string
  // like "255" — parse it). On sqlite this is already populated.
  if (portableType === 'varchar') {
    const len = column.length;
    if (len !== undefined && len !== '') {
      const parsed = Number(len);
      if (Number.isInteger(parsed) && parsed > 0) {
        def.length = parsed;
      }
    }
    // If length cannot be parsed, keep `length` undefined and let
    // normalizeColumn throw — a varchar without length is invalid.
  }

  // Precision/scale for decimal columns.
  if (portableType === 'decimal') {
    if (column.precision !== undefined && column.precision !== null) {
      def.precision = column.precision;
    }
    if (column.scale !== undefined && column.scale !== null) {
      def.scale = column.scale;
    }
  }

  if (isPk) {
    def.primaryKey = true;
  }

  if (defaultLiteral !== undefined) {
    def.default = defaultLiteral;
  }

  return def;
}

// ---------------------------------------------------------------------------
// Index mapping
// ---------------------------------------------------------------------------

/** Map a TypeORM {@link TableIndex} into a portable {@link IndexDefinition}. */
function mapIndex(
  index: TableIndex,
  tableName: string,
  columnNames: ReadonlySet<string>,
): IndexDefinition | null {
  if (isLiveOnlyObject(tableName, { kind: 'index', index, columnNames })) {
    return null;
  }

  // Indexes without a name are auto-generated by TypeORM; the portable model
  // requires a name. Skip unnamed indexes (they represent runtime artifacts
  // the declared side never produced).
  if (index.name === undefined) {
    return null;
  }

  return {
    name: index.name,
    columns: [...index.columnNames],
    unique: index.isUnique,
  };
}

// ---------------------------------------------------------------------------
// FK mapping
// ---------------------------------------------------------------------------

/** Map a TypeORM {@link TableForeignKey} into a portable {@link ForeignKeyDefinition}. */
function mapForeignKey(fk: TableForeignKey, tableName: string): ForeignKeyDefinition | null {
  // Foreign keys without a name (sqlite PRAGMA foreign_key_list does not
  // store constraint names) must have a name synthesized so they survive
  // normalization and match the declared schema.
  const name = fk.name ?? synthesizeFkName(tableName, fk.columnNames);

  const def: ForeignKeyDefinition = {
    name,
    columns: [...fk.columnNames],
    referencedTable: fk.referencedTableName,
    referencedColumns: [...fk.referencedColumnNames],
  };

  // TypeORM reports onDelete/onUpdate as lowercase strings (e.g., "cascade",
  // "restrict", "set null", "no action"). Map to the portable action names.
  const onDelete = mapFkAction(fk.onDelete);
  if (onDelete !== undefined) {
    def.onDelete = onDelete;
  }
  const onUpdate = mapFkAction(fk.onUpdate);
  if (onUpdate !== undefined) {
    def.onUpdate = onUpdate;
  }

  // Deferrable: TypeORM stores the raw driver string.
  if (fk.deferrable !== undefined) {
    def.deferrable = normalizeDeferrable(fk.deferrable);
  }

  return def;
}

/** Map a raw driver FK action string to the portable {@link ForeignKeyAction}. */
function mapFkAction(raw: string | undefined): ForeignKeyAction | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const lower = raw.toLowerCase().replace(/\s+/g, '');
  switch (lower) {
    case 'cascade':
      return 'cascade';
    case 'restrict':
      return 'restrict';
    case 'noaction':
      return 'noAction';
    case 'setnull':
      return 'setNull';
    default:
      return undefined;
  }
}

/** Normalize a raw driver deferrable string to the portable {@link Deferrable}. */
function normalizeDeferrable(raw: string): Deferrable {
  const upper = raw.toUpperCase().replace(/\s+/g, '_');
  if (upper === 'INITIALLY_IMMEDIATE') return 'INITIALLY_IMMEDIATE';
  if (upper === 'INITIALLY_DEFERRED') return 'INITIALLY_DEFERRED';
  return 'NOT_DEFERRABLE';
}

// ---------------------------------------------------------------------------
// Unique constraint mapping
// ---------------------------------------------------------------------------

/** Map a TypeORM {@link TableUnique} into a portable {@link UniqueDefinition}. */
function mapUnique(unique: TableUnique, tableName: string): UniqueDefinition | null {
  // Unnamed unique constraints (sqlite may not preserve names for multi-column
  // UNIQUE clauses) must have a name synthesized.
  const name = unique.name ?? synthesizeUniqueName(tableName, unique.columnNames);

  const def: UniqueDefinition = {
    name,
    columns: [...unique.columnNames],
  };

  if (unique.deferrable !== undefined) {
    def.deferrable = normalizeDeferrable(unique.deferrable);
  }

  return def;
}

// ---------------------------------------------------------------------------
// Check constraint mapping
// ---------------------------------------------------------------------------

/** Map a TypeORM {@link TableCheck} into a portable {@link CheckDefinition}. */
function mapCheck(check: TableCheck): CheckDefinition | null {
  if (check.name === undefined || check.expression === undefined) {
    return null;
  }
  return {
    name: check.name,
    expression: check.expression,
  };
}

// ---------------------------------------------------------------------------
// Table mapping
// ---------------------------------------------------------------------------

/**
 * Convert a TypeORM {@link Table} into a portable {@link TableDefinition},
 * filtering live-only objects and canonicalizing every field so the output
 * survives {@link normalizeSchemaState} unchanged.
 */
function mapTable(
  table: TypeOrmTable,
  driverType: 'mariadb' | 'postgres' | 'mysql' | 'sqlite',
): TableDefinition {
  const tableName = table.name;

  // Build column set first (needed for index column validation).
  const columnNames = new Set(table.columns.map((c) => c.name));

  // Map columns, skipping generated/computed columns and enum columns.
  const columns: ColumnDefinition[] = [];
  for (const col of table.columns) {
    if (isLiveOnlyObject(tableName, { kind: 'column', column: col })) {
      continue;
    }
    columns.push(mapColumn(col, tableName, driverType));
  }

  // Map indexes, filtering live-only ones.
  const indexes: IndexDefinition[] = [];
  for (const idx of table.indices) {
    const mapped = mapIndex(idx, tableName, columnNames);
    if (mapped !== null) {
      indexes.push(mapped);
    }
  }

  // Map unique constraints.
  const uniques: UniqueDefinition[] = [];
  for (const unique of table.uniques) {
    const mapped = mapUnique(unique, tableName);
    if (mapped !== null) {
      uniques.push(mapped);
    }
  }

  // Map foreign keys.
  const foreignKeys: ForeignKeyDefinition[] = [];
  for (const fk of table.foreignKeys) {
    const mapped = mapForeignKey(fk, tableName);
    if (mapped !== null) {
      foreignKeys.push(mapped);
    }
  }

  // Map check constraints.
  const checks: CheckDefinition[] = [];
  for (const check of table.checks) {
    const mapped = mapCheck(check);
    if (mapped !== null) {
      checks.push(mapped);
    }
  }

  const def: TableDefinition = { name: tableName, columns };
  if (indexes.length > 0) {
    def.indexes = indexes;
  }
  if (uniques.length > 0) {
    def.uniques = uniques;
  }
  if (foreignKeys.length > 0) {
    def.foreignKeys = foreignKeys;
  }
  if (checks.length > 0) {
    def.checks = checks;
  }

  return def;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Introspect a live, connected database through a TypeORM query runner and
 * produce a normalized `SchemaState` byte-comparable with the declared schema
 * from `buildSchemaStateFromMetadatas`.
 *
 * The returned schema is passed through `normalizeSchemaState` so columns
 * (PK first), indexes, FK, unfatures, checks, and tables are all sorted
 * deterministically; empty arrays are omitted.
 */
export async function buildSchemaStateFromQueryRunner(
  queryRunner: QueryRunner,
  driverType: 'mariadb' | 'postgres' | 'mysql' | 'sqlite',
): Promise<SchemaState> {
  // TypeORM's MySQL/MariaDB `loadTables` runs an unfiltered
  // `SELECT ... FROM INFORMATION_SCHEMA.TABLES` when called with no table
  // names, which returns rows from every schema the connection can see
  // (e.g. `performance_schema`). Its collation lookup then dereferences an
  // undefined row and throws. Scoping the call to the connected database's
  // own base tables avoids that branch; other drivers tolerate the same list.
  const tableNames = await resolveScopedTableNames(queryRunner, driverType);
  const typeOrmTables = await queryRunner.getTables(tableNames);

  const tables: TableDefinition[] = [];
  for (const typeOrmTable of typeOrmTables) {
    if (isLiveOnlyObject(typeOrmTable.name, { kind: 'table' })) {
      continue;
    }
    tables.push(mapTable(typeOrmTable, driverType));
  }

  return normalizeSchemaState({ tables });
}

/**
 * Resolve the connected database's own table names so {@link QueryRunner.getTables}
 * uses its filtered branch. Returns `undefined` for drivers whose unfiltered
 * branch is safe (sqlite): passing an explicit list there would only add a query
 * for no benefit.
 *
 * Postgres must be scoped: TypeORM's postgres `loadTables` with no names emits
 * `SELECT ... FROM pg_catalog.pg_class ... JOIN pg_catalog.pg_namespace` over
 * every visible relation, so system catalogs (`pg_catalog.pg_statistic`,
 * `information_schema.*`, ...) leak in and then fail `mapTable` on
 * `pg_catalog`-specific types such as `smallint`. Scoping to
 * `current_schema()`'s base tables keeps introspection to the app's own tables.
 */
async function resolveScopedTableNames(
  queryRunner: QueryRunner,
  driverType: 'mariadb' | 'postgres' | 'mysql' | 'sqlite',
): Promise<string[] | undefined> {
  if (driverType === 'mysql' || driverType === 'mariadb') {
    const rows = (await queryRunner.query(
      'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()',
    )) as { TABLE_NAME: string }[];
    return rows.map((row) => row.TABLE_NAME);
  }
  if (driverType === 'postgres') {
    const rows = (await queryRunner.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'",
    )) as { table_name: string }[];
    return rows.map((row) => row.table_name);
  }
  return undefined;
}
