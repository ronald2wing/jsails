/**
 * Cache + rate limiting: a narrow string-keyed cache contract with an
 * in-memory default and an optional Valkey/Redis backend, plus a fixed-window
 * rate limiter over the same store.
 */

export {
  CacheError,
  DEFAULT_CACHE_PREFIX,
  createMemoryCacheStore,
  createValkeyCacheStore,
  type CacheStore,
  type MemoryCacheStoreOptions,
  type ValkeyCacheStoreOptions,
} from './store.js';

export {
  DEFAULT_MUTEX_PREFIX,
  MutexError,
  createMemoryMutexStore,
  createValkeyMutexStore,
  type MemoryMutexStoreOptions,
  type MutexStore,
  type ValkeyMutexStoreOptions,
} from './mutex.js';

export {
  createRateLimiter,
  guardRateLimit,
  rateLimitResponse,
  type RateLimiter,
  type RateLimiterOptions,
  type RateLimitResult,
} from './limiter.js';

export { cachePlugin, cacheToken, type CachePluginOptions } from './plugin.js';

export { mutexPlugin, mutexToken, type MutexPluginOptions } from './mutex-plugin.js';

// The declarative loader calls `mod.default(options)`, so every first-party
// subpath barrel must default-export its factory alongside the named export.
export { cachePlugin as default } from './plugin.js';
