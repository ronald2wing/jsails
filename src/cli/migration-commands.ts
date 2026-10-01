/**
 * Declarative schema commands: `db:push` (diff + apply) and `db:diff` (read-only).
 *
 * The reconciler compares the declared model schema against the live database
 * and emits a plan of operations. `db:push` applies the plan, then runs the
 * config's data migrations (phase 2); `db:diff` prints the schema plan. Both use
 * a single {@link JsailsDataSource} for model metadata and the live connection —
 * there is no migration history, no tracking table, and no rollback. The
 * declarative engine replaced the Rails-style scalar-history engine
 * (makemigrations / migrate / showmigrations) in Phase 5.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { QueryRunner } from 'typeorm';

import { type Operation } from '../migrations/operations.js';
import { reconcileDataSource, type SchemaPlan } from '../migrations/reconciler.js';
import { executeSchemaPlan } from '../migrations/schema-executor.js';
import { createDataMigrationRegistry, type DataMigration } from '../migrations/data.js';
import { MigrationError } from '../migrations/schema-types.js';

import { loadDataSourceConfig } from './config-loader.js';

// ---------------------------------------------------------------------------
// Format operations for human-readable output
// ---------------------------------------------------------------------------

/**
 * Render a single operation as a human-readable line. Only table/column/index
 * identifiers already present in the operation are included; no driver-specific
 * type or definition details are surfaced.
 */
export function formatOperation(op: Operation): string {
  switch (op.kind) {
    case 'create_table':
      return `create_table ${op.table.name}`;
    case 'drop_table':
      return `drop_table ${op.table.name}`;
    case 'add_column':
      return `add_column ${op.table}.${op.column.name}`;
    case 'drop_column':
      return `drop_column ${op.table}.${op.column.name}`;
    case 'rename_column':
      return `rename_column ${op.table}.${op.from} -> ${op.to}`;
    case 'rename_table':
      return `rename_table ${op.from} -> ${op.to}`;
    case 'alter_column':
      return `alter_column ${op.table}.${op.column.name}`;
    case 'alter_inheritance':
      return `alter_inheritance ${op.table}`;
    case 'alter_polymorphic':
      return `alter_polymorphic ${op.table}`;
    case 'add_index':
      return `add_index ${op.table} ${op.index.name}`;
    case 'drop_index':
      return `drop_index ${op.table} ${op.index.name}`;
    case 'add_unique':
      return `add_unique ${op.table} ${op.unique.name}`;
    case 'drop_unique':
      return `drop_unique ${op.table} ${op.unique.name}`;
    case 'add_fk':
      return `add_fk ${op.table} ${op.foreignKey.name}`;
    case 'drop_fk':
      return `drop_fk ${op.table} ${op.foreignKey.name}`;
    case 'add_check':
      return `add_check ${op.table} ${op.check.name}`;
    case 'drop_check':
      return `drop_check ${op.table} ${op.check.name}`;
  }
}

