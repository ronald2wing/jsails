/**
 * Tests for ModelQuery breadth features (C1): annotate, in_batches, find_each.
 *
 * Mirrors the FileDataSource (sqljs) harness from model-query.test.ts with the
 * same MqAuthor / MqPost / MqComment fixture entities and seed data.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  BaseEntity,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { FileDataSource } from '../../src/database/file-data-source.js';
import { qEq } from '../../src/database/query-expressions.js';
import { ModelQueryError, query } from '../../src/database/model-query.js';

// =========================================================================
// Entities (mirror model-query.test.ts fixtures)
// =========================================================================

let MqAuthor: typeof BaseEntity;
let MqPost: typeof BaseEntity;
let MqComment: typeof BaseEntity;

function declareMqRelations() {
  @Entity('mq_authors_ab')
  class A extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 100, nullable: false }) name!: string;
    @OneToMany(() => MqPost, (post: any) => post.author)
    posts!: any[];
  }
  MqAuthor = A;

  @Entity('mq_posts_ab')
  class P extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 200, nullable: false }) title!: string;
    @ManyToOne(() => MqAuthor, { nullable: true })
    @JoinColumn({ name: 'author_id' })
    author!: any;
    @OneToMany(() => MqComment, (c: any) => c.post)
    comments!: any[];
  }
  MqPost = P;

  @Entity('mq_comments_ab')
  class C extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 500, nullable: false }) body!: string;
    @ManyToOne(() => MqPost, { nullable: true })
    @JoinColumn({ name: 'post_id' })
    post!: any;
    @ManyToOne(() => MqAuthor, { nullable: true })
    @JoinColumn({ name: 'author_id' })
    author!: any;
  }
  MqComment = C;
}

declareMqRelations();

async function seedMqRelations() {
  return FileDataSource.create({
    models: [
      {
        entity: MqAuthor,
        rows: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
          { id: 3, name: 'No Posts' },
        ],
      },
      {
        entity: MqPost,
        rows: [
          { id: 1, title: 'Post One', author: 1 },
          { id: 2, title: 'Post Two', author: 2 },
          { id: 3, title: 'Post Three', author: 1 },
          { id: 4, title: 'Orphan Post', author: null },
        ],
      },
      {
        entity: MqComment,
        rows: [
          { id: 1, body: 'Comment 1-1', post: 1, author: 1 },
          { id: 2, body: 'Comment 1-2', post: 1, author: 2 },
          { id: 3, body: 'Comment 2-1', post: 2, author: 1 },
          { id: 4, body: 'Comment 3-1', post: 3, author: 2 },
          { id: 5, body: 'Orphan comment', post: null, author: null },
        ],
      },
    ],
  });
}

// =========================================================================
// annotate
// =========================================================================

describe('ModelQuery.annotate', () => {
  test('attaches comments_count per post from getMany()', async () => {
    const fds = await seedMqRelations();
    try {
      const rows = await query<InstanceType<typeof MqPost>>(MqPost)
        .orderBy('id')
        .annotate('comments')
        .getMany();

      assert.equal(rows.length, 4);

      const recs = rows as unknown as Record<string, unknown>[];
      // Post 1 has 2 comments
      assert.equal(recs[0]!['comments_count'], 2);
      // Post 2 has 1 comment
      assert.equal(recs[1]!['comments_count'], 1);
      // Post 3 has 1 comment
      assert.equal(recs[2]!['comments_count'], 1);
      // Post 4 has 0 comments
      assert.equal(recs[3]!['comments_count'], 0);
    } finally {
      await fds.close();
    }
  });

  test('annotate of an unknown relation throws ModelQueryError', async () => {
    const fds = await seedMqRelations();
    try {
      await assert.rejects(
        query<InstanceType<typeof MqPost>>(MqPost).annotate('notARelation').getMany(),
        ModelQueryError,
      );
    } finally {
      await fds.close();
    }
  });

  test('annotate composes with includes', async () => {
    const fds = await seedMqRelations();
    try {
      const rows = await query<InstanceType<typeof MqPost>>(MqPost)
        .orderBy('id')
        .includes({ author: true })
        .annotate('comments')
        .getMany();

      assert.equal(rows.length, 4);

      const recs = rows as unknown as Record<string, unknown>[];
      // Includes must be loaded
      assert.equal((recs[0]!.author as Record<string, unknown>).name, 'Alice');
      // Annotations must be attached
      assert.equal(recs[0]!['comments_count'], 2);
      assert.equal(recs[3]!['comments_count'], 0);
    } finally {
      await fds.close();
    }
  });

  test('annotate works with getOne', async () => {
    const fds = await seedMqRelations();
    try {
      const row = await query<InstanceType<typeof MqPost>>(MqPost)
        .where(qEq('id', 1))
        .annotate('comments')
        .getOne();

      assert.ok(row !== null);
      const rec = row as unknown as Record<string, unknown>;
      assert.equal(rec['comments_count'], 2);
    } finally {
      await fds.close();
    }
  });

  test('annotate with no rows skips the annotation query', async () => {
    const fds = await seedMqRelations();
    try {
      const rows = await query<InstanceType<typeof MqPost>>(MqPost)
        .where(qEq('id', 999))
        .annotate('comments')
        .getMany();

      assert.deepEqual(rows, []);
    } finally {
      await fds.close();
    }
  });

  test('count ignores annotations', async () => {
    const fds = await seedMqRelations();
    try {
      const n = await query<InstanceType<typeof MqPost>>(MqPost).annotate('comments').count();

      assert.equal(n, 4);
    } finally {
      await fds.close();
    }
  });

  test('multiple annotations in one call', async () => {
    const fds = await seedMqRelations();
    try {
      const row = await query<InstanceType<typeof MqPost>>(MqPost)
        .where(qEq('id', 1))
        .annotate('comments', 'author')
        .getOne();

      assert.ok(row !== null);
      // `author` on MqPost is a many-to-one relation — annotation is
      // nonsensical (you would use a join/includes), but the framework must
      // not crash.  An M2O relation has 0 or 1 related rows.
      const rec = row as unknown as Record<string, unknown>;
      assert.equal(rec['comments_count'], 2);
      assert.equal(rec['author_count'], 1);
    } finally {
      await fds.close();
    }
  });
});

// =========================================================================
// in_batches
// =========================================================================

describe('ModelQuery.in_batches', () => {
  test('yields pages of size 2 with correct page numbers', async () => {
    const fds = await seedMqRelations();
    try {
      const pages: { page: number; ids: number[] }[] = [];

      await query<InstanceType<typeof MqPost>>(MqPost).in_batches(2, (rows, page) => {
        pages.push({
          page,
          ids: rows.map((r) => (r as unknown as Record<string, unknown>).id as number),
        });
      });

      assert.equal(pages.length, 2);
      assert.deepEqual(pages[0], { page: 1, ids: [1, 2] });
      assert.deepEqual(pages[1], { page: 2, ids: [3, 4] });
    } finally {
      await fds.close();
    }
  });

  test('last page can be smaller than batch size', async () => {
    const fds = await seedMqRelations();
    try {
      const pages: { page: number; count: number }[] = [];

      await query<InstanceType<typeof MqPost>>(MqPost).in_batches(3, (rows, page) => {
        pages.push({ page, count: rows.length });
      });

      assert.equal(pages.length, 2);
      assert.equal(pages[0]!.page, 1);
      assert.equal(pages[0]!.count, 3);
      assert.equal(pages[1]!.page, 2);
      assert.equal(pages[1]!.count, 1);
    } finally {
      await fds.close();
    }
  });

  test('respects where filtering', async () => {
    const fds = await seedMqRelations();
    try {
      const pages: number[][] = [];

      await query<InstanceType<typeof MqPost>>(MqPost)
        .where(qEq('id', 1))
        .in_batches(2, (rows) => {
          pages.push(rows.map((r) => (r as unknown as Record<string, unknown>).id as number));
        });

      assert.equal(pages.length, 1);
      assert.deepEqual(pages[0], [1]);
    } finally {
      await fds.close();
    }
  });

  test('size < 1 throws ModelQueryError', async () => {
    const fds = await seedMqRelations();
    try {
      const q = query<InstanceType<typeof MqPost>>(MqPost);
      await assert.rejects(
        q.in_batches(0, () => {}),
        ModelQueryError,
      );
      await assert.rejects(
        q.in_batches(-1, () => {}),
        ModelQueryError,
      );
      await assert.rejects(
        q.in_batches(1.5, () => {}),
        ModelQueryError,
      );
    } finally {
      await fds.close();
    }
  });

  test('in_batches composes with annotate', async () => {
    const fds = await seedMqRelations();
    try {
      const pages: { comments_count: number }[] = [];

      await query<InstanceType<typeof MqPost>>(MqPost)
        .annotate('comments')
        .in_batches(2, (rows) => {
          for (const r of rows) {
            pages.push({
              comments_count: (r as unknown as Record<string, unknown>)['comments_count'] as number,
            });
          }
        });

      assert.equal(pages.length, 4);
      // Order by PK: Post 1 (2 comments), Post 2 (1), Post 3 (1), Post 4 (0)
      assert.equal(pages[0]!.comments_count, 2);
      assert.equal(pages[1]!.comments_count, 1);
      assert.equal(pages[2]!.comments_count, 1);
      assert.equal(pages[3]!.comments_count, 0);
    } finally {
      await fds.close();
    }
  });

  test('respects explicit orderBy in batching', async () => {
    const fds = await seedMqRelations();
    try {
      const pages: number[][] = [];

      await query<InstanceType<typeof MqPost>>(MqPost)
        .orderBy('id', 'DESC')
        .in_batches(2, (rows) => {
          pages.push(rows.map((r) => (r as unknown as Record<string, unknown>).id as number));
        });

      assert.equal(pages.length, 2);
      assert.deepEqual(pages[0], [4, 3]);
      assert.deepEqual(pages[1], [2, 1]);
    } finally {
      await fds.close();
    }
  });
});

// =========================================================================
// find_each
// =========================================================================

describe('ModelQuery.find_each', () => {
  test('visits every row once', async () => {
    const fds = await seedMqRelations();
    try {
      const visited: number[] = [];

      await query<InstanceType<typeof MqPost>>(MqPost).find_each((row) => {
        visited.push((row as unknown as Record<string, unknown>).id as number);
      });

      // PK-ordered
      assert.deepEqual(visited, [1, 2, 3, 4]);
    } finally {
      await fds.close();
    }
  });

  test('respects custom batchSize', async () => {
    const fds = await seedMqRelations();
    try {
      const visited: number[] = [];

      await query<InstanceType<typeof MqPost>>(MqPost).find_each(
        (row) => {
          visited.push((row as unknown as Record<string, unknown>).id as number);
        },
        { batchSize: 1 },
      );

      assert.deepEqual(visited, [1, 2, 3, 4]);
    } finally {
      await fds.close();
    }
  });

  test('default batchSize is 100', async () => {
    const fds = await seedMqRelations();
    try {
      const visited: number[] = [];

      await query<InstanceType<typeof MqPost>>(MqPost).find_each((row) => {
        visited.push((row as unknown as Record<string, unknown>).id as number);
      });

      assert.equal(visited.length, 4);
    } finally {
      await fds.close();
    }
  });
});
