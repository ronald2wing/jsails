/**
 * Conversion of TypeORM entity metadata into the portable, JSON-serializable
 * {@link SchemaState} used by the migration core.
 *
 * The adapter is deliberately narrow: it accepts only the scalar column kinds
 * that the core can represent (integer / varchar / text / boolean / datetime),
 * each backed by a single generated integer primary key. Anything richer —
 * relations, foreign keys, composite keys, indexes, uniques, checks, views,
 * inheritance, embedded columns, generated UUIDs, computed columns, custom
 * transformers, raw-function defaults, custom schemas/catalogs — is rejected
 * with {@link UnsupportedSchemaError} rather than silently losing semantics.
 */

import type { EntityMetadata } from 'typeorm';
import type { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata.js';
import {
  type ColumnDefinition,
  MigrationError,
  type ScalarColumnType,
  type ScalarLiteral,
  type SchemaState,
  type TableDefinition,
  normalizeSchemaState,
  validateIdentifier,
} from '../migrations/schema-state.js';

/** Table name reserved for JSails' own migration tracking; entity tables must not use it. */
export const RESERVED_MIGRATIONS_TABLE = 'jsails_migrations';

/**
 * Raised when a TypeORM entity uses a feature that the portable schema model
 * cannot represent faithfully. Extends {@link MigrationError} so callers that
 * already handle migration errors treat it uniformly.
 */
export class UnsupportedSchemaError extends MigrationError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSchemaError';
  }
}

function unsupported(label: string, feature: string): never {
  throw new UnsupportedSchemaError(
    `${feature} is not supported by the portable schema model (${label})`,
  );
}

function describeType(type: unknown): string {
  if (typeof type === 'function') {
    return `type "${type.name}"`;
  }
  return `type ${JSON.stringify(type)}`;
}

/**
 * Map a TypeORM column type to a portable scalar type. JS constructors
 * (Number/String/Boolean/Date) are matched first so the mapping is identical
 * regardless of driver; explicit SQL type names are matched against a narrow
 * whitelist. Anything else — bigint, smallint, numeric, float, char, enum,
 * json, uuid, timestamp with/without time zone ambiguity, etc. — is rejected.
 */
function mapColumnType(column: ColumnMetadata, label: string): ScalarColumnType {
  const type: unknown = column.type;
  if (type === Number) {
    return 'integer';
  }
  if (type === String) {
    return 'varchar';
  }
  if (type === Boolean) {
    return 'boolean';
  }
  if (type === Date) {
    return 'datetime';
  }
  if (typeof type === 'string') {
    switch (type.trim().toLowerCase()) {
      case 'int':
      case 'int4':
      case 'integer':
        return 'integer';
      case 'varchar':
      case 'character varying':
      case 'varying character':
      case 'char varying':
        return 'varchar';
      case 'text':
        return 'text';
      case 'boolean':
      case 'bool':
        return 'boolean';
      case 'datetime':
      case 'timestamp without time zone':
        return 'datetime';
      default:
        break;
    }
  }
  throw new UnsupportedSchemaError(
    `column "${label}" has unsupported ${describeType(type)}; supported types are ` +
      `Number/String/Boolean/Date and the equivalent SQL types integer/int/int4, ` +
      `varchar/character varying, text, boolean/bool, datetime/timestamp without time zone`,
  );
}

/** Read the required positive integer length of a varchar column. */
function readVarcharLength(column: ColumnMetadata, label: string): number {
  const raw = column.length;
  const length = typeof raw === 'string' && raw !== '' ? Number(raw) : NaN;
  if (!Number.isInteger(length) || length <= 0) {
    throw new UnsupportedSchemaError(
      `varchar column "${label}" requires an explicit positive "length" ` +
        `(e.g. @Column({ type: "varchar", length: 100 })); use type "text" for unbounded strings`,
    );
  }
  return length;
}

/**
 * Convert a column's literal default into a portable scalar literal. Raw
 * function defaults (e.g. `() => "CURRENT_TIMESTAMP"`) and structured defaults
 * are rejected. `undefined` means "no default" (the field is simply absent).
 * An explicit `null` is rejected: TypeORM coerces `default: null` into a
 * nullable column, so silently treating it as "no default" would change the
 * column's nullability — surface it instead.
 */
