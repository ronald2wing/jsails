/**
 * Integration test for the JSails relation API: batch loading, predicates, and
 * aggregates exercised together on a single realistic entity graph.
 *
 * Entity graph:
 *   Author (1) <--- M2O --- Post (N) --- O2M ---> Comment
 *   Author (1) <--- O2O --- Profile
 *   Post   (N) <--- M2M --- Tag (N)   (via junction table post_tags)
 *   Image (child) --- polymorphic ---> Post | Author (inverse: Post.images, Author.images)
 *
 * Covers: M2O/O2M/O2O/M2M/polymorphic loading, nested paths (post.author.profile),
 * whereHas/has/exists, relationCount/relationAggregate, and query-count assertions.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  BaseEntity,
  Column,
  DataSource,
  Entity,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  SelectQueryBuilder,
} from 'typeorm';

import { PolymorphicRelation, clearPolymorphicRegistry } from '../../src/database/polymorphic.js';
import {
  loadRelation,
  loadRelations,
  type LoadRelationsOptions,
} from '../../src/database/relation-loader/index.js';
import { RelationError } from '../../src/database/relation-metadata.js';
import {
  whereHas,
  has,
  exists,
  relationCount,
  relationAggregate,
} from '../../src/database/relation-query.js';

// ---------------------------------------------------------------------------
// Query counting
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

// ---------------------------------------------------------------------------
// Entities — declared once, re-assigned in beforeEach
// ---------------------------------------------------------------------------

let Author: typeof BaseEntity;
let Profile: typeof BaseEntity;
let Post: typeof BaseEntity;
let Comment: typeof BaseEntity;
let Tag: typeof BaseEntity;
let Image: typeof BaseEntity;

function declareEntities() {
  @Entity('rqi_authors')
  class _Author extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 100, nullable: false }) name!: string;
    @OneToMany(() => Post, (p: any) => p.author)
    posts!: any[];
    @OneToOne(() => Profile, (p: any) => p.author)
    profile!: any;
  }
  Author = _Author;

  @Entity('rqi_profiles')
  class _Profile extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'text', nullable: false }) bio!: string;
    @OneToOne(() => Author, { nullable: false, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'author_id' })
    author!: any;
  }
  Profile = _Profile;

  @Entity('rqi_posts')
  class _Post extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 200, nullable: false }) title!: string;
    @Column({ type: 'integer', nullable: false, default: 0 }) likes!: number;
    @ManyToOne(() => Author, { nullable: false })
    @JoinColumn({ name: 'author_id' })
    author!: any;
    @OneToMany(() => Comment, (c: any) => c.post)
    comments!: any[];
    @ManyToMany(() => Tag)
    @JoinTable({
      name: 'rqi_post_tags',
      joinColumn: { name: 'post_id' },
      inverseJoinColumn: { name: 'tag_id' },
    })
    tags!: any[];
  }
  Post = _Post;

  @Entity('rqi_comments')
  class _Comment extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'text', nullable: false }) body!: string;
    @ManyToOne(() => Post, { nullable: false })
    @JoinColumn({ name: 'post_id' })
    post!: any;
  }
  Comment = _Comment;

  @Entity('rqi_tags')
  class _Tag extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 80, nullable: false }) name!: string;
  }
  Tag = _Tag;

  @Entity('rqi_images')
  class _Image extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 255, nullable: false }) url!: string;
    @PolymorphicRelation({ targets: [Post, Author], relatedName: 'images' })
    imageable!: any;
  }
  Image = _Image;
}

// ---------------------------------------------------------------------------
// DataSource lifecycle
// ---------------------------------------------------------------------------

let ds: DataSource;

async function seed(): Promise<void> {
  ds = new DataSource({
    type: 'sqljs',
    entities: [Author, Profile, Post, Comment, Tag, Image],
    synchronize: true,
    logNotifications: false,
    logging: false,
  } as any);
  await ds.initialize();

  // Seed via raw SQL so FK columns are populated directly. TypeORM's `save`
  // method maps relation objects but the column-level FK values may be NULL
  // when the owning entities aren't tracked in the same unit of work.
  await ds.query('INSERT INTO "rqi_authors" ("id", "name") VALUES (?, ?)', [1, 'Alice']);
  await ds.query('INSERT INTO "rqi_authors" ("id", "name") VALUES (?, ?)', [2, 'Bob']);

  await ds.query('INSERT INTO "rqi_profiles" ("id", "bio", "author_id") VALUES (?, ?, ?)', [
    10,
    'Author of two posts',
    1,
  ]);
  await ds.query('INSERT INTO "rqi_profiles" ("id", "bio", "author_id") VALUES (?, ?, ?)', [
    20,
    'Wrote one post',
    2,
  ]);

  await ds.query(
    'INSERT INTO "rqi_posts" ("id", "title", "likes", "author_id") VALUES (?, ?, ?, ?)',
    [1, 'Post One', 5, 1],
  );
  await ds.query(
    'INSERT INTO "rqi_posts" ("id", "title", "likes", "author_id") VALUES (?, ?, ?, ?)',
    [2, 'Post Two', 12, 1],
  );
  await ds.query(
    'INSERT INTO "rqi_posts" ("id", "title", "likes", "author_id") VALUES (?, ?, ?, ?)',
    [3, 'Post Three', 3, 2],
  );

  await ds.query('INSERT INTO "rqi_comments" ("id", "body", "post_id") VALUES (?, ?, ?)', [
    1,
    'Nice!',
    1,
  ]);
  await ds.query('INSERT INTO "rqi_comments" ("id", "body", "post_id") VALUES (?, ?, ?)', [
    2,
    'Agreed',
    1,
  ]);
  await ds.query('INSERT INTO "rqi_comments" ("id", "body", "post_id") VALUES (?, ?, ?)', [
    3,
    'Disagree',
    2,
  ]);
  await ds.query('INSERT INTO "rqi_comments" ("id", "body", "post_id") VALUES (?, ?, ?)', [
    4,
    'Cool',
    3,
  ]);

  await ds.query('INSERT INTO "rqi_tags" ("id", "name") VALUES (?, ?)', [1, 'JavaScript']);
  await ds.query('INSERT INTO "rqi_tags" ("id", "name") VALUES (?, ?)', [2, 'TypeScript']);
  await ds.query('INSERT INTO "rqi_tags" ("id", "name") VALUES (?, ?)', [3, 'CSS']);

  await ds.query('INSERT INTO "rqi_post_tags" ("post_id", "tag_id") VALUES (?, ?)', [1, 1]);
  await ds.query('INSERT INTO "rqi_post_tags" ("post_id", "tag_id") VALUES (?, ?)', [1, 2]);
  await ds.query('INSERT INTO "rqi_post_tags" ("post_id", "tag_id") VALUES (?, ?)', [2, 1]);
  await ds.query('INSERT INTO "rqi_post_tags" ("post_id", "tag_id") VALUES (?, ?)', [3, 3]);

  // Polymorphic images: seed via raw SQL so the discriminator columns
  // (imageable_type, imageable_id) are populated directly.
  await ds.query(
    'INSERT INTO "rqi_images" ("id", "url", "imageable_type", "imageable_id") VALUES (?, ?, ?, ?)',
    [101, '/img/a.png', 'rqi_posts', 1],
  );
  await ds.query(
    'INSERT INTO "rqi_images" ("id", "url", "imageable_type", "imageable_id") VALUES (?, ?, ?, ?)',
    [102, '/img/b.png', 'rqi_posts', 1],
  );
  await ds.query(
    'INSERT INTO "rqi_images" ("id", "url", "imageable_type", "imageable_id") VALUES (?, ?, ?, ?)',
    [103, '/img/c.png', 'rqi_posts', 2],
  );
  await ds.query(
    'INSERT INTO "rqi_images" ("id", "url", "imageable_type", "imageable_id") VALUES (?, ?, ?, ?)',
    [104, '/img/d.png', 'rqi_authors', 1],
  );
}

async function teardown(): Promise<void> {
  if (ds && ds.isInitialized) {
    await ds.destroy();
  }
}

beforeEach(async () => {
  declareEntities();
  await seed();
});

afterEach(async () => {
  clearPolymorphicRegistry();
  await teardown();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('relation-integration', () => {
  // =======================================================================
  // Batch loading
  // =======================================================================

  it('loads M2O + O2O nested + M2M + polymorphic inverse in one call', async () => {
    const counter = installQueryCounter();
    const beforeCount = counter.getCount();

    const posts = (await Post.find({ order: { id: 'ASC' } as any })) as any[];

    const options: LoadRelationsOptions = {
      with: {
        author: {
          with: { profile: true },
        },
        tags: true,
        images: true,
      },
    };

    await loadRelations(posts, options);
    const queryCount = counter.getCount() - beforeCount;
    counter.restore();

    // Post 1: Alice, [JavaScript, TypeScript], 2 images
    assert.equal(posts[0].author.name, 'Alice');
    assert.equal(posts[0].author.profile.bio, 'Author of two posts');
    assert.deepEqual(posts[0].tags.map((t: any) => t.name).sort(), ['JavaScript', 'TypeScript']);
    assert.equal(posts[0].images.length, 2);
    assert.deepEqual(posts[0].images.map((i: any) => i.url).sort(), ['/img/a.png', '/img/b.png']);

    // Post 2: Alice, [JavaScript], 1 image
    assert.equal(posts[1].author.name, 'Alice');
    assert.equal(posts[1].author.profile.bio, 'Author of two posts');
    assert.deepEqual(posts[1].tags.map((t: any) => t.name).sort(), ['JavaScript']);
    assert.equal(posts[1].images.length, 1);
    assert.equal(posts[1].images[0].url, '/img/c.png');

    // Post 3: Bob, [CSS], no images
    assert.equal(posts[2].author.name, 'Bob');
    assert.equal(posts[2].author.profile.bio, 'Wrote one post');
    assert.deepEqual(posts[2].tags.map((t: any) => t.name).sort(), ['CSS']);
    assert.equal(posts[2].images.length, 0);

    // Query-count check: constant regardless of parent count.
    assert.equal(queryCount, 8);
  });

  it('single-parent loadRelation works', async () => {
    const post = (await Post.findOneBy({ id: 1 } as any)) as any;
    await loadRelation(post, {
      with: { author: true },
    });
    assert.equal(post.author.name, 'Alice');
  });

  // =======================================================================
  // Predicates
  // =======================================================================

  it('whereHas filters posts with at least one comment', async () => {
    const posts = await whereHas(Post, 'comments').orderBy('entity_.id', 'ASC').getMany();
    assert.equal(posts.length, 3);
    assert.deepEqual(
      posts.map((p) => (p as any).title),
      ['Post One', 'Post Two', 'Post Three'],
    );
  });

  it('whereHas with nested path filters posts by author.profile', async () => {
    const posts = await whereHas(Post, 'author.profile').orderBy('entity_.id', 'ASC').getMany();
    assert.equal(posts.length, 3);
  });

  it('has filters posts by comment count', async () => {
    const posts = await has(Post, 'comments', '>', 1).orderBy('entity_.id', 'ASC').getMany();
    assert.equal(posts.length, 1);
    assert.equal((posts[0] as any).title, 'Post One');
  });

  it('exists is an alias of whereHas', async () => {
    const posts1 = await exists(Post, 'comments').orderBy('entity_.id', 'ASC').getMany();
    const posts2 = await whereHas(Post, 'comments').orderBy('entity_.id', 'ASC').getMany();
    assert.deepEqual(
      posts1.map((p) => (p as any).title),
      posts2.map((p) => (p as any).title),
    );
  });

  // =======================================================================
  // Aggregates
  // =======================================================================

  it('relationCount returns per-parent counts', async () => {
    const counts = await relationCount(Post, 'comments');
    assert.equal(counts.get('1'), 2);
    assert.equal(counts.get('2'), 1);
    assert.equal(counts.get('3'), 1);
    assert.equal(counts.size, 3);
  });

  it('relationCount returns empty map when no matches', async () => {
    const counts = await relationCount(Post, 'comments', { where: { body: 'nonexistent' } });
    assert.equal(counts.size, 0);
  });

  it('relationAggregate sum over likes on author posts', async () => {
    const sums = await relationAggregate(Author, 'posts', 'sum', 'likes');
    assert.equal(sums.get('1'), 17);
    assert.equal(sums.get('2'), 3);
    assert.equal(sums.size, 2);
  });

  it('relationAggregate avg', async () => {
    const avgs = await relationAggregate(Author, 'posts', 'avg', 'likes');
    assert.equal(avgs.get('1'), 8.5);
    assert.equal(avgs.get('2'), 3);
  });

  it('relationAggregate min and max', async () => {
    const mins = await relationAggregate(Author, 'posts', 'min', 'likes');
    const maxs = await relationAggregate(Author, 'posts', 'max', 'likes');
    assert.equal(mins.get('1'), 5);
    assert.equal(maxs.get('1'), 12);
    assert.equal(mins.get('2'), 3);
    assert.equal(maxs.get('2'), 3);
  });

  // =======================================================================
  // Limits are enforced
  // =======================================================================

  it('polymorphic relations are rejected by predicates', async () => {
    assert.throws(
      () => whereHas(Image, 'imageable'),
      (err: any) => err instanceof RelationError && /polymorphic/i.test(err.message),
    );
    assert.throws(
      () => has(Image, 'imageable', '>', 0),
      (err: any) => err instanceof RelationError && /polymorphic/i.test(err.message),
    );
  });

  it('nested paths are rejected by aggregates', async () => {
    await assert.rejects(
      relationCount(Post, 'author.profile'),
      (err: any) => err instanceof RelationError && /nested/i.test(err.message),
    );
  });

  // =======================================================================
  // No N+1: query count is constant regardless of parent count
  // =======================================================================

  it('query count is constant regardless of parent count', async () => {
    const post1 = (await Post.findOneBy({ id: 1 } as any)) as any;
    const counter1 = installQueryCounter();
    const before1 = counter1.getCount();
    await loadRelation(post1, {
      with: {
        author: { with: { profile: true } },
        tags: true,
      },
    });
    const count1 = counter1.getCount() - before1;
    counter1.restore();

    const allPosts = (await Post.find({ order: { id: 'ASC' } as any })) as any[];
    const counter2 = installQueryCounter();
    const before2 = counter2.getCount();
    await loadRelations(allPosts, {
      with: {
        author: { with: { profile: true } },
        tags: true,
      },
    });
    const count2 = counter2.getCount() - before2;
    counter2.restore();

    assert.equal(count2, count1);
  });
});
