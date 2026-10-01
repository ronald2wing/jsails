#!/usr/bin/env node

/**
 * JSails command-line interface entry point.
 *
 * Parses arguments and dispatches to the command implementations. Heavy
 * modules (TypeORM, BullMQ, Hono, Preact, Vite, Jamal) are loaded only
 * after early routing (`--help`, `inspect`, `describe`, `explain`, `jamal`,
 * `plugins`, `make`) has already returned, so the common `jsails --help`
 * and introspection paths never pull heavyweight dependencies into the
 * import graph.
 *
 * This module is also the package entry (see `package.json` `bin`), so it
 * keeps the executable main guard and re-exports the command runners other
 * files import (`runCli`, `runAppCommand`, `runRuntimeCommand`,
 * `runCreateCommand`, `runDevCommand`, `npmInstallSpawn`, and their
 * dependency-seam types).
 */

import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { AppConfigError, DEFAULT_APP_CONFIG_PATH } from './app/config/schema.js';

import {
  CliCommandError,
  collectConfigCommands,
  createCliCommandRegistry,
  type CliCommand,
  type CliCommandContext,
  type CliCommandMetadata,
  type CliCommandRegistry,
  type CommandAudience,
} from './cli/command-registry.js';

import { CommandDiscoveryError, discoverAppCommands } from './cli/discovery.js';
import { SignatureError } from './cli/signature-commands.js';

import { formatError, usageError as reportUsageError } from './internal/errors.js';

// Re-export type symbols for callers that only need types (e.g. dev-runtime.ts).
export type { ShutdownSignal } from './cli/shutdown.js';

// Lightweight value re-exports for importers that don't need the heavy dispatch.
// `runCli` is declared with `export` below; all other value re-exports are
// available from src/cli/dispatch.ts.

// ---------------------------------------------------------------------------
// Default config paths (hardcoded to avoid importing their heavy source
// modules: config-loader.ts → TypeORM, runtime-config.ts → BullMQ,
// seeder-commands.ts → TypeORM).
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG_PATH = 'jsails.config.js';
const DEFAULT_RUNTIME_CONFIG_PATH = 'jsails.runtime.js';
const DEFAULT_SEED_CONFIG_PATH = 'jsails.seed.js';
const DEFAULT_MIGRATIONS_DIR = 'migrations';

// ---------------------------------------------------------------------------
// Command family sets (pure data; no heavy imports).
// ---------------------------------------------------------------------------

const MIGRATION_COMMANDS = new Set(['makemigrations', 'migrate', 'showmigrations']);
const RUNTIME_COMMANDS = new Set(['work', 'schedule']);
const APP_COMMANDS = new Set(['build', 'serve']);
const PROJECT_COMMANDS = new Set(['create', 'dev']);
const SEED_COMMANDS = new Set(['seed']);
const QUEUE_COMMANDS = new Set(['queue']);
const SCHEDULES_COMMANDS = new Set(['schedules']);
const JAMAL_COMMANDS = new Set(['jamal']);
const PLUGINS_COMMANDS = new Set(['plugins']);
const INSPECT_COMMANDS = new Set(['inspect']);
const DESCRIBE_COMMANDS = new Set(['describe']);
const EXPLAIN_COMMANDS = new Set(['explain']);

/**
 * Whether `name` is a built-in command whose implementation lives behind a
 * lazy import boundary. This is a pure string-set check — it pulls no modules.
 */
function isBuiltinCommand(name: string): boolean {
  return (
    MIGRATION_COMMANDS.has(name) ||
    RUNTIME_COMMANDS.has(name) ||
    APP_COMMANDS.has(name) ||
    PROJECT_COMMANDS.has(name) ||
    SEED_COMMANDS.has(name) ||
    QUEUE_COMMANDS.has(name) ||
    SCHEDULES_COMMANDS.has(name) ||
    JAMAL_COMMANDS.has(name) ||
    PLUGINS_COMMANDS.has(name) ||
    INSPECT_COMMANDS.has(name) ||
    DESCRIBE_COMMANDS.has(name) ||
    EXPLAIN_COMMANDS.has(name)
  );
}

