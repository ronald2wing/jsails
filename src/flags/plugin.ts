/**
 * First-party `flags` plugin: exposes a {@link FeatureFlags} service under a
 * typed service token.
 *
 * `flagsPlugin({ store? })` builds a {@link JsailsPlugin} named `flags` whose
 * `setup` provides the service under {@link flagsToken}:
 *
 * - with an explicit `store`, that store is used verbatim (identity preserved)
 *   and the plugin never closes it (a {@link FeatureStore} holds no resources
 *   the plugin owns);
 * - otherwise the plugin owns the zero-config {@link createMemoryFeatureStore}.
 *
 * Construction is inert: nothing connects and no flag is read or written until
 * the service's `isActive`/`activate`/`deactivate`/`all` is called. Cleanup is a
 * no-op, so the runner's `close` stays idempotent.
 */

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import {
  createFeatureFlags,
  createMemoryFeatureStore,
  type FeatureFlags,
  type FeatureStore,
} from './flags.js';

/**
 * Opaque token for the application {@link FeatureFlags}. Defined once here and
 * shared by the provider (`flagsPlugin`) and any consumer (e.g. an extension's
 * `requires`).
 */
export const flagsToken: ServiceToken<FeatureFlags> = createServiceToken<FeatureFlags>('flags');

/** Options accepted by {@link flagsPlugin}. */
export interface FlagsPluginOptions {
  /** Caller-provided store; used verbatim and never closed by the plugin. */
  readonly store?: FeatureStore;
}

/** True when `value` implements the {@link FeatureStore} contract. */
function isFeatureStore(value: unknown): value is FeatureStore {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<FeatureStore>;
  return (
    typeof candidate.get === 'function' &&
    typeof candidate.set === 'function' &&
    typeof candidate.delete === 'function' &&
    typeof candidate.all === 'function'
  );
}

/**
 * Build the first-party `flags` plugin. Validation is eager and throws
 * `TypeError` for malformed options; the returned plugin is otherwise inert and
 * opens no connection.
 */
export function flagsPlugin(options: FlagsPluginOptions = {}): JsailsPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('flagsPlugin requires an options object');
  }
  if (options.store !== undefined && !isFeatureStore(options.store)) {
    throw new TypeError('store must be a feature store');
  }

  return definePlugin({
    name: 'flags',
    setup({ services }) {
      const store = options.store ?? createMemoryFeatureStore();
      services.provide(flagsToken, createFeatureFlags(store));
    },
  });
}
