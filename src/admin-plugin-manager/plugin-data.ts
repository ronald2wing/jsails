/**
 * Shared plugin data loading for the plugin manager pages.
 *
 * Discovery (honoring the `enabled` allow-list and `pluginsDir`) and persisted
 * state are loaded together; either failing degrades to empty data rather than
 * a 500, so the pages always render.
 */

import { join } from 'node:path';

import {
  DEFAULT_PLUGINS_DIR,
  discoverPlugins,
  type DiscoverPluginsResult,
} from '../plugins/discovery/index.js';
import {
  PLUGIN_STATE_VERSION,
  PluginStateStore,
  type PluginState,
} from '../plugins/state-store.js';
import type { ResolvedPluginManagerOptions } from './plugin.js';

/** Discover plugins and load persisted state, degrading failures to empty data. */
export async function loadPluginData(
  resolved: ResolvedPluginManagerOptions,
): Promise<{ discovered: DiscoverPluginsResult | undefined; state: PluginState }> {
  const pluginsDir = resolved.pluginsDir ?? join(process.cwd(), DEFAULT_PLUGINS_DIR);

  let discovered: DiscoverPluginsResult | undefined;
  try {
    discovered = discoverPlugins({
      rootDir: process.cwd(),
      pluginsDir: resolved.pluginsDir,
      enabled: resolved.enabled,
    });
  } catch {
    discovered = undefined;
  }

  let state: PluginState;
  try {
    if (resolved.stateSource !== undefined) {
      state = await resolved.stateSource.load();
    } else {
      state = new PluginStateStore({ pluginsDir }).load();
    }
  } catch {
    state = { version: PLUGIN_STATE_VERSION, plugins: {} };
  }

  return { discovered, state };
}

/** Read a plugin's state entry without ever touching the prototype chain. */
export function stateEntry(state: PluginState, id: string) {
  return Object.hasOwn(state.plugins, id) ? state.plugins[id] : undefined;
}
