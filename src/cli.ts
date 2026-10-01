#!/usr/bin/env node

/**
 * JSails command-line interface.
 *
 * Migration commands: makemigrations (offline generation), migrate (forward
 * apply), showmigrations (read-only status). Their config module is a JS ESM
 * module default-exporting a {@link JsailsDataSource}; TypeScript configs must
 * be compiled to JavaScript first, so a `.ts` path is rejected rather than
 * executed. Migrations are plain JSON definitions read from a directory and
 * validated through the same history APIs the runner uses.
 *
 * Runtime commands: work (run the job worker) and schedule (one-shot schedule
 * registration). Their config module defaults to `jsails.runtime.js` and
 * default-exports a runtime object (registry, Valkey URL, schedules, ...); see
 * `jobs/runtime-config.ts`. The CLI owns SIGINT/SIGTERM only while `work` is
 * running, and never leaks clients or listeners on startup failure.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { JsailsDataSource } from './database/jsails-data-source.js';
import { generateMigration } from './migrations/autodetector.js';
import type { MigrationDefinition, MigrationHistory } from './migrations/history.js';
import { resolveMigrationOrder } from './migrations/history.js';
import { isValidIdentifier } from './migrations/schema-state.js';
import { getMigrationStatus, migrate } from './migrations/runner.js';
import type { MigrationDataSource } from './migrations/runner.js';
import {
  DEFAULT_RUNTIME_CONFIG_PATH,
  loadRuntimeConfigModule,
  validateRuntimeConfig,
  type ResolvedRuntimeConfig,
} from './jobs/runtime-config.js';
import { createJobsRuntime, type JobsRuntime } from './jobs/runtime.js';
import { createApplication, type Application } from './app/application.js';
import {
  AppConfigError,
  DEFAULT_APP_CONFIG_PATH,
  loadAppConfig,
  type ResolvedAppConfig,
} from './app/config.js';
import {
  CliCommandError,
  collectConfigCommands,
  createCliCommandRegistry,
  type CliCommand,
  type CliCommandContext,
  type CliCommandMetadata,
  type CliCommandRegistry,
  type CommandAudience,
} from './cli/commands.js';
import { CommandDiscoveryError, discoverAppCommands } from './cli/discovery.js';
import { SignatureError } from './cli/command-kit.js';
import { PageRenderError } from './pages/page.js';
import { StaticSiteError, type GenerateStaticSiteResult } from './pages/static-site.js';
import { RouteManifestError } from './routing/manifest.js';
import { writeProjectFiles } from './app/scaffold.js';
import { createStarterFiles } from './app/starter.js';
import { runDev, type DevOptions } from './dev/dev-runtime.js';
import { killOwnedProcessTree } from './cli/owned-process-tree.js';
import { runJamalCommand } from './jamal/command.js';

const DEFAULT_CONFIG_PATH = 'jsails.config.js';
const DEFAULT_MIGRATIONS_DIR = 'migrations';

const MIGRATION_COMMANDS = new Set(['makemigrations', 'migrate', 'showmigrations']);
const RUNTIME_COMMANDS = new Set(['work', 'schedule']);
const APP_COMMANDS = new Set(['build', 'serve']);
/** Commands owned by this file: the `create` scaffold and the `dev` toolchain. */
const PROJECT_COMMANDS = new Set(['create', 'dev']);
/** The `jamal` deployment command, owned by `src/jamal/command.ts`. */
const JAMAL_COMMANDS = new Set(['jamal']);

const HELP_PREFIX = `jsails - TypeORM-based data layer CLI

Usage:
  jsails <command> [options]

Developer commands:
  makemigrations     Generate a migration from the current model schema (offline)
  migrate            Apply pending migrations to the database
  showmigrations     List migrations and their applied state
  work               Run the job worker (registering schedules, then processing jobs)
  schedule           Register schedules once, then exit
  build              Render the static site into the configured output directory
  serve              Run the HTTP server until SIGINT/SIGTERM
  create <dir>       Scaffold a fresh JSails starter application
  dev                Compile, watch, and serve the app for development
  jamal <dev|deploy> Plan Docker/Kamal deployment files (write with --write)
`;

