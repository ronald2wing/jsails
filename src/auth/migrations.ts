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

import { createAuth, type AuthBuildOptions } from './instance.js';

/**
 * The migration plan Better Auth's `getMigrations` returns: the tables to
 * create or alter, the indexes to add, the warnings (`schemaProblems`,
 * `unsafeChanges`), and a `runMigrations()` runner that applies the plan.
 */
export type AuthMigrations = Awaited<ReturnType<typeof getMigrations>>;

/**
 * Build the migration plan for the shared auth instance.
 *
 * `options` must match the plugin's configuration when the app enables
 * `twoFactor`/`socialProviders`, so the plan includes their tables (the default
 * no-arg call reads the already-memoized instance when the plugin ran first).
 *
 * Failures are value-free: a missing connection variable is reported by name
 * only (see {@link createAuth}), and a malformed plan surfaces Better Auth's own
 * error without echoing credentials.
 *
 * The plan's `runMigrations()` executes against the same connection the plan was
 * built from, so this function deliberately does **not** release the pool: a
 * caller that builds a plan and then runs it needs the connection alive across
 * both calls. `auth:migrate` is a short-lived process that exits explicitly
 * after running the plan, so its pool is bounded by process exit.
 */
export async function getAuthMigrations(options?: AuthBuildOptions): Promise<AuthMigrations> {
  return getMigrations(createAuth(options).options);
}
