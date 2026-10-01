/**
 * Tests for the in-memory mutex store: acquire/release lifecycle, expiry
 * via an injectable clock, value-free error paths, and options validation.
 *
 * Tests for the Valkey-backed mutex store: lazy connection, atomic acquire
 * via SET NX PX, prefixed keys, idempotent close, value-free error paths.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MutexError,
  createMemoryMutexStore,
  createValkeyMutexStore,
} from '../../src/cache/mutex.js';
import type { ValkeyCacheStoreDependencies, ValkeyRedisClient } from '../../src/cache/store.js';

/** A mutable fake clock so tests can drive time independently. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('createMemoryMutexStore', () => {
  it('acquire returns true on a free key', async () => {
    const store = createMemoryMutexStore();
    assert.equal(await store.acquire('task:daily-digest', 5000), true);
  });

  it('acquire returns false while held', async () => {
    const store = createMemoryMutexStore();
    assert.equal(await store.acquire('task:daily-digest', 5000), true);
    assert.equal(await store.acquire('task:daily-digest', 5000), false);
  });

  it('release frees a held key', async () => {
    const store = createMemoryMutexStore();
    assert.equal(await store.acquire('k', 5000), true);
    await store.release('k');
    assert.equal(await store.acquire('k', 5000), true);
  });

  it('release of an absent key is a no-op', async () => {
    const store = createMemoryMutexStore();
    await store.release('nonexistent');
    // Must not throw; acquiring the same key must still succeed.
    assert.equal(await store.acquire('nonexistent', 5000), true);
  });

  it('expiry frees a key automatically', async () => {
    const { now, advance } = fakeClock();
    const store = createMemoryMutexStore({ now });

    assert.equal(await store.acquire('k', 1000), true);
    assert.equal(await store.acquire('k', 1000), false);

    advance(999);
    assert.equal(await store.acquire('k', 1000), false);

    advance(1);
    assert.equal(await store.acquire('k', 1000), true);
  });

  it('acquire after expiry re-sets the TTL', async () => {
    const { now, advance } = fakeClock();
    const store = createMemoryMutexStore({ now });

    assert.equal(await store.acquire('k', 1000), true);
    advance(1000);
    // Key is now expired; re-acquire creates a fresh entry.
    assert.equal(await store.acquire('k', 500), true);
    advance(300);
    assert.equal(await store.acquire('k', 500), false);
    advance(200);
    assert.equal(await store.acquire('k', 500), true);
  });

  it('close clears all entries and is idempotent', async () => {
    const store = createMemoryMutexStore();
    assert.equal(await store.acquire('k1', 5000), true);
    assert.equal(await store.acquire('k2', 5000), true);

    await store.close();
    await store.close();
    // After close, all keys are freed.
    assert.equal(await store.acquire('k1', 5000), true);
    assert.equal(await store.acquire('k2', 5000), true);
  });

  it('acquire rejects a value-free MutexError on an invalid key', async () => {
    const store = createMemoryMutexStore();

    // Empty string
    await assert.rejects(store.acquire('', 5000), (error: unknown) => {
      assert.ok(error instanceof MutexError);
      assert.equal(error.code, 'invalid_key');
      return true;
    });

    // Non-string
    for (const bad of [null, undefined, 123, {}, []]) {
      await assert.rejects(store.acquire(bad as string, 5000), (error: unknown) => {
        assert.ok(error instanceof MutexError);
        assert.equal(error.code, 'invalid_key');
        return true;
      });
    }
  });

  it('acquire rejects a value-free MutexError on an invalid ttlMs', async () => {
    const store = createMemoryMutexStore();
    const cases: unknown[] = [NaN, Infinity, -Infinity, 0, -1];
    for (const value of cases) {
      await assert.rejects(store.acquire('k', value as number), (error: unknown) => {
        assert.ok(error instanceof MutexError);
        assert.equal(error.code, 'invalid_ttl');
        return true;
      });
    }
  });

  it('release rejects a value-free MutexError on an invalid key', async () => {
    const store = createMemoryMutexStore();

    await assert.rejects(store.release(''), (error: unknown) => {
      assert.ok(error instanceof MutexError);
      assert.equal(error.code, 'invalid_key');
      return true;
    });
  });

  it('rejects a non-object options argument', () => {
    assert.throws(() => createMemoryMutexStore(null as never), TypeError);
    assert.throws(() => createMemoryMutexStore([] as never), TypeError);
    assert.throws(() => createMemoryMutexStore('string' as never), TypeError);
    assert.throws(() => createMemoryMutexStore(42 as never), TypeError);
  });

  it('rejects now when it is not a function', () => {
    assert.throws(() => createMemoryMutexStore({ now: 'not-a-function' as never }), TypeError);
    assert.throws(() => createMemoryMutexStore({ now: 42 as never }), TypeError);
  });

  it('MutexError has the correct name and code', () => {
    const error = new MutexError('invalid_key', 'msg');
    assert.equal(error.name, 'MutexError');
    assert.equal(error.code, 'invalid_key');
    assert.equal(error.message, 'msg');
    assert.ok(error instanceof Error);
  });
});

// ---------------------------------------------------------------------------
// Valkey-backed mutex store — test infrastructure
// ---------------------------------------------------------------------------

/** A fake ioredis client recording commands; the store constructs its own. */
class FakeMutexClient implements ValkeyRedisClient {
  readonly keys: string[] = [];
  connected = 0;
  disconnected = 0;

