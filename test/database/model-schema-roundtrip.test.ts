/**
 * §7 round-trip proof: a model lowered from a `ModelSpec` (the shape the
 * compiler emits for an implicit model) must produce a portable schema
 * byte-identical to the equivalent hand-written TypeORM model. If the lowering
 * ever diverges, `db:push` would silently miss a column or FK.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { BaseEntity, Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

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

afterEach(() => {
  clearModelRegistry();
});

describe('model-schema round-trip', () => {
  it('matches a hand-written model with columns, a unique, and a FK', async () => {
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

      @Column({ type: 'varchar', length: 120, nullable: false, unique: true })
      slug!: string;

      @Column({ type: 'text', nullable: true })
      body!: string;

      @Column({ type: 'integer', nullable: false })
      views!: number;

      @ManyToOne(() => Author, { nullable: false })
      @JoinColumn({ name: 'author_id' })
      author!: Author;
    }

    const expected = await buildSchema([Author, Post]);

    class SpecAuthor extends BaseEntity {
      declare id: number;
      declare name: string;
    }

    class SpecPost extends BaseEntity {
      declare id: number;
      declare slug: string;
      declare body: string;
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
        { name: 'slug', type: 'varchar', length: 120, nullable: false, unique: true },
        { name: 'body', type: 'text', nullable: true },
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

  it('matches a hand-written one-to-many inverse', async () => {
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

      @ManyToOne(() => Author, { nullable: false })
      @JoinColumn({ name: 'author_id' })
      author!: Author;
    }

    const expected = await buildSchema([Author, Post]);

    class SpecAuthor extends BaseEntity {
      declare id: number;
      declare name: string;
      declare posts: SpecPost[];
    }

    class SpecPost extends BaseEntity {
      declare id: number;
      declare title: string;
      declare author: SpecAuthor;
    }

    defineModel(SpecAuthor, {
      table: 'author',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [{ name: 'name', type: 'varchar', length: 200, nullable: false }],
      relations: [{ kind: 'one-to-many', name: 'posts', target: SpecPost, inverse: 'author' }],
    });

    defineModel(SpecPost, {
      table: 'post',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [{ name: 'title', type: 'varchar', length: 200, nullable: false }],
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
});
