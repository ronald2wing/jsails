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
 * CLI commands (`config.commands` and each extension's `commands`) are
 * validated structurally through the pure CLI command collector and registry,
 * so bad names, reserved builtins, and duplicates across the app and its
 * extensions are rejected early as {@link AppConfigError}s. Only app-level
 * commands are surfaced on {@link ResolvedAppConfig.commands}; extension
 * commands stay on their extension so
 * `collectConfigCommands(resolved)` sees each exactly once.
 *
 * Errors are always `AppConfigError`s with value-free messages: invalid input
 * values, credentials embedded in a URL, and arbitrary exceptions thrown by the
 * imported module are never echoed, and `.cause` is never populated.
 */

import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import type {
  AttachBroadcastOptions,
  BroadcastAdapter,
  BroadcastOptions,
} from '../broadcast/server.js';
import {
  CliCommandError,
  collectConfigCommands,
  createCliCommandRegistry,
  type CliCommand,
} from '../cli/commands.js';
import type { PageRenderer } from '../contracts/render.js';
import type { DeploymentGenerator } from '../deploy/registry.js';
import type { JsailsExtension } from '../extensions/extension.js';
import { assertRedisUrl } from '../jobs/runtime-config.js';
import { DEFAULT_MAX_BODY_BYTES, type Authorize, type ResolveSession } from '../server/app.js';

/** Default config module name, resolved against the working directory. */
export const DEFAULT_APP_CONFIG_PATH = 'jsails.app.js';
/** Default listen host. */
export const DEFAULT_APP_HOST = '127.0.0.1';
/** Default listen port. `0` is a valid, explicitly requested ephemeral port. */
export const DEFAULT_APP_PORT = 3000;
/** Default pages directory, relative to `rootDir`. */
export const DEFAULT_APP_PAGES_DIR = 'pages';
/** Default API directory, relative to `rootDir`. */
export const DEFAULT_APP_API_DIR = 'api';
/** Default static-assets directory, relative to `rootDir`. */
export const DEFAULT_APP_PUBLIC_DIR = 'public';
/** Default build output directory, relative to `rootDir`. */
export const DEFAULT_APP_OUT_DIR = 'out';
/** Default persistent-storage directory, relative to `rootDir`. */
export const DEFAULT_APP_STORAGE_DIR = 'storage';
/** Default health endpoint path. */
export const DEFAULT_HEALTH_PATH = '/up';
/** Default shutdown grace period in milliseconds before lingering sockets are dropped. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
/** Upper bound on the shutdown grace period in milliseconds. */
export const MAX_SHUTDOWN_TIMEOUT_MS = 300_000;

/** Raised for any invalid application config. Messages never embed input. */
export class AppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppConfigError';
  }
}

/** Cleanup callback a `setup` callback may return. */
export type AppCleanup = () => void | Promise<void>;

/**
 * Startup hook returned to the runtime, never invoked by the loader. It may do
 * its work synchronously, return a cleanup callback, or return a promise of
 * either.
 */
export type AppSetup = () => void | AppCleanup | Promise<void | AppCleanup>;

/**
 * Broadcast options accepted in the app config: every {@link BroadcastOptions}
 * field plus the preferred `valkeyUrl` alias of `redisUrl`. The alias is mapped
 * to `redisUrl` in the resolved config; there is no environment fallback.
 */
export interface AppBroadcastOptions extends BroadcastOptions {
  /** Preferred alias of `redisUrl`; when both are set `valkeyUrl` wins. */
  valkeyUrl?: string;
}

/**
 * The broadcast configuration accepted in the app config: either the built-in
 * Socket.IO options ({@link AppBroadcastOptions}, which add the `valkeyUrl`
 * alias) or a custom {@link BroadcastAdapter} under `adapter`. The custom form
 * carries no Socket.IO origin/auth/Valkey fields — the adapter is validated
 * structurally (non-empty name + `attach` function) and passed through by
 * identity, and owns its own authentication, channel authorization, and
 * serialization.
 */
export type AppBroadcastConfig = AppBroadcastOptions | { readonly adapter: BroadcastAdapter };

