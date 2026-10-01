import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createContractToken,
  createServiceToken,
  runExtensions,
} from '../../src/extensions/index.js';

describe('createContractToken', () => {
  it('returns a frozen token with name, version, and a stable internal service token', () => {
    const token = createContractToken<{ port: number }>('database', { version: 1 });

    assert.equal(token.name, 'database');
    assert.equal(token.version, 1);
    assert.equal(typeof token.resolve, 'function');
    assert.ok(Object.isFrozen(token));
  });

  it('defaults version to 1', () => {
    const token = createContractToken<string>('cache');
    assert.equal(token.version, 1);
  });

  it('rejects an empty name', () => {
    assert.throws(() => createContractToken(''), /name must be a non-empty string/);
    assert.throws(() => createContractToken('  '), /name must be a non-empty string/);
  });

  it('rejects a non-positive-integer version', () => {
    assert.throws(
      () => createContractToken('x', { version: 0 }),
      /version must be a positive integer/,
    );
    assert.throws(
      () => createContractToken('x', { version: -1 }),
      /version must be a positive integer/,
    );
    assert.throws(
      () => createContractToken('x', { version: 1.5 }),
      /version must be a positive integer/,
    );
    assert.throws(
      () => createContractToken('x', { version: Number.NaN }),
      /version must be a positive integer/,
    );
  });

  it('treats contract tokens with the same name as distinct identities', async () => {
    const a = createContractToken<string>('db');
    const b = createContractToken<string>('db');

    assert.notStrictEqual(a, b);
    assert.ok(a !== b);
  });
});

describe('contract resolution through the registry', () => {
  it('resolves a contract value after the provider registers it', async () => {
    const database = createContractToken<{ port: number }>('database');
    const db = { port: 5432 };

    const runtime = await runExtensions([
      {
        name: 'db-provider',
        provides: [{ contract: database }],
        setup({ services }) {
          services.provide(database.token, db);
        },
      },
      {
        name: 'consumer',
        requires: [database],
        setup({ services }) {
          const resolved = database.resolve(services);
          assert.equal(resolved, db);
          assert.equal(resolved.port, 5432);
        },
      },
    ]);

    // Resolution also works from the sealed runtime.
    assert.equal(database.resolve(runtime.services), db);
    assert.equal(runtime.services.get(database.token), db);

    await runtime.close();
  });

  it('fails value-free when zero providers exist for a required contract', async () => {
    const database = createContractToken<{ port: number }>('database');

    await assert.rejects(
      runExtensions([
        {
          name: 'consumer',
          requires: [database],
          setup() {},
        },
      ]),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /contract "database" is required but no extension provides it/);
        return true;
      },
    );
  });

  it('fails value-free when two providers exist without an override', async () => {
    const database = createContractToken<{ port: number }>('database');

    await assert.rejects(
      runExtensions([
        {
          name: 'db-provider-1',
          provides: [{ contract: database }],
          setup({ services }) {
            services.provide(database.token, { port: 5432 });
          },
        },
        {
          name: 'db-provider-2',
          provides: [{ contract: database }],
          setup({ services }) {
            // Without replace: true, the second provide hits the duplicate guard
            // in the service registry (not the post-setup contract check).
            services.provide(database.token, { port: 3306 });
          },
        },
        {
          name: 'consumer',
          requires: [database],
          setup() {},
        },
      ]),
      (error: unknown) => {
        // The registry duplicates guard fires before the post-setup check.
        // Either error class is acceptable — both are value-free.
        assert.match((error as Error).message, /already provided|providers|duplicate/i);
        return true;
      },
    );
  });

  it('allows an override provider to replace a default, and its value wins', async () => {
    const database = createContractToken<string>('database');
    const defaultDb = 'mariadb';
    const overrideDb = 'postgres';

    const runtime = await runExtensions([
      {
        name: 'db-default',
        provides: [{ contract: database }],
        setup({ services }) {
          services.provide(database.token, defaultDb);
        },
      },
      {
        name: 'db-override',
        provides: [{ contract: database, override: true }],
        setup({ services }) {
          // replace: true skips the duplicate check
          services.provide(database.token, overrideDb, { replace: true });
        },
      },
      {
        name: 'consumer',
        requires: [database],
        setup({ services }) {
          // The override value wins.
          assert.equal(database.resolve(services), overrideDb);
        },
      },
    ]);

    assert.equal(database.resolve(runtime.services), overrideDb);
    await runtime.close();
  });

  it('fails when two overrides exist for one contract', async () => {
    const database = createContractToken<string>('database');

    await assert.rejects(
      runExtensions([
        {
          name: 'db-1',
          provides: [{ contract: database, override: true }],
          setup({ services }) {
            services.provide(database.token, 'a', { replace: true });
          },
        },
        {
          name: 'db-2',
          provides: [{ contract: database, override: true }],
          setup({ services }) {
            services.provide(database.token, 'b', { replace: true });
          },
        },
        {
          name: 'consumer',
          requires: [database],
          setup() {},
        },
      ]),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /contract "database" has 2 providers and 2 overrides/);
        return true;
      },
    );
  });
});

