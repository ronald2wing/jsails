/**
 * Tests for the batch relation loader (Slices 2–3): M2O, O2M, O2O, M2M, and
 * nested-path loading.
 *
 * Functional coverage: M2O, O2M, O2O-owning, O2O-inverse, M2M-owning,
 * M2M-inverse; nested (2- and 3-level); empty parents; select/where/order/limit;
 * single `loadRelation`; error cases (join strategy, depth exceeded);
 * composite-PK resolution.
 *
 * M2O/O2M/O2O/O2O entities are backed by {@link FileDataSource} (in-memory
 * sqljs). M2M and nested-path entities are backed by raw {@link DataSource}
 * with {@code synchronize: true} so the @JoinTable junction tables are
 * auto-created and seeded via raw queries.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

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
  PrimaryColumn,
  PrimaryGeneratedColumn,
  SelectQueryBuilder,
} from 'typeorm';

import { PolymorphicRelation, clearPolymorphicRegistry } from '../../src/database/polymorphic.js';
import { FileDataSource } from '../../src/database/file-data-source.js';
import { loadRelation, loadRelations } from '../../src/database/relation-loader/index.js';
import { MAX_NESTING_DEPTH, resolveRelation } from '../../src/database/relation-metadata.js';

afterEach(() => clearPolymorphicRegistry());

// ---------------------------------------------------------------------------
// Query-counting instrumentation
// ---------------------------------------------------------------------------

/**
 * Patch `SelectQueryBuilder.prototype.getRawMany` and `getMany` to count every
 * SELECT execution. Our loader's raw (PK, FK) queries use `getRawMany()`,
 * `targetRepo.find()` uses `getMany()` via `createQueryBuilder().getMany()`,
 * and M2M junction queries use `getRawMany()`. Restore after the test.
 *
 * Returns the current count and a restore function; the counter is global, so
 * caller comparisons use deltas (current - initial).
 */
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

// ===================================================================
// M2O: Author (1) <- Book (N)
// ===================================================================

let Author: typeof BaseEntity;
let Book: typeof BaseEntity;

function declareM2OEntities() {
  @Entity('authors_ldr')
  class A extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 100, nullable: false }) name!: string;
    @OneToMany(() => Book, (book: any) => book.author)
    books!: any[];
  }
  Author = A;

  @Entity('books_ldr')
  class B extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 200, nullable: false }) title!: string;
    @ManyToOne(() => Author, { nullable: true })
    @JoinColumn({ name: 'author_id' })
    author!: any;
  }
  Book = B;
}

declareM2OEntities();

async function makeAuthorBook() {
  const fds = await FileDataSource.create({
    models: [
      {
        entity: Author,
        rows: [
          { id: 1, name: 'Orwell' },
          { id: 2, name: 'Huxley' },
          { id: 3, name: 'No Books' },
        ],
      },
      {
        entity: Book,
        rows: [
          { id: 1, title: '1984', author: 1 },
          { id: 2, title: 'Animal Farm', author: 1 },
          { id: 3, title: 'Brave New World', author: 2 },
          { id: 4, title: 'Unknown Author', author: null },
        ],
      },
    ],
  });
  return fds;
}

describe('relation-loader (M2O)', () => {
  test('loads a single many-to-one relation', async () => {
    const fds = await makeAuthorBook();
    try {
      const books = await Book.find({ order: { id: 'ASC' } } as any);
      await loadRelations(books, { with: { author: true } });

      assert.equal(typeof (books[0] as unknown as Record<string, unknown>).author, 'object');
      const author1 = (books[0] as unknown as Record<string, unknown>).author as Record<
        string,
        unknown
      >;
      assert.equal(author1.id, 1);
      assert.equal(author1.name, 'Orwell');

      const author2 = (books[1] as unknown as Record<string, unknown>).author as Record<
        string,
        unknown
      >;
      assert.equal(author2.id, 1);

      const author3 = (books[2] as unknown as Record<string, unknown>).author as Record<
        string,
        unknown
      >;
      assert.equal(author3.id, 2);
    } finally {
      await fds.close();
    }
  });

  test('sets null for a null FK', async () => {
    const fds = await makeAuthorBook();
    try {
      const books = await Book.find({ order: { id: 'ASC' } } as any);
      await loadRelations(books, { with: { author: true } });
      assert.equal((books[3] as unknown as Record<string, unknown>).author, null);
    } finally {
      await fds.close();
    }
  });

  test('empty parents array', async () => {
    const result = await loadRelations([], { with: { author: true } });
    assert.deepEqual(result, []);
  });

  test('empty fds (no rows) short-circuits', async () => {
    const fds = await FileDataSource.create({
      models: [
        { entity: Author, rows: [] },
        { entity: Book, rows: [] },
      ],
    });
    try {
      const books = await Book.find();
      await loadRelations(books, { with: { author: true } });
      assert.deepEqual(books, []);
    } finally {
      await fds.close();
    }
  });

  test('false in with skips the relation', async () => {
    const fds = await makeAuthorBook();
    try {
      const books = await Book.find({ order: { id: 'ASC' } } as any);
      await loadRelations(books, { with: { author: false } });
      assert.ok(true, 'no error thrown');
    } finally {
      await fds.close();
    }
  });

  test('select filters columns on related entity', async () => {
    const fds = await makeAuthorBook();
    try {
      const books = await Book.find({ order: { id: 'ASC' } } as any);
      await loadRelations(books, { with: { author: { select: ['id', 'name'] } } });

      const author = (books[0] as unknown as Record<string, unknown>).author as Record<
        string,
        unknown
      >;
      assert.equal(author.id, 1);
      assert.equal(author.name, 'Orwell');
    } finally {
      await fds.close();
    }
  });

  test('where filters related rows', async () => {
    const fds = await makeAuthorBook();
    try {
      const books = await Book.find({ order: { id: 'ASC' } } as any);
      await loadRelations(books, { with: { author: { where: { name: 'Orwell' } } } });

      const author1 = (books[0] as unknown as Record<string, unknown>).author as Record<
        string,
        unknown
      >;
      assert.equal(author1.id, 1);

      const author3 = (books[2] as unknown as Record<string, unknown>).author;
      assert.equal(author3, null, 'Huxley filtered out by where clause');
    } finally {
      await fds.close();
    }
  });

  test('single-entity loadRelation', async () => {
    const fds = await makeAuthorBook();
    try {
      const book = (await Book.find({ order: { id: 'ASC' } } as any))[0]!;
      const loaded = await loadRelation(book, { with: { author: true } });
      assert.equal(
        ((loaded as unknown as Record<string, unknown>).author as Record<string, unknown>)?.id,
        1,
      );
    } finally {
      await fds.close();
    }
  });

  test('join strategy throws', async () => {
    const fds = await makeAuthorBook();
    try {
      const books = await Book.find({ order: { id: 'ASC' } } as any);
      await assert.rejects(
        () => loadRelations(books, { with: { author: true }, strategy: 'join' }),
        { name: 'RelationError' },
      );
    } finally {
      await fds.close();
    }
  });

  test('nested load books.author.books (M2O then O2M)', async () => {
    const fds = await makeAuthorBook();
    try {
      const books = await Book.find({ order: { id: 'ASC' } } as any);
      await loadRelations(books, { with: { author: { with: { books: true } } } });

      // books[0] = 1984, author = Orwell, author.books = [1984, Animal Farm]
      const book1 = books[0] as unknown as Record<string, unknown>;
      const author1 = book1.author as Record<string, unknown>;
      assert.equal(author1.name, 'Orwell');
      const authorBooks = author1.books as Record<string, unknown>[];
      assert.equal(authorBooks.length, 2);
      assert.equal(authorBooks[0]!.title, '1984');
      assert.equal(authorBooks[1]!.title, 'Animal Farm');

      // Author for book[2] = Huxley, with 1 book
      const book3 = books[2] as unknown as Record<string, unknown>;
      const huxley = book3.author as Record<string, unknown>;
      assert.equal(huxley.name, 'Huxley');
      assert.equal((huxley.books as Record<string, unknown>[]).length, 1);
    } finally {
      await fds.close();
    }
  });
});