/**
 * The shape an application config module default-exports. Every field is
 * optional; defaults are applied during resolution.
 */
export interface JsailsAppConfig {
  /** Project root. Defaults to `.` (the config file's directory). */
  readonly rootDir?: string;
  /** Pages directory, relative to `rootDir`. Defaults to `pages`. */
  readonly pages?: string;
  /** API directory, relative to `rootDir`. Defaults to `api`. */
  readonly api?: string;
  /** Static-assets directory, relative to `rootDir`. Defaults to `public`. */
  readonly public?: string;
  /** Build output directory, relative to `rootDir`. Defaults to `out`. */
  readonly out?: string;
  /**
   * Persistent-storage directory, relative to `rootDir`. Defaults to `storage`.
   * Created by `Application.serve` before listening; never created by build or
   * fetch. Must not equal the project root, contain the config module, or
   * overlap the public/out directories.
   */
  readonly storage?: string;
  /** Listen host. Defaults to `127.0.0.1`. */
  readonly host?: string;
  /** Listen port in `0..65535`. Defaults to `3000`; `0` requests ephemeral. */
  readonly port?: number;
  /** Canonical public `http(s)` origin. Validated but never requested. */
  readonly publicOrigin?: string;
  /**
   * Health endpoint path, or `false` to disable. Defaults to
   * {@link DEFAULT_HEALTH_PATH}. Served for both GET and HEAD as a plain-text
   * `200` with `Cache-Control: no-store`, independent of the default-deny API
   * pipeline. Collision with a discovered page/API route is rejected when the
   * application is assembled.
   */
  readonly healthPath?: string | false;
  /** Global API authorization callback, passed through untouched. */
  readonly authorize?: Authorize;
  /** Session resolver callback, passed through untouched. */
  readonly resolveSession?: ResolveSession;
  /** Request-body cap in bytes. Defaults to {@link DEFAULT_MAX_BODY_BYTES}. */
  readonly maxBodyBytes?: number;
  /**
   * Shutdown grace period in milliseconds. Bounds how long `Application.close`
   * waits for the HTTP/broadcast transport to stop before it destroys lingering
   * sockets owned by the created server. Defaults to
   * {@link DEFAULT_SHUTDOWN_TIMEOUT_MS}; bounded by {@link MAX_SHUTDOWN_TIMEOUT_MS}.
   */
  readonly shutdownTimeoutMs?: number;
  /** Broadcast config: built-in Socket.IO options or a custom adapter. */
  readonly broadcast?: AppBroadcastConfig;
  /** Startup hook, passed through untouched and never invoked here. */
  readonly setup?: AppSetup;
  /**
   * Application-level CLI commands. Validated structurally (name, summary,
   * `run`) through the pure command registry and passed through by identity;
   * `run` is never invoked here. Extension-declared commands stay on their
   * extension so the two sources are never double-counted.
   */
  readonly commands?: readonly CliCommand[];
  /**
   * Extensions applied in declaration order. Validated structurally and passed
   * through by identity; their `setup` callbacks are never invoked here.
   */
  readonly extensions?: readonly JsailsExtension[];
  /**
   * Page renderer. Validated for a `render` function and passed through by
   * identity; its `render` is never invoked here.
   */
  readonly renderer?: PageRenderer;
  /**
   * Custom deployment generators exposed to the `jamal` deployment command.
   * Validated structurally (non-empty unique name, `generate` function) and
   * passed through by identity; `generate` is never invoked here. `jamal`
   * merges these after the built-in generators and rejects a name that
   * collides with a built-in generator id.
   */
  readonly deployments?: readonly DeploymentGenerator[];
}

