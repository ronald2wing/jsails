/**
 * The `plugins` builtin command: discover, check, and manage JSails plugins.
 *
 * This module is the thin dispatcher: it parses arguments, gates the subcommand
 * and its flags, and routes to the read-only `list`/`check` (`.plugins/list`),
 * the installer-backed `install`/`uninstall` (`.plugins/install`), and the
 * managed-state `enable`/`disable`/`rollback` (`.plugins/state`) subcommands.
 *
 * The command reads manifests and config modules only, never imports plugin
 * entry code; every failure is value-free and exits non-zero. `--json` applies
 * only to `list`/`check`.
 */

import { parseArgs } from 'node:util';

import type { DataSource } from 'typeorm';

import { formatError } from '../internal/errors.js';
import {
  createDatabasePluginStateStore,
  type DatabasePluginStateStoreOptions,
} from '../plugins/database-state-store.js';
import {
  createPluginInstaller,
  type PluginInstaller,
  type PluginInstallerOptions,
} from '../plugins/installer.js';
import { isValidSemverVersion, PLUGIN_ID_PATTERN } from '../plugins/manifest.js';
import type { PluginStateSource } from '../plugins/state-store.js';

import { runInstall, runUninstall } from './plugins/install.js';
import { runDiscoverCommand } from './plugins/list.js';
import { runResolve } from './plugins/resolve.js';
import {
  defaultLoadAppPlugins,
  defaultLoadDataSource,
  explicitlySetFlags,
  fail,
  rejectFlags,
  runManagedToggle,
  runRollback,
  usageError,
  type AppPluginSettings,
} from './plugins/state.js';

/** Dependency seam for the `plugins` command. Tests inject cwd + output sinks + factories. */
export interface PluginsDeps {
  /** Working directory the plugins folder and config paths resolve against. */
  readonly cwd: string;
  /** Framework version to check against; defaults to {@link readFrameworkVersion}. */
  readonly frameworkVersion?: string;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Load the app config's plugin settings, or `undefined` when the config is absent. */
  loadAppPlugins?(configPath: string): Promise<AppPluginSettings | undefined>;
  /** Load the database config module default-exporting a `JsailsDataSource`. */
  loadDataSource?(configPath: string): Promise<DataSource>;
  /** Build the plugin installer for a plugins directory. */
  createInstaller?(options: PluginInstallerOptions): PluginInstaller;
  /** Build the database-backed plugin state store. */
  createStateStore?(options: DatabasePluginStateStoreOptions): PluginStateSource;
}

const defaultPluginsDeps: PluginsDeps = {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  loadAppPlugins: defaultLoadAppPlugins,
  loadDataSource: defaultLoadDataSource,
  createInstaller: createPluginInstaller,
  createStateStore: createDatabasePluginStateStore,
};

const PLUGINS_OPTIONS = {
  dir: { type: 'string' },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  config: { type: 'string' },
  'db-config': { type: 'string' },
  version: { type: 'string' },
  url: { type: 'string' },
  sha256: { type: 'string' },
  signature: { type: 'string' },
  force: { type: 'boolean', default: false },
} as const;

const PLUGINS_USAGE = `plugins - discover, check, and manage installed JSails plugins

Usage:
  jsails plugins [list|check|resolve] [options]
  jsails plugins install <id> --version <v> --url <tgz> [--sha256 <hex>] [--signature <b64>] [--force] [options]
  jsails plugins enable <id> [options]
  jsails plugins disable <id> [options]
  jsails plugins uninstall <id> [--force] [options]
  jsails plugins rollback <id> <version> [options]

Subcommands:
  list        List discovered plugins with their provenance (default)
  check       Validate plugins against the framework version
  resolve     Resolve plugin enablement from the code list and managed state
  install     Download and install a plugin bundle
  enable      Enable a managed plugin in the plugin state database
  disable     Disable a managed plugin in the plugin state database
  uninstall   Remove an installed plugin bundle
  rollback    Flip the active version of a managed plugin

Options:
  --dir <path>        Plugins folder (default: <cwd>/storage/plugins)
  --json              Emit machine-readable JSON (list/check/resolve only)
  --config <path>     App config module (enable/disable/rollback/resolve; default: jsails.app.js)
  --db-config <path>  Database config module (enable/disable/rollback/resolve; default: jsails.config.js)
  --version <v>       Plugin version (install; required)
  --url <tgz>         Bundle URL (install; required)
  --sha256 <hex>      Bundle SHA-256 checksum (install)
  --signature <b64>   Detached bundle signature (install)
  --force             Bypass the dependency guard (install/uninstall)
  -h, --help          Show this help

Plugins are discovered from direct npm dependencies that self-identify through
their package.json "jsails" field, and from manifest.json bundles in the plugins
folder. The command reads manifests and config modules only and never imports
plugin code.
`;

