/**
 * Data migrations: named, declaration-ordered functions that run against a live
 * database connection as the **second phase** of `db:push`, after the schema is
 * reconciled.
 *
 * A data migration carries `up` (and `down`) handlers, each receiving a
 * {@link DataMigrationContext} that exposes a minimal query runner over the
 * already-initialized data source. No DDL is expected — schema alterations
 * belong in the declared model, which the reconciler already applies in phase 1.
 *
 * ## No ledger, idempotent by contract
 *
 * A data migration is **not recorded as applied**. There is no tracking table,
 * no `data_version` column, and no checksum — the ledger is exactly the history
 * model the declarative engine deleted. `up` therefore runs on **every**
 * `db:push`, so every data migration MUST be idempotent: the canonical form is a
 * guarded `UPDATE ... WHERE <not-yet-migrated>`, never an unguarded `INSERT`. A
 * non-idempotent migration duplicates rows on the second push; that is the
 * author's responsibility.
 *
 * `down` is kept as a documented **manual escape hatch** — no command invokes
 * it. Without a ledger the engine cannot know which migrations ran, so it cannot
 * safely auto-revert; `down` exists for the developer to call from a script or
 * REPL when reverting a data change by hand.
 */

import type { QueryRunner } from 'typeorm';
import { MigrationError } from './schema-types.js';
import { validateIdentifier } from './schema-validation.js';

/** Context exposed to a data migration's `up` and `down` handlers. */
export interface DataMigrationContext {
  /** The query runner bound to the current migration session. */
  readonly queryRunner: QueryRunner;
}

/**
 * A data migration. `up` runs on every `db:push` and must be idempotent. `down`
 * is a manual escape hatch — no command invokes it.
 */
export interface DataMigration {
  readonly name: string;
  up(ctx: DataMigrationContext): Promise<void>;
  down(ctx: DataMigrationContext): Promise<void>;
}

/**
 * Define a data migration with `up` and `down` handlers. `name` must be a valid
 * identifier. `up` must be idempotent (it runs on every `db:push`); `down` is
 * for manual reverts only.
 */
export function defineDataMigration(def: {
  name: string;
  up(ctx: DataMigrationContext): Promise<void>;
  down(ctx: DataMigrationContext): Promise<void>;
}): DataMigration {
  const name = validateIdentifier(def.name);
  return { name, up: def.up, down: def.down };
}

/**
 * Validate and index a collection of data migrations keyed by name.
 * Rejects duplicate names, names that don't match the key, and invalid identifiers.
 */
export function createDataMigrationRegistry(
  migrations: Record<string, DataMigration>,
): ReadonlyMap<string, DataMigration> {
  const registry = new Map<string, DataMigration>();
  for (const [key, migration] of Object.entries(migrations)) {
    if (typeof migration !== 'object' || migration === null) {
      throw new MigrationError(`data migration "${key}" must be a DataMigration object`);
    }
    // Check duplicate name first so entries with different keys but the same name
    // are caught as duplicates, not as key/name mismatches.
    if (typeof migration.name !== 'string') {
      throw new MigrationError(`data migration "${key}" must have a string "name"`);
    }
    if (registry.has(migration.name)) {
      throw new MigrationError(`duplicate data migration name "${migration.name}"`);
    }
    if (migration.name !== key) {
      throw new MigrationError(
        `data migration key "${key}" does not match its name "${migration.name}"`,
      );
    }
    if (typeof migration.up !== 'function') {
      throw new MigrationError(`data migration "${migration.name}" must have an "up" function`);
    }
    if (typeof migration.down !== 'function') {
      throw new MigrationError(`data migration "${migration.name}" must have a "down" function`);
    }
    registry.set(migration.name, migration);
  }
  return registry;
}
