/**
 * Redis adapter wiring for multi-process broadcast.
 *
 * The Redis adapter is optional: it is only constructed when the caller passes
 * a `redisUrl` to `attachBroadcast`. Importing this module has no side effects —
 * `ioredis` and `@socket.io/redis-adapter` are loaded lazily inside
 * {@link createRedisBroadcastAdapter}, so a single-process deployment never pays
 * for Redis and a failed Redis connection never leaves a half-attached server.
 *
 * Two dedicated clients are created (a publisher and a subscriber) as the
 * adapter requires; both are private to the broadcast module and are closed by
 * {@link closeRedisBroadcastAdapter} when the server shuts down.
 *
 * Error handling is non-silent by design. Connection failures reject the
 * factory promise with a sanitized error, while post-connect failures (a
 * dropped connection, a failed reconnect) are routed to the caller's `onError`
 * callback or, when absent, to `process.emitWarning`. No error path ever
 * echoes the Redis URL: it may embed credentials.
 */

import type { Adapter } from 'socket.io-adapter';
import type { Redis } from 'ioredis';
import { errnoCode } from '../internal/errors.js';

export interface RedisBroadcastAdapter {
  /** Adapter factory suitable for `io.adapter(...)`. */
  readonly adapter: (nsp: unknown) => Adapter;
  /** Owned publisher client. */
  readonly pub: Redis;
  /** Owned subscriber client. */
  readonly sub: Redis;
}

/** Options controlling Redis adapter error surfacing. */
interface RedisBroadcastAdapterOptions {
  /** Invoked with a sanitized error when a client fails after connecting. */
  onError?: (error: Error) => void;
}

/** The slice of an ioredis client the adapter depends on. */
interface RedisClientLike {
  duplicate(): RedisClientLike;
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  on(event: 'error', listener: (error: unknown) => void): void;
}

/**
 * Test seam: the ioredis constructor and the Socket.IO Redis adapter factory.
 * Injectable so tests can exercise lifecycle faults without a live Redis. This
 * is a module-internal export (not re-exported from the public package), used
 * only to mock the backend for the failure paths that a real connection cannot
 * reach deterministically.
 */
export interface RedisBroadcastAdapterDependencies {
  readonly RedisClient: new (url: string, options: object) => RedisClientLike;
  readonly createAdapter: (pub: Redis, sub: Redis) => (nsp: unknown) => Adapter;
}

/** Load the real ioredis class and Socket.IO adapter factory lazily. */
async function loadDependencies(): Promise<RedisBroadcastAdapterDependencies> {
  const [{ Redis: RedisClient }, { createAdapter }] = await Promise.all([
    import('ioredis'),
    import('@socket.io/redis-adapter'),
  ]);
  return {
    RedisClient: RedisClient as unknown as RedisBroadcastAdapterDependencies['RedisClient'],
    createAdapter: createAdapter as unknown as RedisBroadcastAdapterDependencies['createAdapter'],
  };
}

/**
 * Create a Redis-backed Socket.IO adapter bound to `redisUrl`.
 *
 * Client construction, duplication, and connection are all performed inside a
 * single failure boundary so any failure — including a constructor/duplicate
 * throw before `connect()` — leaves no half-initialized clients behind and is
 * rethrown with a generic message (the URL may contain credentials and is never
 * echoed). On failure, any clients created so far are disconnected before the
 * error is rethrown.
 */
export async function createRedisBroadcastAdapter(
  redisUrl: string,
  options: RedisBroadcastAdapterOptions = {},
  dependencies?: RedisBroadcastAdapterDependencies,
): Promise<RedisBroadcastAdapter> {
  const { RedisClient, createAdapter } = dependencies ?? (await loadDependencies());

  let connected = false;
  // Post-connect failures (drops, failed reconnects) are observable. Connect
  // failures are instead reported through the rejected promise, so this handler
  // stays silent until both clients are up.
  const reportError = (error: unknown): void => {
    if (connected) {
      reportRedisError(error, options.onError);
    }
  };

  let pub: RedisClientLike | undefined;
  let sub: RedisClientLike | undefined;
  try {
    pub = new RedisClient(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
    sub = pub.duplicate();
    pub.on('error', reportError);
    sub.on('error', reportError);
    await Promise.all([pub.connect(), sub.connect()]);
    connected = true;
  } catch (error) {
    disconnectQuietly(sub);
    disconnectQuietly(pub);
    throw new Error('failed to connect to the Redis broadcast adapter', {
      cause: sanitizeRedisError(error),
    });
  }

  return {
    adapter: createAdapter(pub as unknown as Redis, sub as unknown as Redis),
    pub: pub as unknown as Redis,
    sub: sub as unknown as Redis,
  };
}

/**
 * Close the owned Redis clients. Errors during teardown are ignored: shutdown
 * must complete even if Redis is already unreachable.
 */
export async function closeRedisBroadcastAdapter(adapter: RedisBroadcastAdapter): Promise<void> {
  await Promise.all(
    [adapter.pub, adapter.sub].map(async (client) => {
      try {
        await Promise.resolve(client.disconnect());
      } catch {
        // Errors during teardown are ignored: shutdown must complete even if
        // Redis is already unreachable.
      }
    }),
  );
}

/** Reduce a backend error to a payload-free `Error` that cannot echo the URL. */
function sanitizeRedisError(error: unknown): Error {
  const code = errnoCode(error);
  return new Error(
    code === undefined
      ? 'Redis broadcast adapter error'
      : `Redis broadcast adapter error (${code})`,
  );
}

/**
 * Surface a post-connect backend error to `onError`, falling back to a generic
 * warning. The observer is guarded so a throwing or rejecting handler never
 * becomes an unhandled rejection that could crash the process.
 */
function reportRedisError(error: unknown, onError: ((error: Error) => void) | undefined): void {
  const sanitized = sanitizeRedisError(error);
  if (onError === undefined) {
    process.emitWarning(sanitized);
    return;
  }
  try {
    void Promise.resolve(onError(sanitized)).catch(() => {
      // A rejecting observer must not surface as an unhandled rejection.
    });
  } catch {
    // A throwing observer is ignored; it must not take down the server.
  }
}

/** Best-effort disconnect used on the failure path; the primary error wins. */
function disconnectQuietly(client: RedisClientLike | undefined): void {
  if (client === undefined) {
    return;
  }
  try {
    void client.disconnect().catch(() => {
      // Teardown on the error path is best-effort.
    });
  } catch {
    // A synchronous disconnect failure is irrelevant to the reported error.
  }
}
