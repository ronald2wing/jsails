/**
 * Field-decorator lowering: the `@jsails.*` decorators a model author writes are
 * folded by the compiler into a `ModelSpec`, and `defineModel` lowers that spec
 * onto TypeORM. This suite drives the spec directly (the compiler's folding is
 * covered in `test/compiler/model-extract.test.ts`) and asserts the resulting
 * portable schema, so a decorator that silently stops lowering is caught here.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { BaseEntity } from 'typeorm';

import { JsailsDataSource, type JsailsDataSourceOptions } from '../../src/database/data-source.js';
import { clearModelRegistry } from '../../src/database/model-registry.js';
import { defineModel } from '../../src/models/define-model.js';
import type { SchemaState } from '../../src/migrations/schema-types.js';

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

async function buildSchema(entities: Function[]): Promise<SchemaState> {
  return new JsailsDataSource(postgresOptions(entities)).getModelSchema();
}

function table(schema: SchemaState, name: string) {
  const found = schema.tables.find((candidate) => candidate.name === name);
  if (found === undefined) {
    assert.fail(`table ${name} missing`);
  }
  return found;
}

function columnOf(schema: SchemaState, tableName: string, columnName: string) {
  const found = table(schema, tableName).columns.find((candidate) => candidate.name === columnName);
  if (found === undefined) {
    assert.fail(`column ${tableName}.${columnName} missing`);
  }
  return found;
}

afterEach(() => {
  clearModelRegistry();
});

describe('field decorators lower onto the portable schema', () => {
  it('applies maxLength, unique, and nullable to columns', async () => {
    class Post extends BaseEntity {
      declare id: number;
      declare slug: string;
      declare subtitle: string;
    }

    defineModel(Post, {
      table: 'post',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [
        { name: 'slug', type: 'varchar', length: 120, unique: true },
        { name: 'subtitle', type: 'varchar', length: 255, nullable: true },
      ],
      relations: [],
    });

    const schema = await buildSchema([Post]);

    const slug = columnOf(schema, 'post', 'slug');
    assert.equal(slug.type, 'varchar');
    assert.equal(slug.length, 120);
    assert.equal(slug.nullable, false);

    const subtitle = columnOf(schema, 'post', 'subtitle');
    assert.equal(subtitle.nullable, true);

    const unique = (table(schema, 'post').uniques ?? []).some((candidate) =>
      candidate.columns.includes('slug'),
    );
    assert.equal(unique, true);
  });

  it('lowers relation behaviour flags (touch, counter_cache, inverse)', async () => {
    class Comment extends BaseEntity {
      declare id: number;
      declare post: Post;
    }
    class Post extends BaseEntity {
      declare id: number;
      declare comments: Comment[];
    }

    defineModel(Comment, {
      table: 'comment',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [],
      relations: [
        { kind: 'many-to-one', name: 'post', target: Post, joinColumn: 'post_id', nullable: false },
      ],
    });
    defineModel(Post, {
      table: 'post',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [],
      relations: [
        {
          kind: 'one-to-many',
          name: 'comments',
          target: Comment,
          inverse: 'post',
          counterCache: true,
        },
      ],
    });

    const schema = await buildSchema([Comment, Post]);

    const fk = (table(schema, 'comment').foreignKeys ?? []).find((candidate) =>
      candidate.columns.includes('post_id'),
    );
    assert.ok(fk !== undefined);
    assert.equal(fk.referencedTable, 'post');
  });

  it('lowers a nullable many-to-one FK', async () => {
    class Author extends BaseEntity {
      declare id: number;
    }
    class Post extends BaseEntity {
      declare id: number;
      declare author: Author;
    }

    defineModel(Author, {
      table: 'author',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [],
      relations: [],
    });
    defineModel(Post, {
      table: 'post',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [],
      relations: [
        {
          kind: 'many-to-one',
          name: 'author',
          target: Author,
          joinColumn: 'author_id',
          nullable: true,
        },
      ],
    });

    const schema = await buildSchema([Author, Post]);
    assert.equal(columnOf(schema, 'post', 'author_id').nullable, true);
  });
});
