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
export type ScalarColumnType = 'integer' | 'varchar' | 'text' | 'boolean' | 'datetime';

/** A scalar literal usable as a column default. `null` is not a default. */
export type ScalarLiteral = string | number | boolean;

export interface ColumnDefinition {
  name: string;
  type: ScalarColumnType;
  /** Explicit nullability. `false` means NOT NULL. */
  nullable: boolean;
  /** Required when `type` is `varchar`; a positive integer. Ignored otherwise. */
  length?: number;
  /**
   * Marks the generated integer primary key. At most one per table; must be
   * `integer`, non-nullable, and have no default. Generation (identity/serial)
   * is implied by this flag.
   */
  primaryKey?: boolean;
  /** Scalar literal default; must match the column type. */
  default?: ScalarLiteral;
}

export interface TableDefinition {
  name: string;
  columns: ColumnDefinition[];
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
  // varchar / text / datetime
  if (typeof value !== 'string') {
    literalTypeMismatch(value, type, columnName);
  }
  assertPortableStringLiteral(value, `default for ${type} column "${columnName}"`);
  if (type === 'datetime') {
    assertValidDatetimeLiteral(value, columnName);
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

  const primaryKey = c.primaryKey === true;
  if (primaryKey) {
    if (type !== 'integer') {
      throw new MigrationError(`primary key column "${name}" must be integer type`);
    }
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
  if (primaryKey) {
    out.primaryKey = true;
  }
  if (defaultValue !== undefined) {
    out.default = defaultValue as ScalarLiteral;
  }
  return out;
}

/**
 * Validate and canonicalize a table definition. Columns are sorted with the
 * primary key first, then by name, so table equality is order-independent.
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
  let primaryKeyCount = 0;
  for (const column of columns) {
    if (seen.has(column.name)) {
      throw new MigrationError(`duplicate column "${column.name}" in table "${name}"`);
    }
    seen.add(column.name);
    if (column.primaryKey) {
      primaryKeyCount += 1;
    }
  }
  if (primaryKeyCount > 1) {
    throw new MigrationError(`table "${name}" declares more than one primary key`);
  }

  columns.sort((a, b) => {
    const aRank = a.primaryKey ? 0 : 1;
    const bRank = b.primaryKey ? 0 : 1;
    if (aRank !== bRank) {
      return aRank - bRank;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  return { name, columns };
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
  for (const table of tables) {
    if (seen.has(table.name)) {
      throw new MigrationError(`duplicate table "${table.name}"`);
    }
    seen.add(table.name);
  }
  tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { tables };
}

export function emptySchema(): SchemaState {
  return { tables: [] };
}

export function columnsEqual(a: ColumnDefinition, b: ColumnDefinition): boolean {
  return JSON.stringify(normalizeColumn(a)) === JSON.stringify(normalizeColumn(b));
}

export function tablesEqual(a: TableDefinition, b: TableDefinition): boolean {
  return JSON.stringify(normalizeTable(a)) === JSON.stringify(normalizeTable(b));
}

export function schemasEqual(a: SchemaState, b: SchemaState): boolean {
  return JSON.stringify(normalizeSchemaState(a)) === JSON.stringify(normalizeSchemaState(b));
}
