/**
 * Read-only, in-memory Active Record data source backed by TypeORM's `sqljs`
 * driver. `FileDataSource.create` seeds a transient SQLite database from JSON
 * files or in-memory row arrays and then flips the database into `query_only`
 * mode, so the same `BaseEntity` static queries (`User.find`,
 * `User.findOneBy`, `User.count`, ...) that work against a real
 * `JsailsDataSource` also work against seeded data — while any write
 * (`save`, `insert`, `update`, `delete`, `remove`) fails at the SQLite level.
 *
 * This is a convenience for tests, demos, and read-only data catalogs. It is
 * deliberately not a sandbox: a trusted caller can reach the underlying
 * `DataSource` (and re-enable writes) through
 * `handle.getRepository(Entity).manager.connection`. Nothing here guards
 * against that — the `query_only` guard only stops accidental writes through
 * the Active Record API.
 *
 * The raw `DataSource` is held privately (composition, not inheritance) so the
 * handle cannot accidentally be mistaken for, or mutated like, a writable
 * connection. Closing a handle restores the previous `BaseEntity` data-source
 * binding rather than tearing down a binding that another data source may have
 * taken over.
 */

import { readFile } from 'node:fs/promises';

import { DataSource, EntitySchema } from 'typeorm';
import type { BaseEntity } from 'typeorm';
import type { EntityMetadata } from 'typeorm';
import type { EntityTarget } from 'typeorm';
import type { Repository } from 'typeorm';
import type { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata.js';

import { buildSchemaStateFromMetadatas } from './model-schema.js';

/** Error raised for any invalid `FileDataSource` model, seed data, or lifecycle misuse. */
export class FileDataSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileDataSourceError';
  }
}

/** A seedable entity: a `BaseEntity` subclass or an explicit `EntitySchema`. */
export type FileDataSourceEntity = typeof BaseEntity | EntitySchema;

/** One model: an entity plus an in-memory row array, or an entity plus a JSON file path. */
export type FileDataSourceModel =
  | { entity: FileDataSourceEntity; rows: readonly Record<string, unknown>[] }
  | { entity: FileDataSourceEntity; file: string };

/** Options accepted by {@link FileDataSource.create}. */
export interface FileDataSourceOptions {
  models: readonly FileDataSourceModel[];
}

type ScalarKind = 'integer' | 'boolean' | 'datetime' | 'string';

/**
 * Read-only Active Record data source. Create instances via
 * {@link FileDataSource.create}; never construct directly.
 */
export class FileDataSource {
  /** File-backed data sources are always read-only. */
  readonly isReadOnly = true as const;

  private readonly dataSource: DataSource;
  private readonly targets: readonly Function[];
  private readonly snapshots: ReadonlyMap<Function, DataSource | null>;
  private closed = false;

  private constructor(
    dataSource: DataSource,
    targets: readonly Function[],
    snapshots: ReadonlyMap<Function, DataSource | null>,
  ) {
    this.dataSource = dataSource;
    this.targets = targets;
    this.snapshots = snapshots;
  }

  /**
   * Seed an in-memory, read-only data source. Each model's entity must already
   * be declared (via decorators or an `EntitySchema`); the schema is validated
   * against the portable schema model, and every row is validated against that
   * schema, before any row is written.
   */
  static async create(options: FileDataSourceOptions): Promise<FileDataSource> {
    const models = validateModels(options.models);
    const entities = models.map((model) => model.entity);

    // Resolve the BaseEntity target classes up front, snapshot their current
    // data-source bindings, and reserve them — all synchronously, before any
    // `await` — so two concurrent creates for the same entity cannot both
    // succeed.
    const targets: Function[] = [];
    const snapshots = new Map<Function, DataSource | null>();
    {
      const seen = new Set<Function>();
      for (const model of models) {
        const target = baseEntityTargetOf(model.entity);
        if (target === null) {
          continue;
        }
        const label = entityLabel(model.entity);
        if (seen.has(target)) {
          throw new FileDataSourceError(`models contain entity "${label}" more than once`);
        }
        seen.add(target);
        if (RESERVED.has(target)) {
          throw new FileDataSourceError(
            `entity "${label}" is already owned by another open FileDataSource`,
          );
        }
        const current = currentBinding(target);
        if (current?.isInitialized) {
          throw new FileDataSourceError(
            `entity "${label}" is already bound to an initialized data source; ` +
              `close or unbind it before creating a FileDataSource for the same entity`,
          );
        }
        snapshots.set(target, current);
        targets.push(target);
      }
    }
    for (const target of targets) {
      RESERVED.add(target);
    }

    const dataSource = new DataSource({ type: 'sqljs', entities });

    try {
      // Read each file exactly once and pre-validate every source is an array
      // of plain objects before touching the ORM.
      const rowsByModel = await Promise.all(models.map(loadRows));

      await dataSource.initialize();

      // Reject relations, composite keys, and non-scalar column types up front
      // (throws UnsupportedSchemaError) instead of silently losing semantics.
      buildSchemaStateFromMetadatas(dataSource.entityMetadatas);

      // Create the tables. The sqljs driver is transient and migration-free, so
      // `synchronize` is the only way to materialize the schema.
      await dataSource.synchronize();

      for (let i = 0; i < models.length; i += 1) {
        await seedModel(dataSource, models[i]!, rowsByModel[i]!);
      }

      enableReadOnly(dataSource);
    } catch (error) {
      // Release reservations and restore each prior binding only if this data
      // source still owns it (a binding may have been taken over meanwhile).
      for (const target of targets) {
        RESERVED.delete(target);
        if (currentBinding(target) === dataSource) {
          setBinding(target, snapshots.get(target) ?? null);
        }
      }
      if (dataSource.isInitialized) {
        await dataSource.destroy().catch(() => {});
      }
      throw error;
    }

    return new FileDataSource(dataSource, targets, snapshots);
  }

