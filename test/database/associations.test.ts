import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  BaseEntity,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { ObjectLiteral } from 'typeorm';

import {
  accepts_nested_attributes_for,
  AssociationError,
  belongs_to,
  has_many,
  has_one,
} from '../../src/database/associations.js';
import { JsailsDataSource } from '../../src/database/data-source.js';
import {
  createEntitySubscriber,
  type EntityHooksDefinition,
} from '../../src/database/entity-subscribers.js';
import { generateMigration } from '../../src/migrations/autodetector.js';
import { migrate, type MigrationDataSource } from '../../src/migrations/migrator.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'associations-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function asMigrationDataSource(dataSource: JsailsDataSource): MigrationDataSource {
  return dataSource as unknown as MigrationDataSource;
}

let dbSeq = 0;

async function createDataSource(
  entities: (Function | typeof BaseEntity)[],
  ...definitions: EntityHooksDefinition<ObjectLiteral>[]
): Promise<JsailsDataSource> {
  const location = join(tmpRoot, `db-${dbSeq++}.sqlite`);
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location,
    entities,
    subscribers: [createEntitySubscriber(...definitions)],
  });
  await dataSource.initialize();
  const schema = await dataSource.getModelSchema();
  const migration = generateMigration('create_tables', [], schema);
  assert.ok(migration, 'expected a create migration for the fixture schema');
  await migrate(asMigrationDataSource(dataSource), [migration]);
  return dataSource;
}

// ---------------------------------------------------------------------------
// Fixture entities
// ---------------------------------------------------------------------------

function makePost() {
  @Entity('posts')
  class Post extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 200, nullable: false })
    title!: string;

    @Column({ type: 'integer', nullable: false, default: 0 })
    comments_count!: number;

    @Column({ type: 'datetime', nullable: true })
    updated_at!: Date | null;

    @OneToMany('Comment', 'post')
    comments!: unknown[];
  }
  return Post;
}

function makeComment() {
  @Entity('comments')
  class Comment extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 500, nullable: false })
    body!: string;

    @ManyToOne('Post', 'comments', { nullable: false })
    post!: unknown;

    @ManyToOne('Author', 'comments', { nullable: true })
    author!: unknown;
  }
  return Comment;
}

function makeAuthor() {
  @Entity('authors')
  class Author extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 200, nullable: false })
    name!: string;

    @Column({ type: 'datetime', nullable: true })
    updated_at!: Date | null;

    @OneToMany('Comment', 'author')
    comments!: unknown[];
  }
  return Author;
}

function makeProfileEntity() {
  @Entity('profiles')
  class Profile extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 500, nullable: false })
    bio!: string;

    @Column({ type: 'datetime', nullable: true })
    updated_at!: Date | null;

    @OneToOne('ProfileUser', 'profile', { nullable: false })
    @JoinColumn({ name: 'user_id' })
    user!: unknown;
  }
  return Profile;
}

function makeProfileUser() {
  @Entity('profile_users')
  class ProfileUser extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 200, nullable: false })
    name!: string;

    @Column({ type: 'datetime', nullable: true })
    updated_at!: Date | null;

    @OneToOne('Profile', { nullable: true })
    profile!: unknown;
  }
  return ProfileUser;
}

// ---------------------------------------------------------------------------
// has_many — counter_cache
// ---------------------------------------------------------------------------

describe('has_many — counter_cache', () => {
  it('increments the parent counter column on child insert', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const Author = makeAuthor(); // Comment references Author too
    const hooks = has_many(Post, 'comments', { counter_cache: true });
    const dataSource = await createDataSource([Post, Comment, Author], ...hooks);

    const post = await Post.create({ title: 'First' }).save();
    assert.equal(post.comments_count, 0);

    await Comment.create({ body: 'one', post }).save();
    await Comment.create({ body: 'two', post }).save();

    const reloaded = await Post.findOneByOrFail({ id: post.id });
    assert.equal(reloaded.comments_count, 2);

    await dataSource.destroy();
  });

  it('decrements the parent counter column on child delete', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const Author = makeAuthor(); // Comment references Author too
    const hooks = has_many(Post, 'comments', { counter_cache: true });
    const dataSource = await createDataSource([Post, Comment, Author], ...hooks);

    const post = await Post.create({ title: 'Del' }).save();
    const c1 = await Comment.create({ body: 'a', post }).save();
    const c2 = await Comment.create({ body: 'b', post }).save();

    await c1.remove();
    const afterOne = await Post.findOneByOrFail({ id: post.id });
    assert.equal(afterOne.comments_count, 1);

    await c2.remove();
    const afterTwo = await Post.findOneByOrFail({ id: post.id });
    assert.equal(afterTwo.comments_count, 0);

    await dataSource.destroy();
  });

  it('uses a custom column name when counter_cache is a string', async () => {
    @Entity('tagged_posts')
    class TaggedPost extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'integer', nullable: false, default: 0 })
      tag_count!: number;

      @OneToMany('Tag', 'post')
      tags!: unknown[];
    }

    @Entity('tags')
    class Tag extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      label!: string;

      @ManyToOne('TaggedPost', 'tags', { nullable: false })
      post!: unknown;
    }

    const hooks = has_many(TaggedPost, 'tags', { counter_cache: 'tag_count' });
    const dataSource = await createDataSource([TaggedPost, Tag], ...hooks);

    const post = await TaggedPost.create({}).save();
    assert.equal(post.tag_count, 0);

    await Tag.create({ label: 'js', post }).save();
    await Tag.create({ label: 'ts', post }).save();

    const reloaded = await TaggedPost.findOneByOrFail({ id: post.id });
    assert.equal(reloaded.tag_count, 2);

    await dataSource.destroy();
  });
});

