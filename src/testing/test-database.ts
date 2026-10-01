/**
 * Transactional database test harness (`jsails/testing`).
 *
 * The Laravel/Rails "DatabaseTransactions" ergonomic: `jsails test` boots a
 * `*_test` database and migrates it once; a test opts into per-test isolation
 * with {@link withTestTransaction}, which wraps the body in
 * {@link withRollback} so every insert the test makes is discarded afterward and
 * tests never leak rows into each other.
 *
 * This module imports the application runtime (the `JsailsDataSource` + the
 * transaction seam); it is server-only and never part of the browser-safe root
 * entry.
 */

import type { JsailsDataSource } from '../database/data-source.js';

/**
 * Wrap a test body in a rollback transaction against the test data source, so
 * every row it writes is discarded after it resolves. Mirrors Rails'
 * `ActiveRecord::TestCase`/Laravel's `DatabaseTransactions` trait.
 *
 * ```ts
 * await withTestTransaction(dataSource, async () => {
 *   const repo = dataSource.getRepository(User);
 *   await repo.save(repo.create({ email: 'a@x.test' }));
 * });
 * // the row is gone here.
 * ```
 *
 * The body's error propagates unchanged; the rollback happens regardless.
 */
export function withTestTransaction<T>(
  dataSource: JsailsDataSource,
  body: () => Promise<T>,
): Promise<T> {
  // Dynamic import keeps the read-only database fixture helpers out of the
  // eager import graph of the testing subpath.
  return import('../database/fixtures.js').then(({ withRollback }) =>
    withRollback(dataSource, body),
  );
}