const HELP_SUFFIX = `Options:
  -c, --config <path>    Path to the JS ESM config module
                         (default: ${DEFAULT_CONFIG_PATH} for migration commands,
                          ${DEFAULT_RUNTIME_CONFIG_PATH} for work/schedule,
                          ${DEFAULT_APP_CONFIG_PATH} for build/serve/dev)
      --migrations <dir> Migrations directory (default: ${DEFAULT_MIGRATIONS_DIR})
      --name <name>      Migration name (makemigrations, required) or npm package
                         name (create, optional; derived from the directory when
                         omitted)
      --jsails-dependency <spec>
                         jsails dependency specifier for a created project
                         (create only, e.g. file:../jsails)
      --install          Run npm install in the created project (create only)
      --auth             Include the Better Auth variant (create only)
      --allow-destructive
                         Permit destructive schema changes (makemigrations only)
  -h, --help             Show this help

Migration config modules must default-export a JsailsDataSource instance.
Work/schedule config modules must default-export a runtime object with a
\`registry\` of jobs (see src/jobs/runtime-config.ts).
Build/serve/dev config modules must default-export an app config object (see
src/app/config.ts); host, port, and output directory are set in the config,
not via extra flags.
TypeScript configs must be compiled to JavaScript before use.
`;

/** Hint printed under "User commands" when none is discovered. */
const USER_COMMANDS_HINT = 'No user commands discovered in commands/ or dist/commands.';

/**
 * Render the full global help: the static developer section, a best-effort user
 * section, then the static options. Discovery is best-effort so a broken command
 * module can never break `jsails --help`; it scans only compiled `commands/`
 * trees and never imports the app config.
 */
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
  auth: { type: 'boolean', default: false },
  'allow-destructive': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}

function usageError(message: string): number {
  console.error(`jsails: ${message}`);
  console.error('Run "jsails --help" for usage.');
  return 2;
}

/** Whether the config path is a TypeScript module that has not been compiled. */
function isTypeScriptConfig(path: string): boolean {
  return /\.(?:ts|mts|cts)$/.test(path);
}

async function loadConfig(configPath: string): Promise<JsailsDataSource> {
  const absolute = resolve(configPath);
  if (isTypeScriptConfig(absolute)) {
    throw new Error(
      `config "${configPath}" is a TypeScript module; compile it to JavaScript first ` +
        `(e.g. tsc) and point --config at the compiled output`,
    );
  }
  let module: unknown;
  try {
    module = await import(pathToFileURL(absolute).href);
  } catch (error) {
    throw new Error(`failed to load config "${configPath}": ${formatError(error)}`);
  }
  const dataSource = (module as { default?: unknown }).default;
  if (!(dataSource instanceof JsailsDataSource)) {
    throw new Error(`config "${configPath}" must default-export a JsailsDataSource instance`);
  }
  return dataSource;
}

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
    if (isNodeError(error, 'ENOENT')) {
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

async function runMakemigrations(
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

  const dataSource = await loadConfig(configPath);
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
    if (isNodeError(error, 'EEXIST')) {
      throw new Error(`migration "${name}" already exists at "${filePath}"; refusing to overwrite`);
    }
    throw error;
  }
  console.log(`Created migration ${filePath}`);
  return 0;
}

/** Validate the on-disk history before any connection is opened. */
function validatedOrderedHistory(history: MigrationHistory): string[] {
  return resolveMigrationOrder(history).map((migration) => migration.name);
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

async function runMigrate(configPath: string, migrationsDir: string): Promise<number> {
  const dataSource = await loadConfig(configPath);
  const history = await readMigrationHistory(resolve(migrationsDir));
  const orderedNames = validatedOrderedHistory(history);

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

    const result = await migrate(asMigrationDataSource(dataSource), history);
    if (result.applied.length === 0) {
      console.log('Nothing to migrate.');
    } else {
      for (const name of result.applied) {
        console.log(`Applied ${name}`);
      }
    }
  } finally {
    await dataSource.destroy();
  }
  return 0;
}

