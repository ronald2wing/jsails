/**
 * Config loading, validation, and secret redaction for the application config.
 *
 * {@link loadAppConfig} imports the compiled config module (rejecting
 * TypeScript paths up front) and {@link validateAppConfig} resolves a
 * programmatic config object into a {@link ResolvedAppConfig}. Both are inert:
 * they never create a directory, load a `.env` file, open a database/Valkey
 * connection, install a signal handler, or invoke `setup`/`authorize`/
 * `resolveSession`, an extension's `setup`, a renderer's `render`, or a CLI
 * command's `run`. Callbacks, extensions, the renderer, and command objects are
 * passed through by identity, never cloned or rebound.
 *
 * Errors are always {@link AppConfigError}s with value-free messages: invalid
 * input values, credentials embedded in a URL, and arbitrary exceptions thrown
 * by the imported module are never echoed, and `.cause` is never populated.
 * The whole resolve pass runs inside {@link sanitizeAppConfigErrors} so a
 * throwing property accessor (or any other step) surfaces as a value-free
 * {@link AppConfigError}.
 */

import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { z } from 'zod';

import type { IntrospectSection } from '../../introspect/sections.js';
import type {
  AttachBroadcastOptions,
  BroadcastAdapter,
  BroadcastOptions,
} from '../../broadcast/server.js';
import {
  CliCommandError,
  collectConfigCommands,
  createCliCommandRegistry,
  type CliCommand,
} from '../../cli/command-registry.js';
import type { DeploymentGenerator } from '../../deploy/registry.js';
import type { JsailsExtension } from '../../extensions/extension.js';
import { validateExtensionEntries, type ExtensionEntryError } from '../../extensions/validation.js';
import { assertRedisUrl } from '../../jobs/runtime-config.js';
import type { PageRenderer } from '../../contracts/render.js';
import type { RouteMiddleware, RouteMiddlewareRef } from '../../routing/middleware.js';
import type { Authorize, ResolveSession } from '../../contracts/http.js';
import { DEFAULT_MAX_BODY_BYTES } from '../../server/app.js';
import {
  AppConfigError,
  DEFAULT_APP_CONFIG_PATH,
  DEFAULT_APP_HOST,
  DEFAULT_APP_PORT,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  appConfigSchema,
  type AppBroadcastOptions,
  type AppConfigLoadOptions,
  type AppConfigValidationOptions,
  type AppPluginsConfig,
  type AppSetup,
  type IntrospectConfig,
  type ResolvedAppConfig,
  type ResolvedIntrospectConfig,
} from './schema.js';
import {
  assertPublicDirIsolation,
  assertStorageIsolation,
  resolveConfigPath,
  resolveDirectoryPaths,
  resolveHealthPath,
} from './paths.js';

/** Whether the path names a TypeScript module that must be compiled first. */
function isTypeScriptConfig(path: string): boolean {
  return /\.(?:ts|mts|cts)$/.test(path);
}

/**
 * Load the config module and resolve it. TypeScript paths are rejected before
 * import (compile first). Import failures surface as a generic error: the
 * module's own exception text may embed secrets and is never re-thrown or
 * attached as a cause.
 */
export async function loadAppConfig(
  configPath?: string,
  options: AppConfigLoadOptions = {},
): Promise<ResolvedAppConfig> {
  const cwd = options.cwd ?? process.cwd();
  const requested = configPath ?? DEFAULT_APP_CONFIG_PATH;
  const absolute = resolveConfigPath(cwd, configPath);
  if (isTypeScriptConfig(absolute)) {
    throw new AppConfigError(
      `app config "${requested}" is a TypeScript module; compile it to JavaScript first ` +
        `(e.g. tsc) and point the loader at the compiled output`,
    );
  }
  let module: unknown;
  try {
    module = await import(pathToFileURL(absolute).href);
  } catch {
    throw new AppConfigError(`failed to load app config "${requested}"`);
  }
  const defaultExport = (module as { default?: unknown }).default;
  return validateAppConfig(defaultExport, { configPath: absolute, cwd });
}

/**
 * Validate a programmatic config object and resolve it. No module execution and
 * no callback invocation: directories are computed lexically and only
 * `rootDir`/`pages`/`api`/`public`/`out`/`shutdownTimeoutMs` values are read.
 * Existing paths are resolved through `realpath` solely to harden the public
 * directory isolation check; the resolved config keeps the lexical paths.
 *
 * This is the value-free read/validate boundary: the whole pass runs inside
 * {@link sanitizeAppConfigErrors}, so a property accessor (or any other step)
 * that throws an arbitrary exception surfaces as an {@link AppConfigError}
 * whose message never echoes the thrown value and whose `.cause` is never set.
 * Framework {@link AppConfigError}s are preserved verbatim.
 */
