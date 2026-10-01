/**
 * Built-in command catalog: static, lazily-loaded contribution descriptors
 * for every heavy-command the CLI owns (T3.3 phase 3).
 *
 * Each descriptor carries a name, summary, config discriminant, and a `load()`
 * thunk that dynamic-imports the real runner module on demand. The thunks are
 * never called by listing/help — only when a command is actually dispatched.
 *
 * This catalog is the sole source of truth for which built-in commands exist,
 * what config type they require, and which module implements them. The heavy
 * dispatch ({@link ../dispatch}) resolves commands through this catalog instead
 * of a hardcoded name-to-runner map.
 */

import type { CommandConfigType } from '../extensions/plugin-contract.js';

/**
 * Signature of every built-in command runner. Each `load()` thunk returns a
 * function of this shape so {@link ../dispatch} can call it uniformly.
 *
 * @param configPath  Resolved path to the config module the command needs.
 * @param values      The parsed CLI flag values ({@link parseArgs} output).
 * @param rest        Positional arguments after the command name.
 */
export type BuiltinCommandRunner = (
  configPath: string,
  values: Record<string, unknown>,
  rest: readonly string[],
) => Promise<number>;

/** A built-in command descriptor: metadata + a lazy runner thunk. */
export interface BuiltinCommandDescriptor {
  readonly name: string;
  readonly summary: string;
  readonly config: CommandConfigType;
  readonly load: () => Promise<BuiltinCommandRunner>;
}

/**
 * The authoritative list of built-in heavy commands. Order is stable and
 * mirrors the existing help text / dispatch surface.
 *
 * config taxonomy:
 *   'migration' — makemigrations, migrate, showmigrations
 *   'runtime'   — work, schedule, queue, schedules
 *   'seed'      — seed
 *   'app'       — build, serve, dev
 *   'none'      — create, make:*
 */