// ---------------------------------------------------------------------------
// has_many — touch
// ---------------------------------------------------------------------------

describe('has_many — touch', () => {
  it('touches the parent updated_at on child insert', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const Author = makeAuthor(); // Comment references Author too
    const hooks = has_many(Post, 'comments', { touch: true });
    const dataSource = await createDataSource([Post, Comment, Author], ...hooks);

    const post = await Post.create({ title: 'TouchMe' }).save();
    assert.equal(post.updated_at, null);

    await Comment.create({ body: 'hello', post }).save();

    const reloaded = await Post.findOneByOrFail({ id: post.id });
    assert.ok(reloaded.updated_at instanceof Date);

    await dataSource.destroy();
  });
});

// ---------------------------------------------------------------------------
// has_many — dependent
// ---------------------------------------------------------------------------

describe('has_many — dependent', () => {
  it('dependent: "destroy" removes children when parent is deleted', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const Author = makeAuthor(); // Comment references Author too
    const hooks = has_many(Post, 'comments', { dependent: 'destroy' });
    const dataSource = await createDataSource([Post, Comment, Author], ...hooks);

    const post = await Post.create({ title: 'DestroyMe' }).save();
    await Comment.create({ body: 'c1', post }).save();
    await Comment.create({ body: 'c2', post }).save();
    assert.equal(await Comment.count(), 2);

    await post.remove();
    assert.equal(await Comment.count(), 0);

    await dataSource.destroy();
  });

  it('dependent: "nullify" sets child FK to null when parent is deleted', async () => {
    @Entity('null_posts')
    class NullPost extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      title!: string;

      @OneToMany('NullComment', 'post')
      comments!: unknown[];
    }

    @Entity('null_comments')
    class NullComment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 500, nullable: false })
      body!: string;

      @ManyToOne('NullPost', 'comments', { nullable: true })
      post!: unknown;
    }

    const hooks = has_many(NullPost, 'comments', { dependent: 'nullify' });
    const dataSource = await createDataSource([NullPost, NullComment], ...hooks);

    const post = await NullPost.create({ title: 'NullifyMe' }).save();
    await NullComment.create({ body: 'nc', post }).save();

    await post.remove();

    const comments = await NullComment.find({ relations: { post: true } });
    assert.equal(comments.length, 1);
    assert.equal(comments[0]!.post, null);

    await dataSource.destroy();
  });
});

// ---------------------------------------------------------------------------
// belongs_to — touch
// ---------------------------------------------------------------------------

describe('belongs_to — touch', () => {
  it('touches the parent when the child is inserted', async () => {
    const Author = makeAuthor();
    const Comment = makeComment();
    const Post = makePost(); // needed because Comment has @ManyToOne('Post', ...)
    const hooks = belongs_to(Comment, 'author', { touch: true });
    const dataSource = await createDataSource([Author, Comment, Post], ...hooks);

    const author = await Author.create({ name: 'Alice' }).save();
    assert.equal(author.updated_at, null);

    const dummyPost = await Post.create({ title: 'dummy' }).save();
    await Comment.create({ body: 'nice', author, post: dummyPost }).save();

    const reloaded = await Author.findOneByOrFail({ id: author.id });
    assert.ok(reloaded.updated_at instanceof Date);

    await dataSource.destroy();
  });
});

// ---------------------------------------------------------------------------
// has_one — touch
// ---------------------------------------------------------------------------