export function validateAppConfig(
  value: unknown,
  options: AppConfigValidationOptions = {},
): ResolvedAppConfig {
  return sanitizeAppConfigErrors(() => resolveAppConfig(value, options));
}

/**
 * Convert any non-{@link AppConfigError} thrown during validation into a
 * value-free {@link AppConfigError}. A framework error is re-thrown unchanged;
 * an arbitrary exception (for example a throwing property getter whose message
 * embeds a credential) is replaced without a cause.
 */
function sanitizeAppConfigErrors<T>(resolve: () => T): T {
  try {
    return resolve();
  } catch (error) {
    if (error instanceof AppConfigError) {
      throw error;
    }
    throw new AppConfigError('the app config could not be read');
  }
}

/** Resolve a validated config; callers go through {@link validateAppConfig}. */
function resolveAppConfig(value: unknown, options: AppConfigValidationOptions): ResolvedAppConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppConfigError('the app config must default-export an object');
  }
  const result = appConfigSchema.safeParse(value);
  if (!result.success) {
    throw new AppConfigError(result.error.issues.map(describeIssue).join('; '));
  }
  const config = result.data;

  const host = resolveHost(config.host);
  const publicOrigin =
    config.publicOrigin === undefined ? undefined : resolvePublicOrigin(config.publicOrigin);
  const authorize = requireFunction(config.authorize, 'authorize') as Authorize | undefined;
  const resolveSession = requireFunction(config.resolveSession, 'resolveSession') as
    ResolveSession | undefined;
  const setup = requireFunction(config.setup, 'setup') as AppSetup | undefined;
  const broadcast = config.broadcast === undefined ? undefined : resolveBroadcast(config.broadcast);
  const extensions = resolveExtensions(config.extensions);
  const commands = resolveCommands(config.commands, extensions);
  const renderer = resolveRenderer(config.renderer);
  const deployments = resolveDeployments(config.deployments);
  const plugins = resolvePlugins((value as { plugins?: unknown }).plugins);
  const introspect = resolveIntrospect((value as { introspect?: IntrospectConfig }).introspect);
  const middleware = resolveMiddleware(config.middleware);
  const globalMiddleware = resolveGlobalMiddleware(config.globalMiddleware);

  const cwd = options.cwd ?? process.cwd();
  const configPath = resolveConfigPath(cwd, options.configPath);
  const configDir = dirname(configPath);
  const { rootDir, pagesDir, apiDir, publicDir, outDir, storageDir } = resolveDirectoryPaths({
    configDir,
    rootDir: config.rootDir,
    pages: config.pages,
    api: config.api,
    public: config.public,
    out: config.out,
    storage: config.storage,
  });
  const healthPath = resolveHealthPath(config.healthPath);

  assertPublicDirIsolation({
    configPath,
    rootDir,
    pagesDir,
    apiDir,
    publicDir,
    outDir,
  });
  assertStorageIsolation({
    configPath,
    rootDir,
    publicDir,
    outDir,
    storageDir,
  });

  return {
    configPath,
    rootDir,
    pagesDir,
    apiDir,
    publicDir,
    outDir,
    storageDir,
    host,
    port: config.port ?? DEFAULT_APP_PORT,
    publicOrigin,
    healthPath,
    authorize,
    resolveSession,
    maxBodyBytes: config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    shutdownTimeoutMs: config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    broadcast,
    setup,
    commands,
    extensions,
    renderer,
    deployments,
    plugins,
    introspect,
    middleware,
    globalMiddleware,
  };
}

/** Map a Zod issue to a value-free message, naming the field but not its value. */
function describeIssue(issue: z.ZodIssue): string {
  if (issue.code === 'unrecognized_keys') {
    return 'unrecognized config field';
  }
  const path = issue.path as readonly (string | number)[];
  const field = path.length > 0 ? `config.${path.join('.')}` : 'the app config';
  switch (issue.code) {
    case 'invalid_type':
      return `${field} has an invalid type`;
    case 'too_small':
      return `${field} is below the minimum`;
    case 'too_big':
      return `${field} is above the maximum`;
    default:
      return `${field} is invalid`;
  }
}

/** Validate a host string: no whitespace or path separators, non-empty. */
function resolveHost(value: string | undefined): string {
  if (value === undefined) return DEFAULT_APP_HOST;
  if (value === '' || /\s/.test(value) || value.includes('/')) {
    throw new AppConfigError('config.host must be a non-empty host without whitespace or a path');
  }
  return value;
}

