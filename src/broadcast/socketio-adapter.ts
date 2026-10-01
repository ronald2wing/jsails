/**
 * Built-in Socket.IO broadcast adapter.
 *
 * Implements the neutral {@link BroadcastAdapter} contract from
 * `./contracts.js` on top of Socket.IO. `createSocketIOBroadcastAdapter`
 * validates its options and returns an adapter whose `attach` mounts a
 * Socket.IO server onto the application's existing `node:http.Server` under a
 * dedicated path (`/_jsails/broadcast`) — there is no separate public port. By
 * default only the websocket transport is enabled, so a multi-node deployment
 * does not need sticky sessions (every connection is a persistent websocket on
 * one node).
 *
 * Security posture (owned here, never assumed for a custom adapter):
 * - The `Origin` header is checked against a configured allowlist with exact
 *   string matching; a missing or non-matching origin is rejected.
 * - The caller must supply an `authenticate` callback that derives the identity
 *   from the connection handshake (headers/query). Client-supplied `auth`
 *   objects are never trusted — the identity comes from the callback alone.
 * - Channel membership is authorized per channel via `authorizeChannel`; when it
 *   is omitted every channel is DENIED by default, never public-by-guess.
 * - Clients can only `subscribe`/`unsubscribe`; there is no client-to-server
 *   broadcast event, so a client can never push to other clients.
 * - Acknowledgments carry only generic error codes, never private error text.
 *
 * Lifecycle: the returned handle's `close()` shuts the Socket.IO server down,
 * which also closes the attached HTTP server (verified Socket.IO 4.8 behavior —
 * `Server#close()` calls `httpServer.close()`). The handle declares
 * `closesHttpServer: true` so the core never closes the server a second time.
 */

