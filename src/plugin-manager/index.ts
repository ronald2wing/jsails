/**
 * Plugin manager subpath: the first-party admin plugin that mounts the plugin
 * install/enable/disable/uninstall/rollback surface under an admin panel.
 *
 * `pluginManagerPlugin(options)` returns an {@link AdminPlugin} (id
 * `plugin-manager`) whose `register` contributes a single admin page (slug
 * `plugins`, label `Plugins`) mounted by {@link adminPlugin} like any other
 * admin page. The page renders the discovered plugin list plus, when
 * configured, the install form and the per-row actions; a `POST` to the same
 * path is dispatched on the submitted `action` field. The admin core has
 * already enforced the default-deny auth gate, a same-origin `Origin`, and a
 * constant-time `_csrf` check before the page's `handlePost` runs.
 *
 * The notice codes (`PLUGIN_NOTICE_*`) are the stable query values a successful
 * mutation redirects to; they are exported so callers and tests can recognize
 * them without string literals. The `PluginInstaller` and `PluginStateSource`
 * types are re-exported so an app can wire the built-in installer/store (or its
 * own implementations) into the plugin without importing the plugin-system
 * subpath directly.
 *
 * This subpath depends on the admin foundation (`jsails/admin`) and the plugin
 * system; it is server-only (it discovers plugins on the filesystem).
 */

export {
  pluginManagerPlugin,
  PluginManagerError,
  type PluginManagerOptions,
  type ResolvedPluginManagerOptions,
} from './plugin.js';

export {
  PLUGIN_NOTICE_INSTALLED,
  PLUGIN_NOTICE_ENABLED,
  PLUGIN_NOTICE_DISABLED,
  PLUGIN_NOTICE_UNINSTALLED,
  PLUGIN_NOTICE_ROLLED_BACK,
  PLUGIN_NOTICE_SETTINGS_SAVED,
  PLUGIN_NOTICE_CODES,
  type PluginNoticeCode,
} from './pages.js';

export type { PluginInstaller } from '../plugins/installer.js';
export type { PluginStateSource } from '../plugins/state-store.js';
