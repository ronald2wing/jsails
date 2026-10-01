/**
 * Routing subpath (`jsails/routing`): the routing surface plus the first-party
 * `routing` plugin.
 *
 * This barrel re-exports the routing helpers the root `jsails` entry already
 * exposes through `exports/routing.ts`, plus the `routing` plugin with its
 * token, so a `plugins.use` consumer can load everything from one subpath and a
 * custom plugin can require the manifest through `routeManifestToken`.
 */

// Routing surface (shared with the root entry).
export {
  discoverRoutes,
  routeToOutputPath,
  substituteRouteParams,
  RouteManifestError,
  type DiscoverRoutesOptions,
  type RouteManifest,
  type RouteManifestEntry,
} from './routes.js';

export {
  createMiddlewareRegistry,
  resolveMiddlewareRefs,
  runMiddleware,
  validateMiddlewareList,
  type MiddlewareRegistry,
  type RouteMiddleware,
  type RouteMiddlewareRef,
} from './middleware.js';

// Signed URLs: HMAC-SHA256-signed URL generation/verification with optional
// expiry, independent of any route registry.
export {
  createUrlSigner,
  SignedUrlError,
  type UrlSigner,
  type UrlSignerOptions,
} from './signed-urls.js';

// Plugin.
export { routingPlugin, routeManifestToken, type RoutingPluginOptions } from './plugin.js';

// The declarative loader calls `mod.default(options)`, so every first-party
// subpath barrel must default-export its factory alongside the named export.
export { routingPlugin as default } from './plugin.js';