/** Render a {@link SchemaPlan} as an ordered array of lines for printing. */
export function formatSchemaPlan(plan: SchemaPlan): string[] {
  const lines: string[] = [];
  for (const op of plan.operations) {
    lines.push(formatOperation(op));
  }
  if (plan.upToDate) {
    lines.push('Database is up to date.');
  } else {
    const destructiveFlag = plan.destructive ? ' (destructive)' : '';
    lines.push(`${plan.operations.length} operation(s)${destructiveFlag}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Declarative DB commands: db:push and db:diff
// ---------------------------------------------------------------------------

/** Options for `runDbPush`. */
export interface DbPushOptions {
  readonly dryRun: boolean;
  readonly allowDestructive: boolean;
}

/**
 * Load the `dataMigrations` named export from the config module, if present.
 *
 * The config module keeps its default export as the `JsailsDataSource`; data
 * migrations ride a separate named export so the schema surface stays
 * `default`-only. Returns a validated registry keyed by name in **declaration
 * order** (object key order), or an empty map when the module exports none.
 *
 * A module that fails to load returns an empty map — {@link loadDataSourceConfig}
 * will have already failed with a better error, so this never masks a real
 * config problem.
 */
async function loadDataMigrationRegistry(
  configPath: string,
): Promise<ReadonlyMap<string, DataMigration>> {
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(resolve(configPath)).href)) as Record<string, unknown>;
  } catch {
    return new Map();
  }
  const raw = module.dataMigrations;
  if (raw === undefined) {
    return new Map();
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new MigrationError(
      'the "dataMigrations" export must be an object of DataMigration values',
    );
  }
  // `createDataMigrationRegistry` validates names/functions; the returned Map
  // preserves insertion (declaration) order, which is the execution order.
  return createDataMigrationRegistry(raw as Record<string, DataMigration>);
}

/** Structural contract a data migration needs from a data source. */
export interface DataMigrationDataSource {
  createQueryRunner(): QueryRunner;
}

/**
 * Run the config's data migrations in declaration order against an initialized
 * data source. No ledger: every migration's `up` runs on every call, so each
 * must be idempotent. Returns the names run, in order.
 *
 * The query runner is connected for the batch and released in a `finally`; a
 * migration that throws surfaces unwrapped and stops the sequence (later
 * migrations are not run).
 */
export async function runDataMigrations(
  dataSource: DataMigrationDataSource,
  migrations: ReadonlyMap<string, DataMigration>,
): Promise<readonly string[]> {
  const ran: string[] = [];
  if (migrations.size === 0) {
    return ran;
  }
  const queryRunner = dataSource.createQueryRunner();
  let primaryError: unknown;
  let connected = false;
  try {
    await queryRunner.connect();
    connected = true;
    for (const migration of migrations.values()) {
      await migration.up({ queryRunner });
      ran.push(migration.name);
    }
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
  if (primaryError !== undefined) {
    throw primaryError;
  }
  return ran;
}

/**
 * Diff the declared model schema against the live database and apply the plan,
 * then run data migrations (phase 2).
 *
 * When `options.dryRun` is set the plan is printed and nothing is applied.
 * When the plan is destructive and `options.allowDestructive` is not set, the
 * command refuses (exit 1) and lists the destructive operations — and phase 2
 * never runs (a refused phase 1 short-circuits the push).
 *
 * Data migrations run on **every** push, including when the schema is already up
 * to date: they carry no ledger, so a data-only change must remain runnable
 * without a schema diff.
 */
export async function runDbPush(configPath: string, options: DbPushOptions): Promise<number> {
  const dataSource = await loadDataSourceConfig(configPath);
  try {
    const plan = await reconcileDataSource(dataSource, { allowDestructive: true });

    if (plan.destructive && !options.allowDestructive) {
      console.log(
        'The plan contains destructive operations. Review them and re-run with --allow-destructive:',
      );
      for (const op of plan.operations) {
        console.log(`  ${formatOperation(op)}`);
      }
      return 1;
    }

    if (options.dryRun) {
      if (plan.upToDate) {
        console.log('Database is up to date.');
      } else {
        for (const line of formatSchemaPlan(plan)) {
          console.log(line);
        }
      }
      // Phase 2 is not connected, so a dry run can only report what *would* run.
      const migrations = await loadDataMigrationRegistry(configPath);
      for (const name of migrations.keys()) {
        console.log(`Would run data migration ${name}`);
      }
      return 0;
    }

    // `reconcileDataSource` introspects the live database through
    // `getLiveSchema`, which initializes the data source as a side effect. Only
    // initialize when it is somehow not yet connected, so we never double-connect.
    if (!dataSource.isInitialized) {
      await dataSource.initialize();
    }
    if (plan.upToDate) {
      console.log('Database is up to date.');
    } else {
      await executeSchemaPlan(dataSource, plan.operations);
      for (const op of plan.operations) {
        console.log(`Applied ${formatOperation(op)}`);
      }
    }

    const migrations = await loadDataMigrationRegistry(configPath);
    const ran = await runDataMigrations(dataSource, migrations);
    for (const name of ran) {
      console.log(`Ran data migration ${name}`);
    }
  } finally {
    await dataSource.destroy();
  }
  return 0;
}

/**
 * Diff the declared model schema against the live database and print the plan
 * without applying it. Read-only: never requires `--allow-destructive`.
 */
export async function runDbDiff(configPath: string): Promise<number> {
  const dataSource = await loadDataSourceConfig(configPath);
  try {
    const plan = await reconcileDataSource(dataSource);
    for (const line of formatSchemaPlan(plan)) {
      console.log(line);
    }
  } finally {
    await dataSource.destroy();
  }
  return 0;
}
