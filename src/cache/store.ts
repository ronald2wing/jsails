/**
 * Cache store: a narrow, string-keyed, TTL-bounded cache contract plus two
 * built-in implementations.
 *
 * - {@link createMemoryCacheStore} is the zero-config default: an in-memory
 *   store with an injectable clock (no connection), used for tests, demos, and
 *   single-process deployments.
 * - {@link createValkeyCacheStore} is a Valkey/Redis-backed store over ioredis.
 *   It is fully lazy: importing this module loads no ioredis, constructing the
 *   store opens no connection, and the client is created and connected on the
 *   first operation only. Keys are namespaced under a prefix, commands use a
 *   finite retry budget and fail fast, and every error surfaced to the caller
 *   is a value-free {@link CacheError} — a connection URL may embed credentials
 *   and is never echoed.
 *
 * Both stores implement {@link CacheStore}, whose `remember` deduplicates
 * concurrent loads for the same key within the process (a later caller joins
 * the in-flight load instead of starting a duplicate).
 */

/** Default key prefix for the Valkey-backed store. */
export const DEFAULT_CACHE_PREFIX = 'jsails:cache';

// Retry budget moved to ./valkey-connection.js.

/**
 * Raised for every cache failure that reaches the caller. Messages are
 * value-free: no URL, key, or backend detail that could leak credentials is
 * ever embedded.
 */
export class CacheError extends Error {
  /** Stable machine code extracted from the underlying error, when available. */
  readonly code: string | undefined;

  constructor(message: string, options?: { code?: string }) {
    super(message);
    this.name = 'CacheError';
    this.code = options?.code;
  }
}

import {
  VALKEY_MAX_RETRIES_PER_REQUEST,
  resolveValkeyPrefix,
  resolveValkeyUrl,
  assertValkeyUrl,
  sanitizeValkeyError,
  reportValkeyError,
  disconnectQuietly,
  loadValkeyRedisClient,
} from './valkey-connection.js';
import { createCleanup } from '../internal/cleanup.js';

/**
 * A string-keyed cache with TTL-bounded entries and an in-flight-deduplicating
 * `remember`. Implementations own their connection; `close` is idempotent.
 */
export interface CacheStore {
  /** Read an entry, or `null` when absent or expired. */
  get(key: string): Promise<string | null>;
  /** Write an entry that expires `ttlMs` milliseconds from now. */
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** Remove an entry; a no-op when absent. */
  delete(key: string): Promise<void>;
  /** Get-or-load: deduplicates concurrent loads for the same key in-process. */
  remember(key: string, ttlMs: number, loader: () => Promise<string>): Promise<string>;
  /** Release owned resources; idempotent. */
  close(): Promise<void>;
}

/** Options for {@link createMemoryCacheStore}. */
export interface MemoryCacheStoreOptions {
  /** Injectable clock returning epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Create an in-memory cache store. It holds no external resources: `close`
 * drops the entries and any in-flight bookkeeping, and is idempotent.
 */
export function createMemoryCacheStore(options: MemoryCacheStoreOptions = {}): CacheStore {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createMemoryCacheStore requires an options object');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('now must be a function');
  }
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, { value: string; expiresAt: number }>();
  const inFlight = new Map<string, Promise<string>>();

  const get = async (key: string): Promise<string | null> => {
    const entry = entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (now() >= entry.expiresAt) {
      entries.delete(key);
      return null;
    }
    return entry.value;
  };

  const set = async (key: string, value: string, ttlMs: number): Promise<void> => {
    entries.set(key, { value, expiresAt: now() + ttlMs });
  };

  const remove = async (key: string): Promise<void> => {
    entries.delete(key);
  };

  return {
    get,
    set,
    delete: remove,
    remember: (key, ttlMs, loader) => rememberWith({ get, set }, inFlight, key, ttlMs, loader),
    async close() {
      entries.clear();
      inFlight.clear();
    },
  };
}

/** Options for {@link createValkeyCacheStore}. */
export interface ValkeyCacheStoreOptions {
  /** Valkey/Redis URL. */
  readonly valkeyUrl?: string;
  /** Key prefix. Defaults to {@link DEFAULT_CACHE_PREFIX}. */
  readonly prefix?: string;
  /** Invoked with a sanitized error when a client fails after connecting. */
  readonly onError?: (error: Error) => void;
}

/** The slice of an ioredis client the Valkey store depends on. */
export interface ValkeyRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  set(key: string, value: string, mode: 'PX', ttlMs: number, condition: 'NX'): Promise<'OK' | null>;
  del(key: string): Promise<number>;
  connect(): Promise<unknown>;
  disconnect(): Promise<void>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

/**
 * Test seam: the ioredis constructor. Injectable so tests can exercise lazy
 * connect, close idempotency, and value-free error paths without a live Valkey.
 * This is a module-internal export (not re-exported from the `jsails/cache`
 * entry); the real ioredis class is loaded lazily when the seam is absent.
 */
