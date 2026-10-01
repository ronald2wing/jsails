import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { BaseEntity, Column, Entity, type EntitySchema, PrimaryGeneratedColumn } from 'typeorm';
import type { MixedList } from 'typeorm';

import { JsailsDataSource, type JsailsDataSourceOptions } from '../../src/database/data-source.js';
import { generateMigration } from '../../src/migrations/autodetector.js';
import type { MigrationDefinition } from '../../src/migrations/history.js';
import {
  getMigrationStatus,
  migrate,
  rollbackTo,
  type MigrationDataSource,
} from '../../src/migrations/migrator.js';
import { MigrationError } from '../../src/migrations/schema-state.js';

/**
 * `JsailsDataSource`'s sqljs form is exercised against a real on-disk sql.js
 * database (the actual WASM build TypeORM loads internally) — never mocked.
 * Every test owns freshly declared entity classes so the global `BaseEntity`
 * data-source binding cannot leak between tests or files.
 */

type AnyEntity = Function | string | EntitySchema<unknown>;

const tmpRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'sqlite-data-source-'),
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

    @Column({ type: 'boolean', default: true })
    active!: boolean;
  }
  return User;
}

function makeUserV1() {
  @Entity('users')
  class UserV1 extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100, nullable: false })
    name!: string;
  }
  return UserV1;
}

function makeUserV2() {
  @Entity('users')
  class UserV2 extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100, nullable: false })
    name!: string;

    @Column({ type: 'integer', nullable: true })
    age!: number | null;
  }
  return UserV2;
}

function makeUserV3() {
  @Entity('users')
  class UserV3 extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100, nullable: false })
    name!: string;

    @Column({ type: 'integer', nullable: true })
    age!: number | null;

    @Column({ type: 'boolean', default: true })
    active!: boolean;
  }
  return UserV3;
}

function sqljsOptions(location: string, entities: MixedList<AnyEntity>): JsailsDataSourceOptions {
  return { type: 'sqljs', location, entities };
}

/** Mirror the CLI's structural cast: the runner's narrow contract predates sqljs. */
function asMigrationDataSource(dataSource: JsailsDataSource): MigrationDataSource {
  return dataSource as unknown as MigrationDataSource;
}

function expectMigrationError(factory: () => unknown, pattern: RegExp): void {
  assert.throws(factory, (error: unknown) => {
    assert.ok(
      error instanceof MigrationError,
      `expected MigrationError, got ${(error as Error)?.constructor?.name}`,
    );
    assert.match(error.message, pattern);
    return true;
  });
}

describe('JsailsDataSource: sqlite construction guards', () => {
  it('rejects a missing location', () => {
    expectMigrationError(
      () => new JsailsDataSource({ type: 'sqljs', entities: [] }),
      /non-empty "location"/,
    );
  });

  it('rejects an empty location', () => {
    expectMigrationError(
      () => new JsailsDataSource({ type: 'sqljs', location: '', entities: [] }),
      /non-empty "location"/,
    );
  });

  it('rejects a NUL character in the location', () => {
    expectMigrationError(
      () => new JsailsDataSource({ type: 'sqljs', location: 'a\0b', entities: [] }),
      /NUL/,
    );
  });

  it('rejects an in-memory database (Uint8Array)', () => {
    expectMigrationError(
      () =>
        new JsailsDataSource({
          type: 'sqljs',
          location: join(tmpRoot, 'memory.db'),
          database: new Uint8Array([1, 2, 3]),
          entities: [],
        }),
      /does not allow "database"/,
    );
  });

  it('rejects autoSave: false', () => {
    expectMigrationError(
      () =>
        new JsailsDataSource({
          type: 'sqljs',
          location: join(tmpRoot, 'autosave.db'),
          entities: [],
          autoSave: false,
        }),
      /autoSave/,
    );
  });

  it('rejects a missing parent directory', () => {
    expectMigrationError(
      () => new JsailsDataSource(sqljsOptions(join(tmpRoot, 'missing-dir', 'x.db'), [])),
      /parent directory .* does not exist/,
    );
  });

  it('rejects a parent that is not a directory', () => {
    const file = join(tmpRoot, 'plain-file');
    writeFileSync(file, 'not a directory');
    expectMigrationError(
      () => new JsailsDataSource(sqljsOptions(join(file, 'x.db'), [])),
      /not a directory/,
    );
  });

  it('rejects synchronize: true on the sqljs driver too', () => {
    expectMigrationError(
      () =>
        new JsailsDataSource({
          type: 'sqljs',
          location: join(tmpRoot, 'sync.db'),
          entities: [],
          synchronize: true,
        }),
      /synchronize/,
    );
  });

  it('resolves a relative location to an absolute path', () => {
    const target = join(tmpRoot, 'relative-users.db');
    const rel = relative(process.cwd(), target);
    assert.notEqual(rel, '');

    const dataSource = new JsailsDataSource(sqljsOptions(rel, [makeUser()]));
    assert.equal(dataSource.jsailsDriver, 'sqlite');
    assert.equal((dataSource.options as { location?: string }).location, target);
  });
});