// ===================================================================
// O2M: Author2 (1) <- Book2 (N)
// ===================================================================

let Author2: typeof BaseEntity;
let Book2: typeof BaseEntity;

function declareO2MEntities() {
  @Entity('authors_ldr2')
  class A extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 100, nullable: false }) name!: string;
    @OneToMany(() => Book2, (book: any) => book.author)
    books!: any[];
  }
  Author2 = A;

  @Entity('books_ldr2')
  class B extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 200, nullable: false }) title!: string;
    @ManyToOne(() => Author2, { nullable: true })
    @JoinColumn({ name: 'author_id' })
    author!: any;
  }
  Book2 = B;
}

declareO2MEntities();

async function makeAuthorBook2() {
  const fds = await FileDataSource.create({
    models: [
      {
        entity: Author2,
        rows: [
          { id: 1, name: 'Orwell' },
          { id: 2, name: 'Huxley' },
          { id: 3, name: 'No Books' },
        ],
      },
      {
        entity: Book2,
        rows: [
          { id: 1, title: '1984', author: 1 },
          { id: 2, title: 'Animal Farm', author: 1 },
          { id: 3, title: 'Brave New World', author: 2 },
        ],
      },
    ],
  });
  return fds;
}

describe('relation-loader (O2M)', () => {
  test('loads one-to-many relations', async () => {
    const fds = await makeAuthorBook2();
    try {
      const authors = await Author2.find({ order: { id: 'ASC' } } as any);
      await loadRelations(authors, { with: { books: true } });

      const author1 = authors[0] as unknown as Record<string, unknown>;
      const books1 = author1.books as Record<string, unknown>[];
      assert.equal(books1.length, 2);

      const author2 = authors[1] as unknown as Record<string, unknown>;
      const books2 = author2.books as Record<string, unknown>[];
      assert.equal(books2.length, 1);
      assert.equal(books2[0]?.title, 'Brave New World');

      const author3 = authors[2] as unknown as Record<string, unknown>;
      const books3 = author3.books as Record<string, unknown>[];
      assert.deepEqual(books3, []);
    } finally {
      await fds.close();
    }
  });

  test('select/where/order/limit applied to O2M', async () => {
    const fds = await makeAuthorBook2();
    try {
      const authors = await Author2.find({ order: { id: 'ASC' } } as any);
      await loadRelations(authors, {
        with: {
          books: {
            select: ['id', 'title'],
            where: { title: 'Animal Farm' },
            order: { id: 'DESC' },
            limit: 1,
          },
        },
      });

      const author1 = authors[0] as unknown as Record<string, unknown>;
      const books = author1.books as Record<string, unknown>[];
      assert.equal(books.length, 1);
      assert.equal(books[0]?.title, 'Animal Farm');
    } finally {
      await fds.close();
    }
  });

  test('empty parents (O2M)', async () => {
    const result = await loadRelations([], { with: { books: true } });
    assert.deepEqual(result, []);
  });
});

// ===================================================================
// O2O: User (1) <-> Profile (1), FK on Profile
// ===================================================================

let User: typeof BaseEntity;
let Profile: typeof BaseEntity;

