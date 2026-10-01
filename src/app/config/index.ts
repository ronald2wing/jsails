/**
 * Application configuration for the JSails server/worker runtime.
 *
 * An application ships one compiled ESM module (default `jsails.app.js`) whose
 * default export is a plain {@link JsailsAppConfig} object. {@link loadAppConfig}
 * imports it and {@link validateAppConfig} turns the raw export into an
 * {@link ResolvedAppConfig} with every directory made absolute:
 *
 * - `rootDir` is relative to the config file's directory;
 * - `pages`/`api`/`public`/`out` are relative to `rootDir`.
 *
 * The loader is deliberately inert: it never creates a directory, loads a
 * `.env` file, opens a database/Valkey connection, installs a signal handler,
 * or invokes `setup`/`authorize`/`resolveSession`, an extension's `setup`, a
 * renderer's `render`, or a CLI command's `run`. Importing the config module
 * runs the app's own top-level code (that is inherent to ESM), but nothing in
 * this module calls the callbacks or methods; extensions, the renderer, and
 * command objects are passed through by identity, never cloned or rebound.
 *
 * Errors are always {@link AppConfigError}s with value-free messages: invalid
 * input values, credentials embedded in a URL, and arbitrary exceptions thrown
 * by the imported module are never echoed, and `.cause` is never populated.
 *
 * This is the assembly barrel. The shape contract (Zod schema, default
 * constants, option/resolved types, and {@link AppConfigError}) lives in
 * `schema.ts`; lexical path resolution and the private-directory
 * isolation guards live in `paths.ts`; and the dynamic import,
 * validation invocation, and secret redaction live in `load.ts`. Only
 * the public surface below is re-exported.
 */

export {
  AppConfigError,
  DEFAULT_APP_CONFIG_PATH,
  DEFAULT_APP_HOST,
  DEFAULT_APP_PORT,
  DEFAULT_APP_PAGES_DIR,
  DEFAULT_APP_API_DIR,
  DEFAULT_APP_PUBLIC_DIR,
  DEFAULT_APP_OUT_DIR,
  DEFAULT_APP_STORAGE_DIR,
  DEFAULT_HEALTH_PATH,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  MAX_SHUTDOWN_TIMEOUT_MS,
  type AppBroadcastConfig,
  type AppBroadcastOptions,
  type AppCleanup,
  type AppConfigLoadOptions,
  type AppConfigValidationOptions,
  type AppPluginsConfig,
  type ConfigSchemaIssue,
  type PluginUseEntry,
  type AppSetup,
  type IntrospectConfig,
  type JsailsAppConfig,
  type ResolvedAppConfig,
  type ResolvedIntrospectConfig,
} from './schema.js';

export { loadAppConfig, validateAppConfig } from './load.js';
export { defineAppConfig } from '../config-schema.js';
