/**
 * JSails' bounded TypeORM data source.
 *
 * {@link JsailsDataSource} extends TypeORM's {@link DataSource} and restricts
 * it to the SQL drivers JSails supports: the server SQL drivers
 * (postgres / mysql / mariadb) plus a file-backed SQLite surface exposed
 * through TypeORM's `sqljs` driver. Its
 * {@link JsailsDataSource.getModelSchema} builds entity metadata offline —
 * without opening a database connection — and converts it into the portable
 * {@link SchemaState} understood by the migration core.
 *
 * The `sqljs` form is a persistent, single-file SQLite database: it requires an
 * explicit `location` path, persists on every write (TypeORM's `autoSave`), and
 * replaces TypeORM's non-atomic whole-file writer with an atomic
 * write-to-temp-then-rename callback. It is single-process only — there is no
 * WAL, no locking, no cross-process concurrency, and no crash/fsync durability
 * guarantee. It is not the read-only {@link FileDataSource}: writes are real
 * and persist to disk.
 *
 * Unsafe options that would mutate the database on startup (synchronize,
 * dropSchema, migrationsRun) or conflict with JSails' own migration history
 * (TypeORM migrations) are rejected at construction time for every driver.
 */

import { statSync, type Stats } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';

import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';

import { MigrationError, type SchemaState } from '../migrations/schema-state.js';
import { buildSchemaStateFromMetadatas } from './model-schema.js';

/**
 * Logical database drivers this adapter supports. `sqlite` is surfaced through
 * TypeORM's `sqljs` driver; the other three map one-to-one to TypeORM types.
 */
export type JsailsSupportedDriver = 'postgres' | 'mysql' | 'mariadb' | 'sqlite';

/** Narrowed TypeORM options: only the supported drivers are permitted. */
export type JsailsDataSourceOptions = Extract<
  DataSourceOptions,
  { type: 'postgres' | 'mysql' | 'mariadb' | 'sqljs' }
>;

type SqljsOptions = Extract<DataSourceOptions, { type: 'sqljs' }>;

/** TypeORM `type` values for the server SQL drivers (sqljs is handled separately). */
const SERVER_DRIVERS: ReadonlySet<string> = new Set(['postgres', 'mysql', 'mariadb']);

const LOGICAL_DRIVERS: ReadonlySet<string> = new Set<JsailsSupportedDriver>([
  'postgres',
  'mysql',
  'mariadb',
  'sqlite',
]);

interface PreparedOptions {
  options: DataSourceOptions;
  driver: JsailsSupportedDriver;
}

export class JsailsDataSource extends DataSource {
  /** The validated logical driver type for this data source (`sqljs` maps to `sqlite`). */
  readonly jsailsDriver: JsailsSupportedDriver;

  constructor(options: JsailsDataSourceOptions) {
    const prepared = prepareDataSourceOptions(options);
    super(prepared.options);
    this.jsailsDriver = prepared.driver;
  }

  /**
   * Build entity metadata without connecting and convert it into a normalized
   * portable {@link SchemaState}. Never opens a database connection.
   */
  async getModelSchema(): Promise<SchemaState> {
    await this.buildMetadatas();
    return buildSchemaStateFromMetadatas(this.entityMetadatas);
  }
}

/**
 * Validate the options and produce the concrete options to hand to TypeORM,
 * plus the logical driver. All validation happens before {@link DataSource}'s
 * constructor runs, so an invalid configuration fails with {@link MigrationError}
 * rather than a driver-level error.
 */
function prepareDataSourceOptions(options: JsailsDataSourceOptions): PreparedOptions {
  assertSafeOptions(options);
  if (options.type === 'sqljs') {
    return { options: prepareSqljsOptions(options), driver: 'sqlite' };
  }
  assertServerDriver(options.type);
  return { options, driver: options.type };
}

function assertServerDriver(type: unknown): asserts type is 'postgres' | 'mysql' | 'mariadb' {
  if (typeof type !== 'string' || !SERVER_DRIVERS.has(type)) {
    throw new MigrationError(
      `unsupported database type ${JSON.stringify(type)}; ` +
        `JsailsDataSource supports only ${[...LOGICAL_DRIVERS].join(', ')}`,
    );
  }
}

/**
 * Normalize a `sqljs` configuration into a persistent file-backed SQLite data
 * source. Requires an explicit non-empty `location`, rejects the in-memory
 * `database` (Uint8Array) and `autoSave: false`, resolves the location to an
 * absolute path, and fails at construct time when the parent directory is
 * missing or not a directory (it is never auto-created).
 */
function prepareSqljsOptions(options: SqljsOptions): DataSourceOptions {
  const location = options.location;
  if (typeof location !== 'string' || location.length === 0) {
    throw new MigrationError(
      'JsailsDataSource sqljs configuration requires a non-empty "location" string',
    );
  }
  if (location.includes('\0')) {
    throw new MigrationError('JsailsDataSource sqljs "location" must not contain a NUL character');
  }
  if (options.database !== undefined) {
    throw new MigrationError(
      'JsailsDataSource sqljs configuration does not allow "database" (Uint8Array); ' +
        'persist to a file via "location" instead',
    );
  }
  if (options.autoSave === false) {
    throw new MigrationError(
      'JsailsDataSource sqljs configuration requires autoSave: true so writes persist to "location"',
    );
  }

  const resolvedLocation = resolvePath(location);
  assertWritableParentDirectory(resolvedLocation);

  return {
    ...options,
    location: resolvedLocation,
    autoSave: true,
    autoSaveCallback: atomicSaveCallback(resolvedLocation),
  };
}

function assertWritableParentDirectory(location: string): void {
  const parent = dirname(location);
  let stat: Stats;
  try {
    stat = statSync(parent);
  } catch {
    throw new MigrationError(
      `JsailsDataSource sqljs "location" parent directory "${parent}" does not exist; ` +
        'create it before constructing the data source',
    );
  }
  if (!stat.isDirectory()) {
    throw new MigrationError(
      `JsailsDataSource sqljs "location" parent "${parent}" is not a directory`,
    );
  }
}

/**
 * Atomic whole-file writer for the sqljs `autoSaveCallback`: write the exported
 * database bytes to a temp file in the same directory, then rename it over the
 * target. This replaces TypeORM's default non-atomic `writeFile` on the target
 * path. It is still single-process and provides no crash/fsync durability —
 * only that a completed save never exposes a partially-written database file.
 */
function atomicSaveCallback(location: string): (data: Uint8Array) => Promise<void> {
  const tempPath = `${location}.tmp`;
  return async (data: Uint8Array) => {
    await writeFile(tempPath, data);
    await rename(tempPath, location);
  };
}

function assertSafeOptions(options: JsailsDataSourceOptions): void {
  if (options.synchronize) {
    throw new MigrationError(
      'JsailsDataSource does not allow synchronize: true; use explicit migrations instead',
    );
  }
  if (options.dropSchema) {
    throw new MigrationError('JsailsDataSource does not allow dropSchema: true');
  }
  if (options.migrationsRun) {
    throw new MigrationError(
      'JsailsDataSource does not allow migrationsRun: true; JSails manages its own migration history',
    );
  }
  if (options.migrations !== undefined) {
    throw new MigrationError(
      'JsailsDataSource does not allow TypeORM migrations configuration; ' +
        'it conflicts with the JSails migration history',
    );
  }
}
