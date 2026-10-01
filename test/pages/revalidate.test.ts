/**
 * On-demand revalidation: `revalidatePath` / `revalidateTag` purge cached
 * page entries through the per-store reverse index + store delete.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryCacheStore } from '../../src/cache/store.js';
import { cacheToken } from '../../src/cache/index.js';
import { revalidatePath, revalidateTag, recordPageCacheKey } from '../../src/pages/revalidate.js';

// A minimal context carrying a cache store under the cache token.
function contextWithStore(store = new MemoryCacheStore()): {
  store: MemoryCacheStore;
  services: { tryGet: <T>(token: unknown) => T | undefined };
} {
  return {
    store,
    services: {
      tryGet: <T>(token: unknown): T | undefined => {
        if (token === cacheToken) return store as unknown as T;
        return undefined;
      },
    },
  };
}

describe('on-demand revalidation', () => {
  it('revalidatePath deletes every key recorded under the path', async () => {
    const { store, services } = contextWithStore();
    await store.set('jsails:page:/blog:a=1', 'one', 60_000);
    await store.set('jsails:page:/blog:a=2', 'two', 60_000);
    recordPageCacheKey(store, 'jsails:page:/blog:a=1', '/blog', []);
    recordPageCacheKey(store, 'jsails:page:/blog:a=2', '/blog', []);

    await revalidatePath('/blog', {}, { services });

    assert.equal(await store.get('jsails:page:/blog:a=1'), null);
    assert.equal(await store.get('jsails:page:/blog:a=2'), null);
  });

  it('revalidateTag deletes keys recorded under the tag, not others', async () => {
    const { store, services } = contextWithStore();
    await store.set('jsails:page:/blog:tagged', 'tagged', 60_000);
    await store.set('jsails:page:/blog:untagged', 'untagged', 60_000);
    recordPageCacheKey(store, 'jsails:page:/blog:tagged', '/blog', ['posts']);
    recordPageCacheKey(store, 'jsails:page:/blog:untagged', '/blog', []);

    await revalidateTag('posts', { services });

    assert.equal(await store.get('jsails:page:/blog:tagged'), null);
    assert.equal(await store.get('jsails:page:/blog:untagged'), 'untagged');
  });

  it('an invalid tag purges nothing without throwing', async () => {
    const { services } = contextWithStore();
    await assert.doesNotReject(revalidateTag('', { services }));
    await assert.doesNotReject(revalidateTag('bad\0tag', { services }));
  });

  it('normalizes a non-/ path and purges via a fresh store index', async () => {
    const { store, services } = contextWithStore();
    await store.set('k1', 'v', 60_000);
    recordPageCacheKey(store, 'k1', 'blog', []);

    await revalidatePath('blog', {}, { services });
    assert.equal(await store.get('k1'), null);
  });

  it('does not leak index state across distinct store instances', async () => {
    const a = contextWithStore();
    const b = contextWithStore();
    await a.store.set('ka', 'va', 60_000);
    await b.store.set('kb', 'vb', 60_000);
    recordPageCacheKey(a.store, 'ka', '/shared', []);
    recordPageCacheKey(b.store, 'kb', '/other', []);

    await revalidatePath('/shared', {}, { services: a.services });
    // b's key is unaffected because the index is per-store.
    assert.equal(await a.store.get('ka'), null);
    assert.equal(await b.store.get('kb'), 'vb');
  });

  it('is a silent no-op without a store', async () => {
    await assert.doesNotReject(revalidatePath('/blog', {}, undefined));
    await assert.doesNotReject(revalidateTag('posts', undefined));
  });
});