/** A validated config with absolute directories and resolved defaults. */
export interface ResolvedAppConfig {
  /** Absolute path of the config module used as the resolution anchor. */
  readonly configPath: string;
  /** Absolute project root. */
  readonly rootDir: string;
  /** Absolute pages directory. */
  readonly pagesDir: string;
  /** Absolute API directory. */
  readonly apiDir: string;
  /** Absolute static-assets directory. The folder need not exist yet. */
  readonly publicDir: string;
  /** Absolute build output directory. */
  readonly outDir: string;
  /** Absolute persistent-storage directory. The folder need not exist yet. */
  readonly storageDir: string;
  /** Listen host. */
  readonly host: string;
  /** Listen port; `0` is preserved as an ephemeral-port request. */
  readonly port: number;
  /** Canonical public origin, when configured. */
  readonly publicOrigin: string | undefined;
  /** Health endpoint path, or `undefined` when disabled. */
  readonly healthPath: string | undefined;
  /** The authorization callback, passed through and never invoked. */
  readonly authorize: Authorize | undefined;
  /** The session resolver, passed through and never invoked. */
  readonly resolveSession: ResolveSession | undefined;
  /** Request-body cap in bytes. */
  readonly maxBodyBytes: number;
  /** Shutdown grace period in milliseconds. */
  readonly shutdownTimeoutMs: number;
  /** Resolved broadcast config handed to `attachBroadcast`, when configured. */
  readonly broadcast: AttachBroadcastOptions | undefined;
  /** The setup hook, passed through and never invoked. */
  readonly setup: AppSetup | undefined;
  /**
   * Application-level CLI commands, passed through by identity and defaulted to
   * an empty list. Extension-declared commands are not flattened here; they stay
   * on {@link ResolvedAppConfig.extensions} so `collectConfigCommands` sees each
   * command exactly once.
   */
  readonly commands: readonly CliCommand[];
  /** Extensions in declaration order; the same list instance passed in. */
  readonly extensions: readonly JsailsExtension[];
  /** The page renderer, passed through by identity, when configured. */
  readonly renderer: PageRenderer | undefined;
  /** Custom deployment generators, passed through by identity (default empty). */
  readonly deployments: readonly DeploymentGenerator[];
}

/** Options for {@link loadAppConfig}. */
export interface AppConfigLoadOptions {
  /** Working directory a relative config path is resolved against. */
  readonly cwd?: string;
}

/** Options for {@link validateAppConfig}. */
export interface AppConfigValidationOptions {
  /** Config path anchoring `rootDir`; defaults to `<cwd>/jsails.app.js`. */
  readonly configPath?: string;
  /** Working directory a relative `configPath` is resolved against. */
  readonly cwd?: string;
}

/**
 * Top-level shape check. Unknown keys are rejected (`.strict()`); callbacks and
 * broadcast are opaque here and validated by hand so their error messages stay
 * value-free.
 */
const appConfigSchema = z
  .object({
    rootDir: z.string().min(1).optional(),
    pages: z.string().min(1).optional(),
    api: z.string().min(1).optional(),
    public: z.string().min(1).optional(),
    out: z.string().min(1).optional(),
    storage: z.string().min(1).optional(),
    host: z.string().optional(),
    port: z.number().int().min(0).max(65535).optional(),
    publicOrigin: z.string().optional(),
    healthPath: z.union([z.literal(false), z.string().min(1)]).optional(),
    authorize: z.unknown().optional(),
    resolveSession: z.unknown().optional(),
    maxBodyBytes: z.number().int().positive().optional(),
    shutdownTimeoutMs: z.number().int().positive().max(MAX_SHUTDOWN_TIMEOUT_MS).optional(),
    broadcast: z.unknown().optional(),
    setup: z.unknown().optional(),
    commands: z.unknown().optional(),
    extensions: z.unknown().optional(),
    renderer: z.unknown().optional(),
    deployments: z.unknown().optional(),
  })
  .strict();

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
  const absolute = resolve(cwd, requested);
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

  const cwd = options.cwd ?? process.cwd();
  const configPath = resolve(cwd, options.configPath ?? DEFAULT_APP_CONFIG_PATH);
  const configDir = dirname(configPath);
  const rootDir = resolve(configDir, config.rootDir ?? '.');
  const pagesDir = resolve(rootDir, config.pages ?? DEFAULT_APP_PAGES_DIR);
  const apiDir = resolve(rootDir, config.api ?? DEFAULT_APP_API_DIR);
  const publicDir = resolve(rootDir, config.public ?? DEFAULT_APP_PUBLIC_DIR);
  const outDir = resolve(rootDir, config.out ?? DEFAULT_APP_OUT_DIR);
  const storageDir = resolve(rootDir, config.storage ?? DEFAULT_APP_STORAGE_DIR);
  const healthPath = resolveHealthPath(config.healthPath);

  assertPublicDirIsolation({ configPath, rootDir, pagesDir, apiDir, publicDir, outDir });
  assertStorageIsolation({ configPath, rootDir, publicDir, outDir, storageDir });

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

