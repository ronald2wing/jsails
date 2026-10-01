import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { JsailsDataSource } from '../../src/database/data-source.js';
import { generateMigration } from '../../src/migrations/autodetector.js';
import { replayMigrationHistory } from '../../src/migrations/history.js';
import { migrate, type MigrationDataSource } from '../../src/migrations/migrator.js';
import {
  BLOG_POST_TABLE,
  JsailsBlogPost,
  blogPostEntities,
  createDatabaseBlogStore,
} from '../../src/blog/database-store.js';

/**
 * The database-backed blog store is exercised against a real on-disk sql.js
 * database (the actual WASM build TypeORM loads internally), with the
 * `jsails_blog_post` table created by the real migration history — never by
 * runtime DDL.
 */

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'blog-db-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Mirror the CLI's structural cast: the runner's narrow contract predates sqljs. */
function asMigrationDataSource(dataSource: JsailsDataSource): MigrationDataSource {
  return dataSource as unknown as MigrationDataSource;
}

/** Initialize a file-backed data source and apply the entity migration. */
async function migratedDataSource(location: string): Promise<JsailsDataSource> {
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location,
    entities: [JsailsBlogPost],
  });
  await dataSource.initialize();

  const schema = await dataSource.getModelSchema();
  const migration = generateMigration('create_jsails_blog_post', [], schema);
  assert.ok(migration, 'expected a create_jsails_blog_post migration');
  await migrate(asMigrationDataSource(dataSource), [migration]);
  return dataSource;
}

/** The canonical column list: primary key first, then the rest alphabetically. */
const expectedColumns = [
  { name: 'id', type: 'integer', nullable: false, primaryKey: true },
  { name: 'body', type: 'text', nullable: false },
  { name: 'createdAt', type: 'datetime', nullable: false },
  { name: 'published', type: 'boolean', nullable: false },
  { name: 'slug', type: 'varchar', length: 190, nullable: false },
  { name: 'title', type: 'varchar', length: 190, nullable: false },
  { name: 'updatedAt', type: 'datetime', nullable: false },
];

describe('JsailsBlogPost: portable schema and migration', () => {
  it('builds the expected portable schema offline without connecting', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'schema.db'),
      entities: [JsailsBlogPost],
    });
    const schema = await dataSource.getModelSchema();

    assert.equal(dataSource.isInitialized, false);
    assert.deepEqual(schema, {
      tables: [{ name: BLOG_POST_TABLE, columns: expectedColumns }],
    });
  });

  it('emits a single create_table operation with the expected scalar columns', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'migration.db'),
      entities: [JsailsBlogPost],
    });
    const schema = await dataSource.getModelSchema();
    const migration = generateMigration('create_jsails_blog_post', [], schema);

    assert.ok(migration, 'expected a create_jsails_blog_post migration');
    assert.deepEqual(migration.dependencies, []);
    assert.equal(migration.operations.length, 1);

    const operation = migration.operations[0];
    assert.ok(operation, 'expected a create_table operation');
    if (operation.kind !== 'create_table') {
      throw new Error('unreachable: operation is not create_table');
    }
    assert.equal(operation.table.name, BLOG_POST_TABLE);
    assert.deepEqual(operation.table.columns, expectedColumns);

    assert.deepEqual(replayMigrationHistory([migration]), schema);
  });

  it('is the only entity in blogPostEntities', () => {
    assert.deepEqual(blogPostEntities, [JsailsBlogPost]);
  });
});