async function runShowmigrations(configPath: string, migrationsDir: string): Promise<number> {
  const dataSource = await loadConfig(configPath);
  const history = await readMigrationHistory(resolve(migrationsDir));
  const orderedNames = validatedOrderedHistory(history);

  await dataSource.initialize();
  try {
    const status = await getMigrationStatus(asMigrationDataSource(dataSource), history);
    if (orderedNames.length === 0) {
      console.log('No migrations found.');
      return 0;
    }
    const applied = new Set(status.applied);
    const dirty = new Set(status.dirty);
    for (const name of orderedNames) {
      const marker = applied.has(name) ? '[x]' : dirty.has(name) ? '[!]' : '[ ]';
      console.log(`${marker} ${name}`);
    }
  } finally {
    await dataSource.destroy();
  }
  return 0;
}

// ---------------------------------------------------------------------------
// runtime commands: work / schedule
// ---------------------------------------------------------------------------

/**
 * Dependency seam for the runtime commands. Tests inject a fake controller so
 * no live Valkey/Redis is contacted; the default builds the neutral runtime
 * from the resolved config's selected adapter (built-in or custom, through the
 * same contract).
 */
export interface RuntimeDeps {
  /** Build the neutral runtime controller for a resolved runtime config. */
  createRuntime(config: ResolvedRuntimeConfig): JobsRuntime;
  /** Install SIGINT/SIGTERM handlers and resolve on the first signal. */
  waitForShutdown?(): ShutdownSignal;
}

/** The shutdown wait seam: a promise plus a disposer removing signal listeners. */
export interface ShutdownSignal {
  readonly promise: Promise<void>;
  dispose(): void;
}

const defaultRuntimeDeps: RuntimeDeps = {
  createRuntime: (config) =>
    createJobsRuntime({
      registry: config.registry,
      adapter: config.selectedAdapter,
      queueName: config.queueName,
      prefix: config.prefix,
      concurrency: config.concurrency,
    }),
  waitForShutdown: waitForShutdownSignal,
};

/**
 * Install SIGINT/SIGTERM handlers that resolve on the first signal. `dispose()`
 * removes the listeners so a startup failure or completed shutdown never leaks
 * a signal handler. The handlers are installed before the worker starts so a
 * SIGINT/SIGTERM can interrupt the worker's startup connection retries.
 */
function waitForShutdownSignal(): ShutdownSignal {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  const listeners: Array<[NodeJS.Signals, () => void]> = [];
  for (const signal of signals) {
    const listener = () => resolvePromise();
    process.on(signal, listener);
    listeners.push([signal, listener]);
  }
  let disposed = false;
  return {
    promise,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const [signal, listener] of listeners) {
        process.removeListener(signal, listener);
      }
    },
  };
}

async function loadResolvedRuntimeConfig(configPath: string): Promise<ResolvedRuntimeConfig> {
  const raw = await loadRuntimeConfigModule(configPath);
  return validateRuntimeConfig(raw);
}

/**
 * One-shot `schedule`: register the configured schedules, then exit. The
 * runtime is created, used, and closed; no worker or signal handler is
 * involved. An empty schedule list registers nothing and never forces a
 * producer (the runtime creates handles lazily, so nothing connects).
 */
async function runScheduleCommand(configPath: string, deps: RuntimeDeps): Promise<number> {
  const config = await loadResolvedRuntimeConfig(configPath);
  const runtime = deps.createRuntime(config);
  try {
    if (config.schedules.length > 0) {
      await runtime.upsertSchedules(config.schedules);
    }
    console.log(
      `Registered ${config.schedules.length} schedule(s) for queue "${config.queueName}".`,
    );
  } finally {
    await runtime.close();
  }
  return 0;
}

