/**
 * Contract test for the auth migration disposal seam.
 *
 * `getAuthMigrations()` builds Better Auth's migration plan from the shared
 * memoized instance and hands back a plan whose `runMigrations()` runs against
 * the same connection the plan was built from. It therefore must NOT release the
 * pool: doing so would leave `runMigrations()` executing against a destroyed
 * Kysely instance. `auth:migrate` is a short-lived process that exits explicitly
 * after running the plan, so its pool is bounded by process exit.
 *
 * NOTE (live-DB gap): `getAuthMigrations()` itself cannot run in-process without
 * a live MariaDB — Better Auth's `getMigrations` introspects the database
 * (`db.introspection.getTables()`), which needs a real connection. The full
 * build-plan-then-run round-trip is exercised end-to-end by the starter's live
 * `auth:migrate` journey (`npm run verify:starter`). This suite pins the disposal
 * primitive that the app-config shutdown seam uses, without a database.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { attachDispose, type Auth } from '../../src/auth/instance.js';

describe('auth migration disposal seam', () => {
  it('exposes an idempotent dispose a caller can invoke after running', async () => {
    // `disposeCachedAuth` (the app-config shutdown seam) goes through the
    // instance's own `dispose`; it must run its work exactly once even when
    // invoked repeatedly, so a double shutdown cannot destroy the pool twice.
    let released = 0;
    const auth = attachDispose({} as Auth, async () => {
      released += 1;
    });

    await Promise.all([auth.dispose(), auth.dispose()]);
    await auth.dispose();
    assert.equal(released, 1);
  });
});
