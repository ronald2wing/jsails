import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { ApplicationRecord } from '../../src/database/application-record.js';
import { JsailsDataSource, type JsailsDataSourceOptions } from '../../src/database/data-source.js';
import {
  clearModelRegistry,
  registerModel,
  registeredModels,
} from '../../src/database/model-registry.js';
import type { ModelSpec } from '../../src/models/define-model.js';

/**
 * The registry is module-level, so every test resets it. A test that registers a
 * model must not leak it into the next test's data source.
 */
afterEach(() => {
  clearModelRegistry();
});

function postgresOptions(entities: JsailsDataSourceOptions['entities']): JsailsDataSourceOptions {
  return {
    type: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    username: 'placeholder',
    password: 'placeholder',
    database: 'placeholder',
    entities,
    synchronize: false,
  };
}

/**
 * Build a real entity through TypeORM's own decorator factories — the same
 * mechanism the compiler emits. This keeps the test independent of the
 * compiler while exercising the exact registration path.
 */
function definePost(): typeof ApplicationRecord {
  class Post extends ApplicationRecord {
    declare id: number;
    declare title: string;
  }
  Entity('post')(Post);
  PrimaryGeneratedColumn()(Post.prototype, 'id');
  Column({ type: 'varchar', length: 200, nullable: false })(Post.prototype, 'title');
  return Post;
}

/** A minimal spec for a raw entity registered directly (bypassing `defineModel`). */
function spec(table: string): ModelSpec {
  return { table, primaryKey: { name: 'id', kind: 'integer' }, columns: [], relations: [] };
}

describe('model registry', () => {
  it('starts empty and returns a frozen snapshot', () => {
    assert.deepEqual(registeredModels(), []);
    assert.ok(Object.isFrozen(registeredModels()));
  });

  it('registers a model with its hooks and preserves order', () => {
    const Post = definePost();
    class Author extends ApplicationRecord {}
    registerModel(Post, [], spec('post'));
    registerModel(Author, [], spec('author'));

    const models = registeredModels();
    assert.equal(models.length, 2);
    assert.equal(models[0]?.entity, Post);
    assert.equal(models[1]?.entity, Author);
    assert.deepEqual(models[0]?.hooks, []);
  });

  it('is idempotent per class, replacing in place', () => {
    const Post = definePost();
    class Author extends ApplicationRecord {}
    registerModel(Post, [], spec('post'));
    registerModel(Author, [], spec('author'));
    registerModel(Post, [], spec('post'));

    const models = registeredModels();
    assert.equal(models.length, 2);
    assert.equal(models[0]?.entity, Post);
    assert.equal(models[1]?.entity, Author);
  });

  it('clearModelRegistry empties the registry', () => {
    registerModel(definePost(), [], spec('post'));
    assert.equal(registeredModels().length, 1);
    clearModelRegistry();
    assert.deepEqual(registeredModels(), []);
  });
});

describe('JsailsDataSource model harvest', () => {
  it('appends registered models to an explicit entities list', async () => {
    const Post = definePost();
    registerModel(Post, [], spec('post'));

    class Explicit extends ApplicationRecord {
      declare id: number;
    }
    Entity('explicit')(Explicit);
    PrimaryGeneratedColumn()(Explicit.prototype, 'id');

    const schema = await new JsailsDataSource(postgresOptions([Explicit])).getModelSchema();
    const tables = schema.tables.map((table) => table.name).sort();
    assert.deepEqual(tables, ['explicit', 'post']);
  });

  it('does not duplicate a model already listed explicitly', async () => {
    const Post = definePost();
    registerModel(Post, [], spec('post'));

    const schema = await new JsailsDataSource(postgresOptions([Post])).getModelSchema();
    const posts = schema.tables.filter((table) => table.name === 'post');
    assert.equal(posts.length, 1);
  });

  it('leaves a non-array entities option untouched', () => {
    const Post = definePost();
    registerModel(Post, [], spec('post'));

    // A glob string is not an array: the registry contributes only class
    // targets, so the string is passed through unchanged (TS forbids this
    // shape, but a JS caller can reach it, so the guard is exercised here).
    const options = postgresOptions(
      'dist/**/*.entity.js' as unknown as JsailsDataSourceOptions['entities'],
    );
    const dataSource = new JsailsDataSource(options);
    assert.equal(dataSource.options.entities, 'dist/**/*.entity.js');
  });

  it('is a no-op when the registry is empty', async () => {
    class Solo extends ApplicationRecord {
      declare id: number;
    }
    Entity('solo')(Solo);
    PrimaryGeneratedColumn()(Solo.prototype, 'id');

    const schema = await new JsailsDataSource(postgresOptions([Solo])).getModelSchema();
    assert.deepEqual(
      schema.tables.map((table) => table.name),
      ['solo'],
    );
  });
});