/**
 * `work`: register any schedules, start the worker, and wait for a shutdown
 * signal. The CLI owns SIGINT/SIGTERM only while `work` is running. Every
 * owned resource (the runtime controller, its producer/worker handles, and the
 * signal listeners) is closed/disposed on both the shutdown path and the
 * startup-failure path.
 */
async function runWorkCommand(configPath: string, deps: RuntimeDeps): Promise<number> {
  const config = await loadResolvedRuntimeConfig(configPath);

  // Install signal listeners before starting the worker so a signal can
  // interrupt the worker's startup connection retries.
  const signal = (deps.waitForShutdown ?? waitForShutdownSignal)();

  let runtime: JobsRuntime | undefined;
  try {
    runtime = deps.createRuntime(config);
    if (config.schedules.length > 0) {
      await runtime.upsertSchedules(config.schedules);
    }
    await runtime.startWorker();
    console.log(`Worker started for queue "${config.queueName}". Waiting for shutdown signal.`);
    await signal.promise;
  } finally {
    signal.dispose();
    if (runtime !== undefined) {
      await runtime.close();
    }
  }
  return 0;
}

/**
 * Dispatch a runtime command (`work` / `schedule`) with the given dependencies.
 * Exported for tests: inject a fake controller to exercise lifecycle, close
 * ordering, and registration without a live Valkey.
 */
export async function runRuntimeCommand(
  command: 'work' | 'schedule',
  configPath: string,
  deps: RuntimeDeps = defaultRuntimeDeps,
): Promise<number> {
  if (command === 'schedule') {
    return runScheduleCommand(configPath, deps);
  }
  return runWorkCommand(configPath, deps);
}

// ---------------------------------------------------------------------------
// app commands: build / serve
// ---------------------------------------------------------------------------

/**
 * Dependency seam for the app commands. Tests inject fakes so no HTTP server is
 * bound and no config module is imported; the defaults are the real factories.
 */
export interface AppDeps {
  loadConfig(configPath: string): Promise<ResolvedAppConfig>;
  createApplication(config: ResolvedAppConfig): Promise<Application>;
  /** Install SIGINT/SIGTERM handlers and resolve on the first signal. */
  waitForShutdown?(): ShutdownSignal;
}

const defaultAppDeps: AppDeps = {
  loadConfig: (configPath) => loadAppConfig(configPath),
  createApplication,
  waitForShutdown: waitForShutdownSignal,
};

/** Report one completed static build: outputs written plus any skipped APIs. */
function printBuildResult(result: GenerateStaticSiteResult): void {
  const outputs = result.written.length + result.copied.length;
  console.log(
    `Built ${outputs} output file(s) (${result.written.length} page(s), ${result.copied.length} asset(s)).`,
  );
  if (result.skipped.length > 0) {
    console.log(
      `Skipped ${result.skipped.length} API route(s): a static site build does not serve API routes.`,
    );
  }
}

/**
 * `build`: load the config, assemble the app, render the static site, and close.
 * The app is closed exactly once in a `finally`, whether the build succeeds or
 * throws. A failed `createApplication` owns nothing the CLI must close (its
 * extensions are already torn down by the assembler).
 */
async function runBuildCommand(configPath: string, deps: AppDeps): Promise<number> {
  const config = await deps.loadConfig(configPath);
  const app = await deps.createApplication(config);
  try {
    printBuildResult(await app.build());
  } finally {
    await app.close();
  }
  return 0;
}

/**
 * `serve`: load the config, install shutdown signal handlers, assemble the app,
 * listen, print the actual URL, and wait for SIGINT/SIGTERM before closing.
 *
 * Signal handlers are installed before `createApplication` so a signal arriving
 * during startup (extension setup or listen) is captured and leads to a clean
 * shutdown instead of the default immediate termination. They are disposed on
 * every path (shutdown, startup failure, and config failure), and never at
 * import time. The app is closed exactly once in the `finally`.
 */