describe('JsailsDataSource: sqlite portable schema and migrations', () => {
  it('builds the portable schema offline without connecting', async () => {
    const dataSource = new JsailsDataSource(
      sqljsOptions(join(tmpRoot, 'mapping.db'), [makeUser()]),
    );
    const schema = await dataSource.getModelSchema();
    assert.equal(dataSource.isInitialized, false);
    assert.deepEqual(schema, {
      tables: [
        {
          name: 'users',
          columns: [
            { name: 'id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'active', type: 'boolean', nullable: false, default: true },
            { name: 'age', type: 'integer', nullable: true },
            { name: 'name', type: 'varchar', length: 100, nullable: false },
          ],
        },
      ],
    });
  });

  it('persists schema, migrations, and rows across destroy and reopen', async () => {
    const location = join(tmpRoot, 'persist.db');
    const User = makeUser();
    const dataSource = new JsailsDataSource(sqljsOptions(location, [User]));
    await dataSource.initialize();

    const schema = await dataSource.getModelSchema();
    const migration = generateMigration('create_users', [], schema);
    assert.ok(migration, 'expected a create_users migration');
    assert.deepEqual((await migrate(asMigrationDataSource(dataSource), [migration])).applied, [
      'create_users',
    ]);

    // Active Record CRUD through the same surface as a server driver.
    await User.create({ name: 'alice', age: 30 }).save();
    await User.insert({ name: 'bob', age: 20, active: false });

    let all = await User.find({ order: { name: 'ASC' } });
    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((u) => u.name),
      ['alice', 'bob'],
    );
    assert.equal(all[0]!.active, true, 'the boolean default is applied');

    await User.update({ name: 'alice' }, { age: 31 });
    await User.delete({ name: 'bob' });

    all = await User.find({ order: { name: 'ASC' } });
    assert.equal(all.length, 1);
    assert.equal(all[0]!.name, 'alice');
    assert.equal(all[0]!.age, 31);

    await dataSource.destroy();

    // Reopen the same file with a fresh entity class; rows must still be there.
    const User2 = makeUser();
    const reopened = new JsailsDataSource(sqljsOptions(location, [User2]));
    await reopened.initialize();

    const rows = await User2.find({ order: { name: 'ASC' } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, 'alice');
    assert.equal(rows[0]!.age, 31);

    // The migration history survived too: status reports it applied and a
    // re-run is a no-op.
    const schema2 = await reopened.getModelSchema();
    const migration2 = generateMigration('create_users', [], schema2);
    assert.ok(migration2);

    const status = await getMigrationStatus(asMigrationDataSource(reopened), [migration2]);
    assert.equal(status.tableExists, true);
    assert.deepEqual(status.applied, ['create_users']);
    assert.deepEqual(status.pending, []);
    assert.deepEqual(status.dirty, []);

    assert.deepEqual((await migrate(asMigrationDataSource(reopened), [migration2])).applied, []);

    await reopened.destroy();
  });

  it('rejects a checksum mismatch on an applied migration', async () => {
    const location = join(tmpRoot, 'checksum.db');
    const dataSource = new JsailsDataSource(sqljsOptions(location, [makeUser()]));
    await dataSource.initialize();

    const schema = await dataSource.getModelSchema();
    const migration = generateMigration('create_users', [], schema);
    assert.ok(migration);
    await migrate(asMigrationDataSource(dataSource), [migration]);

    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.query('UPDATE jsails_migrations SET checksum = ? WHERE name = ?', [
      '0'.repeat(64),
      'create_users',
    ]);
    await queryRunner.release();

    await assert.rejects(
      migrate(asMigrationDataSource(dataSource), [migration]),
      /checksum mismatch/,
    );
    await dataSource.destroy();
  });

  it('rejects a tracking table that is not a prefix of the history', async () => {
    const location = join(tmpRoot, 'prefix.db');
    const dataSource = new JsailsDataSource(sqljsOptions(location, [makeUserV1()]));
    await dataSource.initialize();

    const v1 = await dataSource.getModelSchema();
    const m1 = generateMigration('create_users', [], v1);
    assert.ok(m1);

    // A second model adds a nullable column; its schema is built offline.
    const v2 = await new JsailsDataSource(
      sqljsOptions(join(tmpRoot, 'unused.db'), [makeUserV2()]),
    ).getModelSchema();
    const m2 = generateMigration('add_age', [m1], v2);
    assert.ok(m2);

    await migrate(asMigrationDataSource(dataSource), [m1, m2]);

    // Delete the first row, leaving only "add_age" recorded.
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.query('DELETE FROM jsails_migrations WHERE name = ?', ['create_users']);
    await queryRunner.release();

    await assert.rejects(migrate(asMigrationDataSource(dataSource), [m1, m2]), /prefix/);
    await dataSource.destroy();
  });

  it('surfaces a corrupt database file on first query', async () => {
    const location = join(tmpRoot, 'corrupt.db');
    writeFileSync(location, 'this is not a sqlite database file');

    const dataSource = new JsailsDataSource(sqljsOptions(location, [makeUser()]));
    // sql.js defers the header check: initialize (a PRAGMA-only open) succeeds
    // and the error surfaces on the first real query.
    await dataSource.initialize();

    const schema = await dataSource.getModelSchema();
    const migration = generateMigration('create_users', [], schema);
    assert.ok(migration);

    await assert.rejects(
      migrate(asMigrationDataSource(dataSource), [migration]),
      /not a database/i,
    );
    await dataSource.destroy();
  });
});

/** Build the `create_users` migration for the id+name model, offline. */
async function createUsersMigration(): Promise<MigrationDefinition> {
  const v1 = await new JsailsDataSource(
    sqljsOptions(join(tmpRoot, 'schema-v1.db'), [makeUserV1()]),
  ).getModelSchema();
  const migration = generateMigration('create_users', [], v1);
  assert.ok(migration, 'expected a create_users migration');
  return migration;
}

/** Build the `add_age` migration on top of `create_users`, offline. */
async function addAgeMigration(createUsers: MigrationDefinition): Promise<MigrationDefinition> {
  const v2 = await new JsailsDataSource(
    sqljsOptions(join(tmpRoot, 'schema-v2.db'), [makeUserV2()]),
  ).getModelSchema();
  const migration = generateMigration('add_age', [createUsers], v2);
  assert.ok(migration, 'expected an add_age migration');
  return migration;
}

describe('JsailsDataSource: sqlite rollback', () => {
  it('forward then down-to-target drops the added column and preserves surviving data', async () => {
    const location = join(tmpRoot, 'rollback-target.db');
    const UserV2 = makeUserV2();
    const dataSource = new JsailsDataSource(sqljsOptions(location, [UserV2]));
    await dataSource.initialize();

    const m1 = await createUsersMigration();
    const m2 = await addAgeMigration(m1);
    await migrate(asMigrationDataSource(dataSource), [m1, m2]);
    await UserV2.create({ name: 'alice', age: 30 }).save();

    const result = await rollbackTo(asMigrationDataSource(dataSource), [m1, m2], {
      targetName: 'create_users',
    });
    assert.deepEqual(result.unapplied, ['add_age']);

    const status = await getMigrationStatus(asMigrationDataSource(dataSource), [m1, m2]);
    assert.deepEqual(status.applied, ['create_users']);
    assert.deepEqual(status.pending, ['add_age']);

    // The added column is gone, so a query against it fails.
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await assert.rejects(queryRunner.query('SELECT age FROM users'), /no such column/i);
    await queryRunner.release();

    // Reopening with the earlier model reads the surviving row.
    await dataSource.destroy();
    const UserV1 = makeUserV1();
    const reopened = new JsailsDataSource(sqljsOptions(location, [UserV1]));
    await reopened.initialize();
    const names = await UserV1.find({ order: { name: 'ASC' } });
    assert.deepEqual(
      names.map((user) => user.name),
      ['alice'],
    );
    await reopened.destroy();
  });

  it('rolls back the last N applied migrations by steps', async () => {
    const location = join(tmpRoot, 'rollback-steps.db');
    const UserV3 = makeUserV3();
    const dataSource = new JsailsDataSource(sqljsOptions(location, [UserV3]));
    await dataSource.initialize();

    const m1 = await createUsersMigration();
    const m2 = await addAgeMigration(m1);
    const v3 = await dataSource.getModelSchema();
    const m3 = generateMigration('add_active', [m1, m2], v3);
    assert.ok(m3);

    await migrate(asMigrationDataSource(dataSource), [m1, m2, m3]);

    const result = await rollbackTo(asMigrationDataSource(dataSource), [m1, m2, m3], { steps: 1 });
    assert.deepEqual(result.unapplied, ['add_active']);

    const status = await getMigrationStatus(asMigrationDataSource(dataSource), [m1, m2, m3]);
    assert.deepEqual(status.applied, ['create_users', 'add_age']);
    assert.deepEqual(status.pending, ['add_active']);
    await dataSource.destroy();
  });

  it('refuses a checksum mismatch before executing any rollback DDL', async () => {
    const location = join(tmpRoot, 'rollback-checksum.db');
    const UserV2 = makeUserV2();
    const dataSource = new JsailsDataSource(sqljsOptions(location, [UserV2]));
    await dataSource.initialize();

    const m1 = await createUsersMigration();
    const m2 = await addAgeMigration(m1);
    await migrate(asMigrationDataSource(dataSource), [m1, m2]);

    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.query('UPDATE jsails_migrations SET checksum = ? WHERE name = ?', [
      '0'.repeat(64),
      'add_age',
    ]);
    await queryRunner.release();

    await assert.rejects(
      rollbackTo(asMigrationDataSource(dataSource), [m1, m2], { targetName: 'create_users' }),
      /checksum mismatch/,
    );

    // No DDL ran: the added column must still exist. (The corrupted checksum
    // also still fails `getMigrationStatus`, so the live column is the proof.)
    const verify = dataSource.createQueryRunner();
    await verify.connect();
    await verify.query('SELECT age FROM users');
    await verify.release();

    await dataSource.destroy();
  });

  it('requires allowDestructive to un-apply the first migration', async () => {
    const location = join(tmpRoot, 'rollback-root.db');
    const UserV2 = makeUserV2();
    const dataSource = new JsailsDataSource(sqljsOptions(location, [UserV2]));
    await dataSource.initialize();

    const m1 = await createUsersMigration();
    const m2 = await addAgeMigration(m1);
    await migrate(asMigrationDataSource(dataSource), [m1, m2]);

    await assert.rejects(
      rollbackTo(asMigrationDataSource(dataSource), [m1, m2], { steps: 2 }),
      /allowDestructive/,
    );

    const result = await rollbackTo(asMigrationDataSource(dataSource), [m1, m2], {
      steps: 2,
      allowDestructive: true,
    });
    assert.deepEqual(result.unapplied, ['add_age', 'create_users']);

    const status = await getMigrationStatus(asMigrationDataSource(dataSource), [m1, m2]);
    assert.equal(status.tableExists, true);
    assert.deepEqual(status.applied, []);
    assert.deepEqual(status.pending, ['create_users', 'add_age']);
    await dataSource.destroy();
  });
});