export const BUILTIN_COMMANDS: readonly BuiltinCommandDescriptor[] = [
  // ---------------------------------------------------------------------------
  // Migration commands (config: 'migration')
  // ---------------------------------------------------------------------------
  {
    name: 'makemigrations',
    summary: 'Generate a migration from the current model schema (offline)',
    config: 'migration',
    load: async () => {
      const { runMakemigrations } = await import('./migration-commands.js');
      return async (configPath, values) => {
        const migrationsDir = (values.migrations as string | undefined) ?? 'migrations';
        return runMakemigrations(
          configPath,
          migrationsDir,
          values.name as string,
          Boolean(values['allow-destructive']),
        );
      };
    },
  },
  {
    name: 'migrate',
    summary: 'Apply pending migrations (or roll back with --down/--steps)',
    config: 'migration',
    load: async () => {
      const { runMigrate } = await import('./migration-commands.js');
      return async (configPath, values) => {
        const migrationsDir = (values.migrations as string | undefined) ?? 'migrations';
        const migrateMode = values.__migrateMode as
          { kind: string; targetName?: string; steps?: number } | undefined;
        const cliOptions: { fake?: boolean; fakeInitial?: boolean } | undefined =
          values.fake || values['fake-initial']
            ? { fake: Boolean(values.fake), fakeInitial: Boolean(values['fake-initial']) }
            : undefined;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        return runMigrate(configPath, migrationsDir, migrateMode as any, cliOptions as any);
      };
    },
  },
  {
    name: 'showmigrations',
    summary: 'List migrations and their applied state',
    config: 'migration',
    load: async () => {
      const { runShowmigrations } = await import('./migration-commands.js');
      return async (configPath, values) => {
        const migrationsDir = (values.migrations as string | undefined) ?? 'migrations';
        const format = values.format as string | undefined;
        if (format !== undefined && format !== 'table' && format !== 'json' && format !== 'plan') {
          // usage-error path: return non-zero to signal a usage error.
          // The original dispatch throws a usage error for invalid format;
          // we replicate that validation here.
          return 2;
        }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        return runShowmigrations(configPath, migrationsDir, format as any);
      };
    },
  },

  // ---------------------------------------------------------------------------
  // Runtime commands (config: 'runtime')
  // ---------------------------------------------------------------------------
  {
    name: 'work',
    summary: 'Run the job worker (registering schedules, then processing jobs)',
    config: 'runtime',
    load: async () => {
      const { runRuntimeCommand } = await import('./runtime-commands.js');
      return async (configPath) => runRuntimeCommand('work', configPath);
    },
  },
  {
    name: 'schedule',
    summary: 'Register schedules once, then exit',
    config: 'runtime',
    load: async () => {
      const { runRuntimeCommand } = await import('./runtime-commands.js');
      return async (configPath) => runRuntimeCommand('schedule', configPath);
    },
  },
  {
    name: 'queue',
    summary: 'Print queue metrics (--json for machine-readable output)',
    config: 'runtime',
    load: async () => {
      const { runQueueCommand } = await import('./queue-commands.js');
      return async (configPath, values) =>
        runQueueCommand(configPath, { json: Boolean(values.json) });
    },
  },
  {
    name: 'schedules',
    summary: 'List registered schedules (--json for machine-readable output)',
    config: 'runtime',
    load: async () => {
      const { runSchedulesCommand } = await import('./schedule-commands.js');
      return async (configPath, values) =>
        runSchedulesCommand(configPath, { json: Boolean(values.json) });
    },
  },

  // ---------------------------------------------------------------------------
  // Seed command (config: 'seed')
  // ---------------------------------------------------------------------------
  {
    name: 'seed',
    summary: 'Run registered database seeders (filter with --only <name>)',
    config: 'seed',
    load: async () => {
      const { runSeedCommand } = await import('./seeder-commands.js');
      return async (configPath, values) =>
        runSeedCommand(configPath, {
          names: values.only as readonly string[] | undefined,
        });
    },
  },

  // ---------------------------------------------------------------------------
  // App commands (config: 'app')
  // ---------------------------------------------------------------------------
  {
    name: 'build',
    summary: 'Render the static site into the configured output directory',
    config: 'app',
    load: async () => {
      const { runAppCommand } = await import('./app-commands.js');
      return async (configPath) => runAppCommand('build', configPath);
    },
  },
  {
    name: 'serve',
    summary: 'Run the HTTP server until SIGINT/SIGTERM',
    config: 'app',
    load: async () => {
      const { runAppCommand } = await import('./app-commands.js');
      return async (configPath) => runAppCommand('serve', configPath);
    },
  },
  {
    name: 'dev',
    summary: 'Compile, watch, and serve the app for development',
    config: 'app',
    load: async () => {
      const { runDevCommand } = await import('./app-commands.js');
      return async (configPath) => runDevCommand(configPath);
    },
  },

  // ---------------------------------------------------------------------------
  // Project command (config: 'none')
  // ---------------------------------------------------------------------------
  {
    name: 'create',
    summary: 'Scaffold a fresh JSails starter application',
    config: 'none',
    load: async () => {
      const { runCreateCommand } = await import('./create.js');
      return async (_configPath, values, rest) =>
        runCreateCommand(rest[0] as string, {
          name: values.name as string | undefined,
          jsailsDependency: values['jsails-dependency'] as string | undefined,
          install: Boolean(values.install),
          admin: Boolean(values.admin),
          blog: Boolean(values.blog),
          cli: Boolean(values.cli),
          static: Boolean(values.static),
        });
    },
  },
];

/**
 * Build a simple name-to-descriptor lookup map from the static catalog. The
 * map is read-only and never calls any `load()` thunk — resolution is the
 * caller's responsibility.
 */
export function createBuiltinCommandIndex(): ReadonlyMap<string, BuiltinCommandDescriptor> {
  const map = new Map<string, BuiltinCommandDescriptor>();
  for (const entry of BUILTIN_COMMANDS) {
    map.set(entry.name, entry);
  }
  return map;
}