async function runServeCommand(configPath: string, deps: AppDeps): Promise<number> {
  const config = await deps.loadConfig(configPath);
  const signal = (deps.waitForShutdown ?? waitForShutdownSignal)();
  let app: Application | undefined;
  try {
    app = await deps.createApplication(config);
    const handle = await app.serve();
    console.log(`Serving at ${handle.url}`);
    await signal.promise;
  } finally {
    signal.dispose();
    if (app !== undefined) {
      await app.close();
    }
  }
  return 0;
}

/**
 * Dispatch an app command (`build` / `serve`) with the given dependencies.
 * Exported for tests: inject fake factories to exercise lifecycle, close
 * ordering, and signal disposal without a real server or config module.
 */
export async function runAppCommand(
  command: 'build' | 'serve',
  configPath: string,
  deps: AppDeps = defaultAppDeps,
): Promise<number> {
  if (command === 'build') {
    return runBuildCommand(configPath, deps);
  }
  return runServeCommand(configPath, deps);
}

/**
 * Sanitize an app-command failure for the CLI. Framework errors carry value-free
 * messages and are echoed; anything else (an extension `setup`, a custom
 * renderer, an API module) is untrusted user code whose message may embed a
 * payload or credentials, so it is replaced with a generic message.
 */
function formatAppError(error: unknown): string {
  if (isValueFreeError(error)) {
    return formatError(error);
  }
  return 'the application command failed';
}

/** Errors whose messages are value-free by construction and safe to echo. */
function isValueFreeError(error: unknown): boolean {
  return (
    error instanceof AppConfigError ||
    error instanceof RouteManifestError ||
    error instanceof StaticSiteError ||
    error instanceof PageRenderError
  );
}

// ---------------------------------------------------------------------------
// project commands: create / dev
// ---------------------------------------------------------------------------

/** npm name the starter uses when a directory basename yields none. */
const DEFAULT_PACKAGE_NAME = 'jsails-app';

/** Longest name npm accepts for a new package. */
const MAX_PACKAGE_NAME_LENGTH = 214;

/**
 * Derive a valid npm package name from a directory basename: lowercase, keep
 * only the characters npm allows in an unscoped name, and drop a leading `.`
 * or `_`. A basename that yields nothing usable falls back to
 * {@link DEFAULT_PACKAGE_NAME}.
 */
function derivePackageName(dirName: string): string {
  let name = dirName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._]+/, '');
  if (!/^[a-z0-9]/.test(name)) {
    return DEFAULT_PACKAGE_NAME;
  }
  if (name.length > MAX_PACKAGE_NAME_LENGTH) {
    name = name.slice(0, MAX_PACKAGE_NAME_LENGTH);
  }
  return name;
}

/** Dependency seam for the `create` command's optional install step. */
export interface CreateDeps {
  /** Run `npm install` inside `cwd`; resolves to its process exit code. */
  install?(cwd: string): Promise<number>;
}

/** Options for {@link runCreateCommand}. */
export interface CreateOptions {
  /** npm package name; derived from the directory basename when absent. */
  readonly name?: string;
  /** `jsails` dependency specifier (e.g. `file:../jsails`). */
  readonly jsailsDependency?: string;
  /** Whether to run `npm install` inside the created project. */
  readonly install: boolean;
  /** Whether to generate the Better Auth variant. Defaults to false. */
  readonly auth?: boolean;
}

/** Terminate the owned process tree a detached child leads, best effort. */
function killChildGroup(child: ChildProcess | undefined): void {
  if (child === undefined || child.pid === undefined) {
    return;
  }
  killOwnedProcessTree(child.pid, 'SIGTERM');
}

/**
 * The npm-install spawn for the given platform. On Windows `npm` resolves to
 * `npm.cmd`, which Node refuses to spawn with `shell: false` (CVE-2024-27980),
 * so the install is invoked through `cmd.exe /d /s /c npm install` with a
 * fixed, non-interpolated command string. On POSIX `npm` is a shebang script
 * spawnable directly. No user-controlled shell is ever involved.
 *
 * Exported for the focused arg-assembly test; the real spawn happens in
 * {@link defaultInstallDependencies}.
 */
