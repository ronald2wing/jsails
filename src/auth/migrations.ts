/**
 * Better Auth schema migrations for the first-party `auth` plugin.
 *
 * `getAuthMigrations()` resolves the shared, lazily-constructed Better Auth
 * instance and builds its migration plan through Better Auth's own
 * `getMigrations`. Importing this module performs no environment reads and no
 * database work: the instance (and any connection it opens) is resolved only
 * when the function is called.
 *
 * This is the single seam the starter's `auth:migrate` script and auth test
 * suite use. They no longer import the `better-auth/db/migration` subpath
 * directly — that resolution depended on npm hoisting a transitive framework
 * dependency into the app's own `node_modules`, which is not guaranteed.
 */

import { getMigrations } from 'better-auth/db/migration';

import { createAuth } from './instance.js';

/**
 * The migration plan Better Auth's `getMigrations` returns: the tables to
 * create or alter, the indexes to add, the warnings (`schemaProblems`,
 * `unsafeChanges`), and a `runMigrations()` runner that applies the plan.
 */
export type AuthMigrations = Awaited<ReturnType<typeof getMigrations>>;

/**
 * Build the migration plan for the shared auth instance.
 *
 * Failures are value-free: a missing connection variable is reported by name
 * only (see {@link createAuth}), and a malformed plan surfaces Better Auth's own
 * error without echoing credentials.
 */
export async function getAuthMigrations(): Promise<AuthMigrations> {
  return getMigrations(createAuth().options);
}
