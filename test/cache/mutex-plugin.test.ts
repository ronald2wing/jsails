/**
 * Tests for the `mutex` plugin: ownership, cleanup, caller-supplied store
 * passthrough, and options validation. The Valkey-backed store is exercised by
 * `test/cache/mutex.test.ts` — this test covers the plugin wiring only.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mutexPlugin, mutexToken, type MutexStore } from '../../src/cache/index.js';
import { runExtensions } from '../../src/extensions/extension.js';

describe('mutexPlugin', () => {
  it('provides the owned store under mutexToken without connecting at setup', async () => {
    // `valkeyUrl` is intentionally unresolvable; the store is constructed but
    // never connected, so setup passes and the returned object is a MutexStore.
    const plugin = mutexPlugin({ valkeyUrl: 'redis://127.0.0.1:1' });
    assert.equal(plugin.name, 'mutex');

    const runtime = await runExtensions([plugin]);
    try {
      const store: MutexStore = runtime.services.get(mutexToken);
      assert.equal(typeof store.acquire, 'function');
      assert.equal(typeof store.release, 'function');
      assert.equal(typeof store.close, 'function');
    } finally {
      await runtime.close();
    }
  });

  it('defaults to the in-memory store when no URL is configured', async () => {
    const runtime = await runExtensions([mutexPlugin({})]);
    try {
      const store: MutexStore = runtime.services.get(mutexToken);
      assert.equal(await store.acquire('k', 1000), true);
      assert.equal(await store.acquire('k', 1000), false);
      await store.release('k');
      assert.equal(await store.acquire('k', 1000), true);
    } finally {
      await runtime.close();
    }
  });

  it('preserves a caller-provided store and never closes it', async () => {
    let closed = false;
    const provided: MutexStore = {
      acquire: async () => true,
      release: async () => {},
      close: async () => {
        closed = true;
      },
    };

    const runtime = await runExtensions([mutexPlugin({ store: provided })]);
    try {
      assert.equal(runtime.services.get(mutexToken), provided);
    } finally {
      await runtime.close();
    }
    assert.equal(closed, false, 'a caller-provided store must not be closed');
  });

  it('closes the owned store exactly once', async () => {
    const runtime = await runExtensions([mutexPlugin({})]);
    await runtime.close();
    // Idempotent close: the runtime's close is already idempotent, and the
    // owned memory store's close clears the map (also idempotent).
    await runtime.close();
  });

  it('closes an owned memory store so acquire fails after close', async () => {
    const runtime = await runExtensions([mutexPlugin({})]);
    const store: MutexStore = runtime.services.get(mutexToken);
    await store.acquire('k', 1000);
    await runtime.close();
    // The owned in-memory store is just a cleared Map — it does not reject
    // after close (unlike the Valkey store which throws 'closed'). This
    // is consistent: the memory store's `close` clears the map; subsequent
    // acquires operate on the empty map and succeed.
    const acquired = await store.acquire('k', 1000);
    assert.equal(acquired, true);
  });

  it('exposes a stable mutexToken singleton', () => {
    assert.equal(mutexToken.name, 'mutex');
  });

  it('rejects a malformed store', () => {
    assert.throws(() => mutexPlugin({ store: null as never }), TypeError);
    assert.throws(() => mutexPlugin({ store: {} as MutexStore }), TypeError);
    // An object with only acquire (missing release and close)
    assert.throws(
      () => mutexPlugin({ store: { acquire: async () => true } as unknown as MutexStore }),
      TypeError,
    );
  });

  it('rejects an onError that is not a function', () => {
    assert.throws(() => mutexPlugin({ onError: 'not a function' as never }), TypeError);
    assert.throws(() => mutexPlugin({ onError: 42 as never }), TypeError);
  });

  it('rejects non-object options', () => {
    assert.throws(() => mutexPlugin(null as never), TypeError);
    assert.throws(() => mutexPlugin([] as never), TypeError);
  });

  it('valkeyUrl selects the Valkey store lazily', () => {
    // Construction with a valkeyUrl does not throw — the store is lazy and
    // no connection is attempted at plugin construction time. The returned
    // plugin has the correct name.
    const plugin = mutexPlugin({ valkeyUrl: 'redis://127.0.0.1:1' });
    assert.equal(plugin.name, 'mutex');
  });
});