// ---------------------------------------------------------------------------
// Global help text
// ---------------------------------------------------------------------------

const HELP_PREFIX = `jsails - TypeORM-based data layer CLI

Usage:
  jsails <command> [options]

Developer commands:
  makemigrations     Generate a migration from the current model schema (offline)
  migrate            Apply pending migrations (or roll back with --down/--steps)
  showmigrations     List migrations and their applied state
  work               Run the job worker (registering schedules, then processing jobs)
  schedule           Register schedules once, then exit
  build              Render the static site into the configured output directory
  serve              Run the HTTP server until SIGINT/SIGTERM
  seed               Run registered database seeders (filter with --only <name>)
  queue              Print queue metrics (--json for machine-readable output)
  schedules          List registered schedules (--json for machine-readable output)
  create <dir>       Scaffold a fresh JSails starter application
  dev                Compile, watch, and serve the app for development
  make:<page|api|job|model|command|server-component|serializer|middleware>
                     Generate a single conventional file (e.g. make:model blog-post)
  jamal <dev|deploy> Plan Docker/Kamal deployment files (write with --write)
plugins            Discover, check, and manage installed JSails plugins
                      (list | check | install | enable | disable | uninstall | rollback)
  inspect            Introspect the application (routes ...)
  describe           Compose a machine-readable snapshot of the app's definition
  explain <path>     Resolve which route handles a path and show its pipeline stages
`;

const HELP_SUFFIX = `Options:
  -c, --config <path>    Path to the JS ESM config module
                          (default: ${DEFAULT_CONFIG_PATH} for migration commands,
                           ${DEFAULT_RUNTIME_CONFIG_PATH} for work/schedule/queue,
                           ${DEFAULT_SEED_CONFIG_PATH} for seed,
                           ${DEFAULT_APP_CONFIG_PATH} for build/serve/dev)
      --migrations <dir> Migrations directory (default: ${DEFAULT_MIGRATIONS_DIR})
      --name <name>      Migration name (makemigrations, required) or npm package
                          name (create, optional; derived from the directory when
                          omitted)
      --jsails-dependency <spec>
                          jsails dependency specifier for a created project
                          (create only, e.g. file:../jsails)
      --install          Run npm install in the created project (create only)
      --admin            Include the admin panel (create only)
      --blog             Include the admin panel plus the first-party blog
                          plugin and pages (create only; implies --admin)
      --cli              Scaffold a CLI-only starter with no web surface
                          (create only; mutually exclusive with --admin/--blog/--static)
      --static           Scaffold a static-site (SSG) starter with no auth, API,
                          server components, or Jamal (create only; mutually
                          exclusive with --admin/--blog/--cli)
      --allow-destructive
                          Permit destructive schema changes (makemigrations, and
                          required for migrate rollback)
      --down <name>      Roll back every migration applied after <name>
                          (migrate only; requires --allow-destructive)
      --steps <n>        Roll back the last <n> applied migrations
                          (migrate only; requires --allow-destructive)
      --only <name>      Run only the named seeder(s) (seed only, repeatable)
      --json             Print queue metrics or schedules as JSON (queue/schedules only)
      --format <fmt>     Showmigrations output format: table (default), json, or plan
                          (showmigrations only)
      --fake             Record migrations as applied without executing operations
                          (migrate only)
      --fake-initial     Record the first migration as applied when the tracking table
                          is empty (migrate only; mutually exclusive with --fake)
  -h, --help             Show this help

Migration config modules must default-export a JsailsDataSource instance.
Work/schedule/queue config modules must default-export a runtime object with a
\`registry\` of jobs (see src/jobs/runtime-config.ts).
Seed config modules must default-export \`{ registry, dataSource }\` (see
src/cli/seeder-commands.ts).
Build/serve/dev config modules must default-export an app config object (see
src/app/config.ts); host, port, and output directory are set in the config,
not via extra flags.
TypeScript configs must be compiled to JavaScript before use.
`;

