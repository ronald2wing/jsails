/**
 * Server-side broadcast entry point.
 *
 * `attachBroadcast` mounts a broadcast transport onto the application's
 * existing `node:http.Server` — there is no separate public port. Two forms are
 * accepted:
 *
 * - the legacy `BroadcastOptions` form, which builds the built-in Socket.IO
 *   adapter (see `./socketio-adapter.ts`) and enforces its origin/auth/channel
 *   checks; and
 * - an `{ adapter }` form carrying a {@link BroadcastAdapter}, which mounts a
 *   custom transport. A custom adapter is trusted application code that owns
 *   its own authentication, channel authorization, and serialization — the core
 *   never forges or inspects a connection handshake on its behalf, and performs
 *   no Socket.IO origin/auth/channel validation for it.
 *
 * The returned {@link Broadcast} wraps the adapter's handle with an `emit`
 * alias and an idempotent, concurrent-safe `close`. Whether `close()` also
 * closes the attached HTTP server is declared by the handle's
 * `closesHttpServer` flag: `false` leaves the caller's server alive (the caller
 * closes it independently after the transport stops), and `true` means the
 * adapter already closed it — the core never closes the server a second time.
 */

import type { Server as NodeHttpServer } from 'node:http';

import type { JsonValue } from '../contracts/http.js';
import type { BroadcastAdapter, BroadcastHandle } from './contracts.js';
import type { BroadcastOptions } from './socketio-adapter.js';

export {
  BROADCAST_PATH,
  type BroadcastAdapter,
  type BroadcastHandle,
  type MaybePromise,
} from './contracts.js';
export type { BroadcastHandshake, BroadcastOptions } from './socketio-adapter.js';

/**
 * The handle returned by {@link attachBroadcast}: the transport handle's
 * `broadcast`/`close`/`closesHttpServer` plus an `emit` alias of `broadcast`.
 */
export interface Broadcast extends BroadcastHandle {
  /** Alias of {@link BroadcastHandle.broadcast}. */
  emit(channel: string, event: string, data: JsonValue): void;
}

/** Options accepted by {@link attachBroadcast}: built-in Socket.IO options or a custom adapter. */
export type AttachBroadcastOptions = BroadcastOptions | { adapter: BroadcastAdapter };

/**
 * Attach a broadcast transport to `server` and resolve to a {@link Broadcast}
 * wrapper. The built-in Socket.IO form resolves once the server is mounted
 * (after any configured Redis adapter is initialized, so an unreachable Redis
 * rejects before anything is attached); the custom form resolves once the
 * adapter's `attach` resolves.
 */
export async function attachBroadcast(
  server: NodeHttpServer,
  options: AttachBroadcastOptions,
): Promise<Broadcast> {
  if (server === null || typeof server !== 'object') {
    throw new TypeError('attachBroadcast requires an http.Server instance');
  }
  if (isAdapterOptions(options)) {
    return attachCustomAdapter(server, options.adapter);
  }
  return attachSocketIOAdapter(server, options);
}

/** `{ adapter }` discriminates the custom form; Socket.IO options have no such field. */
function isAdapterOptions(
  options: AttachBroadcastOptions,
): options is { adapter: BroadcastAdapter } {
  return options !== null && typeof options === 'object' && 'adapter' in options;
}

async function attachCustomAdapter(
  server: NodeHttpServer,
  adapter: BroadcastAdapter,
): Promise<Broadcast> {
  assertAdapter(adapter);
  const handle = await adapter.attach(server);
  try {
    assertHandle(handle);
  } catch (validationError) {
    // The adapter may have allocated transport resources before returning a
    // malformed handle. Dispose it best-effort without letting cleanup mask the
    // validation error; if disposal also fails, surface both.
    await disposeMalformedHandle(handle, validationError);
    throw validationError;
  }
  return wrapHandle(handle);
}

/**
 * Best-effort cleanup for a handle that failed validation. A handle with no
 * `close` cannot be disposed, so its validation error propagates alone. A
 * failing `close` is aggregated behind the validation error rather than
 * replacing it. The core never closes the HTTP server here: the adapter's own
 * `close` owns that decision through its `closesHttpServer` contract.
 */
async function disposeMalformedHandle(handle: unknown, validationError: unknown): Promise<void> {
  const close =
    handle === null || typeof handle !== 'object'
      ? undefined
      : (handle as { close?: unknown }).close;
  if (typeof close !== 'function') {
    return;
  }
  try {
    await (close as (this: unknown) => unknown).call(handle);
  } catch (cleanupError) {
    throw new AggregateError(
      [validationError, cleanupError],
      'BroadcastAdapter.attach returned a malformed handle that failed to close',
      { cause: validationError },
    );
  }
}

async function attachSocketIOAdapter(
  server: NodeHttpServer,
  options: BroadcastOptions,
): Promise<Broadcast> {
  // The built-in Socket.IO engine (and its Redis backend) is loaded lazily so a
  // custom-adapter deployment never pays for Socket.IO or starts a Redis client.
  const { createSocketIOBroadcastAdapter } = await import('./socketio-adapter.js');
  const handle = await createSocketIOBroadcastAdapter(options).attach(server);
  return wrapHandle(handle);
}

function assertAdapter(adapter: unknown): asserts adapter is BroadcastAdapter {
  if (adapter === null || typeof adapter !== 'object') {
    throw new TypeError('attachBroadcast adapter must be a BroadcastAdapter');
  }
  const name = (adapter as { name?: unknown }).name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('BroadcastAdapter must declare a non-empty name');
  }
  if (typeof (adapter as { attach?: unknown }).attach !== 'function') {
    throw new TypeError('BroadcastAdapter must declare an attach function');
  }
}

function assertHandle(handle: unknown): asserts handle is BroadcastHandle {
  if (handle === null || typeof handle !== 'object') {
    throw new TypeError('BroadcastAdapter.attach must resolve to a handle object');
  }
  if (typeof (handle as { broadcast?: unknown }).broadcast !== 'function') {
    throw new TypeError('broadcast handle must declare a broadcast function');
  }
  if (typeof (handle as { close?: unknown }).close !== 'function') {
    throw new TypeError('broadcast handle must declare a close function');
  }
  if (typeof (handle as { closesHttpServer?: unknown }).closesHttpServer !== 'boolean') {
    throw new TypeError('broadcast handle must declare a boolean closesHttpServer');
  }
}

/**
 * Wrap a transport handle with an `emit` alias and a memoized `close` so every
 * caller (including concurrent ones) awaits the same shutdown, even if the
 * adapter's own `close` is not itself idempotent.
 */
function wrapHandle(handle: BroadcastHandle): Broadcast {
  let closePromise: Promise<void> | undefined;
  return {
    broadcast: (channel, event, data) => handle.broadcast(channel, event, data),
    emit: (channel, event, data) => handle.broadcast(channel, event, data),
    closesHttpServer: handle.closesHttpServer,
    close: () => {
      if (closePromise === undefined) {
        closePromise = Promise.resolve().then(() => handle.close());
      }
      return closePromise;
    },
  };
}
