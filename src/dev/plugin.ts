/**
 * Dev plugin (`jsails/dev`): mounts the live-reload SSE route in development.
 *
 * The route streams `/_jsails/dev/reload`; the starter's `ui/layout.tsx` inlines
 * {@link devReloadScript} into `<head>` when `NODE_ENV` is `development`, and the
 * browser reloads once on each reconnect after a nodemon restart. The plugin is
 * inert in any other environment: `mount` runs only during `setup`, and setup
 * only registers the hook when `enabled`.
 */

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { liveReloadResponse } from './live-reload.js';

/** Options for {@link devPlugin}. */
export interface DevPluginOptions {
  /** Mount the reload route. Defaults to `NODE_ENV === 'development'`. */
  readonly enabled?: boolean;
}

/**
 * The first-party dev plugin. In development it mounts the reload SSE route;
 * elsewhere it is a no-op (no hook is registered).
 */
export function devPlugin(options: DevPluginOptions = {}): JsailsPlugin {
  const enabled = options.enabled ?? process.env.NODE_ENV === 'development';
  return definePlugin({
    name: 'dev',
    setup({ configureHttp }) {
      if (!enabled) return;
      configureHttp((app) => {
        app.get('/_jsails/dev/reload', () => liveReloadResponse());
      });
    },
  });
}
