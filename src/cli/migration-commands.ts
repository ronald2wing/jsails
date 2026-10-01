/**
 * Migration commands: `makemigrations` (offline generation), `migrate` (forward
 * apply or rollback), and `showmigrations` (read-only status). Their config
 * module is a JS ESM module default-exporting a {@link JsailsDataSource};
 * TypeScript configs must be compiled to JavaScript first, so a `.ts` path is
 * rejected rather than executed. Migrations are plain JSON definitions read
 * from a directory and validated through the same history APIs the runner uses.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { JsailsDataSource } from '../database/data-source.js';
import { generateMigration } from '../migrations/autodetector.js';
import { createDataMigrationRegistry, type DataMigration } from '../migrations/data.js';
import type { MigrationDefinition, MigrationHistory } from '../migrations/history.js';
import { resolveMigrationOrder } from '../migrations/history.js';
import { isValidIdentifier, MigrationError } from '../migrations/schema-state.js';
import { getMigrationStatus, migrate, rollbackTo } from '../migrations/migrator.js';
import type {
  MigrateOptions,
  MigrationDataSource,
  RollbackOptions,
} from '../migrations/migrator.js';

import { loadDataSourceConfig } from './config-loader.js';
import { formatError, isErrno } from '../internal/errors.js';

/**
 * Read every `*.json` migration definition in the directory, in deterministic
 * filename order. A missing directory is an empty history. Parsing errors are
 * surfaced with the offending path; structural validation is left to the
 * history APIs (`resolveMigrationOrder` / `generateMigration`).
 */
