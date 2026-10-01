/**
 * Data migration definitions: functions that run against a live database
 * connection, sequenced in the same linear migration chain as schema changes.
 *
 * A data migration carries `up` and `down` handlers, each receiving a
 * {@link DataMigrationContext} that exposes a minimal query runner over the
 * already-initialized data source. No DDL is expected — schema alterations
 * belong in schema migrations.
 *
 * Data migrations are recorded in the `jsails_migrations` tracking table with
 * `kind = 'data'` and are invertible via their `down` handler. A data migration
 * without `down` is refused on rollback (value-free).
 */

import type { QueryRunner } from 'typeorm';
import { MigrationError } from './schema-state.js';
import { validateIdentifier } from './schema-state.js';

/** Context exposed to a data migration's `up` and `down` handlers. */
export interface DataMigrationContext {
  /** The query runner bound to the current migration session. */
  readonly queryRunner: QueryRunner;
}

/** A data migration: named, forward-invertible, bound to a live connection. */
export interface DataMigration {
  readonly name: string;
  up(ctx: DataMigrationContext): Promise<void>;
  down(ctx: DataMigrationContext): Promise<void>;
}

/**
 * Define a data migration with required `up` and `down` handlers.
 * `name` must be a valid identifier.
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
