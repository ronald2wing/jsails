#!/usr/bin/env node

/**
 * JSails command-line interface entry point.
 *
 * Parses arguments and dispatches to the command implementations. Heavy
 * modules (TypeORM, BullMQ, Hono, Preact, Vite, Jamal) are loaded only
 * after early routing (`--help`, `inspect`, `describe`, `explain`, `app:shape`,
 * `jamal`, `plugins`, `make`) has already returned, so the common `jsails --help`
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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { AppConfigError, DEFAULT_APP_CONFIG_PATH } from '../app/config/schema.js';

import {
  CliCommandError,
  collectConfigCommands,
  createCliCommandRegistry,
  type CliCommand,
  type CliCommandContext,
  type CliCommandMetadata,
  type CliCommandRegistry,
  type CommandAudience,
} from './command-registry.js';

import { CommandDiscoveryError, discoverAppCommands } from './discovery.js';
import { SignatureError } from './signature-commands.js';

import { formatError, usageError as reportUsageError } from '../internal/errors.js';

// Re-export type symbols for callers that only need types (e.g. dev-runtime.ts).
export type { ShutdownSignal } from './shutdown.js';

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

// ---------------------------------------------------------------------------
// Command family sets (pure data; no heavy imports).
// ---------------------------------------------------------------------------

const MIGRATION_COMMANDS = new Set(['db:push', 'db:diff']);
const RUNTIME_COMMANDS = new Set(['work', 'schedule']);
const APP_COMMANDS = new Set(['build', 'serve']);
const PROJECT_COMMANDS = new Set(['create', 'dev']);
const SEED_COMMANDS = new Set(['seed']);
const QUEUE_COMMANDS = new Set(['queue']);
const SCHEDULES_COMMANDS = new Set(['schedules']);
const JAMAL_COMMANDS = new Set(['jamal']);
const PLUGINS_COMMANDS = new Set(['plugins']);
const INSPECT_COMMANDS = new Set(['inspect']);
const TEST_COMMANDS = new Set(['test']);
const DESCRIBE_COMMANDS = new Set(['describe']);
const EXPLAIN_COMMANDS = new Set(['explain']);
const APP_SHAPE_COMMANDS = new Set(['app:shape']);
const MCP_COMMANDS = new Set(['mcp']);
const AGENTS_SETUP_COMMANDS = new Set(['agents:setup']);
const CONSOLE_COMMANDS = new Set(['console']);
const I18N_COMMANDS = new Set(['i18n:missing']);

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
    TEST_COMMANDS.has(name) ||
    DESCRIBE_COMMANDS.has(name) ||
    EXPLAIN_COMMANDS.has(name) ||
    APP_SHAPE_COMMANDS.has(name) ||
    MCP_COMMANDS.has(name) ||
    AGENTS_SETUP_COMMANDS.has(name) ||
    CONSOLE_COMMANDS.has(name) ||
    I18N_COMMANDS.has(name)
  );
}

// ---------------------------------------------------------------------------
// Global help text
// ---------------------------------------------------------------------------

const HELP_PREFIX = `jsails - TypeORM-based data layer CLI

Usage:
  jsails <command> [options]

Developer commands:
  db:push            Diff the declared model schema against the live DB and apply the plan
  db:diff            Diff the declared model schema against the live DB (read-only)
  work               Run the job worker (registering schedules, then processing jobs)
  schedule           Register schedules once, then exit
  build              Render the static site into the configured output directory
  build:meta         Generate .jsails/ artifacts (models, components, autoload) before tsc
  serve              Run the HTTP server until SIGINT/SIGTERM
  seed               Run registered database seeders (filter with --only <name>)
  queue              Print queue metrics (--json for machine-readable output)
  schedules          List registered schedules (--json for machine-readable output)
  create <dir>       Scaffold a fresh JSails starter application
  dev                Compile, watch, and serve the app for development
make:<page|api|job|model|command|server-component|serializer|middleware|content|post|doc>
                       Generate a single conventional file (e.g. make:model blog-post)
  convert:component  Convert a component between single-file and multi-file shapes
  jamal <dev|deploy> Plan Docker/Kamal deployment files (write with --write)
  test               Boot the test DB, reconcile the schema, and run node --test
plugins            Discover, check, and manage installed JSails plugins
                       (list | check | install | enable | disable | uninstall | rollback)
  inspect            Introspect the application (routes ...)
  describe           Compose a machine-readable snapshot of the app's definition
  explain <path>     Resolve which route handles a path and show its pipeline stages
  app:shape <shape>  Report live-only plugins for a given deployment shape (static|full|cli)
  mcp               Start the MCP introspection server (Model Context Protocol over stdio)
  agents:setup      Emit agent files (.mcp.json, AGENTS.md) so an AI agent can drive this app
  i18n:missing       Report translation keys used in code but absent from catalogs
  console           Start an interactive REPL with the application loaded
`;

const HELP_SUFFIX = `Options:
  -c, --config <path>    Path to the JS ESM config module
                          (default: ${DEFAULT_CONFIG_PATH} for migration commands,
                           ${DEFAULT_RUNTIME_CONFIG_PATH} for work/schedule/queue,
                           ${DEFAULT_SEED_CONFIG_PATH} for seed,
                           ${DEFAULT_APP_CONFIG_PATH} for build/serve/dev)
      --name <name>      npm package name (create, optional; derived from the
                           directory when omitted)
      --jsails-dependency <spec>
                           jsails dependency specifier for a created project
                           (create only; a file: path or an npm semver range like ^1.0.0)
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
                           Permit destructive schema changes (db:push only)
      --dry-run            Print the reconciliation plan without applying it
                           (db:push only)
      --only <name>      Run only the named seeder(s) (seed only, repeatable)
      --json             Print queue metrics or schedules as JSON (queue/schedules only)
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
  name: { type: 'string' },
  'jsails-dependency': { type: 'string' },
  install: { type: 'boolean', default: false },
  admin: { type: 'boolean', default: false },
  blog: { type: 'boolean', default: false },
  cli: { type: 'boolean', default: false },
  static: { type: 'boolean', default: false },
  'allow-destructive': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  only: { type: 'string', multiple: true },
  json: { type: 'boolean', default: false },
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
  // Install framework globals before any app module is imported: a discovered
  // command or the app config may reference `defineCommand`, `ApplicationRecord`,
  // etc. by bare name, resolved against `globalThis` at evaluation time.
  await installGlobals(options.configPath);

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
      const { loadAppConfig } = await import('../app/config/index.js');
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

/**
 * Install the framework globals, then the project's generated globals.
 *
 * A bare identifier in app code (`ApplicationRecord`, a user's `Author`)
 * resolves against `globalThis` at module-evaluation time, so both sets must be
 * installed before any app module is imported. The project tree lives beside
 * the config module (`.jsails/project-symbols.js`); `configPath`'s directory is
 * the project root, falling back to the current working directory.
 */
