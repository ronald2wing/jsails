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

const DEFERRABLE_VALUES = new Set<Deferrable>([
  'INITIALLY_IMMEDIATE',
  'INITIALLY_DEFERRED',
  'NOT_DEFERRABLE',
]);

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

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SCALAR_TYPES = new Set<ScalarColumnType>([
  'integer',
  'varchar',
  'text',
  'boolean',
  'datetime',
  'decimal',
  'float',
  'bigint',
  'uuid',
  'json',
  'date',
  'time',
]);

/** Error raised for any invalid schema, operation, history, or diff. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export function isValidIdentifier(name: string): boolean {
  return typeof name === 'string' && IDENTIFIER.test(name);
}

/** Validate a runtime identifier and return it typed. Used for untrusted JSON. */
export function validateIdentifier(name: unknown): string {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new MigrationError(`invalid identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

function isScalarType(value: unknown): value is ScalarColumnType {
  return typeof value === 'string' && SCALAR_TYPES.has(value as ScalarColumnType);
}

/** Portable integer columns are signed 32-bit (postgres `integer`, mysql `int`). */
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/**
 * Backslash (U+005C) and C0/DEL control characters (U+0000-001F, U+007F) are
 * not portable as string literal defaults: MySQL treats a backslash as an
 * escape, so re-escaping per driver would silently corrupt data or reopen the
 * injection it was meant to close. These are rejected uniformly rather than
 * given driver-dependent escaping.
 */
const BACKSLASH_OR_CONTROL = /[\u005C\u0000-\u001F\u007F]/;

/**
 * Reject a string that cannot be represented portably as a SQL default. Shared
 * with the schema editor so a direct `quoteLiteral` call cannot bypass core
 * normalization. Single quotes remain allowed (they are doubled, never escaped).
 */
export function assertPortableStringLiteral(value: string, label: string): void {
  if (BACKSLASH_OR_CONTROL.test(value)) {
    throw new MigrationError(
      `${label} contains a backslash or control character (U+005C or U+0000-001F/007F), ` +
        `which cannot be ported safely across SQL drivers; omit the default and set the ` +
        `value from application code instead`,
    );
  }
}

function literalTypeMismatch(value: unknown, type: ScalarColumnType, columnName: string): never {
  throw new MigrationError(
    `default for ${type} column "${columnName}" does not match its type: ${JSON.stringify(value)}`,
  );
}

function daysInMonth(year: number, month: number): number {
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const leapFebruary = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (month === 2 && leapFebruary) {
    return 29;
  }
  return days[month - 1] as number;
}

/**
 * Validate a datetime default against the exact `YYYY-MM-DD HH:MM:SS` form,
 * with a real calendar (leap years, month/day ranges) and a portable year range
 * of 1000..9999. This is a pure string/arithmetic check; no `Date` object is
 * constructed, so timezone coercion can never shift the value.
 */
function assertValidDatetimeLiteral(value: string, columnName: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (match === null) {
    throw new MigrationError(
      `default for datetime column "${columnName}" must be exactly "YYYY-MM-DD HH:MM:SS" ` +
        `(no timezone, no fractional seconds); got ${JSON.stringify(value)}`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1000 || year > 9999) {
    throw new MigrationError(
      `default for datetime column "${columnName}" has year ${year}, outside the ` +
        `portable range 1000..9999`,
    );
  }
  if (month < 1 || month > 12) {
    throw new MigrationError(
      `default for datetime column "${columnName}" has invalid month ${month}`,
    );
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new MigrationError(
      `default for datetime column "${columnName}" has invalid day ${day} for ` +
        `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`,
    );
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw new MigrationError(
      `default for datetime column "${columnName}" has invalid time ` +
        `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:` +
        `${String(second).padStart(2, '0')}`,
    );
  }
}

/**
 * Validate a date default (YYYY-MM-DD) with a real calendar and a portable year
 * range of 1000..9999. No `Date` object is constructed.
 */
function assertValidDateLiteral(value: string, columnName: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new MigrationError(
      `default for date column "${columnName}" must be exactly "YYYY-MM-DD" ` +
        `(no timezone, no time component); got ${JSON.stringify(value)}`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || year > 9999) {
    throw new MigrationError(
      `default for date column "${columnName}" has year ${year}, outside the ` +
        `portable range 1000..9999`,
    );
  }
  if (month < 1 || month > 12) {
    throw new MigrationError(`default for date column "${columnName}" has invalid month ${month}`);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new MigrationError(
      `default for date column "${columnName}" has invalid day ${day} for ` +
        `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`,
    );
  }
}

/**
 * Validate a time default (HH:MM:SS) within valid ranges. No `Date` object is
 * constructed.
 */
function assertValidTimeLiteral(value: string, columnName: string): void {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (match === null) {
    throw new MigrationError(
      `default for time column "${columnName}" must be exactly "HH:MM:SS" ` +
        `(no timezone, no fractional seconds); got ${JSON.stringify(value)}`,
    );
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new MigrationError(
      `default for time column "${columnName}" has invalid time ` +
        `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:` +
        `${String(second).padStart(2, '0')}`,
    );
  }
}

function assertLiteralMatchesType(
  value: unknown,
  type: ScalarColumnType,
  columnName: string,
): void {
  if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      literalTypeMismatch(value, type, columnName);
    }
    if (value < INT32_MIN || value > INT32_MAX) {
      throw new MigrationError(
        `default for integer column "${columnName}" is out of range: ${String(value)}; ` +
          `portable integer columns are signed 32-bit (${INT32_MIN}..${INT32_MAX})`,
      );
    }
    return;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') {
      literalTypeMismatch(value, type, columnName);
    }
    return;
  }
  if (type === 'decimal' || type === 'float' || type === 'bigint') {
    if (typeof value !== 'number') {
      literalTypeMismatch(value, type, columnName);
    }
    return;
  }
  if (type === 'json') {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      literalTypeMismatch(value, type, columnName);
    }
    if (typeof value === 'string') {
      assertPortableStringLiteral(value, `default for json column "${columnName}"`);
    }
    return;
  }
  // varchar / text / datetime / uuid / date / time
  if (typeof value !== 'string') {
    literalTypeMismatch(value, type, columnName);
  }
  assertPortableStringLiteral(value, `default for ${type} column "${columnName}"`);
  if (type === 'datetime') {
    assertValidDatetimeLiteral(value, columnName);
  }
  if (type === 'date') {
    assertValidDateLiteral(value, columnName);
  }
  if (type === 'time') {
    assertValidTimeLiteral(value, columnName);
  }
}

/**
 * Validate and canonicalize a single column definition. Returns a fresh object
 * with only the meaningful fields set, so JSON serialization is deterministic.
 */
export function normalizeColumn(column: ColumnDefinition): ColumnDefinition {
  if (typeof column !== 'object' || column === null) {
    throw new MigrationError('column definition must be an object');
  }
  const c = column as unknown as Record<string, unknown>;
  const name = validateIdentifier(c.name);
  const type = c.type;
  if (!isScalarType(type)) {
    throw new MigrationError(`column "${name}" has invalid type: ${JSON.stringify(type)}`);
  }
  if (typeof c.nullable !== 'boolean') {
    throw new MigrationError(`column "${name}" "nullable" must be a boolean`);
  }
  const nullable = c.nullable;

  const length = c.length;
  if (type === 'varchar') {
    if (typeof length !== 'number' || !Number.isInteger(length) || length <= 0) {
      throw new MigrationError(`varchar column "${name}" requires a positive integer "length"`);
    }
  } else if (length !== undefined) {
    throw new MigrationError(`column "${name}" may only declare "length" when type is varchar`);
  }

  const precision = c.precision;
  const scale = c.scale;
  if (type === 'decimal') {
    if (typeof precision !== 'number' || !Number.isInteger(precision) || precision <= 0) {
      throw new MigrationError(`decimal column "${name}" requires a positive integer "precision"`);
    }
    if (scale !== undefined) {
      if (typeof scale !== 'number' || !Number.isInteger(scale) || scale < 0) {
        throw new MigrationError(`decimal column "${name}" "scale" must be a non-negative integer`);
      }
      if (scale > precision) {
        throw new MigrationError(
          `decimal column "${name}" "scale" (${scale}) must not exceed "precision" (${precision})`,
        );
      }
    }
  } else {
    if (precision !== undefined) {
      throw new MigrationError(
        `column "${name}" may only declare "precision" when type is decimal`,
      );
    }
    if (scale !== undefined) {
      throw new MigrationError(`column "${name}" may only declare "scale" when type is decimal`);
    }
  }

  const primaryKey = c.primaryKey === true;
  if (primaryKey) {
    // A composite primary key allows non-integer columns; the single-PK
    // integer requirement is enforced in normalizeTable after all columns
    // are seen.
    if (nullable) {
      throw new MigrationError(`primary key column "${name}" must not be nullable`);
    }
    if (c.default !== undefined) {
      throw new MigrationError(`primary key column "${name}" must not declare a default`);
    }
  }

  const defaultValue = c.default;
  if (defaultValue !== undefined) {
    assertLiteralMatchesType(defaultValue, type, name);
    if (type === 'varchar' && typeof defaultValue === 'string') {
      const defaultLength = Array.from(defaultValue).length;
      if (defaultLength > (length as number)) {
        throw new MigrationError(
          `default for varchar column "${name}" is ${defaultLength} characters ` +
            `(Unicode code points), exceeding its declared length ${length as number}`,
        );
      }
    }
  }

  const out: ColumnDefinition = { name, type, nullable };
  if (type === 'varchar') {
    out.length = length;
  }
  if (type === 'decimal') {
    out.precision = precision;
    if (scale !== undefined) {
      out.scale = scale;
    }
  }
  if (primaryKey) {
    out.primaryKey = true;
  }
  if (defaultValue !== undefined) {
    out.default = defaultValue as ScalarLiteral;
  }
  return out;
}

/** Validate a runtime constraint name and a non-empty, duplicate-free column list. */
function normalizeNamedColumns(
  constraint: Record<string, unknown>,
  kind: string,
): { name: string; columns: string[] } {
  const name = validateIdentifier(constraint.name);
  if (!Array.isArray(constraint.columns) || constraint.columns.length === 0) {
    throw new MigrationError(`${kind} "${name}" must declare at least one column`);
  }
  const columns = constraint.columns.map((column) => validateIdentifier(column));
  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(column)) {
      throw new MigrationError(`${kind} "${name}" lists column "${column}" more than once`);
    }
    seen.add(column);
  }
  return { name, columns };
}

/**
 * Validate and canonicalize a named index definition. Returns a fresh object so
 * JSON serialization is deterministic.
 */
export function normalizeIndex(index: IndexDefinition): IndexDefinition {
  if (typeof index !== 'object' || index === null) {
    throw new MigrationError('index definition must be an object');
  }
  const { name, columns } = normalizeNamedColumns(
    index as unknown as Record<string, unknown>,
    'index',
  );
  if (typeof (index as unknown as Record<string, unknown>).unique !== 'boolean') {
    throw new MigrationError(`index "${name}" "unique" must be a boolean`);
  }
  return { name, columns, unique: index.unique };
}

/**
 * Validate and canonicalize a named unique constraint definition. Always unique,
 * so the canonical form is `{ name, columns }`.
 */
export function normalizeUnique(unique: UniqueDefinition): UniqueDefinition {
  if (typeof unique !== 'object' || unique === null) {
    throw new MigrationError('unique constraint definition must be an object');
  }
  const record = unique as unknown as Record<string, unknown>;
  const { name, columns } = normalizeNamedColumns(record, 'unique constraint');
  const out: UniqueDefinition = { name, columns };
  if (record.deferrable !== undefined) {
    if (
      typeof record.deferrable !== 'string' ||
      !DEFERRABLE_VALUES.has(record.deferrable as Deferrable)
    ) {
      throw new MigrationError(
        `unique constraint "${name}" "deferrable" must be one of INITIALLY_IMMEDIATE, ` +
          `INITIALLY_DEFERRED, NOT_DEFERRABLE; got ${JSON.stringify(record.deferrable)}`,
      );
    }
    out.deferrable = record.deferrable as Deferrable;
  }
  return out;
}

/**
 * Validate and canonicalize a check constraint definition. The name must be a
 * non-empty identifier and the expression must be a non-empty string. The
 * expression is stored verbatim — no parsing, validation, or sanitization is
 * performed, so an invalid expression is the caller's responsibility and may
 * fail at DDL-execution time.
 */
export function normalizeCheck(check: CheckDefinition): CheckDefinition {
  if (typeof check !== 'object' || check === null) {
    throw new MigrationError('check constraint definition must be an object');
  }
  const record = check as unknown as Record<string, unknown>;
  const name = validateIdentifier(record.name);
  if (typeof record.expression !== 'string' || record.expression.length === 0) {
    throw new MigrationError(
      `check constraint "${name}" must have a non-empty "expression" string`,
    );
  }
  return { name, expression: record.expression };
}

const FOREIGN_KEY_ACTIONS = new Set<ForeignKeyAction>([
  'cascade',
  'restrict',
  'setNull',
  'noAction',
]);

function normalizeForeignKeyAction(
  value: unknown,
  fkName: string,
  kind: string,
): ForeignKeyAction | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !FOREIGN_KEY_ACTIONS.has(value as ForeignKeyAction)) {
    throw new MigrationError(
      `foreign key "${fkName}" ${kind} must be one of cascade, restrict, setNull, noAction; ` +
        `got ${JSON.stringify(value)}`,
    );
  }
  return value as ForeignKeyAction;
}

/**
 * Validate and canonicalize a foreign key definition. Single- and multi-column
 * (composite) keys are both accepted; the number of local and referenced columns
 * must match. Referenced-table/column existence is checked at the schema and
 * apply-time boundaries, not here — a single table cannot see the rest of the
 * schema.
 */
export function normalizeForeignKey(fk: ForeignKeyDefinition): ForeignKeyDefinition {
  if (typeof fk !== 'object' || fk === null) {
    throw new MigrationError('foreign key definition must be an object');
  }
  const record = fk as unknown as Record<string, unknown>;
  const name = validateIdentifier(record.name);
  const label = `foreign key "${name}"`;

  if (!Array.isArray(record.columns) || record.columns.length === 0) {
    throw new MigrationError(`${label} must declare at least one local column`);
  }
  const columns = record.columns.map((column) => validateIdentifier(column));
  if (new Set(columns).size !== columns.length) {
    throw new MigrationError(`${label} lists a local column more than once`);
  }

  const referencedTable = validateIdentifier(record.referencedTable);
  if (!Array.isArray(record.referencedColumns) || record.referencedColumns.length === 0) {
    throw new MigrationError(`${label} must declare at least one referenced column`);
  }
  const referencedColumns = record.referencedColumns.map((column) => validateIdentifier(column));
  if (referencedColumns.length !== columns.length) {
    throw new MigrationError(
      `${label} has ${columns.length} local column(s) but ${referencedColumns.length} ` +
        `referenced column(s); they must match`,
    );
  }
  if (new Set(referencedColumns).size !== referencedColumns.length) {
    throw new MigrationError(`${label} lists a referenced column more than once`);
  }

  const out: ForeignKeyDefinition = { name, columns, referencedTable, referencedColumns };
  const onDelete = normalizeForeignKeyAction(record.onDelete, name, '"onDelete"');
  if (onDelete !== undefined) {
    out.onDelete = onDelete;
  }
  const onUpdate = normalizeForeignKeyAction(record.onUpdate, name, '"onUpdate"');
  if (onUpdate !== undefined) {
    out.onUpdate = onUpdate;
  }
  if (record.deferrable !== undefined) {
    if (
      typeof record.deferrable !== 'string' ||
      !DEFERRABLE_VALUES.has(record.deferrable as Deferrable)
    ) {
      throw new MigrationError(
        `${label} "deferrable" must be one of INITIALLY_IMMEDIATE, INITIALLY_DEFERRED, ` +
          `NOT_DEFERRABLE; got ${JSON.stringify(record.deferrable)}`,
      );
    }
    out.deferrable = record.deferrable as Deferrable;
  }
  return out;
}

/** Every index/unique column must name a real column of the table. */
function assertConstraintColumns(
  kind: string,
  name: string,
  columns: string[],
  tableName: string,
  columnNames: ReadonlySet<string>,
): void {
  for (const column of columns) {
    if (!columnNames.has(column)) {
      throw new MigrationError(
        `${kind} "${name}" in table "${tableName}" references unknown column "${column}"`,
      );
    }
  }
}

/**
 * Validate and canonicalize a single-table-inheritance descriptor. When
 * `columnNames` is supplied the discriminator column must exist in the table;
 * operation validation omits it because the target table is not known there.
 */
export function normalizeInheritance(
  raw: unknown,
  tableName: string,
  columnNames?: ReadonlySet<string>,
): TableDefinition['inheritance'] {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new MigrationError(`table "${tableName}" "inheritance" must be an object`);
  }
  const inh = raw as Record<string, unknown>;
  if (inh.strategy !== 'single') {
    throw new MigrationError(
      `table "${tableName}" "inheritance.strategy" must be "single"; got ${JSON.stringify(inh.strategy)}`,
    );
  }
  const discriminatorColumn = validateIdentifier(inh.discriminatorColumn);
  if (columnNames !== undefined && !columnNames.has(discriminatorColumn)) {
    throw new MigrationError(
      `table "${tableName}" inheritance discriminator column "${discriminatorColumn}" ` +
        `does not exist in the table's columns`,
    );
  }
  if (!Array.isArray(inh.discriminatorValues) || inh.discriminatorValues.length === 0) {
    throw new MigrationError(
      `table "${tableName}" "inheritance.discriminatorValues" must be a non-empty array`,
    );
  }
  const discriminatorValues = inh.discriminatorValues.map((v: unknown, i: number) => {
    if (typeof v !== 'string') {
      throw new MigrationError(
        `table "${tableName}" "inheritance.discriminatorValues[${i}]" must be a string`,
      );
    }
    return v;
  });
  const seenValues = new Set<string>();
  for (const v of discriminatorValues) {
    if (seenValues.has(v)) {
      throw new MigrationError(
        `table "${tableName}" inheritance has duplicate discriminator value "${v}"`,
      );
    }
    seenValues.add(v);
  }
  return { strategy: 'single', discriminatorColumn, discriminatorValues };
}

