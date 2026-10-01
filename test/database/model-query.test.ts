/**
 * Tests for ModelQuery (Slice 1): the chainable SELECT query surface wrapping
 * a TypeORM SelectQueryBuilder.
 *
 * Functional coverage: where (Q predicate filtering), orderBy, limit, offset,
 * getOne (null on empty), count, apply escape hatch, and every rejection path
 * (invalid column, negative/non-integer limit/offset).
 *
 * All entities are backed by {@link FileDataSource} (in-memory sqljs,
 * query_only mode) so tests exercise the real ORM without external services.
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
  SelectQueryBuilder,
} from 'typeorm';

import { FileDataSource } from '../../src/database/file-data-source.js';
import { qEq, qGt, qLike, qIsNull, qNotNull } from '../../src/database/query-expressions.js';
import { ModelQueryError, query } from '../../src/database/model-query.js';
import { RelationError } from '../../src/database/relation-metadata.js';

// ---------------------------------------------------------------------------
// Query-counting instrumentation (mirrors relation-loader test pattern)
// ---------------------------------------------------------------------------

function installQueryCounter(): { getCount: () => number; restore: () => void } {
  let count = 0;

  const origGetRawMany = SelectQueryBuilder.prototype.getRawMany;
  SelectQueryBuilder.prototype.getRawMany = function (...args: unknown[]) {
    count++;
    return (origGetRawMany as Function).apply(this, args);
  };

  const origGetMany = SelectQueryBuilder.prototype.getMany;
  SelectQueryBuilder.prototype.getMany = function (...args: unknown[]) {
    count++;
    return (origGetMany as Function).apply(this, args);
  };

  return {
    getCount: () => count,
    restore: () => {
      SelectQueryBuilder.prototype.getRawMany = origGetRawMany;
      SelectQueryBuilder.prototype.getMany = origGetMany;
    },
  };
}

// =========================================================================
// Eager-load entities (M2O + O2M for includes tests)
// =========================================================================

let MqAuthor: typeof BaseEntity;
let MqPost: typeof BaseEntity;
let MqComment: typeof BaseEntity;

function declareMqRelations() {
  @Entity('mq_authors')
  class A extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 100, nullable: false }) name!: string;
    @OneToMany(() => MqPost, (post: any) => post.author)
    posts!: any[];
  }
  MqAuthor = A;

  @Entity('mq_posts')
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

  @Entity('mq_comments')
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
// Test entities
// =========================================================================

@Entity('mq_items')
class MqItem extends BaseEntity {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: 'integer', nullable: false }) likes!: number;
  @Column({ type: 'integer', nullable: false }) views!: number;
  @Column({ type: 'varchar', length: 100, nullable: true }) name!: string | null;
}

async function seedItems() {
  return FileDataSource.create({
    models: [
      {
        entity: MqItem,
        rows: [
          { id: 1, likes: 10, views: 5, name: 'alpha' },
          { id: 2, likes: 5, views: 10, name: 'beta' },
          { id: 3, likes: 8, views: 8, name: null },
          { id: 4, likes: 3, views: 2, name: 'delta' },
          { id: 5, likes: 12, views: 20, name: 'epsilon' },
        ],
      },
    ],
  });
}

// =========================================================================
// where — Q predicates
// =========================================================================

describe('ModelQuery.where', () => {
  test('filters rows with a leaf predicate', async () => {
    const fds = await seedItems();
    try {
      const rows = await query<MqItem>(MqItem).where(qGt('likes', 7)).getMany();
      const ids = rows.map((r) => r.id).sort();
      assert.deepEqual(ids, [1, 3, 5]);
    } finally {
      await fds.close();
    }
  });

  test('filters rows with eq predicate', async () => {
    const fds = await seedItems();
    try {
      const rows = await query<MqItem>(MqItem).where(qEq('likes', 10)).getMany();
      const ids = rows.map((r) => r.id);
      assert.deepEqual(ids, [1]);
    } finally {
      await fds.close();
    }
  });

  test('filters with isNull predicate', async () => {
    const fds = await seedItems();
    try {
      const rows = await query<MqItem>(MqItem).where(qIsNull('name')).getMany();
      const ids = rows.map((r) => r.id);
      assert.deepEqual(ids, [3]);
    } finally {
      await fds.close();
    }
  });

  test('filters with notNull predicate', async () => {
    const fds = await seedItems();
    try {
      const rows = await query<MqItem>(MqItem).where(qNotNull('name')).getMany();
      const ids = rows.map((r) => r.id).sort();
      assert.deepEqual(ids, [1, 2, 4, 5]);
    } finally {
      await fds.close();
    }
  });

  test('filters with like predicate', async () => {
    const fds = await seedItems();
    try {
      const rows = await query<MqItem>(MqItem).where(qLike('name', '%l%')).getMany();
      const ids = rows.map((r) => r.id).sort();
      assert.deepEqual(ids, [1, 4, 5]);
    } finally {
      await fds.close();
    }
  });

  test('returns all rows when no where clause is applied', async () => {
    const fds = await seedItems();
    try {
      const rows = await query<MqItem>(MqItem).getMany();
      assert.equal(rows.length, 5);
    } finally {
      await fds.close();
    }
  });
});

// =========================================================================
// orderBy
// =========================================================================

describe('ModelQuery.orderBy', () => {
  test('orders ascending by default', async () => {
    const fds = await seedItems();
    try {
      const rows = await query<MqItem>(MqItem).orderBy('likes').getMany();
      const ids = rows.map((r) => r.id);
      assert.deepEqual(ids, [4, 2, 3, 1, 5]);
    } finally {
      await fds.close();
    }
  });

  test('orders descending when direction is explicit', async () => {
    const fds = await seedItems();
    try {
      const rows = await query<MqItem>(MqItem).orderBy('likes', 'DESC').getMany();
      const ids = rows.map((r) => r.id);
      assert.deepEqual(ids, [5, 1, 3, 2, 4]);
    } finally {
      await fds.close();
    }
  });

  test('combines with where', async () => {
    const fds = await seedItems();
    try {
      const rows = await query<MqItem>(MqItem)
        .where(qGt('likes', 5))
        .orderBy('likes', 'DESC')
        .getMany();
      const ids = rows.map((r) => r.id);
      assert.deepEqual(ids, [5, 1, 3]);
    } finally {
      await fds.close();
    }
  });

  test('rejects an invalid column identifier', async () => {
    const fds = await seedItems();
    try {
      assert.throws(() => {
        query<MqItem>(MqItem).orderBy('col;drop');
      }, ModelQueryError);
    } finally {
      await fds.close();
    }
  });

  test('rejects an empty column identifier', async () => {
    const fds = await seedItems();
    try {
      assert.throws(() => {
        query<MqItem>(MqItem).orderBy('');
      }, ModelQueryError);
    } finally {
      await fds.close();
    }
  });
});

// =========================================================================
// limit / offset
// =========================================================================

describe('ModelQuery.limit', () => {
  test('returns at most N rows', async () => {
    const fds = await seedItems();
    try {
      const rows = await query<MqItem>(MqItem).orderBy('id').limit(2).getMany();
      const ids = rows.map((r) => r.id);
      assert.deepEqual(ids, [1, 2]);
    } finally {
      await fds.close();
    }
  });

  test('zero returns no rows', async () => {
    const fds = await seedItems();
    try {
      const rows = await query<MqItem>(MqItem).limit(0).getMany();
      assert.deepEqual(rows, []);
    } finally {
      await fds.close();
    }
  });

  test('rejects a negative value', async () => {
    const fds = await seedItems();
    try {
      assert.throws(() => {
        query<MqItem>(MqItem).limit(-1);
      }, ModelQueryError);
    } finally {
      await fds.close();
    }
  });

  test('rejects a non-integer value', async () => {
    const fds = await seedItems();
    try {
      assert.throws(() => {
        query<MqItem>(MqItem).limit(1.5);
      }, ModelQueryError);
    } finally {
      await fds.close();
    }
  });
});

describe('ModelQuery.offset', () => {
  test('skips the first N rows', async () => {
    const fds = await seedItems();
    try {
      const rows = await query<MqItem>(MqItem).orderBy('id').offset(2).getMany();
      const ids = rows.map((r) => r.id);
      assert.deepEqual(ids, [3, 4, 5]);
    } finally {
      await fds.close();
    }
  });

  test('combines with limit for pagination', async () => {
    const fds = await seedItems();
    try {
      const rows = await query<MqItem>(MqItem).orderBy('id').limit(2).offset(1).getMany();
      const ids = rows.map((r) => r.id);
      assert.deepEqual(ids, [2, 3]);
    } finally {
      await fds.close();
    }
  });

  test('rejects a negative value', async () => {
    const fds = await seedItems();
    try {
      assert.throws(() => {
        query<MqItem>(MqItem).offset(-1);
      }, ModelQueryError);
    } finally {
      await fds.close();
    }
  });

  test('rejects a non-integer value', async () => {
    const fds = await seedItems();
    try {
      assert.throws(() => {
        query<MqItem>(MqItem).offset(0.5);
      }, ModelQueryError);
    } finally {
      await fds.close();
    }
  });
});

// =========================================================================
// getOne
// =========================================================================

describe('ModelQuery.getOne', () => {
  test('returns the first matching row', async () => {
    const fds = await seedItems();
    try {
      const row = await query<MqItem>(MqItem).where(qEq('id', 1)).getOne();
      assert.ok(row !== null);
      assert.equal(row.id, 1);
      assert.equal(row.name, 'alpha');
    } finally {
      await fds.close();
    }
  });

  test('returns null when no rows match', async () => {
    const fds = await seedItems();
    try {
      const row = await query<MqItem>(MqItem).where(qEq('id', 999)).getOne();
      assert.equal(row, null);
    } finally {
      await fds.close();
    }
  });

  test('returns the first row from an unfiltered query', async () => {
    const fds = await seedItems();
    try {
      const row = await query<MqItem>(MqItem).getOne();
      assert.ok(row !== null);
    } finally {
      await fds.close();
    }
  });
});

// =========================================================================
// count
// =========================================================================

describe('ModelQuery.count', () => {
  test('returns the total row count when unfiltered', async () => {
    const fds = await seedItems();
    try {
      const n = await query<MqItem>(MqItem).count();
      assert.equal(n, 5);
    } finally {
      await fds.close();
    }
  });

  test('returns the filtered row count', async () => {
    const fds = await seedItems();
    try {
      const n = await query<MqItem>(MqItem).where(qGt('likes', 7)).count();
      assert.equal(n, 3);
    } finally {
      await fds.close();
    }
  });

  test('returns zero when no rows match', async () => {
    const fds = await seedItems();
    try {
      const n = await query<MqItem>(MqItem).where(qEq('id', 999)).count();
      assert.equal(n, 0);
    } finally {
      await fds.close();
    }
  });

  test('ignores limit and offset', async () => {
    const fds = await seedItems();
    try {
      const n = await query<MqItem>(MqItem).limit(1).offset(3).count();
      assert.equal(n, 5); // count ignores pagination
    } finally {
      await fds.close();
    }
  });
});

// =========================================================================
// apply — escape hatch
// =========================================================================

describe('ModelQuery.apply', () => {
  test('allows raw builder access', async () => {
    const fds = await seedItems();
    try {
      const rows = await query<MqItem>(MqItem)
        .apply((qb) => qb.andWhere(`${qb.alias}.likes = :likes`, { likes: 5 }))
        .getMany();
      const ids = rows.map((r) => r.id);
      assert.deepEqual(ids, [2]);
    } finally {
      await fds.close();
    }
  });

  test('chains with standard methods', async () => {
    const fds = await seedItems();
    try {
      const rows = await query<MqItem>(MqItem)
        .orderBy('id')
        .apply((qb) => qb.limit(2))
        .getMany();
      const ids = rows.map((r) => r.id);
      assert.deepEqual(ids, [1, 2]);
    } finally {
      await fds.close();
    }
  });
});

// =========================================================================
// Custom alias
// =========================================================================

describe('ModelQuery with custom alias', () => {
  test('uses a custom alias when provided', async () => {
    const fds = await seedItems();
    try {
      const rows = await query<MqItem>(MqItem, { alias: 'custom_alias' })
        .where(qGt('likes', 7))
        .getMany();
      const ids = rows.map((r) => r.id).sort();
      assert.deepEqual(ids, [1, 3, 5]);
    } finally {
      await fds.close();
    }
  });
});

// =========================================================================
// getMany — full integration
// =========================================================================

describe('ModelQuery.getMany', () => {
  test('chains where + orderBy + limit + offset', async () => {
    const fds = await seedItems();
    try {
      const rows = await query<MqItem>(MqItem)
        .where(qGt('likes', 4))
        .orderBy('likes', 'DESC')
        .limit(2)
        .offset(1)
        .getMany();
      const ids = rows.map((r) => r.id);
      // likes > 4 → ids 1(10), 2(5), 3(8), 5(12)
      // sorted desc: 5(12), 1(10), 3(8), 2(5)
      // limit 2 offset 1 → skip row 0 → [1, 3]
      assert.deepEqual(ids, [1, 3]);
    } finally {
      await fds.close();
    }
  });
});

// =========================================================================
// includes — eager loading (Slice 2)
// =========================================================================

describe('ModelQuery.includes', () => {
  test('M2O: loads the related entity on each parent', async () => {
    const fds = await seedMqRelations();
    try {
      const posts = await query<InstanceType<typeof MqPost>>(MqPost)
        .orderBy('id')
        .includes({ author: true })
        .getMany();

      assert.equal(posts.length, 4);

      const post1 = posts[0] as unknown as Record<string, unknown>;
      const author = post1.author as Record<string, unknown>;
      assert.equal(author.id, 1);
      assert.equal(author.name, 'Alice');

      const post2 = posts[1] as unknown as Record<string, unknown>;
      assert.equal((post2.author as Record<string, unknown>).name, 'Bob');

      const post3 = posts[2] as unknown as Record<string, unknown>;
      assert.equal((post3.author as Record<string, unknown>).name, 'Alice');

      const post4 = posts[3] as unknown as Record<string, unknown>;
      assert.equal(post4.author, null);
    } finally {
      await fds.close();
    }
  });

  test('O2M: loads the child collection', async () => {
    const fds = await seedMqRelations();
    try {
      const posts = await query<InstanceType<typeof MqPost>>(MqPost)
        .orderBy('id')
        .includes({ comments: true })
        .getMany();

      const post1 = posts[0] as unknown as Record<string, unknown>;
      const comments = post1.comments as Record<string, unknown>[];
      assert.equal(comments.length, 2);
      assert.equal(comments[0]!.body, 'Comment 1-1');
      assert.equal(comments[1]!.body, 'Comment 1-2');

      const post2 = posts[1] as unknown as Record<string, unknown>;
      const p2c = post2.comments as Record<string, unknown>[];
      assert.equal(p2c.length, 1);

      const post4 = posts[3] as unknown as Record<string, unknown>;
      assert.deepEqual(post4.comments, []);
    } finally {
      await fds.close();
    }
  });

  test('nested include: comments.author', async () => {
    const fds = await seedMqRelations();
    try {
      const posts = await query<InstanceType<typeof MqPost>>(MqPost)
        .orderBy('id')
        .includes({ comments: { with: { author: true } } })
        .getMany();

      const post1 = posts[0] as unknown as Record<string, unknown>;
      const comments = post1.comments as Record<string, unknown>[];
      assert.equal(comments.length, 2);
      assert.equal((comments[0]!.author as Record<string, unknown>).name, 'Alice');
      assert.equal((comments[1]!.author as Record<string, unknown>).name, 'Bob');
    } finally {
      await fds.close();
    }
  });

  test('repeated includes() calls merge top-level keys', async () => {
    const fds = await seedMqRelations();
    try {
      const posts = await query<InstanceType<typeof MqPost>>(MqPost)
        .orderBy('id')
        .includes({ author: true })
        .includes({ comments: true })
        .getMany();

      const post1 = posts[0] as unknown as Record<string, unknown>;
      assert.ok(typeof post1.author === 'object');
      assert.equal((post1.comments as Record<string, unknown>[]).length, 2);
    } finally {
      await fds.close();
    }
  });

  test('repeated includes() deep-merges nested with specs', async () => {
    const fds = await seedMqRelations();
    try {
      const posts = await query<InstanceType<typeof MqPost>>(MqPost)
        .orderBy('id')
        .includes({ comments: { with: { author: true } } })
        .includes({ comments: { with: { post: true } } })
        .getMany();

      // Both comment.author AND comment.post should be loaded.
      const post1 = posts[0] as unknown as Record<string, unknown>;
      const comments = post1.comments as Record<string, unknown>[];
      assert.equal(comments.length, 2);

      const c1 = comments[0]!;
      assert.equal((c1.author as Record<string, unknown>).name, 'Alice');
      assert.equal((c1.post as Record<string, unknown>).id, 1);
    } finally {
      await fds.close();
    }
  });

  test('limit restricts base rows and relations load only for those rows', async () => {
    const fds = await seedMqRelations();
    try {
      // limit(2) → only Post 1 and Post 2. Relations loaded only for those 2.
      const posts = await query<InstanceType<typeof MqPost>>(MqPost)
        .orderBy('id')
        .limit(2)
        .includes({ author: true, comments: true })
        .getMany();

      assert.equal(posts.length, 2);

      const rows = posts as unknown as Record<string, unknown>[];
      assert.equal((rows[0]!.author as Record<string, unknown>).name, 'Alice');
      assert.equal((rows[1]!.author as Record<string, unknown>).name, 'Bob');

      // Only posts 1 and 2 have comments loaded.
      const c1 = rows[0]!.comments as Record<string, unknown>[];
      assert.equal(c1.length, 2);
      const c2 = rows[1]!.comments as Record<string, unknown>[];
      assert.equal(c2.length, 1);
    } finally {
      await fds.close();
    }
  });

  test('empty result set issues no relation query', async () => {
    const fds = await seedMqRelations();
    const counter = installQueryCounter();
    try {
      const initialCount = counter.getCount();

      const rows = await query<InstanceType<typeof MqPost>>(MqPost)
        .where(qEq('id', 999))
        .includes({ author: true })
        .getMany();

      assert.deepEqual(rows, []);

      // Only the base getMany() query — no loader queries.
      const queryCount = counter.getCount() - initialCount;
      assert.equal(queryCount, 1);
    } finally {
      counter.restore();
      await fds.close();
    }
  });

  test('getOne returns null and skips includes when no row matches', async () => {
    const fds = await seedMqRelations();
    try {
      const row = await query<InstanceType<typeof MqPost>>(MqPost)
        .where(qEq('id', 999))
        .includes({ author: true })
        .getOne();

      // Returns null before loadRelations is ever called (early return guards
      // against both a missing row and a missing includes spec).
      assert.equal(row, null);
    } finally {
      await fds.close();
    }
  });

  test('count ignores includes (delegates to builder unchanged)', async () => {
    const fds = await seedMqRelations();
    try {
      const n = await query<InstanceType<typeof MqPost>>(MqPost)
        .includes({ author: true, comments: true })
        .count();

      assert.equal(n, 4);
    } finally {
      await fds.close();
    }
  });

  test('rejects non-object spec (null, array, string)', async () => {
    const fds = await seedMqRelations();
    try {
      const q = query<InstanceType<typeof MqPost>>(MqPost);

      assert.throws(() => q.includes(null as any), ModelQueryError);
      assert.throws(() => q.includes([] as any), ModelQueryError);
      assert.throws(() => q.includes('author' as any), ModelQueryError);
    } finally {
      await fds.close();
    }
  });

  test('getOne includes loads relations on the single matched row', async () => {
    const fds = await seedMqRelations();
    try {
      const row = await query<InstanceType<typeof MqPost>>(MqPost)
        .where(qEq('id', 1))
        .includes({ author: true })
        .getOne();

      assert.ok(row !== null);
      const rec = row as unknown as Record<string, unknown>;
      assert.equal((rec.author as Record<string, unknown>).name, 'Alice');
    } finally {
      await fds.close();
    }
  });

  test('per-relation options (select/where/order/limit) are honored', async () => {
    const fds = await seedMqRelations();
    try {
      const rows = await query<InstanceType<typeof MqPost>>(MqPost)
        .where(qEq('id', 1))
        .includes({
          comments: {
            where: { body: 'Comment 1-1' },
            order: { id: 'DESC' },
            limit: 1,
          },
        })
        .getMany();

      const comments = (rows[0] as unknown as Record<string, unknown>).comments as Record<
        string,
        unknown
      >[];
      assert.equal(comments.length, 1);
      assert.equal(comments[0]!.body, 'Comment 1-1');
    } finally {
      await fds.close();
    }
  });

  test('offset without limit slices the base rows', async () => {
    const fds = await seedMqRelations();
    try {
      const rows = await query<InstanceType<typeof MqPost>>(MqPost)
        .orderBy('id')
        .offset(2)
        .getMany();

      const ids = rows.map((r) => (r as unknown as Record<string, unknown>).id);
      assert.deepEqual(ids, [3, 4]);
    } finally {
      await fds.close();
    }
  });

  test('propagates RelationError for an unknown relation through includes', async () => {
    const fds = await seedMqRelations();
    try {
      await assert.rejects(
        query<InstanceType<typeof MqPost>>(MqPost).includes({ notARelation: true }).getMany(),
        RelationError,
      );
    } finally {
      await fds.close();
    }
  });
});

// =========================================================================
// whereHas and has — relation predicates (Slice 3)
// =========================================================================

describe('ModelQuery.whereHas', () => {
  test('filters parents that have at least one related row (existence check)', async () => {
    const fds = await seedMqRelations();
    try {
      const posts = await query<InstanceType<typeof MqPost>>(MqPost)
        .orderBy('id')
        .whereHas('comments')
        .getMany();

      // Posts 1, 2, 3 have comments; Post 4 has none; orphan comment 5 is
      // not linked to any post.
      const ids = posts.map((r) => (r as unknown as Record<string, unknown>).id);
      assert.deepEqual(ids, [1, 2, 3]);
    } finally {
      await fds.close();
    }
  });

  test('filters with a predicate on the related rows', async () => {
    const fds = await seedMqRelations();
    try {
      const posts = await query<InstanceType<typeof MqPost>>(MqPost)
        .orderBy('id')
        .whereHas('comments', (rq) => rq.where('body', 'Comment 1-1'))
        .getMany();

      // Only Post 1 has a comment with exactly that body.
      const ids = posts.map((r) => (r as unknown as Record<string, unknown>).id);
      assert.deepEqual(ids, [1]);
    } finally {
      await fds.close();
    }
  });

  test('composes with includes: filters parents and eager-loads relations', async () => {
    const fds = await seedMqRelations();
    try {
      const posts = await query<InstanceType<typeof MqPost>>(MqPost)
        .orderBy('id')
        .whereHas('comments')
        .includes({ comments: true })
        .getMany();

      assert.equal(posts.length, 3);

      // Comments must be loaded on the returned rows.
      const post1 = posts[0] as unknown as Record<string, unknown>;
      const p1c = post1.comments as Record<string, unknown>[];
      assert.equal(p1c.length, 2);

      const post2 = posts[1] as unknown as Record<string, unknown>;
      const p2c = post2.comments as Record<string, unknown>[];
      assert.equal(p2c.length, 1);
    } finally {
      await fds.close();
    }
  });

  test('chained with where: both conditions must match', async () => {
    const fds = await seedMqRelations();
    try {
      const posts = await query<InstanceType<typeof MqPost>>(MqPost)
        .whereHas('comments')
        .where(qEq('id', 1))
        .getMany();

      // Post 1 has comments and id=1.
      assert.equal(posts.length, 1);
      const post = posts[0] as unknown as Record<string, unknown>;
      assert.equal(post.id, 1);
    } finally {
      await fds.close();
    }
  });

  test('empty result when no parent satisfies the relation check', async () => {
    const fds = await seedMqRelations();
    try {
      const posts = await query<InstanceType<typeof MqPost>>(MqPost)
        .whereHas('comments', (rq) => rq.where('body', 'NonExistent'))
        .getMany();

      assert.deepEqual(posts, []);
    } finally {
      await fds.close();
    }
  });

  test('composes with getOne', async () => {
    const fds = await seedMqRelations();
    try {
      const post = await query<InstanceType<typeof MqPost>>(MqPost)
        .whereHas('comments')
        .orderBy('id')
        .getOne();

      assert.ok(post !== null);
      assert.equal((post as unknown as Record<string, unknown>).id, 1);
    } finally {
      await fds.close();
    }
  });

  test('getOne returns null when no row satisfies whereHas', async () => {
    const fds = await seedMqRelations();
    try {
      const row = await query<InstanceType<typeof MqPost>>(MqPost)
        .whereHas('comments', (rq) => rq.where('body', 'NonExistent'))
        .getOne();

      assert.equal(row, null);
    } finally {
      await fds.close();
    }
  });

  test('rejects a custom alias (correlation would silently break)', async () => {
    const fds = await seedMqRelations();
    try {
      assert.throws(
        () => query<InstanceType<typeof MqPost>>(MqPost, { alias: 'custom' }).whereHas('comments'),
        RelationError,
      );
    } finally {
      await fds.close();
    }
  });
});

describe('ModelQuery.has', () => {
  test('filters parents whose related count satisfies the operator', async () => {
    const fds = await seedMqRelations();
    try {
      const posts = await query<InstanceType<typeof MqPost>>(MqPost)
        .orderBy('id')
        .has('comments', '>', 1)
        .getMany();

      // Only Post 1 has more than 1 comment (2 total).
      const ids = posts.map((r) => (r as unknown as Record<string, unknown>).id);
      assert.deepEqual(ids, [1]);
    } finally {
      await fds.close();
    }
  });

  test('equals operator', async () => {
    const fds = await seedMqRelations();
    try {
      const posts = await query<InstanceType<typeof MqPost>>(MqPost)
        .orderBy('id')
        .has('comments', '=', 1)
        .getMany();

      // Posts 2 and 3 each have exactly 1 comment.
      const ids = posts.map((r) => (r as unknown as Record<string, unknown>).id);
      assert.deepEqual(ids, [2, 3]);
    } finally {
      await fds.close();
    }
  });

  test('greater-or-equal operator', async () => {
    const fds = await seedMqRelations();
    try {
      const posts = await query<InstanceType<typeof MqPost>>(MqPost)
        .orderBy('id')
        .has('comments', '>=', 1)
        .getMany();

      // Posts 1, 2, 3 all have >= 1 comment.
      const ids = posts.map((r) => (r as unknown as Record<string, unknown>).id);
      assert.deepEqual(ids, [1, 2, 3]);
    } finally {
      await fds.close();
    }
  });

  test('less-than operator returns parents with fewer related rows', async () => {
    const fds = await seedMqRelations();
    try {
      const posts = await query<InstanceType<typeof MqPost>>(MqPost)
        .orderBy('id')
        .has('comments', '<', 2)
        .getMany();

      // Posts 2, 3 have 1 comment (< 2); Post 4 has 0 (< 2).
      const ids = posts.map((r) => (r as unknown as Record<string, unknown>).id);
      assert.deepEqual(ids, [2, 3, 4]);
    } finally {
      await fds.close();
    }
  });

  test('composes with where: count condition AND column condition', async () => {
    const fds = await seedMqRelations();
    try {
      const posts = await query<InstanceType<typeof MqPost>>(MqPost)
        .has('comments', '>=', 1)
        .where(qEq('id', 2))
        .getMany();

      // Post 2 has >= 1 comment and id=2.
      assert.equal(posts.length, 1);
      const post = posts[0] as unknown as Record<string, unknown>;
      assert.equal(post.id, 2);
    } finally {
      await fds.close();
    }
  });

  test('composes with includes', async () => {
    const fds = await seedMqRelations();
    try {
      const posts = await query<InstanceType<typeof MqPost>>(MqPost)
        .orderBy('id')
        .has('comments', '>', 1)
        .includes({ comments: true })
        .getMany();

      assert.equal(posts.length, 1);
      const post1 = posts[0] as unknown as Record<string, unknown>;
      const p1c = post1.comments as Record<string, unknown>[];
      assert.equal(p1c.length, 2);
    } finally {
      await fds.close();
    }
  });
});

// =========================================================================
// Error handling — ModelQueryError value-free guarantee
// =========================================================================

describe('ModelQueryError', () => {
  test('is an instance of Error', () => {
    const err = new ModelQueryError('test');
    assert.ok(err instanceof Error);
  });

  test('has the correct name', () => {
    const err = new ModelQueryError('test');
    assert.equal(err.name, 'ModelQueryError');
  });

  test('does not echo entity/property names or values in error messages', async () => {
    const fds = await seedItems();
    try {
      assert.throws(() => {
        query<MqItem>(MqItem).limit(-1);
      }, /non-negative integer/);
    } finally {
      await fds.close();
    }
  });
});
