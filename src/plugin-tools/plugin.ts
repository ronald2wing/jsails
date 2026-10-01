/**
 * First-party `plugin-tools` plugin: exposes canonical internal tool modules
 * under a typed service token so plugin authors get them the same way they get
 * any service.
 *
 * `pluginToolsPlugin()` builds a {@link JsailsPlugin} named `plugin-tools` with
 * `priority: -1000` (runs before all default plugins) whose `setup` provides a
 * namespace object under {@link pluginToolsToken}:
 *
 * - `cleanup` — {@link createCleanup} (idempotent concurrent-safe teardown)
 * - `zod` — {@link mapZodIssues} (canonical value-free issue mapper)
 * - `trustedMutation` — {@link isSameOriginRequest}, {@link csrfTokenValid},
 *   {@link checkTrustedMutation} (same-origin + CSRF guard)
 * - `responses` — {@link forbiddenResponse}, {@link badRequestResponse},
 *   {@link notFoundResponse}, {@link attachNoStore} (value-free response
 *   factories)
 *
 * Construction is inert: nothing connects and no operation is performed until a
 * consumer calls a tool. The returned plugin carries no cleanup — the runner's
 * `close` stays idempotent.
 *
 * This plugin re-exports the internal modules; the internal modules remain the
 * source of truth and are imported directly by core code. The plugin provides
 * the same tools for plugin authors through the service registry.
 */

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';

import { createCleanup } from '../internal/cleanup.js';
import { mapZodIssues } from '../internal/zod.js';
import {
  isSameOriginRequest,
  csrfTokenValid,
  checkTrustedMutation,
} from '../internal/trusted-mutation.js';
import {
  forbiddenResponse,
  badRequestResponse,
  notFoundResponse,
  attachNoStore,
} from '../internal/responses.js';

/**
 * Namespace of canonical tool functions the `plugin-tools` plugin provides.
 * Each property maps to an internal module's public API; the internal modules
 * remain the source of truth.
 */
export interface PluginTools {
  readonly cleanup: typeof createCleanup;
  readonly zod: typeof mapZodIssues;
  readonly trustedMutation: {
    readonly isSameOriginRequest: typeof isSameOriginRequest;
    readonly csrfTokenValid: typeof csrfTokenValid;
    readonly checkTrustedMutation: typeof checkTrustedMutation;
  };
  readonly responses: {
    readonly forbiddenResponse: typeof forbiddenResponse;
    readonly badRequestResponse: typeof badRequestResponse;
    readonly notFoundResponse: typeof notFoundResponse;
    readonly attachNoStore: typeof attachNoStore;
  };
}

/**
 * Opaque token for {@link PluginTools}. Defined once here and shared by the
 * provider (`pluginToolsPlugin`) and any consumer (e.g. an extension's
 * `requires`).
 */
export const pluginToolsToken: ServiceToken<PluginTools> =
  createServiceToken<PluginTools>('plugin-tools');

/**
 * Build the first-party `plugin-tools` plugin. The returned plugin is inert at
 * construction and opens no connection.
 *
 * `priority` is `-1000` so this plugin runs before every default plugin (which
 * use priority `0`).
 */
export function pluginToolsPlugin(): JsailsPlugin {
  // The namespace object is frozen so consumers cannot accidentally mutate it.
  const tools: PluginTools = Object.freeze({
    cleanup: createCleanup,
    zod: mapZodIssues,
    trustedMutation: Object.freeze({
      isSameOriginRequest,
      csrfTokenValid,
      checkTrustedMutation,
    }),
    responses: Object.freeze({
      forbiddenResponse,
      badRequestResponse,
      notFoundResponse,
      attachNoStore,
    }),
  });

  return definePlugin({
    name: 'plugin-tools',
    priority: -1000,
    setup({ services }) {
      services.provide(pluginToolsToken, tools);
    },
  });
}
