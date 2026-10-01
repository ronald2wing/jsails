/**
 * Schema-plan executor: applies a list of DDL operations to a data source
 * with the correct per-driver transaction discipline.
 *
 * This is the DDL execution core extracted from the old migration-history
 * runner (`applyMigration` + `withQueryRunner`). The declarative reconciler
 * produces an ordered plan; this module applies it, with no tracking table,
 * no history, and no rollback — only the connect/preflight/apply/release
 * lifecycle.
 *
 * - Postgres/SQLite: the entire batch runs in a single transaction so a
 *   mid-plan failure leaves the database unchanged.
 * - MySQL/MariaDB: DDL auto-commits — there is no transaction boundary.
 *   A failure at the Nth operation leaves the first N-1 durably applied.
 *   Callers should review the plan via a dry run before applying.
 */

import type { QueryRunner } from 'typeorm';
import { executeSchemaOperation, preflightSchemaOperations } from '../database/schema-editor.js';
import type { SchemaEditorDriver } from '../database/schema-editor.js';
import { type Operation } from './operations.js';
import { MigrationError } from './schema-types.js';

/** Structural contract the executor needs from a data source. */
export interface SchemaExecutorDataSource {
  readonly isInitialized: boolean;
  readonly jsailsDriver: SchemaEditorDriver;
  createQueryRunner(): QueryRunner;
  initialize(): Promise<unknown>;
}

function assertInitialized(dataSource: SchemaExecutorDataSource): void {
  if (!dataSource.isInitialized) {
    throw new MigrationError('data source must be initialized before executing a schema plan');
  }
}

/**
 * Run `fn` against a connected query runner, always releasing it, never
 * obscuring the primary error.
 */
async function withQueryRunner<T>(
  dataSource: SchemaExecutorDataSource,
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

/**
 * Apply a plan of schema operations to an initialized data source.
 *
 * Every operation is preflighted against the driver before any DDL runs,
 * so a malformed plan is refused before the database is touched.
 *
 * Postgres/SQLite wrap the entire batch in a transaction — a mid-plan
 * failure leaves the database unchanged. MySQL/MariaDB DDL auto-commits
 * so there is no transaction boundary (inherent to non-transactional DDL
 * engines).
 */
export async function executeSchemaPlan(
  dataSource: SchemaExecutorDataSource,
  operations: readonly Operation[],
): Promise<void> {
  assertInitialized(dataSource);

  // Preflight rejects a malformed plan before any database work.
  const driver = dataSource.jsailsDriver;
  const validated = preflightSchemaOperations(operations as Operation[], driver);
  if (validated.length === 0) {
    return;
  }

  await withQueryRunner(dataSource, async (queryRunner) => {
    const isPostgresOrSqlite = driver === 'postgres' || driver === 'sqlite';
    if (isPostgresOrSqlite) {
      await queryRunner.startTransaction();
      try {
        for (const op of validated) {
          await executeSchemaOperation(queryRunner, op, driver);
        }
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

    // MySQL/MariaDB: DDL auto-commits — see module doc note above.
    for (const op of validated) {
      await executeSchemaOperation(queryRunner, op, driver);
    }
  });
}