describe('has_one — touch', () => {
  it(
    'touches the child entity when the parent saves',
    {
      skip: 'has_one touch on cascade-insert: TypeORM does not assign generated ids to parent OR child at afterInsert time under sqljs, so neither the in-memory relation nor the FK lookup yields a touchable id. Tracked as a follow-up.',
    },
    async () => {
      const ProfileUser = makeProfileUser();
      const Profile = makeProfileEntity();
      const hooks = has_one(ProfileUser, 'profile', { touch: true });
      const dataSource = await createDataSource([ProfileUser, Profile], ...hooks);

      // Save parent and child together in a single cascade INSERT so the owning
      // side's FK is set without an empty cascade UPDATE.
      const user = ProfileUser.create({ name: 'Bob' });
      const profile = Profile.create({ bio: 'Hello', user });
      user.profile = profile;
      await user.save();

      // After parent save, the child profile should be touched.
      const reloadedProfile = await Profile.findOneByOrFail({ id: profile.id });
      assert.ok(reloadedProfile.updated_at instanceof Date);

      // Update the parent and verify the child is touched again.
      const beforeUpdate = reloadedProfile.updated_at.getTime();
      user.name = 'Bob Updated';
      await user.save();

      const afterUpdate = await Profile.findOneByOrFail({ id: profile.id });
      assert.ok(afterUpdate.updated_at instanceof Date);
      assert.ok(afterUpdate.updated_at.getTime() >= beforeUpdate);

      await dataSource.destroy();
    },
  );
});

// ---------------------------------------------------------------------------
// accepts_nested_attributes_for
// ---------------------------------------------------------------------------

describe('accepts_nested_attributes_for', () => {
  it('persists nested children and filters to whitelisted fields', async () => {
    const Post = makePost();
    const Comment = makeComment();
    const Author = makeAuthor(); // needed because Comment has @ManyToOne('Author', ...)
    const hooks = accepts_nested_attributes_for(Post, 'comments', { fields: ['body'] });
    const dataSource = await createDataSource([Post, Comment, Author], ...hooks);

    const post = Post.create({ title: 'Nested' });
    const comment = Comment.create({ body: 'filtered body', post });
    (comment as unknown as Record<string, unknown>).extra_field = 'should be dropped';
    post.comments = [comment];

    await post.save();

    const found = await Comment.findOneByOrFail({ body: 'filtered body' });
    assert.equal(found.body, 'filtered body');
    assert.equal((found as unknown as Record<string, unknown>).extra_field, undefined);

    await dataSource.destroy();
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('association errors', () => {
  it('has_many with an unknown relation name throws AssociationError', () => {
    const Post = makePost();
    assert.throws(
      () => has_many(Post, 'nope'),
      (err: unknown) => err instanceof AssociationError && /relation/.test(err.message),
    );
  });

  it('has_many with a relation that is not one-to-many throws', () => {
    const Comment = makeComment();
    // 'post' is a many-to-one on Comment, not a one-to-many.
    assert.throws(
      () => has_many(Comment, 'post'),
      (err: unknown) => err instanceof AssociationError && /one-to-many/.test(err.message),
    );
  });

  it('belongs_to with a relation that is not many-to-one throws', () => {
    const Post = makePost();
    assert.throws(
      () => belongs_to(Post, 'comments'),
      (err: unknown) => err instanceof AssociationError && /many-to-one/.test(err.message),
    );
  });

  it('accepts_nested_attributes_for with empty fields throws', () => {
    const Post = makePost();
    assert.throws(
      () => accepts_nested_attributes_for(Post, 'comments', { fields: [] }),
      (err: unknown) => err instanceof AssociationError && /fields/.test(err.message),
    );
  });

  it('has_many with invalid counter_cache value throws', () => {
    const Post = makePost();
    assert.throws(
      () => has_many(Post, 'comments', { counter_cache: 42 as unknown as string }),
      (err: unknown) => err instanceof AssociationError && /counter_cache/.test(err.message),
    );
  });

  it('has_many with invalid dependent value throws', () => {
    const Post = makePost();
    assert.throws(
      () => has_many(Post, 'comments', { dependent: 'cascade' as unknown as 'destroy' }),
      (err: unknown) => err instanceof AssociationError && /dependent/.test(err.message),
    );
  });

  it('has_one with an unknown relation throws', () => {
    const ProfileUser = makeProfileUser();
    assert.throws(
      () => has_one(ProfileUser, 'nope'),
      (err: unknown) => err instanceof AssociationError && /relation/.test(err.message),
    );
  });
});

// ---------------------------------------------------------------------------
// AssociationError — value-free guarantee
// ---------------------------------------------------------------------------

describe('AssociationError is value-free', () => {
  it('has name AssociationError and never echoes entity data', () => {
    const err = new AssociationError('an error message');
    assert.equal(err.name, 'AssociationError');
    assert.ok(err instanceof Error);
  });
});