/** The resolved directory paths whose containment is checked together. */
interface DirectoryLayout {
  readonly configPath: string;
  readonly rootDir: string;
  readonly pagesDir: string;
  readonly apiDir: string;
  readonly publicDir: string;
  readonly outDir: string;
}

/**
 * Reject a `publicDir` that could expose source, config, or compiled output.
 * The public directory must not contain (or equal) the project root, must not
 * overlap the pages/api/out directories in either direction, and must not
 * contain the config module itself.
 *
 * Paths that exist on disk are resolved through `realpath` so a symlinked
 * directory cannot smuggle an overlap past the lexical check; a missing path (a
 * public directory need not exist yet) falls back to its lexical form. This is
 * defense in depth: the runtime static-file middleware independently rejects a
 * symlinked public root and any symlinked segment it serves.
 */
function assertPublicDirIsolation(layout: DirectoryLayout): void {
  const rootDir = realOrLexical(layout.rootDir);
  const publicDir = realOrLexical(layout.publicDir);
  const configPath = realOrLexical(layout.configPath);

  if (isPathInside(publicDir, rootDir)) {
    throw new AppConfigError('config.public must not contain the project root');
  }
  const directories = [
    ['pages', layout.pagesDir],
    ['api', layout.apiDir],
    ['out', layout.outDir],
  ] as const;
  for (const [field, path] of directories) {
    const resolved = realOrLexical(path);
    if (isPathInside(publicDir, resolved) || isPathInside(resolved, publicDir)) {
      throw new AppConfigError(`config.public must not overlap the ${field} directory`);
    }
  }
  if (isPathInside(publicDir, configPath)) {
    throw new AppConfigError('the app config must not live inside the public directory');
  }
}

/** The resolved paths whose storage-directory containment is checked together. */
interface StorageLayout {
  readonly configPath: string;
  readonly rootDir: string;
  readonly publicDir: string;
  readonly outDir: string;
  readonly storageDir: string;
}

/**
 * Reject a `storageDir` that would expose or clobber build/source state. The
 * storage directory must not equal the project root, must not overlap the
 * public/out directories in either direction, and must not contain the config
 * module itself. Paths that exist on disk are resolved through `realpath` (the
 * same hardening as the public check) so a symlink cannot smuggle an overlap
 * past the lexical comparison.
 */
function assertStorageIsolation(layout: StorageLayout): void {
  const rootDir = realOrLexical(layout.rootDir);
  const storageDir = realOrLexical(layout.storageDir);
  const configPath = realOrLexical(layout.configPath);

  if (storageDir === rootDir) {
    throw new AppConfigError('config.storage must not equal the project root');
  }
  const directories = [
    ['public', layout.publicDir],
    ['out', layout.outDir],
  ] as const;
  for (const [field, path] of directories) {
    const resolved = realOrLexical(path);
    if (isPathInside(storageDir, resolved) || isPathInside(resolved, storageDir)) {
      throw new AppConfigError(`config.storage must not overlap the ${field} directory`);
    }
  }
  if (isPathInside(storageDir, configPath)) {
    throw new AppConfigError('the app config must not live inside the storage directory');
  }
}

/** Resolve an existing path to its real path, else return the lexical path. */
function realOrLexical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** True when `child` is `parent` or lives inside it. */
function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === '') return true;
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
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

/** Internal framework namespace reserved for broadcast and components. */
const RESERVED_INTERNAL_PREFIX = '/_jsails';