  /** Controls the return value of `set(key, value, 'PX', ttlMs, 'NX')`. */
  setResult: 'OK' | null = 'OK';

  /** When set, every operation throws this error instead of succeeding. */
  throwOnOperation: Error | null = null;

  async get(key: string): Promise<string | null> {
    this.keys.push(key);
    if (this.throwOnOperation) {
      throw this.throwOnOperation;
    }
    return null;
  }

  async set(
    key: string,
    _value: string,
    _mode: 'PX',
    _ttlMs: number,
    condition?: 'NX',
  ): Promise<'OK' | null> {
    this.keys.push(key);
    if (this.throwOnOperation) {
      throw this.throwOnOperation;
    }
    if (condition === 'NX') {
      return this.setResult;
    }
    return 'OK';
  }

  async del(key: string): Promise<number> {
    this.keys.push(key);
    if (this.throwOnOperation) {
      throw this.throwOnOperation;
    }
    return 0;
  }

  async connect(): Promise<unknown> {
    this.connected += 1;
    return undefined;
  }

  async disconnect(): Promise<void> {
    this.disconnected += 1;
  }

  on(): unknown {
    return undefined;
  }
}

/** Track every client the store constructs so tests can inspect the real one. */
function fakeMutexClientDeps(): {
  deps: ValkeyCacheStoreDependencies;
  instances: FakeMutexClient[];
} {
  const instances: FakeMutexClient[] = [];
  class TrackingClient extends FakeMutexClient {
    constructor(url: string, options: object) {
      super();
      instances.push(this);
      void url;
      void options;
    }
  }
  return { deps: { RedisClient: TrackingClient }, instances };
}

// ---------------------------------------------------------------------------
// Valkey-backed mutex store — tests
// ---------------------------------------------------------------------------

