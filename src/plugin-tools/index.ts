/**
 * Plugin-tools: a first-party plugin that exposes canonical internal tool
 * modules for plugin authors through the service registry.
 *
 * {@link pluginToolsPlugin} is the first-party extension that provides a
 * {@link PluginTools} namespace under {@link pluginToolsToken}. It runs before
 * all default plugins (`priority: -1000`).
 */

export { pluginToolsPlugin, pluginToolsToken, type PluginTools } from './plugin.js';

// The `plugin-tools` factory is the subpath's default export, matching every
// other first-party plugin subpath: the loader resolves a `plugins.use`
// specifier by importing its default export and calling it with the options.
export { pluginToolsPlugin as default } from './plugin.js';
