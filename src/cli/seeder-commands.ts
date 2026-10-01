/**
 * The `seed` command: run registered database seeders against an initialized
 * data source. Its config module defaults to `jsails.seed.js` and
 * default-exports `{ registry, dataSource }` — a {@link SeederRegistry} plus a
 * TypeORM `DataSource` (a `JsailsDataSource` satisfies it). The command owns the
 * data source lifecycle exactly like the migration commands: it initializes the
 * source before running, and destroys it afterward. TypeScript configs must be
 * compiled to JavaScript first, so a `.ts` path is rejected rather than executed.
 */

import { DataSource } from 'typeorm';

import {
  createSeederRegistry,
  runSeeders,
  type Seeder,
  type SeederRegistry,
} from '../database/seeders.js';

import { loadConfigModule } from './config-loader.js';
import { formatError } from '../internal/errors.js';

/** The shape a seed config module default-exports. */
export interface SeedConfig {
  /** Name -> seeder map, validated structurally (never executed here). */
  readonly registry: SeederRegistry;
  /** The data source every seeder writes through. */
  readonly dataSource: DataSource;
}

/** Options for {@link runSeedCommand}. */
export interface SeedCommandOptions {
  /** The seeders to run; absent runs all seeders in registry order. */
  readonly names?: readonly string[];
}

/** Dependency seam for the `seed` command; tests inject a config loader. */
export interface SeedCommandDeps {
  /** Load and validate the seed config module. */
  loadConfig(configPath: string): Promise<SeedConfig>;
  /** Write one output line. */
  stdout(text: string): void;
}

const defaultSeedCommandDeps: SeedCommandDeps = {
  loadConfig: loadSeedConfig,
  stdout: (text) => process.stdout.write(`${text}\n`),
};

/**
 * Validate a seed config default export: a non-null object with a structurally
 * valid `registry` (re-validated without executing any seeder) and a TypeORM
 * `DataSource` under `dataSource`. Exported for direct unit testing.
 */
export function validateSeedConfig(raw: unknown, configPath: string): SeedConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`seed config "${configPath}" must default-export an object`);
  }
  const config = raw as Record<string, unknown>;

  let registry: SeederRegistry;
  try {
    registry = createSeederRegistry(config.registry as Record<string, Seeder>);
  } catch (error) {
    throw new Error(`seed config "${configPath}" has an invalid registry: ${formatError(error)}`);
  }

  if (!(config.dataSource instanceof DataSource)) {
    throw new Error(
      `seed config "${configPath}" must include a TypeORM DataSource under "dataSource"`,
    );
  }

  return { registry, dataSource: config.dataSource };
}

/** Import the seed config module and return its validated default export. */
export async function loadSeedConfig(configPath: string): Promise<SeedConfig> {
  const raw = await loadConfigModule(configPath);
  return validateSeedConfig(raw, configPath);
}

/**
 * Run the seeders named by `options.names` (or all, in registry order) against
 * the config's data source, initializing and destroying it around the run.
 * Returns the process exit code.
 */
export async function runSeedCommand(
  configPath: string,
  options: SeedCommandOptions = {},
  deps: SeedCommandDeps = defaultSeedCommandDeps,
): Promise<number> {
  const { registry, dataSource } = await deps.loadConfig(configPath);

  await dataSource.initialize();
  try {
    const ran = await runSeeders(registry, { dataSource, names: options.names });
    if (ran.length === 0) {
      deps.stdout('No seeders to run.');
    } else {
      for (const name of ran) {
        deps.stdout(`Seeded ${name}`);
      }
    }
  } finally {
    await dataSource.destroy();
  }
  return 0;
}
