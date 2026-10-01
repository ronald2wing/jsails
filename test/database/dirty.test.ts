/**
 * Dirty tracking: `defineDirtyTracking` + the `changed`/`was`/`savedChanges`
 * read surface on `ApplicationRecord`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { ApplicationRecord } from '../../src/database/application-record.js';
import { JsailsDataSource } from '../../src/database/data-source.js';
import { createEntitySubscriber } from '../../src/database/entity-subscribers.js';
import { defineDirtyTracking, changed, was, savedChanges } from '../../src/database/dirty.js';
import { diffSchemaStates } from '../../src/migrations/autodetector.js';
import { executeSchemaPlan } from '../../src/migrations/schema-executor.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'dirty-'));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

function makePost() {
  @Entity('posts')
  class Post extends ApplicationRecord {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 200 })
    title!: string;

    @Column({ type: 'integer', default: 0 })
    views!: number;
  }
  return Post;
}

let dbSeq = 0;

async function createDataSource(Post: ReturnType<typeof makePost>): Promise<JsailsDataSource> {
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location: join(tmpRoot, `db-${dbSeq++}.sqlite`),
    entities: [Post],
    subscribers: [createEntitySubscriber(defineDirtyTracking(Post))],
  });
  await dataSource.initialize();
  const schema = await dataSource.getModelSchema();
  const operations = diffSchemaStates({ tables: [] }, schema);
  await executeSchemaPlan(dataSource, operations);
  return dataSource;
}

describe('dirty tracking', () => {
  it('reports [] before any edit, then lists changed columns after an in-memory edit', async () => {
    const Post = makePost();
    const dataSource = await createDataSource(Post);

    const post = await Post.create({ title: 'Hello' }).save();
    assert.deepEqual(post.changed(), []);

    post.title = 'Changed';
    assert.deepEqual(post.changed(), ['title']);
    assert.equal(post.changed('title'), true);
    assert.equal(post.changed('views'), false);
    assert.equal(post.was('title'), 'Hello');

    await dataSource.destroy();
  });

  it('records savedChanges after an update round-trip', async () => {
    const Post = makePost();
    const dataSource = await createDataSource(Post);

    const post = await Post.create({ title: 'Before', views: 0 }).save();
    await post.save(); // no-op save; nothing changed
    assert.deepEqual(post.savedChanges(), {});

    post.title = 'After';
    await post.save();
    const saved = post.savedChanges();
    assert.deepEqual(saved.title, ['Before', 'After']);

    await dataSource.destroy();
  });

  it('treats an untracked instance as unchanged (no throw)', async () => {
    const Post = makePost();
    // No subscriber wired: the instance has no snapshot.
    const post = new Post();
    post.title = 'x';
    assert.deepEqual(changed(post), []);
    assert.equal(changed(post, 'title'), false);
    assert.equal(was(post, 'title'), undefined);
    assert.deepEqual(savedChanges(post), {});
  });
});
