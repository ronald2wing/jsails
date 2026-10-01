/**
 * Implicit-model end-to-end: a model lowered from a `ModelSpec` (what the
 * compiler emits for a bare `declare` field) is harvested into a
 * `JsailsDataSource`'s `entities` and behaves like any other Active Record
 * entity — columns, FK, one-to-many, same-target-two-fields, and queries.
 *
 * `JsailsDataSource` owns schema history (it rejects `synchronize`), so the
 * portable-schema assertions go through `getModelSchema()` and the query
 * assertions run against a raw TypeORM `DataSource` over the same harvested
 * entity list.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { BaseEntity, DataSource } from 'typeorm';

import { JsailsDataSource, type JsailsDataSourceOptions } from '../../src/database/data-source.js';
import { clearModelRegistry, registeredModels } from '../../src/database/model-registry.js';
import { defineModel } from '../../src/models/define-model.js';

function postgresOptions(entities: Function[]): JsailsDataSourceOptions {
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

afterEach(() => {
  clearModelRegistry();
});

describe('implicit model through JsailsDataSource', () => {
  it('harvests registered models into the portable schema', async () => {
    class Author extends BaseEntity {
      declare id: number;
      declare name: string;
      declare posts: Post[];
    }
    class Post extends BaseEntity {
      declare id: number;
      declare title: string;
      declare author: Author;
    }

    defineModel(Author, {
      table: 'author',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [{ name: 'name', type: 'varchar', length: 200, nullable: false }],
      relations: [{ kind: 'one-to-many', name: 'posts', target: Post, inverse: 'author' }],
    });
    defineModel(Post, {
      table: 'post',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [{ name: 'title', type: 'varchar', length: 200, nullable: false }],
      relations: [
        {
          kind: 'many-to-one',
          name: 'author',
          target: Author,
          joinColumn: 'author_id',
          nullable: false,
        },
      ],
    });

    // No explicit `entities` — the registry is the only source.
    const schema = await new JsailsDataSource(postgresOptions([])).getModelSchema();
    assert.deepEqual(schema.tables.map((table) => table.name).sort(), ['author', 'post']);
    const post = schema.tables.find((table) => table.name === 'post');
    assert.ok(post?.columns.some((column) => column.name === 'author_id'));
  });

  it('runs queries against a harvested model', async () => {
    class Author extends BaseEntity {
      declare id: number;
      declare name: string;
      declare posts: Post[];
    }
    class Post extends BaseEntity {
      declare id: number;
      declare title: string;
      declare author: Author;
    }

    defineModel(Author, {
      table: 'author',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [{ name: 'name', type: 'varchar', length: 200, nullable: false }],
      relations: [{ kind: 'one-to-many', name: 'posts', target: Post, inverse: 'author' }],
    });
    defineModel(Post, {
      table: 'post',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [{ name: 'title', type: 'varchar', length: 200, nullable: false }],
      relations: [
        {
          kind: 'many-to-one',
          name: 'author',
          target: Author,
          joinColumn: 'author_id',
          nullable: false,
        },
      ],
    });

    const entities = registeredModels().map((model) => model.entity);
    const source = new DataSource({
      type: 'sqljs',
      entities,
      synchronize: true,
      logging: false,
    });
    await source.initialize();
    try {
      const author = await source.getRepository(Author).save({ name: 'Alice' } as Author);
      await source.getRepository(Post).save({ title: 'Hello', author } as Post);

      const posts = await source.getRepository(Post).find({ relations: { author: true } });
      assert.equal(posts.length, 1);
      assert.equal(posts[0]?.title, 'Hello');
      assert.equal(posts[0]?.author.id, author.id);
    } finally {
      await source.destroy();
    }
  });

  it('disambiguates two relations to the same target by field name', async () => {
    class User extends BaseEntity {
      declare id: number;
      declare name: string;
    }
    class Post extends BaseEntity {
      declare id: number;
      declare title: string;
      declare author: User;
      declare editor: User;
    }

    defineModel(User, {
      table: 'user',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [{ name: 'name', type: 'varchar', length: 200, nullable: false }],
      relations: [],
    });
    defineModel(Post, {
      table: 'post',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [{ name: 'title', type: 'varchar', length: 200, nullable: false }],
      relations: [
        {
          kind: 'many-to-one',
          name: 'author',
          target: User,
          joinColumn: 'author_id',
          nullable: false,
        },
        {
          kind: 'many-to-one',
          name: 'editor',
          target: User,
          joinColumn: 'editor_id',
          nullable: true,
        },
      ],
    });

    const entities = registeredModels().map((model) => model.entity);
    const source = new DataSource({
      type: 'sqljs',
      entities,
      synchronize: true,
      logging: false,
    });
    await source.initialize();
    try {
      const alice = await source.getRepository(User).save({ name: 'Alice' } as User);
      const bob = await source.getRepository(User).save({ name: 'Bob' } as User);
      await source.getRepository(Post).save({ title: 'Draft', author: alice, editor: bob } as Post);

      const post = await source
        .getRepository(Post)
        .findOneOrFail({ where: { title: 'Draft' }, relations: { author: true, editor: true } });
      assert.equal(post.author.id, alice.id);
      assert.equal(post.editor.id, bob.id);
    } finally {
      await source.destroy();
    }
  });
});
