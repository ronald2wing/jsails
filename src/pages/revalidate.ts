/**
 * On-demand revalidation — purge cached pages by path or by tag.
 *
 * The Next.js `revalidatePath` / `revalidateTag` analog, on top of the same
 * cache store the page `revalidate` (ISR) path uses. A page that opts into
 * caching may also declare `tags: string[]`; when its props are cached, the
 * cache key is recorded in a reverse index (path → keys, tag → keys). The index
 * is keyed **per cache store** (a `WeakMap`), so two apps / two stores never
 * share or leak invalidation state — matching the framework's no-global-registry
 * discipline.
 *
 * `revalidatePath` / `revalidateTag` delete every recorded key through the same
 * store. Revalidation is graceful-degradation: a purge that fails falls back to
 * TTL expiry, never throws to the caller.
 */

import { cacheToken } from '../cache/index.js';
import type { CacheStore } from '../cache/store.js';

// ---------------------------------------------------------------------------
// Reverse index (per store)
// ---------------------------------------------------------------------------

class RevalidationIndex {
  readonly #paths = new Map<string, Set<string>>();
  readonly #tags = new Map<string, Set<string>>();

  record(key: string, path: string, tags: readonly string[]): void {
    this.#recordPath(key, path);
    for (const tag of tags) {
      this.#recordTag(key, tag);
    }
  }

  keysForPath(path: string): string[] {
    return [...(this.#paths.get(path) ?? new Set<string>())];
  }

  keysForTag(tag: string): string[] {
    return [...(this.#tags.get(tag) ?? new Set<string>())];
  }

  removeKey(key: string): void {
    for (const keys of this.#paths.values()) keys.delete(key);
    for (const keys of this.#tags.values()) keys.delete(key);
  }

  #recordPath(key: string, path: string): void {
    const keys = this.#paths.get(path) ?? new Set<string>();
    keys.add(key);
    this.#paths.set(path, keys);
  }

  #recordTag(key: string, tag: string): void {
    const keys = this.#tags.get(tag) ?? new Set<string>();
    keys.add(key);
    this.#tags.set(tag, keys);
  }
}

/** Reverse indexes, keyed by cache-store identity (never a global singleton). */
const indexes = new WeakMap<CacheStore, RevalidationIndex>();

function indexFor(store: CacheStore): RevalidationIndex {
  const existing = indexes.get(store);
  if (existing !== undefined) return existing;
  const created = new RevalidationIndex();
  indexes.set(store, created);
  return created;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** A minimal carrier of the request context needed to resolve the cache store. */
export interface RevalidationContext {
  readonly services?: {
    readonly tryGet?: <T>(token: unknown) => T | undefined;
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a cache key under its route path and tags. Called by the page cache
 * writer with the same store instance it caches through.
 */
export function recordPageCacheKey(
  store: CacheStore,
  key: string,
  path: string,
  tags: readonly string[],
): void {
  indexFor(store).record(key, normalizePath(path), tags);
}

/** Options for {@link revalidatePath}. */
export interface RevalidatePathOptions {
  /** Reserved for future layout-scoped invalidation; treated as a page purge. */
  readonly type?: 'page' | 'layout';
}

/**
 * Invalidate every cached page recorded under `path`. Resolves the cache store
 * lazily from the context; without a store this is a silent no-op.
 */
export async function revalidatePath(
  path: string,
  options: RevalidatePathOptions = {},
  context?: RevalidationContext,
): Promise<void> {
  void options;
  const store = tryResolveCacheStore(context);
  if (store === undefined) return;

  const index = indexFor(store);
  for (const key of index.keysForPath(normalizePath(path))) {
    try {
      await store.delete(key);
    } catch {
      // Fall back to TTL expiry; revalidation is never a source of errors.
    }
    index.removeKey(key);
  }
}

/** Invalidate every cached page recorded under `tag`. */
export async function revalidateTag(tag: string, context?: RevalidationContext): Promise<void> {
  if (typeof tag !== 'string' || tag.trim() === '' || tag.includes('\0')) {
    return; // Value-free: an invalid tag purges nothing rather than throwing.
  }
  const store = tryResolveCacheStore(context);
  if (store === undefined) return;

  const index = indexFor(store);
  for (const key of index.keysForTag(tag)) {
    try {
      await store.delete(key);
    } catch {
      // Fall back to TTL expiry.
    }
    index.removeKey(key);
  }
}

/** Normalize a revalidation path to an absolute, single-slash path. */
function normalizePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) return '/';
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  return withSlash.replace(/\/+/g, '/');
}

/** Resolve the cache store from an optional context, failing closed to undefined. */
function tryResolveCacheStore(context?: RevalidationContext): CacheStore | undefined {
  if (context === undefined) return undefined;
  try {
    return context.services?.tryGet?.(cacheToken);
  } catch {
    return undefined;
  }
}