/**
 * Resolve the health endpoint path: `undefined` (default) yields
 * {@link DEFAULT_HEALTH_PATH}, `false` disables, and a string is shape-validated.
 * A path must start with `/`, may not end with `/` (except the root path `/`
 * itself), and must not contain a backslash, `?`, `#`, `:`, `[`, `]`, a doubled
 * `/`, or a control character, nor live under the reserved `/_jsails`
 * namespace. The input value is never echoed in an error.
 */
function resolveHealthPath(value: string | false | undefined): string | undefined {
  if (value === undefined) return DEFAULT_HEALTH_PATH;
  if (value === false) return undefined;
  const valid =
    value.startsWith('/') &&
    (value === '/' || !value.endsWith('/')) &&
    !/[\\?#:[\]]/.test(value) &&
    !value.includes('//') &&
    !/[\u0000-\u001f\u007f]/.test(value);
  if (!valid) {
    throw new AppConfigError('config.healthPath must be an absolute path without a trailing slash');
  }
  if (value === RESERVED_INTERNAL_PREFIX || value.startsWith(`${RESERVED_INTERNAL_PREFIX}/`)) {
    throw new AppConfigError('config.healthPath must not use the reserved /_jsails namespace');
  }
  return value;
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
 * - the built-in form ({@link AppBroadcastOptions}) maps the preferred
 *   `valkeyUrl` alias onto `redisUrl`. The URL is validated (never echoed) and
 *   there is no environment fallback. Function-typed fields are checked but
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
 * the preferred `valkeyUrl` alias onto `redisUrl`. The URL is validated (never
 * echoed) and there is no environment fallback. Function-typed fields are
 * checked; they are never invoked.
 */
function resolveBuiltinBroadcast(value: AppBroadcastOptions): BroadcastOptions {
  const raw = value;
  for (const name of ['authenticate', 'authorizeChannel', 'onError'] as const) {
    const field = raw[name];
    if (field !== undefined && typeof field !== 'function') {
      throw new AppConfigError(`config.broadcast.${name} must be a function`);
    }
  }
  const redisUrl = raw.valkeyUrl ?? raw.redisUrl;
  if (redisUrl !== undefined) {
    try {
      assertRedisUrl(redisUrl);
    } catch {
      throw new AppConfigError('config.broadcast.redisUrl must be a redis:// or rediss:// URL');
    }
  }
  const { valkeyUrl: _valkeyUrl, ...rest } = raw;
  if (redisUrl === undefined) {
    return { ...rest };
  }
  return { ...rest, redisUrl };
}

/**
 * Validate extensions structurally without cloning them, then return the same
 * list instance. Names must be non-empty and unique, `setup` must be a
 * function, and every `requires` entry must be a token-shaped object. Nothing
 * is invoked and no extension value is echoed in an error.
 */
function resolveExtensions(value: unknown): readonly JsailsExtension[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AppConfigError('config.extensions must be an array');
  }
  const names = new Set<string>();
  for (const extension of value) {
    if (extension === null || typeof extension !== 'object' || Array.isArray(extension)) {
      throw new AppConfigError('config.extensions entries must be extension objects');
    }
    const name: unknown = (extension as { name?: unknown }).name;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new AppConfigError('config.extensions entries must have a non-empty name');
    }
    if (names.has(name)) {
      throw new AppConfigError('config.extensions contains duplicate names');
    }
    names.add(name);
    if (typeof (extension as { setup?: unknown }).setup !== 'function') {
      throw new AppConfigError('config.extensions entries must define a setup function');
    }
    const requires: unknown = (extension as { requires?: unknown }).requires;
    if (requires !== undefined) {
      if (!Array.isArray(requires)) {
        throw new AppConfigError('config.extensions requires must be an array of service tokens');
      }
      for (const token of requires) {
        const tokenName: unknown =
          token !== null && typeof token === 'object'
            ? (token as { name?: unknown }).name
            : undefined;
        if (typeof tokenName !== 'string' || tokenName.trim() === '') {
          throw new AppConfigError('config.extensions requires an invalid service token');
        }
      }
    }
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
