/**
 * Migration runner: forward apply and destructive rollback.
 *
 * Applies (or un-applies) a validated linear migration history against an
 * initialized data source, recording each applied migration in the reserved
 * `jsails_migrations` tracking table. {@link migrate} applies pending
 * migrations; {@link rollbackTo} un-applies the tail of the applied prefix
 * (everything after a named target, or the last N applied migrations) by
 * executing each migration's inverted operations in reverse order.
 *
 * The entire history is resolved (linear-graph validation), replayed (operation
 * precondition validation), and preflighted against the driver before any
 * database work, so a malformed history never half-applies. Rollback verifies
 * the stored checksums and replays the whole backwards plan against the schema
 * state before any DDL runs, so a mismatch or an un-invertible plan is refused
 * value-free and the database is left untouched.
 *
 * Concurrency is serialized with a session lock taken on the same query runner
 * that performs the work: a fixed Postgres advisory lock key, or a MySQL/MariaDB
 * named lock (`GET_LOCK`/`RELEASE_LOCK`) scoped to the database. SQLite takes no
 * session lock: a sqljs database is a single file owned by a single process, so
 * cross-process serialization is impossible anyway and no lock is attempted.
 * Durability differs by driver:
 *
 * - Postgres: each migration runs in its own transaction; its record is written
 *   only after its operations succeed and is rolled back with them.
 * - SQLite (sqljs): DDL is transactional, so the same pattern applies — each
 *   migration runs in its own transaction and its record is committed
 *   atomically with its operations.
 * - MySQL/MariaDB: DDL auto-commits, so an "applying" row is persisted before
 *   the operations and flipped to "applied" only once they all succeed. A
 *   failure leaves the "applying" marker, blocking a blind retry of half-applied
 *   non-transactional DDL.
 */

import { createHash } from 'node:crypto';
import type { QueryRunner } from 'typeorm';
import { Table } from 'typeorm';
import { RESERVED_MIGRATIONS_TABLE } from '../database/model-schema.js';
import { executeSchemaOperation, preflightSchemaOperations } from '../database/schema-editor.js';
import type { SchemaEditorDriver } from '../database/schema-editor.js';
import type { DataMigration } from './data.js';
import type { MigrationDefinition, MigrationHistory } from './history.js';
import { replayOrderedHistory, resolveMigrationOrder } from './history.js';
import { applyOperations, invertOperation, type Operation } from './operations.js';
import {
  MigrationError,
  emptySchema,
  normalizeSchemaState,
  type SchemaState,
} from './schema-state.js';

/** Structural contract the runner needs from a data source. */
export interface MigrationDataSource {
  readonly isInitialized: boolean;
  readonly jsailsDriver: SchemaEditorDriver;
  readonly options: { database?: string };
  createQueryRunner(): QueryRunner;
}

/** Result of a forward migration run. */
export interface MigrationRunResult {
  /** Names of migrations applied by this run, in history order. */
  applied: string[];
}

/** Result of a rollback run. */
export interface MigrationRollbackResult {
  /** Names of migrations un-applied by this run, in reverse history order. */
  unapplied: string[];
}

/**
 * Rollback target. Exactly one of `targetName` or `steps` must be given.
 * `targetName` un-applies every applied migration after that migration (the
 * target stays applied); `steps` un-applies the last N applied migrations.
 */
export interface RollbackOptions {
  /** Name of the migration to roll back to (exclusive); it stays applied. */
  targetName?: string;
  /** Number of applied migrations to un-apply from the tail. */
  steps?: number;
  /**
   * Required to un-apply the first (root) migration. Defaults to false.
   * Un-applying a later migration does not require this flag.
   */
  allowDestructive?: boolean;
}

/** Options for forward migration runs. */
export interface MigrateOptions {
  /** Data migration registry keyed by name. Required when any history entry has kind: 'data'. */
  dataMigrations?: ReadonlyMap<string, DataMigration>;
  /** Record migrations as applied without executing schema or data operations. */
  fake?: boolean;
  /** Record the first migration as applied without executing it when the tracking table is empty. */
  fakeInitial?: boolean;
}

/** Read-only snapshot of migration state against the tracking table. */
export interface MigrationStatus {
  /** Whether the tracking table exists in the database. */
  tableExists: boolean;
  /** Migrations recorded as applied, in history order. */
  applied: string[];
  /** Migrations not yet applied, in history order. */
  pending: string[];
  /** Migrations stuck in the "applying" (dirty) state, in history order. */
  dirty: string[];
}

