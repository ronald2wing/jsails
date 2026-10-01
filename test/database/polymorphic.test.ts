/**
 * Tests for the polymorphic-relation core: decorator column generation,
 * schema-state attachment, descriptor validation round-trips, and the four
 * runtime loaders (`loadPolymorphic`, `loadPolymorphicInverse`,
 * `resolvePolymorphicTarget`, `resolvePolymorphicInverse`).
 *
 * Schema tests use the connectionless `JsailsDataSource.getModelSchema()`;
 * loader tests use the in-memory `FileDataSource` because it needs no
 * external services and exercises Active Record queries against real SQLite.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { JsailsDataSource } from '../../src/database/data-source.js';
import { FileDataSource } from '../../src/database/file-data-source.js';
import { UnsupportedSchemaError } from '../../src/database/model-schema.js';
import {
  clearPolymorphicRegistry,
  PolymorphicRelation,
  loadPolymorphic,
  loadPolymorphicInverse,
  resolvePolymorphicTarget,
  resolvePolymorphicInverse,
} from '../../src/database/polymorphic.js';
import {
  MigrationError,
  type SchemaState,
  type TableDefinition,
} from '../../src/migrations/schema-state.js';
import {
  type Operation,
  applyOperation,
  invertOperation,
  validateOperation,
} from '../../src/migrations/operations.js';
import { generateMigration } from '../../src/migrations/autodetector.js';
import { replayMigrationHistory } from '../../src/migrations/history.js';

async function buildSchema(entities: Function[]): ReturnType<JsailsDataSource['getModelSchema']> {
  return new JsailsDataSource({
    type: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    username: 'placeholder',
    password: 'placeholder',
    database: 'placeholder',
    entities,
    synchronize: false,
  }).getModelSchema();
}

describe('PolymorphicRelation decorator', () => {
  afterEach(() => {
    clearPolymorphicRegistry();
  });

  it('generates target_type (varchar 190, not null) and target_id (integer, not null) columns', async () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity('comments')
    class Comment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'text', nullable: false })
      body!: string;

      @PolymorphicRelation({ targets: [Post], relatedName: 'comments' })
      target!: unknown;
    }

    const schema = await buildSchema([Post, Comment]);
    const table = schema.tables.find((t) => t.name === 'comments');
    assert.ok(table, 'table exists');

    const typeCol = table.columns.find((c) => c.name === 'target_type');
    const idCol = table.columns.find((c) => c.name === 'target_id');

    assert.ok(typeCol, 'type column exists');
    assert.equal(typeCol.type, 'varchar');
    assert.equal(typeCol.length, 190);
    assert.equal(typeCol.nullable, false);

    assert.ok(idCol, 'id column exists');
    assert.equal(idCol.type, 'integer');
    assert.equal(idCol.nullable, false);
  });

  it('honors custom typeColumn and idColumn names', async () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity('comments')
    class Comment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @PolymorphicRelation({
        targets: [Post],
        relatedName: 'comments',
        typeColumn: 'ref_type',
        idColumn: 'ref_id',
      })
      ref!: unknown;
    }

    const schema = await buildSchema([Post, Comment]);
    const table = schema.tables.find((t) => t.name === 'comments');
    assert.ok(table);

    const typeCol = table.columns.find((c) => c.name === 'ref_type');
    const idCol = table.columns.find((c) => c.name === 'ref_id');

    assert.ok(typeCol, 'custom type column exists');
    assert.equal(typeCol.type, 'varchar');
    assert.equal(typeCol.length, 190);

    assert.ok(idCol, 'custom id column exists');
    assert.equal(idCol.type, 'integer');
  });

  it('snake-cases the property name for default column names', async () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity('comments')
    class Comment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @PolymorphicRelation({ targets: [Post], relatedName: 'comments' })
      commentTarget!: unknown;
    }

    const schema = await buildSchema([Post, Comment]);
    const table = schema.tables.find((t) => t.name === 'comments');
    assert.ok(table);

    assert.ok(table.columns.find((c) => c.name === 'comment_target_type'));
    assert.ok(table.columns.find((c) => c.name === 'comment_target_id'));
  });

  it('rejects empty targets array', () => {
    assert.throws(() => {
      // Use a class factory that throws at class definition time
      const fn = () => {
        class Test extends BaseEntity {
          @PolymorphicRelation([] as never)
          target!: unknown;
        }
        return Test;
      };
      fn();
    }, /targets/);
  });

  it('rejects missing relatedName', () => {
    assert.throws(() => {
      const fn = () => {
        class Test extends BaseEntity {
          @PolymorphicRelation({ targets: [BaseEntity] } as never)
          target!: unknown;
        }
        return Test;
      };
      fn();
    }, /relatedName/);
  });
});

describe('buildSchemaStateFromMetadatas polymorphic descriptor', () => {
  afterEach(() => {
    clearPolymorphicRegistry();
  });

  it('attaches the polymorphic descriptor with resolved target table names', async () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      title!: string;
    }

    @Entity('videos')
    class Video extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      url!: string;
    }

    @Entity('comments')
    class Comment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'text', nullable: false })
      body!: string;

      @PolymorphicRelation({
        targets: [Post, Video],
        relatedName: 'comments',
      })
      target!: unknown;
    }

    const schema = await buildSchema([Comment, Post, Video]);
    const table = schema.tables.find((t) => t.name === 'comments');
    assert.ok(table);
    assert.ok(table.polymorphic, 'polymorphic descriptor is attached');
    const poly = table.polymorphic;

    assert.equal(poly.typeColumn, 'target_type');
    assert.equal(poly.idColumn, 'target_id');
    assert.deepEqual(poly.targets, ['posts', 'videos']);
  });

  it('throws UnsupportedSchemaError when a target class has no table metadata', async () => {
    class NotAnEntity {
      id!: number;
    }

    @Entity('comments')
    class Comment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'text', nullable: false })
      body!: string;

      @PolymorphicRelation({
        targets: [NotAnEntity],
        relatedName: 'comments',
      })
      target!: unknown;
    }

    await assert.rejects(buildSchema([Comment]), (error: unknown) => {
      assert.ok(error instanceof UnsupportedSchemaError);
      assert.match(error.message, /no registered table metadata/);
      return true;
    });
  });
});

describe('normalizeSchemaState polymorphic round-trip', () => {
  afterEach(() => {
    clearPolymorphicRegistry();
  });

  it('preserves the polymorphic descriptor through normalizeSchemaState', async () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      title!: string;
    }

    @Entity('comments')
    class Comment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @PolymorphicRelation({
        targets: [Post],
        relatedName: 'comments',
      })
      target!: unknown;
    }

    const schema = await buildSchema([Comment, Post]);
    const table = schema.tables.find((t) => t.name === 'comments');
    assert.ok(table?.polymorphic);
    assert.deepEqual(table.polymorphic, {
      typeColumn: 'target_type',
      idColumn: 'target_id',
      targets: ['posts'],
    });
  });
});

describe('polymorphic descriptor validation', () => {
  it('rejects empty targets array via normalizePolymorphic', async () => {
    const { normalizePolymorphic } = await import('../../src/migrations/schema-state.js');
    assert.throws(
      () => normalizePolymorphic({ typeColumn: 't', idColumn: 'i', targets: [] }, 'tbl'),
      MigrationError,
    );
  });

  it('rejects missing typeColumn via normalizePolymorphic', async () => {
    const { normalizePolymorphic } = await import('../../src/migrations/schema-state.js');
    assert.throws(
      () => normalizePolymorphic({ idColumn: 'i', targets: ['posts'] }, 'tbl'),
      MigrationError,
    );
  });

  it('rejects empty idColumn via normalizePolymorphic', async () => {
    const { normalizePolymorphic } = await import('../../src/migrations/schema-state.js');
    assert.throws(
      () => normalizePolymorphic({ typeColumn: 't', idColumn: '', targets: ['posts'] }, 'tbl'),
      MigrationError,
    );
  });

  it('rejects duplicate targets', async () => {
    const { normalizePolymorphic } = await import('../../src/migrations/schema-state.js');
    assert.throws(
      () =>
        normalizePolymorphic(
          { typeColumn: 't', idColumn: 'i', targets: ['posts', 'posts'] },
          'tbl',
        ),
      MigrationError,
    );
  });

  it('rejects unknown column when columnNames set', async () => {
    const { normalizePolymorphic } = await import('../../src/migrations/schema-state.js');
    assert.throws(
      () =>
        normalizePolymorphic(
          { typeColumn: 'unknown_col', idColumn: 'ref_id', targets: ['posts'] },
          'tbl',
          new Set(['ref_id']),
        ),
      MigrationError,
    );
  });

  it('returns undefined for undefined input', async () => {
    const { normalizePolymorphic } = await import('../../src/migrations/schema-state.js');
    assert.equal(normalizePolymorphic(undefined, 'tbl'), undefined);
  });
});

describe('resolvePolymorphicTarget and resolvePolymorphicInverse (sync, no I/O)', () => {
  afterEach(() => {
    clearPolymorphicRegistry();
  });

  it('resolvePolymorphicTarget returns the matching class based on type column value', () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      title!: string;
    }

    @Entity('videos')
    class Video extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity('comments')
    class Comment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @PolymorphicRelation({
        targets: [Post, Video],
        relatedName: 'comments',
      })
      target!: unknown;
    }

    const instance = Object.create(Comment.prototype);
    (instance as Record<string, unknown>).target_type = 'posts';
    (instance as Record<string, unknown>).target_id = 1;

    const resolved = resolvePolymorphicTarget(instance, 'target');
    assert.equal(resolved, Post);
  });

  it('resolvePolymorphicTarget returns undefined when type column is null', () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity('comments')
    class Comment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @PolymorphicRelation({
        targets: [Post],
        relatedName: 'comments',
      })
      target!: unknown;
    }

    const instance = Object.create(Comment.prototype);
    (instance as Record<string, unknown>).target_type = null;
    (instance as Record<string, unknown>).target_id = null;

    const resolved = resolvePolymorphicTarget(instance, 'target');
    assert.equal(resolved, undefined);
  });

  it('resolvePolymorphicInverse returns the child class that targets the instance table', () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity('comments')
    class Comment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @PolymorphicRelation({
        targets: [Post],
        relatedName: 'comments',
      })
      target!: unknown;
    }

    const post = Object.create(Post.prototype);
    (post as Record<string, unknown>).id = 1;

    const resolved = resolvePolymorphicInverse(post, 'comments');
    assert.equal(resolved, Comment);
  });

  it('resolvePolymorphicInverse returns undefined when no match', () => {
    @Entity('videos')
    class Video extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity('comments')
    class Comment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @PolymorphicRelation({
        targets: [Video],
        relatedName: 'comments',
      })
      target!: unknown;
    }

    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    // Post is NOT a target of any polymorphic relation with relatedName 'comments'
    void Comment; // decorator side effect registers the polymorphic relation
    const post = Object.create(Post.prototype);
    const resolved = resolvePolymorphicInverse(post, 'comments');
    assert.equal(resolved, undefined);
  });
});

describe('loadPolymorphic (forward: child -> parent)', () => {
  afterEach(() => {
    clearPolymorphicRegistry();
  });

  it('returns null when type and id columns are null', async () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      title!: string;
    }

    @Entity('comments')
    class Comment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'text', nullable: false })
      body!: string;

      @PolymorphicRelation({
        targets: [Post],
        relatedName: 'comments',
      })
      target!: unknown;
    }

    const fds = await FileDataSource.create({
      models: [
        { entity: Post, rows: [{ id: 1, title: 'hello' }] },
        {
          entity: Comment,
          rows: [{ id: 1, body: 'nice', target_type: 'posts', target_id: 1 }],
        },
      ],
    });

    // Create an instance with null type/id
    const comment = fds.getRepository(Comment).create();
    comment.id = 99;
    comment.body = 'no target';
    (comment as unknown as Record<string, unknown>).target_type = null;
    (comment as unknown as Record<string, unknown>).target_id = null;

    const result = await loadPolymorphic(comment, 'target');
    assert.equal(result, null);
  });

  it('resolves the right parent entity when type and id are set', async () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      title!: string;
    }

    @Entity('videos')
    class Video extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      url!: string;
    }

    @Entity('comments')
    class Comment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'text', nullable: false })
      body!: string;

      @PolymorphicRelation({
        targets: [Post, Video],
        relatedName: 'comments',
      })
      target!: unknown;
    }

    const fds = await FileDataSource.create({
      models: [
        { entity: Post, rows: [{ id: 1, title: 'hello' }] },
        { entity: Video, rows: [{ id: 1, url: 'http://x' }] },
        {
          entity: Comment,
          rows: [
            { id: 1, body: 'nice', target_type: 'posts', target_id: 1 },
            { id: 2, body: 'cool', target_type: 'videos', target_id: 1 },
          ],
        },
      ],
    });

    const comment1 = await fds.getRepository(Comment).findOneBy({ id: 1 });
    assert.ok(comment1);
    const parent1 = await loadPolymorphic<Post>(comment1, 'target');
    assert.ok(parent1);
    assert.equal((parent1 as unknown as Record<string, unknown>).title, 'hello');

    const comment2 = await fds.getRepository(Comment).findOneBy({ id: 2 });
    assert.ok(comment2);
    const parent2 = await loadPolymorphic<Video>(comment2, 'target');
    assert.ok(parent2);
    assert.equal((parent2 as unknown as Record<string, unknown>).url, 'http://x');
  });

  it('throws when no polymorphic descriptor is found', async () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      title!: string;
    }

    const fds = await FileDataSource.create({
      models: [{ entity: Post, rows: [{ id: 1, title: 'hello' }] }],
    });
    const post = await fds.getRepository(Post).findOneBy({ id: 1 });
    assert.ok(post);

    await assert.rejects(loadPolymorphic(post, 'notDecorated'), /no polymorphic descriptor/i);
  });
});

describe('loadPolymorphicInverse (parent -> children)', () => {
  afterEach(() => {
    clearPolymorphicRegistry();
  });

  it('returns child rows for a target instance', async () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      title!: string;
    }

    @Entity('comments')
    class Comment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'text', nullable: false })
      body!: string;

      @PolymorphicRelation({
        targets: [Post],
        relatedName: 'comments',
      })
      target!: unknown;
    }

    const fds = await FileDataSource.create({
      models: [
        { entity: Post, rows: [{ id: 1, title: 'hello' }] },
        {
          entity: Comment,
          rows: [
            { id: 1, body: 'nice', target_type: 'posts', target_id: 1 },
            { id: 2, body: 'cool', target_type: 'posts', target_id: 1 },
            { id: 3, body: 'ok', target_type: 'posts', target_id: 2 },
          ],
        },
      ],
    });

    const post1 = await fds.getRepository(Post).findOneBy({ id: 1 });
    assert.ok(post1);

    const children = await loadPolymorphicInverse<Comment>(post1, 'comments');
    assert.equal(children.length, 2);
    assert.equal((children[0] as unknown as Comment).body, 'nice');
    assert.equal((children[1] as unknown as Comment).body, 'cool');
  });

  it('returns empty array when no child rows match', async () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      title!: string;
    }

    @Entity('comments')
    class Comment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'text', nullable: false })
      body!: string;

      @PolymorphicRelation({
        targets: [Post],
        relatedName: 'comments',
      })
      target!: unknown;
    }

    const fds = await FileDataSource.create({
      models: [
        {
          entity: Post,
          rows: [
            { id: 1, title: 'hello' },
            { id: 2, title: 'no comments yet' },
          ],
        },
        {
          entity: Comment,
          rows: [{ id: 1, body: 'nice', target_type: 'posts', target_id: 1 }],
        },
      ],
    });

    const uncPost = await fds.getRepository(Post).findOneBy({ id: 2 });
    assert.ok(uncPost, 'post 2 should exist');
    const children = await loadPolymorphicInverse<Comment>(uncPost, 'comments');
    assert.equal(children.length, 0);
  });

  it('throws when no matching child entity is found', async () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      title!: string;
    }

    const fds = await FileDataSource.create({
      models: [{ entity: Post, rows: [{ id: 1, title: 'hello' }] }],
    });
    const post = await fds.getRepository(Post).findOneBy({ id: 1 });
    assert.ok(post);

    await assert.rejects(
      loadPolymorphicInverse(post, 'nonexistent'),
      /no polymorphic child entity found/i,
    );
  });
});

describe('alter_polymorphic operation', () => {
  function pk(name = 'id'): { name: string; type: 'integer'; nullable: false; primaryKey: true } {
    return { name, type: 'integer', nullable: false, primaryKey: true };
  }

  function int(
    name: string,
    nullable = false,
  ): { name: string; type: 'integer'; nullable: boolean } {
    return { name, type: 'integer', nullable };
  }

  function str(
    name: string,
    length = 100,
    nullable = false,
  ): { name: string; type: 'varchar'; length: number; nullable: boolean } {
    return { name, type: 'varchar', length, nullable };
  }

  const commentsTable: TableDefinition = {
    name: 'comments',
    columns: [pk(), str('body', 200), str('target_type', 190), int('target_id')],
    polymorphic: { typeColumn: 'target_type', idColumn: 'target_id', targets: ['posts'] },
  };

  const empty: SchemaState = { tables: [] };
  const state = (): SchemaState => ({ tables: [{ ...commentsTable }] });

  it('applyOperation sets the polymorphic descriptor', () => {
    const base: SchemaState = {
      tables: [{ name: 'comments', columns: commentsTable.columns }],
    };
    const op: Operation = {
      kind: 'alter_polymorphic',
      table: 'comments',
      polymorphic: { typeColumn: 'target_type', idColumn: 'target_id', targets: ['posts'] },
      previous: undefined,
    };
    const result = applyOperation(base, op);
    const table = result.tables.find((t) => t.name === 'comments');
    assert.ok(table);
    assert.deepEqual(table.polymorphic, {
      typeColumn: 'target_type',
      idColumn: 'target_id',
      targets: ['posts'],
    });
  });

  it('applyOperation removes the polymorphic descriptor when polymorphic is undefined', () => {
    const op: Operation = {
      kind: 'alter_polymorphic',
      table: 'comments',
      polymorphic: undefined,
      previous: { typeColumn: 'target_type', idColumn: 'target_id', targets: ['posts'] },
    };
    const result = applyOperation(state(), op);
    const table = result.tables.find((t) => t.name === 'comments');
    assert.ok(table);
    assert.equal(table.polymorphic, undefined);
  });

  it('applyOperation throws when table not found', () => {
    const op: Operation = {
      kind: 'alter_polymorphic',
      table: 'nonexistent',
      polymorphic: undefined,
      previous: undefined,
    };
    assert.throws(() => applyOperation(empty, op), /does not exist/);
  });

  it('applyOperation throws when previous does not match state', () => {
    const op: Operation = {
      kind: 'alter_polymorphic',
      table: 'comments',
      polymorphic: {
        typeColumn: 'target_type',
        idColumn: 'target_id',
        targets: ['posts', 'videos'],
      },
      previous: { typeColumn: 'wrong', idColumn: 'target_id', targets: ['posts'] },
    };
    assert.throws(() => applyOperation(state(), op), /does not match state/);
  });

  it('applyOperation throws when polymorphic columns do not exist in the table', () => {
    const base: SchemaState = {
      tables: [{ name: 'comments', columns: [pk(), str('body', 200)] }],
    };
    const op: Operation = {
      kind: 'alter_polymorphic',
      table: 'comments',
      polymorphic: { typeColumn: 'target_type', idColumn: 'target_id', targets: ['posts'] },
      previous: undefined,
    };
    assert.throws(() => applyOperation(base, op), /does not exist in the table/);
  });

  it('invertOperation swaps polymorphic and previous', () => {
    const op: Operation = {
      kind: 'alter_polymorphic',
      table: 'comments',
      polymorphic: { typeColumn: 'target_type', idColumn: 'target_id', targets: ['posts'] },
      previous: undefined,
    };
    const inverted = invertOperation(op);
    assert.equal(inverted.kind, 'alter_polymorphic');
    assert.equal(inverted.table, 'comments');
    assert.equal(inverted.polymorphic, undefined);
    assert.deepEqual(inverted.previous, {
      typeColumn: 'target_type',
      idColumn: 'target_id',
      targets: ['posts'],
    });
  });

  it('alter_polymorphic invert round-trips: apply then invert returns original state', () => {
    const base: SchemaState = {
      tables: [{ name: 'comments', columns: commentsTable.columns }],
    };
    const op: Operation = {
      kind: 'alter_polymorphic',
      table: 'comments',
      polymorphic: {
        typeColumn: 'target_type',
        idColumn: 'target_id',
        targets: ['posts', 'videos'],
      },
      previous: undefined,
    };
    const applied = applyOperation(base, op);
    const table = applied.tables.find((t) => t.name === 'comments');
    assert.ok(table);
    assert.ok(table.polymorphic);
    assert.deepEqual(table.polymorphic.targets, ['posts', 'videos']);

    const reversed = applyOperation(applied, invertOperation(op));
    const restored = reversed.tables.find((t) => t.name === 'comments');
    assert.ok(restored);
    assert.equal(restored.polymorphic, undefined);
  });

  it('validateOperation rejects malformed alter_polymorphic', () => {
    assert.throws(
      () =>
        validateOperation({
          kind: 'alter_polymorphic',
          table: 'tbl',
          polymorphic: { typeColumn: 't', idColumn: 'i', targets: [] },
          previous: undefined,
        }),
      MigrationError,
    );
  });
});

describe('autodetector: alter_polymorphic emission', () => {
  afterEach(() => {
    clearPolymorphicRegistry();
  });

  it('emits alter_polymorphic when the targets list changes', async () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      title!: string;
    }

    @Entity('videos')
    class Video extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      url!: string;
    }

    @Entity('comments')
    class Comment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'text', nullable: false })
      body!: string;

      @PolymorphicRelation({
        targets: [Post],
        relatedName: 'comments',
      })
      target!: unknown;
    }

    const initial = await buildSchema([Comment, Post, Video]);

    // Build the desired schema by adding Video to the polymorphic targets.
    // The table name, columns, indexes are identical — only the descriptor changes.
    const desired: SchemaState = {
      tables: initial.tables.map((t) => {
        if (t.name === 'comments') {
          return {
            ...t,
            polymorphic: {
              typeColumn: 'target_type',
              idColumn: 'target_id',
              targets: ['posts', 'videos'],
            },
          };
        }
        return t;
      }),
    };

    const createTables = generateMigration('create_tables', [], initial);
    assert.ok(createTables);
    const alterTargets = generateMigration('add_video_target', [createTables], desired);
    assert.ok(alterTargets);
    const kinds = alterTargets.operations.map((op) => op.kind);
    assert.ok(
      kinds.includes('alter_polymorphic'),
      'expected alter_polymorphic in ' + JSON.stringify(kinds),
    );

    // Replay reconstructs the descriptor.
    assert.deepEqual(replayMigrationHistory([createTables, alterTargets]), desired);
  });

  it('emits alter_polymorphic when polymorphic is removed', async () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity('comments')
    class Comment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @PolymorphicRelation({
        targets: [Post],
        relatedName: 'comments',
      })
      target!: unknown;
    }

    const initial = await buildSchema([Comment, Post]);

    // Remove the polymorphic descriptor from the comments table.
    const desired: SchemaState = {
      tables: initial.tables.map((t) => {
        if (t.name === 'comments') {
          const { polymorphic: _poly, ...rest } = t;
          return rest;
        }
        return t;
      }),
    };

    const createTables = generateMigration('create_tables', [], initial);
    assert.ok(createTables);
    const removePoly = generateMigration('remove_polymorphic', [createTables], desired);
    assert.ok(removePoly);
    const kinds = removePoly.operations.map((op) => op.kind);
    assert.ok(
      kinds.includes('alter_polymorphic'),
      'expected alter_polymorphic for removal in ' + JSON.stringify(kinds),
    );

    assert.deepEqual(replayMigrationHistory([createTables, removePoly]), desired);
  });

  it('create_table with polymorphic preserves the descriptor via stripForeignKeys', async () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity('comments')
    class Comment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @PolymorphicRelation({
        targets: [Post],
        relatedName: 'comments',
      })
      target!: unknown;
    }

    const desired = await buildSchema([Comment, Post]);
    const migration = generateMigration('create_comments', [], desired);
    assert.ok(migration);

    const createOp = migration.operations.find(
      (op) => op.kind === 'create_table' && op.table.name === 'comments',
    );
    assert.ok(createOp);
    if (createOp.kind === 'create_table') {
      // stripForeignKeys preserves the polymorphic descriptor on the create_table operation.
      assert.ok(createOp.table.polymorphic, 'polymorphic descriptor is preserved on create_table');
      assert.deepEqual(createOp.table.polymorphic?.targets, ['posts']);
    }

    assert.deepEqual(replayMigrationHistory([migration]), desired);
  });
});
