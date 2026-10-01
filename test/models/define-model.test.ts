import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { BaseEntity, Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { JsailsDataSource, type JsailsDataSourceOptions } from '../../src/database/data-source.js';
import { clearModelRegistry, registeredModels } from '../../src/database/model-registry.js';
import { defineModel, ModelDefinitionError } from '../../src/models/define-model.js';
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

afterEach(() => {
  clearModelRegistry();
});

describe('defineModel: lowers a spec onto TypeORM', () => {
  it('produces the same portable schema as hand-written decorators', async () => {
    // Hand-written reference model.
    @Entity('author')
    class Author extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      name!: string;
    }

    @Entity('post')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      title!: string;

      @Column({ type: 'integer', nullable: false })
      views!: number;

      @ManyToOne(() => Author, { nullable: false })
      @JoinColumn({ name: 'author_id' })
      author!: Author;
    }

    const expected = await buildSchema([Author, Post]);

    // The same shape, lowered from a spec.
    class SpecAuthor extends BaseEntity {
      declare id: number;
      declare name: string;
    }

    class SpecPost extends BaseEntity {
      declare id: number;
      declare title: string;
      declare views: number;
      declare author: SpecAuthor;
    }

    defineModel(SpecAuthor, {
      table: 'author',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [{ name: 'name', type: 'varchar', length: 200, nullable: false }],
      relations: [],
    });

    defineModel(SpecPost, {
      table: 'post',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [
        { name: 'title', type: 'varchar', length: 200, nullable: false },
        { name: 'views', type: 'integer', nullable: false },
      ],
      relations: [
        {
          kind: 'many-to-one',
          name: 'author',
          target: SpecAuthor,
          joinColumn: 'author_id',
          nullable: false,
        },
      ],
    });

    const actual = await buildSchema([SpecAuthor, SpecPost]);

    assert.deepEqual(actual, expected);
  });

  it('registers the class and its derived hooks', () => {
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
          touch: true,
        },
      ],
    });

    const models = registeredModels();
    assert.equal(models.length, 2);
    assert.equal(models[0]!.entity, Author);
    assert.equal(models[1]!.entity, Post);
    // `touch: true` derives a hook definition for the relation.
    assert.ok(models[1]!.hooks.length > 0);
  });

  it('is idempotent per class', () => {
    class Post extends BaseEntity {
      declare id: number;
    }

    const spec = {
      table: 'post',
      primaryKey: { name: 'id', kind: 'integer' } as const,
      columns: [],
      relations: [],
    };

    defineModel(Post, spec);
    defineModel(Post, spec);

    assert.equal(registeredModels().length, 1);
  });

  it('rejects a varchar column without a length', () => {
    class Post extends BaseEntity {
      declare id: number;
    }

    assert.throws(
      () =>
        defineModel(Post, {
          table: 'post',
          primaryKey: { name: 'id', kind: 'integer' },
          columns: [{ name: 'title', type: 'varchar' }],
          relations: [],
        }),
      ModelDefinitionError,
    );
  });

  it('rejects a non-integer primary key', () => {
    class Post extends BaseEntity {
      declare id: number;
    }

    assert.throws(
      () =>
        defineModel(Post, {
          table: 'post',
          primaryKey: { name: 'id', kind: 'uuid' as 'integer' },
          columns: [],
          relations: [],
        }),
      ModelDefinitionError,
    );
  });

  it('lowers a one-to-many relation with a counter cache', () => {
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

    const post = registeredModels().find((model) => model.entity === Post);
    assert.ok(post !== undefined);
    assert.ok(post.hooks.length > 0);
  });

  it('wires an encryption hook for the declared encrypted fields', () => {
    class User extends BaseEntity {
      declare id: number;
      declare ssn: string;
    }

    defineModel(User, {
      table: 'user',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [{ name: 'ssn', type: 'varchar', length: 255 }],
      relations: [],
      encrypted: ['ssn'],
    });

    const user = registeredModels().find((model) => model.entity === User);
    assert.ok(user !== undefined);
    assert.equal(user.hooks.length, 1);
  });

  it('rejects an encrypted field that is not a column', () => {
    class User extends BaseEntity {
      declare id: number;
    }

    assert.throws(
      () =>
        defineModel(User, {
          table: 'user',
          primaryKey: { name: 'id', kind: 'integer' },
          columns: [],
          relations: [],
          encrypted: ['missing'],
        }),
      ModelDefinitionError,
    );
  });
});
