/**
 * Shared state and lifecycle helpers for the `plugins` command.
 *
 * This module is the dependency leaf of the plugins command: it owns the
 * value-free error discipline, the per-subcommand flag allow-lists, the default
 * app-config/data-source loaders, and the managed-state mutations
 * (`enable`/`disable`/`rollback`) shared by the lifecycle subcommands. It reads
 * manifests, config modules, and the plugin state database only — it never
 * imports plugin code.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DataSource } from 'typeorm';

import { AppConfigError, DEFAULT_APP_CONFIG_PATH, loadAppConfig } from '../../app/config/index.js';
import { JsailsDataSource } from '../../database/data-source.js';
import { usageError as reportUsageError } from '../../internal/errors.js';
import { createDatabasePluginStateStore } from '../../plugins/database-state-store.js';
import { PluginEnablementError } from '../../plugins/enablement.js';
import { PluginInstallerError } from '../../plugins/installer.js';
import { PluginStateError, type PluginState } from '../../plugins/state-store.js';

import type { ParsedValues, PluginsDeps } from '../plugins-command.js';

/** The plugin settings the lifecycle commands read from the app config. */
export interface AppPluginSettings {
  /** Plugin ids enabled out of the box (code-managed; install refuses these). */
  readonly enabled?: readonly string[];
  /** Whether plugin state is managed in the database. */
  readonly managed?: boolean;
}

/** The default database config path for the lifecycle commands. */
const DEFAULT_DB_CONFIG_PATH = 'jsails.config.js';

/** A value-free error raised by this command; its message is safe to echo. */
class PluginsCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginsCommandError';
  }
}

/** Whether the config path is a TypeScript module that has not been compiled. */
function isTypeScriptConfig(path: string): boolean {
  return /\.(?:ts|mts|cts)$/.test(path);
}

/** Report a usage failure (exit 2) with the plugins help hint. */
export function usageError(deps: PluginsDeps, message: string): number {
  return reportUsageError(
    (line) => deps.stderr(line),
    'Run "jsails plugins --help" for usage.',
    message,
  );
}

/** Report a runtime (non-usage) failure with a value-free message; exit 1. */
export function fail(deps: PluginsDeps, message: string): number {
  deps.stderr(`jsails: ${message}`);
  return 1;
}

/** Read the app config's plugin settings; `undefined` when the config is absent. */
export async function defaultLoadAppPlugins(
  configPath: string,
): Promise<AppPluginSettings | undefined> {
  if (!existsSync(configPath)) {
    return undefined;
  }
  const resolved = await loadAppConfig(configPath);
  return {
    enabled: resolved.plugins?.enabled,
    managed: resolved.plugins?.managed,
  };
}

/** Load a compiled database config module default-exporting a `JsailsDataSource`. */
export async function defaultLoadDataSource(configPath: string): Promise<DataSource> {
  if (isTypeScriptConfig(configPath)) {
    throw new PluginsCommandError(
      'the database config is a TypeScript module; compile it to JavaScript first',
    );
  }
  let module: unknown;
  try {
    module = await import(pathToFileURL(configPath).href);
  } catch {
    throw new PluginsCommandError('failed to load the database config');
  }
  const dataSource = (module as { default?: unknown }).default;
  if (!(dataSource instanceof JsailsDataSource)) {
    throw new PluginsCommandError(
      'the database config must default-export a JsailsDataSource instance',
    );
  }
  return dataSource;
}

/** Echo only value-free error messages; anything else falls back to a fixed message. */
export function safeMessage(error: unknown, fallback: string): string {
  if (
    error instanceof PluginsCommandError ||
    error instanceof PluginInstallerError ||
    error instanceof PluginStateError ||
    error instanceof AppConfigError ||
    error instanceof PluginEnablementError
  ) {
    return error.message;
  }
  return fallback;
}

/** The flags each subcommand may carry (everything else is a usage error). */
const SUBCOMMAND_FLAGS: Record<string, ReadonlySet<string>> = {
  list: new Set(['dir', 'json']),
  check: new Set(['dir', 'json']),
  resolve: new Set(['config', 'db-config', 'json']),
  install: new Set(['dir', 'version', 'url', 'sha256', 'signature', 'force']),
  uninstall: new Set(['dir', 'force']),
  enable: new Set(['config', 'db-config']),
  disable: new Set(['config', 'db-config']),
  rollback: new Set(['config', 'db-config']),
};