/**
 * Validate and canonicalize a polymorphic-relation descriptor. When
 * `columnNames` is supplied both columns must exist in the table; operation
 * validation omits it because the target table is not known there.
 */
export function normalizePolymorphic(
  raw: unknown,
  tableName: string,
  columnNames?: ReadonlySet<string>,
): TableDefinition['polymorphic'] {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new MigrationError(`table "${tableName}" "polymorphic" must be an object`);
  }
  const poly = raw as Record<string, unknown>;

  const typeColumn = poly.typeColumn;
  if (typeof typeColumn !== 'string' || typeColumn.length === 0) {
    throw new MigrationError(
      `table "${tableName}" "polymorphic.typeColumn" must be a non-empty string`,
    );
  }
  validateIdentifier(typeColumn);

  const idColumn = poly.idColumn;
  if (typeof idColumn !== 'string' || idColumn.length === 0) {
    throw new MigrationError(
      `table "${tableName}" "polymorphic.idColumn" must be a non-empty string`,
    );
  }
  validateIdentifier(idColumn);

  if (!Array.isArray(poly.targets) || poly.targets.length === 0) {
    throw new MigrationError(
      `table "${tableName}" "polymorphic.targets" must be a non-empty array`,
    );
  }
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const target of poly.targets) {
    if (typeof target !== 'string') {
      throw new MigrationError(
        `table "${tableName}" "polymorphic.targets" must contain only strings`,
      );
    }
    validateIdentifier(target);
    if (seen.has(target)) {
      throw new MigrationError(
        `table "${tableName}" "polymorphic.targets" has duplicate target "${target}"`,
      );
    }
    seen.add(target);
    targets.push(target);
  }
  targets.sort();

  if (columnNames !== undefined) {
    if (!columnNames.has(typeColumn)) {
      throw new MigrationError(
        `table "${tableName}" polymorphic type column "${typeColumn}" ` +
          `does not exist in the table's columns`,
      );
    }
    if (!columnNames.has(idColumn)) {
      throw new MigrationError(
        `table "${tableName}" polymorphic id column "${idColumn}" ` +
          `does not exist in the table's columns`,
      );
    }
  }

  return { typeColumn, idColumn, targets };
}