const USER_COMMANDS_HINT = 'No user commands discovered in commands/ or dist/commands.';

async function buildGlobalHelp(): Promise<string> {
  let discovered: readonly CliCommand[] = [];
  try {
    discovered = await discoverCommandsFromCwd();
  } catch {
    // Best-effort: fall through to the hint below.
  }
  const userCommands = discovered
    .filter((command) => command.audience === 'user')
    .map((command) => `  ${command.name} - ${command.summary}`);
  const userSection =
    userCommands.length === 0
      ? `User commands:\n  ${USER_COMMANDS_HINT}\n`
      : `User commands:\n${userCommands.join('\n')}\n`;
  return `${HELP_PREFIX}\n${userSection}\n${HELP_SUFFIX}`;
}

const OPTIONS = {
  config: { type: 'string', short: 'c' },
  migrations: { type: 'string' },
  name: { type: 'string' },
  'jsails-dependency': { type: 'string' },
  install: { type: 'boolean', default: false },
  admin: { type: 'boolean', default: false },
  blog: { type: 'boolean', default: false },
  cli: { type: 'boolean', default: false },
  static: { type: 'boolean', default: false },
  'allow-destructive': { type: 'boolean', default: false },
  down: { type: 'string' },
  steps: { type: 'string' },
  only: { type: 'string', multiple: true },
  json: { type: 'boolean', default: false },
  format: { type: 'string' },
  fake: { type: 'boolean', default: false },
  'fake-initial': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

function usageError(message: string): number {
  return reportUsageError((line) => console.error(line), 'Run "jsails --help" for usage.', message);
}

// ---------------------------------------------------------------------------
// custom commands: jsails <name> [--config <path>] [raw arguments]
// ---------------------------------------------------------------------------

interface CustomInvocation {
  readonly configPath: string | undefined;
  readonly rawArgs: readonly string[];
}

function parseCustomInvocation(rest: readonly string[]): CustomInvocation | number {
  let configPath: string | undefined;
  const rawArgs: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (token === '--') {
      rawArgs.push(...rest.slice(index));
      break;
    }
    if (token === '--config') {
      const value = rest[index + 1];
      if (value === undefined) {
        return usageError('--config requires a value');
      }
      if (configPath !== undefined) {
        return usageError('--config specified more than once');
      }
      configPath = value;
      index += 1;
      continue;
    }
    if (token.startsWith('--config=')) {
      if (configPath !== undefined) {
        return usageError('--config specified more than once');
      }
      configPath = token.slice('--config='.length);
      continue;
    }
    rawArgs.push(token);
  }
  return { configPath, rawArgs };
}

function isCliEchoableError(error: unknown): boolean {
  return (
    error instanceof CliCommandError ||
    error instanceof AppConfigError ||
    error instanceof SignatureError ||
    error instanceof CommandDiscoveryError
  );
}

function audienceLabel(audience: CommandAudience | undefined): string {
  return audience === 'user' ? 'user command' : 'developer command';
}

function customCommandHelp(command: string, metadata: readonly CliCommandMetadata[]): string {
  const entry = metadata.find((candidate) => candidate.name === command);
  const summary = entry?.summary ?? '';
  const usage = entry?.usage ?? entry?.name ?? command;
  const audience = audienceLabel(entry?.audience);
  return `${command} - ${summary}\nAudience: ${audience}\n\nUsage:\n  jsails ${usage}\n`;
}

async function discoverCommandsFromCwd(): Promise<CliCommand[]> {
  const cwd = process.cwd();
  const commands: CliCommand[] = [];
  for (const base of [cwd, join(cwd, 'dist')]) {
    commands.push(...(await discoverAppCommands(base)));
  }
  return commands;
}