import type { IncomingHttpHeaders, Server as NodeHttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { DefaultEventsMap, ServerOptions, Socket } from 'socket.io';

import type { JsonValue } from '../contracts/http.js';
import {
  BROADCAST_PATH,
  type BroadcastAdapter,
  type BroadcastHandle,
  type MaybePromise,
} from './contracts.js';
import {
  closeRedisBroadcastAdapter,
  createRedisBroadcastAdapter,
  type RedisBroadcastAdapter,
} from './redis.js';

/** Client -> server event: request membership in one or more channels. */
const SUBSCRIBE_EVENT = 'jsails:subscribe';
/** Client -> server event: leave one or more channels. */
const UNSUBSCRIBE_EVENT = 'jsails:unsubscribe';
/** Server -> client event: a JSON payload delivered to a channel's members. */
const BROADCAST_EVENT = 'jsails:event';

const DEFAULT_MAX_SUBSCRIPTIONS = 100;
const DEFAULT_MAX_CHANNEL_NAME_LENGTH = 128;
const DEFAULT_MAX_EVENT_NAME_LENGTH = 128;
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024; // 1 MiB

/** Engine.IO transport name union, derived from Socket.IO's own options. */
type TransportName = NonNullable<ServerOptions['transports']>[number];
const DEFAULT_TRANSPORTS: TransportName[] = ['websocket'];
/** Upper bound on channels a client may name in a single subscribe/unsubscribe. */
const MAX_CHANNELS_PER_REQUEST = 50;
/** Prefix applied to channel room names to avoid colliding with socket id rooms. */
const ROOM_PREFIX = 'jsails:channel:';

/**
 * The subset of the connection handshake handed to `authenticate`. The `auth`
 * object Socket.IO exposes is deliberately omitted: it is client-supplied and
 * must not be used as an identity.
 */
export interface BroadcastHandshake {
  /** Raw request headers (includes `cookie` and `authorization`). */
  readonly headers: IncomingHttpHeaders;
  /** Parsed query string from the request URL. */
  readonly query: NodeJS.Dict<string | string[]>;
}

export interface BroadcastOptions {
  /**
   * Exact-match list of allowed `Origin` header values. A connection whose
   * origin is absent or not in this list is rejected. Required and non-empty.
   */
  allowedOrigins: string[];
  /**
   * Derive the authenticated identity from the connection handshake. Return a
   * non-null identity, or `null`/`undefined` to deny the connection. Required:
   * this is the seam the application's session/authorization layer plugs into.
   */
  authenticate(handshake: BroadcastHandshake): MaybePromise<unknown>;
  /**
   * Authorize an identity for a channel. Return `true` to allow joining. When
   * omitted, every channel is denied.
   */
  authorizeChannel?(identity: unknown, channel: string): MaybePromise<boolean>;
  /** Engine.IO path. Defaults to `/_jsails/broadcast`. */
  path?: string;
  /**
   * Engine.IO transports. Defaults to `['websocket']`; enabling polling requires
   * sticky sessions in a multi-node deployment.
   */
  transports?: TransportName[];
  /** Maximum channels a single connection may join. Defaults to 100. */
  maxSubscriptions?: number;
  /** Maximum length of a channel name. Defaults to 128. */
  maxChannelNameLength?: number;
  /** Maximum length of an event name. Defaults to 128. */
  maxEventNameLength?: number;
  /** Maximum serialized JSON payload size in bytes. Defaults to 1 MiB. */
  maxPayloadBytes?: number;
  /**
   * Redis URL enabling the multi-process pub/sub adapter (recommended for
   * production). When omitted, an in-memory adapter is used and broadcasts only
   * reach clients connected to this process.
   */
  redisUrl?: string;
  /**
   * Invoked when the Redis adapter reports a runtime failure after startup
   * (for example, a dropped connection). The error is sanitized: it carries
   * only a generic message and the underlying error code, never the Redis URL
   * or its credentials. When omitted, such failures are surfaced via
   * `process.emitWarning`. Throwing or rejecting from this callback does not
   * affect the broadcast server.
   */
  onError?: (error: Error) => void;
}

interface BroadcastSocketData {
  identity: unknown;
  subscriptions: Set<string>;
}

type BroadcastServer = Server<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  BroadcastSocketData
>;
type BroadcastSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  BroadcastSocketData
>;

interface ResolvedOptions {
  readonly allowedOrigins: readonly string[];
  readonly authenticate: (handshake: BroadcastHandshake) => MaybePromise<unknown>;
  readonly authorizeChannel:
    ((identity: unknown, channel: string) => MaybePromise<boolean>) | undefined;
  readonly path: string;
  readonly transports: TransportName[];
  readonly maxSubscriptions: number;
  readonly maxChannelNameLength: number;
  readonly maxEventNameLength: number;
  readonly maxPayloadBytes: number;
  readonly redisUrl: string | undefined;
  readonly onError: ((error: Error) => void) | undefined;
}

interface SubscribeAck {
  ok: boolean;
  error?: string;
}

/**
 * Create the built-in Socket.IO {@link BroadcastAdapter}. Options are validated
 * here (synchronously) so a bad configuration fails fast; nothing is opened —
 * no Redis client is created and no Socket.IO server is constructed — until the
 * returned adapter's `attach` runs.
 */
export function createSocketIOBroadcastAdapter(options: BroadcastOptions): BroadcastAdapter {
  const opts = resolveOptions(options);
  return {
    name: 'socket.io',
    attach: (server) => attachToServer(server, opts),
  };
}

/**
 * Mount the Socket.IO server onto `server`. Initializes the Redis adapter (when
 * configured) before touching the HTTP server, so an unreachable Redis rejects
 * this promise before anything is attached and cleans up its own partial
 * resources.
 */
async function attachToServer(
  server: NodeHttpServer,
  opts: ResolvedOptions,
): Promise<BroadcastHandle> {
  let redis: RedisBroadcastAdapter | undefined;
  if (opts.redisUrl !== undefined) {
    redis = await createRedisBroadcastAdapter(opts.redisUrl, { onError: opts.onError });
  }

  const io: BroadcastServer = new Server(server, {
    path: opts.path,
    serveClient: false,
    transports: opts.transports,
  });
  if (redis !== undefined) {
    io.adapter(redis.adapter);
  }

  io.use((socket, next) => {
    authorizeConnection(socket, opts).then(
      () => next(),
      () => next(new Error('unauthorized')),
    );
  });

  io.on('connection', (socket) => {
    registerSubscriptionHandlers(socket, opts);
  });

  function emitToChannel(channel: string, event: string, data: JsonValue): void {
    assertChannelName(channel, opts.maxChannelNameLength);
    assertEventName(event, opts.maxEventNameLength);
    assertJsonPayload(data, opts.maxPayloadBytes);
    io.to(roomForChannel(channel)).emit(BROADCAST_EVENT, { channel, event, data });
  }

  let closePromise: Promise<void> | undefined;

  async function close(): Promise<void> {
    if (closePromise === undefined) {
      closePromise = performClose();
    }
    return closePromise;
  }

  async function performClose(): Promise<void> {
    let primaryError: unknown;
    try {
      await io.close();
    } catch (error) {
      primaryError = error;
    }
    if (redis !== undefined) {
      try {
        await closeRedisBroadcastAdapter(redis);
      } catch (error) {
        if (primaryError === undefined) {
          primaryError = error;
        }
      }
    }
    if (primaryError !== undefined) {
      throw primaryError;
    }
  }

  return {
    broadcast: emitToChannel,
    close,
    closesHttpServer: true,
  };
}

function resolveOptions(options: BroadcastOptions): ResolvedOptions {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('attachBroadcast requires an options object');
  }
  const { allowedOrigins, authenticate } = options;
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    throw new TypeError('allowedOrigins must be a non-empty array of exact origin strings');
  }
  for (const origin of allowedOrigins) {
    if (typeof origin !== 'string' || origin.length === 0) {
      throw new TypeError('allowedOrigins must contain only non-empty strings');
    }
  }
  if (typeof authenticate !== 'function') {
    throw new TypeError('authenticate callback is required');
  }
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new TypeError('onError must be a function');
  }
  const transports = options.transports ?? DEFAULT_TRANSPORTS;
  if (
    !Array.isArray(transports) ||
    transports.length === 0 ||
    transports.some((t) => typeof t !== 'string')
  ) {
    throw new TypeError('transports must be a non-empty array of transport names');
  }
  return {
    allowedOrigins,
    authenticate,
    authorizeChannel: options.authorizeChannel,
    path: options.path ?? BROADCAST_PATH,
    transports,
    maxSubscriptions: positiveInt(
      options.maxSubscriptions,
      DEFAULT_MAX_SUBSCRIPTIONS,
      'maxSubscriptions',
    ),
    maxChannelNameLength: positiveInt(
      options.maxChannelNameLength,
      DEFAULT_MAX_CHANNEL_NAME_LENGTH,
      'maxChannelNameLength',
    ),
    maxEventNameLength: positiveInt(
      options.maxEventNameLength,
      DEFAULT_MAX_EVENT_NAME_LENGTH,
      'maxEventNameLength',
    ),
    maxPayloadBytes: positiveInt(
      options.maxPayloadBytes,
      DEFAULT_MAX_PAYLOAD_BYTES,
      'maxPayloadBytes',
    ),
    redisUrl: options.redisUrl,
    onError: options.onError,
  };
}