function readDefault(column: ColumnMetadata, label: string): ScalarLiteral | undefined {
  const value = column.default;
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    throw new UnsupportedSchemaError(
      `column "${label}" declares an explicit null default; omit "default" to leave it ` +
        `absent (TypeORM coerces default: null into a nullable column, which the portable ` +
        `schema does not support)`,
    );
  }
  if (typeof value === 'function') {
    throw new UnsupportedSchemaError(
      `column "${label}" uses a function default (raw SQL); only scalar literal defaults are supported`,
    );
  }
  if (typeof value === 'object') {
    throw new UnsupportedSchemaError(
      `column "${label}" has a non-literal default ${JSON.stringify(value)}; ` +
        `only scalar literal defaults are supported`,
    );
  }
  // number/string/boolean: type compatibility is enforced by normalizeColumn.
  return value;
}

/** Reject column-level features the portable schema cannot represent. */
function assertSupportedColumn(column: ColumnMetadata, tableName: string): void {
  const label = `${tableName}.${column.databaseName}`;
  if (column.isVirtual || column.isVirtualProperty) {
    unsupported(label, 'virtual columns');
  }
  if (column.isObjectId) {
    unsupported(label, 'object id columns');
  }
  if (column.isDiscriminator) {
    unsupported(label, 'discriminator columns (inheritance)');
  }
  if (column.isCreateDate || column.isUpdateDate || column.isDeleteDate) {
    unsupported(
      label,
      'date columns with implicit function defaults (@CreateDateColumn/@UpdateDateColumn/@DeleteDateColumn)',
    );
  }
  if (column.isVersion) {
    unsupported(label, 'version columns');
  }
  if (
    column.isTreeLevel ||
    column.isNestedSetLeft ||
    column.isNestedSetRight ||
    column.isMaterializedPath
  ) {
    unsupported(label, 'tree columns');
  }
  if (column.relationMetadata !== undefined || column.referencedColumn !== undefined) {
    unsupported(label, 'foreign key columns');
  }
  if (column.transformer !== undefined) {
    unsupported(label, 'custom value transformers');
  }
  if (column.asExpression !== undefined) {
    unsupported(label, 'computed (generated) columns');
  }
  if (column.generatedIdentity !== undefined) {
    unsupported(label, 'Postgres IDENTITY generation');
  }
  if (column.generationStrategy === 'uuid') {
    unsupported(label, 'UUID-generated columns');
  }
  if (column.generationStrategy === 'rowid') {
    unsupported(label, 'rowid-generated columns');
  }
  if (column.isArray) {
    unsupported(label, 'array columns');
  }
  if (
    column.enum !== undefined ||
    column.enumName !== undefined ||
    column.type === 'enum' ||
    column.type === 'simple-enum' ||
    column.type === 'set'
  ) {
    unsupported(label, 'enum/set columns');
  }
  if (column.spatialFeatureType !== undefined || column.srid !== undefined) {
    unsupported(label, 'spatial columns');
  }
  if (column.unsigned) {
    unsupported(label, 'unsigned numeric columns');
  }
  if (column.charset !== undefined || column.collation !== undefined) {
    unsupported(label, 'column charset/collation');
  }
  if (column.onUpdate !== undefined) {
    unsupported(label, 'ON UPDATE triggers');
  }
  if (column.precision !== undefined && column.precision !== null) {
    unsupported(label, 'column precision');
  }
  if (column.scale !== undefined && column.scale !== null) {
    unsupported(label, 'column scale');
  }
  if (column.comment !== undefined) {
    unsupported(label, 'column comments');
  }
  if (column.query !== undefined) {
    unsupported(label, 'virtual column queries');
  }
  if (column.hstoreType !== undefined) {
    unsupported(label, 'HSTORE columns');
  }
}