export function npmInstallSpawn(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    return {
      command: windowsCmdPath(env),
      args: ['/d', '/s', '/c', 'npm install'],
    };
  }
  return { command: 'npm', args: ['install'] };
}

/**
 * `cmd.exe` on Windows, resolved from the canonical `ComSpec` environment
 * variable (never the `PATH`, never a shell), falling back to a well-known
 * `SystemRoot` location when `ComSpec` is unset.
 */
function windowsCmdPath(env: NodeJS.ProcessEnv): string {
  const comspec = env.ComSpec;
  if (comspec !== undefined && comspec.trim() !== '') {
    return comspec;
  }
  const root = (env.SystemRoot ?? '').trim() || 'C:\\Windows';
  return win32.join(root, 'System32', 'cmd.exe');
}

/**
 * Run `npm install` inside `cwd` with a static argument array and no shell. The
 * child runs detached in its own process group so a SIGINT/SIGTERM interrupts
 * it without orphaning it: on a signal the group is terminated and the install
 * reports failure.
 */
function defaultInstallDependencies(cwd: string): Promise<number> {
  return new Promise<number>((resolve) => {
    let signal: ShutdownSignal | undefined;
    let settled = false;
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      signal?.dispose();
      resolve(code);
    };

    const { command, args } = npmInstallSpawn(process.platform, process.env);
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
      detached: true,
    });
    child.once('error', () => settle(1));
    child.once('exit', (code) => settle(code ?? 1));

    signal = waitForShutdownSignal();
    void signal.promise.then(() => {
      killChildGroup(child);
      settle(1);
    });
  });
}

const defaultCreateDeps: CreateDeps = {
  install: defaultInstallDependencies,
};

/** Print the created-project summary and the commands to run next. */
function printCreateResult(name: string, targetDir: string, installed: boolean): void {
  console.log(`Created ${name} in ${targetDir}.`);
  console.log('Next steps:');
  if (!installed) {
    console.log('  npm install');
  }
  console.log('  npm run dev');
  console.log('  npm run build');
}

/**
 * `create`: generate the starter file set, write it into the target directory,
 * and optionally run `npm install`. The name is derived from the directory
 * basename when `--name` is absent; nothing is installed unless `--install` is
 * given. A failed install propagates its exit code while the generated project
 * is kept, so the user can retry without losing the scaffold.
 */
export async function runCreateCommand(
  targetDir: string,
  options: CreateOptions,
  deps: CreateDeps = defaultCreateDeps,
): Promise<number> {
  const name = options.name ?? derivePackageName(basename(targetDir));
  const starterOptions = {
    name,
    ...(options.jsailsDependency === undefined
      ? {}
      : { jsailsDependency: options.jsailsDependency }),
    ...(options.auth ? { auth: true } : {}),
  };
  const { files } = await createStarterFiles(starterOptions);
  const written = await writeProjectFiles(targetDir, files);

  if (!options.install) {
    printCreateResult(name, written.targetDir, false);
    return 0;
  }

  const installCode = await (deps.install ?? defaultInstallDependencies)(written.targetDir);
  if (installCode !== 0) {
    console.error(
      `jsails: npm install failed (exit ${installCode}); the generated project was kept`,
    );
    console.error(`Run "npm install" inside ${written.targetDir} to retry.`);
    return installCode;
  }
  printCreateResult(name, written.targetDir, true);
  return 0;
}

/** Dependency seam for the `dev` command: inject a fake toolchain for tests. */
export interface DevCommandDeps {
  runDev(options: DevOptions): Promise<number>;
}

const defaultDevCommandDeps: DevCommandDeps = {
  runDev: (options) => runDev(options),
};

/**
 * `dev`: lazily invoke the development toolchain with the resolved config path.
 * No host/port/output flags are accepted; those live in the app config. The
 * toolchain starts here, never at import time.
 */
export async function runDevCommand(
  configPath: string,
  deps: DevCommandDeps = defaultDevCommandDeps,
): Promise<number> {
  return deps.runDev({ configPath });
}

// ---------------------------------------------------------------------------
// custom commands: jsails <name> [--config <path>] [raw arguments]
// ---------------------------------------------------------------------------

