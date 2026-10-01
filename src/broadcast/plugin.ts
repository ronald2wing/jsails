/**
 * First-party `broadcast` plugin: mounts a broadcast transport onto the
 * application's HTTP server as a composable extension, via the `onServe` hook.
 *
 * `broadcastPlugin(options)` builds a {@link JsailsPlugin} named `broadcast`
 * whose `setup` registers an `onServe` hook. When the application starts
 * serving, that hook calls `attachBroadcast(server, options)` against the same
 * `node:http.Server` the application already owns — the plugin never opens a
 * listener of its own, so HTTP and broadcast share the application's single
 * public port. Both option forms are accepted, exactly as `attachBroadcast`
 * accepts them:
 *
 * - the built-in Socket.IO options ({@link BroadcastOptions}), which enforce the
 *   Socket.IO origin/auth/channel security posture; and
 * - an `{ adapter }` form carrying a custom {@link BroadcastAdapter}, which is
 *   trusted application code owning its own authentication, authorization, and
 *   serialization.
 *
 * The attached {@link Broadcast} handle is stored in the `setup` closure and the
 * returned cleanup closes it (idempotently and concurrency-safely, via the
 * wrapper's own memoized `close`). The application still owns the HTTP server
 * and its bounded shutdown: the plugin only stops the transport, never the
 * server. When the application is only ever built or fetched (never served),
 * `onServe` never runs and the cleanup is a no-op.
 *
 * This is the new composable surface for broadcast, preferred over the legacy
 * `config.broadcast` field: both reach `attachBroadcast`, but the plugin keeps
 * broadcast lifecycle inside the extension system (declaration-ordered setup,
 * reverse cleanup) instead of the config object. The `config.broadcast` path is
 * unchanged and still works.
 *
 * Construction is lazy: nothing connects and no handle is created at import,
 * plugin construction, or `setup` — the transport is attached only when the
 * application actually serves.
 */

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { attachBroadcast, type AttachBroadcastOptions, type Broadcast } from './server.js';

/** Options accepted by {@link broadcastPlugin}: built-in Socket.IO or a custom adapter. */
export type BroadcastPluginOptions = AttachBroadcastOptions;

/**
 * Build the first-party `broadcast` plugin. The returned plugin is inert: no
 * transport is attached until the application serves, at which point the
 * `onServe` hook attaches to the application-owned HTTP server.
 */
export function broadcastPlugin(options: BroadcastPluginOptions): JsailsPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('broadcastPlugin requires an options object');
  }

  return definePlugin({
    name: 'broadcast',
    setup({ onServe }) {
      let handle: Broadcast | undefined;

      onServe(async (server) => {
        handle = await attachBroadcast(server, options);
      });

      return () => (handle === undefined ? Promise.resolve() : handle.close());
    },
  });
}
