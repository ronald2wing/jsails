/**
 * Inspect commands: read-only introspection of the application's route
 * manifest. `inspect routes` wraps `discoverRoutes` and prints the manifest
 * without importing page/API modules or opening a connection.
 *
 * ```sh
 * jsails inspect routes --json        # machine-readable
 * jsails inspect routes                # human-readable table
 * jsails inspect routes --config jsails.app.js
 * ```
 */

import { resolve } from 'node:path';

import { AppConfigError, loadAppConfig, type ResolvedAppConfig } from '../app/config/index.js';
import { formatError, usageError as reportUsageError } from '../internal/errors.js';
import { discoverRoutes, type RouteManifest } from '../routing/routes.js';

/** Options for {@link runInspectRoutesCommand}. */
export interface InspectRoutesOptions {
  /** Print a single JSON line instead of the human-readable table. */
  readonly json?: boolean;
}

/**
 * CLI input to the route introspection command.
 * Exported so tests can inject fakes.
 */
export interface InspectRoutesInput {
  /** Path to the compiled app config module. */
  readonly configPath: string;
  /** Options parsed from CLI flags. */
  readonly options: InspectRoutesOptions;
}

/** Dependency seam for the `inspect routes` command. */
export interface InspectRoutesDeps {
  /** Load and resolve the app config. */
  loadConfig(configPath: string): Promise<ResolvedAppConfig>;
  /** Write one output line. */
  stdout(text: string): void;
  /** Write one error line. */
  stderr(text: string): void;
}

const defaultInspectRoutesDeps: InspectRoutesDeps = {
  loadConfig: (configPath) => loadAppConfig(configPath),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

/** Error types whose messages are safe to echo verbatim. */
function isEchoable(error: unknown): boolean {
  return error instanceof AppConfigError;
}

/**
 * Load the app config, call `discoverRoutes`, and print the route manifest.
 * Returns a process exit code. Errors are value-free: config and route failures
 * are caught and printed to stderr, returning 1.
 */
export async function runInspectRoutes(
  input: InspectRoutesInput,
  deps: InspectRoutesDeps = defaultInspectRoutesDeps,
): Promise<number> {
  let config: ResolvedAppConfig;
  try {
    config = await deps.loadConfig(input.configPath);
  } catch (error) {
    deps.stderr(
      `jsails: ${formatError(error, { allow: isEchoable, fallback: 'failed to load config' })}`,
    );
    return 1;
  }

  const rootDir = config.rootDir;
  const resolvedPagesDir = config.pagesDir;
  const resolvedApiDir = config.apiDir;

  let manifest: RouteManifest;
  try {
    manifest = discoverRoutes(rootDir, { pagesDir: resolvedPagesDir, apiDir: resolvedApiDir });
  } catch (error) {
    deps.stderr(
      `jsails: ${formatError(error, { allow: isEchoable, fallback: 'route discovery failed' })}`,
    );
    return 1;
  }

  const lines = renderRouteManifest(manifest, input.options.json === true);
  for (const line of lines) {
    deps.stdout(line);
  }
  return 0;
}

/**
 * Render the route manifest as output lines.
 *
 * JSON shape (stable; keep in sync with the help text):
 * ```
 * {
 *   "entries": [
 *     {
 *       "kind": "page" | "api",
 *       "route": "/path/:param",
 *       "file": "/abs/path/to/file.js",
 *       "dynamic": true | false,
 *       "catchAll": false,
 *       "params": ["param"]
 *     }
 *   ]
 * }
 * ```
 */
function renderRouteManifest(manifest: RouteManifest, asJson: boolean): string[] {
  if (asJson) {
    const entries = manifest.entries.map((entry) => ({
      kind: entry.kind,
      route: entry.route,
      file: resolve(entry.file),
      dynamic: entry.dynamic,
      catchAll: entry.catchAll,
      params: entry.params,
    }));
    return [JSON.stringify({ entries })];
  }

  if (manifest.entries.length === 0) {
    return ['No routes found.'];
  }

  const lines: string[] = [
    `Route manifest (${manifest.entries.length} route(s)):`,
    '',
    'ROUTE                   KIND   DYNAMIC   PARAMS           FILE',
    '----                    ----   -------   ------           ----',
  ];
  for (const entry of manifest.entries) {
    const route = entry.route.padEnd(22);
    const kind = entry.kind.padEnd(6);
    const dynamic = String(entry.dynamic).padEnd(9);
    const params = entry.params.join(',').padEnd(16);
    lines.push(`${route} ${kind} ${dynamic} ${params} ${entry.file}`);
  }
  return lines;
}

/** Render usage text for `inspect routes --help`. */
function inspectRoutesHelp(): string {
  return `inspect routes - print the discovered route manifest

Usage:
  jsails inspect routes [options]

Options:
  -c, --config <path>  Path to the app config module (default: jsails.app.js)
      --json           Emit a single JSON line instead of a table
  -h, --help           Show this help

Read-only: never imports page/API modules, never opens a connection.

JSON shape:
  { "entries": [{ "kind", "route", "file", "dynamic", "catchAll", "params" }] }
`;
}

/**
 * Parse and run `jsails inspect` from the raw arguments after the command name.
 * Owns its own argument parsing (like `jamal`/`plugins`/`make`), so it is
 * routed before the shared `parseArgs` flag-gating in `cli.ts`.
 */
export async function runInspectCommand(
  args: readonly string[],
  deps?: InspectRoutesDeps,
): Promise<number> {
  // Manual argument parsing so we stay compatible with the early-routing
  // pattern without pulling in `node:util parseArgs`.
  let configPath = 'jsails.app.js';
  let json = false;
  let help = false;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === '--help' || token === '-h') {
      help = true;
    } else if (token === '--json') {
      json = true;
    } else if (token === '--config') {
      const value = args[index + 1];
      if (value === undefined) {
        return reportUsageError(
          (line) => (deps?.stderr ?? defaultInspectRoutesDeps.stderr)(line),
          'Run "jsails inspect --help" for usage.',
          '--config requires a value',
        );
      }
      configPath = value;
      index += 1;
    } else if (token.startsWith('--config=')) {
      configPath = token.slice('--config='.length);
    } else if (token.startsWith('-')) {
      return reportUsageError(
        (line) => (deps?.stderr ?? defaultInspectRoutesDeps.stderr)(line),
        'Run "jsails inspect --help" for usage.',
        `unknown option ${JSON.stringify(token)}`,
      );
    } else {
      positionals.push(token);
    }
  }

  if (help) {
    (deps?.stdout ?? defaultInspectRoutesDeps.stdout)(inspectRoutesHelp());
    return 0;
  }

  if (positionals.length === 0) {
    return reportUsageError(
      (line) => (deps?.stderr ?? defaultInspectRoutesDeps.stderr)(line),
      'Run "jsails inspect --help" for usage.',
      'a subcommand is required (routes)',
    );
  }

  const subcommand = positionals[0];
  if (subcommand !== 'routes') {
    return reportUsageError(
      (line) => (deps?.stderr ?? defaultInspectRoutesDeps.stderr)(line),
      'Run "jsails inspect --help" for usage.',
      `unknown subcommand ${JSON.stringify(subcommand)}`,
    );
  }

  if (positionals.length > 1) {
    return reportUsageError(
      (line) => (deps?.stderr ?? defaultInspectRoutesDeps.stderr)(line),
      'Run "jsails inspect --help" for usage.',
      `unexpected argument: ${positionals.slice(1).join(' ')}`,
    );
  }

  return runInspectRoutes({ configPath, options: { json } }, deps);
}
