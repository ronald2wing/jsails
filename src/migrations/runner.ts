/**
 * Forward migration runner.
 *
 * Applies a validated linear migration history to an initialized data source,
 * recording each applied migration in the reserved `jsails_migrations` tracking
 * table. Only forward application and read-only status are provided; rollback
 * and a CLI are out of scope for this slice.
 *
 * The entire history is resolved (linear-graph validation), replayed (operation
 * precondition validation), and preflighted against the driver before any
 * database work, so a malformed history never half-applies.
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
import type { MigrationDefinition, MigrationHistory } from './history.js';
import { replayOrderedHistory, resolveMigrationOrder } from './history.js';
import type { Operation } from './operations.js';
import { MigrationError } from './schema-state.js';

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
 */
function migrationDigest(migration: MigrationDefinition): string {
  const payload = {
    name: migration.name,
    dependency: migration.dependencies[0] ?? null,
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
    ],
  });
}

/** Positional placeholder for the driver: `$n` for Postgres, `?` otherwise. */
function placeholder(driver: SchemaEditorDriver, index: number): string {
  return driver === 'postgres' ? `$${index}` : '?';
}

function insertRowSql(driver: SchemaEditorDriver): string {
  return (
    `INSERT INTO ${MIGRATIONS_TABLE} (name, checksum, status) VALUES ` +
    `(${placeholder(driver, 1)}, ${placeholder(driver, 2)}, ${placeholder(driver, 3)})`
  );
}

function updateStatusSql(driver: SchemaEditorDriver): string {
  return (
    `UPDATE ${MIGRATIONS_TABLE} SET status = ${placeholder(driver, 1)} ` +
    `WHERE name = ${placeholder(driver, 2)}`
  );
}

const SELECT_ROWS_SQL = `SELECT name, checksum, status FROM ${MIGRATIONS_TABLE}`;

interface PreparedMigration {
  name: string;
  operations: Operation[];
  checksum: string;
}

interface TrackedRow {
  name: string;
  checksum: string;
  status: string;
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
  return (result.records as Array<{ name: unknown; checksum: unknown; status: unknown }>).map(
    (row) => ({
      name: String(row.name),
      checksum: String(row.checksum),
      status: String(row.status),
    }),
  );
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
): Promise<void> {
  await queryRunner.query(insertRowSql(driver), [name, checksum, status]);
}

async function updateMigrationStatus(
  queryRunner: QueryRunner,
  driver: SchemaEditorDriver,
  name: string,
  status: string,
): Promise<void> {
  await queryRunner.query(updateStatusSql(driver), [status, name]);
}

async function applyMigration(
  queryRunner: QueryRunner,
  driver: SchemaEditorDriver,
  name: string,
  operations: Operation[],
  checksum: string,
): Promise<void> {
  if (driver === 'postgres' || driver === 'sqlite') {
    await queryRunner.startTransaction();
    try {
      for (const operation of operations) {
        await executeSchemaOperation(queryRunner, operation, driver);
      }
      await insertMigrationRow(queryRunner, driver, name, checksum, STATUS_APPLIED);
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
  await insertMigrationRow(queryRunner, driver, name, checksum, STATUS_APPLYING);
  for (const operation of operations) {
    await executeSchemaOperation(queryRunner, operation, driver);
  }
  await updateMigrationStatus(queryRunner, driver, name, STATUS_APPLIED);
}

/**
 * Apply all pending migrations from `history` to `dataSource`, recording each
 * in the tracking table. The whole history is validated, replayed, and
 * preflighted before any database work begins.
 */
export async function migrate(
  dataSource: MigrationDataSource,
  history: MigrationHistory,
): Promise<MigrationRunResult> {
  assertInitialized(dataSource);
  const driver = dataSource.jsailsDriver;
  const database = dataSource.options.database ?? '';

  const prepared = prepareHistory(history, driver);
  const orderedNames = prepared.map((entry) => entry.name);
  const digestByName = new Map(prepared.map((entry) => [entry.name, entry.checksum]));

  return withQueryRunner(dataSource, async (queryRunner) => {
    await acquireSessionLock(queryRunner, driver, database);

    let primaryError: unknown;
    let result: MigrationRunResult | undefined;
    try {
      if (!(await queryRunner.hasTable(MIGRATIONS_TABLE))) {
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
        await applyMigration(queryRunner, driver, entry.name, entry.operations, entry.checksum);
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