describe('createDatabaseBlogStore: round-trip', () => {
  it('lists in insertion order and reads a post back by id', async () => {
    const dataSource = await migratedDataSource(join(tmpRoot, 'roundtrip.db'));
    const store = createDatabaseBlogStore({ dataSource });

    assert.deepEqual(await store.list(), []);
    assert.equal(await store.get(1), undefined);

    const first = await store.create({ title: 'Hello', body: 'world' });
    const second = await store.create({ title: 'Second', body: 'body 2' });

    assert.equal(first.id, 1);
    assert.equal(second.id, 2);
    assert.match(first.createdAt, /^\d{4}-\d{2}-\d{2}T/); // store stamps createdAt itself

    const list = await store.list();
    assert.deepEqual(
      list.map((post) => post.title),
      ['Hello', 'Second'],
    );
    assert.deepEqual(await store.get(1), first);

    await dataSource.destroy();
  });

  it('updates an existing post and ignores unknown ids', async () => {
    const dataSource = await migratedDataSource(join(tmpRoot, 'update.db'));
    const store = createDatabaseBlogStore({ dataSource });

    await store.create({ title: 'a', body: '1' });
    const updated = await store.update(1, { title: 'renamed', body: '2' });

    assert.ok(updated);
    assert.equal(updated?.title, 'renamed');
    assert.equal((await store.get(1))?.body, '2');
    assert.equal(await store.update(99, { title: 'x', body: 'y' }), undefined);

    await dataSource.destroy();
  });

  it('derives a slug from the title and stores it on the row', async () => {
    const dataSource = await migratedDataSource(join(tmpRoot, 'slug.db'));
    const store = createDatabaseBlogStore({ dataSource });

    const post = await store.create({ title: '  Hello, World!  ', body: 'x' });
    const row = await dataSource.getRepository(JsailsBlogPost).findOneByOrFail({ id: post.id });
    assert.equal(row.slug, 'hello-world');

    await dataSource.destroy();
  });

  it('hides unpublished rows from list but not get, against an injected clock', async () => {
    const dataSource = await migratedDataSource(join(tmpRoot, 'published.db'));
    const clock = () => new Date('2026-01-01T00:00:00.000Z');
    const store = createDatabaseBlogStore({ dataSource, now: clock });

    const published = await store.create({ title: 'Shown', body: 'x' });
    const row = await dataSource
      .getRepository(JsailsBlogPost)
      .findOneByOrFail({ id: published.id });
    assert.equal(row.published, true);
    assert.equal(row.createdAt.getTime(), clock().getTime());

    // A row written unpublished by another path is hidden from the public list
    // but still reachable by id.
    const hidden = await dataSource.getRepository(JsailsBlogPost).save({
      title: 'Hidden',
      slug: 'hidden',
      body: 'y',
      published: false,
      createdAt: clock(),
      updatedAt: clock(),
    });

    assert.deepEqual(
      (await store.list()).map((post) => post.title),
      ['Shown'],
    );
    assert.equal((await store.get(hidden.id))?.title, 'Hidden');

    await dataSource.destroy();
  });
});

describe('createDatabaseBlogStore: missing table', () => {
  it('fails with a clear error when the table was never migrated', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'missing.db'),
      entities: [JsailsBlogPost],
    });
    await dataSource.initialize();

    const store = createDatabaseBlogStore({ dataSource });
    await assert.rejects(async () => store.list(), /makemigrations|migrate/);
    await assert.rejects(async () => store.get(1), /makemigrations|migrate/);
    await assert.rejects(
      async () => store.create({ title: 'a', body: 'b' }),
      /makemigrations|migrate/,
    );
    await assert.rejects(
      async () => store.update(1, { title: 'a', body: 'b' }),
      /makemigrations|migrate/,
    );

    await dataSource.destroy();
  });

  it('auto-initializes an uninitialized data source on first use', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'autoinit.db'),
      entities: [JsailsBlogPost],
    });
    assert.equal(dataSource.isInitialized, false);

    const store = createDatabaseBlogStore({ dataSource });
    // The store initializes the source itself, then reports the missing table
    // (this source was never migrated).
    await assert.rejects(async () => store.list(), /makemigrations|migrate/);
    assert.equal(dataSource.isInitialized, true);

    await dataSource.destroy();
  });
});

describe('createDatabaseBlogStore: lazy data source', () => {
  it('resolves the data source once, on first use, through getDataSource', async () => {
    let resolutions = 0;
    const dataSource = await migratedDataSource(join(tmpRoot, 'lazy.db'));
    const store = createDatabaseBlogStore({
      getDataSource: () => {
        resolutions += 1;
        return dataSource;
      },
    });

    assert.equal(resolutions, 0); // the thunk is not run at construction
    assert.deepEqual(await store.list(), []);
    assert.equal(resolutions, 1); // run once, on first use
    assert.deepEqual(await store.list(), []);
    assert.equal(resolutions, 1); // memoized thereafter

    await dataSource.destroy();
  });

  it('requires a dataSource or getDataSource at construction', () => {
    assert.throws(() => createDatabaseBlogStore({}), TypeError);
    assert.throws(() => createDatabaseBlogStore({ getDataSource: 'nope' as never }), TypeError);
  });
});
