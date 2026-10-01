/**
 * Test fixtures and transactional rollback for JSails data sources.
 *
 * {@link defineFixture} declares a named fixture (an entity name plus a row
 * array). {@link loadFixtures} inserts the rows in declaration order through
 * the data source's repository — no raw SQL, same pattern as seeders.
 * {@link withRollback} wraps a body in a {@link transaction} and always
 * rolls back (via an internal sentinel) so tests never commit fixture rows.
 *
 * ```ts
 * import { defineFixture, loadFixtures, withRollback } from 'jsails';
 *
 * const users = defineFixture('users', {
 *   entity: 'User',
 *   rows: [{ name: 'alice' }, { name: 'bob' }],
 * });
 *
 * await loadFixtures(dataSource, [users]);
 *
 * await withRollback(dataSource, async () => {
 *   const rows = await dataSource.getRepository(User).find();
 *   assert.equal(rows.length, 2); // fixture rows are visible inside
 *   return rows;
 * });
 * // No rows persisted — transaction was forced to roll back.
 * ```
 */

import { DataSource } from 'typeorm';

import type { JsailsDataSource } from './data-source.js';
import { transaction } from './transaction.js';

/** Raised for an invalid fixture declaration or a resolution failure. */
export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureError';
  }
}

/**
 * One fixture: an entity name (class name or table name) plus the rows to
 * insert. No class reference is stored — resolution happens lazily inside
 * {@link loadFixtures} against the live data source's metadata.
 */
export interface Fixture {
  /** The entity class name (e.g. `'User'`) or table name (e.g. `'users'`). */
  readonly entity: string;
  /** Rows inserted in array order. Every field must match the entity schema. */
  readonly rows: readonly Record<string, unknown>[];
}

/**
 * Declare a named fixture. The name is diagnostic only — it is never used
 * for resolution. Returns the same fixture object for chaining.
 */
export function defineFixture(name: string, fixture: Fixture): Fixture {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new FixtureError('defineFixture: "name" must be a non-empty string');
  }
  validateFixture(fixture);
  return fixture;
}

/** Sentinel thrown inside the transaction body to force a rollback. */
const ROLLBACK_SENTINEL = Symbol('jsails.fixture.rollback');

/**
 * Run `body` inside a transaction and always roll back after the body
 * resolves. The body receives the transaction-scoped manager (through
 * {@link transaction}) so fixture rows it inserts are visible to subsequent
 * `getRepository` calls inside the same body.
 *
 * - Body **resolves** → the result is captured, the sentinel forces a
 *   rollback, and `withRollback` returns the result. No rows are persisted.
 * - Body **throws** → the transaction rolls back and the original error is
 *   re-thrown unchanged. The body's error is never masked by the sentinel.
 */
export async function withRollback<T>(
  dataSource: JsailsDataSource,
  body: () => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    await transaction(dataSource, async () => {
      result = await body();
      throw ROLLBACK_SENTINEL;
    });
    // unreachable — the body either throws its own error or the sentinel
  } catch (error) {
    if (error === ROLLBACK_SENTINEL) {
      return result!;
    }
    throw error;
  }
  // unreachable — every path is handled in the catch above
  throw new Error('unreachable');
}

/**
 * Insert fixture rows in declaration order through the data source's
 * repository. Each fixture's `entity` is resolved against the data source's
 * metadata (matching entity class name or table name); a mismatch throws
 * {@link FixtureError}.
 *
 * Rows are inserted via `repository.save()` — one repository call per
 * fixture — so TypeORM lifecycle hooks (e.g. `beforeInsert`) fire normally.
 */
export async function loadFixtures(
  dataSource: JsailsDataSource,
  fixtures: readonly Fixture[],
): Promise<void> {
  validateFixturesParam(fixtures);
  for (const fixture of fixtures) {
    validateFixture(fixture);
    await saveFixtureRows(dataSource, fixture);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateFixturesParam(value: unknown): asserts value is readonly Fixture[] {
  if (!Array.isArray(value)) {
    throw new FixtureError('loadFixtures: "fixtures" must be an array');
  }
}

function validateFixture(fixture: unknown): asserts fixture is Fixture {
  if (fixture === null || typeof fixture !== 'object') {
    throw new FixtureError('fixture must be an object with "entity" and "rows"');
  }
  const f = fixture as Record<string, unknown>;
  if (typeof f.entity !== 'string' || f.entity.trim() === '') {
    throw new FixtureError('fixture.entity must be a non-empty string');
  }
  if (!Array.isArray(f.rows)) {
    throw new FixtureError('fixture.rows must be an array');
  }
}

async function saveFixtureRows(dataSource: JsailsDataSource, fixture: Fixture): Promise<void> {
  const ds = dataSource as unknown as DataSource;
  for (const metadata of ds.entityMetadatas) {
    if (metadata.name === fixture.entity || metadata.tableName === fixture.entity) {
      // metadata.target is the entity class / EntitySchema — cast through
      // any so the generic constraint does not interfere with runtime save.
      await ds.getRepository(metadata.target as any).save(fixture.rows);
      return;
    }
  }
  throw new FixtureError(`entity "${fixture.entity}" is not registered in the data source`);
}
