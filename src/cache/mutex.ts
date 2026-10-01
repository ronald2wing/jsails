/**
 * Task-scheduling overlap control: a narrow, atomic acquire/release lock-store
 * contract, independent from the {@link CacheStore} contract.
 *
 * A cache is pure data whose writes are always idempotent ("set this value")
 * and whose reads are always safe to retry; a mutex carries ownership and lock
 * semantics — the caller must atomically acquire a key only when it is absent,
 * and an accidental double-release must not disturb another caller's lock. A
 * {@link CacheStore} only provides a plain `set` (always overwrites), so it
 * cannot express that atomic acquire without an unsafe read-then-write gap.
 *
 * ## In-process limitation
 *
 * The built-in {@link MemoryMutexStore} guarantees mutual exclusion within a
 * single process only. In a multi-process deployment — separate `jsails work`
 * workers, or a parent process that enqueues a job and a worker that executes
 * it — the in-memory map is not shared, so two processes can both "acquire" the
 * same key concurrently. A multi-process deployment must use
 * {@link ValkeyMutexStore}, which provides the same contract backed by a shared
 * Valkey `SET key value NX PX ttl` atomic operation.
 */

/** Reserved default prefix for Valkey-backed mutex keys. */
export const DEFAULT_MUTEX_PREFIX = 'jsails:mutex';

/**
 * Raised for mutex misuse or backend failure. Value-free — never echoes the
 * key, value, or backend connection detail that could leak state or
 * credentials.
 */
export class MutexError extends Error {
  /** Stable machine code identifying the failure category. */
  readonly code: 'invalid_key' | 'invalid_ttl' | 'backend_error' | 'closed';

  constructor(code: MutexError['code'], message: string) {
    super(message);
    this.name = 'MutexError';
    this.code = code;
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
import type { ValkeyRedisClient, ValkeyCacheStoreDependencies } from './store.js';

// Retry budget moved to ./valkey-connection.js.

/**
 * Atomic acquire/release lock store.
 *
 * The acquire/release pair models a distributed mutex: a caller acquires a
 * named key with a bounded TTL, holds it while the operation runs, and
 * releases it when done. If the operation crashes, the TTL acts as a safety
 * net — the key expires automatically and the next caller can acquire it.
 */
export interface MutexStore {
  /**
   * Acquire atomically: resolves `true` only when this call created the entry
   * (the key was absent or its existing entry had already expired). Resolves
   * `false` when another caller holds the key.
   *
   * `ttlMs` is the lock lifetime in milliseconds; it must be positive and
   * finite. The entry is not refreshed — callers that hold a lock past its TTL
   * may find another caller has taken it.
   */
  acquire(key: string, ttlMs: number): Promise<boolean>;

  /**
   * Release an entry; a no-op when the key is absent. Idempotent — releasing
   * an already-released key does not error and does not disturb another
   * caller's lock.
   */
  release(key: string): Promise<void>;

  /** Release owned resources; idempotent. */
  close(): Promise<void>;
}

/** Options for {@link MemoryMutexStore}. */
export interface MemoryMutexStoreOptions {
  /** Injectable clock returning epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Options for {@link ValkeyMutexStore}.
 *
 * The store provides cross-process mutual exclusion via the atomic `SET NX PX`
 * operation on a shared Valkey/Redis backend, unlike the in-process-only memory
 * store. Construction is fully lazy: no client is created and no URL is read
 * until the first `acquire`/`release`.
 */
export interface ValkeyMutexStoreOptions {
  /** Valkey/Redis URL. Falls back to `VALKEY_URL`. */
  readonly valkeyUrl?: string;
  /** Key prefix. Defaults to {@link DEFAULT_MUTEX_PREFIX}. */
  readonly prefix?: string;
  /** Invoked with a sanitized error when a client fails after connecting. */
  readonly onError?: (error: Error) => void;
}

/**
 * In-memory mutex store backed by a `Map<key, expiresAt>`.
 * `acquire` is a synchronous check-and-set (atomic in-process): if the key is
 * absent or expired, it sets the expiry and returns `true`; otherwise it
 * returns `false`. `release` deletes the key. `close` clears the map and is
 * idempotent.
 *
 * This store holds no external resources and needs no connection. Construct
 * with `new MemoryMutexStore({ now? })`.
 */
export class MemoryMutexStore implements MutexStore {
  readonly #now: () => number;
  readonly #entries = new Map<string, number>();

  constructor(options: MemoryMutexStoreOptions = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('MemoryMutexStore requires an options object');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new TypeError('now must be a function');
    }
    this.#now = options.now ?? (() => Date.now());
  }

  async acquire(key: string, ttlMs: number): Promise<boolean> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new MutexError('invalid_key', 'key must be a non-empty string');
    }
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new MutexError('invalid_ttl', 'ttlMs must be a positive finite number');
    }
    const expiresAt = this.#entries.get(key);
    if (expiresAt !== undefined && this.#now() < expiresAt) {
      return false;
    }
    this.#entries.set(key, this.#now() + ttlMs);
    return true;
  }

  async release(key: string): Promise<void> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new MutexError('invalid_key', 'key must be a non-empty string');
    }
    this.#entries.delete(key);
  }

  async close(): Promise<void> {
    this.#entries.clear();
  }
}

