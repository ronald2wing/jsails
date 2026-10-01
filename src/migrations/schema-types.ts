/**
 * Structural, JSON-serializable logical schema model shared by the migration
 * core, the autodetector, and (later) the TypeORM metadata adapter.
 *
 * This module is deliberately free of raw SQL and database functions: a schema
 * state is a plain object of tables and columns that can round-trip through
 * `JSON.stringify`/`JSON.parse` unchanged.
 */

/**
 * Portable scalar column types. The metadata adapter maps these onto concrete
 * driver types; unsupported features are rejected there, not silently ignored.
 */
export type ScalarColumnType =
  | 'integer'
  | 'varchar'
  | 'text'
  | 'boolean'
  | 'datetime'
  | 'decimal'
  | 'float'
  | 'bigint'
  | 'uuid'
  | 'json'
  | 'date'
  | 'time';

/** A scalar literal usable as a column default. `null` is not a default. */
export type ScalarLiteral = string | number | boolean;

export interface ColumnDefinition {
  name: string;
  type: ScalarColumnType;
  /** Explicit nullability. `false` means NOT NULL. */
  nullable: boolean;
  /** Required when `type` is `varchar`; a positive integer. Ignored otherwise. */
  length?: number;
  /** Required when `type` is `decimal`; total digit count. */
  precision?: number;
  /** Optional when `type` is `decimal`; digits after the decimal point. */
  scale?: number;
  /**
   * Marks a primary-key column. At most one generated integer primary key
   * per table — a single PK column must be `integer`, non-nullable, and have
   * no default, and generation is implied. A composite primary key (multiple
   * columns with this flag) allows non-integer types and carries no generation
   * — every column must still be non-nullable with no default.
   */
  primaryKey?: boolean;
  /** Scalar literal default; must match the column type. */
  default?: ScalarLiteral;
}

/**
 * A named column-list index. `unique` distinguishes a unique index (true) from
 * a plain index (false); both are indexes, not constraints.
 */
export interface IndexDefinition {
  name: string;
  columns: string[];
  unique: boolean;
}

/** Constraint deferrability. Omitted means NOT DEFERRABLE (the default). */
export type Deferrable = 'INITIALLY_IMMEDIATE' | 'INITIALLY_DEFERRED' | 'NOT_DEFERRABLE';

/**
 * A named column-list unique constraint. A unique constraint is unique by
 * definition, so it carries no `unique` flag.
 */
export interface UniqueDefinition {
  name: string;
  columns: string[];
  deferrable?: Deferrable;
}

/**
 * Referential action of a foreign key. Mapped from the portable names onto the
 * driver's native `ON DELETE`/`ON UPDATE` clauses by the schema editor. Omitted
 * means "use the database default" (typically RESTRICT/NO ACTION).
 */
export type ForeignKeyAction = 'cascade' | 'restrict' | 'setNull' | 'noAction';

/**
 * A named foreign key from a table's local columns to another table's columns.
 * Single- and multi-column (composite) foreign keys are both supported; the
 * number of local columns must equal the number of referenced columns.
 */
export interface ForeignKeyDefinition {
  name: string;
  /** Local (owning) columns, in referential order. */
  columns: string[];
  /** Table this key references. */
  referencedTable: string;
  /** Columns of the referenced table, matching `columns` by position. */
  referencedColumns: string[];
  onDelete?: ForeignKeyAction;
  onUpdate?: ForeignKeyAction;
  deferrable?: Deferrable;
}

/**
 * A named SQL check constraint. The `expression` is raw SQL owned by the
 * caller; JSails never validates, sanitizes, or parses it. An invalid or
 * unsupported expression is the caller's responsibility — it is passed
 * verbatim to the driver and may fail at DDL-execution time.
 */
export interface CheckDefinition {
  name: string;
  /** Raw SQL predicate, caller-owned and never sanitized. */
  expression: string;
}

export interface TableDefinition {
  name: string;
  columns: ColumnDefinition[];
  /** Named indexes (plain or unique), sorted by name. Omitted when empty. */
  indexes?: IndexDefinition[];
  /** Named unique constraints, sorted by name. Omitted when empty. */
  uniques?: UniqueDefinition[];
  /** Named foreign keys, sorted by name. Omitted when empty. */
  foreignKeys?: ForeignKeyDefinition[];
  /** Named check constraints, sorted by name. Omitted when empty. */
  checks?: CheckDefinition[];
  /**
   * Optional explicit name for the primary key constraint. When absent (or when
   * no column is marked `primaryKey`) the constraint name is driver-defaulted.
   */
  primaryKeyName?: string;
  /**
   * Table-level inheritance descriptor. Present only for single-table
   * inheritance (STI) tables where one table holds all subclasses.
   * MTI (joined/concrete) uses a parent-link FK and needs no descriptor.
   */
  inheritance?: {
    strategy: 'single';
    discriminatorColumn: string;
    discriminatorValues: string[];
  };
  /**
   * Table-level polymorphic-relation descriptor. Present when the table has a
   * generic foreign key: a type column naming the target table and an id column
   * naming the target row. No database-level FK exists (the target varies per row).
   */
  polymorphic?: {
    typeColumn: string;
    idColumn: string;
    targets: string[];
  };
}

export interface SchemaState {
  tables: TableDefinition[];
}

/** Error raised for any invalid schema, operation, history, or diff. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** An empty schema state — the baseline every diff starts from. */
export function emptySchema(): SchemaState {
  return { tables: [] };
}