/** The flags explicitly present in the parsed values (defaults are ignored). */
export function explicitlySetFlags(values: ParsedValues): string[] {
  const flags: string[] = [];
  if (values.dir !== undefined) flags.push('dir');
  if (values.json === true) flags.push('json');
  if (values.config !== undefined) flags.push('config');
  if (values['db-config'] !== undefined) flags.push('db-config');
  if (values.version !== undefined) flags.push('version');
  if (values.url !== undefined) flags.push('url');
  if (values.sha256 !== undefined) flags.push('sha256');
  if (values.signature !== undefined) flags.push('signature');
  if (values.force === true) flags.push('force');
  return flags;
}

/** Reject a flag outside a subcommand's allow-list, or `undefined` when all pass. */
export function rejectFlags(
  subcommand: string,
  flags: readonly string[],
  deps: PluginsDeps,
): number | undefined {
  const allowed = SUBCOMMAND_FLAGS[subcommand] ?? new Set<string>();
  for (const flag of flags) {
    if (!allowed.has(flag)) {
      return usageError(deps, `--${flag} is not valid for "plugins ${subcommand}"`);
    }
  }
  return undefined;
}

/** `enable`/`disable`: flip a managed plugin's `enabled` flag in the database. */
export async function runManagedToggle(
  id: string,
  enable: boolean,
  values: ParsedValues,
  deps: PluginsDeps,
): Promise<number> {
  const configPath = resolve(deps.cwd, values.config ?? DEFAULT_APP_CONFIG_PATH);
  const dbConfigPath = resolve(deps.cwd, values['db-config'] ?? DEFAULT_DB_CONFIG_PATH);
  return runManagedStateUpdate(deps, configPath, dbConfigPath, (state) => {
    const entry = state.plugins[id];
    if (entry === undefined) {
      throw new PluginsCommandError('plugin is not installed');
    }
    return {
      version: state.version,
      plugins: { ...state.plugins, [id]: { active: entry.active, enabled: enable } },
    };
  });
}

/** `rollback`: flip a managed plugin's active version in the database. */
export async function runRollback(
  id: string,
  version: string,
  values: ParsedValues,
  deps: PluginsDeps,
): Promise<number> {
  const configPath = resolve(deps.cwd, values.config ?? DEFAULT_APP_CONFIG_PATH);
  const dbConfigPath = resolve(deps.cwd, values['db-config'] ?? DEFAULT_DB_CONFIG_PATH);
  return runManagedStateUpdate(deps, configPath, dbConfigPath, (state) => {
    const entry = state.plugins[id];
    if (entry === undefined) {
      throw new PluginsCommandError('plugin is not installed');
    }
    return {
      version: state.version,
      plugins: { ...state.plugins, [id]: { active: version, enabled: entry.enabled } },
    };
  });
}

/**
 * Require a managed app config, then apply `mutate` to the database-backed
 * plugin state. The data source is initialized before the store is built and
 * destroyed in a `finally`, whether the update succeeds or fails.
 */
async function runManagedStateUpdate(
  deps: PluginsDeps,
  configPath: string,
  dbConfigPath: string,
  mutate: (state: PluginState) => PluginState,
): Promise<number> {
  let settings: AppPluginSettings | undefined;
  try {
    settings = await (deps.loadAppPlugins ?? defaultLoadAppPlugins)(configPath);
  } catch (error) {
    return fail(deps, safeMessage(error, 'the app config could not be read'));
  }
  if (settings?.managed !== true) {
    return fail(deps, 'plugin state is not managed (set plugins.managed in the app config)');
  }

  let dataSource: DataSource;
  try {
    dataSource = await (deps.loadDataSource ?? defaultLoadDataSource)(dbConfigPath);
  } catch (error) {
    return fail(deps, safeMessage(error, 'the plugin state database config could not be loaded'));
  }

  try {
    await dataSource.initialize();
  } catch {
    return fail(deps, 'the plugin state database could not be initialized');
  }

  let result = 0;
  try {
    const store = (deps.createStateStore ?? createDatabasePluginStateStore)({ dataSource });
    const state = await store.load();
    await store.save(mutate(state));
    result = 0;
  } catch (error) {
    result = fail(deps, safeMessage(error, 'the plugin state could not be updated'));
  } finally {
    try {
      await dataSource.destroy();
    } catch {
      if (result === 0) {
        result = fail(deps, 'the plugin state database could not be closed');
      }
    }
  }
  return result;
}
