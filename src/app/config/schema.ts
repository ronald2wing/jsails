/**
 * Config schema and type surface for the JSails application runtime.
 *
 * This module owns the shape contract only: the Zod schema that rejects unknown
 * keys and mistyped fields up front, the default constants and their bounds,
 * the value-free {@link AppConfigError}, and the option/resolved types that
 * {@link loadAppConfig}/{@link validateAppConfig} produce. Callbacks
 * (`authorize`/`resolveSession`/`setup`), `broadcast`, `commands`, `extensions`,
 * `renderer`, and `deployments` are marked opaque here and validated
 * by hand in `load.ts` so their error messages stay value-free.
 */

import { z } from 'zod';

import type {
  AttachBroadcastOptions,
  BroadcastAdapter,
  BroadcastOptions,
} from '../../broadcast/server.js';
import type { CliCommand } from '../../cli/command-registry.js';
import type { DeploymentGenerator } from '../../deploy/registry.js';
import type { JsailsExtension } from '../../extensions/extension.js';
import { PLUGIN_ID_PATTERN } from '../../plugins/manifest/index.js';
import type { PageRenderer } from '../../contracts/render.js';
import type { IntrospectSection } from '../../introspect/sections.js';
import type { RouteMiddleware, RouteMiddlewareRef } from '../../routing/middleware.js';
import type { Authorize, ResolveSession } from '../../contracts/http.js';
import type { PageMetadata } from '../../seo/metadata.js';
import type { RobotsOptions } from '../../seo/robots.js';

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

/** A single value-free config field error. */
export interface ConfigSchemaIssue {
  /** Location of the failure, e.g. `["port"]`. Never a raw value. */
  readonly path: readonly (string | number)[];
  /** Stable machine code, e.g. `"invalid_type"`, `"unrecognized_keys"`. */
  readonly code: string;
  /** Short description derived only from the schema, never from input. */
  readonly message: string;
}

/** Raised for any invalid application config. Messages never embed input. */
export class AppConfigError extends Error {
  /** Structured, value-free failures. Set only when the error originates from Zod validation. */
  readonly issues: readonly ConfigSchemaIssue[] | undefined;