/**
 * Validate and canonicalize a table definition. Columns are sorted with the
 * primary key first, then by name, so table equality is order-independent.
 * Indexes and uniques are validated against the table's columns and sorted by
 * name; empty lists are omitted from the canonical form.
 */
export function normalizeTable(table: TableDefinition): TableDefinition {
  if (typeof table !== 'object' || table === null) {
    throw new MigrationError('table definition must be an object');
  }
  const t = table as unknown as Record<string, unknown>;
  const name = validateIdentifier(t.name);
  if (!Array.isArray(t.columns)) {
    throw new MigrationError(`table "${name}" "columns" must be an array`);
  }

  const columns = t.columns.map((col) => normalizeColumn(col as ColumnDefinition));
  const seen = new Set<string>();
  const pkColumns: ColumnDefinition[] = [];
  for (const column of columns) {
    if (seen.has(column.name)) {
      throw new MigrationError(`duplicate column "${column.name}" in table "${name}"`);
    }
    seen.add(column.name);
    if (column.primaryKey) {
      pkColumns.push(column);
    }
  }
  // Single-primary-key invariant: exactly one PK column must be integer.
  if (pkColumns.length === 1) {
    const pkColumn = pkColumns[0] as ColumnDefinition;
    if (pkColumn.type !== 'integer') {
      throw new MigrationError(
        `single primary key column "${pkColumn.name}" in table "${name}" must be integer type`,
      );
    }
  }

  columns.sort((a, b) => {
    const aRank = a.primaryKey ? 0 : 1;
    const bRank = b.primaryKey ? 0 : 1;
    if (aRank !== bRank) {
      return aRank - bRank;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const columnNames = new Set(columns.map((column) => column.name));

  const rawIndexes = t.indexes;
  const indexes: IndexDefinition[] = [];
  if (rawIndexes !== undefined) {
    if (!Array.isArray(rawIndexes)) {
      throw new MigrationError(`table "${name}" "indexes" must be an array`);
    }
    const seenIndexes = new Set<string>();
    for (const raw of rawIndexes) {
      const index = normalizeIndex(raw as IndexDefinition);
      if (seenIndexes.has(index.name)) {
        throw new MigrationError(
          `table "${name}" declares more than one index named "${index.name}"`,
        );
      }
      seenIndexes.add(index.name);
      assertConstraintColumns('index', index.name, index.columns, name, columnNames);
      indexes.push(index);
    }
    indexes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  const rawUniques = t.uniques;
  const uniques: UniqueDefinition[] = [];
  if (rawUniques !== undefined) {
    if (!Array.isArray(rawUniques)) {
      throw new MigrationError(`table "${name}" "uniques" must be an array`);
    }
    const seenUniques = new Set<string>();
    for (const raw of rawUniques) {
      const unique = normalizeUnique(raw as UniqueDefinition);
      if (seenUniques.has(unique.name)) {
        throw new MigrationError(
          `table "${name}" declares more than one unique constraint named "${unique.name}"`,
        );
      }
      seenUniques.add(unique.name);
      assertConstraintColumns('unique constraint', unique.name, unique.columns, name, columnNames);
      uniques.push(unique);
    }
    uniques.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  const rawForeignKeys = t.foreignKeys;
  const foreignKeys: ForeignKeyDefinition[] = [];
  if (rawForeignKeys !== undefined) {
    if (!Array.isArray(rawForeignKeys)) {
      throw new MigrationError(`table "${name}" "foreignKeys" must be an array`);
    }
    const seenForeignKeys = new Set<string>();
    for (const raw of rawForeignKeys) {
      const foreignKey = normalizeForeignKey(raw as ForeignKeyDefinition);
      if (seenForeignKeys.has(foreignKey.name)) {
        throw new MigrationError(
          `table "${name}" declares more than one foreign key named "${foreignKey.name}"`,
        );
      }
      seenForeignKeys.add(foreignKey.name);
      assertConstraintColumns(
        'foreign key',
        foreignKey.name,
        foreignKey.columns,
        name,
        columnNames,
      );
      foreignKeys.push(foreignKey);
    }
    foreignKeys.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  const rawChecks = t.checks;
  const checks: CheckDefinition[] = [];
  if (rawChecks !== undefined) {
    if (!Array.isArray(rawChecks)) {
      throw new MigrationError(`table "${name}" "checks" must be an array`);
    }
    const seenChecks = new Set<string>();
    for (const raw of rawChecks) {
      const check = normalizeCheck(raw as CheckDefinition);
      if (seenChecks.has(check.name)) {
        throw new MigrationError(
          `table "${name}" declares more than one check constraint named "${check.name}"`,
        );
      }
      seenChecks.add(check.name);
      checks.push(check);
    }
    checks.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  const rawPrimaryKeyName = t.primaryKeyName;
  if (rawPrimaryKeyName !== undefined) {
    validateIdentifier(rawPrimaryKeyName);
  }

  // Inheritance descriptor validation for single-table inheritance (STI).
  // The discriminator column must exist in the table and discriminator values
  // must be a non-empty, duplicate-free string array.
  const inheritance = normalizeInheritance(t.inheritance, name, columnNames);
  const polymorphic = normalizePolymorphic(t.polymorphic, name, columnNames);

  const out: TableDefinition = { name, columns };
  if (pkColumns.length > 0 && rawPrimaryKeyName !== undefined) {
    out.primaryKeyName = rawPrimaryKeyName as string;
  }
  if (indexes.length > 0) {
    out.indexes = indexes;
  }
  if (uniques.length > 0) {
    out.uniques = uniques;
  }
  if (foreignKeys.length > 0) {
    out.foreignKeys = foreignKeys;
  }
  if (checks.length > 0) {
    out.checks = checks;
  }
  if (inheritance !== undefined) {
    out.inheritance = inheritance;
  }
  if (polymorphic !== undefined) {
    out.polymorphic = polymorphic;
  }
  return out;
}

/** Validate and canonicalize a whole schema state. Tables are sorted by name. */
export function normalizeSchemaState(schema: SchemaState): SchemaState {
  if (typeof schema !== 'object' || schema === null) {
    throw new MigrationError('schema state must be an object');
  }
  const s = schema as unknown as Record<string, unknown>;
  if (!Array.isArray(s.tables)) {
    throw new MigrationError('schema state "tables" must be an array');
  }

  const tables = s.tables.map((table) => normalizeTable(table as TableDefinition));
  const seen = new Set<string>();
  const byName = new Map<string, TableDefinition>();
  for (const table of tables) {
    if (seen.has(table.name)) {
      throw new MigrationError(`duplicate table "${table.name}"`);
    }
    seen.add(table.name);
    byName.set(table.name, table);
  }
  tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // Cross-table validation: every foreign key must reference a real table and
  // real columns of that table.
  for (const table of tables) {
    for (const foreignKey of table.foreignKeys ?? []) {
      const referenced = byName.get(foreignKey.referencedTable);
      if (referenced === undefined) {
        throw new MigrationError(
          `foreign key "${foreignKey.name}" in table "${table.name}" references unknown table ` +
            `"${foreignKey.referencedTable}"`,
        );
      }
      const referencedColumns = new Set(referenced.columns.map((column) => column.name));
      for (const column of foreignKey.referencedColumns) {
        if (!referencedColumns.has(column)) {
          throw new MigrationError(
            `foreign key "${foreignKey.name}" in table "${table.name}" references unknown ` +
              `column "${foreignKey.referencedTable}.${column}"`,
          );
        }
      }
    }
  }

  return { tables };
}

export function emptySchema(): SchemaState {
  return { tables: [] };
}

export function columnsEqual(a: ColumnDefinition, b: ColumnDefinition): boolean {
  return JSON.stringify(normalizeColumn(a)) === JSON.stringify(normalizeColumn(b));
}

export function indexesEqual(a: IndexDefinition, b: IndexDefinition): boolean {
  return JSON.stringify(normalizeIndex(a)) === JSON.stringify(normalizeIndex(b));
}

export function uniquesEqual(a: UniqueDefinition, b: UniqueDefinition): boolean {
  return JSON.stringify(normalizeUnique(a)) === JSON.stringify(normalizeUnique(b));
}

export function foreignKeysEqual(a: ForeignKeyDefinition, b: ForeignKeyDefinition): boolean {
  return JSON.stringify(normalizeForeignKey(a)) === JSON.stringify(normalizeForeignKey(b));
}

export function checksEqual(a: CheckDefinition, b: CheckDefinition): boolean {
  return JSON.stringify(normalizeCheck(a)) === JSON.stringify(normalizeCheck(b));
}

export function inheritanceEqual(
  a: TableDefinition['inheritance'],
  b: TableDefinition['inheritance'],
): boolean {
  return (
    JSON.stringify(normalizeInheritance(a, 'table')) ===
    JSON.stringify(normalizeInheritance(b, 'table'))
  );
}

export function polymorphicEqual(
  a: TableDefinition['polymorphic'],
  b: TableDefinition['polymorphic'],
): boolean {
  return (
    JSON.stringify(normalizePolymorphic(a, 'table')) ===
    JSON.stringify(normalizePolymorphic(b, 'table'))
  );
}

export function tablesEqual(a: TableDefinition, b: TableDefinition): boolean {
  return JSON.stringify(normalizeTable(a)) === JSON.stringify(normalizeTable(b));
}

export function schemasEqual(a: SchemaState, b: SchemaState): boolean {
  return JSON.stringify(normalizeSchemaState(a)) === JSON.stringify(normalizeSchemaState(b));
}