function positiveInt(value: unknown, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Verify the connection origin and authenticate it. Throws on any rejection so
 * the caller can answer with a single generic error. Never surfaces callback
 * error text: a throwing/rejecting `authenticate` is treated as a denial.
 */
async function authorizeConnection(socket: BroadcastSocket, opts: ResolvedOptions): Promise<void> {
  const origin = socket.handshake.headers.origin;
  if (typeof origin !== 'string' || !opts.allowedOrigins.includes(origin)) {
    throw new Error('origin not allowed');
  }
  const identity = await resolveIdentity(socket, opts.authenticate);
  if (identity === null || identity === undefined) {
    throw new Error('unauthorized');
  }
  socket.data.identity = identity;
  socket.data.subscriptions = new Set<string>();
}

async function resolveIdentity(
  socket: BroadcastSocket,
  authenticate: ResolvedOptions['authenticate'],
): Promise<unknown> {
  try {
    return await authenticate({
      headers: socket.handshake.headers,
      query: socket.handshake.query,
    });
  } catch {
    return undefined;
  }
}

function registerSubscriptionHandlers(socket: BroadcastSocket, opts: ResolvedOptions): void {
  // Serialize subscribe/unsubscribe per socket. A concurrent burst must not
  // race the subscription cap (checked before an asynchronous authorization
  // completes) or interleave membership mutations, so each request is queued
  // behind the previous one.
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (operation: () => Promise<void>): void => {
    queue = queue.then(operation, operation);
  };

  socket.on(SUBSCRIBE_EVENT, (payload: unknown, ack?: (response: SubscribeAck) => void) => {
    enqueue(() => handleSubscribe(socket, payload, ack, opts));
  });
  socket.on(UNSUBSCRIBE_EVENT, (payload: unknown, ack?: (response: SubscribeAck) => void) => {
    enqueue(() => handleUnsubscribe(socket, payload, ack, opts));
  });
}

async function handleSubscribe(
  socket: BroadcastSocket,
  payload: unknown,
  ack: ((response: SubscribeAck) => void) | undefined,
  opts: ResolvedOptions,
): Promise<void> {
  const respond = ackOnce(ack);
  try {
    const channels = parseChannelList(payload, opts);
    if (channels === null) {
      respond({ ok: false, error: 'invalid-request' });
      return;
    }
    const subscriptions = socket.data.subscriptions;
    const newChannels = channels.filter((name) => !subscriptions.has(name));
    if (subscriptions.size + newChannels.length > opts.maxSubscriptions) {
      respond({ ok: false, error: 'too-many-subscriptions' });
      return;
    }
    const identity = socket.data.identity;
    for (const name of newChannels) {
      if (!(await isChannelAuthorized(identity, name, opts.authorizeChannel))) {
        respond({ ok: false, error: 'unauthorized' });
        return;
      }
    }
    for (const name of newChannels) {
      subscriptions.add(name);
      await socket.join(roomForChannel(name));
    }
    respond({ ok: true });
  } catch {
    respond({ ok: false, error: 'internal-error' });
  }
}

async function handleUnsubscribe(
  socket: BroadcastSocket,
  payload: unknown,
  ack: ((response: SubscribeAck) => void) | undefined,
  opts: ResolvedOptions,
): Promise<void> {
  const respond = ackOnce(ack);
  try {
    const channels = parseChannelList(payload, opts);
    if (channels === null) {
      respond({ ok: false, error: 'invalid-request' });
      return;
    }
    const subscriptions = socket.data.subscriptions;
    for (const name of channels) {
      if (subscriptions.has(name)) {
        subscriptions.delete(name);
        await socket.leave(roomForChannel(name));
      }
    }
    respond({ ok: true });
  } catch {
    respond({ ok: false, error: 'internal-error' });
  }
}

/** Default-deny: no `authorizeChannel`, no membership. Callback errors deny. */
async function isChannelAuthorized(
  identity: unknown,
  channel: string,
  authorizeChannel: ResolvedOptions['authorizeChannel'],
): Promise<boolean> {
  if (authorizeChannel === undefined) {
    return false;
  }
  try {
    return (await authorizeChannel(identity, channel)) === true;
  } catch {
    return false;
  }
}

/** Validate and deduplicate a channel list; returns `null` when invalid. */
function parseChannelList(payload: unknown, opts: ResolvedOptions): string[] | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const raw = (payload as { channels?: unknown }).channels;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CHANNELS_PER_REQUEST) {
    return null;
  }
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0 || item.length > opts.maxChannelNameLength) {
      return null;
    }
    seen.add(item);
  }
  return [...seen];
}