/** Whether `name` is one of the built-in commands owned by this file. */
function isBuiltinCommand(name: string): boolean {
  return (
    MIGRATION_COMMANDS.has(name) ||
    RUNTIME_COMMANDS.has(name) ||
    APP_COMMANDS.has(name) ||
    PROJECT_COMMANDS.has(name) ||
    JAMAL_COMMANDS.has(name)
  );
}

/** A custom-command invocation after the leading command name was consumed. */
interface CustomInvocation {
  /** Explicit `--config` value, or `undefined` when the default is implied. */
  readonly configPath: string | undefined;
  /** Every token except the consumed `--config` pair, in original order. */
  readonly rawArgs: readonly string[];
}

/**
 * Extract the custom command's config path from the tokens after its name.
 * Only `--config <value>` and `--config=<value>` are understood, and only
 * before a `--` delimiter; every other token — including `--` itself and
 * anything after it — is preserved verbatim and in order. A missing value or a
 * repeated config flag is a usage error (already printed) returned as a number.
 */
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

/** Echo only errors whose messages are value-free; else a generic failure. */
function formatCustomError(error: unknown): string {
  if (
    error instanceof CliCommandError ||
    error instanceof AppConfigError ||
    error instanceof SignatureError ||
    error instanceof CommandDiscoveryError
  ) {
    return error.message;
  }
  return 'the command failed';
}

/** Human label for a resolved audience in `--help` output. */
function audienceLabel(audience: CommandAudience | undefined): string {
  return audience === 'user' ? 'user command' : 'developer command';
}

/** Render the `--help` summary for one custom command without running it. */
function customCommandHelp(command: string, metadata: readonly CliCommandMetadata[]): string {
  const entry = metadata.find((candidate) => candidate.name === command);
  const summary = entry?.summary ?? '';
  const usage = entry?.usage ?? entry?.name ?? command;
  const audience = audienceLabel(entry?.audience);
  return `${command} - ${summary}\nAudience: ${audience}\n\nUsage:\n  jsails ${usage}\n`;
}

/** Discover compiled command modules from the working directory. */
async function discoverCommandsFromCwd(): Promise<CliCommand[]> {
  const cwd = process.cwd();
  // The generated starter compiles `commands/` sources into `dist/commands`;
  // a bare `commands/` tree (already-compiled modules at the project root) is
  // also accepted. Both locations are scanned so either convention works.
  const commands: CliCommand[] = [];
  for (const base of [cwd, join(cwd, 'dist')]) {
    commands.push(...(await discoverAppCommands(base)));
  }
  return commands;
}

/**
 * Resolve a custom command from the working directory's compiled `commands/`
 * tree and/or the app config, then either print its help or run it with the raw
 * argument tokens. No application is assembled and no extension `setup` runs.
 *
 * A discovered command resolved to the `user` audience (and invoked without an
 * explicit `--config`) is the user-facing path: it runs without ever loading
 * the app config, so it works from any cwd whether or not a project is present.
 * Every other command keeps today's behavior — the app config is loaded (when
 * `--config` is explicit or the default config file exists) and merged with the
 * discovered commands, so a name claimed by both is still rejected as a
 * duplicate and builtin-reserved names stay reserved.
 */
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
    console.error(`jsails: ${formatCustomError(error)}`);
    return 1;
  }

  const isDiscoveredUser =
    !options.hasExplicitConfig &&
    discovered.some((candidate) => candidate.name === command && candidate.audience === 'user');

  let config: ResolvedAppConfig | undefined;
  let configCommands: readonly CliCommand[] = [];
  if (!isDiscoveredUser && options.hasConfig) {
    try {
      config = await loadAppConfig(options.configPath);
      configCommands = collectConfigCommands(config);
    } catch (error) {
      console.error(`jsails: ${formatCustomError(error)}`);
      return 1;
    }
  }

  let registry: CliCommandRegistry;
  try {
    registry = createCliCommandRegistry(
      isDiscoveredUser ? discovered : [...configCommands, ...discovered],
    );
  } catch (error) {
    console.error(`jsails: ${formatCustomError(error)}`);
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
    configPath: config?.configPath ?? resolve(options.configPath),
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  };
  try {
    return await registry.run(command, options.rawArgs, context);
  } catch (error) {
    console.error(`jsails: ${formatCustomError(error)}`);
    return 1;
  }
}