describe('topological sort by requires/provides', () => {
  it('orders extensions so providers run before consumers regardless of declaration order', async () => {
    const db = createContractToken<string>('db');
    const cache = createContractToken<string>('cache');
    const order: string[] = [];

    const runtime = await runExtensions([
      {
        name: 'consumer',
        requires: [db, cache],
        setup() {
          order.push('consumer');
        },
      },
      {
        name: 'db-provider',
        provides: [{ contract: db }],
        setup({ services }) {
          order.push('db-provider');
          services.provide(db.token, 'db');
        },
      },
      {
        name: 'cache-provider',
        provides: [{ contract: cache }],
        setup({ services }) {
          order.push('cache-provider');
          services.provide(cache.token, 'cache');
        },
      },
    ]);

    // Both providers must run before the consumer.
    assert.equal(order[0] !== 'consumer', true);
    assert.equal(order[1] !== 'consumer', true);
    assert.equal(order[2], 'consumer');
    await runtime.close();
  });

  it('reports a dependency cycle with a value-free error', async () => {
    const db = createContractToken<string>('db');
    const cache = createContractToken<string>('cache');

    await assert.rejects(
      runExtensions([
        {
          name: 'a',
          provides: [{ contract: db }],
          requires: [cache],
          setup({ services }) {
            services.provide(db.token, 'a');
          },
        },
        {
          name: 'b',
          provides: [{ contract: cache }],
          requires: [db],
          setup({ services }) {
            services.provide(cache.token, 'b');
          },
        },
      ]),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /dependency cycle detected/);
        // Names are echoed (value-free) in the message
        assert.match(error.message, /a/);
        assert.match(error.message, /b/);
        return true;
      },
    );
  });
});

describe('priority and declaration order are tiebreaks within topological layers', () => {
  it('uses priority then declaration order for providers with no ordering constraint', async () => {
    const db1 = createContractToken<string>('db1');
    const db2 = createContractToken<string>('db2');
    const order: string[] = [];

    const runtime = await runExtensions([
      {
        name: 'db-high',
        priority: 10,
        setup({ services }) {
          order.push('db-high');
          services.provide(db1.token, 'high');
        },
      },
      {
        name: 'db-low',
        priority: 1,
        provides: [{ contract: db2 }],
        setup({ services }) {
          order.push('db-low');
          services.provide(db2.token, 'low');
        },
      },
      {
        name: 'consumer',
        requires: [db2],
        setup() {
          order.push('consumer');
        },
      },
    ]);

    // db-low provides db2 and must run before consumer.
    // db-high and db-low are in the same layer (no ordering constraints between
    // them), so priority (ascending) determines their order: db-low (1) before
    // db-high (10).
    assert.deepEqual(order, ['db-low', 'db-high', 'consumer']);
    await runtime.close();
  });
});