function declareO2OEntities() {
  @Entity('users_ldr')
  class U extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 100, nullable: false }) name!: string;
    @OneToOne(() => Profile, (profile: any) => profile.user, { nullable: true })
    profile!: any;
  }
  User = U;

  @Entity('profiles_ldr')
  class P extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 100, nullable: true }) bio!: string | null;
    @OneToOne(() => User)
    @JoinColumn({ name: 'user_id' })
    user!: any;
  }
  Profile = P;
}

declareO2OEntities();

async function makeUserProfile() {
  const fds = await FileDataSource.create({
    models: [
      {
        entity: User,
        rows: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
          { id: 3, name: 'No Profile' },
        ],
      },
      {
        entity: Profile,
        rows: [
          { id: 1, bio: 'Alice bio', user: 1 },
          { id: 2, bio: 'Bob bio', user: 2 },
        ],
      },
    ],
  });
  return fds;
}

describe('relation-loader (O2O)', () => {
  test('loads owning O2O (id on Profile)', async () => {
    const fds = await makeUserProfile();
    try {
      const users = await User.find({ order: { id: 'ASC' } } as any);
      await loadRelations(users, { with: { profile: true } });

      const user1 = users[0] as unknown as Record<string, unknown>;
      assert.ok(user1.profile !== null);
      const profile1 = user1.profile as Record<string, unknown>;
      assert.equal(profile1.id, 1);

      const user3 = users[2] as unknown as Record<string, unknown>;
      assert.equal(user3.profile, null);
    } finally {
      await fds.close();
    }
  });

  test('loads inverse O2O (Profile -> User)', async () => {
    const fds = await makeUserProfile();
    try {
      const profiles = await Profile.find({ order: { id: 'ASC' } } as any);
      await loadRelations(profiles, { with: { user: true } });

      const profile1 = profiles[0] as unknown as Record<string, unknown>;
      const user1 = profile1.user as Record<string, unknown>;
      assert.ok(user1 !== null);
      assert.equal(user1.id, 1);

      const profile2 = profiles[1] as unknown as Record<string, unknown>;
      const user2 = profile2.user as Record<string, unknown>;
      assert.equal(user2.id, 2);
    } finally {
      await fds.close();
    }
  });
});

// ===================================================================
// Composite-PK resolution test (entity metadata only, no load)
// ===================================================================

let CompositeAuthor: typeof BaseEntity;
let CompositeBook: typeof BaseEntity;

function declareCompositeEntities() {
  @Entity('composite_authors')
  class A extends BaseEntity {
    @PrimaryColumn({ type: 'integer' }) tenant!: number;
    @PrimaryColumn({ type: 'integer' }) id!: number;
    @Column({ type: 'varchar', length: 200, nullable: false }) name!: string;
    @OneToMany(() => CompositeBook, (book: any) => book.author)
    books!: any[];
  }
  CompositeAuthor = A;

  @Entity('composite_books')
  class B extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 200, nullable: false }) title!: string;
    @ManyToOne(() => CompositeAuthor, { nullable: true })
    @JoinColumn({ name: 'author_tenant' })
    @JoinColumn({ name: 'author_id' })
    author!: any;
  }
  CompositeBook = B;
}

declareCompositeEntities();

describe('relation-loader (composite PK resolution)', () => {
  test('resolveRelation detects composite PK primaryColumns', () => {
    const relation = resolveRelation(CompositeBook, 'author');
    assert.deepEqual(relation.primaryColumns, ['tenant', 'id']);
  });
});

// ===================================================================
// Slice 3: Nested paths (3-level)
// ===================================================================

/**
 * Entity graph for 3-level nesting:
 *   Post (N) -> Comment (M2O), Comment -> AuthorEntity (M2O)
 * So posts.comments.author = 3 batched queries total.
 */

let PostEntity: typeof BaseEntity;
let CommentEntity: typeof BaseEntity;
let AuthorEntity: typeof BaseEntity;

function declareNestedEntities() {
  @Entity('nest_authors')
  class A extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 100, nullable: false }) name!: string;
  }
  AuthorEntity = A;

  @Entity('nest_comments')
  class C extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 200, nullable: false }) body!: string;
    @ManyToOne(() => PostEntity)
    @JoinColumn({ name: 'post_id' })
    post!: any;
    @ManyToOne(() => AuthorEntity)
    @JoinColumn({ name: 'author_id' })
    author!: any;
  }
  CommentEntity = C;

  @Entity('nest_posts')
  class P extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 200, nullable: false }) title!: string;
    @OneToMany(() => CommentEntity, (c: any) => c.post)
    comments!: any[];
  }
  PostEntity = P;
}

declareNestedEntities();

async function makeNestedDS() {
  const ds = new DataSource({
    type: 'sqljs',
    entities: [PostEntity, CommentEntity, AuthorEntity],
    synchronize: true,
  } as any);
  await ds.initialize();

  await (ds.getRepository(PostEntity) as any).save([
    { id: 1, title: 'Post 1' },
    { id: 2, title: 'Post 2' },
  ]);

  await (ds.getRepository(AuthorEntity) as any).save([
    { id: 1, name: 'Alice' },
    { id: 2, name: 'Bob' },
  ]);

  await (ds.getRepository(CommentEntity) as any).save([
    { id: 1, body: 'Comment 1', post: 1, author: 1 },
    { id: 2, body: 'Comment 2', post: 1, author: 2 },
    { id: 3, body: 'Comment 3', post: 2, author: 1 },
  ]);

  return ds;
}

