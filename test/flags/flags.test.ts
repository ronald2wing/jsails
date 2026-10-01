/**
 * Feature-flags core tests: the in-memory store's resolution and default-
 * inactive behavior, scope isolation, the `resolveFeature` branch helper, the
 * plugin's token/service wiring (with a provided store used verbatim), and the
 * value-free error guarantee. No database or connection is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runExtensions } from '../../src/extensions/index.js';
import { createFeatureFlags } from '../../src/flags/flags.js';
import {
  FeatureFlagError,
  createMemoryFeatureStore,
  flagsPlugin,
  flagsToken,
  resolveFeature,
  type FeatureFlags,
  type FeatureStore,
} from '../../src/flags/index.js';

describe('createMemoryFeatureStore', () => {
  it('returns null for an unset flag (default inactive)', async () => {
    const store = createMemoryFeatureStore();
    assert.equal(await store.get('missing'), null);
    assert.deepEqual(await store.all(), {});
  });

  it('round-trips set/get and distinguishes off from unset', async () => {
    const store = createMemoryFeatureStore();

    await store.set('new-checkout', true);
    assert.equal(await store.get('new-checkout'), true);

    await store.set('new-checkout', false);
    assert.equal(await store.get('new-checkout'), false, 'off is distinct from unset');

    await store.delete('new-checkout');
    assert.equal(await store.get('new-checkout'), null);
  });

  it('delete is a no-op for an absent flag', async () => {
    const store = createMemoryFeatureStore();
    await store.delete('never-set');
    assert.equal(await store.get('never-set'), null);
  });

  it('lists every flag in a scope through all()', async () => {
    const store = createMemoryFeatureStore();

    await store.set('a', true);
    await store.set('b', false);
    await store.set('c', true, 'scoped');

    assert.deepEqual(await store.all(), { a: true, b: false });
    assert.deepEqual(await store.all('scoped'), { c: true });
    assert.deepEqual(await store.all('empty'), {});
  });
});

describe('scope isolation', () => {
  it('keeps the global scope and each scoped namespace independent', async () => {
    const store = createMemoryFeatureStore();

    await store.set('dark-mode', true);
    await store.set('dark-mode', true, 'user-1');
    await store.set('dark-mode', false, 'user-2');

    assert.equal(await store.get('dark-mode'), true);
    assert.equal(await store.get('dark-mode', 'user-1'), true);
    assert.equal(await store.get('dark-mode', 'user-2'), false);
    assert.equal(await store.get('dark-mode', 'user-3'), null, 'unset scope defaults inactive');

    assert.deepEqual(await store.all(), { 'dark-mode': true });
    assert.deepEqual(await store.all('user-1'), { 'dark-mode': true });
    assert.deepEqual(await store.all('user-2'), { 'dark-mode': false });
  });

  it('deleting a scoped flag never touches another scope or the global scope', async () => {
    const store = createMemoryFeatureStore();

    await store.set('beta', true);
    await store.set('beta', true, 'user-1');

    await store.delete('beta', 'user-1');

    assert.equal(await store.get('beta'), true);
    assert.equal(await store.get('beta', 'user-1'), null);
  });
});

describe('createFeatureFlags service', () => {
  function service(): FeatureFlags {
    return createFeatureFlags(createMemoryFeatureStore());
  }

  it('isActive defaults to inactive for an unset flag', async () => {
    const flags = service();
    assert.equal(await flags.isActive('unknown'), false);
  });

  it('activate/deactivate flip a flag and survive reads', async () => {
    const flags = service();

    assert.equal(await flags.isActive('beta'), false);

    await flags.activate('beta');
    assert.equal(await flags.isActive('beta'), true);

    await flags.deactivate('beta');
    assert.equal(await flags.isActive('beta'), false);
  });

  it('activate/deactivate respect the scope', async () => {
    const flags = service();

    await flags.activate('beta', 'user-1');
    assert.equal(await flags.isActive('beta'), false, 'global scope is untouched');
    assert.equal(await flags.isActive('beta', 'user-1'), true);

    assert.deepEqual(await flags.all('user-1'), { beta: true });
  });
});

describe('resolveFeature', () => {
  it('resolves the active branch only', async () => {
    const store = createMemoryFeatureStore();
    await store.set('new-ui', true);
    const feature = resolveFeature(createFeatureFlags(store), 'new-ui');

    assert.equal(await feature.active('on'), 'on');
    assert.equal(await feature.inactive('off'), undefined);
  });

  it('resolves the inactive branch only', async () => {
    const store = createMemoryFeatureStore();
    const feature = resolveFeature(createFeatureFlags(store), 'new-ui');

    assert.equal(await feature.active('on'), undefined);
    assert.equal(await feature.inactive('off'), 'off');
  });

  it('composes into a single selection with ??', async () => {
    const store = createMemoryFeatureStore();
    await store.set('new-ui', true, 'user-1');
    const feature = resolveFeature(createFeatureFlags(store), 'new-ui', 'user-1');

    const result = (await feature.active('new')) ?? (await feature.inactive('old'));
    assert.equal(result, 'new');
  });

  it('validates the key eagerly without reading the store', () => {
    assert.throws(
      () => resolveFeature(createFeatureFlags(createMemoryFeatureStore()), ''),
      FeatureFlagError,
    );
    assert.throws(
      () => resolveFeature(createFeatureFlags(createMemoryFeatureStore()), 'ok', ''),
      FeatureFlagError,
    );
  });
});

describe('flagsPlugin', () => {
  it('has name "flags" and a stable token', () => {
    assert.equal(flagsToken.name, 'flags');
    assert.equal(flagsPlugin().name, 'flags');
  });

  it('provides a FeatureFlags service under the token', async () => {
    const runtime = await runExtensions([flagsPlugin()]);
    try {
      const flags: FeatureFlags = runtime.services.get(flagsToken);
      assert.equal(typeof flags.isActive, 'function');
      assert.equal(await flags.isActive('anything'), false);
    } finally {
      await runtime.close();
    }
  });

  it('uses a provided store verbatim', async () => {
    const store = createMemoryFeatureStore();
    await store.set('pre-seeded', true);

    const runtime = await runExtensions([flagsPlugin({ store })]);
    try {
      const flags = runtime.services.get(flagsToken);
      assert.equal(
        await flags.isActive('pre-seeded'),
        true,
        'the provided store backs the service',
      );
      assert.equal(await flags.isActive('other'), false);
    } finally {
      await runtime.close();
    }
  });

  it('validates malformed options eagerly', () => {
    assert.throws(() => flagsPlugin(null as never), TypeError);
    assert.throws(() => flagsPlugin([] as never), TypeError);
    assert.throws(() => flagsPlugin({ store: {} } as never), TypeError);
    assert.throws(() => flagsPlugin({ store: null } as never), TypeError);
  });

  it('closes idempotently with no handles held', async () => {
    const runtime = await runExtensions([flagsPlugin()]);
    await runtime.close();
    await runtime.close();
  });
});

describe('value-free errors', () => {
  it('rejects an empty key without echoing it', async () => {
    const store = createMemoryFeatureStore();
    await assert.rejects(store.get(''), (error: unknown) => {
      assert.ok(error instanceof FeatureFlagError);
      assert.equal(
        error.message,
        'a feature flag key must be a non-empty string of at most 190 characters',
      );
      return true;
    });
  });

  it('rejects an over-long key without echoing its content', async () => {
    const store = createMemoryFeatureStore();
    const secret = `SECRET_${'x'.repeat(200)}`;
    await assert.rejects(store.set(secret, true), (error: unknown) => {
      assert.ok(error instanceof FeatureFlagError);
      assert.ok(!error.message.includes('SECRET'), 'the key is never echoed');
      assert.ok(!error.message.includes('xxx'), 'the key body is never echoed');
      return true;
    });
  });

  it('rejects an empty scope and a non-boolean value', async () => {
    const store = createMemoryFeatureStore();
    await assert.rejects(store.get('ok', ''), FeatureFlagError);
    await assert.rejects(store.set('ok', 'yes' as never), FeatureFlagError);
  });
});

describe('import/construction laziness', () => {
  it('constructing a store, service, or plugin performs no I/O', () => {
    // These are synchronous factories: any connection would already have to
    // exist at this point, so this documents that none is opened.
    const store: FeatureStore = createMemoryFeatureStore();
    assert.equal(typeof store.get, 'function');
    assert.equal(typeof flagsPlugin().name, 'string');
  });
});