/**
 * Parse arguments, dispatch to a command, and return a process exit code.
 * Never throws for expected failures: usage errors return 2, runtime errors
 * return 1. Help returns 0 without importing the config module.
 *
 * A leading non-flag token that is not a builtin selects the custom-command
 * path. A command discovered from the working directory and resolved to the
 * `user` audience runs without loading the app config; otherwise the app config
 * is loaded (when `--config` is explicit or the default app config file exists)
 * and merged with the discovered commands. This keeps `jsails --help` and a
 * bare unknown command free of any config import: discovery only scans for
 * compiled command modules and never imports the config.
 */
export async function runCli(argv: string[]): Promise<number> {
  // `jamal` owns its own subcommand + flags (`--write`, `--dir`), so it is
  // routed before the shared parseArgs/flag-gating below. It never imports a
  // config module and never reaches the custom-command path.
  if (argv[0] === 'jamal') {
    return runJamalCommand(argv.slice(1));
  }

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
      'a command is required (makemigrations | migrate | showmigrations | work | schedule | build | serve | create | dev | jamal)',
    );
  }
  // `create` takes exactly one positional (the target directory); every other
  // command takes none.
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
    !PROJECT_COMMANDS.has(command)
  ) {
    return usageError(`unknown command ${JSON.stringify(command)}`);
  }

  const isMigration = MIGRATION_COMMANDS.has(command);
  const isRuntime = RUNTIME_COMMANDS.has(command);
  const isApp = APP_COMMANDS.has(command);
  const isCreate = command === 'create';
  const isDev = command === 'dev';
  const configPath =
    values.config ??
    (isRuntime
      ? DEFAULT_RUNTIME_CONFIG_PATH
      : isApp || isDev
        ? DEFAULT_APP_CONFIG_PATH
        : DEFAULT_CONFIG_PATH);
  const migrationsDir = values.migrations ?? DEFAULT_MIGRATIONS_DIR;

  // Reject flags owned by another command before any work runs.
  if (!isMigration && values.migrations !== undefined) {
    return usageError('--migrations is only valid for migration commands');
  }
  if (command !== 'makemigrations' && values['allow-destructive']) {
    return usageError('--allow-destructive is only valid for makemigrations');
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
  if (!isCreate && values.auth) {
    return usageError('--auth is only valid for create');
  }
  if (isCreate && values.config !== undefined) {
    return usageError('create does not take --config');
  }
  if (command === 'makemigrations' && (values.name === undefined || values.name === '')) {
    return usageError('makemigrations requires --name');
  }

  try {
    if (isRuntime) {
      return await runRuntimeCommand(command as 'work' | 'schedule', configPath);
    }
    if (isApp) {
      return await runAppCommand(command as 'build' | 'serve', configPath);
    }
    if (isCreate) {
      // `rest.length === 1` was validated above, so the target is present.
      return await runCreateCommand(rest[0] as string, {
        name: values.name,
        jsailsDependency: values['jsails-dependency'],
        install: values.install,
        auth: values.auth,
      });
    }
    if (isDev) {
      return await runDevCommand(configPath);
    }
    if (command === 'makemigrations') {
      return await runMakemigrations(
        configPath,
        migrationsDir,
        values.name as string,
        values['allow-destructive'],
      );
    }
    if (command === 'migrate') {
      return await runMigrate(configPath, migrationsDir);
    }
    return await runShowmigrations(configPath, migrationsDir);
  } catch (error) {
    console.error(`jsails: ${isApp ? formatAppError(error) : formatError(error)}`);
    return 1;
  }
}

/** Compare the module URL against the real path of the invoked entry point. */
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