const MIGRATIONS_TABLE = RESERVED_MIGRATIONS_TABLE;
const STATUS_APPLYING = 'applying';
const STATUS_APPLIED = 'applied';
const MIGRATION_KIND_COL = 'kind';
const DEFAULT_MIGRATION_KIND = 'schema';
const DATA_MIGRATION_KIND = 'data';

/** Fixed Postgres advisory lock key. Arbitrary but stable across releases. */
const PG_ADVISORY_LOCK_KEY = 72674931007;

/**
 * MySQL named locks are global (not per-database); scope the name to the
 * database and hash it down to the 64-character limit when necessary.
 */
function sessionLockName(database: string): string {
  const candidate = `jsails:${database}`;
  if (candidate.length <= 64) {
    return candidate;
  }
  return `jsails:${createHash('sha256').update(candidate).digest('hex').slice(0, 56)}`;
}

/**
 * Serialize a value with object keys sorted, preserving array order. Combined
 * with the normalized definitions produced by the schema-state module, this
 * yields a digest that is independent of how a migration was written.
 */
function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map(
      (key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}

/**
 * Canonical SHA-256 digest of a migration. The dependency is hashed as the
 * resolved single predecessor (or null), not as an array whose order could vary.
 * Includes `kind` so a data migration's checksum always differs from a schema
 * migration's, even when both have empty operations.
 */
function migrationDigest(migration: MigrationDefinition): string {
  const payload = {
    name: migration.name,
    dependency: migration.dependencies[0] ?? null,
    kind: migration.kind ?? DEFAULT_MIGRATION_KIND,
    operations: migration.operations,
  };
  return createHash('sha256').update(stableSerialize(payload)).digest('hex');
}

function migrationsTrackingTable(): Table {
  return new Table({
    name: MIGRATIONS_TABLE,
    columns: [
      { name: 'name', type: 'varchar', length: '190', isPrimary: true, isNullable: false },
      { name: 'checksum', type: 'varchar', length: '64', isNullable: false },
      { name: 'status', type: 'varchar', length: '16', isNullable: false },
      {
        name: MIGRATION_KIND_COL,
        type: 'varchar',
        length: '16',
        isNullable: false,
        default: `'${DEFAULT_MIGRATION_KIND}'`,
      },
    ],
  });
}

/** Positional placeholder for the driver: `$n` for Postgres, `?` otherwise. */
function placeholder(driver: SchemaEditorDriver, index: number): string {
  return driver === 'postgres' ? `$${index}` : '?';
}

function insertRowSql(driver: SchemaEditorDriver): string {
  return (
    `INSERT INTO ${MIGRATIONS_TABLE} (name, checksum, status, ${MIGRATION_KIND_COL}) VALUES ` +
    `(${placeholder(driver, 1)}, ${placeholder(driver, 2)}, ${placeholder(driver, 3)}, ${placeholder(driver, 4)})`
  );
}

function updateStatusSql(driver: SchemaEditorDriver): string {
  return (
    `UPDATE ${MIGRATIONS_TABLE} SET status = ${placeholder(driver, 1)} ` +
    `WHERE name = ${placeholder(driver, 2)}`
  );
}

function deleteRowSql(driver: SchemaEditorDriver): string {
  return `DELETE FROM ${MIGRATIONS_TABLE} WHERE name = ${placeholder(driver, 1)}`;
}

const SELECT_ROWS_SQL = `SELECT name, checksum, status, ${MIGRATION_KIND_COL} FROM ${MIGRATIONS_TABLE}`;

interface PreparedMigration {
  name: string;
  operations: Operation[];
  checksum: string;
  kind: 'schema' | 'data';
}

interface TrackedRow {
  name: string;
  checksum: string;
  status: string;
  kind: string;
}

function assertInitialized(dataSource: MigrationDataSource): void {
  if (!dataSource.isInitialized) {
    throw new MigrationError('data source must be initialized before running migrations');
  }
}

/** Validate, order, replay, and preflight the whole history, then compute digests. */
function prepareHistory(
  history: MigrationHistory,
  driver: SchemaEditorDriver,
): PreparedMigration[] {
  const ordered = resolveMigrationOrder(history);
  replayOrderedHistory(ordered);
  return ordered.map((migration) => ({
    name: migration.name,
    operations: preflightSchemaOperations(migration.operations, driver),
    checksum: migrationDigest(migration),
    kind: migration.kind === DATA_MIGRATION_KIND ? DATA_MIGRATION_KIND : DEFAULT_MIGRATION_KIND,
  }));
}

/** Run `fn` on a connected query runner, always releasing it, never obscuring errors. */
async function withQueryRunner<T>(
  dataSource: MigrationDataSource,
  fn: (queryRunner: QueryRunner) => Promise<T>,
): Promise<T> {
  const queryRunner = dataSource.createQueryRunner();
  let primaryError: unknown;
  let result: T | undefined;
  let connected = false;
  try {
    await queryRunner.connect();
    connected = true;
    result = await fn(queryRunner);
  } catch (error) {
    primaryError = error;
  }
  if (connected) {
    try {
      await queryRunner.release();
    } catch (error) {
      if (primaryError === undefined) primaryError = error;
    }
  }
  if (primaryError !== undefined) throw primaryError;
  return result as T;
}

async function acquireSessionLock(
  queryRunner: QueryRunner,
  driver: SchemaEditorDriver,
  database: string,
): Promise<void> {
  if (driver === 'sqlite') {
    // A sqljs database is a single file owned by a single process; there is no
    // cross-process contention to serialize against, so no lock is taken.
    return;
  }
  if (driver === 'postgres') {
    const result = await queryRunner.query(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [PG_ADVISORY_LOCK_KEY],
      true,
    );
    if (!result.records[0]?.acquired) {
      throw new MigrationError(
        'could not acquire migration lock: another migration session is in progress',
      );
    }
    return;
  }
  const result = await queryRunner.query(
    'SELECT GET_LOCK(?, 0) AS acquired',
    [sessionLockName(database)],
    true,
  );
  if (Number(result.records[0]?.acquired) !== 1) {
    throw new MigrationError(
      'could not acquire migration lock: another migration session is in progress',
    );
  }
}

async function releaseSessionLock(
  queryRunner: QueryRunner,
  driver: SchemaEditorDriver,
  database: string,
): Promise<void> {
  if (driver === 'sqlite') {
    return;
  }
  if (driver === 'postgres') {
    await queryRunner.query('SELECT pg_advisory_unlock($1)', [PG_ADVISORY_LOCK_KEY]);
    return;
  }
  await queryRunner.query('SELECT RELEASE_LOCK(?)', [sessionLockName(database)]);
}

async function loadTrackedRows(queryRunner: QueryRunner): Promise<TrackedRow[]> {
  const result = await queryRunner.query(SELECT_ROWS_SQL, undefined, true);
  return (
    result.records as Array<{ name: unknown; checksum: unknown; status: unknown; kind?: unknown }>
  ).map((row) => ({
    name: String(row.name),
    checksum: String(row.checksum),
    status: String(row.status),
    kind: typeof row.kind === 'string' && row.kind.length > 0 ? row.kind : DEFAULT_MIGRATION_KIND,
  }));
}

/**
 * Validate tracked rows against the history. Throws on duplicate rows, unknown
 * names, checksum mismatches, invalid status values, and rows that do not form
 * a prefix of the resolved history. Returns the applied names and any dirty
 * ("applying") names; the caller decides whether dirty rows are fatal.
 */
function validateTrackedRows(
  rows: TrackedRow[],
  orderedNames: string[],
  digestByName: Map<string, string>,
): { applied: Set<string>; dirty: string[] } {
  const seen = new Set<string>();
  const applied = new Set<string>();
  const dirty: string[] = [];

  for (const row of rows) {
    if (seen.has(row.name)) {
      throw new MigrationError(`tracking table has a duplicate row for migration "${row.name}"`);
    }
    seen.add(row.name);

    const expected = digestByName.get(row.name);
    if (expected === undefined) {
      throw new MigrationError(`tracking table references unknown migration "${row.name}"`);
    }
    if (row.checksum !== expected) {
      throw new MigrationError(
        `migration "${row.name}" checksum mismatch: recorded ${row.checksum}, expected ${expected}`,
      );
    }
    if (row.status === STATUS_APPLIED) {
      applied.add(row.name);
    } else if (row.status === STATUS_APPLYING) {
      dirty.push(row.name);
    } else {
      throw new MigrationError(
        `migration "${row.name}" has invalid status ${JSON.stringify(row.status)}`,
      );
    }
  }

  const recorded = orderedNames.filter((name) => seen.has(name));
  for (let i = 0; i < recorded.length; i += 1) {
    if (recorded[i] !== orderedNames[i]) {
      throw new MigrationError(
        `tracking table does not form a prefix of the migration history: ` +
          `recorded "${recorded[i]}" where "${orderedNames[i]}" was expected`,
      );
    }
  }

  return { applied, dirty };
}

async function insertMigrationRow(
  queryRunner: QueryRunner,
  driver: SchemaEditorDriver,
  name: string,
  checksum: string,
  status: string,
  kind: string,
): Promise<void> {
  await queryRunner.query(insertRowSql(driver), [name, checksum, status, kind]);
}

async function updateMigrationStatus(
  queryRunner: QueryRunner,
  driver: SchemaEditorDriver,
  name: string,
  status: string,
): Promise<void> {
  await queryRunner.query(updateStatusSql(driver), [status, name]);
}

async function deleteMigrationRow(
  queryRunner: QueryRunner,
  driver: SchemaEditorDriver,
  name: string,
): Promise<void> {
  await queryRunner.query(deleteRowSql(driver), [name]);
}

async function applyMigration(
  queryRunner: QueryRunner,
  driver: SchemaEditorDriver,
  name: string,
  operations: Operation[],
  checksum: string,
  kind: 'schema' | 'data',
  dataMigration?: DataMigration,
  fake = false,
): Promise<void> {
  const isPostgresOrSqlite = driver === 'postgres' || driver === 'sqlite';

  if (isPostgresOrSqlite) {
    await queryRunner.startTransaction();
    try {
      if (!fake) {
        if (kind === 'data') {
          if (dataMigration === undefined) {
            throw new MigrationError(
              `data migration "${name}" is not registered; provide a data migration registry`,
            );
          }
          await dataMigration.up({ queryRunner });
        } else {
          for (const operation of operations) {
            await executeSchemaOperation(queryRunner, operation, driver);
          }
        }
      }
      await insertMigrationRow(queryRunner, driver, name, checksum, STATUS_APPLIED, kind);
      await queryRunner.commitTransaction();
    } catch (error) {
      try {
        await queryRunner.rollbackTransaction();
      } catch {
        // Rollback failure is secondary; surface the operation's error.
      }
      throw error;
    }
    return;
  }

  // MySQL/MariaDB: DDL auto-commits, so persist an "applying" marker first and
  // only mark "applied" once every operation succeeds. A failure leaves the
  // marker in place, blocking a blind retry of half-applied DDL.
  if (!fake) {
    await insertMigrationRow(queryRunner, driver, name, checksum, STATUS_APPLYING, kind);
    if (kind === 'data') {
      if (dataMigration === undefined) {
        throw new MigrationError(
          `data migration "${name}" is not registered; provide a data migration registry`,
        );
      }
      await dataMigration.up({ queryRunner });
    } else {
      for (const operation of operations) {
        await executeSchemaOperation(queryRunner, operation, driver);
      }
    }
    await updateMigrationStatus(queryRunner, driver, name, STATUS_APPLIED);
  } else {
    // Fake: just record the row as applied.
    await insertMigrationRow(queryRunner, driver, name, checksum, STATUS_APPLIED, kind);
  }
}

/** Invert a migration's operations and reverse their order, so it un-applies. */
function invertOperations(operations: Operation[]): Operation[] {
  return operations
    .slice()
    .reverse()
    .map((operation) => invertOperation(operation));
}

/** Replay prepared operations from the empty schema to the final applied state. */
function replayPreparedState(prepared: PreparedMigration[]): SchemaState {
  let state = emptySchema();
  for (const entry of prepared) {
    state = applyOperations(state, entry.operations);
  }
  return normalizeSchemaState(state);
}

/**
 * Validate the rollback options' shape without touching the database: exactly
 * one of `targetName`/`steps` must be present and `steps` must be a positive
 * integer. Target membership and the destructive gate are checked later against
 * the live applied prefix.
 */
function validateRollbackOptions(options: RollbackOptions): void {
  const hasTarget = options.targetName !== undefined;
  const hasSteps = options.steps !== undefined;
  if (hasTarget === hasSteps) {
    throw new MigrationError(
      'rollback requires exactly one of "targetName" (--down) or "steps" (--steps)',
    );
  }
  if (hasSteps && (!Number.isInteger(options.steps) || (options.steps as number) <= 0)) {
    throw new MigrationError('"steps" (--steps) must be a positive integer');
  }
}

/**
 * Compute the migrations to un-apply, in reverse history order, from the
 * applied prefix. Assumes {@link validateRollbackOptions} has already passed.
 * Applies the destructive gate, then replays the whole backwards plan against
 * the schema state so any un-invertible plan is refused before DDL. Returns the
 * reverse-ordered migrations to un-apply and whether the set includes the root.
 */
function prepareRollback(
  prepared: PreparedMigration[],
  applied: ReadonlySet<string>,
  options: RollbackOptions,
  dataMigrations?: ReadonlyMap<string, DataMigration>,
): { toUnapply: PreparedMigration[]; unappliesRoot: boolean } {
  const appliedPrefix = prepared.filter((entry) => applied.has(entry.name));

  let toUnapply: PreparedMigration[];
  if (options.targetName !== undefined) {
    const targetName = options.targetName;
    const targetIndex = appliedPrefix.findIndex((entry) => entry.name === targetName);
    if (targetIndex === -1) {
      throw new MigrationError(
        `cannot roll back to "${targetName}": it is not an applied migration`,
      );
    }
    // The target stays applied; everything after it is un-applied.
    toUnapply = appliedPrefix.slice(targetIndex + 1).reverse();
  } else {
    const steps = options.steps as number;
    if (steps > appliedPrefix.length) {
      throw new MigrationError(
        `cannot roll back ${steps} migration(s): only ${appliedPrefix.length} are applied`,
      );
    }
    toUnapply = appliedPrefix.slice(-steps).reverse();
  }

  const unappliesRoot = toUnapply.length > 0 && toUnapply[toUnapply.length - 1] === prepared[0];
  if (unappliesRoot && options.allowDestructive !== true) {
    throw new MigrationError(
      'rolling back the first migration is destructive and requires "allowDestructive"',
    );
  }

  // Reject data migrations without a `down` handler before any DDL runs.
  if (dataMigrations !== undefined) {
    for (const entry of toUnapply) {
      if (entry.kind === 'data') {
        const dm = dataMigrations.get(entry.name);
        if (dm === undefined) {
          throw new MigrationError(
            `data migration "${entry.name}" is not registered; provide a data migration registry`,
          );
        }
        if (typeof dm.down !== 'function') {
          throw new MigrationError(
            `data migration "${entry.name}" has no "down" handler; it cannot be rolled back`,
          );
        }
      }
    }
  }

  // Backwards preflight: replay the inverted operations over the final applied
  // schema state so a plan that cannot be inverted is refused before any DDL.
  let state = replayPreparedState(prepared);
  for (const entry of toUnapply) {
    state = applyOperations(state, invertOperations(entry.operations));
  }
  normalizeSchemaState(state);

  return { toUnapply, unappliesRoot };
}

/**
 * Un-apply one migration with the same durability discipline as forward
 * application: a per-migration transaction on Postgres/SQLite (the row is
 * deleted only after the inverted operations/`down` handler succeed), and a
 * dirty "applying" marker persisted before the DDL/handler on MySQL/MariaDB
 * (flipped back to a delete only once every operation succeeds, so a failure
 * blocks a blind retry).
 */
async function unapplyMigration(
  queryRunner: QueryRunner,
  driver: SchemaEditorDriver,
  name: string,
  inverted: Operation[],
  kind: 'schema' | 'data',
  dataMigration?: DataMigration,
): Promise<void> {
  const isPostgresOrSqlite = driver === 'postgres' || driver === 'sqlite';

  if (isPostgresOrSqlite) {
    await queryRunner.startTransaction();
    try {
      if (kind === 'data') {
        if (dataMigration === undefined) {
          throw new MigrationError(
            `data migration "${name}" is not registered; provide a data migration registry`,
          );
        }
        if (typeof dataMigration.down !== 'function') {
          throw new MigrationError(
            `data migration "${name}" has no "down" handler; it cannot be rolled back`,
          );
        }
        await dataMigration.down({ queryRunner });
      } else {
        for (const operation of inverted) {
          await executeSchemaOperation(queryRunner, operation, driver);
        }
      }
      await deleteMigrationRow(queryRunner, driver, name);
      await queryRunner.commitTransaction();
    } catch (error) {
      try {
        await queryRunner.rollbackTransaction();
      } catch {
        // Rollback failure is secondary; surface the operation's error.
      }
      throw error;
    }
    return;
  }

  // MySQL/MariaDB: DDL auto-commits, so mark the row "applying" before any DDL
  // and delete it only once every inverted operation/`down` handler succeeds.
  await updateMigrationStatus(queryRunner, driver, name, STATUS_APPLYING);
  if (kind === 'data') {
    if (dataMigration === undefined) {
      throw new MigrationError(
        `data migration "${name}" is not registered; provide a data migration registry`,
      );
    }
    if (typeof dataMigration.down !== 'function') {
      throw new MigrationError(
        `data migration "${name}" has no "down" handler; it cannot be rolled back`,
      );
    }
    await dataMigration.down({ queryRunner });
  } else {
    for (const operation of inverted) {
      await executeSchemaOperation(queryRunner, operation, driver);
    }
  }
  await deleteMigrationRow(queryRunner, driver, name);
}

/**
 * Validate that every data migration named in the history has a registered handler.
 * Throws value-free when a data migration is missing from the registry.
 */
function validateDataMigrations(
  prepared: PreparedMigration[],
  dataMigrations: ReadonlyMap<string, DataMigration> | undefined,
): void {
  for (const entry of prepared) {
    if (entry.kind === 'data' && !dataMigrations?.has(entry.name)) {
      throw new MigrationError(
        `data migration "${entry.name}" is not registered; ` +
          `provide a data migration registry (--data-migrations config, or the "dataMigrations" named export)`,
      );
    }
  }
}

/**
 * Apply all pending migrations from `history` to `dataSource`, recording each
 * in the tracking table. The whole history is validated, replayed, and
 * preflighted before any database work begins.
 *
 * When {@link MigrateOptions.fake} is true every pending migration is recorded
 * without executing schema operations or data-migration handlers.
 * {@link MigrateOptions.fakeInitial} records only the first migration as
 * applied when the tracking table is empty; subsequent migrations are executed.
 */
export async function migrate(
  dataSource: MigrationDataSource,
  history: MigrationHistory,
  options?: MigrateOptions,
): Promise<MigrationRunResult> {
  assertInitialized(dataSource);
  const driver = dataSource.jsailsDriver;
  const database = dataSource.options.database ?? '';

  const prepared = prepareHistory(history, driver);
  const orderedNames = prepared.map((entry) => entry.name);
  const digestByName = new Map(prepared.map((entry) => [entry.name, entry.checksum]));

  const dataMigrations = options?.dataMigrations;
  const globalFake = options?.fake === true;
  const fakeInitial = options?.fakeInitial === true;

  if (globalFake && fakeInitial) {
    throw new MigrationError('--fake and --fake-initial are mutually exclusive');
  }

  validateDataMigrations(prepared, dataMigrations);

  return withQueryRunner(dataSource, async (queryRunner) => {
    await acquireSessionLock(queryRunner, driver, database);

    let primaryError: unknown;
    let result: MigrationRunResult | undefined;
    try {
      const tableExisted = await queryRunner.hasTable(MIGRATIONS_TABLE);
      if (!tableExisted) {
        await queryRunner.createTable(migrationsTrackingTable());
      }

      const rows = await loadTrackedRows(queryRunner);
      const { applied, dirty } = validateTrackedRows(rows, orderedNames, digestByName);
      if (dirty.length > 0) {
        throw new MigrationError(
          `cannot migrate: migration(s) "${dirty.join('", "')}" are in the "applying" state; ` +
            `a previous run may have failed after non-transactional DDL. Resolve manually.`,
        );
      }

      const appliedNow: string[] = [];
      for (const entry of prepared) {
        if (applied.has(entry.name)) {
          continue;
        }

        const isFirstPending = applied.size === 0 && appliedNow.length === 0;

        let fakeThis = globalFake;
        if (fakeInitial && isFirstPending) {
          fakeThis = true;
        }

        const dataMigration = dataMigrations?.get(entry.name);
        await applyMigration(
          queryRunner,
          driver,
          entry.name,
          entry.operations,
          entry.checksum,
          entry.kind,
          dataMigration,
          fakeThis,
        );
        appliedNow.push(entry.name);
      }
      result = { applied: appliedNow };
    } catch (error) {
      primaryError = error;
    }

    try {
      await releaseSessionLock(queryRunner, driver, database);
    } catch (error) {
      if (primaryError === undefined) primaryError = error;
    }

    if (primaryError !== undefined) throw primaryError;
    return result as MigrationRunResult;
  });
}

/**
 * Un-apply the tail of the applied migration prefix. Exactly one of
 * `options.targetName` or `options.steps` selects the migrations to un-apply;
 * see {@link RollbackOptions}. Stored checksums are verified and the whole
 * backwards plan is replayed against the schema state before any DDL runs, so a
 * mismatch or an un-invertible plan is refused value-free. Un-applying the
 * first (root) migration requires `allowDestructive`.
 *
 * Data migrations are looked up from the optional `dataMigrations` registry.
 * A data migration without a `down` handler is refused value-free before any
 * DDL is executed.
 */
export async function rollbackTo(
  dataSource: MigrationDataSource,
  history: MigrationHistory,
  options: RollbackOptions,
  dataMigrations?: ReadonlyMap<string, DataMigration>,
): Promise<MigrationRollbackResult> {
  assertInitialized(dataSource);
  const driver = dataSource.jsailsDriver;
  const database = dataSource.options.database ?? '';

  const prepared = prepareHistory(history, driver);
  const orderedNames = prepared.map((entry) => entry.name);
  const digestByName = new Map(prepared.map((entry) => [entry.name, entry.checksum]));

  // Validate the target/steps shape before any connection is opened.
  validateRollbackOptions(options);

  return withQueryRunner(dataSource, async (queryRunner) => {
    await acquireSessionLock(queryRunner, driver, database);

    let primaryError: unknown;
    let result: MigrationRollbackResult | undefined;
    try {
      if (!(await queryRunner.hasTable(MIGRATIONS_TABLE))) {
        throw new MigrationError('cannot roll back: no migrations are applied');
      }

      const rows = await loadTrackedRows(queryRunner);
      const { applied, dirty } = validateTrackedRows(rows, orderedNames, digestByName);
      if (dirty.length > 0) {
        throw new MigrationError(
          `cannot roll back: migration(s) "${dirty.join('", "')}" are in the "applying" state; ` +
            `a previous run may have failed after non-transactional DDL. Resolve manually.`,
        );
      }

      // Recompute the plan against the real applied set: this verifies the
      // stored checksums (done above) and the target against the live prefix.
      const plan = prepareRollback(prepared, applied, options, dataMigrations);
      const unapplied: string[] = [];
      for (const entry of plan.toUnapply) {
        await unapplyMigration(
          queryRunner,
          driver,
          entry.name,
          invertOperations(entry.operations),
          entry.kind,
          dataMigrations?.get(entry.name),
        );
        unapplied.push(entry.name);
      }
      result = { unapplied };
    } catch (error) {
      primaryError = error;
    }

    try {
      await releaseSessionLock(queryRunner, driver, database);
    } catch (error) {
      if (primaryError === undefined) primaryError = error;
    }

    if (primaryError !== undefined) throw primaryError;
    return result as MigrationRollbackResult;
  });
}

/**
 * Read the tracking table and report applied, pending, and dirty migrations
 * against `history`. Never creates the table. The snapshot is a single SELECT,
 * not an isolated transaction: it may observe an in-flight run.
 */
export async function getMigrationStatus(
  dataSource: MigrationDataSource,
  history: MigrationHistory,
): Promise<MigrationStatus> {
  assertInitialized(dataSource);
  const driver = dataSource.jsailsDriver;

  const prepared = prepareHistory(history, driver);
  const orderedNames = prepared.map((entry) => entry.name);
  const digestByName = new Map(prepared.map((entry) => [entry.name, entry.checksum]));

  return withQueryRunner(dataSource, async (queryRunner) => {
    if (!(await queryRunner.hasTable(MIGRATIONS_TABLE))) {
      return { tableExists: false, applied: [], pending: orderedNames, dirty: [] };
    }
    const rows = await loadTrackedRows(queryRunner);
    const { applied, dirty } = validateTrackedRows(rows, orderedNames, digestByName);
    const dirtySet = new Set(dirty);
    return {
      tableExists: true,
      applied: orderedNames.filter((name) => applied.has(name)),
      pending: orderedNames.filter((name) => !applied.has(name) && !dirtySet.has(name)),
      dirty: orderedNames.filter((name) => dirtySet.has(name)),
    };
  });
}