  constructor(message: string, issues?: readonly ConfigSchemaIssue[]) {
    super(message);
    this.name = 'AppConfigError';
    this.issues = issues;
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
 * field except the transport-level `redisUrl` (the public config key is
 * `valkeyUrl`), which is mapped to `redisUrl` in the resolved config. There is
 * no environment fallback.
 */
export interface AppBroadcastOptions extends Omit<BroadcastOptions, 'redisUrl'> {
  /** Valkey/Redis URL for the multi-process pub/sub adapter. */
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
 * A plugin specifier, optionally paired with its options. A bare string names
 * the plugin; a `[specifier, options]` tuple also carries the options passed to
 * the plugin factory. The loader resolves the specifier (a framework subpath
 * like `jsails/auth`, or an npm package) and calls the factory.
 */
export type PluginUseEntry = string | readonly [string, Readonly<Record<string, unknown>>];

/**
 * Plugin system settings. `enabled` lists the plugin ids enabled out of the
 * box (each must match {@link PLUGIN_ID_PATTERN}); `use` lists plugins to load
 * as specifiers or `[specifier, options]` tuples; `downloads` gates whether
 * the admin Directory install surface may download plugin bundles; `managed`
 * switches plugin state persistence from the JSON document to the database.
 * Validated strictly (unknown keys rejected) with value-free errors; passed
 * through by identity.
 */
export interface AppPluginsConfig {
  /** Plugin ids enabled out of the box; each matches {@link PLUGIN_ID_PATTERN}. */
  readonly enabled?: readonly string[];
  /**
   * Plugins to load, as specifiers or `[specifier, options]` tuples. The loader
   * resolves each specifier and constructs the plugin. Absent means no
   * declaratively-loaded plugins.
   */
  readonly use?: readonly PluginUseEntry[];
  /** Whether admin Directory installs may download plugin bundles. */
  readonly downloads?: boolean;
  /**
   * Whether installed-plugin state is managed in the database (`jsails_plugins`
   * table). Defaults to `false`: a non-managed deployment reads only the code
   * plugin list and never opens the database for plugins. The static export is
   * always non-managed.
   */
  readonly managed?: boolean;
}

/**
 * Runtime introspection config: an opt-in, default-off, default-deny endpoint
 * exposing a machine-readable JSON snapshot of a running app's state. Absent
 * means the route is never registered.
 */
export interface IntrospectConfig {
  /** Whether the introspection endpoint is active. Defaults to `false` (off). */
  readonly enabled?: boolean;
  /**
   * Authorization callback required when `enabled` is `true`. Default-deny:
   * the request is allowed only when the callback resolves to exactly `true`;
   * any other value, a throw, or a rejection denies. There is no implicit
   * public default — the loader rejects `enabled: true` without `authorize`.
   */
  readonly authorize?: Authorize;
  /** Sections to make available. Defaults to the safe subset. */
  readonly sections?: readonly IntrospectSection[];
}

/** Resolved introspection config after validation and defaults are applied. */
export interface ResolvedIntrospectConfig {
  readonly enabled: true;
  readonly authorize: Authorize;
  readonly sections: readonly IntrospectSection[];
}

/**
 * SEO config: site-wide defaults applied to every page's metadata, plus the
 * build-time `robots.txt` directives. Absent means no SEO defaults and no
 * `robots.txt` emission.
 */
export interface SeoConfig {
  /** Site name, used to fill a missing `openGraph.siteName`. */
  readonly siteName?: string;
  /**
   * Canonical site origin (e.g. `https://example.com`). Used to resolve
   * relative canonical/alternate URLs and sitemap `loc` entries. Validated as
   * an absolute `http(s)` origin.
   */
  readonly origin?: string;
  /** Default metadata merged under every page's own metadata (page wins). */
  readonly defaults?: PageMetadata;
  /** Build-time `robots.txt` directives. */
  readonly robots?: RobotsOptions;
}

/** Resolved SEO config after validation. */
export interface ResolvedSeoConfig {
  readonly siteName: string | undefined;
  readonly origin: string | undefined;
  readonly defaults: PageMetadata | undefined;
  readonly robots: RobotsOptions | undefined;
}

/** Resolved i18n config after validation and path resolution. */
export interface ResolvedI18nConfig {
  readonly locale: string;
  readonly fallbackLocale: string;
  /** Supported locales for prefix routing; empty/absent disables it. */
  readonly locales?: readonly string[];
  /** The un-prefixed locale (defaults to `locale`). */
  readonly defaultLocale?: string;
  readonly catalogs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Absolute load paths resolved from the config's `loadPaths` entries. */
  readonly loadPaths?: readonly string[];
}

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
   * Deployment shape: which plugins run. `'full'` (default) includes live-only
   * plugins; `'static'` excludes plugins declared `runtime: 'live'` (the static
   * closure, derived from each plugin's `describe().runtime`); `'cli'` is
   * command/job-only. Sugar over `plugins.use` — the only thing a shape switch
   * changes; the file structure is identical across shapes.
   */
  readonly shape?: 'static' | 'full' | 'cli';
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
  /** Request-body cap in bytes. Defaults to the server body-limit default. */
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
  /**
   * Plugin system settings: which plugin ids are enabled out of the box and
   * whether the admin Directory install surface may download bundles. Validated
   * strictly (unknown keys rejected) with value-free errors and passed through
   * by identity. Absent means no plugins are enabled.
   */
  readonly plugins?: AppPluginsConfig;
  /**
   * Runtime introspection endpoint. Default-off, default-deny. When absent the
   * route is never registered. When `enabled: true` the loader requires an
   * `authorize` callback; `sections` defaults to the safe subset.
   */
  readonly introspect?: IntrospectConfig;
  /**
   * SEO defaults and build-time `robots.txt` directives. Absent means no SEO
   * defaults and no `robots.txt` emission. Validated by hand in load.ts so
   * errors stay value-free.
   */
  readonly seo?: SeoConfig;
  /**
   * Named middleware registry: handlers referenced by name from route-level
   * `middleware` exports. Every value must be a function and every key must be
   * non-empty. Validated by hand in load.ts so errors stay value-free.
   */
  readonly middleware?: Readonly<Record<string, RouteMiddleware>>;
  /**
   * Global middleware chain applied to every request before per-route handlers.
   * Each entry is either a handler function (passed through by identity) or a
   * string naming a handler registered in {@link middleware}. Validated by hand
   * in load.ts so errors stay value-free.
   */
  readonly globalMiddleware?: readonly RouteMiddlewareRef[];
  /**
   * Internationalization (i18n) config: locale defaults, fallback, and loader
   * paths. Validated by hand in load.ts so errors stay value-free.
   */
  readonly i18n?: I18nConfig;
}

/**
 * i18n config block: defines the default and fallback locales, plus either
 * inline catalogs or filesystem load paths (mutually exclusive).
 */
export interface I18nConfig {
  /** Default active locale. Defaults to `'en'`. */
  readonly locale?: string;
  /** Fallback locale. Defaults to `'en'`. */
  readonly fallbackLocale?: string;
  /**
   * Supported locales for locale-prefixed routing (`/fr/about`). When set, each
   * page/API route is additionally registered under `/{locale}/<route>` for
   * every locale here, and a leading locale segment sets the ambient locale.
   * `defaultLocale` (when set) matches the bare path too. Absent disables
   * prefix routing (URLs carry no locale).
   */
  readonly locales?: readonly string[];
  /**
   * The default locale, whose URLs stay un-prefixed. Defaults to `locale`.
   */
  readonly defaultLocale?: string;
  /**
   * Inline message catalogs keyed by locale. For tests and demos; mutually
   * exclusive with `loadPaths`.
   */
  readonly catalogs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * Filesystem load paths for locale message files. For production;
   * mutually exclusive with `catalogs`. Each path is relative to `rootDir`.
   */
  readonly loadPaths?: readonly string[];
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
  /** Deployment shape; defaults to `'full'` (read as `?? 'full'`). */
  readonly shape?: 'static' | 'full' | 'cli';
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
  /**
   * Plugin settings, passed through by identity. Absent when the config omitted
   * `plugins`; otherwise `enabled` defaults to `[]` (no plugins enabled) and
   * `downloads`/`managed` are `undefined` when unset (an unset `managed` means
   * non-managed, the default).
   */
  readonly plugins: AppPluginsConfig | undefined;
  /**
   * Introspection config, passed through by identity. Absent when the config
   * omitted `introspect` or when its `enabled` is not `true` (fail closed).
   */
  readonly introspect?: ResolvedIntrospectConfig;
  /**
   * Resolved SEO config. Absent when the config omitted `seo`. The
   * `siteName`/`origin`/`defaults` subset is what reaches every page request
   * context as `RequestContext.seo`; `robots` is consumed by the static
   * exporter only.
   */
  readonly seo?: ResolvedSeoConfig;
  /**
   * Named middleware registry, passed through by identity. Absent when the
   * config omitted `middleware`; every value is a function with a non-empty
   * key (validated during resolution).
   */
  readonly middleware?: Readonly<Record<string, RouteMiddleware>>;
  /**
   * Global middleware chain, passed through by identity. Absent when the config
   * omitted `globalMiddleware`; every entry is a function or a non-empty
   * string (validated during resolution).
   */
  readonly globalMiddleware?: readonly RouteMiddlewareRef[];
  /**
   * Resolved i18n config. Absent when the config omitted `i18n`.
   */
  readonly i18n?: ResolvedI18nConfig;
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
export const appConfigSchema = z
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
    shape: z.enum(['static', 'full', 'cli']).optional(),
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
    introspect: z
      .object({
        enabled: z.boolean().optional(),
        authorize: z.unknown().optional(),
        sections: z
          .array(
            z.enum([
              'routes',
              'plugins',
              'components',
              'pipeline',
              'config',
              'diagnostics',
              'jobs',
              'i18n',
              'health',
            ]),
          )
          .optional(),
      })
      .strict()
      .optional(),
    plugins: z
      .object({
        enabled: z.array(z.string().regex(PLUGIN_ID_PATTERN)).optional(),
        // Each entry is a non-empty string specifier or a 2-element
        // [specifier, options] tuple. The second element of a tuple must be a
        // plain object (z.record rejects arrays and null). Extra tuple elements
        // and wrong arity are rejected by the tuple constraint.
        use: z
          .array(
            z.union([
              z.string().min(1),
              z.tuple([z.string().min(1), z.record(z.string(), z.unknown())]),
            ]),
          )
          .optional(),
        downloads: z.boolean().optional(),
        managed: z.boolean().optional(),
      })
      .strict()
      .optional(),
    middleware: z.unknown().optional(),
    globalMiddleware: z.unknown().optional(),
    seo: z
      .object({
        siteName: z.string().min(1).optional(),
        origin: z.string().min(1).optional(),
        defaults: z.unknown().optional(),
        robots: z.unknown().optional(),
      })
      .strict()
      .optional(),
    i18n: z
      .object({
        locale: z.string().min(1).optional(),
        fallbackLocale: z.string().min(1).optional(),
        catalogs: z.unknown().optional(),
        loadPaths: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