describe('createValkeyMutexStore', () => {
  it('acquire returns true when the client returns OK', async () => {
    const { deps, instances } = fakeMutexClientDeps();
    const store = createValkeyMutexStore({ valkeyUrl: 'redis://host:6379' }, deps);
    try {
      assert.equal(await store.acquire('task:send', 5000), true);
      assert.equal(instances.length, 1);
      const client = instances[0]!;
      assert.equal(client.connected, 1);
    } finally {
      await store.close();
    }
  });

  it('acquire returns false when the client returns null', async () => {
    const { deps, instances } = fakeMutexClientDeps();
    const store = createValkeyMutexStore({ valkeyUrl: 'redis://host:6379' }, deps);
    try {
      // Force the client connection first, then switch the set result.
      assert.equal(await store.acquire('task:send', 5000), true);
      const client = instances[0]!;
      client.setResult = null;
      assert.equal(await store.acquire('task:send', 5000), false);
    } finally {
      await store.close();
    }
  });

  it('release calls del with the prefixed key', async () => {
    const { deps, instances } = fakeMutexClientDeps();
    const store = createValkeyMutexStore({ valkeyUrl: 'redis://h', prefix: 'app:mutex' }, deps);
    try {
      assert.equal(await store.acquire('k', 1000), true);
      const client = instances[0]!;
      client.keys.length = 0; // reset the tracking
      await store.release('k');
      assert.deepEqual(client.keys, ['app:mutex:k']);
    } finally {
      await store.close();
    }
  });

  it('is fully lazy: no client constructed until first operation', async () => {
    const { deps, instances } = fakeMutexClientDeps();
    const store = createValkeyMutexStore({ valkeyUrl: 'redis://host:6379' }, deps);

    assert.equal(instances.length, 0, 'construction must be lazy');

    try {
      await store.acquire('k', 1000);
      assert.equal(instances.length, 1);
      const client = instances[0]!;
      assert.equal(client.connected, 1);
    } finally {
      await store.close();
    }
  });

  it('close disconnects exactly once and is idempotent', async () => {
    const { deps, instances } = fakeMutexClientDeps();
    const store = createValkeyMutexStore({ valkeyUrl: 'redis://h' }, deps);

    await store.acquire('k', 1000); // force the connect
    await store.close();
    await store.close();

    const client = instances[0]!;
    assert.equal(client.disconnected, 1);
  });

  it('operations after close throw MutexError(closed)', async () => {
    const { deps } = fakeMutexClientDeps();
    const store = createValkeyMutexStore({ valkeyUrl: 'redis://h' }, deps);

    await store.acquire('k', 1000); // force the connect
    await store.close();

    await assert.rejects(store.acquire('k', 1000), (error: unknown) => {
      assert.ok(error instanceof MutexError);
      assert.equal(error.code, 'closed');
      return true;
    });

    await assert.rejects(store.release('k'), (error: unknown) => {
      assert.ok(error instanceof MutexError);
      assert.equal(error.code, 'closed');
      return true;
    });
  });

  it('close is a no-op when no client was ever created', async () => {
    const { deps, instances } = fakeMutexClientDeps();
    const store = createValkeyMutexStore({ valkeyUrl: 'redis://h' }, deps);

    await store.close();
    assert.equal(instances.length, 0, 'no client should have been constructed');
  });

  it('missing URL throws a value-free MutexError', async () => {
    const { deps } = fakeMutexClientDeps();

    // Ensure VALKEY_URL does not interfere with the test.
    const saved = process.env.VALKEY_URL;
    delete process.env.VALKEY_URL;
    try {
      const store = createValkeyMutexStore({}, deps);
      await assert.rejects(store.acquire('k', 1000), (error: unknown) => {
        assert.ok(error instanceof MutexError);
        assert.equal(error.code, 'backend_error');
        // The error must not echo any URL fragment (there is none, but the
        // guard matters for the real code path).
        return true;
      });
    } finally {
      if (saved !== undefined) {
        process.env.VALKEY_URL = saved;
      }
    }
  });

  it('backend error surfaces as value-free MutexError(backend_error)', async () => {
    const { deps, instances } = fakeMutexClientDeps();
    const store = createValkeyMutexStore({ valkeyUrl: 'redis://user:secret@host:6379/0' }, deps);

    try {
      // Force connect first, then make the next operation throw.
      await store.acquire('k', 1000);
      const client = instances[0]!;
      const backendError = new Error('connection to redis://user:secret@host:6379/0 failed');
      (backendError as NodeJS.ErrnoException).code = 'ECONNREFUSED';
      client.throwOnOperation = backendError;

      await assert.rejects(store.acquire('k', 1000), (error: unknown) => {
        assert.ok(error instanceof MutexError);
        assert.equal(error.code, 'backend_error');
        const msg = String(error);
        // Value-free: neither the URL nor the key must be echoed.
        for (const fragment of ['secret', 'user', '6379', 'redis://', 'host']) {
          assert.ok(!msg.includes(fragment), `error must not echo "${fragment}"`);
        }
        return true;
      });
    } finally {
      await store.close();
    }
  });

  it('prefix override is respected', async () => {
    const { deps, instances } = fakeMutexClientDeps();
    const store = createValkeyMutexStore({ valkeyUrl: 'redis://h', prefix: 'custom:mutex' }, deps);
    try {
      await store.acquire('task:daily', 1000);
      const client = instances[0]!;
      assert.deepEqual(client.keys, ['custom:mutex:task:daily']);
    } finally {
      await store.close();
    }
  });

  it('default prefix is jsails:mutex', async () => {
    const { deps, instances } = fakeMutexClientDeps();
    const store = createValkeyMutexStore({ valkeyUrl: 'redis://h' }, deps);
    try {
      await store.acquire('k', 1000);
      const client = instances[0]!;
      assert.deepEqual(client.keys, ['jsails:mutex:k']);
    } finally {
      await store.close();
    }
  });

  it('rejects a non-redis scheme value-free', async () => {
    const { deps } = fakeMutexClientDeps();
    const store = createValkeyMutexStore({ valkeyUrl: 'http://secret@host' }, deps);

    await assert.rejects(store.acquire('k', 1000), (error: unknown) => {
      assert.ok(error instanceof MutexError);
      assert.equal(error.code, 'backend_error');
      assert.ok(!String(error).includes('secret'));
      return true;
    });
  });

  it('rejects a non-object options argument', () => {
    assert.throws(() => createValkeyMutexStore(null as never), TypeError);
    assert.throws(() => createValkeyMutexStore([] as never), TypeError);
    assert.throws(() => createValkeyMutexStore('string' as never), TypeError);
    assert.throws(() => createValkeyMutexStore(42 as never), TypeError);
  });

  it('rejects onError when it is not a function', () => {
    assert.throws(() => createValkeyMutexStore({ onError: 'not-a-function' as never }), TypeError);
    assert.throws(() => createValkeyMutexStore({ onError: 42 as never }), TypeError);
  });
});
