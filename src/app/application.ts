/**
 * Application runtime assembly.
 *
 * `createApplication` turns a {@link ResolvedAppConfig} into a runnable
 * {@link Application}. It is deliberately inert about infrastructure: it never
 * initializes a database or a Valkey connection itself. Extensions own their
 * services, and route discovery happens during extension setup (the `routing`
 * plugin discovers routes and publishes the manifest under
 * {@link routeManifestToken}), so the manifest is resolved from the registry
 * after extensions run:
 *
 * 1. {@link resolvePluginUse} resolves declarative `plugins.use` entries into
 *    constructed {@link JsailsPlugin} objects, throwing a value-free
 *    {@link AppConfigError} when any entry fails to load. The routing plugin is
 *    auto-injected first so every app — even one using only `config.extensions`
 *    — gets filesystem route discovery. The `pages` plugin is auto-injected
 *    second so every app gets the built-in Preact page renderer (under
 *    {@link pageRendererToken}) and static-site generator (under
 *    {@link staticSiteToken}); `config.renderer` overrides the default. The
 *    resolved plugins are merged with `config.extensions` (`use` plugins last,
 *    then hand-written extensions) before {@link runExtensions} runs every
 *    extension's `setup` in declaration order against a fresh service registry,
 *    collecting HTTP hooks and serve hooks. The routing plugin's `setup` calls
 *    {@link discoverRoutes} and publishes the manifest, so any later extension
 *    can consume it through {@link routeManifestToken}. Developer plugins always
 *    run in full — `config.plugins.enabled` is a marketplace/managed-only gate
 *    for plugins installed through the admin Directory, not a developer filter
 *    at boot time.
 * 2. After extensions run, the route manifest, the default page renderer, and
 *    the static-site generator are resolved from the service registry. The
 *    health-route collision check runs against the manifest. If the routing or
 *    pages plugin did not provide its service the assembly fails with a
 *    value-free {@link AppConfigError}.
 * 3. The app's own `setup` hook runs last; if it throws, the extensions that
 *    already opened are closed again before the error propagates.
 *
 * {@link Application.build} renders the static site through the resolved
 * static-site generator (the configured renderer or the default Preact renderer
 * from the `pages` plugin, plus the extension services) and never listens on a
 * port.
 * {@link Application.serve} assembles the Hono app, mounts the public-files
 * middleware, creates one HTTP server, runs each collected serve hook (e.g. the
 * broadcast plugin's) against that server, optionally attaches broadcast to the
 * same server, and then listens.
 *
 * {@link Application.fetch} routes a single {@link Request} through the same
 * assembled Hono pipeline without ever constructing an HTTP server, listening,
 * or attaching broadcast. The pipeline (`createApp` plus the public-files
 * middleware, including every `configureHttp` hook) is assembled lazily and
 * memoized once, so `fetch` and `serve` share one app and the hooks run exactly
 * once per successful assembly. A failed assembly is forgotten so a later
 * request retries it from scratch. `fetch` calls are independent: they run
 * concurrently like a real server rather than behind the build/serve lock, and
 * a `fetch` after `serve` reuses the already-assembled app with no extra hooks.
 *
 * `close()` tears down in reverse: HTTP/broadcast first, then the app cleanup,
 * then the extensions; every step is attempted even when earlier ones fail, and
 * `close()` is idempotent and safe for concurrent callers. Before running the
 * teardown it waits for any in-flight `fetch` handler to return its `Response`,
 * so a running handler never races the extension cleanups. Only handler
 * completion is drained — the returned `Response`'s body may still be streaming
 * and is the caller's to consume; there is no full network-drain guarantee.
 *
 * Transport teardown is bounded by `config.shutdownTimeoutMs`: `broadcast.close`
 * and the HTTP close are each raced against that deadline, and a server that
 * will not stop — typically an upgraded socket that Socket.IO does not own — has
 * its tracked sockets destroyed so cleanup can proceed and a timeout error is
 * surfaced. Only sockets the created server accepted are touched. The app's own
 * cleanup callback and the extensions' cleanups are trusted and awaited without
 * a deadline: they may hang independently, and a synchronous infinite loop
 * cannot be bounded from here.
 */