  /** Whether the underlying connection is still open. */
  get isInitialized(): boolean {
    return this.dataSource.isInitialized;
  }

  /** Repository for a seeded entity (or the entity class itself). */
  getRepository<Entity extends Record<string, any>>(
    entity: EntityTarget<Entity>,
  ): Repository<Entity> {
    this.assertOpen();
    return this.dataSource.getRepository(entity);
  }

  /**
   * Close the data source and restore each entity's previous `BaseEntity`
   * binding (or clear it). A binding that has since been taken over by an
   * unrelated data source is left untouched.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const target of this.targets) {
      RESERVED.delete(target);
      if (currentBinding(target) === this.dataSource) {
        setBinding(target, this.snapshots.get(target) ?? null);
      }
    }
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new FileDataSourceError('this FileDataSource has been closed');
    }
  }
}

/** Set of BaseEntity targets currently owned by an open FileDataSource. */
const RESERVED = new WeakSet<Function>();

/**
 * Identify a BaseEntity subclass the same way TypeORM does (duck-typing on the
 * inherited static members), so binding decisions match TypeORM's own
 * auto-binding during metadata construction.
 */
function isBaseEntityConstructor(target: unknown): target is Function {
  if (typeof target !== 'function') {
    return false;
  }
  const ctor = target as unknown as Record<string, unknown>;
  return (
    typeof ctor.hasId === 'function' &&
    typeof ctor.save === 'function' &&
    typeof ctor.useDataSource === 'function'
  );
}

/** The BaseEntity target class to bind/reserve for an entity, if any. */
function baseEntityTargetOf(entity: EntityTarget<unknown>): Function | null {
  if (typeof entity === 'function') {
    return isBaseEntityConstructor(entity) ? entity : null;
  }
  if (entity instanceof EntitySchema) {
    const target = entity.options.target;
    return typeof target === 'function' && isBaseEntityConstructor(target) ? target : null;
  }
  return null;
}

function entityLabel(entity: EntityTarget<unknown>): string {
  if (typeof entity === 'function') {
    return entity.name || '(anonymous entity class)';
  }
  if (entity instanceof EntitySchema) {
    return entity.options.name;
  }
  if (typeof entity === 'string') {
    return entity;
  }
  // The `{ type, name }` object form of an EntityTarget carries the name.
  return entity.name;
}

/**
 * Read an entity's current `BaseEntity` data source through its public API, or
 * `null` when unbound. Reaching into TypeORM's private `dataSource` static is
 * deliberately avoided.
 */
function currentBinding(target: Function): DataSource | null {
  const ctor = target as unknown as {
    getRepository(): { manager: { connection: DataSource } };
  };
  try {
    return ctor.getRepository().manager.connection;
  } catch {
    return null;
  }
}

function setBinding(target: Function, dataSource: DataSource | null): void {
  const ctor = target as unknown as {
    useDataSource(dataSource: DataSource | null): void;
  };
  ctor.useDataSource(dataSource);
}

function validateModels(models: unknown): readonly FileDataSourceModel[] {
  if (!Array.isArray(models)) {
    throw new FileDataSourceError('FileDataSource.create: "models" must be an array');
  }
  if (models.length === 0) {
    throw new FileDataSourceError('FileDataSource.create: "models" must not be empty');
  }
  for (const [index, model] of models.entries()) {
    const label = `models[${index}]`;
    if (typeof model !== 'object' || model === null) {
      throw new FileDataSourceError(`FileDataSource.create: ${label} must be an object`);
    }
    const record = model as Record<string, unknown>;
    const entity = record.entity;
    if (typeof entity !== 'function' && !(entity instanceof EntitySchema)) {
      throw new FileDataSourceError(
        `FileDataSource.create: ${label}.entity must be a BaseEntity subclass or an EntitySchema`,
      );
    }
    const hasRows = Array.isArray(record.rows);
    const hasFile = typeof record.file === 'string';
    if (hasRows === hasFile) {
      throw new FileDataSourceError(
        `FileDataSource.create: ${label} must provide exactly one of "rows" or "file"`,
      );
    }
  }
  return models as readonly FileDataSourceModel[];
}

async function loadRows(model: FileDataSourceModel): Promise<readonly Record<string, unknown>[]> {
  if ('rows' in model) {
    return assertArrayOfObjects(model.rows, entityLabel(model.entity));
  }
  let text: string;
  try {
    text = await readFile(model.file, 'utf8');
  } catch (error) {
    throw new FileDataSourceError(
      `FileDataSource.create: cannot read file "${model.file}": ${(error as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new FileDataSourceError(
      `FileDataSource.create: file "${model.file}" is not valid JSON: ${(error as Error).message}`,
    );
  }
  return assertArrayOfObjects(parsed, `file "${model.file}"`);
}

function assertArrayOfObjects(value: unknown, label: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new FileDataSourceError(`${label} must be a JSON array of plain objects`);
  }
  for (const [index, row] of value.entries()) {
    if (!isPlainObject(row)) {
      throw new FileDataSourceError(`${label}[${index}] must be a plain object`);
    }
  }
  return value as Record<string, unknown>[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

async function seedModel(
  dataSource: DataSource,
  model: FileDataSourceModel,
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  const metadata = dataSource.getMetadata(model.entity);
  validateRows(metadata, rows);
  const repository = dataSource.getRepository(model.entity) as Repository<Record<string, unknown>>;
  await repository.insert(rows);
}

function validateRows(metadata: EntityMetadata, rows: readonly Record<string, unknown>[]): void {
  const byProperty = new Map<string, ColumnMetadata>();
  for (const column of metadata.columns) {
    byProperty.set(column.propertyName, column);
  }
  const primaryColumn = metadata.primaryColumns[0];
  const seenIds = new Set<number>();

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!byProperty.has(key)) {
        throw new FileDataSourceError(
          `row for entity "${metadata.name}" contains unknown field "${key}"`,
        );
      }
    }

    for (const column of metadata.columns) {
      const value = row[column.propertyName];
      if (value === undefined) {
        if (isOmissible(column)) {
          continue;
        }
        throw new FileDataSourceError(
          `row for entity "${metadata.name}" is missing required field "${column.propertyName}"`,
        );
      }
      if (value === null) {
        if (column.isNullable) {
          continue;
        }
        throw new FileDataSourceError(
          `row for entity "${metadata.name}" has null for non-nullable field "${column.propertyName}"`,
        );
      }
      if (column === primaryColumn) {
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
          throw new FileDataSourceError(
            `row for entity "${metadata.name}" has invalid primary key ${JSON.stringify(value)} ` +
              `for "${column.propertyName}"`,
          );
        }
        if (seenIds.has(value)) {
          throw new FileDataSourceError(
            `row for entity "${metadata.name}" duplicates primary key value ${value}`,
          );
        }
        seenIds.add(value);
        continue;
      }
      assertScalarValue(metadata.name, column, value);
    }
  }
}

function isOmissible(column: ColumnMetadata): boolean {
  if (column.isPrimary && column.isGenerated) {
    return true;
  }
  if (column.default !== undefined) {
    return true;
  }
  return column.isNullable;
}

function assertScalarValue(entityName: string, column: ColumnMetadata, value: unknown): void {
  const kind = scalarKind(column);
  const valid =
    kind === 'integer'
      ? typeof value === 'number' && Number.isInteger(value)
      : kind === 'boolean'
        ? typeof value === 'boolean'
        : kind === 'datetime'
          ? typeof value === 'string' || value instanceof Date
          : typeof value === 'string';
  if (!valid) {
    throw new FileDataSourceError(
      `row for entity "${entityName}" has invalid value for field "${column.propertyName}": ` +
        `expected ${kind}, got ${describeValue(value)}`,
    );
  }
}

function scalarKind(column: ColumnMetadata): ScalarKind {
  const type = column.type;
  if (type === Number) {
    return 'integer';
  }
  if (type === Boolean) {
    return 'boolean';
  }
  if (type === Date) {
    return 'datetime';
  }
  if (type === String) {
    return 'string';
  }
  if (typeof type === 'string') {
    const normalized = type.trim().toLowerCase();
    if (normalized === 'int' || normalized === 'int4' || normalized === 'integer') {
      return 'integer';
    }
    if (normalized === 'boolean' || normalized === 'bool') {
      return 'boolean';
    }
    if (normalized === 'datetime' || normalized === 'timestamp without time zone') {
      return 'datetime';
    }
  }
  return 'string';
}

function describeValue(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    return Object.prototype.toString.call(value);
  }
  return JSON.stringify(value);
}

function enableReadOnly(dataSource: DataSource): void {
  const driver = dataSource.driver as unknown as {
    databaseConnection: { exec(sql: string): unknown };
  };
  driver.databaseConnection.exec('PRAGMA query_only = ON');
}
