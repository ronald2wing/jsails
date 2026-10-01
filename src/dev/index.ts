/**
 * Dev tooling subpath (`jsails/dev`): the dev plugin and live-reload surface.
 *
 * Everything here is server-only. Import the plugin (and the starter's
 * live-reload script) for local development; production never mounts it.
 */

export { devPlugin, type DevPluginOptions } from './plugin.js';
export { devReloadScript, liveReloadResponse, type LiveReloadOptions } from './live-reload.js';

// `plugins.use` resolves a specifier by importing its DEFAULT export and calling
// it with the options tuple — so the dev subpath default-exports the plugin
// factory, exactly like `jsails/auth`, `jsails/cache`, and the other plugins.
export { devPlugin as default } from './plugin.js';