/**
 * Validate the optional public origin: an `http(s)` ORIGIN only. Credentials,
 * any path beyond `/`, and query/fragment are rejected. The canonical origin is
 * returned; the input value is never included in an error.
 */
function resolvePublicOrigin(value: string): string {
  if (value === '') {
    throw new AppConfigError('config.publicOrigin must be a non-empty http(s) origin');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppConfigError('config.publicOrigin must be a valid http(s) origin');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppConfigError('config.publicOrigin must use the http or https scheme');
  }
  if (url.username !== '' || url.password !== '') {
    throw new AppConfigError('config.publicOrigin must not contain credentials');
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new AppConfigError(
      'config.publicOrigin must be an origin only (no path, query, or fragment)',
    );
  }
  return url.origin;
}

/** Return the callback unchanged, or throw when a provided value is not one. */
function requireFunction(value: unknown, name: string): unknown {
  if (value === undefined) return undefined;
  if (typeof value !== 'function') {
    throw new AppConfigError(`config.${name} must be a function`);
  }
  return value;
}

/**
 * Validate the broadcast config without mutating the input. Two forms are
 * accepted:
 *
 * - `{ adapter }` carries a {@link BroadcastAdapter} and is validated
 *   structurally only (non-empty name + `attach` function) and returned with
 *   the adapter preserved by identity; no Socket.IO origin/auth/Valkey fields
 *   are read, required, or validated.
 * - the built-in form ({@link AppBroadcastOptions}) maps the public `valkeyUrl`
 *   key onto the transport-level `redisUrl`. The URL is validated (never echoed)
 *   and there is no environment fallback. Function-typed fields are checked but
 *   never invoked.
 */
function resolveBroadcast(value: unknown): AttachBroadcastOptions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppConfigError('config.broadcast must be an object');
  }
  if ('adapter' in value) {
    return resolveBroadcastAdapter(value);
  }
  return resolveBuiltinBroadcast(value as AppBroadcastOptions);
}

/**
 * Validate the custom `{ adapter }` form structurally and return it with the
 * adapter preserved by identity. The adapter's own `attach` is never invoked
 * here; its origin/auth/channel/validation responsibilities are its own.
 */
function resolveBroadcastAdapter(value: { readonly adapter?: unknown }): {
  adapter: BroadcastAdapter;
} {
  const adapter = value.adapter;
  if (adapter === null || typeof adapter !== 'object') {
    throw new AppConfigError('config.broadcast.adapter must be a BroadcastAdapter');
  }
  const name: unknown = (adapter as { name?: unknown }).name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new AppConfigError('config.broadcast.adapter must declare a non-empty name');
  }
  if (typeof (adapter as { attach?: unknown }).attach !== 'function') {
    throw new AppConfigError('config.broadcast.adapter must declare an attach function');
  }
  return { adapter: adapter as BroadcastAdapter };
}

/**
 * Validate the built-in Socket.IO options without mutating the input, mapping
 * the public `valkeyUrl` key onto the transport-level `redisUrl`. The URL is
 * validated (never echoed) and there is no environment fallback.
 * Function-typed fields are checked; they are never invoked.
 */
function resolveBuiltinBroadcast(value: AppBroadcastOptions): BroadcastOptions {
  const raw = value;
  for (const name of ['authenticate', 'authorizeChannel', 'onError'] as const) {
    const field = raw[name];
    if (field !== undefined && typeof field !== 'function') {
      throw new AppConfigError(`config.broadcast.${name} must be a function`);
    }
  }
  const redisUrl = raw.valkeyUrl;
  if (redisUrl !== undefined) {
    try {
      assertRedisUrl(redisUrl);
    } catch {
      throw new AppConfigError('config.broadcast.valkeyUrl must be a redis:// or rediss:// URL');
    }
  }
  // Drop the legacy `redisUrl` config key so it never reaches the transport
  // options: the public key is `valkeyUrl`, mapped to `redisUrl` below.
  const {
    valkeyUrl: _valkeyUrl,
    redisUrl: _legacyRedisUrl,
    ...rest
  } = raw as AppBroadcastOptions & { redisUrl?: string };
  if (redisUrl === undefined) {
    return { ...rest };
  }
  return { ...rest, redisUrl };
}

/**
 * Map a shared extension-entry validation error to a value-free message. The
 * messages keep the canonical `config.extensions` prefix and never echo an
 * entry's name.
 */