async function installGlobals(configPath: string): Promise<void> {
  const { installFrameworkSymbols, installProjectSymbols } =
    await import('../symbols/install-server.js');
  const rootDir = dirname(resolve(configPath));
  await installFrameworkSymbols(rootDir);
  await installProjectSymbols(rootDir);
}

async function routeJamal(args: readonly string[]): Promise<number> {
  // Jamal loads the app config (deploy generators, app name), which may
  // reference framework globals by bare name.
  await installGlobals(process.cwd());
  const { runJamalCommand } = await import('../jamal/command.js');
  return runJamalCommand(args);
}

async function routeTest(args: readonly string[]): Promise<number> {
  // The test runner loads the app config and reconciles the test database; both
  // may reference framework globals by bare name.
  await installGlobals(process.cwd());
  const { runTestCommand } = await import('./test-commands.js');
  const readFlag = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx === -1) return undefined;
    return args[idx + 1];
  };
  const values = {
    config: readFlag('--config'),
    noServices: args.includes('--no-services'),
    watch: args.includes('--watch'),
    testFile: readFlag('--test-file'),
  };
  return runTestCommand(values);
}

async function routePlugins(args: readonly string[]): Promise<number> {
  const { runPluginsCommand } = await import('./plugins-commands.js');
  return runPluginsCommand(args);
}

async function routeInspect(args: readonly string[]): Promise<number> {
  const { runInspectCommand } = await import('./inspect-commands.js');
  return runInspectCommand(args);
}

async function routeDescribe(args: readonly string[]): Promise<number> {
  const { runDescribeCommand } = await import('./describe-commands.js');
  return runDescribeCommand(args);
}

async function routeExplain(args: readonly string[]): Promise<number> {
  const { runExplainCommand } = await import('./explain-commands.js');
  return runExplainCommand(args);
}

async function routeAppShape(args: readonly string[]): Promise<number> {
  const { runAppShapeCommand } = await import('./app-shape-commands.js');
  return runAppShapeCommand(args);
}

async function routeMcp(args: readonly string[]): Promise<number> {
  const { runMcpCommand } = await import('./mcp-commands.js');
  return runMcpCommand(args);
}

async function routeAgentsSetup(args: readonly string[]): Promise<number> {
  const { runAgentsSetupCli } = await import('./agents-setup-commands.js');
  return runAgentsSetupCli(args);
}

