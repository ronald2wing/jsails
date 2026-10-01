import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { JsailsDataSource } from '../../src/database/data-source.js';
import {
  defineFixture,
  FixtureError,
  loadFixtures,
  withRollback,
  type Fixture,
} from '../../src/database/fixtures.js';
import { generateMigration } from '../../src/migrations/autodetector.js';
import { migrate, type MigrationDataSource } from '../../src/migrations/migrator.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'fixtures-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Entity factories
// ---------------------------------------------------------------------------

function makeUser() {
  @Entity('users')
  class User extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100, nullable: false })
    name!: string;
  }
  return User;
}

function makeItem() {
  @Entity('items')
  class Item extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 200, nullable: false })
    title!: string;
  }
  return Item;
}

// ---------------------------------------------------------------------------
// Data source helpers
// ---------------------------------------------------------------------------

function asMigrationDataSource(dataSource: JsailsDataSource): MigrationDataSource {
  return dataSource as unknown as MigrationDataSource;
}

let locationSeq = 0;

async function createDataSource(
  entities: (ReturnType<typeof makeUser> | ReturnType<typeof makeItem>)[],
): Promise<JsailsDataSource> {
  const location = join(tmpRoot, `db-${locationSeq++}.sqlite`);
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location,
    entities,
  });
  await dataSource.initialize();
  const schema = await dataSource.getModelSchema();
  const migration = generateMigration('create_tables', [], schema);
  assert.ok(migration, 'expected a create migration for the fixture schema');
  await migrate(asMigrationDataSource(dataSource), [migration]);
  return dataSource;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('defineFixture', () => {
  it('rejects a non-string or empty name', () => {
    assert.throws(() => defineFixture('', { entity: 'User', rows: [] }), FixtureError);
    assert.throws(
      () => defineFixture(42 as unknown as string, { entity: 'User', rows: [] }),
      FixtureError,
    );
  });

  it('rejects a fixture without entity', () => {
    assert.throws(() => defineFixture('x', { entity: '', rows: [] }), FixtureError);
    assert.throws(
      () => defineFixture('x', { entity: undefined as unknown as string, rows: [] }),
      FixtureError,
    );
  });

  it('rejects a fixture without rows', () => {
    assert.throws(
      () =>
        defineFixture('x', {
          entity: 'User',
          rows: null as unknown as Record<string, unknown>[],
        }),
      FixtureError,
    );
  });

  it('returns the fixture verbatim', () => {
    const rows: readonly Record<string, unknown>[] = [{ name: 'alice' }];
    const f = defineFixture('users', { entity: 'User', rows });
    assert.equal(f.entity, 'User');
    assert.equal(f.rows, rows);
  });
});

describe('loadFixtures', () => {
  it('rejects a non-array fixtures argument', async () => {
    const User = makeUser();
    const ds = await createDataSource([User]);
    try {
      await assert.rejects(loadFixtures(ds, null as unknown as Fixture[]), FixtureError);
    } finally {
      await ds.destroy();
    }
  });

  it('rejects an unknown entity name', async () => {
    const User = makeUser();
    const ds = await createDataSource([User]);
    try {
      await assert.rejects(loadFixtures(ds, [{ entity: 'Unknown', rows: [] }]), /not registered/);
    } finally {
      await ds.destroy();
    }
  });

  it('inserts rows and they are readable via getRepository', async () => {
    const User = makeUser();
    const ds = await createDataSource([User]);
    try {
      await loadFixtures(ds, [{ entity: 'User', rows: [{ name: 'alice' }, { name: 'bob' }] }]);

      const repo = ds.getRepository(User);
      const rows = await repo.find();
      assert.equal(rows.length, 2);
      const names = rows.map((r) => r.name).sort();
      assert.deepEqual(names, ['alice', 'bob']);
    } finally {
      await ds.destroy();
    }
  });

  it('resolves entity by table name (not class name)', async () => {
    const User = makeUser(); // tableName = 'users'
    const ds = await createDataSource([User]);
    try {
      // Resolve by table name 'users' instead of class name 'User'.
      await loadFixtures(ds, [{ entity: 'users', rows: [{ name: 'charlie' }] }]);

      const repo = ds.getRepository(User);
      const rows = await repo.find();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.name, 'charlie');
    } finally {
      await ds.destroy();
    }
  });

  it('inserts multiple fixtures in declaration order', async () => {
    const User = makeUser();
    const Item = makeItem();
    const ds = await createDataSource([User, Item]);
    try {
      await loadFixtures(ds, [
        { entity: 'User', rows: [{ name: 'u1' }] },
        { entity: 'Item', rows: [{ title: 'i1' }] },
        { entity: 'User', rows: [{ name: 'u2' }] },
      ]);

      const users = await ds.getRepository(User).find({ order: { id: 'ASC' } });
      assert.equal(users.length, 2);
      assert.deepEqual(
        users.map((u) => u.name),
        ['u1', 'u2'],
      );

      const items = await ds.getRepository(Item).find({ order: { id: 'ASC' } });
      assert.equal(items.length, 1);
      assert.equal(items[0]!.title, 'i1');
    } finally {
      await ds.destroy();
    }
  });
});

describe('withRollback', () => {
  it('returns the body result and leaves no rows persisted', async () => {
    const User = makeUser();
    const ds = await createDataSource([User]);

    try {
      await loadFixtures(ds, [{ entity: 'User', rows: [{ name: 'fixture-user' }] }]);

      const result = await withRollback(ds, async () => {
        // Fixture rows are visible inside the transaction body.
        const repo = ds.getRepository(User);
        const inside = await repo.find();
        assert.equal(inside.length, 1);
        assert.equal(inside[0]!.name, 'fixture-user');

        // Write more rows inside the body — those will roll back too.
        await repo.save([{ name: 'tx-user-1' }, { name: 'tx-user-2' }]);

        return 'body-result';
      });

      assert.equal(result, 'body-result');

      // After rollback: only the rows loaded *before* the transaction remain.
      const after = await ds.getRepository(User).find();
      assert.equal(after.length, 1);
      assert.equal(after[0]!.name, 'fixture-user');
    } finally {
      await ds.destroy();
    }
  });

  it('propagates body error unchanged — no rows are persisted', async () => {
    const User = makeUser();
    const ds = await createDataSource([User]);

    class BodyError extends Error {
      constructor() {
        super('body-error');
        this.name = 'BodyError';
      }
    }

    try {
      await loadFixtures(ds, [{ entity: 'User', rows: [{ name: 'before' }] }]);

      await assert.rejects(
        withRollback(ds, async () => {
          await ds.getRepository(User).save([{ name: 'nope' }]);
          throw new BodyError();
        }),
        BodyError,
      );

      // Only the rows loaded before the rollback remain.
      const after = await ds.getRepository(User).find();
      assert.equal(after.length, 1);
      assert.equal(after[0]!.name, 'before');
    } finally {
      await ds.destroy();
    }
  });

  it('rolls back even when body does no writes', async () => {
    const User = makeUser();
    const ds = await createDataSource([User]);

    try {
      await loadFixtures(ds, [{ entity: 'User', rows: [{ name: 'original' }] }]);

      const result = await withRollback(ds, async () => {
        const rows = await ds.getRepository(User).find();
        return rows.length;
      });

      assert.equal(result, 1);

      // No new rows were added — and because the transaction rolled back,
      // nothing was committed.
      const after = await ds.getRepository(User).find();
      assert.equal(after.length, 1);
    } finally {
      await ds.destroy();
    }
  });
});
