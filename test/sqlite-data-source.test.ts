import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { BaseEntity, Column, Entity, type EntitySchema, PrimaryGeneratedColumn } from 'typeorm';
import type { MixedList } from 'typeorm';

import {
  JsailsDataSource,
  type JsailsDataSourceOptions,
} from '../src/database/jsails-data-source.js';
import { generateMigration } from '../src/migrations/autodetector.js';
import { getMigrationStatus, migrate, type MigrationDataSource } from '../src/migrations/runner.js';
import { MigrationError } from '../src/migrations/schema-state.js';

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
