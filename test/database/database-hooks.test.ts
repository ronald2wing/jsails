import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { ObjectLiteral } from 'typeorm';

import {
  createEntitySubscriber,
  defineEntityHooks,
  EntityHooksError,
  type EntityHookEvent,
  type EntityHooksDefinition,
} from '../../src/database/entity-subscribers.js';
import { JsailsDataSource } from '../../src/database/data-source.js';
import { generateMigration } from '../../src/migrations/autodetector.js';
import { migrate, type MigrationDataSource } from '../../src/migrations/migrator.js';

/**
 * The entity lifecycle hooks are exercised against a real on-disk sql.js
 * database driven by a `JsailsDataSource` whose `subscribers` option carries
 * the compiled subscriber — the same wiring an application uses. Every test
 * owns freshly declared entity classes so the global `BaseEntity` binding
 * cannot leak between tests.
 */

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'database-hooks-'));

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

    @Column({ type: 'boolean', default: true })
    active!: boolean;
  }
  return User;
}

function asMigrationDataSource(dataSource: JsailsDataSource): MigrationDataSource {
  return dataSource as unknown as MigrationDataSource;
}

let locationSeq = 0;

/** Build, initialize, and table-create a sqljs data source bound to `User`. */
async function createDataSource(
  User: ReturnType<typeof makeUser>,
  ...definitions: EntityHooksDefinition<ObjectLiteral>[]
): Promise<JsailsDataSource> {
  const location = join(tmpRoot, `db-${locationSeq++}.sqlite`);
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location,
    entities: [User],
    subscribers: [createEntitySubscriber(...definitions)],
  });
  await dataSource.initialize();
  const schema = await dataSource.getModelSchema();
  const migration = generateMigration('create_users', [], schema);
  assert.ok(migration, 'expected a create migration for the fixture schema');
  await migrate(asMigrationDataSource(dataSource), [migration]);
  return dataSource;
}