/** Wrap an ack so it fires at most once. */
function ackOnce(
  ack: ((response: SubscribeAck) => void) | undefined,
): (response: SubscribeAck) => void {
  if (ack === undefined) {
    return () => {};
  }
  let called = false;
  return (response: SubscribeAck): void => {
    if (called) {
      return;
    }
    called = true;
    ack(response);
  };
}

function assertChannelName(name: unknown, maxLength: number): asserts name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > maxLength) {
    throw new TypeError('channel must be a non-empty string within the configured length');
  }
}

function assertEventName(name: unknown, maxLength: number): asserts name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > maxLength) {
    throw new TypeError('event must be a non-empty string within the configured length');
  }
}

function assertJsonPayload(data: unknown, maxBytes: number): asserts data is JsonValue {
  if (!isJsonValue(data)) {
    throw new TypeError(
      'payload must be JSON-serializable (no functions, symbols, bigint, undefined, or non-plain objects)',
    );
  }
  const serialized = JSON.stringify(data);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new RangeError('payload exceeds the maximum allowed size');
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueInternal(value, new Set<object>());
}

/**
 * Cycle-safe strict JSON check: rejects non-finite numbers, functions, symbols,
 * undefined, bigint, non-plain objects, and circular references. The ancestor
 * set only tracks the current path, so shared (diamond) references stay valid.
 */
function isJsonValueInternal(value: unknown, ancestors: Set<object>): value is JsonValue {
  if (value === null) {
    return true;
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object': {
      if (ancestors.has(value)) {
        return false;
      }
      ancestors.add(value);
      let ok = true;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (!isJsonValueInternal(item, ancestors)) {
            ok = false;
            break;
          }
        }
      } else {
        const proto = Object.getPrototypeOf(value) as unknown;
        if (proto !== Object.prototype && proto !== null) {
          ancestors.delete(value);
          return false;
        }
        for (const item of Object.values(value)) {
          if (!isJsonValueInternal(item, ancestors)) {
            ok = false;
            break;
          }
        }
      }
      ancestors.delete(value);
      return ok;
    }
    default:
      return false;
  }
}

function roomForChannel(channel: string): string {
  return ROOM_PREFIX + channel;
}
