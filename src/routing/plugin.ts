/**
 * First-party `routing` plugin: discovers filesystem routes and publishes the
 * {@link RouteManifest} under a typed service token so the pipeline can resolve
 * the manifest from the registry after extensions run.
 *
 * `routingPlugin(options)` builds a {@link JsailsPlugin} named `routing` whose
 * `setup` calls {@link discoverRoutes} and provides the result under
 * {@link routeManifestToken}.
 *
 * Construction is inert: nothing is read from disk until the plugin's `setup`
 * runs inside {@link runExtensions}. The returned plugin carries no cleanup —
 * the manifest is static after discovery and the runner's `close` stays
 * idempotent.
 */

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';

import { discoverRoutes, type RouteManifest } from './routes.js';

/**
 * Opaque token for the discovered {@link RouteManifest}. Defined once here and
 * shared by the provider (`routingPlugin`) and every consumer (the pipeline,
 * static export, introspection, and the public `Application.manifest` field).
 */
export const routeManifestToken: ServiceToken<RouteManifest> =
  createServiceToken<RouteManifest>('route-manifest');

/** Options for the routing plugin. */
export interface RoutingPluginOptions {
  /** The application root directory resolved from the app config. */
  readonly rootDir: string;
  /** The pages directory relative to `rootDir` (default `pages`). */
  readonly pagesDir?: string;
  /** The API directory relative to `rootDir` (default `api`). */
  readonly apiDir?: string;
}

/**
 * Build the first-party `routing` plugin. The returned plugin is inert at
 * construction and opens no connection.
 */
export function routingPlugin(options: RoutingPluginOptions): JsailsPlugin {
  return definePlugin({
    name: 'routing',
    priority: -1000, // Run after plugin-tools (-1000) but before any default plugin (0).
    setup({ services }) {
      const manifest = discoverRoutes(options.rootDir, {
        pagesDir: options.pagesDir,
        apiDir: options.apiDir,
      });
      services.provide(routeManifestToken, manifest);
    },
  });
}