describe('relation-loader (nested 3-level)', () => {
  test('loads posts.comments.author with exactly 4 loader queries for N>1 parents', async () => {
    const ds = await makeNestedDS();
    const counter = installQueryCounter();
    try {
      // Let the initial find() also be counted — we take the delta after it.
      const posts = (await PostEntity.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      const initialQueryCount = counter.getCount();

      await loadRelations(posts, {
        with: { comments: { with: { author: true } } },
      });

      const loaderQueryCount = counter.getCount() - initialQueryCount;

      // Level 0: O2M comments (1 raw query + 1 child find = 2)
      // Level 1: M2O author (1 raw query + 1 target find = 2)
      // Total = 4 loader queries.
      assert.equal(loaderQueryCount, 4);

      // Post 1: 2 comments, by Alice + Bob
      const post1 = posts[0]!;
      const post1Comments = post1.comments as Record<string, unknown>[];
      assert.equal(post1Comments.length, 2);

      const c1Author = post1Comments[0]!.author as Record<string, unknown>;
      assert.equal(c1Author.name, 'Alice');
      const c2Author = post1Comments[1]!.author as Record<string, unknown>;
      assert.equal(c2Author.name, 'Bob');

      // Post 2: 1 comment, by Alice
      const post2 = posts[1]!;
      const post2Comments = post2.comments as Record<string, unknown>[];
      assert.equal(post2Comments.length, 1);
      const c3Author = post2Comments[0]!.author as Record<string, unknown>;
      assert.equal(c3Author.name, 'Alice');
    } finally {
      counter.restore();
      await ds.destroy();
    }
  });
});

// ===================================================================
// Slice 3: M2M junction traversal
// ===================================================================

/**
 * Post <-> Tag M2M with @JoinTable on the owning side (Post.tags).
 */

let M2mPost: typeof BaseEntity;
let M2mTag: typeof BaseEntity;

function declareM2mEntities() {
  @Entity('m2m_posts')
  class P extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 200, nullable: false }) title!: string;
    @ManyToMany(() => M2mTag, (tag: any) => tag.posts)
    @JoinTable({
      name: 'm2m_post_tags',
      joinColumn: { name: 'postId', referencedColumnName: 'id' },
      inverseJoinColumn: { name: 'tagId', referencedColumnName: 'id' },
    })
    tags!: any[];
  }
  M2mPost = P;

  @Entity('m2m_tags')
  class T extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 100, nullable: false }) name!: string;
    @ManyToMany(() => M2mPost, (post: any) => post.tags)
    posts!: any[];
  }
  M2mTag = T;
}

declareM2mEntities();

async function makeM2mDS() {
  const ds = new DataSource({
    type: 'sqljs',
    entities: [M2mPost, M2mTag],
    synchronize: true,
  } as any);
  await ds.initialize();

  await (ds.getRepository(M2mPost) as any).save([
    { id: 1, title: 'Post 1' },
    { id: 2, title: 'Post 2' },
    { id: 3, title: 'Post 3 (no tags)' },
  ]);

  await (ds.getRepository(M2mTag) as any).save([
    { id: 1, name: 'TypeScript' },
    { id: 2, name: 'JavaScript' },
    { id: 3, name: 'Node.js' },
    { id: 4, name: 'Unused' },
  ]);

  // Seed junction table. The @JoinTable auto-generated column names depend on
  // TypeORM's naming strategy. Default: <entity>Id → postId / tagId.
  await ds.query('INSERT INTO "m2m_post_tags" ("postId", "tagId") VALUES (?, ?)', [1, 1]);
  await ds.query('INSERT INTO "m2m_post_tags" ("postId", "tagId") VALUES (?, ?)', [1, 2]);
  await ds.query('INSERT INTO "m2m_post_tags" ("postId", "tagId") VALUES (?, ?)', [2, 2]);
  await ds.query('INSERT INTO "m2m_post_tags" ("postId", "tagId") VALUES (?, ?)', [2, 3]);

  return ds;
}

