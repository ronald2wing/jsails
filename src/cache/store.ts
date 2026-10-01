/**
 * Cache store: a narrow, string-keyed, TTL-bounded cache contract plus two
 * built-in implementations.
 *
 * - {@link MemoryCacheStore} is the zero-config default: an in-memory
 *   store with an injectable clock (no connection), used for tests, demos, and
 *   single-process deployments.
 * - {@link ValkeyCacheStore} is a Valkey/Redis-backed store over ioredis.
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

/** Options for {@link MemoryCacheStore}. */
export interface MemoryCacheStoreOptions {
  /** Injectable clock returning epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * In-memory cache store. It holds no external resources: `close` drops the
 * entries and any in-flight bookkeeping, and is idempotent. Construct with
 * `new MemoryCacheStore({ now? })`.
 */
export class MemoryCacheStore implements CacheStore {
  readonly #now: () => number;
  readonly #entries = new Map<string, { value: string; expiresAt: number }>();
  readonly #inFlight = new Map<string, Promise<string>>();

  constructor(options: MemoryCacheStoreOptions = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('MemoryCacheStore requires an options object');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new TypeError('now must be a function');
    }
    this.#now = options.now ?? (() => Date.now());
  }

  async get(key: string): Promise<string | null> {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (this.#now() >= entry.expiresAt) {
      this.#entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.#entries.set(key, { value, expiresAt: this.#now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  async remember(key: string, ttlMs: number, loader: () => Promise<string>): Promise<string> {
    return rememberWith(this, this.#inFlight, key, ttlMs, loader);
  }

  async close(): Promise<void> {
    this.#entries.clear();
    this.#inFlight.clear();
  }
}

/** Options for {@link ValkeyCacheStore}. */
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
 * Valkey/Redis-backed cache store over ioredis.
 *
 * Construction is fully lazy: no client is created and no URL is read until the
 * first `get`/`set`/`delete`/`remember`. The URL is resolved with the precedence
 * `valkeyUrl` -> `VALKEY_URL` and validated as an
 * explicit `redis://`/`rediss://` URL (value-free on failure). Commands use a
 * finite retry budget and fail fast rather than queueing while the backend is
 * unreachable. `close` disconnects the owned client exactly once and is a no-op
 * when no client was ever created.
 */
export class ValkeyCacheStore implements CacheStore {
  readonly #options: ValkeyCacheStoreOptions;
  readonly #dependencies: ValkeyCacheStoreDependencies | undefined;
  readonly #prefix: string;
  readonly #inFlight = new Map<string, Promise<string>>();

  #client: ValkeyRedisClient | undefined;
  #connecting: Promise<ValkeyRedisClient> | undefined;
  #connected = false;
  #closed = false;

  constructor(options: ValkeyCacheStoreOptions = {}, dependencies?: ValkeyCacheStoreDependencies) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('ValkeyCacheStore requires an options object');
    }
    if (options.onError !== undefined && typeof options.onError !== 'function') {
      throw new TypeError('onError must be a function');
    }
    this.#options = options;
    this.#dependencies = dependencies;
    this.#prefix = resolveValkeyPrefix(options.prefix, DEFAULT_CACHE_PREFIX);
  }

  #keyFor(key: string): string {
    return `${this.#prefix}:${key}`;
  }

  #makeError(message: string, code?: string): CacheError {
    return new CacheError(message, { code });
  }

  async #ensureClient(): Promise<ValkeyRedisClient> {
    if (this.#closed) {
      throw new CacheError('cache store is closed');
    }
    if (this.#client !== undefined) {
      return this.#client;
    }
    this.#connecting ??= this.#connect();
    try {
      this.#client = await this.#connecting;
      return this.#client;
    } catch (error) {
      // A failed connect is not memoized: the next operation retries.
      this.#connecting = undefined;
      throw error;
    }
  }

  async #connect(): Promise<ValkeyRedisClient> {
    const RedisClient = this.#dependencies?.RedisClient ?? (await loadValkeyRedisClient());
    const rawUrl = resolveValkeyUrl(this.#options);
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
        if (this.#connected) {
          reportValkeyError(error, this.#options.onError, 'cache', (m, c) => this.#makeError(m, c));
        }
      });
      await instance.connect();
      this.#connected = true;
      return instance;
    } catch (error) {
      disconnectQuietly(instance);
      throw sanitizeValkeyError(error, 'cache', (m, c) => this.#makeError(m, c));
    }
  }

  async get(key: string): Promise<string | null> {
    const c = await this.#ensureClient();
    try {
      return await c.get(this.#keyFor(key));
    } catch (error) {
      throw sanitizeValkeyError(error, 'cache', (m, c2) => this.#makeError(m, c2));
    }
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    const c = await this.#ensureClient();
    try {
      await c.set(this.#keyFor(key), value, 'PX', ttlMs);
    } catch (error) {
      throw sanitizeValkeyError(error, 'cache', (m, c2) => this.#makeError(m, c2));
    }
  }

  async delete(key: string): Promise<void> {
    const c = await this.#ensureClient();
    try {
      await c.del(this.#keyFor(key));
    } catch (error) {
      throw sanitizeValkeyError(error, 'cache', (m, c2) => this.#makeError(m, c2));
    }
  }

  async remember(key: string, ttlMs: number, loader: () => Promise<string>): Promise<string> {
    return rememberWith(this, this.#inFlight, key, ttlMs, loader);
  }

  /**
   * Concurrent-safe teardown: two simultaneous `close()` calls share one
   * disconnect. `#closed` is still set synchronously by `close()` so a racing
   * operation is rejected before the client is torn down.
   */
  async close(): Promise<void> {
    this.#closed = true;
    const c = this.#client;
    this.#client = undefined;
    this.#connecting = undefined;
    if (c === undefined) {
      return;
    }
    try {
      await c.disconnect();
    } catch {
      // Teardown errors are ignored: shutdown must complete even if the
      // backend is already unreachable.
    }
  }
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
