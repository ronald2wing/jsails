/**
 * Named scopes: the `scope` registrar + `applyScope` composing with `ModelQuery`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { PrimaryGeneratedColumn, Column, Entity } from 'typeorm';

import { ApplicationRecord } from '../../src/database/application-record.js';
import { JsailsDataSource } from '../../src/database/data-source.js';
import { query } from '../../src/database/model-query.js';
import { qEq, qGt } from '../../src/database/query-expressions.js';
import { applyScope, resolveScope, scope, ScopeError } from '../../src/database/scopes.js';
import { diffSchemaStates } from '../../src/migrations/autodetector.js';
import { executeSchemaPlan } from '../../src/migrations/schema-executor.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'scopes-'));
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

    @Column({ type: 'varchar', length: 20, default: 'draft' })
    status!: string;
  }
  return Post;
}

let dbSeq = 0;

async function createDataSource(Post: ReturnType<typeof makePost>): Promise<JsailsDataSource> {
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location: join(tmpRoot, `db-${dbSeq++}.sqlite`),
    entities: [Post],
  });
  await dataSource.initialize();
  const schema = await dataSource.getModelSchema();
  const operations = diffSchemaStates({ tables: [] }, schema);
  await executeSchemaPlan(dataSource, operations);
  return dataSource;
}

describe('named scopes', () => {
  it('registers a scope and applies it through applyScope and ModelQuery.scope', async () => {
    const Post = makePost();
    // Register a scope that filters published + popular posts.
    scope('popular', (q) => q.where(qGt('views', 10)))(Post);
    scope('published', (q) => q.where(qEq('status', 'published')))(Post);

    const dataSource = await createDataSource(Post);
    await Post.create({ title: 'hot', views: 50, status: 'published' }).save();
    await Post.create({ title: 'cold', views: 1, status: 'published' }).save();
    await Post.create({ title: 'hot-draft', views: 99, status: 'draft' }).save();

    const popular = await query(Post).scope('popular').getMany();
    assert.deepEqual(popular.map((p) => (p as { title: string }).title).sort(), [
      'hot',
      'hot-draft',
    ]);

    const published = await applyScope(query(Post), 'published').getMany();
    assert.deepEqual(published.map((p) => (p as { title: string }).title).sort(), ['cold', 'hot']);

    await dataSource.destroy();
  });

  it('resolves a scope by name and returns undefined for an unknown name', () => {
    const Post = makePost();
    scope('published', (q) => q.where(qEq('status', 'published')))(Post);
    assert.equal(typeof resolveScope(Post, 'published'), 'function');
    assert.equal(resolveScope(Post, 'missing'), undefined);
  });

  it('rejects a duplicate or invalid scope name value-free', () => {
    const Post = makePost();
    scope('published', (q) => q.where(qEq('status', 'published')))(Post);
    assert.throws(() => scope('published', () => ({}) as never)(Post), ScopeError);
    assert.throws(() => scope('', () => ({}) as never)(Post), ScopeError);
  });

  it('applyScope throws a value-free unknown-scope error', async () => {
    const Post = makePost();
    scope('published', (q) => q.where(qEq('status', 'published')))(Post);
    const dataSource = await createDataSource(Post);
    const q = query(Post);
    // The ScopeError message is value-free: it never echoes the scope name.
    assert.throws(
      () => applyScope(q, 'nope'),
      (e: unknown) => e instanceof ScopeError && !e.message.includes('nope'),
    );
    await dataSource.destroy();
  });
});
