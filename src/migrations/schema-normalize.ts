/**
 * Validation and canonicalization of the portable schema model.
 *
 * Every `normalizeX` returns a fresh object with only the meaningful fields set
 * and in a deterministic order, so two schemas that differ only in field order
 * or omitted-vs-empty lists compare equal via `JSON.stringify`. All input here
 * may be untrusted JSON (a stored migration definition), so every field is
 * checked structurally before it is trusted.
 */

import {
  MigrationError,
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
} from './schema-types.js';
import { assertLiteralMatchesType, validateIdentifier } from './schema-validation.js';

const DEFERRABLE_VALUES = new Set<Deferrable>([
  'INITIALLY_IMMEDIATE',
  'INITIALLY_DEFERRED',
  'NOT_DEFERRABLE',
]);

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

function isScalarType(value: unknown): value is ScalarColumnType {
  return typeof value === 'string' && SCALAR_TYPES.has(value as ScalarColumnType);
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
