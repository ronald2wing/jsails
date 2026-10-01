/**
 * Conversion of TypeORM entity metadata into the portable, JSON-serializable
 * {@link SchemaState} used by the migration core.
 *
 * The adapter is deliberately narrow: it accepts scalar column kinds
 * (integer / varchar / text / boolean / datetime), a single generated integer
 * primary key or a composite primary key, plus simple (non-partial,
 * non-expression) indexes, simple unique constraints, and single- or
 * multi-column many-to-one foreign keys with ON DELETE / ON UPDATE actions.
 * Deferrable foreign keys and unique constraints are supported on Postgres
 * only. Many-to-many relations are supported through explicit junction-table
 * entities (a regular entity with two many-to-one foreign keys and a single
 * generated primary key) or auto-generated @JoinTable junction tables
 * (which carry a composite primary key). Anything richer — partial/expression
 * indexes, checks, views, embedded columns, generated UUIDs, computed columns,
 * custom transformers, raw-function defaults, custom schemas/catalogs — is
 * rejected with {@link UnsupportedSchemaError} rather than silently losing
 * semantics.
 */

import type { EntityMetadata } from 'typeorm';
import { getMetadataArgsStorage } from 'typeorm';
import type { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata.js';
import type { IndexMetadata } from 'typeorm/metadata/IndexMetadata.js';
import type { UniqueMetadata } from 'typeorm/metadata/UniqueMetadata.js';
import {
  type ColumnDefinition,
  columnsEqual,
  type Deferrable,
  type ForeignKeyAction,
  type ForeignKeyDefinition,
  type IndexDefinition,
  MigrationError,
  type ScalarColumnType,
  type ScalarLiteral,
  type SchemaState,
  type TableDefinition,
  type UniqueDefinition,
  normalizeSchemaState,
  validateIdentifier,
} from '../migrations/schema-state.js';

import { resolvePolymorphicDescriptor } from './polymorphic.js';

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
      case 'decimal':
      case 'numeric':
        return 'decimal';
      case 'float':
      case 'float8':
      case 'double precision':
      case 'double':
        return 'float';
      case 'bigint':
      case 'int8':
        return 'bigint';
      case 'uuid':
        return 'uuid';
      case 'json':
      case 'jsonb':
        return 'json';
      case 'date':
        return 'date';
      case 'time':
      case 'time without time zone':
        return 'time';
      default:
        break;
    }
  }
  throw new UnsupportedSchemaError(
    `column "${label}" has unsupported ${describeType(type)}; supported types are ` +
      `Number/String/Boolean/Date and the equivalent SQL types integer/int/int4, ` +
      `varchar/character varying, text, boolean/bool, datetime/timestamp without time zone, ` +
      `decimal/numeric, float/float8/double precision/double, bigint/int8, uuid, ` +
      `json/jsonb, date, time/time without time zone`,
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
  // Relation join columns (a @ManyToOne declared without an explicit @Column)
  // are virtual in TypeORM's model but back real foreign keys; they are
  // converted like any other scalar column below. Only genuinely virtual
  // columns are rejected.
  // Discriminator columns (STI) are flagged as virtual properties by TypeORM
  // but back real varchar data — accept them here and convert them normally below.
  if (
    (column.isVirtual || column.isVirtualProperty) &&
    column.referencedColumn === undefined &&
    !column.isDiscriminator
  ) {
    unsupported(label, 'virtual columns');
  }
  if (column.isObjectId) {
    unsupported(label, 'object id columns');
  }
  // Discriminator columns are now supported as normal varchar columns; STI
  // is handled at the entity level (see convertStiEntity).
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
  // Join columns (a scalar column backing a relation's foreign key) are
  // supported and converted like any other scalar column; the relation shape
  // itself is validated in assertSupportedRelations.
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

function convertColumn(
  column: ColumnMetadata,
  tableName: string,
  isSinglePk: boolean,
): ColumnDefinition {
  const label = `${tableName}.${column.databaseName}`;
  assertSupportedColumn(column, tableName);

  const type = mapColumnType(column, label);
  const name = column.databaseName;
  validateIdentifier(name);

  const isPrimary = column.isPrimary;
  const isMtiPk = isPrimary && !column.isGenerated && column.relationMetadata !== undefined;
  if (isPrimary) {
    if (isSinglePk) {
      if (isMtiPk) {
        // Multi-table inheritance: the PK is also a one-to-one FK to the
        // parent table, so it is not auto-generated — its value comes from
        // the parent row. Only integer PKs are supported (foreign key
        // integrity requires type compatibility with the parent PK).
        if (type !== 'integer') {
          throw new UnsupportedSchemaError(
            `table-inherited primary key column "${label}" must map to integer, got "${type}"`,
          );
        }
        if (column.isNullable) {
          throw new UnsupportedSchemaError(
            `table-inherited primary key column "${label}" must not be nullable`,
          );
        }
      } else {
        // Single generated PK: must be integer, generated, with a valid strategy.
        if (!column.isGenerated) {
          throw new UnsupportedSchemaError(
            `column "${label}" is a primary key without generation (@PrimaryColumn); ` +
              `only generated integer primary keys (@PrimaryGeneratedColumn) are supported`,
          );
        }
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
      }
    } else {
      // Composite PK column (@PrimaryColumn): must not be generated, any
      // scalar type is accepted (the portable schema enforces non-nullable +
      // no default at normalization time).
      if (column.isGenerated) {
        throw new UnsupportedSchemaError(
          `composite primary key column "${label}" must not be generated; ` +
            `use @PrimaryColumn instead of @PrimaryGeneratedColumn`,
        );
      }
    }
  } else if (column.isGenerated) {
    throw new UnsupportedSchemaError(`column "${label}" is generated but is not the primary key`);
  }

  const definition: ColumnDefinition = { name, type, nullable: column.isNullable };

  if (type === 'varchar') {
    definition.length = readVarcharLength(column, label);
  }

  if (type === 'decimal') {
    const precision = column.precision;
    if (typeof precision === 'number' && precision !== null) {
      definition.precision = precision;
    }
    const scale = column.scale;
    if (typeof scale === 'number' && scale !== null) {
      definition.scale = scale;
    }
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

/**
 * Convert a TypeORM index into a portable {@link IndexDefinition}, rejecting any
 * feature the portable model cannot represent: partial/filtered indexes
 * (`where`), expression or ordered column lists, spatial/fulltext/parser/concurrent
 * modifiers, custom index types, and indexes excluded from schema sync.
 */
function convertIndex(index: IndexMetadata, tableName: string): IndexDefinition {
  const name = index.name;
  validateIdentifier(name);
  const label = `${tableName}.${name}`;
  if (index.synchronize === false) {
    unsupported(label, 'indexes excluded from schema sync (synchronize: false)');
  }
  if (index.where !== undefined) {
    unsupported(label, 'partial/filtered indexes (where)');
  }
  if (index.isSpatial) {
    unsupported(label, 'spatial indexes');
  }
  if (index.isFulltext) {
    unsupported(label, 'fulltext indexes');
  }
  if (index.isNullFiltered) {
    unsupported(label, 'null-filtered indexes');
  }
  if (index.isConcurrent) {
    unsupported(label, 'concurrent index builds');
  }
  if (index.parser !== undefined) {
    unsupported(label, 'fulltext index parsers');
  }
  if (index.type !== undefined) {
    unsupported(label, 'custom index types');
  }
  if (typeof index.givenColumnNames === 'function') {
    unsupported(label, 'expression or ordered index column lists');
  }
  const columns = index.columns.map((column) => {
    const columnName = column.databaseName;
    validateIdentifier(columnName);
    return columnName;
  });
  return { name, columns, unique: index.isUnique };
}

/**
 * Convert a TypeORM unique constraint into a portable {@link UniqueDefinition},
 * rejecting deferred constraints and expression/ordered column lists.
 */
function convertUnique(unique: UniqueMetadata, tableName: string): UniqueDefinition {
  const name = unique.name;
  validateIdentifier(name);
  const label = `${tableName}.${name}`;
  if (typeof unique.givenColumnNames === 'function') {
    unsupported(label, 'expression or ordered unique column lists');
  }
  const columns = unique.columns.map((column) => {
    const columnName = column.databaseName;
    validateIdentifier(columnName);
    return columnName;
  });
  const definition: UniqueDefinition = { name, columns };
  if (unique.deferrable !== undefined) {
    definition.deferrable = mapDeferrable(unique.deferrable, label);
  }
  return definition;
}

/** Reject entity-level features the portable schema cannot represent. */
function assertSupportedEntity(metadata: EntityMetadata): void {
  const label = metadata.name;

  // Junction tables produced by @JoinTable carry tableType 'junction'; allow
  // them through — composite primary keys are now supported.
  if (metadata.tableType !== 'regular' && metadata.tableType !== 'junction') {
    unsupported(label, `tables of type "${metadata.tableType}"`);
  }

  if (metadata.treeType !== undefined) {
    unsupported(label, 'tree entities');
  }
  // M2M junction tables are now converted as normal tables.  Auto-generated
  // @JoinTable junction tables carry composite primary keys (both join columns)
  // and are accepted below.
  if (metadata.isClosureJunction) {
    unsupported(label, 'closure junction tables');
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
  if (metadata.embeddeds.length > 0) {
    unsupported(label, 'embedded columns');
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

/**
 * Verify that every declared relation is representable in the portable
 * schema model. Many-to-one (owning), one-to-many (inverse, ignored),
 * many-to-many (through junction-table entities), and one-to-one are all
 * supported. One-to-one is the latest addition: the owning side contributes
 * a foreign key (picked up from metadata.foreignKeys) and a synthesized
 * unique constraint on the join column(s) (see {@link synthesizeOneToOneUniques}).
 */
function assertSupportedRelations(_metadata: EntityMetadata): void {
  // No relation shapes are currently rejected here.
}

/**
 * Synthesize unique constraints for owning-side one-to-one relations.
 * TypeORM emits a foreign key for a one-to-one owning side, but does not
 * automatically declare a unique constraint on the join column(s). Without
 * that constraint the column allows duplicate values, which violates the
 * one-to-one contract. This function creates a {@link UniqueDefinition} for
 * every owning-side one-to-one join column set not already covered by an
 * explicit {@link UniqueMetadata} on the entity.
 */
function synthesizeOneToOneUniques(metadata: EntityMetadata): UniqueDefinition[] {
  const uniques: UniqueDefinition[] = [];
  const existingColumnSets = new Set(
    metadata.uniques.map((u) =>
      u.columns
        .map((c) => c.databaseName)
        .sort()
        .join(','),
    ),
  );
  const pkColumnNames = new Set(metadata.primaryColumns.map((c) => c.databaseName));
  for (const relation of metadata.relations) {
    if (!relation.isOneToOne || !relation.isOwning) {
      continue;
    }
    const joinColumnNames = relation.joinColumns.map((jc) => jc.databaseName);
    if (joinColumnNames.length === 0) {
      continue;
    }
    if (existingColumnSets.has(joinColumnNames.slice().sort().join(','))) {
      continue;
    }
    // When the join columns are the primary key columns (the MTI case), the
    // PK itself enforces uniqueness so no separate unique is needed.
    if (joinColumnNames.every((c) => pkColumnNames.has(c))) {
      continue;
    }
    const name = `UQ_${metadata.tableName}_${joinColumnNames.join('_')}`;
    validateIdentifier(name);
    uniques.push({ name, columns: joinColumnNames });
  }
  return uniques;
}

/** Map a TypeORM ON DELETE/ON UPDATE action onto the portable action set. */
function mapForeignKeyAction(
  value: string | undefined,
  label: string,
  kind: string,
): ForeignKeyAction | undefined {
  switch (value) {
    case undefined:
    case 'DEFAULT':
      return undefined;
    case 'CASCADE':
      return 'cascade';
    case 'RESTRICT':
      return 'restrict';
    case 'SET NULL':
      return 'setNull';
    case 'NO ACTION':
      return 'noAction';
    default:
      throw new UnsupportedSchemaError(
        `foreign key ${label} has unsupported ${kind} ${JSON.stringify(value)}`,
      );
  }
}

/** Map TypeORM's DeferrableType onto the portable {@link Deferrable} set. */
function mapDeferrable(value: string | undefined, label: string): Deferrable {
  switch (value) {
    case 'INITIALLY IMMEDIATE':
      return 'INITIALLY_IMMEDIATE';
    case 'INITIALLY DEFERRED':
      return 'INITIALLY_DEFERRED';
    default:
      throw new UnsupportedSchemaError(
        `${label} has unsupported deferrable ${JSON.stringify(value)}`,
      );
  }
}

/**
 * Convert TypeORM foreign-key metadata into portable foreign keys. Both single-
 * and multi-column (composite) foreign keys are accepted.
 */
function convertForeignKeys(metadata: EntityMetadata, tableName: string): ForeignKeyDefinition[] {
  const keys: ForeignKeyDefinition[] = [];
  for (const foreignKey of metadata.foreignKeys) {
    const label = `${tableName}.${foreignKey.name}`;
    const name = foreignKey.name;
    validateIdentifier(name);
    const referencedTable = foreignKey.referencedEntityMetadata.tableName;
    validateIdentifier(referencedTable);

    const columns = foreignKey.columnNames.map((cn) => {
      validateIdentifier(cn);
      return cn;
    });
    const referencedColumns = foreignKey.referencedColumnNames.map((cn) => {
      validateIdentifier(cn);
      return cn;
    });

    const definition: ForeignKeyDefinition = {
      name,
      columns,
      referencedTable,
      referencedColumns,
    };
    const onDelete = mapForeignKeyAction(foreignKey.onDelete, label, 'onDelete');
    if (onDelete !== undefined) {
      definition.onDelete = onDelete;
    }
    const onUpdate = mapForeignKeyAction(foreignKey.onUpdate, label, 'onUpdate');
    if (onUpdate !== undefined) {
      definition.onUpdate = onUpdate;
    }
    if (foreignKey.deferrable !== undefined) {
      definition.deferrable = mapDeferrable(foreignKey.deferrable, label);
    }
    keys.push(definition);
  }
  return keys;
}

/**
 * Resolve the target classes in a polymorphic descriptor to their table names.
 * Throws when a target class has no registered table metadata.
 */
function resolvePolymorphicTargets(
  descriptor: { typeColumn: string; idColumn: string; targetClasses: Function[] },
  tableName: string,
): { typeColumn: string; idColumn: string; targets: string[] } {
  const targetTableNames = descriptor.targetClasses.map((targetClass) => {
    const tableArg = getMetadataArgsStorage().tables.find((t) => t.target === targetClass);
    if (!tableArg) {
      throw new UnsupportedSchemaError(
        `polymorphic relation on "${tableName}" references target "${targetClass.name}" ` +
          `which has no registered table metadata`,
      );
    }
    return tableArg.name ?? targetClass.name;
  });
  return {
    typeColumn: descriptor.typeColumn,
    idColumn: descriptor.idColumn,
    targets: targetTableNames,
  };
}

function convertEntity(metadata: EntityMetadata): TableDefinition {
  assertSupportedEntity(metadata);
  assertSupportedRelations(metadata);

  const tableName = metadata.tableName;
  validateIdentifier(tableName);
  if (tableName === RESERVED_MIGRATIONS_TABLE) {
    throw new UnsupportedSchemaError(
      `entity "${metadata.name}" maps to reserved table name "${RESERVED_MIGRATIONS_TABLE}"`,
    );
  }

  const isSinglePk = metadata.primaryColumns.length <= 1;
  const columns = metadata.columns.map((column) => convertColumn(column, tableName, isSinglePk));

  const table: TableDefinition = { name: tableName, columns };
  if (metadata.indices.length > 0) {
    table.indexes = metadata.indices.map((index) => convertIndex(index, tableName));
  }
  if (metadata.uniques.length > 0) {
    table.uniques = metadata.uniques.map((unique) => convertUnique(unique, tableName));
  }
  const oneToOneUniques = synthesizeOneToOneUniques(metadata);
  if (oneToOneUniques.length > 0) {
    if (!table.uniques) {
      table.uniques = [];
    }
    table.uniques.push(...oneToOneUniques);
  }
  const foreignKeys = convertForeignKeys(metadata, tableName);
  if (foreignKeys.length > 0) {
    table.foreignKeys = foreignKeys;
  }

  const polyDesc =
    typeof metadata.target === 'function'
      ? resolvePolymorphicDescriptor(metadata.target)
      : undefined;
  if (polyDesc) {
    table.polymorphic = resolvePolymorphicTargets(polyDesc, tableName);
  }

  return table;
}

/**
 * Convert an STI parent and all its children into a single table definition.
 * All columns, indexes, uniques, and foreign keys from every entity in the
 * hierarchy are merged into one table. Columns with the same name must have
 * an identical definition, otherwise a conflict is reported.
 */
function convertStiEntity(metadata: EntityMetadata): TableDefinition {
  assertSupportedEntity(metadata);
  assertSupportedRelations(metadata);

  const tableName = metadata.tableName;
  validateIdentifier(tableName);
  if (tableName === RESERVED_MIGRATIONS_TABLE) {
    throw new UnsupportedSchemaError(
      `entity "${metadata.name}" maps to reserved table name "${RESERVED_MIGRATIONS_TABLE}"`,
    );
  }

  const allEntities = [metadata, ...metadata.childEntityMetadatas];

  // Collect columns from parent and every child, deduplicating by name.
  // Columns must have an identical definition across entities; a mismatch
  // is a data-integrity hazard.
  const columnMap = new Map<string, ColumnDefinition>();
  for (const entity of allEntities) {
    const isSinglePk = entity.primaryColumns.length <= 1;
    for (const column of entity.columns) {
      const def = convertColumn(column, tableName, isSinglePk);
      const existing = columnMap.get(def.name);
      if (existing !== undefined) {
        if (!columnsEqual(existing, def)) {
          throw new UnsupportedSchemaError(
            `conflicting column "${def.name}" in STI table "${tableName}": ` +
              `child entity "${entity.name}" redeclares it with a different definition`,
          );
        }
        continue;
      }
      columnMap.set(def.name, def);
    }
  }
  const columns = [...columnMap.values()];

  // Collect indexes from every entity in the hierarchy.
  const indexMap = new Map<string, IndexDefinition>();
  for (const entity of allEntities) {
    for (const index of entity.indices) {
      const def = convertIndex(index, tableName);
      if (indexMap.has(def.name)) {
        continue;
      }
      indexMap.set(def.name, def);
    }
  }

  // Collect unique constraints from every entity.
  const uniqueMap = new Map<string, UniqueDefinition>();
  for (const entity of allEntities) {
    for (const unique of entity.uniques) {
      const def = convertUnique(unique, tableName);
      if (uniqueMap.has(def.name)) {
        continue;
      }
      uniqueMap.set(def.name, def);
    }
  }

  // Collect foreign keys from every entity.
  const fkMap = new Map<string, ForeignKeyDefinition>();
  for (const entity of allEntities) {
    for (const fk of convertForeignKeys(entity, tableName)) {
      if (fkMap.has(fk.name)) {
        continue;
      }
      fkMap.set(fk.name, fk);
    }
  }

  const table: TableDefinition = { name: tableName, columns };

  if (indexMap.size > 0) {
    table.indexes = [...indexMap.values()];
  }
  if (uniqueMap.size > 0) {
    table.uniques = [...uniqueMap.values()];
  }

  // Synthesize one-to-one uniques across every entity in the hierarchy.
  const oneToOneUniques: UniqueDefinition[] = [];
  const existingUniqueNames = new Set(uniqueMap.keys());
  for (const entity of allEntities) {
    for (const uq of synthesizeOneToOneUniques(entity)) {
      if (!existingUniqueNames.has(uq.name)) {
        oneToOneUniques.push(uq);
        existingUniqueNames.add(uq.name);
      }
    }
  }
  if (oneToOneUniques.length > 0) {
    if (!table.uniques) {
      table.uniques = [];
    }
    table.uniques.push(...oneToOneUniques);
  }

  if (fkMap.size > 0) {
    table.foreignKeys = [...fkMap.values()];
  }

  // Polymorphic descriptor: attached to the shared table from the parent entity.
  const polyDesc =
    typeof metadata.target === 'function'
      ? resolvePolymorphicDescriptor(metadata.target)
      : undefined;
  if (polyDesc) {
    table.polymorphic = resolvePolymorphicTargets(polyDesc, tableName);
  }

  // Inheritance descriptor: the discriminator column name and the sorted
  // list of child discriminator values.
  const discriminatorColumnName = metadata.discriminatorColumn!.databaseName;
  const discriminatorValues = metadata.childEntityMetadatas
    .map((child) => child.discriminatorValue!)
    .filter((v): v is string => v !== undefined)
    .sort();

  table.inheritance = {
    strategy: 'single',
    discriminatorColumn: discriminatorColumnName,
    discriminatorValues,
  };

  return table;
}

/**
 * Convert built TypeORM entity metadata into a normalized portable
 * {@link SchemaState}. The mapping is driver-independent so that the same
 * entity yields the same logical schema on every supported driver.
 *
 * For single-table inheritance (STI), the parent and all children share one
 * table — only one table definition is emitted per hierarchy, with all columns
 * from every entity merged and an {@link TableDefinition.inheritance} descriptor
 * recording the discriminator shape.
 */
export function buildSchemaStateFromMetadatas(
  entityMetadatas: readonly EntityMetadata[],
): SchemaState {
  const visited = new Set<string>();
  const tables: TableDefinition[] = [];

  for (const metadata of entityMetadatas) {
    const tableName = metadata.tableName;
    if (visited.has(tableName)) {
      continue;
    }
    visited.add(tableName);

    if (metadata.inheritancePattern === 'STI') {
      tables.push(convertStiEntity(metadata));
      for (const child of metadata.childEntityMetadatas) {
        visited.add(child.tableName);
      }
    } else {
      tables.push(convertEntity(metadata));
    }
  }

  return normalizeSchemaState({ tables });
}