function describeConfigExtensionError(error: ExtensionEntryError): string {
  switch (error.code) {
    case 'not_object':
      return 'config.extensions entries must be extension objects';
    case 'missing_name':
      return 'config.extensions entries must have a non-empty name';
    case 'invalid_priority':
      return 'config.extensions entries must have a finite number priority';
    case 'invalid_disabled':
      return 'config.extensions entries must have a boolean disabled flag';
    case 'duplicate_name':
      return 'config.extensions contains duplicate names';
    case 'missing_setup':
      return 'config.extensions entries must define a setup function';
    case 'requires_not_array':
      return 'config.extensions requires must be an array of service or contract tokens';
    case 'invalid_token':
      return 'config.extensions requires an invalid service token';
    case 'provides_not_array':
      return 'config.extensions provides must be an array of contract token providers';
    case 'invalid_provides_entry':
      return 'config.extensions provides entry must have a contract token';
    case 'invalid_provides_override':
      return 'config.extensions provides entry override must be a boolean';
    case 'invalid_requires_union':
      return 'config.extensions requires an invalid token';
  }
}

/**
 * Validate extensions structurally without cloning them, then return the same
 * list instance. Names must be non-empty and unique, `setup` must be a
 * function, priorities/disabled flags must be well-shaped, and every `requires`
 * entry must be a token-shaped object. Nothing is invoked and no extension
 * value is echoed in an error. The structural check is shared with the
 * extension runner via `validateExtensionEntries`.
 */
function resolveExtensions(value: unknown): readonly JsailsExtension[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AppConfigError('config.extensions must be an array');
  }
  const error = validateExtensionEntries(value);
  if (error !== undefined) {
    throw new AppConfigError(describeConfigExtensionError(error));
  }
  return value as readonly JsailsExtension[];
}

/**
 * Validate CLI commands from the app and its extensions using the pure command
 * collector and registry, then return the app-level list by identity.
 *
 * Collection and registry validation are synchronous and side-effect free: they
 * read command metadata (`name`, `summary`, `usage`, `run`) exactly once and
 * never invoke a handler. The registry applies one namespace across both
 * sources, so a bad shape, an invalid name, a reserved builtin, or a duplicate
 * shared between the app and an extension is rejected here. A
 * {@link CliCommandError} is remapped to a value-free {@link AppConfigError};
 * extension commands stay on their extension, so the returned list is
 * app-level only and `collectConfigCommands(resolved)` never double-counts.
 */
function resolveCommands(
  appCommands: unknown,
  extensions: readonly JsailsExtension[],
): readonly CliCommand[] {
  try {
    createCliCommandRegistry(collectConfigCommands({ commands: appCommands, extensions }));
  } catch (error) {
    throw new AppConfigError(describeCommandError(error));
  }
  return appCommands === undefined ? [] : (appCommands as readonly CliCommand[]);
}

/** Map a command validation failure to a value-free app-config message. */
function describeCommandError(error: unknown): string {
  if (!(error instanceof CliCommandError)) {
    return 'config.commands is invalid';
  }
  switch (error.code) {
    case 'duplicate_name':
      return 'config.commands contains duplicate command names';
    case 'reserved_name':
      return 'config.commands contains a reserved command name';
    case 'invalid_name':
      return 'config.commands contains an invalid command name';
    case 'invalid_command':
      return 'config.commands contains an invalid command';
    default:
      return 'config.commands is invalid';
  }
}

/**
 * Validate that a renderer exposes a `render` function and return the same
 * object by identity. The function is never invoked, and no method is rebound
 * or copied, so a class renderer keeps its own `this` and instance state.
 */
function resolveRenderer(value: unknown): PageRenderer | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    throw new AppConfigError('config.renderer must be a renderer object');
  }
  if (typeof (value as { render?: unknown }).render !== 'function') {
    throw new AppConfigError('config.renderer must define a render function');
  }
  return value as PageRenderer;
}

/**
 * Resolve the plugin settings without mutating the input. The shape is already
 * validated by the strict nested schema, so this only applies the `enabled`
 * default and preserves identity: absent stays `undefined`, and a provided
 * object is returned by reference (never copied or frozen) with `enabled`
 * defaulted to an empty list when omitted. `downloads` and `managed` are
 * carried through verbatim (neither has a materialized default here; an unset
 * `managed` means non-managed, the default).
 */
function resolvePlugins(value: unknown): AppPluginsConfig | undefined {
  if (value === undefined) return undefined;
  const plugins = value as AppPluginsConfig;
  return plugins.enabled === undefined ? { ...plugins, enabled: [] } : plugins;
}

