/**
 * Shared config-module loading for the CLI.
 *
 * Migration commands load a compiled JS ESM module default-exporting a
 * {@link JsailsDataSource}; app commands load an app config object through
 * {@link loadAppConfig}. Both need the same "compile TypeScript first"
 * rejection and value-free failure discipline, so this module owns the shared
 * loader and re-exports the app-config surface the CLI commands consume.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { JsailsDataSource } from '../database/data-source.js';
import { formatError } from '../internal/errors.js';

export {
  AppConfigError,
  DEFAULT_APP_CONFIG_PATH,
  loadAppConfig,
  type ResolvedAppConfig,
} from '../app/config/index.js';

/** The default database config path for the migration commands. */
export const DEFAULT_CONFIG_PATH = 'jsails.config.js';

/** Whether the config path is a TypeScript module that has not been compiled. */
export function isTypeScriptConfig(path: string): boolean {
  return /\.(?:ts|mts|cts)$/.test(path);
}

/**
 * Load a compiled config module and return its default export. A TypeScript
 * path is rejected rather than executed; every failure is value-free.
 */
export async function loadConfigModule(configPath: string): Promise<unknown> {
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
  return (module as { default?: unknown }).default;
}

/** Load a database config module default-exporting a `JsailsDataSource`. */
export async function loadDataSourceConfig(configPath: string): Promise<JsailsDataSource> {
  const dataSource = await loadConfigModule(configPath);
  if (!(dataSource instanceof JsailsDataSource)) {
    throw new Error(`config "${configPath}" must default-export a JsailsDataSource instance`);
  }
  return dataSource;
}