function convertColumn(column: ColumnMetadata, tableName: string): ColumnDefinition {
  const label = `${tableName}.${column.databaseName}`;
  assertSupportedColumn(column, tableName);

  const type = mapColumnType(column, label);
  const name = column.databaseName;
  validateIdentifier(name);

  const isPrimary = column.isPrimary;
  if (isPrimary) {
    if (!column.isGenerated) {
      throw new UnsupportedSchemaError(
        `column "${label}" is a primary key without generation (@PrimaryColumn); ` +
          `only generated integer primary keys (@PrimaryGeneratedColumn) are supported`,
      );
    }
    // generationStrategy is typed without "identity" (Postgres IDENTITY), but
    // `@PrimaryGeneratedColumn("identity")` sets it at runtime; treat it as an
    // integer-generation strategy.
    const strategy = column.generationStrategy as string | undefined;
    if (strategy !== 'increment' && strategy !== 'identity') {
      throw new UnsupportedSchemaError(
        `column "${label}" uses unsupported generation strategy ${JSON.stringify(strategy)}`,
      );
    }
    if (type !== 'integer') {
      throw new UnsupportedSchemaError(
        `primary key column "${label}" must map to integer, got "${type}"`,
      );
    }
  } else if (column.isGenerated) {
    throw new UnsupportedSchemaError(`column "${label}" is generated but is not the primary key`);
  }

  const definition: ColumnDefinition = { name, type, nullable: column.isNullable };

  if (type === 'varchar') {
    definition.length = readVarcharLength(column, label);
  }

  if (isPrimary) {
    definition.primaryKey = true;
  }

  const defaultValue = readDefault(column, label);
  if (defaultValue !== undefined) {
    definition.default = defaultValue;
  }

  return definition;
}

/** Reject entity-level features the portable schema cannot represent. */
function assertSupportedEntity(metadata: EntityMetadata): void {
  const label = metadata.name;

  if (metadata.tableType !== 'regular') {
    unsupported(label, `tables of type "${metadata.tableType}"`);
  }
  if (metadata.inheritancePattern !== undefined || metadata.discriminatorColumn !== undefined) {
    unsupported(label, 'inheritance (single-table / discriminator)');
  }
  if (metadata.parentEntityMetadata !== undefined || metadata.childEntityMetadatas.length > 0) {
    unsupported(label, 'inheritance');
  }
  if (metadata.treeType !== undefined) {
    unsupported(label, 'tree entities');
  }
  if (metadata.isJunction || metadata.isClosureJunction) {
    unsupported(label, 'junction tables');
  }
  if (metadata.schema !== undefined) {
    unsupported(label, `custom schema "${metadata.schema}"`);
  }
  if (metadata.database !== undefined) {
    unsupported(label, `custom catalog/database "${metadata.database}"`);
  }
  if (metadata.engine !== undefined) {
    unsupported(label, `table engine "${metadata.engine}"`);
  }
  if (metadata.comment !== undefined) {
    unsupported(label, 'table comments');
  }
  if (metadata.synchronize === false) {
    unsupported(label, 'entities excluded from schema sync (synchronize: false)');
  }
  if (metadata.relations.length > 0) {
    unsupported(label, 'entity relations');
  }
  if (metadata.foreignKeys.length > 0) {
    unsupported(label, 'foreign keys');
  }
  if (metadata.primaryColumns.length > 1) {
    unsupported(label, 'composite primary keys');
  }
  if (metadata.embeddeds.length > 0) {
    unsupported(label, 'embedded columns');
  }
  if (metadata.indices.length > 0) {
    unsupported(label, 'indexes');
  }
  if (metadata.uniques.length > 0) {
    unsupported(label, 'unique constraints');
  }
  if (metadata.checks.length > 0) {
    unsupported(label, 'check constraints');
  }
  if (metadata.exclusions.length > 0) {
    unsupported(label, 'exclusion constraints');
  }
  // Note: `metadata.hasUUIDGeneratedColumns` is NOT used here — despite its name
  // TypeORM sets it for any generated column (including the increment primary
  // key). UUID generation is instead detected per-column via
  // `column.generationStrategy === "uuid"`.
}

function convertEntity(metadata: EntityMetadata): TableDefinition {
  assertSupportedEntity(metadata);

  const tableName = metadata.tableName;
  validateIdentifier(tableName);
  if (tableName === RESERVED_MIGRATIONS_TABLE) {
    throw new UnsupportedSchemaError(
      `entity "${metadata.name}" maps to reserved table name "${RESERVED_MIGRATIONS_TABLE}"`,
    );
  }

  const columns = metadata.columns.map((column) => convertColumn(column, tableName));
  return { name: tableName, columns };
}

/**
 * Convert built TypeORM entity metadata into a normalized portable
 * {@link SchemaState}. The mapping is driver-independent so that the same
 * entity yields the same logical schema on every supported driver.
 */
export function buildSchemaStateFromMetadatas(
  entityMetadatas: readonly EntityMetadata[],
): SchemaState {
  const tables = entityMetadatas.map(convertEntity);
  return normalizeSchemaState({ tables });
}