const SUBCOMMANDS = new Set([
  'list',
  'check',
  'install',
  'enable',
  'disable',
  'uninstall',
  'rollback',
  'resolve',
]);

/** The flags the `plugins` command parses (all optional; defaults are ignored). */
export interface ParsedValues {
  readonly dir?: string;
  readonly json?: boolean;
  readonly config?: string;
  readonly 'db-config'?: string;
  readonly version?: string;
  readonly url?: string;
  readonly sha256?: string;
  readonly signature?: string;
  readonly force?: boolean;
}

/** Run `jsails plugins` over the tokens after the command name. */
export async function runPluginsCommand(
  args: readonly string[],
  deps: PluginsDeps = defaultPluginsDeps,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: PLUGINS_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usageError(deps, formatError(error));
  }

  const { values, positionals } = parsed;

  if (values.help) {
    deps.stdout(PLUGINS_USAGE);
    return 0;
  }

  const subcommand = positionals[0] ?? 'list';
  if (!SUBCOMMANDS.has(subcommand)) {
    return usageError(deps, `unknown subcommand ${JSON.stringify(subcommand)}`);
  }

  if (subcommand === 'list' || subcommand === 'check') {
    if (positionals.length > 1) {
      return usageError(deps, `unexpected argument: ${positionals.slice(1).join(' ')}`);
    }
    return runDiscoverCommand(subcommand, values, deps);
  }

  if (subcommand === 'resolve') {
    if (positionals.length > 1) {
      return usageError(deps, `unexpected argument: ${positionals.slice(1).join(' ')}`);
    }
    return runResolve(values, deps);
  }

  return runLifecycleCommand(subcommand, positionals, values, deps);
}

/** Dispatch the lifecycle subcommands after shared gating. */
async function runLifecycleCommand(
  subcommand: string,
  positionals: readonly string[],
  values: ParsedValues,
  deps: PluginsDeps,
): Promise<number> {
  const rejected = rejectFlags(subcommand, explicitlySetFlags(values), deps);
  if (rejected !== undefined) {
    return rejected;
  }

  const id = positionals[1];
  const version = positionals[2];
  if (subcommand === 'rollback') {
    if (id === undefined || version === undefined || positionals.length > 3) {
      return usageError(deps, 'plugins rollback requires <id> <version>');
    }
  } else if (id === undefined || positionals.length > 2) {
    return usageError(deps, `plugins ${subcommand} requires <id>`);
  }

  if (!PLUGIN_ID_PATTERN.test(id)) {
    return fail(deps, 'plugin id is invalid');
  }

  switch (subcommand) {
    case 'install':
      return runInstall(id, values, deps);
    case 'uninstall':
      return runUninstall(id, values, deps);
    case 'enable':
    case 'disable':
      return runManagedToggle(id, subcommand === 'enable', values, deps);
    case 'rollback': {
      if (version === undefined || !isValidSemverVersion(version)) {
        return fail(deps, 'plugin version is invalid');
      }
      return runRollback(id, version, values, deps);
    }
    default:
      return usageError(deps, `unknown subcommand ${JSON.stringify(subcommand)}`);
  }
}
