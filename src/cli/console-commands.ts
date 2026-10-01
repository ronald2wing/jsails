/**
 * `jsails console` — an interactive REPL for poking the database, calling
 * models, inspecting config, and running jobs interactively (Rails `rails
 * console` / Laravel `artisan tinker` equivalent).
 *
 * Usage:
 *   jsails console [--config jsails.config.js] [--runtime jsails.runtime.js]
 *
 * Both flags are optional. When the db config exists, the data source is
 * initialized before the REPL opens and destroyed afterward; when absent, the
 * DB is skipped and the REPL still opens. The runtime config is optional and
 * builds a jobs runtime (reusing the same loader `work`/`schedule`/`queue`
 * use) — the runtime is closed when the REPL exits.
 *
 * The REPL context object exposes:
 *   db       — the initialized DataSource, or undefined
 *   models   — a map of entity name -> repository (from entityMetadatas)
 *   config   — the loaded module defaults ({ db: ..., runtime: ... })
 *   jobs     — the JobsRuntime, or undefined
 *
 * All errors are value-free: a bad config path or failed init surfaces a
 * stable code + generic message, never file contents or credentials.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { start, type REPLServer } from 'node:repl';

import { loadConfigModule } from './config-loader.js';
import { JsailsDataSource } from '../database/data-source.js';
import { formatError } from '../internal/errors.js';
import {
  loadRuntimeConfigModule,
  validateRuntimeConfig,
  type ResolvedRuntimeConfig,
} from '../jobs/runtime-config.js';
import { JobsRuntimeImpl, type JobsRuntime } from '../jobs/runtime.js';

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const USAGE = `jsails console - Start an interactive REPL with the application loaded

Usage:
  jsails console [--config <path>] [--runtime <path>]

Options:
  --config <path>   Path to the database config module (default: jsails.config.js)
  --runtime <path>  Path to the runtime config module (default: jsails.runtime.js)

The REPL exposes the following context variables:
  db       The initialized data source (or undefined)
  models   Map of entity name to entity class (from entity metadata)
  config   The loaded config metadata ({ db, runtime })
  jobs     The jobs runtime (or undefined)

Both config modules are optional. When a config file does not exist, the
corresponding resource is skipped and the REPL still opens.

Type .exit to quit, .help for REPL commands.`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed `console` command options. */
export interface ConsoleOptions {
  /** Path to the database config (default `jsails.config.js`). */
  readonly configPath?: string;
  /** Path to the runtime config (default `jsails.runtime.js`). */
  readonly runtimePath?: string;
}

/** The REPL surface the command drives; testable via injection. */
export interface ConsoleRepl {
  /** A promise that resolves when the REPL exits. */
  readonly closed: Promise<void>;
  /** The REPL context object (populated before the prompt appears). */
  readonly context: Record<string, unknown>;
  /** Close the REPL programmatically (idempotent, best-effort). */
  close(): void;
}

/** Dependency seam for the console command. Tests inject fakes for I/O. */
export interface ConsoleDeps {
  /** Write a line to stdout. */
  stdout(text: string): void;
  /** Write a line to stderr. */
  stderr(text: string): void;
  /** Load a data source from a config path; returns undefined when the file does not exist. */
  loadDataSource(configPath: string): Promise<JsailsDataSource | undefined>;
  /** Load a resolved runtime config; returns undefined when the file does not exist. */
  loadRuntimeConfig(configPath: string): Promise<ResolvedRuntimeConfig | undefined>;
  /** Build a jobs runtime from a resolved config. */
  createRuntime(config: ResolvedRuntimeConfig): JobsRuntime;
  /** Start the REPL with the given context object. */
  startRepl(context: Record<string, unknown>): ConsoleRepl;
}

// ---------------------------------------------------------------------------
// Default dependencies (real I/O, real node:repl)
// ---------------------------------------------------------------------------

async function defaultLoadDataSource(configPath: string): Promise<JsailsDataSource | undefined> {
  if (!existsSync(resolve(configPath))) {
    return undefined;
  }
  const raw = await loadConfigModule(configPath);
  if (!(raw instanceof JsailsDataSource)) {
    throw new Error(`config "${configPath}" must default-export a JsailsDataSource instance`);
  }
  return raw;
}

async function defaultLoadRuntimeConfig(
  configPath: string,
): Promise<ResolvedRuntimeConfig | undefined> {
  if (!existsSync(resolve(configPath))) {
    return undefined;
  }
  const raw = await loadRuntimeConfigModule(configPath);
  return validateRuntimeConfig(raw);
}

function defaultStartRepl(context: Record<string, unknown>): ConsoleRepl {
  const server: REPLServer = start({ prompt: 'jsails> ', terminal: true, useColors: true });
  // Copy context entries into the REPL server context.
  for (const [key, value] of Object.entries(context)) {
    server.context[key] = value;
  }
  let closedResolve: () => void;
  const closed = new Promise<void>((resolveFn) => {
    closedResolve = resolveFn;
  });
  server.on('exit', () => closedResolve());
  return {
    closed,
    get context() {
      // Return a snapshot that reflects any mutations the user made at the REPL.
      return { ...server.context };
    },
    close() {
      try {
        server.close();
      } catch {
        // The REPL may already be closed; swallow.
      }
    },
  };
}