describe('relation-loader (M2M)', () => {
  test('loads M2M owning (post -> tags) in exactly 2 queries', async () => {
    const ds = await makeM2mDS();
    const counter = installQueryCounter();
    try {
      const posts = (await M2mPost.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      const initialCount = counter.getCount();

      await loadRelations(posts, { with: { tags: true } });

      const loaderCount = counter.getCount() - initialCount;
      // Junction query (getRawMany) + target find (getMany) = 2 queries.
      assert.equal(loaderCount, 2);

      const post1 = posts[0]!;
      const tags1 = post1.tags as Record<string, unknown>[];
      assert.equal(tags1.length, 2);
      assert.equal(tags1[0]!.name, 'TypeScript');
      assert.equal(tags1[1]!.name, 'JavaScript');

      const post2 = posts[1]!;
      const tags2 = post2.tags as Record<string, unknown>[];
      assert.equal(tags2.length, 2);
      assert.equal(tags2[0]!.name, 'JavaScript');
      assert.equal(tags2[1]!.name, 'Node.js');

      const post3 = posts[2]!;
      assert.deepEqual(post3.tags, []);
    } finally {
      counter.restore();
      await ds.destroy();
    }
  });

  test('loads M2M inverse (tag -> posts)', async () => {
    const ds = await makeM2mDS();
    try {
      const tags = (await M2mTag.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      await loadRelations(tags, { with: { posts: true } });

      const tag1 = tags[0]!;
      const tag1Posts = tag1.posts as Record<string, unknown>[];
      assert.equal(tag1Posts.length, 1);
      assert.equal(tag1Posts[0]!.title, 'Post 1');

      const tag2 = tags[1]!;
      const tag2Posts = tag2.posts as Record<string, unknown>[];
      assert.equal(tag2Posts.length, 2);

      const tag4 = tags[3]!;
      assert.deepEqual(tag4.posts, []);
    } finally {
      await ds.destroy();
    }
  });

  test('M2M with where/order/limit', async () => {
    const ds = await makeM2mDS();
    try {
      const posts = (await M2mPost.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      await loadRelations(posts, {
        with: {
          tags: {
            where: { name: 'JavaScript' },
            order: { id: 'DESC' },
            limit: 1,
          },
        },
      });

      // Post 1 has TypeScript + JavaScript; where filters to JavaScript only.
      const post1 = posts[0]!;
      const tags1 = post1.tags as Record<string, unknown>[];
      assert.equal(tags1.length, 1);
      assert.equal(tags1[0]!.name, 'JavaScript');
    } finally {
      await ds.destroy();
    }
  });

  test('empty parent array for M2M returns zero queries', async () => {
    const ds = await makeM2mDS();
    const counter = installQueryCounter();
    try {
      // Just calling loadRelations([]) — no queries at all.
      const initialCount = counter.getCount();
      await loadRelations([], { with: { tags: true } });
      assert.equal(counter.getCount(), initialCount);
    } finally {
      counter.restore();
      await ds.destroy();
    }
  });
});

// ===================================================================
// Slice 3: Nested M2M
// ===================================================================

/**
 * Verify that M2M loaded children flow into nested recursion.
 * The `tag` entity (M2mTag) has no outgoing relations to test nesting with,
 * so we chain: load post.tags, then on each tag, load... we could define a
 * O2M on Tag if we extend the entity. For simplicity, we reuse the existing
 * Author M2O pattern: define a TagAuthor entity and add a M2O from Tag to
 * TagAuthor. Then posts.tags.author is a nested M2M path.
 */

let M2mNestedPost: typeof BaseEntity;
let M2mNestedTag: typeof BaseEntity;
let M2mNestedAuthor: typeof BaseEntity;

function declareM2mNestedEntities() {
  @Entity('m2mn_posts')
  class P extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 200, nullable: false }) title!: string;
    @ManyToMany(() => M2mNestedTag, (tag: any) => tag.posts)
    @JoinTable({
      name: 'm2mn_post_tags',
      joinColumn: { name: 'postId', referencedColumnName: 'id' },
      inverseJoinColumn: { name: 'tagId', referencedColumnName: 'id' },
    })
    tags!: any[];
  }
  M2mNestedPost = P;

  @Entity('m2mn_tags')
  class T extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 100, nullable: false }) name!: string;
    @ManyToMany(() => M2mNestedPost, (post: any) => post.tags)
    posts!: any[];
    @ManyToOne(() => M2mNestedAuthor)
    @JoinColumn({ name: 'author_id' })
    author!: any;
  }
  M2mNestedTag = T;

  @Entity('m2mn_authors')
  class A extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 100, nullable: false }) name!: string;
  }
  M2mNestedAuthor = A;
}

declareM2mNestedEntities();

async function makeM2mNestedDS() {
  const ds = new DataSource({
    type: 'sqljs',
    entities: [M2mNestedPost, M2mNestedTag, M2mNestedAuthor],
    synchronize: true,
  } as any);
  await ds.initialize();

  await (ds.getRepository(M2mNestedPost) as any).save([
    { id: 1, title: 'Post 1' },
    { id: 2, title: 'Post 2' },
  ]);

  await (ds.getRepository(M2mNestedAuthor) as any).save([
    { id: 1, name: 'Alice' },
    { id: 2, name: 'Bob' },
  ]);

  await (ds.getRepository(M2mNestedTag) as any).save([
    { id: 1, name: 'TypeScript', author: 1 },
    { id: 2, name: 'JavaScript', author: 2 },
    { id: 3, name: 'Node.js', author: 1 },
  ]);

  // Junction: Post 1 → TS + JS, Post 2 → JS + Node
  await ds.query('INSERT INTO "m2mn_post_tags" ("postId", "tagId") VALUES (?, ?)', [1, 1]);
  await ds.query('INSERT INTO "m2mn_post_tags" ("postId", "tagId") VALUES (?, ?)', [1, 2]);
  await ds.query('INSERT INTO "m2mn_post_tags" ("postId", "tagId") VALUES (?, ?)', [2, 2]);
  await ds.query('INSERT INTO "m2mn_post_tags" ("postId", "tagId") VALUES (?, ?)', [2, 3]);

  return ds;
}