async function readMigrationHistory(dir: string): Promise<MigrationHistory> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return [];
    }
    throw new Error(`failed to read migrations directory "${dir}": ${formatError(error)}`);
  }

  const migrations: MigrationDefinition[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const filePath = join(dir, entry);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      throw new Error(`failed to read migration "${filePath}": ${formatError(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`migration "${filePath}" is not valid JSON: ${formatError(error)}`);
    }
    migrations.push(parsed as MigrationDefinition);
  }
  return migrations;
}

export async function runMakemigrations(
  configPath: string,
  migrationsDir: string,
  name: string,
  allowDestructive: boolean,
): Promise<number> {
  if (!isValidIdentifier(name)) {
    throw new Error(
      `invalid migration name ${JSON.stringify(name)}; ` +
        `names must match [A-Za-z_][A-Za-z0-9_]*`,
    );
  }

  const dataSource = await loadDataSourceConfig(configPath);
  const absoluteDir = resolve(migrationsDir);
  const history = await readMigrationHistory(absoluteDir);

  // Build the model schema offline: metadata only, no database connection.
  const desiredSchema = await dataSource.getModelSchema();
  const migration = generateMigration(name, history, desiredSchema, {
    allowDestructive,
  });

  if (migration === null) {
    console.log('No changes detected.');
    return 0;
  }

  await mkdir(absoluteDir, { recursive: true });
  const filePath = join(absoluteDir, `${name}.json`);
  try {
    await writeFile(filePath, `${JSON.stringify(migration, null, 2)}\n`, {
      flag: 'wx',
    });
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      throw new Error(`migration "${name}" already exists at "${filePath}"; refusing to overwrite`);
    }
    throw error;
  }
  console.log(`Created migration ${filePath}`);
  return 0;
}

/** Showmigrations output format. */
export type ShowmigrationsFormat = 'table' | 'json' | 'plan';

/** Validate the on-disk history before any connection is opened. */
function validatedOrderedHistory(history: MigrationHistory): string[] {
  return resolveMigrationOrder(history).map((migration) => migration.name);
}

/**
 * Load the `dataMigrations` named export from the config module, if present.
 * Returns a validated registry, or `undefined` when the module has no such export.
 */
async function loadDataMigrationRegistry(
  configPath: string,
): Promise<ReadonlyMap<string, DataMigration> | undefined> {
  const resolved = resolve(configPath);
  let module: Record<string, unknown>;
  try {
    module = await import(resolved);
  } catch {
    // If the config can't be loaded, the main loadDataSourceConfig will fail
    // with a better error. Return undefined — the migrator will fail with a
    // clear "data migration not registered" error when it encounters one.
    return undefined;
  }
  if (module.dataMigrations !== undefined) {
    const raw = module.dataMigrations as Record<string, DataMigration>;
    if (typeof raw !== 'object' || raw === null) {
      throw new MigrationError(
        '"dataMigrations" export must be an object of DataMigration instances',
      );
    }
    return createDataMigrationRegistry(raw);
  }
  return undefined;
}

/** Forward-migration options resolved from the CLI. */
export interface MigrateCliOptions {
  /** Record without executing. */
  fake?: boolean;
  /** Record the first migration without executing when the table is empty. */
  fakeInitial?: boolean;
}

/**
 * Adapt a {@link JsailsDataSource} to the runner's structural contract. The
 * base `DataSource` declares `options: DataSourceOptions`, whose `database` is
 * `string | Uint8Array` (for sqljs); for the SQL drivers JsailsDataSource
 * supports it is always a string at runtime.
 */
function asMigrationDataSource(dataSource: JsailsDataSource): MigrationDataSource {
  return dataSource as unknown as MigrationDataSource;
}

/** Rollback options resolved from the CLI flags, or null for a forward run. */
export type MigrateMode =
  { kind: 'forward' } | { kind: 'down'; targetName: string } | { kind: 'steps'; steps: number };

export async function runMigrate(
  configPath: string,
  migrationsDir: string,
  mode: MigrateMode,
  cliOptions?: MigrateCliOptions,
): Promise<number> {
  const dataSource = await loadDataSourceConfig(configPath);
  const history = await readMigrationHistory(resolve(migrationsDir));
  const orderedNames = validatedOrderedHistory(history);

  const dataMigrationRegistry = await loadDataMigrationRegistry(configPath);

  await dataSource.initialize();
  try {
    if (orderedNames.length === 0) {
      // No local history must not bypass the database: read-only status both
      // verifies tracking is clean and rejects orphaned applied rows without
      // creating a tracking table a real migrate would otherwise leave behind.
      await getMigrationStatus(asMigrationDataSource(dataSource), history);
      console.log('No migrations found.');
      return 0;
    }

    if (mode.kind === 'forward') {
      const migrateOptions: MigrateOptions | undefined =
        (cliOptions?.fake ?? cliOptions?.fakeInitial ?? dataMigrationRegistry)
          ? {
              fake: cliOptions?.fake,
              fakeInitial: cliOptions?.fakeInitial,
              dataMigrations: dataMigrationRegistry,
            }
          : undefined;
      const result = await migrate(asMigrationDataSource(dataSource), history, migrateOptions);
      if (result.applied.length === 0) {
        console.log('Nothing to migrate.');
      } else {
        const label = (cliOptions?.fake ?? cliOptions?.fakeInitial) ? 'Faked' : 'Applied';
        for (const name of result.applied) {
          console.log(`${label} ${name}`);
        }
      }
      return 0;
    }

    const options: RollbackOptions =
      mode.kind === 'down'
        ? { targetName: mode.targetName, allowDestructive: true }
        : { steps: mode.steps, allowDestructive: true };
    const result = await rollbackTo(
      asMigrationDataSource(dataSource),
      history,
      options,
      dataMigrationRegistry,
    );
    if (result.unapplied.length === 0) {
      console.log('Nothing to roll back.');
    } else {
      for (const name of result.unapplied) {
        console.log(`Unapplied ${name}`);
      }
    }
  } finally {
    await dataSource.destroy();
  }
  return 0;
}

export async function runShowmigrations(
  configPath: string,
  migrationsDir: string,
  format: ShowmigrationsFormat = 'table',
): Promise<number> {
  const formatValue: ShowmigrationsFormat =
    format === 'table' || format === 'json' || format === 'plan' ? format : 'table';

  const dataSource = await loadDataSourceConfig(configPath);
  const history = await readMigrationHistory(resolve(migrationsDir));
  const orderedNames = validatedOrderedHistory(history);

  await dataSource.initialize();
  try {
    const status = await getMigrationStatus(asMigrationDataSource(dataSource), history);
    if (orderedNames.length === 0) {
      if (formatValue === 'json') {
        console.log('[]');
      } else {
        console.log('No migrations found.');
      }
      return 0;
    }

    const applied = new Set(status.applied);
    const dirty = new Set(status.dirty);

    switch (formatValue) {
      case 'json': {
        const entries = orderedNames.map((name, index) => ({
          name,
          index,
          applied: applied.has(name),
          dirty: dirty.has(name),
          kind: history.find((m) => m.name === name)?.kind ?? 'schema',
        }));
        console.log(JSON.stringify(entries, null, 2));
        break;
      }
      case 'plan': {
        // plan format: non-applied migrations with their full operations
        const pending = orderedNames.filter((name) => !applied.has(name) && !dirty.has(name));
        for (const name of pending) {
          console.log(`-- ${name}`);
        }
        break;
      }
      case 'table':
      default: {
        for (const name of orderedNames) {
          const marker = applied.has(name) ? '[x]' : dirty.has(name) ? '[!]' : '[ ]';
          const migration = history.find((m) => m.name === name);
          const kindSuffix = migration?.kind === 'data' ? ' (data)' : '';
          console.log(`${marker} ${name}${kindSuffix}`);
        }
        break;
      }
    }
  } finally {
    await dataSource.destroy();
  }
  return 0;
}
