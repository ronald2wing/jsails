import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  BaseEntity,
  Column,
  DataSource,
  Entity,
  EntitySchema,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { FileDataSource, FileDataSourceError } from '../src/database/file-data-source.js';
import { UnsupportedSchemaError } from '../src/database/model-schema.js';

/**
 * FileDataSource is exercised against a real in-memory sql.js database (the
 * actual `sql.js` WASM build that TypeORM loads internally) — never mocked.
 * Every test owns freshly declared entity classes so the global `BaseEntity`
 * data-source binding cannot leak between tests.
 */

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

function makePost() {
  @Entity('posts')
  class Post extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 200, nullable: false })
    title!: string;
  }
  return Post;
}

const tmpRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'file-data-source-'),
);

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeJsonFile(name: string, data: unknown): string {
  const path = join(tmpRoot, name);
  writeFileSync(path, JSON.stringify(data));
  return path;
}

async function expectFileError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(
      error instanceof FileDataSourceError,
      `expected FileDataSourceError, got ${(error as Error)?.constructor?.name}`,
    );
    assert.match(error.message, pattern);
    return true;
  });
}

describe('FileDataSource', () => {
  it('seeds an in-memory array and serves Active Record queries', async () => {
    const User = makeUser();
    const fds = await FileDataSource.create({
      models: [
        {
          entity: User,
          rows: [
            { name: 'alice', age: 30 },
            { name: 'bob', age: 20 },
          ],
        },
      ],
    });

    assert.equal(fds.isReadOnly, true);
    assert.equal(fds.isInitialized, true);

    const all = await User.find();
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((u) => u.name).sort(), ['alice', 'bob']);
    assert.equal(
      all.every((u) => u.active),
      true,
    ); // default applied by ORM

    const alice = await User.findOneBy({ name: 'alice' });
    assert.ok(alice);
    assert.equal(alice.age, 30);

    assert.equal(await User.count(), 2);
    await fds.close();
  });

  it('seeds from a temporary JSON file', async () => {
    const User = makeUser();
    const file = writeJsonFile('users.json', [
      { name: 'carol', age: 40, active: false },
      { name: 'dave', age: null },
    ]);

    const fds = await FileDataSource.create({ models: [{ entity: User, file }] });
    const all = await User.find({ order: { name: 'ASC' } });
    assert.equal(all.length, 2);
    assert.equal(all[0]!.name, 'carol');
    assert.equal(all[0]!.active, false);
    assert.equal(all[1]!.age, null);
    await fds.close();
  });

  it('supports sorting and filtered counts', async () => {
    const User = makeUser();
    const fds = await FileDataSource.create({
      models: [
        {
          entity: User,
          rows: [
            { name: 'alice', age: 30 },
            { name: 'bob', age: 20 },
            { name: 'carol', age: 40 },
          ],
        },
      ],
    });

    const byAgeDesc = await User.find({ order: { age: 'DESC' } });
    assert.deepEqual(
      byAgeDesc.map((u) => u.age),
      [40, 30, 20],
    );

    assert.equal(await User.count({ where: { age: 40 } }), 1);
    await fds.close();
  });

  it('never writes back to the source file', async () => {
    const User = makeUser();
    const file = writeJsonFile('untouched.json', [{ name: 'alice' }]);
    const original = readFileSync(file, 'utf8');

    const fds = await FileDataSource.create({ models: [{ entity: User, file }] });
    // Attempt a write (it must fail) and then close; neither may touch the file.
    await assert.rejects(User.insert({ name: 'mallory' }), /readonly/);
    await fds.close();

    assert.equal(readFileSync(file, 'utf8'), original);
  });

  it('rejects save, insert, update, and delete as read-only', async () => {
    const User = makeUser();
    const fds = await FileDataSource.create({
      models: [{ entity: User, rows: [{ name: 'alice', age: 30 }] }],
    });

    await assert.rejects(User.insert({ name: 'mallory' }), /readonly/);
    await assert.rejects(User.save({ name: 'mallory' }), /readonly/);
    await assert.rejects(User.update({ name: 'alice' }, { name: 'new' }), /readonly/);
    await assert.rejects(User.delete({ name: 'alice' }), /readonly/);

    const alice = await User.findOneByOrFail({ name: 'alice' });
    alice.age = 31;
    await assert.rejects(alice.save(), /readonly/);
    await assert.rejects(alice.remove(), /readonly/);

    assert.equal(await User.count(), 1);
    await fds.close();
  });

  it('supports an empty typed dataset', async () => {
    const User = makeUser();
    const fds = await FileDataSource.create({ models: [{ entity: User, rows: [] }] });
    assert.deepEqual(await User.find(), []);
    assert.equal(await User.count(), 0);
    await fds.close();
  });

  it('rejects unknown fields, missing required fields, and bad value types', async () => {
    const User = makeUser();

    await expectFileError(
      FileDataSource.create({
        models: [{ entity: User, rows: [{ name: 'a', bogus: 1 }] }],
      }),
      /unknown field "bogus"/,
    );

    await expectFileError(
      FileDataSource.create({
        models: [{ entity: User, rows: [{ age: 5 }] }],
      }),
      /missing required field "name"/,
    );

    await expectFileError(
      FileDataSource.create({
        models: [{ entity: User, rows: [{ name: 42 }] }],
      }),
      /invalid value for field "name"/,
    );

    // A JSON file that is not an array, and one whose element is not an object.
    const notArray = writeJsonFile('not-array.json', { name: 'x' });
    await expectFileError(
      FileDataSource.create({ models: [{ entity: User, file: notArray }] }),
      /must be a JSON array of plain objects/,
    );

    const notObject = writeJsonFile('not-object.json', ['nope']);
    await expectFileError(
      FileDataSource.create({ models: [{ entity: User, file: notObject }] }),
      /must be a plain object/,
    );
  });

  it('releases the reservation when initialization fails', async () => {
    const User = makeUser();

    await expectFileError(
      FileDataSource.create({
        models: [{ entity: User, rows: [{ name: 'a', bogus: 1 }] }],
      }),
      /unknown field/,
    );

    // The failed create must have released its reservation on the class.
    const fds = await FileDataSource.create({
      models: [{ entity: User, rows: [{ name: 'ok' }] }],
    });
    assert.equal(await User.count(), 1);
    await fds.close();
  });

  it('rejects a second concurrent create for the same entity class', async () => {
    const User = makeUser();

    const first = FileDataSource.create({
      models: [{ entity: User, rows: [{ name: 'a' }] }],
    });
    const second = FileDataSource.create({
      models: [{ entity: User, rows: [{ name: 'b' }] }],
    });

    await expectFileError(second, /already owned by another open FileDataSource/);

    const fds = await first;
    assert.equal(await User.count(), 1);
    await fds.close();
  });

  it('keeps distinct entity classes independent', async () => {
    const User = makeUser();
    const Post = makePost();

    const fds = await FileDataSource.create({
      models: [
        { entity: User, rows: [{ name: 'alice' }] },
        { entity: Post, rows: [{ title: 'hello' }, { title: 'world' }] },
      ],
    });

    assert.equal(await User.count(), 1);
    assert.equal(await Post.count(), 2);
    assert.deepEqual((await Post.find()).map((p) => p.title).sort(), ['hello', 'world']);

    // A separate data source for a different class can coexist.
    const other = await FileDataSource.create({
      models: [{ entity: makePost(), rows: [{ title: 'independent' }] }],
    });
    assert.equal(await Post.count(), 2);
    await other.close();

    await fds.close();
  });

  it('unbinds an entity with no prior binding on close', async () => {
    const User = makeUser();
    const fds = await FileDataSource.create({
      models: [{ entity: User, rows: [{ name: 'alice' }] }],
    });
    await fds.close();

    assert.throws(() => User.getRepository(), /DataSource is not set/);
  });

  it('restores the prior data-source binding on close', async () => {
    const User = makeUser();

    // A prior data source that has metadata but is not initialized (mirrors a
    // getModelSchema-only binding): initialize then destroy leaves the binding
    // intact while `isInitialized` becomes false.
    const prior = new DataSource({ type: 'sqljs', entities: [User] });
    await prior.initialize();
    await prior.destroy();

    const fds = await FileDataSource.create({
      models: [{ entity: User, rows: [{ name: 'alice' }] }],
    });
    assert.equal(
      User.getRepository().manager.connection,
      fds.getRepository(User).manager.connection,
    );

    await fds.close();
    assert.equal(User.getRepository().manager.connection, prior);
  });

  it('does not clobber a data source that took over the binding', async () => {
    const User = makeUser();
    const fds = await FileDataSource.create({
      models: [{ entity: User, rows: [{ name: 'alice' }] }],
    });

    // An unrelated data source initializes and takes over the binding.
    const takeover = new DataSource({ type: 'sqljs', entities: [User] });
    await takeover.initialize();

    await fds.close();

    assert.equal(User.getRepository().manager.connection, takeover);
    await takeover.destroy();
  });

  it('refuses an entity already bound to an initialized data source', async () => {
    const User = makeUser();

    const active = new DataSource({ type: 'sqljs', entities: [User] });
    await active.initialize();

    await expectFileError(
      FileDataSource.create({
        models: [{ entity: User, rows: [{ name: 'alice' }] }],
      }),
      /already bound to an initialized data source/,
    );

    await active.destroy();
  });

  it('accepts an EntitySchema, and binds a BaseEntity EntitySchema target', async () => {
    const tagSchema = new EntitySchema({
      name: 'Tag',
      tableName: 'tags',
      columns: {
        id: { type: 'integer', primary: true, generated: true },
        label: { type: 'varchar', length: 50, nullable: false },
      },
    });

    class Profile extends BaseEntity {
      id!: number;
      handle!: string;
    }
    const profileSchema = new EntitySchema({
      name: 'Profile',
      tableName: 'profiles',
      target: Profile,
      columns: {
        id: { type: 'integer', primary: true, generated: true },
        handle: { type: 'varchar', length: 50, nullable: false },
      },
    });

    const fds = await FileDataSource.create({
      models: [
        { entity: tagSchema, rows: [{ label: 'a' }, { label: 'b' }] },
        { entity: profileSchema, rows: [{ handle: 'ada' }] },
      ],
    });

    const tags = await fds.getRepository(tagSchema).find();
    assert.deepEqual(tags.map((t) => t.label).sort(), ['a', 'b']);

    const profiles = await Profile.find();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]!.handle, 'ada');

    await fds.close();
  });

  it('rejects unsupported schema features (non-scalar columns, relations)', async () => {
    @Entity('things')
    class Thing extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'json', nullable: true })
      payload!: unknown;
    }
    await assert.rejects(
      FileDataSource.create({ models: [{ entity: Thing, rows: [] }] }),
      UnsupportedSchemaError,
    );

    @Entity('authors')
    class Author extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 50 })
      name!: string;
    }
    @Entity('books')
    class Book extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 50 })
      title!: string;

      @ManyToOne(() => Author)
      author!: Author;
    }
    await assert.rejects(
      FileDataSource.create({
        models: [
          { entity: Author, rows: [{ name: 'a' }] },
          { entity: Book, rows: [{ title: 'b' }] },
        ],
      }),
      UnsupportedSchemaError,
    );
  });

  it('rejects malformed model declarations', async () => {
    const User = makeUser();

    await expectFileError(FileDataSource.create({ models: [] }), /"models" must not be empty/);

    await expectFileError(
      FileDataSource.create({
        models: [{ entity: User, rows: [], file: 'x.json' }] as never,
      }),
      /exactly one of "rows" or "file"/,
    );

    await expectFileError(
      FileDataSource.create({ models: [{ entity: 'User', rows: [] }] as never }),
      /entity must be a BaseEntity subclass or an EntitySchema/,
    );
  });
});
