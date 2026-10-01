/**
 * First-party `signals` plugin: wraps the shared interceptor/observer registry
 * as a {@link SignalBus} service and provides it under a typed service token.
 *
 * This is the bridge that closes the gap between the extension runner's sealed
 * interceptor registry and the plugin ecosystem: after setup, any plugin that
 * `requires: [signalsToken]` receives a bus whose `emit` fires every observer
 * on the shared registry regardless of which plugin registered it.
 */

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import { createSignalBus, SignalError, type SignalBus } from './signal-bus.js';

/** Opaque token for the application {@link SignalBus}. */
export const signalsToken: ServiceToken<SignalBus> = createServiceToken<SignalBus>('signals');

/**
 * Build the first-party `signals` plugin. Construction is inert — no connection
 * is opened and no event is emitted until the bus is used.
 *
 * The plugin's `setup` reads the shared interceptor registry from the setup
 * context's `interceptorRegistry` member (added in the same framework release).
 * When that member is absent — a defensive guard for an older runner that
 * predates this seam — setup throws a value-free {@link SignalError}.
 */
export function signalsPlugin(): JsailsPlugin {
  return definePlugin({
    name: 'signals',
    setup({ services, interceptorRegistry }) {
      // Defensive guard: an older framework runner that predates the
      // interceptorRegistry member on the setup context won't have it.
      if (!interceptorRegistry) {
        throw new SignalError(
          'shared interceptor registry is unavailable — ensure the signals plugin is ' +
            'run inside a framework that exposes the shared registry on the setup context',
        );
      }

      const bus = createSignalBus(interceptorRegistry);
      services.provide(signalsToken, bus);
    },
  });
}
