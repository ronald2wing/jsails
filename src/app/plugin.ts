/**
 * First-party `app` plugin: publishes the HTTP surface (`createApp`,
 * `createHttpServer`, `createPublicFilesMiddleware`) under a typed service token
 * so plugin authors can build or mount Hono apps through the registry the same
 * way they consume any other service.
 *
 * `appPlugin()` builds a {@link JsailsPlugin} named `app` whose `setup` provides
 * a frozen {@link HttpApp} namespace object under {@link httpAppToken}.
 *
 * Construction is inert: nothing connects and no I/O is performed until a
 * consumer calls one of the provided functions. The returned plugin carries no
 * cleanup — the runner's `close` stays idempotent.
 */

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';

import { createApp } from '../server/app.js';
import { createHttpServer } from '../server/server-http.js';
import { createPublicFilesMiddleware } from './static-files.js';

/**
 * Namespace of the HTTP-surface functions the `app` plugin provides.
 * Each property directly references the canonical public function.
 */
export interface HttpApp {
  readonly createApp: typeof createApp;
  readonly createHttpServer: typeof createHttpServer;
  readonly createPublicFilesMiddleware: typeof createPublicFilesMiddleware;
}

/**
 * Opaque token for {@link HttpApp}. Defined once here and shared by the
 * provider (`appPlugin`) and any consumer (e.g. an extension's `requires`).
 */
export const httpAppToken: ServiceToken<HttpApp> = createServiceToken<HttpApp>('app');

/**
 * Build the first-party `app` plugin. The returned plugin is inert at
 * construction and opens no connection.
 */
export function appPlugin(): JsailsPlugin {
  const tools: HttpApp = Object.freeze({
    createApp,
    createHttpServer,
    createPublicFilesMiddleware,
  });

  return definePlugin({
    name: 'app',
    priority: -999, // runs after plugin-tools (-1000) but before any default plugin (0)
    setup({ services }) {
      services.provide(httpAppToken, tools);
    },
  });
}