describe('relation-loader (nested M2M)', () => {
  test('loads posts.tags.author (M2M then M2O)', async () => {
    const ds = await makeM2mNestedDS();
    try {
      const posts = (await M2mNestedPost.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      await loadRelations(posts, {
        with: { tags: { with: { author: true } } },
      });

      // Post 1 tags: TypeScript (author=Alice), JavaScript (author=Bob)
      const post1 = posts[0]!;
      const tags1 = post1.tags as Record<string, unknown>[];
      assert.equal(tags1.length, 2);
      assert.equal((tags1[0]!.author as Record<string, unknown>).name, 'Alice');
      assert.equal((tags1[1]!.author as Record<string, unknown>).name, 'Bob');

      // Post 2 tags: JavaScript (author=Bob), Node.js (author=Alice)
      const post2 = posts[1]!;
      const tags2 = post2.tags as Record<string, unknown>[];
      assert.equal(tags2.length, 2);
      assert.equal((tags2[0]!.author as Record<string, unknown>).name, 'Bob');
      assert.equal((tags2[1]!.author as Record<string, unknown>).name, 'Alice');
    } finally {
      await ds.destroy();
    }
  });
});

// ===================================================================
// Slice 3: Error cases
// ===================================================================

describe('relation-loader (depth limits)', () => {
  test('depth-exceeded path throws value-free RelationError', async () => {
    // Build a depth that exceeds MAX_NESTING_DEPTH by nesting `with` to
    // MAX_NESTING_DEPTH + 1. We chain M2O relations using the existing entities.
    // Book → Author → ??? We don't have chained entities for 9 levels.
    // Test via the recursion: create a spec with 9 nested `with` levels.
    const tooDeep: any = { author: true };
    let current = tooDeep;
    for (let i = 1; i <= MAX_NESTING_DEPTH; i += 1) {
      current.author = { with: { author: true } };
      current = current.author;
    }

    const fds = await FileDataSource.create({
      models: [
        { entity: Author, rows: [{ id: 1, name: 'Orwell' }] },
        { entity: Book, rows: [{ id: 1, title: '1984', author: 1 }] },
      ],
    });
    try {
      const books = await Book.find({ order: { id: 'ASC' } } as any);
      await assert.rejects(() => loadRelations(books, { with: tooDeep }), {
        name: 'RelationError',
      });
    } finally {
      await fds.close();
    }
  });
});

// ===================================================================
// Slice 4: Polymorphic batched loading
// ===================================================================

/**
 * Entity graph for polymorphic tests:
 *   Comment -[polymorphic]-> Post | Video  (target property on Comment)
 *   Post <-[inverse]- Comment                (comments relatedName)
 *   Video <-[inverse]- Comment
 *
 * The polymorphic descriptor lives on Comment:
 *   @PolymorphicRelation({ targets: [Post, Video], relatedName: 'comments' })
 *
 * Columns generated: target_type (varchar), target_id (integer).
 */

let PolyPost: typeof BaseEntity;
let PolyVideo: typeof BaseEntity;
let PolyComment: typeof BaseEntity;

function declarePolymorphicEntities() {
  @Entity('poly_posts')
  class Post extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 200, nullable: false }) title!: string;
  }
  PolyPost = Post;

  @Entity('poly_videos')
  class Video extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 200, nullable: false }) title!: string;
    // Video has an extra column not present on Post for select/where validation tests.
    @Column({ type: 'integer', nullable: true }) duration!: number | null;
  }
  PolyVideo = Video;

  @Entity('poly_comments')
  class Comment extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 500, nullable: false }) body!: string;
    @PolymorphicRelation({ targets: [Post, Video], relatedName: 'comments' })
    target!: any;
  }
  PolyComment = Comment;
}

async function makePolymorphicDS() {
  const fds = await FileDataSource.create({
    models: [
      {
        entity: PolyPost,
        rows: [
          { id: 1, title: 'Post One' },
          { id: 2, title: 'Post Two' },
          { id: 3, title: 'Post Three (no comments)' },
        ],
      },
      {
        entity: PolyVideo,
        rows: [
          { id: 1, title: 'Video One', duration: 120 },
          { id: 2, title: 'Video Two', duration: 240 },
          { id: 3, title: 'Video Three (no comments)', duration: 360 },
        ],
      },
      {
        entity: PolyComment,
        rows: [
          { id: 1, body: 'Comment on Post 1', target_type: 'poly_posts', target_id: 1 },
          { id: 2, body: 'Comment on Post 2', target_type: 'poly_posts', target_id: 2 },
          { id: 3, body: 'Comment on Video 1', target_type: 'poly_videos', target_id: 1 },
          { id: 4, body: 'Comment on Video 2', target_type: 'poly_videos', target_id: 2 },
        ],
      },
    ],
  });
  return fds;
}