export interface ValkeyCacheStoreDependencies {
  readonly RedisClient: new (url: string, options: object) => ValkeyRedisClient;
}

/**
 * Create a Valkey/Redis-backed cache store over ioredis.
 *
 * Construction is fully lazy: no client is created and no URL is read until the
 * first `get`/`set`/`delete`/`remember`. The URL is resolved with the precedence
 * `valkeyUrl` -> `VALKEY_URL` and validated as an
 * explicit `redis://`/`rediss://` URL (value-free on failure). Commands use a
 * finite retry budget and fail fast rather than queueing while the backend is
 * unreachable. `close` disconnects the owned client exactly once and is a no-op
 * when no client was ever created.
 */
export function createValkeyCacheStore(
  options: ValkeyCacheStoreOptions = {},
  dependencies?: ValkeyCacheStoreDependencies,
): CacheStore {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createValkeyCacheStore requires an options object');
  }
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new TypeError('onError must be a function');
  }
  const prefix = resolveValkeyPrefix(options.prefix, DEFAULT_CACHE_PREFIX);
  const inFlight = new Map<string, Promise<string>>();

  let client: ValkeyRedisClient | undefined;
  let connecting: Promise<ValkeyRedisClient> | undefined;
  let connected = false;
  let closed = false;

  const keyFor = (key: string): string => `${prefix}:${key}`;

  const ensureClient = async (): Promise<ValkeyRedisClient> => {
    if (closed) {
      throw new CacheError('cache store is closed');
    }
    if (client !== undefined) {
      return client;
    }
    connecting ??= connect();
    try {
      client = await connecting;
      return client;
    } catch (error) {
      // A failed connect is not memoized: the next operation retries.
      connecting = undefined;
      throw error;
    }
  };

  const cacheMakeError = (message: string, code?: string) => new CacheError(message, { code });

  async function connect(): Promise<ValkeyRedisClient> {
    const RedisClient = dependencies?.RedisClient ?? (await loadValkeyRedisClient());
    const rawUrl = resolveValkeyUrl(options);
    if (rawUrl === undefined) {
      throw new CacheError('no Valkey/Redis URL configured: set valkeyUrl or VALKEY_URL');
    }
    const url = assertValkeyUrl(rawUrl, (message) => new CacheError(message));
    let instance: ValkeyRedisClient | undefined;
    try {
      instance = new RedisClient(url, {
        lazyConnect: true,
        maxRetriesPerRequest: VALKEY_MAX_RETRIES_PER_REQUEST,
        enableOfflineQueue: false,
      });
      // Connect failures reject the promise above; only post-connect failures
      // (drops, failed reconnects) are routed to the observer.
      instance.on('error', (error) => {
        if (connected) {
          reportValkeyError(error, options.onError, 'cache', cacheMakeError);
        }
      });
      await instance.connect();
      connected = true;
      return instance;
    } catch (error) {
      disconnectQuietly(instance);
      throw sanitizeValkeyError(error, 'cache', cacheMakeError);
    }
  }

  const get = async (key: string): Promise<string | null> => {
    const c = await ensureClient();
    try {
      return await c.get(keyFor(key));
    } catch (error) {
      throw sanitizeValkeyError(error, 'cache', cacheMakeError);
    }
  };

  const set = async (key: string, value: string, ttlMs: number): Promise<void> => {
    const c = await ensureClient();
    try {
      await c.set(keyFor(key), value, 'PX', ttlMs);
    } catch (error) {
      throw sanitizeValkeyError(error, 'cache', cacheMakeError);
    }
  };

  const remove = async (key: string): Promise<void> => {
    const c = await ensureClient();
    try {
      await c.del(keyFor(key));
    } catch (error) {
      throw sanitizeValkeyError(error, 'cache', cacheMakeError);
    }
  };

  // Concurrent-safe teardown: two simultaneous `close()` calls share one
  // disconnect. `closed` is still set synchronously by `close()` so a racing
  // operation is rejected before the client is torn down.
  const closeOnce = createCleanup(async () => {
    const c = client;
    client = undefined;
    connecting = undefined;
    if (c === undefined) {
      return;
    }
    try {
      await c.disconnect();
    } catch {
      // Teardown errors are ignored: shutdown must complete even if the
      // backend is already unreachable.
    }
  });

  return {
    get,
    set,
    delete: remove,
    remember: (key, ttlMs, loader) => rememberWith({ get, set }, inFlight, key, ttlMs, loader),
    async close() {
      closed = true;
      await closeOnce();
    },
  };
}

/** Shared get-or-load with in-process in-flight dedupe for both stores. */
async function rememberWith(
  store: Pick<CacheStore, 'get' | 'set'>,
  inFlight: Map<string, Promise<string>>,
  key: string,
  ttlMs: number,
  loader: () => Promise<string>,
): Promise<string> {
  const cached = await store.get(key);
  if (cached !== null) {
    return cached;
  }
  const existing = inFlight.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const promise = (async () => {
    const value = await loader();
    await store.set(key, value, ttlMs);
    return value;
  })();
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}
