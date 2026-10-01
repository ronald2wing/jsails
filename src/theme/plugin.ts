/**
 * First-party `theme` plugin: provides the resolved theme-token surface under
 * {@link themeToken}.
 *
 * `themePlugin(options?)` builds a {@link JsailsPlugin} named `theme` whose
 * `setup` merges the app-level tokens with plugin contributions and provides
 * the result as a {@link ThemeTokens} service:
 *
 * - `options.tokens` is the application layer (highest precedence).
 * - `options.contributions` is collected from {@link PluginDescription.theme}
 *   by the extension runner; contributions are folded in registration order.
 * - `options.active` selects which named theme's effective tokens fold into
 *   the active map (step 3 of the ordered fold). Absent means no named theme
 *   participates in the active merge.
 *
 * Construction is inert: the plugin is a pure factory and no tokens are
 * resolved until `setup` runs. `requires` is empty — the plugin has no
 * upstream dependencies.
 */

import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import {
  createThemeTokens,
  type ThemeContribution,
  type ThemeTokenMap,
  type ThemeTokens,
} from './tokens.js';

/**
 * Opaque token for the resolved theme surface. Defined once here and shared
 * by the provider ({@link themePlugin}) and any consumer (e.g. the admin
 * panel, a custom renderer, or the starter's loadLayout).
 */
export const themeToken: ServiceToken<ThemeTokens> = createServiceToken<ThemeTokens>('theme');

/** Options accepted by {@link themePlugin}. */
export interface ThemePluginOptions {
  /** Application-level token overrides (highest precedence). */
  readonly tokens?: ThemeTokenMap;
  /**
   * Plugin-layer contributions, collected by the extension runner from each
   * plugin's {@link PluginDescription.theme}. The order is deterministic
   * (extension sort order); contributions are folded in registration order
   * and same-named contributions spread-merge (later wins per key).
   */
  readonly contributions?: readonly ThemeContribution[];
  /**
   * When set, the named theme whose effective tokens fold into the active
   * map in step 3 of the ordered resolution. The named theme need not have
   * been contributed yet — an unknown name is harmless (no tokens from it).
   */
  readonly active?: string;
}

/**
 * Build the first-party `theme` plugin. Nothing is resolved at construction;
 * the plugin's `setup` provides the merged token surface under
 * {@link themeToken}. A second provider is rejected by the service registry
 * with a value-free duplicate error.
 */
export function themePlugin(options: ThemePluginOptions = {}): JsailsPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('themePlugin requires an options object');
  }

  const appTokens: ThemeTokenMap = options.tokens === undefined ? {} : options.tokens;
  const layers: readonly ThemeContribution[] =
    options.contributions === undefined ? [] : options.contributions;

  return definePlugin({
    name: 'theme',
    setup({ services }) {
      const tokens = createThemeTokens(appTokens, layers, { active: options.active });
      services.provide(themeToken, tokens);
    },
  });
}