async function routeI18nMissing(args: readonly string[]): Promise<number> {
  const { runI18nMissingCommand } = await import('./i18n-missing-commands.js');
  return runI18nMissingCommand(args);
}

async function routeMake(args: readonly string[]): Promise<number> {
  const { runMakeCommand, isMakeCommandType } = await import('./make-commands.js');
  const type = args[0]?.slice('make:'.length);
  if (type === undefined || !isMakeCommandType(type)) {
    return usageError(`unknown command ${JSON.stringify(args[0])}`);
  }
  return runMakeCommand(type, args.slice(1));
}

async function routeConvert(args: readonly string[]): Promise<number> {
  const { runConvertCommand } = await import('./convert-commands.js');
  return runConvertCommand(args);
}

async function routeMeta(args: readonly string[]): Promise<number> {
  const { runMetaCommand } = await import('./meta-commands.js');
  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx === -1 ? undefined : args[dirIdx + 1];
  return runMetaCommand({ dir });
}

// ---------------------------------------------------------------------------
// runCli — main entry point
// ---------------------------------------------------------------------------

export async function runCli(argv: string[]): Promise<number> {
  // Assemble `process.env` from the developer's `.env` files before any command
  // logic runs, so the validators and app code read a consistent environment.
  // The test command auto-sets `NODE_ENV=test` (matching Jest/Phoenix), which
  // selects `.env.testing` instead of `.env.local`.
  const { assembleEnvironment } = await import('../dotenv.js');
  if (argv[0] === 'test' && process.env.NODE_ENV === undefined) {
    process.env.NODE_ENV = 'test';
  }
  assembleEnvironment();

  // Early-routed commands: handled BEFORE any heavy module is loaded.
  // Each route lazily imports its own implementation module.
  if (argv[0] === 'jamal') {
    return routeJamal(argv.slice(1));
  }
  if (argv[0] === 'test') {
    return routeTest(argv.slice(1));
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
  if (argv[0] === 'app:shape') {
    return routeAppShape(argv.slice(1));
  }
  if (argv[0] === 'mcp') {
    return routeMcp(argv.slice(1));
  }
  if (argv[0] === 'agents:setup') {
    return routeAgentsSetup(argv.slice(1));
  }
  if (argv[0] === 'i18n:missing') {
    return routeI18nMissing(argv.slice(1));
  }
  if (argv[0] === 'console') {
    const { runConsole } = await import('./console-commands.js');
    return runConsole(argv.slice(1));
  }
  if (argv[0] === 'make') {
    const { GLOBAL_MAKE_HELP } = await import('./make-commands.js');
    process.stdout.write(GLOBAL_MAKE_HELP);
    return 0;
  }
  if (argv[0] !== undefined && argv[0].startsWith('make:')) {
    return routeMake(argv);
  }
  if (argv[0] !== undefined && argv[0].startsWith('convert:')) {
    return routeConvert(argv.slice(1));
  }
  if (argv[0] === 'build:meta') {
    return routeMeta(argv.slice(1));
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
      'a command is required (db:push | db:diff | work | schedule | build | serve | seed | queue | schedules | create | dev | inspect | describe | explain | app:shape | mcp | agents:setup | i18n:missing | make:<page|api|job|model|command|server-component|serializer|middleware> | convert:component | jamal | plugins)',
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
  if (command !== 'db:push' && values['allow-destructive']) {
    return usageError('--allow-destructive is only valid for db:push');
  }
  if (command !== 'db:push' && values['dry-run']) {
    return usageError('--dry-run is only valid for db:push');
  }
  if (!isCreate && values.name !== undefined) {
    return usageError('--name is only valid for create');
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
  if (isCreate && values.config !== undefined) {
    return usageError('create does not take --config');
  }
  if (isCreate && values.cli && (values.admin || values.blog || values.static)) {
    return usageError('--cli cannot be combined with --admin, --blog, or --static');
  }
  if (isCreate && values.static && (values.admin || values.blog)) {
    return usageError('--static cannot be combined with --admin or --blog');
  }

  // All validation passed. Now load the heavy dispatch module.
  // This dynamic import is the boundary: everything above this point runs
  // without TypeORM, BullMQ, Hono, Preact, Vite, or Jamal.
  //
  // Install the framework globals first: the app config and every discovered
  // module may reference `ApplicationRecord`, `defineJob`, etc. by bare name,
  // and those names resolve against `globalThis` at module-evaluation time.
  await installGlobals(configPath);
  const { runDispatch } = await import('./dispatch.js');
  return runDispatch(command, configPath, values, rest);
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
