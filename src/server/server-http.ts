/**
 * Node HTTP server factory for a Hono app.
 *
 * `createHttpServer` wraps a Hono app's `fetch` in a `node:http.Server` via the
 * maintained `@hono/node-server` adapter (`createAdaptorServer`). It never
 * calls `listen()` — binding an ephemeral or configured port and closing the
 * server are entirely the caller's responsibility. The returned server carries
 * no JSails-owned connections (no Valkey, no database) and can be shared with
 * `attachBroadcast` on the same port.
 */

import type { createServer } from 'node:http';
import type { Server as NodeHttpServer, ServerOptions } from 'node:http';

import { createAdaptorServer } from '@hono/node-server';
import type { Hono } from 'hono';

/** Options for {@link createHttpServer}. */
export interface HttpServerOptions {
  /** Options forwarded to `node:http.createServer`. */
  serverOptions?: ServerOptions;
  /** Custom server factory; defaults to `node:http.createServer`. */
  createServer?: typeof createServer;
}

/**
 * Create a non-listening `node:http.Server` serving `app`. The caller owns
 * `listen()` and `close()`; the Hono app itself is stateless and needs no
 * shutdown. No port is opened and no external connection is established.
 */
export function createHttpServer(app: Hono, options: HttpServerOptions = {}): NodeHttpServer {
  if (app === null || typeof app !== 'object' || typeof app.fetch !== 'function') {
    throw new TypeError('createHttpServer requires a Hono app instance');
  }
  return createAdaptorServer({
    fetch: app.fetch,
    serverOptions: options.serverOptions,
    createServer: options.createServer,
  }) as NodeHttpServer;
}
