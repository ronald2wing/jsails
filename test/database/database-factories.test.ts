import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { defineFactory, FactoryError } from '../../src/database/factories.js';
import {
  createEntitySubscriber,
  defineEntityHooks,
} from '../../src/database/entity-subscribers.js';
import { JsailsDataSource } from '../../src/database/data-source.js';
import { generateMigration } from '../../src/migrations/autodetector.js';
import { migrate, type MigrationDataSource } from '../../src/migrations/migrator.js';

/**
 * Factories are exercised against a real on-disk sql.js database for `create`
 * and with no database at all for `build` — `build` takes no data source, so a
 * missing/uninitialized source cannot leak into it. Every test owns freshly
 * declared entity classes so the global `BaseEntity` binding cannot leak.
 */

const tmpRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'database-factories-'),
);

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeUser() {
  @Entity('users')
  class User extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100, nullable: false })
    name!: string;

    @Column({ type: 'integer', nullable: true })
    age!: number | null;
  }
  return User;
}

function asMigrationDataSource(dataSource: JsailsDataSource): MigrationDataSource {
  return dataSource as unknown as MigrationDataSource;
}

let locationSeq = 0;

async function createDataSource(
  User: ReturnType<typeof makeUser>,
  subscriber?: ReturnType<typeof createEntitySubscriber>,
): Promise<JsailsDataSource> {
  const location = join(tmpRoot, `db-${locationSeq++}.sqlite`);
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location,
    entities: [User],
    subscribers: subscriber ? [subscriber] : [],
  });
  await dataSource.initialize();
  const schema = await dataSource.getModelSchema();
  const migration = generateMigration('create_users', [], schema);
  assert.ok(migration, 'expected a create migration for the fixture schema');
  await migrate(asMigrationDataSource(dataSource), [migration]);
  return dataSource;
}

function userFactory(User: ReturnType<typeof makeUser>) {
  return defineFactory(User, (sequence) => ({ name: `user-${sequence}` }));
}

describe('entity factories', () => {
  it('builds deterministic sequences without touching a database', () => {
    const User = makeUser();
    const users = userFactory(User);

    const built = users.build(3);
    assert.deepEqual(
      built.map((u) => u.name),
      ['user-1', 'user-2', 'user-3'],
    );
    // `build` returns plain attribute objects, never generated ids.
    for (const attrs of built) {
      assert.ok(!('id' in attrs));
    }
  });

  it('applies overrides on top of generated attributes', () => {
    const User = makeUser();
    const users = defineFactory(User, (sequence) => ({ name: `user-${sequence}`, age: sequence }));

    const built = users.build(2, { age: 99 });
    assert.deepEqual(
      built.map((u) => u.age),
      [99, 99],
    );
    assert.deepEqual(
      built.map((u) => u.name),
      ['user-1', 'user-2'],
    );
  });

  it('passes overrides to the generator so derived fields can depend on them', () => {
    const User = makeUser();
    const users = defineFactory(User, (sequence, overrides) => ({
      name: `user-${sequence}`,
      age: overrides.name === 'bob' ? 100 : 0,
    }));

    assert.equal(users.build(1, { name: 'bob' })[0]!.age, 100);
    assert.equal(users.build(1)[0]!.age, 0);
  });

  it('is stateless across build calls', () => {
    const User = makeUser();
    const users = userFactory(User);

    const first = users.build(2).map((u) => u.name);
    const second = users.build(2).map((u) => u.name);
    assert.deepEqual(first, ['user-1', 'user-2']);
    assert.deepEqual(second, ['user-1', 'user-2']);
  });

  it('persists rows through the repository and fires insert hooks', async () => {
    const User = makeUser();
    const log: string[] = [];
    const dataSource = await createDataSource(
      User,
      createEntitySubscriber(
        defineEntityHooks(User, {
          beforeInsert: () => {
            log.push('insert');
          },
        }),
      ),
    );

    const created = await userFactory(User).create(3, {}, { dataSource });
    assert.deepEqual(
      created.map((u) => u.name),
      ['user-1', 'user-2', 'user-3'],
    );
    for (const user of created) {
      assert.equal(typeof user.id, 'number');
    }
    assert.equal(await User.count(), 3);
    assert.deepEqual(log, ['insert', 'insert', 'insert']);

    await dataSource.destroy();
  });

  it('persists overrides through create', async () => {
    const User = makeUser();
    const dataSource = await createDataSource(User);
    const users = defineFactory(User, (sequence) => ({ name: `user-${sequence}` }));

    const created = await users.create(2, { name: 'fixed' }, { dataSource });
    assert.deepEqual(
      created.map((u) => u.name),
      ['fixed', 'fixed'],
    );
    await dataSource.destroy();
  });

  it('rejects create without a data source or with an uninitialized one', async () => {
    const User = makeUser();
    const users = userFactory(User);

    await assert.rejects(users.create(1, {}, { dataSource: {} as JsailsDataSource }), FactoryError);

    const uninitialized = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'uninitialized.sqlite'),
      entities: [User],
    });
    await assert.rejects(users.create(1, {}, { dataSource: uninitialized }), FactoryError);
  });

  it('rejects an invalid generator, count, and overrides', () => {
    const User = makeUser();
    assert.throws(() => defineFactory(User, 42 as unknown as never), FactoryError);

    const users = userFactory(User);
    assert.throws(() => users.build(-1), FactoryError);
    assert.throws(() => users.build(1.5), FactoryError);
    assert.throws(() => users.build(1, null as unknown as Record<string, never>), FactoryError);
    assert.throws(() => users.build(1, [] as unknown as Record<string, never>), FactoryError);
  });

  it('rejects a generator that returns a non-object', () => {
    const User = makeUser();
    const users = defineFactory(User, () => 42 as unknown as Record<string, never>);
    assert.throws(() => users.build(1), FactoryError);
  });
});