describe('entity lifecycle hooks', () => {
  it('fires insert hooks in order around a save', async () => {
    const User = makeUser();
    const log: EntityHookEvent[] = [];
    const dataSource = await createDataSource(
      User,
      defineEntityHooks(User, {
        beforeInsert: () => {
          log.push('beforeInsert');
        },
        afterInsert: () => {
          log.push('afterInsert');
        },
      }),
    );

    const user = await User.create({ name: 'alice' }).save();
    assert.equal(typeof user.id, 'number');

    assert.deepEqual(log, ['beforeInsert', 'afterInsert']);
    assert.equal(await User.count(), 1);
    await dataSource.destroy();
  });

  it('lets a beforeInsert hook mutate the entity, and the mutation persists', async () => {
    const User = makeUser();
    const dataSource = await createDataSource(
      User,
      defineEntityHooks(User, {
        beforeInsert: ({ entity }) => {
          entity.name = `mutated-${entity.name}`;
        },
      }),
    );

    const user = await User.create({ name: 'alice' }).save();
    assert.equal(user.name, 'mutated-alice');

    const reloaded = await User.findOneByOrFail({ id: user.id });
    assert.equal(reloaded.name, 'mutated-alice');
    await dataSource.destroy();
  });

  it('reports changed columns and the pre-change snapshot on update', async () => {
    const User = makeUser();
    const snapshots: { entity: { name?: string }; changed: readonly string[] }[] = [];
    const dataSource = await createDataSource(
      User,
      defineEntityHooks(User, {
        afterUpdate: ({ entity, changedColumns }) => {
          snapshots.push({ entity, changed: changedColumns ?? [] });
        },
      }),
    );

    const user = await User.create({ name: 'alice', age: 30, active: false }).save();
    user.name = 'alice-updated';
    await user.save();

    assert.equal(snapshots.length, 1);
    // The snapshot is the pre-change database row; only `name` was modified.
    assert.equal(snapshots[0]!.entity.name, 'alice');
    assert.ok(snapshots[0]!.changed.includes('name'));
    assert.ok(!snapshots[0]!.changed.includes('age'));
    await dataSource.destroy();
  });

  it('fires delete hooks in order around a remove', async () => {
    const User = makeUser();
    const log: EntityHookEvent[] = [];
    const dataSource = await createDataSource(
      User,
      defineEntityHooks(User, {
        beforeDelete: () => {
          log.push('beforeDelete');
        },
        afterDelete: () => {
          log.push('afterDelete');
        },
      }),
    );

    const user = await User.create({ name: 'alice' }).save();
    await user.remove();

    assert.deepEqual(log, ['beforeDelete', 'afterDelete']);
    assert.equal(await User.count(), 0);
    await dataSource.destroy();
  });

  it('fires afterLoad for each loaded entity', async () => {
    const User = makeUser();
    const loaded: string[] = [];
    const dataSource = await createDataSource(
      User,
      defineEntityHooks(User, {
        afterLoad: ({ entity }) => {
          loaded.push(entity.name);
        },
      }),
    );

    await User.create({ name: 'alice' }).save();
    await User.create({ name: 'bob' }).save();

    loaded.length = 0;
    const found = await User.find({ order: { name: 'ASC' } });

    assert.deepEqual(loaded, ['alice', 'bob']);
    assert.equal(found.length, 2);
    await dataSource.destroy();
  });

  it('runs multiple declarations for the same entity in declaration order', async () => {
    const User = makeUser();
    const log: string[] = [];
    const dataSource = await createDataSource(
      User,
      defineEntityHooks(User, {
        beforeInsert: () => {
          log.push('first');
        },
      }),
      defineEntityHooks(User, {
        beforeInsert: () => {
          log.push('second');
        },
      }),
    );

    await User.create({ name: 'alice' }).save();
    assert.deepEqual(log, ['first', 'second']);
    await dataSource.destroy();
  });

  it('propagates a throwing beforeInsert hook and writes nothing', async () => {
    const User = makeUser();
    const dataSource = await createDataSource(
      User,
      defineEntityHooks(User, {
        beforeInsert: () => {
          throw new Error('boom');
        },
      }),
    );

    await assert.rejects(User.create({ name: 'alice' }).save(), /boom/);
    assert.equal(await User.count(), 0);
    await dataSource.destroy();
  });

  it('awaits async hooks in order', async () => {
    const User = makeUser();
    const log: string[] = [];
    const dataSource = await createDataSource(
      User,
      defineEntityHooks(User, {
        beforeInsert: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          log.push('beforeInsert');
        },
        afterInsert: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          log.push('afterInsert');
        },
      }),
    );

    await User.create({ name: 'alice' }).save();
    assert.deepEqual(log, ['beforeInsert', 'afterInsert']);
    await dataSource.destroy();
  });

  it('keeps hook registries isolated between two data sources', async () => {
    const UserA = makeUser();
    const UserB = makeUser();
    const logA: string[] = [];
    const logB: string[] = [];

    const dataSourceA = await createDataSource(
      UserA,
      defineEntityHooks(UserA, {
        beforeInsert: () => {
          logA.push('A');
        },
      }),
    );
    const dataSourceB = await createDataSource(
      UserB,
      defineEntityHooks(UserB, {
        beforeInsert: () => {
          logB.push('B');
        },
      }),
    );

    await UserA.create({ name: 'a' }).save();
    await UserB.create({ name: 'b' }).save();

    assert.deepEqual(logA, ['A']);
    assert.deepEqual(logB, ['B']);

    await dataSourceA.destroy();
    await dataSourceB.destroy();
  });
});

describe('entity hooks declaration validation', () => {
  it('rejects a non-function handler', () => {
    assert.throws(
      () => defineEntityHooks(makeUser(), { beforeInsert: 42 as unknown as never }),
      (error: unknown) => error instanceof EntityHooksError && /beforeInsert/.test(error.message),
    );
  });

  it('rejects a non-object definition in createEntitySubscriber', () => {
    assert.throws(
      () => createEntitySubscriber(42 as unknown as EntityHooksDefinition<ObjectLiteral>),
      (error: unknown) => error instanceof EntityHooksError && /definition/.test(error.message),
    );
  });

  it('rejects a definition missing its entity', () => {
    assert.throws(
      () =>
        createEntitySubscriber({ hooks: {} } as unknown as EntityHooksDefinition<ObjectLiteral>),
      (error: unknown) => error instanceof EntityHooksError && /entity/.test(error.message),
    );
  });
});