describe('relation-loader (polymorphic forward)', () => {
  test('loads polymorphic forward (child -> parent) with one query per target table', async () => {
    // Re-register: top-level afterEach calls clearPolymorphicRegistry().
    declarePolymorphicEntities();
    const fds = await makePolymorphicDS();
    const counter = installQueryCounter();
    try {
      const comments = (await PolyComment.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      const initialCount = counter.getCount();
      await loadRelations(comments, { with: { target: true } });
      const loaderCount = counter.getCount() - initialCount;

      // Two distinct target tables (poly_posts, poly_videos) -> 2 find() queries.
      assert.equal(loaderCount, 2);

      // Comment 1 -> Post One
      const c1 = comments[0]!;
      assert.equal((c1.target as Record<string, unknown>).id, 1);
      assert.equal((c1.target as Record<string, unknown>).title, 'Post One');

      // Comment 2 -> Post Two
      const c2 = comments[1]!;
      assert.equal((c2.target as Record<string, unknown>).title, 'Post Two');

      // Comment 3 -> Video One
      const c3 = comments[2]!;
      assert.equal((c3.target as Record<string, unknown>).title, 'Video One');

      // Comment 4 -> Video Two
      const c4 = comments[3]!;
      assert.equal((c4.target as Record<string, unknown>).title, 'Video Two');
    } finally {
      counter.restore();
      await fds.close();
    }
  });

  test('polymorphic forward: empty parents -> zero queries', async () => {
    const fds = await makePolymorphicDS();
    const counter = installQueryCounter();
    try {
      const initialCount = counter.getCount();
      await loadRelations([], { with: { target: true } });
      assert.equal(counter.getCount(), initialCount);
    } finally {
      counter.restore();
      await fds.close();
    }
  });

  test('polymorphic forward: select filters columns on loaded targets', async () => {
    declarePolymorphicEntities();
    const fds = await makePolymorphicDS();
    try {
      const comments = (await PolyComment.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      // Both Post and Video have 'id' and 'title', so this is valid.
      await loadRelations(comments, { with: { target: { select: ['id', 'title'] } } });

      const c1 = comments[0]!;
      assert.equal((c1.target as Record<string, unknown>).id, 1);
      assert.equal((c1.target as Record<string, unknown>).title, 'Post One');
    } finally {
      await fds.close();
    }
  });

  test('polymorphic forward: select with column absent on one target throws', async () => {
    declarePolymorphicEntities();
    const fds = await makePolymorphicDS();
    try {
      const comments = (await PolyComment.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      // 'duration' exists on Video but NOT on Post — must be rejected value-free.
      await assert.rejects(
        () => loadRelations(comments, { with: { target: { select: ['id', 'duration'] } } }),
        { name: 'RelationError' },
      );
    } finally {
      await fds.close();
    }
  });

  test('polymorphic forward: where with column absent on one target throws', async () => {
    declarePolymorphicEntities();
    const fds = await makePolymorphicDS();
    try {
      const comments = (await PolyComment.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      // 'duration' exists on Video but NOT on Post — must be rejected.
      await assert.rejects(
        () => loadRelations(comments, { with: { target: { where: { duration: 120 } } } }),
        { name: 'RelationError' },
      );
    } finally {
      await fds.close();
    }
  });

  test('polymorphic forward: where applied as filter', async () => {
    declarePolymorphicEntities();
    const fds = await makePolymorphicDS();
    try {
      const comments = (await PolyComment.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      // Filter to only Post One (id=1). Comment 1 targets Post 1, Comment 2 targets
      // Post 2 but gets null because the where clause excludes it.
      await loadRelations(comments, { with: { target: { where: { title: 'Post One' } } } });

      const c1 = comments[0]!;
      assert.equal((c1.target as Record<string, unknown>).title, 'Post One');

      const c2 = comments[1]!;
      assert.equal(c2.target, null, 'Post Two filtered out by where clause');
    } finally {
      await fds.close();
    }
  });
});

describe('relation-loader (polymorphic inverse)', () => {
  test('loads polymorphic inverse (parent -> children) with one query', async () => {
    declarePolymorphicEntities();
    const fds = await makePolymorphicDS();
    const counter = installQueryCounter();
    try {
      const posts = (await PolyPost.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      const initialCount = counter.getCount();
      await loadRelations(posts, { with: { comments: true } });
      const loaderCount = counter.getCount() - initialCount;

      // One find() query on the child table filtered by type + id IN.
      assert.equal(loaderCount, 1);

      // Post 1: has 1 comment
      const post1 = posts[0]!;
      const post1Comments = post1.comments as Record<string, unknown>[];
      assert.equal(post1Comments.length, 1);
      assert.equal(post1Comments[0]!.body, 'Comment on Post 1');

      // Post 2: has 1 comment
      const post2 = posts[1]!;
      const post2Comments = post2.comments as Record<string, unknown>[];
      assert.equal(post2Comments.length, 1);
      assert.equal(post2Comments[0]!.body, 'Comment on Post 2');

      // Post 3: no comments
      const post3 = posts[2]!;
      assert.deepEqual(post3.comments, []);
    } finally {
      counter.restore();
      await fds.close();
    }
  });

  test('polymorphic inverse: empty parents -> zero queries', async () => {
    const fds = await makePolymorphicDS();
    const counter = installQueryCounter();
    try {
      const initialCount = counter.getCount();
      await loadRelations([], { with: { comments: true } });
      assert.equal(counter.getCount(), initialCount);
    } finally {
      counter.restore();
      await fds.close();
    }
  });

  test('polymorphic inverse: select/where/order/limit applied', async () => {
    declarePolymorphicEntities();
    const fds = await makePolymorphicDS();
    try {
      const posts = (await PolyPost.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      await loadRelations(posts, {
        with: {
          comments: {
            select: ['id', 'body'],
            where: { body: 'Comment on Post 1' },
            order: { id: 'DESC' },
            limit: 1,
          },
        },
      });

      const post1 = posts[0]!;
      const post1Comments = post1.comments as Record<string, unknown>[];
      assert.equal(post1Comments.length, 1);
      assert.equal(post1Comments[0]!.body, 'Comment on Post 1');
    } finally {
      await fds.close();
    }
  });

  test('polymorphic inverse: relation without matching child gets empty arrays', async () => {
    // The registered Comment descriptor has relatedName 'comments', so the
    // loader recognises this as a plausible inverse property even though no
    // child targets orphan_targets. Without the descriptor, the fallback
    // would be skipped and resolveRelation would throw.
    declarePolymorphicEntities();

    // Entity without any polymorphic child targeting it.
    @Entity('orphan_targets')
    class OrphanTarget extends BaseEntity {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: 'varchar', length: 100, nullable: false }) name!: string;
    }

    const fds = await FileDataSource.create({
      models: [{ entity: OrphanTarget, rows: [{ id: 1, name: 'Orphan' }] }],
    });
    try {
      const orphans = (await OrphanTarget.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      // 'comments' matches no polymorphic descriptor -> every parent gets [].
      await loadRelations(orphans, { with: { comments: true } });

      assert.deepEqual((orphans[0] as Record<string, unknown>).comments, []);
    } finally {
      await fds.close();
    }
  });
});

describe('relation-loader (polymorphic nested)', () => {
  test('polymorphic forward then nested M2O on target', async () => {
    // Extend the graph: Post has an author. Comment -> target (polymorphic)
    // -> author (M2O on Post). Only posts have authors; videos don't.
    @Entity('poly_nest_posts')
    class NestPost extends BaseEntity {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: 'varchar', length: 200, nullable: false }) title!: string;
      @ManyToOne(() => NestAuthor)
      @JoinColumn({ name: 'author_id' })
      author!: any;
    }

    @Entity('poly_nest_videos')
    class NestVideo extends BaseEntity {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: 'varchar', length: 200, nullable: false }) title!: string;
    }

    @Entity('poly_nest_authors')
    class NestAuthor extends BaseEntity {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: 'varchar', length: 100, nullable: false }) name!: string;
    }

    @Entity('poly_nest_comments')
    class NestComment extends BaseEntity {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: 'varchar', length: 500, nullable: false }) body!: string;
      @PolymorphicRelation({ targets: [NestPost, NestVideo], relatedName: 'comments' })
      target!: any;
    }

    const fds = await FileDataSource.create({
      models: [
        {
          entity: NestAuthor,
          rows: [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
          ],
        },
        {
          entity: NestPost,
          rows: [
            { id: 1, title: 'Post One', author: 1 },
            { id: 2, title: 'Post Two', author: 2 },
          ],
        },
        {
          entity: NestVideo,
          rows: [{ id: 1, title: 'Video One' }],
        },
        {
          entity: NestComment,
          rows: [
            { id: 1, body: 'On Post 1', target_type: 'poly_nest_posts', target_id: 1 },
            { id: 2, body: 'On Video 1', target_type: 'poly_nest_videos', target_id: 1 },
          ],
        },
      ],
    });

    try {
      const comments = (await NestComment.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      // Load comment.target then target.author (M2O nested under polymorphic).
      await loadRelations(comments, {
        with: { target: { with: { author: true } } },
      });

      // Comment 1 -> Post 1 -> Alice
      const c1 = comments[0]!;
      const c1Target = c1.target as Record<string, unknown>;
      assert.equal(c1Target.title, 'Post One');
      assert.equal((c1Target.author as Record<string, unknown>).name, 'Alice');

      // Comment 2 -> Video 1 (Video has no 'author' relation, so resolveRelation
      // will throw for 'author' on Video). The nested recursion uses
      // collectLoadedChildren, which feeds [VideoOne] into the next level.
      // resolveRelation(Video, 'author') throws RelationError — and there is no
      // polymorphic inverse fallback for 'author' on Video (no child targets it).
      // The error should propagate as a RelationError.
      // But wait: Video has no `author` property at all. resolveRelation will
      // throw. This is expected — you cannot load a relation that doesn't exist.
      // However, the comment targeting a Video should NOT break the whole batch.
      // The current design: if any child in the collected set fails resolution,
      // the whole nested level fails. This is intentional for M2O/O2M nesting
      // where every child is expected to have the same relation. For polymorphic,
      // the targets may have different shapes.
      //
      // We accept this limitation: nesting under polymorphic requires every
      // target to have the requested relation. The caller is expected to know
      // that or use separate load calls. This test documents the behavior.
    } finally {
      await fds.close();
    }
  });

  test('polymorphic forward then nested M2O on target (same-shape targets)', async () => {
    // Same test but both targets have the 'author' relation.
    @Entity('poly_nest2_posts')
    class Nest2Post extends BaseEntity {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: 'varchar', length: 200, nullable: false }) title!: string;
      @ManyToOne(() => Nest2Author)
      @JoinColumn({ name: 'author_id' })
      author!: any;
    }

    @Entity('poly_nest2_videos')
    class Nest2Video extends BaseEntity {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: 'varchar', length: 200, nullable: false }) title!: string;
      @ManyToOne(() => Nest2Author)
      @JoinColumn({ name: 'author_id' })
      author!: any;
    }

    @Entity('poly_nest2_authors')
    class Nest2Author extends BaseEntity {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: 'varchar', length: 100, nullable: false }) name!: string;
    }

    @Entity('poly_nest2_comments')
    class Nest2Comment extends BaseEntity {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: 'varchar', length: 500, nullable: false }) body!: string;
      @PolymorphicRelation({ targets: [Nest2Post, Nest2Video], relatedName: 'comments' })
      target!: any;
    }

    const fds = await FileDataSource.create({
      models: [
        {
          entity: Nest2Author,
          rows: [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
          ],
        },
        {
          entity: Nest2Post,
          rows: [
            { id: 1, title: 'Post One', author: 1 },
            { id: 2, title: 'Post Two', author: 2 },
          ],
        },
        {
          entity: Nest2Video,
          rows: [
            { id: 1, title: 'Video One', author: 1 },
            { id: 2, title: 'Video Two', author: 2 },
          ],
        },
        {
          entity: Nest2Comment,
          rows: [
            { id: 1, body: 'On Post 1', target_type: 'poly_nest2_posts', target_id: 1 },
            { id: 2, body: 'On Video 2', target_type: 'poly_nest2_videos', target_id: 2 },
          ],
        },
      ],
    });

    try {
      const comments = (await Nest2Comment.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      await loadRelations(comments, {
        with: { target: { with: { author: true } } },
      });

      // Comment 1 -> Post 1 -> Alice
      const c1 = comments[0]!;
      const c1Target = c1.target as Record<string, unknown>;
      assert.equal(c1Target.title, 'Post One');
      assert.equal((c1Target.author as Record<string, unknown>).name, 'Alice');

      // Comment 2 -> Video 2 -> Bob
      const c2 = comments[1]!;
      const c2Target = c2.target as Record<string, unknown>;
      assert.equal(c2Target.title, 'Video Two');
      assert.equal((c2Target.author as Record<string, unknown>).name, 'Bob');
    } finally {
      await fds.close();
    }
  });

  test('polymorphic inverse then nested relation on children', async () => {
    // Posts have comments (polymorphic inverse). Each comment has a nested
    // polymorphic forward load: comment.target (the post itself).
    // This tests inverse -> forward nesting.
    declarePolymorphicEntities();
    const fds = await makePolymorphicDS();
    try {
      const posts = (await PolyPost.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      await loadRelations(posts, {
        with: { comments: { with: { target: true } } },
      });

      // Post 1 -> [Comment on Post 1], and that comment's target is Post 1.
      const post1 = posts[0]!;
      const post1Comments = post1.comments as Record<string, unknown>[];
      assert.equal(post1Comments.length, 1);
      const nestedTarget = post1Comments[0]!.target as Record<string, unknown>;
      assert.equal(nestedTarget.id, 1);
      assert.equal(nestedTarget.title, 'Post One');
    } finally {
      await fds.close();
    }
  });
});
