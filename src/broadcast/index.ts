/**
 * Broadcast entry point: the server-side transport surface plus the
 * first-party `broadcast` plugin. Named re-exports only; importing this module
 * pulls in the Socket.IO adapter (via `server.js`) but never opens a connection.
 */

export {
  attachBroadcast,
  BROADCAST_PATH,
  type AttachBroadcastOptions,
  type Broadcast,
  type BroadcastAdapter,
  type BroadcastHandle,
  type BroadcastHandshake,
  type BroadcastOptions,
} from './server.js';

// Re-export the shared type from its canonical internal home so public barrels
// (the root `jsails` entry and `jsails/broadcast`) still resolve it.
export { type Awaitable } from '../internal/types.js';

export { createSocketIOBroadcastAdapter } from './socketio-adapter.js';

export { broadcastPlugin, type BroadcastPluginOptions } from './plugin.js';

// The `broadcast` factory is the subpath's default export, matching every other
// first-party plugin subpath: `plugins.use` resolves a specifier by importing
// the default export and calling it with the options tuple.
export { broadcastPlugin as default } from './plugin.js';