/**
 * Valkey/Redis-backed mutex store with full lazy-connection discipline matching
 * {@link ValkeyCacheStore}. The store provides cross-process mutual exclusion:
 * `acquire` uses the atomic `SET key value NX PX ttlMs` command, so competing
 * processes sharing a Valkey/Redis instance see the same lock state. The
 * in-process {@link MemoryMutexStore} cannot provide that guarantee.
 *
 * Construction is inert — no client is created and no URL is read until the
 * first `acquire`/`release`. The URL is resolved with precedence `valkeyUrl` ->
 * `VALKEY_URL` and validated as an explicit `redis://`/`rediss://` URL
 * (value-free on failure). Commands use a finite retry budget and fail fast.
 * `close` disconnects the owned client exactly once and is a no-op when no
 * client was ever created. After close, every operation throws
 * `MutexError('closed', ...)`.
 */
export class ValkeyMutexStore implements MutexStore {
  readonly #options: ValkeyMutexStoreOptions;
  readonly #dependencies: ValkeyCacheStoreDependencies | undefined;
  readonly #prefix: string;
  readonly #closeOnce: () => Promise<void>;

  #client: ValkeyRedisClient | undefined;
  #connecting: Promise<ValkeyRedisClient> | undefined;
  #connected = false;
  #closed = false;

  constructor(options: ValkeyMutexStoreOptions = {}, dependencies?: ValkeyCacheStoreDependencies) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('ValkeyMutexStore requires an options object');
    }
    if (options.onError !== undefined && typeof options.onError !== 'function') {
      throw new TypeError('onError must be a function');
    }
    this.#options = options;
    this.#dependencies = dependencies;
    this.#prefix = resolveValkeyPrefix(options.prefix, DEFAULT_MUTEX_PREFIX);
    // Concurrent-safe teardown: two simultaneous `close()` calls share one
    // disconnect.
    this.#closeOnce = createCleanup(async () => {
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
    });
  }

  #keyFor(key: string): string {
    return `${this.#prefix}:${key}`;
  }

  #makeError(message: string, _code?: string): MutexError {
    return new MutexError('backend_error', message);
  }

  async #ensureClient(): Promise<ValkeyRedisClient> {
    if (this.#closed) {
      throw new MutexError('closed', 'mutex store is closed');
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
      throw new MutexError(
        'backend_error',
        'no Valkey/Redis URL configured: set valkeyUrl or VALKEY_URL',
      );
    }
    const url = assertValkeyUrl(rawUrl, (message) => new MutexError('backend_error', message));
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
          reportValkeyError(error, this.#options.onError, 'mutex', (m, c) => this.#makeError(m, c));
        }
      });
      await instance.connect();
      this.#connected = true;
      return instance;
    } catch (error) {
      disconnectQuietly(instance);
      throw sanitizeValkeyError(error, 'mutex', (m, c) => this.#makeError(m, c));
    }
  }

  async acquire(key: string, ttlMs: number): Promise<boolean> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new MutexError('invalid_key', 'key must be a non-empty string');
    }
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new MutexError('invalid_ttl', 'ttlMs must be a positive finite number');
    }
    const c = await this.#ensureClient();
    try {
      const result = await c.set(this.#keyFor(key), '1', 'PX', ttlMs, 'NX');
      return result === 'OK';
    } catch (error) {
      throw sanitizeValkeyError(error, 'mutex', (m, c2) => this.#makeError(m, c2));
    }
  }

  async release(key: string): Promise<void> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new MutexError('invalid_key', 'key must be a non-empty string');
    }
    const c = await this.#ensureClient();
    try {
      await c.del(this.#keyFor(key));
    } catch (error) {
      throw sanitizeValkeyError(error, 'mutex', (m, c2) => this.#makeError(m, c2));
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#closeOnce();
  }
}