describe('existing ServiceToken requires still work', () => {
  it('accepts ServiceToken entries in requires alongside ContractToken entries', async () => {
    const answer = createServiceToken<number>('answer');
    const db = createContractToken<string>('db');
    const seen: number[] = [];

    const runtime = await runExtensions([
      {
        name: 'db-provider',
        provides: [{ contract: db }],
        setup({ services }) {
          services.provide(db.token, 'db');
        },
      },
      {
        name: 'service-provider',
        setup({ services }) {
          services.provide(answer, 42);
        },
      },
      {
        name: 'consumer',
        requires: [db, answer],
        setup({ services }) {
          seen.push(services.get(answer));
          assert.equal(db.resolve(services), 'db');
          assert.equal(services.get(answer), 42);
        },
      },
    ]);

    assert.equal(seen[0], 42);
    await runtime.close();
  });
});

describe('contract provides/requires through the plugin shape', () => {
  it('honors provides on a plugin and sorts it before a plain extension consumer', async () => {
    const db = createContractToken<string>('db');
    const order: string[] = [];

    // plugin-contract.test.ts imports definePlugin from the same barrel
    const { definePlugin } = await import('../../src/extensions/index.js');

    const runtime = await runExtensions([
      {
        name: 'consumer',
        requires: [db],
        setup() {
          order.push('consumer');
        },
      },
      definePlugin({
        name: 'db-provider',
        provides: [{ contract: db }],
        setup({ services }) {
          order.push('db-provider');
          services.provide(db.token, 'db');
        },
      }),
    ]);

    assert.deepEqual(order, ['db-provider', 'consumer']);
    await runtime.close();
  });
});

describe('contract provider with replace on the registry level', () => {
  it('allows a second provide with replace: true (the override mechanism)', async () => {
    const db = createContractToken<string>('db');

    const runtime = await runExtensions([
      {
        name: 'db-default',
        provides: [{ contract: db }],
        setup({ services }) {
          services.provide(db.token, 'default');
        },
      },
      {
        name: 'db-override',
        provides: [{ contract: db, override: true }],
        setup({ services }) {
          services.provide(db.token, 'override', { replace: true });
        },
      },
      {
        name: 'consumer',
        requires: [db],
        setup({ services }) {
          assert.equal(db.resolve(services), 'override');
        },
      },
    ]);

    assert.equal(runtime.services.get(db.token), 'override');
    await runtime.close();
  });

  it('replace: true works even when the token is not yet registered (first write)', async () => {
    const db = createContractToken<string>('db');

    const runtime = await runExtensions([
      {
        name: 'db-provider',
        provides: [{ contract: db }],
        setup({ services }) {
          services.provide(db.token, 'value', { replace: true });
        },
      },
      {
        name: 'consumer',
        requires: [db],
        setup({ services }) {
          assert.equal(db.resolve(services), 'value');
        },
      },
    ]);

    assert.equal(runtime.services.get(db.token), 'value');
    await runtime.close();
  });
});

describe('runExtensions enabledNames support with contracts', () => {
  it('skips a disabled provider and fails because the required contract has zero providers', async () => {
    const db = createContractToken<string>('db');

    await assert.rejects(
      runExtensions(
        [
          {
            name: 'db-provider',
            provides: [{ contract: db }],
            setup({ services }) {
              services.provide(db.token, 'db');
            },
          },
          {
            name: 'consumer',
            requires: [db],
            setup() {},
          },
        ],
        { enabledNames: ['consumer'] },
      ),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /contract "db" is required but no extension provides it/);
        return true;
      },
    );
  });

  it('provider and consumer are both enabled, works', async () => {
    const db = createContractToken<string>('db');

    const runtime = await runExtensions(
      [
        {
          name: 'db-provider',
          provides: [{ contract: db }],
          setup({ services }) {
            services.provide(db.token, 'db');
          },
        },
        {
          name: 'consumer',
          requires: [db],
          setup() {},
        },
      ],
      { enabledNames: ['db-provider', 'consumer'] },
    );

    assert.equal(runtime.services.get(db.token), 'db');
    assert.deepEqual(runtime.skipped, []);
    await runtime.close();
  });
});