import type { Server as NodeHttpServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import type { Socket } from 'node:net';

import type { Hono } from 'hono';

import type { Broadcast } from '../broadcast/server.js';
import { attachBroadcast } from '../broadcast/server.js';
import { AppConfigError } from './config/index.js';
import type { AppCleanup, PluginUseEntry, ResolvedAppConfig } from './config/index.js';
import { createAssetUrlResolver } from './asset-urls.js';
import { runExtensions } from '../extensions/extension.js';
import type { JsailsPlugin } from '../extensions/plugin-contract.js';
import type { ServiceRegistry, ServiceToken } from '../extensions/services.js';
import type { PageRenderer } from '../contracts/render.js';
import type {
  GenerateStaticSiteOptions,
  GenerateStaticSiteResult,
} from '../pages/static-site/index.js';
import { pagesPlugin, pageRendererToken, staticSiteToken } from '../pages/plugin.js';
import type { RouteManifest } from '../routing/routes.js';
import { routingPlugin, routeManifestToken } from '../routing/plugin.js';
import { createApp } from '../server/app.js';
import {
  createBuiltinIntrospectProviders,
  type IntrospectRouteConfig,
} from '../introspect/index.js';
import {
  migrationDataSourceToken,
  jobMetricsToken,
  failedJobStoreToken,
} from '../introspect/builtin-providers.js';
import { resolvePluginEnablement } from '../plugins/enablement.js';
import { resolvePluginUse } from '../plugins/use.js';
import { serverComponentsToken } from '../server-components/extension.js';
import type { ServerComponentsRuntime } from '../server-components/runtime.js';
import { diagnosticsToken, type Diagnostics } from '../diagnostics/plugin.js';
import { createMiddlewareRegistry, resolveMiddlewareRefs } from '../routing/middleware.js';
import { createHttpServer } from '../server/server-http.js';
import { createPublicFilesMiddleware } from './static-files.js';

/** A runnable application assembled from a {@link ResolvedAppConfig}. */
export interface Application {
  /** The resolved config this application was built from. */
  readonly config: ResolvedAppConfig;
  /** The discovered route manifest (pages and API routes). */
  readonly manifest: RouteManifest;
  /** Read-only services provided by the applied extensions. */
  readonly services: ServiceRegistry;
  /** Render the static site into `config.outDir`; never opens a port. */
  build(): Promise<GenerateStaticSiteResult>;
  /** Assemble and listen the HTTP server; attach broadcast when configured. */
  serve(): Promise<ServeHandle>;
  /**
   * Route one request through the shared Hono pipeline. No HTTP server is
   * constructed, nothing listens, and broadcast is never attached. Requests
   * are independent and may run concurrently. The returned `Response`'s body
   * is the caller's to consume; `close` does not drain streamed bodies.
   */
  fetch(request: Request): Promise<Response>;
  /** Stop HTTP/broadcast, then app cleanup, then reverse extensions. */
  close(): Promise<void>;
}

/** A listening HTTP server owned by {@link Application.serve}. */
export interface ServeHandle {
  /** The bound `node:http.Server`; may be shared with broadcast. */
  readonly server: NodeHttpServer;
  /** The actual bound port (resolved when `config.port` is `0`). */
  readonly port: number;
  /** The server's origin URL, e.g. `http://127.0.0.1:3000/`. */
  readonly url: string;
  /** Shut the whole application down; delegates to {@link Application.close}. */
  close(): Promise<void>;
}

/** One server and its optional attached broadcast, tracked for teardown. */
interface ServedEntry {
  readonly server: NodeHttpServer;
  readonly broadcast: Broadcast | undefined;
  /** Sockets the server accepted, so a stuck close can destroy only these. */
  readonly sockets: Set<Socket>;
}

/**
 * Assemble an {@link Application} from a resolved config. Route discovery and
 * extension setup run before any port is opened; the returned application owns
 * no connection until `serve()` (or an extension's own `setup`) creates one.
 */
export async function createApplication(config: ResolvedAppConfig): Promise<Application> {
  if (config === null || typeof config !== 'object') {
    throw new TypeError('createApplication requires a resolved app config');
  }

  // One shared asset-URL resolver for HTTP and static generation. It performs no
  // filesystem access until first used, so building it is inert.
  const assetUrl = createAssetUrlResolver(config.publicDir);

  // Resolve declarative `plugins.use` entries into constructed JsailsPlugin
  // objects. A use entry that fails to load is a fatal boot error: the
  // developer explicitly asked for it, so a missing or broken plugin is a
  // misconfiguration, not a warning.
  const usePlugins = await resolveUsePlugins(config.plugins?.use);

  // Merged extension list: default routing plugin first (auto-injected so every
  // app gets filesystem route discovery during extension setup), then the pages
  // plugin (auto-injected so every app has a default Preact page renderer and
  // static-site generator), then declarative plugins, then config.extensions.
  // Backward compatibility: an app using only `config.extensions` still gets
  // route discovery and page rendering without any config change.
  const extensions = [
    routingPlugin({
      rootDir: config.rootDir,
      pagesDir: config.pagesDir,
      apiDir: config.apiDir,
    }),
    pagesPlugin(),
    ...usePlugins,
    ...config.extensions,
  ];

  // Extension setup in declaration order, then the app's own setup hook.
  // Developer plugins (from `plugins.use` or `config.extensions`) always run
  // in full — `plugins.enabled` is a marketplace/managed-only gate that
  // controls plugins installed through the admin Directory, not a developer
  // filter at boot time.
  const extensionRuntime = await runExtensions(extensions);

  // The routing plugin discovers routes during its `setup` and publishes the
  // manifest under routeManifestToken. Every app requires routes, so a missing
  // manifest is a fatal boot error.
  let manifest: RouteManifest;
  try {
    manifest = extensionRuntime.services.get(routeManifestToken);
  } catch {
    throw new AppConfigError('route discovery did not provide a manifest');
  }

  // The pages plugin provides the default Preact renderer and static-site
  // generator during its `setup`. Every app requires page rendering, so a
  // missing service is a fatal boot error.
  let pageRenderer: PageRenderer;
  try {
    pageRenderer = extensionRuntime.services.get(pageRendererToken);
  } catch {
    throw new AppConfigError('pages plugin did not provide a page renderer');
  }
  let staticSiteFn: (options: GenerateStaticSiteOptions) => Promise<GenerateStaticSiteResult>;
  try {
    staticSiteFn = extensionRuntime.services.get(staticSiteToken);
  } catch {
    throw new AppConfigError('pages plugin did not provide a static site generator');
  }

  // The health endpoint is framework infrastructure registered ahead of the
  // filesystem routes, so it must not claim a route that already belongs to a
  // page or API module.
  assertNoHealthRouteCollision(manifest, config.healthPath);

  let appCleanup: AppCleanup | undefined;
  try {
    const setupResult = await config.setup?.();
    appCleanup = typeof setupResult === 'function' ? setupResult : undefined;
  } catch (error) {
    // The extensions are already open; close them before the error propagates.
    let closeError: unknown;
    try {
      await extensionRuntime.close();
    } catch (cleanupError) {
      closeError = cleanupError;
    }
    if (closeError === undefined) throw error;
    throw new AggregateError([error, closeError], 'application setup failed', { cause: error });
  }

  // Build the introspection route config lazily and memoize it. The built-in
  // providers capture the route manifest, plugin marketplace enablement
  // (resolved from the config's code list — `plugins.enabled` is a managed-only
  // gate for admin-installed plugins, never a developer filter), and the
  // live services from the extension registry. No external service is opened;
  // the config is computed once and reused for every assembly.
  //
  // The middleware-derived inputs are passed at the single call site inside
  // buildApp() because the registry and resolved global chain only exist there;
  // the values are static per application lifecycle so caching is sound.
  let introspectRouteConfig: IntrospectRouteConfig | undefined;
  const buildIntrospectRouteConfig = (
    middlewareNames: readonly string[],
    globalMiddlewareCount: number,
  ): IntrospectRouteConfig | undefined => {
    if (introspectRouteConfig !== undefined) return introspectRouteConfig;
    if (config.introspect === undefined) return undefined;
    const plugins = resolvePluginEnablement({
      codeEnabled: config.plugins?.enabled,
    });
    const componentsRuntime = resolveServerComponentsRuntime(extensionRuntime.services);
    const diagnosticsService = resolveDiagnosticsService(extensionRuntime.services);
    const dataSource = resolveService(extensionRuntime.services, migrationDataSourceToken);
    const jobMetrics = resolveService(extensionRuntime.services, jobMetricsToken);
    const failedJobStore = resolveService(extensionRuntime.services, failedJobStoreToken);
    const providers = createBuiltinIntrospectProviders({
      manifest,
      plugins,
      componentsRuntime,
      dataSource,
      diagnosticsService,
      jobMetrics,
      failedJobStore,
      middlewareNames,
      globalMiddlewareCount,
      // Redacted projection: booleans for callbacks and directory basenames
      // only, so introspection never leaks absolute paths, secrets, or
      // callback identities.
      appConfig: {
        host: config.host,
        port: config.port,
        ...(config.publicOrigin === undefined ? {} : { publicOrigin: config.publicOrigin }),
        ...(config.healthPath === undefined ? {} : { healthPath: config.healthPath }),
        maxBodyBytes: config.maxBodyBytes,
        shutdownTimeoutMs: config.shutdownTimeoutMs,
        dirs: {
          root: basename(config.rootDir) || '.',
          pages: basename(config.pagesDir),
          api: basename(config.apiDir),
          public: basename(config.publicDir),
          out: basename(config.outDir),
          storage: basename(config.storageDir),
        },
        hasAuthorize: config.authorize !== undefined,
        hasResolveSession: config.resolveSession !== undefined,
        hasSetup: config.setup !== undefined,
        hasRenderer: config.renderer !== undefined,
        hasBroadcast: config.broadcast !== undefined,
        commandCount: config.commands.length,
        extensionCount: config.extensions.length,
        deploymentCount: config.deployments.length,
        pluginEnabled: config.plugins?.enabled ?? [],
        middlewareNames,
        globalMiddlewareCount,
        introspectEnabled: config.introspect?.enabled === true,
      },
    });
    introspectRouteConfig = {
      enabled: config.introspect.enabled,
      authorize: config.introspect.authorize,
      sections: config.introspect.sections,
      providers,
    };
    return introspectRouteConfig;
  };

  const served: ServedEntry[] = [];
  let closed = false;
  let closing: Promise<void> | undefined;
  let opTail: Promise<void> = Promise.resolve();

  // The shared Hono pipeline (createApp + public middleware), assembled lazily
  // on the first fetch/serve and memoized for both. A failed assembly is
  // forgotten so a later request retries it from scratch.
  let assembledApp: Hono | undefined;
  let assemblingApp: Promise<Hono> | undefined;

  // In-flight `fetch` requests. `close` waits for these to return their
  // `Response` before tearing down extensions, so a running handler never races
  // the extension cleanups. Only handler completion is drained: a streamed body
  // is the caller's to consume and is never waited on here.
  let inflightFetches = 0;
  let fetchesDrained: Promise<void> = Promise.resolve();
  let resolveFetchesDrained: (() => void) | undefined;

  /** Serialize build/serve/close so they never interleave shared state. */
  const withLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = opTail.then(operation);
    opTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const assertOpen = (): void => {
    if (closed) throw new Error('application is closed');
  };

  /** Assemble (and memoize) the shared Hono pipeline once per application. */
  const assembleApp = (): Promise<Hono> => {
    if (assembledApp !== undefined) return Promise.resolve(assembledApp);
    if (assemblingApp === undefined) {
      assemblingApp = buildApp().then(
        (app) => {
          assembledApp = app;
          assemblingApp = undefined;
          return app;
        },
        (error: unknown) => {
          // A failed assembly produced nothing reusable: forget it so the next
          // request re-runs createApp and the HTTP hooks from scratch.
          assemblingApp = undefined;
          throw error;
        },
      );
    }
    return assemblingApp;
  };

  /** Run `createApp`, then mount the public-files middleware onto it. */
  async function buildApp(): Promise<Hono> {
    // Build the named middleware registry from the config map. The map is
    // validated by load.ts; createMiddlewareRegistry only rejects an empty-name
    // or non-function entry which are impossible after that validation, but the
    // describe callback keeps errors value-free.
    const middlewareRegistry = createMiddlewareRegistry(config.middleware ?? {}, (message) => {
      throw new Error(`middleware registry: ${message}`);
    });

    // Resolve config globalMiddleware refs (functions pass through by identity;
    // strings are resolved from the registry). Then append extension middleware
    // handlers in setup order, so the combined global chain is: config-defined
    // handlers first, then extension-defined handlers.
    const resolvedConfigGlobal = config.globalMiddleware
      ? resolveMiddlewareRefs(config.globalMiddleware, middlewareRegistry, (message) => {
          throw new Error(`global middleware: ${message}`);
        })
      : [];
    const globalMiddleware = [...resolvedConfigGlobal, ...extensionRuntime.middleware];

    const app = await createApp({
      manifest,
      authorize: config.authorize,
      resolveSession: config.resolveSession,
      renderer: config.renderer ?? pageRenderer,
      services: extensionRuntime.services,
      httpHooks: extensionRuntime.httpHooks,
      maxBodyBytes: config.maxBodyBytes,
      publicOrigin: config.publicOrigin,
      assetUrl,
      healthPath: config.healthPath,
      storagePath: config.storageDir,
      introspect: buildIntrospectRouteConfig(middlewareRegistry.names(), globalMiddleware.length),
      globalMiddleware,
      middlewareRegistry,
    });

    const publicMiddleware = await createPublicFilesMiddleware(config.publicDir);
    if (publicMiddleware !== undefined) {
      app.use('*', publicMiddleware);
    }

    return app;
  }

  const build = (): Promise<GenerateStaticSiteResult> =>
    withLock(async () => {
      assertOpen();
      return staticSiteFn({
        manifest,
        outDir: config.outDir,
        publicDir: config.publicDir,
        baseUrl: config.publicOrigin,
        renderer: config.renderer ?? pageRenderer,
        services: extensionRuntime.services,
        assetUrl,
        storagePath: config.storageDir,
      });
    });

  const serve = (): Promise<ServeHandle> =>
    withLock(async () => {
      assertOpen();
      return startServing();
    });

  /**
   * Route one request through the shared Hono pipeline. No HTTP server is
   * constructed, nothing listens, and broadcast is never attached. Requests are
   * independent and may run concurrently; `close` waits only for a handler to
   * return its `Response`, never for a streamed body to finish.
   */
  const fetchRequest = (request: Request): Promise<Response> => {
    if (request === null || typeof request !== 'object') {
      return Promise.reject(new TypeError('fetch requires a Request'));
    }
    if (closed) {
      return Promise.reject(new Error('application is closed'));
    }
    enterFetch();
    return (async () => {
      try {
        const app = await assembleApp();
        if (closed) {
          throw new Error('application is closed');
        }
        return await app.fetch(request);
      } finally {
        exitFetch();
      }
    })();
  };

  /** Track a `fetch` handler as in-flight so `close` can drain it. */
  const enterFetch = (): void => {
    if (inflightFetches === 0) {
      fetchesDrained = new Promise<void>((resolve) => {
        resolveFetchesDrained = resolve;
      });
    }
    inflightFetches += 1;
  };

  /** Release one in-flight `fetch`; resolve the drain gate when none remain. */
  const exitFetch = (): void => {
    inflightFetches -= 1;
    if (inflightFetches === 0 && resolveFetchesDrained !== undefined) {
      resolveFetchesDrained();
      resolveFetchesDrained = undefined;
    }
  };

  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    // Reject future build/serve/fetch immediately; teardown runs behind any
    // in-flight op and waits for in-flight fetch handlers to settle first.
    closed = true;
    closing = withLock(async () => {
      await fetchesDrained;
      await teardown();
    });
    return closing;
  };

  async function startServing(): Promise<ServeHandle> {
    let server: NodeHttpServer | undefined;
    let sockets: Set<Socket> | undefined;
    let broadcast: Broadcast | undefined;
    try {
      const app = await assembleApp();

      // Ensure the storage directory exists before listening. This is the only
      // operation that creates it: build and fetch are read-only with respect to
      // the filesystem layout and never materialize the folder.
      mkdirSync(config.storageDir, { recursive: true });

      server = createHttpServer(app);
      sockets = trackConnections(server);
      for (const hook of extensionRuntime.serveHooks) {
        await hook(server, { config, services: extensionRuntime.services });
      }
      if (config.broadcast !== undefined) {
        broadcast = await attachBroadcast(server, config.broadcast);
      }

      await listen(server, config.host, config.port);

      const bound = server.address();
      const port = typeof bound === 'object' && bound !== null ? bound.port : config.port;
      const url = `http://${formatHost(config.host)}:${port}/`;

      served.push({ server, broadcast, sockets });

      return { server, port, url, close: () => close() };
    } catch (error) {
      // A failed startup owns nothing beyond what it created here: release the
      // HTTP server/broadcast but leave extensions and the app cleanup intact so
      // the application can still build or serve again.
      const cleanupErrors: unknown[] = [];
      if (server !== undefined && sockets !== undefined) {
        try {
          await closeServedEntry({ server, broadcast, sockets }, config.shutdownTimeoutMs);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length === 0) throw error;
      throw new AggregateError([error, ...cleanupErrors], 'serve failed', { cause: error });
    }
  }

  async function teardown(): Promise<void> {
    const errors: unknown[] = [];
    for (const entry of [...served].reverse()) {
      try {
        await closeServedEntry(entry, config.shutdownTimeoutMs);
      } catch (error) {
        errors.push(error);
      }
    }
    if (appCleanup !== undefined) {
      try {
        await appCleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await extensionRuntime.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'application close failed');
  }

  return {
    config,
    manifest,
    services: extensionRuntime.services,
    build,
    serve,
    fetch: fetchRequest,
    close,
  };
}

/**
 * Reject a health endpoint path that collides with a discovered page or API
 * route. The check runs against the manifest (the only place route discovery
 * has happened), so it reports the conflicting route and its source file — an
 * intentional exception to the value-free config-error convention, since the
 * file is the actionable fix and is never attacker-controlled input.
 */
function assertNoHealthRouteCollision(
  manifest: RouteManifest,
  healthPath: string | undefined,
): void {
  if (healthPath === undefined) return;
  const entry = manifest.byRoute.get(healthPath);
  if (entry === undefined) return;
  throw new AppConfigError(
    `config.healthPath "${healthPath}" collides with the ${entry.kind} route "${entry.route}" (${entry.file})`,
  );
}

/** Bind the server, resolving on `listening` and rejecting on `error`. */
function listen(server: NodeHttpServer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** Raised when the transport fails to stop within the configured grace period. */
class ShutdownTimeoutError extends Error {
  constructor() {
    super('server shutdown exceeded the configured timeout');
    this.name = 'ShutdownTimeoutError';
  }
}

/** Track every socket the server accepts so a stuck close can destroy only them. */
function trackConnections(server: NodeHttpServer): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return sockets;
}

/**
 * Close one served entry (HTTP server plus any attached broadcast) within the
 * configured grace period. The transport stops first, then the HTTP server is
 * closed if it is still open. The server's actual listening state is the only
 * guard against a double close: the built-in Socket.IO adapter closes the
 * server as part of its own `close`, so the explicit close is then a no-op,
 * while a custom adapter that leaves the server alive (`closesHttpServer:
 * false`) gets it closed here — the server is never skipped because of what the
 * handle declared. A transport error never short-circuits the server close.
 *
 * Idle keep-alive and in-flight requests are force-closed first so a normal
 * close resolves promptly; upgraded sockets are left alone — Socket.IO closes
 * its own, and a lingering non-Socket.IO upgraded socket is destroyed through
 * the tracked set if the deadline elapses. Only sockets this server accepted
 * are touched, never the process or unrelated sockets.
 */
async function closeServedEntry(entry: ServedEntry, timeoutMs: number): Promise<void> {
  if (entry.server.listening) {
    entry.server.closeIdleConnections();
    entry.server.closeAllConnections();
  }

  const force = (): void => {
    for (const socket of entry.sockets) {
      socket.destroy();
    }
    entry.sockets.clear();
  };

  const errors: unknown[] = [];

  // Stop the transport first. The built-in adapter also closes the server here;
  // a custom `closesHttpServer: false` adapter only stops its own transport and
  // the server is released by the explicit close below. A transport error is
  // collected but never prevents the server from being released.
  if (entry.broadcast !== undefined) {
    try {
      await withShutdownDeadline(entry.broadcast.close(), timeoutMs, force);
    } catch (error) {
      errors.push(error);
    }
  }

  // Close the HTTP server if it is still open. This runs whether or not a
  // broadcast was attached, and regardless of what the transport handle
  // declared — only the server's listening state guards against a double close.
  if (entry.server.listening) {
    try {
      await withShutdownDeadline(closeHttpServer(entry.server), timeoutMs, force);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'server close failed');
}

/**
 * Race a close operation against the shutdown deadline. When the operation
 * settles first it wins; when the deadline wins, `force` destroys the lingering
 * sockets and a {@link ShutdownTimeoutError} is thrown. The timer is always
 * cleared, and the operation's promise is always handled so a late settlement
 * never becomes an unhandled rejection.
 */
async function withShutdownDeadline(
  operation: Promise<void>,
  timeoutMs: number,
  force: () => void,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        force();
        reject(new ShutdownTimeoutError());
      }, timeoutMs);
      operation.then(
        () => {
          if (settled) return;
          settled = true;
          resolve();
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error);
        },
      );
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Close a listening server, resolving once all its connections have ended. */
function closeHttpServer(server: NodeHttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

/** Resolve the server-components runtime from the sealed service registry. */
function resolveServerComponentsRuntime(
  services: ServiceRegistry | undefined,
): ServerComponentsRuntime | undefined {
  if (services === undefined) return undefined;
  try {
    return services.tryGet(serverComponentsToken);
  } catch {
    return undefined;
  }
}

/** Resolve the diagnostics service from the sealed service registry. */
function resolveDiagnosticsService(services: ServiceRegistry | undefined): Diagnostics | undefined {
  if (services === undefined) return undefined;
  try {
    return services.tryGet(diagnosticsToken);
  } catch {
    return undefined;
  }
}

/** Resolve a single typed service from the registry, failing closed to undefined. */
function resolveService<T>(
  services: ServiceRegistry | undefined,
  token: ServiceToken<T>,
): T | undefined {
  if (services === undefined) return undefined;
  try {
    return services.tryGet(token);
  } catch {
    return undefined;
  }
}

/**
 * Resolve `plugins.use` entries into constructed {@link JsailsPlugin} objects,
 * or throw a value-free {@link AppConfigError} when any entry fails to load.
 * Absent/empty `entries` returns an empty array with no import or error.
 */
async function resolveUsePlugins(
  entries: readonly PluginUseEntry[] | undefined,
): Promise<readonly JsailsPlugin[]> {
  if (entries === undefined || entries.length === 0) return [];

  const result = await resolvePluginUse({ entries });

  if (result.issues.length > 0) {
    // Value-free: name the failing specifiers only, never echo options or error
    // details. The specifier is the value the developer wrote in their config,
    // not a secret — it is the actionable identifier for fixing the problem.
    const specifiers = result.issues.map((issue) => issue.path ?? 'unknown').join(', ');
    throw new AppConfigError(`plugin(s) failed to load: ${specifiers}`);
  }

  return result.plugins;
}

/** Wrap a bare IPv6 host in brackets so it forms a valid URL authority. */
function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}
