/**
 * Application runtime assembly.
 *
 * `createApplication` turns a {@link ResolvedAppConfig} into a runnable
 * {@link Application}. It is deliberately inert about infrastructure: it never
 * initializes a database or a Valkey connection itself. Extensions own their
 * services, and broadcast is attached only when the config requests it during
 * {@link Application.serve}. Discovery and validation happen before any
 * extension opens a connection:
 *
 * 1. {@link discoverRoutes} scans the pages/api directories and validates the
 *    route space (rejecting ambiguous, duplicate, or malformed routes) with no
 *    module import and no connection.
 * 2. {@link runExtensions} runs each extension's `setup` in declaration order
 *    against a fresh service registry, collecting HTTP hooks.
 * 3. The app's own `setup` hook runs last; if it throws, the extensions that
 *    already opened are closed again before the error propagates.
 *
 * {@link Application.build} renders the static site through
 * {@link generateStaticSite} (the configured renderer or the built-in Preact
 * renderer, plus the extension services) and never listens on a port.
 * {@link Application.serve} assembles the Hono app, mounts the public-files
 * middleware, creates one HTTP server, optionally attaches broadcast to that
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
import type { Socket } from 'node:net';

import type { Hono } from 'hono';

import type { Broadcast } from '../broadcast/server.js';
import { attachBroadcast } from '../broadcast/server.js';
import { AppConfigError } from './config.js';
import type { AppCleanup, ResolvedAppConfig } from './config.js';
import { createAssetUrlResolver } from './asset-urls.js';
import { runExtensions } from '../extensions/extension.js';
import type { ServiceRegistry } from '../extensions/services.js';
import { preactPageRenderer } from '../pages/page.js';
import type { GenerateStaticSiteResult } from '../pages/static-site.js';
import { generateStaticSite } from '../pages/static-site.js';
import type { RouteManifest } from '../routing/manifest.js';
import { discoverRoutes } from '../routing/manifest.js';
import { createApp } from '../server/app.js';
import { createHttpServer } from '../server/http.js';
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

  // Discover and validate the route space before any extension opens a connection.
  const manifest = discoverRoutes(config.rootDir, {
    pagesDir: config.pagesDir,
    apiDir: config.apiDir,
  });

  // The health endpoint is framework infrastructure registered ahead of the
  // filesystem routes, so it must not claim a route that already belongs to a
  // page or API module.
  assertNoHealthRouteCollision(manifest, config.healthPath);

  // One shared asset-URL resolver for HTTP and static generation. It performs no
  // filesystem access until first used, so building it is inert.
  const assetUrl = createAssetUrlResolver(config.publicDir);

  // Extension setup in declaration order, then the app's own setup hook.
  const extensionRuntime = await runExtensions(config.extensions);
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
    const app = await createApp({
      manifest,
      authorize: config.authorize,
      resolveSession: config.resolveSession,
      renderer: config.renderer ?? preactPageRenderer,
      services: extensionRuntime.services,
      httpHooks: extensionRuntime.httpHooks,
      maxBodyBytes: config.maxBodyBytes,
      publicOrigin: config.publicOrigin,
      assetUrl,
      healthPath: config.healthPath,
      storagePath: config.storageDir,
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
      return generateStaticSite({
        manifest,
        outDir: config.outDir,
        publicDir: config.publicDir,
        baseUrl: config.publicOrigin,
        renderer: config.renderer,
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

/** Wrap a bare IPv6 host in brackets so it forms a valid URL authority. */
function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}
