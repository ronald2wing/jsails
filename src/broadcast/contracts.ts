/**
 * Neutral broadcast transport contract.
 *
 * The JSails core (`attachBroadcast` in `./server.ts`) mounts a broadcast
 * transport onto an existing `node:http.Server` — never a second listener or an
 * alternate public port. The transport itself is pluggable: the built-in
 * Socket.IO adapter (`./socketio-adapter.ts`) implements this contract, and an
 * application may supply its own {@link BroadcastAdapter}.
 *
 * Security boundary: the core performs no authentication, authorization,
 * channel validation, or payload serialization for a custom adapter. A custom
 * transport is trusted application code and owns its own handshake
 * authentication, channel authorization, and serialization — the core never
 * forges or inspects a connection handshake on its behalf. The Socket.IO
 * adapter's origin/auth/channel checks live in its own module, not here.
 */

import type { Server as NodeHttpServer } from 'node:http';

import type { JsonValue } from '../contracts/http.js';
import type { Awaitable } from '../internal/types.js';

export { BROADCAST_PATH } from './path.js';

/**
 * The surface a mounted broadcast transport exposes to the JSails core. The
 * wrapper {@link attachBroadcast} returns adds an `emit` alias and an
 * idempotent, concurrent-safe `close` on top of this handle.
 */
export interface BroadcastHandle {
  /**
   * Deliver a JSON payload to every authorized, currently-joined member of
   * `channel`. Broadcasts are ephemeral: there is no replay for clients that
   * join later and no durable store. The transport owns channel/event/payload
   * validation and serialization.
   */
  broadcast(channel: string, event: string, data: JsonValue): void;
  /**
   * Shut the transport down. Must be idempotent and safe for concurrent
   * callers; every caller must await the same shutdown.
   */
  close(): Promise<void>;
  /**
   * Whether {@link close} also closes the HTTP server the adapter was attached
   * to. When `true` the adapter owns the server's teardown and the core must
   * not close it again; when `false` the caller owns the server and closes it
   * independently after the transport stops.
   */
  readonly closesHttpServer: boolean;
}

/**
 * A broadcast transport implementation. A `name` labels it for diagnostics
 * only; `attach` mounts it onto an existing HTTP server and returns (or
 * resolves to) a {@link BroadcastHandle}.
 *
 * Contract for implementors:
 * - `attach` must not open its own listener or an alternate public port.
 * - A throwing/rejecting `attach` owns whatever it partially created — the
 *   core neither reuses nor disposes a failed adapter's resources.
 */
export interface BroadcastAdapter {
  /** Diagnostic label, never used for identity or routing. */
  readonly name: string;
  attach(server: NodeHttpServer): Awaitable<BroadcastHandle>;
}
