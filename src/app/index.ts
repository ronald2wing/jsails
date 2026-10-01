/**
 * App subpath (`jsails/app`): the HTTP application surface plus the first-party
 * `app` plugin.
 *
 * This barrel re-exports the core HTTP functions the root `jsails` entry already
 * exposes through `entry/server.ts`, the {@link Application} / {@link ServeHandle}
 * / {@link AppCleanup} types, and the `app` plugin with its token, so a
 * `plugins.use` consumer can load everything from one subpath.
 */

// HTTP surface (shared with the root entry).
export { createApp, type AppOptions } from '../server/app.js';
export { createHttpServer, type HttpServerOptions } from '../server/server-http.js';
export { createPublicFilesMiddleware } from './static-files.js';

// App runtime types.
export { type Application, type ServeHandle } from './application.js';
export { type AppCleanup } from './config/index.js';

// Plugin.
export { appPlugin, httpAppToken, type HttpApp } from './plugin.js';

// The declarative loader calls `mod.default(options)`, so every first-party
// subpath barrel must default-export its factory alongside the named export.
export { appPlugin as default } from './plugin.js';
