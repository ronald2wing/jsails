import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  createSeederRegistry,
  defineSeeder,
  runSeeders,
  SeederError,
  type SeederRegistry,
} from '../../src/database/seeders.js';
import { JsailsDataSource } from '../../src/database/data-source.js';

/**
 * Seeders are exercised against a real in-process sql.js database so the
 * runner's `isInitialized` contract is exercised faithfully. Seeder bodies only
 * record invocation order and the context data source identity — no table is
 * required to prove ordering, filtering, and failure semantics.
 */

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'seeders-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

let locationSeq = 0;

/** A fresh, initialized, in-memory sql.js data source. */
async function createDataSource(): Promise<JsailsDataSource> {
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location: join(tmpRoot, `seeder-${locationSeq++}.sqlite`),
    entities: [],
  });
  await dataSource.initialize();
  return dataSource;
}

describe('defineSeeder', () => {
  it('rejects a non-string or empty name', () => {
    assert.throws(() => defineSeeder('', async () => {}), SeederError);
    assert.throws(() => defineSeeder(42 as unknown as string, async () => {}), SeederError);
  });

  it('rejects a non-function run', () => {
    assert.throws(() => defineSeeder('x', 42 as unknown as never), SeederError);
  });

  it('returns the name and run verbatim', () => {
    const run = async () => {};
    const seeder = defineSeeder('users', run);
    assert.equal(seeder.name, 'users');
    assert.equal(seeder.run, run);
  });
});

describe('createSeederRegistry', () => {
  it('rejects a non-object', () => {
    assert.throws(() => createSeederRegistry(null as unknown as SeederRegistry), SeederError);
    assert.throws(() => createSeederRegistry([] as unknown as SeederRegistry), SeederError);
  });

  it('rejects a seeder whose declared name does not match its key', () => {
    assert.throws(
      () =>
        createSeederRegistry({
          key: defineSeeder('other', async () => {}),
        }),
      /keys must match the declared name/,
    );
  });

  it('accepts a valid map and returns it', () => {
    const users = defineSeeder('users', async () => {});
    const registry = createSeederRegistry({ users });
    assert.equal(registry.users, users);
  });
});

describe('runSeeders', () => {
  it('runs every seeder in registry insertion order', async () => {
    const dataSource = await createDataSource();
    const order: string[] = [];
    const registry = createSeederRegistry({
      second: defineSeeder('second', async (ctx) => {
        assert.equal(ctx.dataSource, dataSource);
        order.push('second');
      }),
      first: defineSeeder('first', async () => {
        order.push('first');
      }),
      third: defineSeeder('third', async () => {
        order.push('third');
      }),
    });

    const ran = await runSeeders(registry, { dataSource });

    assert.deepEqual(order, ['second', 'first', 'third'], 'insertion order, not key order');
    assert.deepEqual(ran, ['second', 'first', 'third']);
    await dataSource.destroy();
  });

  it('filters to the requested names, preserving registry order', async () => {
    const dataSource = await createDataSource();
    const order: string[] = [];
    const registry = createSeederRegistry({
      a: defineSeeder('a', async () => {
        order.push('a');
      }),
      b: defineSeeder('b', async () => {
        order.push('b');
      }),
      c: defineSeeder('c', async () => {
        order.push('c');
      }),
    });

    const ran = await runSeeders(registry, { dataSource, names: ['c', 'a'] });

    assert.deepEqual(order, ['a', 'c'], 'requested names re-sorted into registry order');
    assert.deepEqual(ran, ['a', 'c']);
    await dataSource.destroy();
  });

  it('runs nothing for an empty selection', async () => {
    const dataSource = await createDataSource();
    const order: string[] = [];
    const registry = createSeederRegistry({
      a: defineSeeder('a', async () => {
        order.push('a');
      }),
    });

    const ran = await runSeeders(registry, { dataSource, names: [] });

    assert.deepEqual(order, []);
    assert.deepEqual(ran, []);
    await dataSource.destroy();
  });

  it('rejects an unknown requested name without echoing it', async () => {
    const dataSource = await createDataSource();
    const registry = createSeederRegistry({
      a: defineSeeder('a', async () => {}),
    });

    await assert.rejects(
      runSeeders(registry, { dataSource, names: ['s3cret'] }),
      (error: unknown) => {
        assert.ok(error instanceof SeederError);
        assert.equal(error.message, 'requested seeder is not registered');
        assert.doesNotMatch(error.message, /s3cret/);
        return true;
      },
    );
    await dataSource.destroy();
  });

  it('fails fast, wrapping the failing seeder name and cause', async () => {
    const dataSource = await createDataSource();
    const boom = new Error('boom');
    const order: string[] = [];
    const registry = createSeederRegistry({
      good: defineSeeder('good', async () => {
        order.push('good');
      }),
      bad: defineSeeder('bad', async () => {
        throw boom;
      }),
      after: defineSeeder('after', async () => {
        order.push('after');
      }),
    });

    await assert.rejects(runSeeders(registry, { dataSource }), (error: unknown) => {
      assert.ok(error instanceof SeederError);
      assert.equal(error.seederName, 'bad');
      assert.equal(error.cause, boom);
      return true;
    });
    assert.deepEqual(order, ['good'], 'the seeder after the failure never ran');
    await dataSource.destroy();
  });

  it('rejects an uninitialized data source', async () => {
    const uninitialized = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'uninitialized.sqlite'),
      entities: [],
    });
    const registry = createSeederRegistry({
      a: defineSeeder('a', async () => {}),
    });

    await assert.rejects(
      runSeeders(registry, { dataSource: uninitialized }),
      /requires an initialized data source/,
    );
  });
});
