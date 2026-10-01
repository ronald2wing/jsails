/**
 * Plugin manager: the first-party admin plugin that mounts the plugin
 * install/enable/disable/uninstall/rollback surface under the admin panel.
 *
 * `pluginManagerPlugin(options)` returns an {@link AdminPlugin} (id
 * `plugin-manager`) whose `register` contributes a single admin page (slug
 * `plugins`, label `Plugins`). The page is mounted by {@link adminPlugin} under
 * the panel path exactly like any other admin page, so the plugin manager is
 * ordinary panel composition — not a special route registrar inside the core.
 *
 * The page renders the discovered plugin list plus, when configured, the
 * install form and the per-row enable/disable/uninstall/rollback actions; a
 * `POST` to the same path is dispatched on the submitted `action` field. The
 * core already enforced the default-deny auth gate, a same-origin `Origin`,
 * and a constant-time `_csrf` check before the page's `handlePost` runs, so
 * this plugin owns only its own policy: installs are gated behind
 * {@link resolveDownloadsCapability} (a `false`/`null` `downloads` disables
 * them) and refuse code-enabled ids; enable/disable require `managed: true`
 * with a `stateSource`; uninstall/rollback require an `installer`. A successful
 * post 303-redirects to `<path>/plugins?notice=<code>`.
 *
 * The module imports the admin page/builder descriptors and the plugin-system
 * discovery/state/installer modules; it never imports the admin route
 * registrar. There is no dependency from the admin core back into this module.
 */

import { defineAdminPage } from '../admin/page.js';
import { defineAdminPlugin, type AdminPlugin } from '../admin/admin-plugin.js';
import type { PluginInstaller } from '../plugins/installer.js';
import type { PluginStateSource } from '../plugins/state-store.js';
import {
  handlePluginsPost,
  handlePluginSettingsPost,
  renderPluginsPage,
  renderPluginSettingsPage,
} from './pages.js';

/** Options for {@link pluginManagerPlugin}. */
export interface PluginManagerOptions {
  /** Explicit enable allow-list passed to discovery. */
  readonly enabled?: readonly string[];
  /** Storage-backed plugins folder. Defaults to `<cwd>/storage/plugins`. */
  readonly pluginsDir?: string;
  /** When `true` with a `stateSource`, enable/disable actions are mounted. */
  readonly managed?: boolean;
  /** Download capability; `false` disables installs. Defaults to enabled. */
  readonly downloads?: boolean | null;
  /** Persisted plugin state source (JSON store or database-backed). */
  readonly stateSource?: PluginStateSource;
  /** Installer surface for install/uninstall/rollback actions. */
  readonly installer?: PluginInstaller;
}

/** The resolved, frozen options captured by the plugin's page callbacks. */
export interface ResolvedPluginManagerOptions {
  readonly enabled?: readonly string[];
  readonly pluginsDir?: string;
  readonly managed?: boolean;
  readonly downloads?: boolean | null;
  readonly stateSource?: PluginStateSource;
  readonly installer?: PluginInstaller;
}

/** Raised for invalid {@link PluginManagerOptions}; messages are value-free. */
export class PluginManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginManagerError';
  }
}

/**
 * Build the plugin-manager admin plugin. The options are validated and frozen
 * eagerly; the returned descriptor is inert until the admin plugin invokes its
 * `register` during application assembly.
 */
export function pluginManagerPlugin(options: PluginManagerOptions = {}): AdminPlugin {
  const resolved = resolveOptions(options);
  return defineAdminPlugin({
    id: 'plugin-manager',
    register(builder) {
      builder.addPage(
        defineAdminPage({
          slug: 'plugins',
          label: 'Plugins',
          render: (context) => renderPluginsPage(context, resolved),
          handlePost: (context) => handlePluginsPost(context, resolved),
        }),
      );
      builder.addPage(
        defineAdminPage({
          slug: 'plugin-settings',
          label: 'Plugin Settings',
          render: (context) => renderPluginSettingsPage(context, resolved),
          handlePost: (context) => handlePluginSettingsPost(context, resolved),
        }),
      );
    },
  });
}

/** Validate and freeze {@link PluginManagerOptions} into a resolved descriptor. */
function resolveOptions(options: PluginManagerOptions): ResolvedPluginManagerOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new PluginManagerError('pluginManagerPlugin requires an options object');
  }
  if (options.enabled !== undefined) {
    if (!Array.isArray(options.enabled)) {
      throw new PluginManagerError('enabled must be an array of plugin ids');
    }
    for (const id of options.enabled) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new PluginManagerError('enabled must be an array of plugin ids');
      }
    }
  }
  if (options.pluginsDir !== undefined) {
    if (typeof options.pluginsDir !== 'string' || options.pluginsDir.length === 0) {
      throw new PluginManagerError('pluginsDir must be a non-empty string');
    }
  }
  if (options.managed !== undefined && typeof options.managed !== 'boolean') {
    throw new PluginManagerError('managed must be a boolean');
  }
  if (
    options.downloads !== undefined &&
    options.downloads !== null &&
    typeof options.downloads !== 'boolean'
  ) {
    throw new PluginManagerError('downloads must be a boolean');
  }
  if (options.stateSource !== undefined) {
    const source = options.stateSource as Partial<PluginStateSource> | null;
    if (
      source === null ||
      typeof source !== 'object' ||
      typeof source.load !== 'function' ||
      typeof source.save !== 'function'
    ) {
      throw new PluginManagerError('stateSource must be a plugin state source');
    }
  }
  if (options.installer !== undefined) {
    const installer = options.installer as Partial<PluginInstaller> | null;
    if (
      installer === null ||
      typeof installer !== 'object' ||
      typeof installer.install !== 'function' ||
      typeof installer.uninstall !== 'function' ||
      typeof installer.rollback !== 'function'
    ) {
      throw new PluginManagerError('installer must be a plugin installer');
    }
  }
  return Object.freeze({
    ...(options.enabled === undefined ? {} : { enabled: Object.freeze([...options.enabled]) }),
    ...(options.pluginsDir === undefined ? {} : { pluginsDir: options.pluginsDir }),
    ...(options.managed === undefined ? {} : { managed: options.managed }),
    ...(options.downloads === undefined ? {} : { downloads: options.downloads }),
    ...(options.stateSource === undefined ? {} : { stateSource: options.stateSource }),
    ...(options.installer === undefined ? {} : { installer: options.installer }),
  });
}