export const defaultConsoleDeps: ConsoleDeps = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  loadDataSource: defaultLoadDataSource,
  loadRuntimeConfig: defaultLoadRuntimeConfig,
  createRuntime: (config) =>
    new JobsRuntimeImpl({
      registry: config.registry,
      adapter: config.adapter,
      queueName: config.queueName,
      prefix: config.prefix,
      concurrency: config.concurrency,
    }),
  startRepl: defaultStartRepl,
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse `--config <path>` and `--runtime <path>` from raw args. */
function parseConsoleArgs(args: readonly string[]) {
  let configPath = 'jsails.config.js';
  let runtimePath = 'jsails.runtime.js';
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    if (token === '--help' || token === '-h') {
      return 'help';
    }
    if (token === '--config') {
      const value = args[i + 1];
      if (value === undefined) {
        return '--config requires a value';
      }
      configPath = value;
      i += 1;
    } else if (token.startsWith('--config=')) {
      configPath = token.slice('--config='.length);
      if (configPath === '') {
        return '--config requires a value';
      }
    } else if (token === '--runtime') {
      const value = args[i + 1];
      if (value === undefined) {
        return '--runtime requires a value';
      }
      runtimePath = value;
      i += 1;
    } else if (token.startsWith('--runtime=')) {
      runtimePath = token.slice('--runtime='.length);
      if (runtimePath === '') {
        return '--runtime requires a value';
      }
    } else {
      return `unknown argument: ${JSON.stringify(token)}`;
    }
  }
  return { configPath, runtimePath };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

interface BootContext {
  db: JsailsDataSource | undefined;
  models: Record<string, unknown>;
  config: Record<string, unknown>;
  jobs: JobsRuntime | undefined;
}

async function bootContext(options: ConsoleOptions, deps: ConsoleDeps): Promise<BootContext> {
  const configRecords: Record<string, unknown> = {};

  // 1. Data source.
  let db: JsailsDataSource | undefined;
  let models: Record<string, unknown> = {};
  try {
    db = await deps.loadDataSource(options.configPath ?? 'jsails.config.js');
  } catch (error) {
    deps.stderr(`jsails: failed to load db config: ${formatError(error)}`);
    // Continue: the REPL still opens without a database.
  }
  if (db !== undefined) {
    try {
      await db.initialize();
      configRecords.db = {
        initialized: true,
        options: { type: db.options.type, database: db.options.database },
      };
      // Build a models map from entity metadata.
      const modelMap: Record<string, unknown> = {};
      for (const meta of db.entityMetadatas) {
        // Store the entity constructor/name so callers can do `models.User.find()`.
        modelMap[meta.name] = meta.target;
      }
      models = modelMap;
    } catch (error) {
      deps.stderr(`jsails: failed to initialize data source: ${formatError(error)}`);
      db = undefined;
    }
  }

  // 2. Runtime config + jobs runtime.
  let jobs: JobsRuntime | undefined;
  try {
    const rtConfig = await deps.loadRuntimeConfig(options.runtimePath ?? 'jsails.runtime.js');
    if (rtConfig !== undefined) {
      configRecords.runtime = {
        queueName: rtConfig.queueName,
        scheduleCount: rtConfig.schedules.length,
      };
      jobs = deps.createRuntime(rtConfig);
    }
  } catch (error) {
    deps.stderr(`jsails: failed to load runtime config: ${formatError(error)}`);
    // Continue: the REPL still opens without a jobs runtime.
  }

  return { db, models, config: configRecords, jobs };
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

function printBanner(ctx: BootContext, deps: ConsoleDeps): void {
  const lines: string[] = ['JSails interactive console'];
  if (ctx.db !== undefined) {
    const entityCount = Object.keys(ctx.models).length;
    lines.push(`  Database: connected (${entityCount} model(s))`);
  } else {
    lines.push('  Database: not available');
  }
  if (ctx.jobs !== undefined) {
    lines.push('  Jobs: ready');
  } else {
    lines.push('  Jobs: not available');
  }
  lines.push('');
  lines.push('Type .exit to quit, .help for REPL commands.');
  for (const line of lines) {
    deps.stdout(line);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the `jsails console` command.
 *
 * @param args  Raw arguments after `console`.
 * @param deps  Injected dependencies (defaults to real I/O). The `startRepl`
 *              seam is the injection point for tests — supply a fake REPL
 *              to inspect the context without a real TTY.
 */
export async function runConsole(
  args: readonly string[],
  deps: ConsoleDeps = defaultConsoleDeps,
): Promise<number> {
  const parsed = parseConsoleArgs(args);
  if (typeof parsed === 'string') {
    if (parsed === 'help') {
      deps.stdout(USAGE);
      return 0;
    }
    deps.stderr(`jsails: ${parsed}`);
    return 1;
  }

  // Reject .ts config paths (compile first).
  for (const [label, path] of [
    ['--config', parsed.configPath],
    ['--runtime', parsed.runtimePath],
  ] as const) {
    if (/\.(?:ts|mts|cts)$/.test(path)) {
      deps.stderr(
        `jsails: ${label} "${path}" is a TypeScript module; compile it to JavaScript first ` +
          `(e.g. tsc) and point ${label} at the compiled output`,
      );
      return 1;
    }
  }

  const ctx = await bootContext(
    { configPath: parsed.configPath, runtimePath: parsed.runtimePath },
    deps,
  );

  // Build the REPL context object.
  const replContext: Record<string, unknown> = {
    db: ctx.db,
    models: ctx.models,
    config: ctx.config,
    jobs: ctx.jobs,
  };

  printBanner(ctx, deps);

  const repl = deps.startRepl(replContext);

  // Wait for the REPL to exit, then tear down.
  await repl.closed;

  // Teardown: destroy the data source and close the jobs runtime.
  // Both are best-effort: a teardown error is swallowed so exit is clean.
  if (ctx.db !== undefined) {
    try {
      await ctx.db.destroy();
    } catch {
      // Swallow: the process is exiting.
    }
  }
  if (ctx.jobs !== undefined) {
    try {
      await ctx.jobs.close();
    } catch {
      // Swallow.
    }
  }

  return 0;
}