async function runCustomCommand(
  command: string,
  options: {
    readonly configPath: string;
    readonly hasConfig: boolean;
    readonly hasExplicitConfig: boolean;
    readonly rawArgs: readonly string[];
  },
): Promise<number> {
  let discovered: readonly CliCommand[] = [];
  try {
    discovered = await discoverCommandsFromCwd();
  } catch (error) {
    console.error(
      `jsails: ${formatError(error, { allow: isCliEchoableError, fallback: 'the command failed' })}`,
    );
    return 1;
  }

  const isDiscoveredUser =
    !options.hasExplicitConfig &&
    discovered.some((candidate) => candidate.name === command && candidate.audience === 'user');

  let config: unknown;
  let configCommands: readonly CliCommand[] = [];
  if (!isDiscoveredUser && options.hasConfig) {
    try {
      const { loadAppConfig } = await import('./app/config/index.js');
      config = await loadAppConfig(options.configPath);
      configCommands = collectConfigCommands(config);
    } catch (error) {
      console.error(
        `jsails: ${formatError(error, { allow: isCliEchoableError, fallback: 'the command failed' })}`,
      );
      return 1;
    }
  }

  let registry: CliCommandRegistry;
  try {
    registry = createCliCommandRegistry(
      isDiscoveredUser ? discovered : [...configCommands, ...discovered],
    );
  } catch (error) {
    console.error(
      `jsails: ${formatError(error, { allow: isCliEchoableError, fallback: 'the command failed' })}`,
    );
    return 1;
  }

  if (!registry.has(command)) {
    return usageError(`unknown command ${JSON.stringify(command)}`);
  }
  if (
    options.rawArgs.length === 1 &&
    (options.rawArgs[0] === '--help' || options.rawArgs[0] === '-h')
  ) {
    process.stdout.write(customCommandHelp(command, registry.list()));
    return 0;
  }

  const context: CliCommandContext = {
    configPath: config
      ? (((config as Record<string, unknown>).configPath as string) ?? resolve(options.configPath))
      : resolve(options.configPath),
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  };
  try {
    return await registry.run(command, options.rawArgs, context);
  } catch (error) {
    console.error(
      `jsails: ${formatError(error, { allow: isCliEchoableError, fallback: 'the command failed' })}`,
    );
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Early-routing helpers (lazy imports — only loaded when the command matches)
// ---------------------------------------------------------------------------

async function routeJamal(args: readonly string[]): Promise<number> {
  const { runJamalCommand } = await import('./jamal/command.js');
  return runJamalCommand(args);
}

async function routePlugins(args: readonly string[]): Promise<number> {
  const { runPluginsCommand } = await import('./cli/plugins-command.js');
  return runPluginsCommand(args);
}

async function routeInspect(args: readonly string[]): Promise<number> {
  const { runInspectCommand } = await import('./cli/inspect-commands.js');
  return runInspectCommand(args);
}

async function routeDescribe(args: readonly string[]): Promise<number> {
  const { runDescribeCommand } = await import('./cli/describe-command.js');
  return runDescribeCommand(args);
}

async function routeExplain(args: readonly string[]): Promise<number> {
  const { runExplainCommand } = await import('./cli/explain-command.js');
  return runExplainCommand(args);
}

async function routeMake(args: readonly string[]): Promise<number> {
  const { runMakeCommand, isMakeCommandType } = await import('./cli/make-commands.js');
  const type = args[0]?.slice('make:'.length);
  if (type === undefined || !isMakeCommandType(type)) {
    return usageError(`unknown command ${JSON.stringify(args[0])}`);
  }
  return runMakeCommand(type, args.slice(1));
}

// ---------------------------------------------------------------------------
// runCli — main entry point
// ---------------------------------------------------------------------------

export async function runCli(argv: string[]): Promise<number> {
  // Early-routed commands: handled BEFORE any heavy module is loaded.
  // Each route lazily imports its own implementation module.
  if (argv[0] === 'jamal') {
    return routeJamal(argv.slice(1));
  }
  if (argv[0] === 'plugins') {
    return routePlugins(argv.slice(1));
  }
  if (argv[0] === 'inspect') {
    return routeInspect(argv.slice(1));
  }
  if (argv[0] === 'describe') {
    return routeDescribe(argv.slice(1));
  }
  if (argv[0] === 'explain') {
    return routeExplain(argv.slice(1));
  }
  if (argv[0] === 'make') {
    const { GLOBAL_MAKE_HELP } = await import('./cli/make-commands.js');
    process.stdout.write(GLOBAL_MAKE_HELP);
    return 0;
  }
  if (argv[0] !== undefined && argv[0].startsWith('make:')) {
    return routeMake(argv);
  }

  // Custom-command path: a leading non-flag, non-builtin token.
  const first = argv[0];
  if (first !== undefined && !first.startsWith('-') && !isBuiltinCommand(first)) {
    const invocation = parseCustomInvocation(argv.slice(1));
    if (typeof invocation === 'number') {
      return invocation;
    }
    const configPath = invocation.configPath ?? DEFAULT_APP_CONFIG_PATH;
    const hasExplicitConfig = invocation.configPath !== undefined;
    const hasConfig = hasExplicitConfig || existsSync(resolve(configPath));
    return runCustomCommand(first, {
      configPath,
      hasConfig,
      hasExplicitConfig,
      rawArgs: invocation.rawArgs,
    });
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usageError(formatError(error));
  }

  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(await buildGlobalHelp());
    return 0;
  }

  const [command, ...rest] = positionals;
  if (command === undefined) {
    return usageError(
      'a command is required (makemigrations | migrate | showmigrations | work | schedule | build | serve | seed | queue | schedules | create | dev | inspect | describe | explain | make:<page|api|job|model|command|server-component|serializer|middleware> | jamal | plugins)',
    );
  }

  if (command === 'create') {
    if (rest.length !== 1) {
      return usageError('create requires a target directory: jsails create <dir>');
    }
  } else if (rest.length > 0) {
    return usageError(`unexpected argument: ${rest.join(' ')}`);
  }

  if (
    !MIGRATION_COMMANDS.has(command) &&
    !RUNTIME_COMMANDS.has(command) &&
    !APP_COMMANDS.has(command) &&
    !PROJECT_COMMANDS.has(command) &&
    !SEED_COMMANDS.has(command) &&
    !QUEUE_COMMANDS.has(command) &&
    !SCHEDULES_COMMANDS.has(command)
  ) {
    return usageError(`unknown command ${JSON.stringify(command)}`);
  }

  const isMigration = MIGRATION_COMMANDS.has(command);
  const isRuntime = RUNTIME_COMMANDS.has(command);
  const isApp = APP_COMMANDS.has(command);
  const isCreate = command === 'create';
  const isDev = command === 'dev';
  const isSeed = command === 'seed';
  const isQueue = command === 'queue';
  const isSchedules = command === 'schedules';
  const configPath =
    values.config ??
    (isRuntime || isQueue || isSchedules
      ? DEFAULT_RUNTIME_CONFIG_PATH
      : isApp || isDev
        ? DEFAULT_APP_CONFIG_PATH
        : isSeed
          ? DEFAULT_SEED_CONFIG_PATH
          : DEFAULT_CONFIG_PATH);

  // Flag wall: cross-flag validation (runs before any heavy module loads).
  if (!isMigration && values.migrations !== undefined) {
    return usageError('--migrations is only valid for migration commands');
  }
  if (command !== 'makemigrations' && command !== 'migrate' && values['allow-destructive']) {
    return usageError('--allow-destructive is only valid for makemigrations and migrate');
  }
  if (command !== 'migrate' && (values.down !== undefined || values.steps !== undefined)) {
    return usageError('--down and --steps are only valid for migrate');
  }
  if (!isCreate && command !== 'makemigrations' && values.name !== undefined) {
    return usageError('--name is only valid for makemigrations and create');
  }
  if (!isCreate && values['jsails-dependency'] !== undefined) {
    return usageError('--jsails-dependency is only valid for create');
  }
  if (!isCreate && values.install) {
    return usageError('--install is only valid for create');
  }
  if (!isCreate && values.admin) {
    return usageError('--admin is only valid for create');
  }
  if (!isCreate && values.blog) {
    return usageError('--blog is only valid for create');
  }
  if (!isCreate && values.cli) {
    return usageError('--cli is only valid for create');
  }
  if (!isCreate && values.static) {
    return usageError('--static is only valid for create');
  }
  if (!isSeed && values.only !== undefined) {
    return usageError('--only is only valid for seed');
  }
  if (!isQueue && !isSchedules && values.json) {
    return usageError('--json is only valid for queue and schedules');
  }
  if (command !== 'showmigrations' && values.format !== undefined) {
    return usageError('--format is only valid for showmigrations');
  }
  if (command !== 'migrate' && values.fake) {
    return usageError('--fake is only valid for migrate');
  }
  if (command !== 'migrate' && values['fake-initial']) {
    return usageError('--fake-initial is only valid for migrate');
  }
  if (values.fake && values['fake-initial']) {
    return usageError('--fake and --fake-initial are mutually exclusive');
  }
  if (
    (values.fake || values['fake-initial']) &&
    (values.down !== undefined || values.steps !== undefined)
  ) {
    return usageError(
      '--fake and --fake-initial are only valid for forward (non-rollback) migration',
    );
  }
  if (isCreate && values.config !== undefined) {
    return usageError('create does not take --config');
  }
  if (isCreate && values.cli && (values.admin || values.blog || values.static)) {
    return usageError('--cli cannot be combined with --admin, --blog, or --static');
  }
  if (isCreate && values.static && (values.admin || values.blog)) {
    return usageError('--static cannot be combined with --admin or --blog');
  }
  if (command === 'makemigrations' && (values.name === undefined || values.name === '')) {
    return usageError('makemigrations requires --name');
  }

  // Resolve migrate mode (validation only; type-only annotation is erased).
  let migrateMode: { kind: string; targetName?: string; steps?: number } | undefined;
  if (command === 'migrate') {
    const hasDown = values.down !== undefined;
    const hasSteps = values.steps !== undefined;
    if (hasDown && hasSteps) {
      return usageError('--down and --steps are mutually exclusive');
    }
    if (hasDown || hasSteps) {
      if (!values['allow-destructive']) {
        return usageError(
          'rollback is destructive (tables and columns are dropped) and requires --allow-destructive',
        );
      }
      if (hasDown) {
        migrateMode = { kind: 'down', targetName: values.down as string };
      } else {
        const steps = Number(values.steps);
        if (!Number.isInteger(steps) || steps <= 0) {
          return usageError('--steps requires a positive integer');
        }
        migrateMode = { kind: 'steps', steps };
      }
    } else if (values['allow-destructive']) {
      return usageError('--allow-destructive on migrate requires --down or --steps');
    } else {
      migrateMode = { kind: 'forward' };
    }
  }

  // All validation passed. Now load the heavy dispatch module.
  // This dynamic import is the boundary: everything above this point runs
  // without TypeORM, BullMQ, Hono, Preact, Vite, or Jamal.
  const { runDispatch } = await import('./cli/dispatch.js');
  return runDispatch(command, configPath, values, migrateMode, rest);
}

// ---------------------------------------------------------------------------
// Entry-point guard
// ---------------------------------------------------------------------------

function isMainModule(metaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return metaUrl === pathToFileURL(argv1).href;
  }
}

if (isMainModule(import.meta.url)) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`jsails: ${formatError(error)}`);
      process.exitCode = 1;
    });
}