/**
 * Resolve the introspection config with safe defaults. The shape is already
 * validated by the strict nested schema; this layer applies policy:
 *
 * - absent → `undefined` (route never registered);
 * - `enabled !== true` → `undefined` (fail closed);
 * - `enabled === true` and no `authorize` → `AppConfigError` (the endpoint must
 *   be default-deny, and the loader rejects an insecure default);
 * - `sections` defaults to the safe subset `['routes', 'plugins', 'components',
 *   'health']`.
 */
function resolveIntrospect(
  value: IntrospectConfig | undefined,
): ResolvedIntrospectConfig | undefined {
  if (value === undefined) return undefined;
  if (value.enabled !== true) return undefined; // fail closed
  if (typeof value.authorize !== 'function') {
    throw new AppConfigError(
      'config.introspect.authorize is required when introspection is enabled',
    );
  }
  const sections = value.sections ?? SAFE_INTROSPECT_SECTIONS;
  return {
    enabled: true,
    authorize: value.authorize,
    sections,
  };
}

/** The safe subset of sections available by default when `sections` is omitted. */
const SAFE_INTROSPECT_SECTIONS: readonly IntrospectSection[] = [
  'routes',
  'plugins',
  'components',
  'health',
] as const;

/**
 * Validate the custom deployment generators without cloning them, then return
 * the same list instance. Names must be non-empty and unique and `generate`
 * must be a function; the name is never echoed in an error and `generate` is
 * never invoked. The generator-id name pattern (lower-case, no whitespace) is
 * enforced later by the deploy-generator registry, not here, so an out-of-band
 * caller can keep a generator with any non-empty name and only fail when the
 * registry actually registers it.
 */
function resolveDeployments(value: unknown): readonly DeploymentGenerator[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AppConfigError('config.deployments must be an array');
  }
  const names = new Set<string>();
  for (const generator of value) {
    if (generator === null || typeof generator !== 'object' || Array.isArray(generator)) {
      throw new AppConfigError('config.deployments entries must be deployment generator objects');
    }
    const name: unknown = (generator as { name?: unknown }).name;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new AppConfigError('config.deployments entries must have a non-empty name');
    }
    if (names.has(name)) {
      throw new AppConfigError('config.deployments contains duplicate names');
    }
    names.add(name);
    if (typeof (generator as { generate?: unknown }).generate !== 'function') {
      throw new AppConfigError('config.deployments entries must define a generate function');
    }
  }
  return value as readonly DeploymentGenerator[];
}

/**
 * Validate the named middleware registry without mutating the input. Every value
 * must be a function and every key must be non-empty. Absent resolves to
 * `undefined` (no middleware registered). A valid map is returned by identity so
 * the registry can be pre-built and passed through unchanged.
 *
 * Names and handler values are never echoed in errors — the caller's own
 * middleware key-names may embed sensitive identifiers, and the handler
 * functions may carry closures with secrets.
 */
function resolveMiddleware(value: unknown): Readonly<Record<string, RouteMiddleware>> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppConfigError('config.middleware must be a plain object');
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new AppConfigError('config.middleware must be a plain object');
  }
  for (const [key, handler] of Object.entries(value as Record<string, unknown>)) {
    // Names are validated (never echoed) before handlers so a bad name from an
    // otherwise-valid handler still fails value-free.
    if (key.length === 0) {
      throw new AppConfigError('config.middleware entries must have non-empty names');
    }
    if (typeof handler !== 'function') {
      throw new AppConfigError('config.middleware entries must be functions');
    }
  }
  return value as Readonly<Record<string, RouteMiddleware>>;
}

/**
 * Validate the global middleware array without mutating the input. Every entry
 * must be a function ({@link RouteMiddleware}) or a non-empty string (a name
 * registered in {@link middleware}). Absent resolves to `undefined` (no global
 * chain). A valid array is returned by identity.
 *
 * Entry values are never echoed in errors; the string names may reference
 * middleware registered under sensitive identifiers, and inline functions may
 * carry closures with secrets.
 */
function resolveGlobalMiddleware(value: unknown): readonly RouteMiddlewareRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AppConfigError('config.globalMiddleware must be an array');
  }
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] as unknown;
    if (typeof entry !== 'function' && typeof entry !== 'string') {
      throw new AppConfigError('config.globalMiddleware entries must be functions or strings');
    }
    // Reject empty strings at load time so resolution never has to check again.
    if (typeof entry === 'string' && entry.length === 0) {
      throw new AppConfigError('config.globalMiddleware entries must be non-empty strings');
    }
  }
  return value as readonly RouteMiddlewareRef[];
}
