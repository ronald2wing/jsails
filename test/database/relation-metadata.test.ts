/**
 * Tests for the relation-metadata resolver: pure, connectionless resolution
 * of TypeORM relation decorators and polymorphic descriptors.
 *
 * Every test defines fresh entity classes inside the test block so there is
 * no cross-test contamination. Polymorphic tests call
 * {@link clearPolymorphicRegistry} in {@link afterEach} because that registry
 * is module-scoped.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  BaseEntity,
  Column,
  Entity,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { clearPolymorphicRegistry, PolymorphicRelation } from '../../src/database/polymorphic.js';
import {
  resolveRelation,
  resolveRelationPath,
  MAX_NESTING_DEPTH,
  RelationError,
} from '../../src/database/relation-metadata.js';

// ---------------------------------------------------------------------------
// Many-to-one
// ---------------------------------------------------------------------------

describe('resolveRelation: many-to-one', () => {
  it('resolves a @ManyToOne with @JoinColumn to a descriptor', () => {
    @Entity()
    class Author extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      name!: string;
    }

    @Entity()
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => Author)
      @JoinColumn({ name: 'author_id' })
      author!: Author;
    }

    const result = resolveRelation(Post, 'author');

    assert.equal(result.propertyName, 'author');
    assert.equal(result.kind, 'many-to-one');
    assert.equal(result.targetEntity, Author);
    assert.equal(result.joinColumn, 'author_id');
    assert.deepEqual(result.primaryColumns, ['id']);
  });
});

// ---------------------------------------------------------------------------
// One-to-many (inverse)
// ---------------------------------------------------------------------------

describe('resolveRelation: one-to-many', () => {
  it('resolves an inverse @OneToMany to a descriptor', () => {
    // Author must be defined first because Post references it in the
    // `author` property type annotation (__metadata("design:type", Author)).
    @Entity()
    class Author extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @OneToMany(() => Post, (post) => post.author)
      posts!: Post[];
    }

    @Entity()
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      title!: string;

      @ManyToOne(() => Author)
      @JoinColumn({ name: 'author_id' })
      author!: Author;
    }

    const result = resolveRelation(Author, 'posts');

    assert.equal(result.propertyName, 'posts');
    assert.equal(result.kind, 'one-to-many');
    assert.equal(result.targetEntity, Post);
    assert.equal(result.inverseJoinColumn, 'author_id');
    assert.deepEqual(result.primaryColumns, ['id']);
  });
});

// ---------------------------------------------------------------------------
// One-to-one owning
// ---------------------------------------------------------------------------

describe('resolveRelation: one-to-one owning', () => {
  it('resolves an owning-side @OneToOne with @JoinColumn', () => {
    @Entity()
    class User extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity()
    class Profile extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @OneToOne(() => User)
      @JoinColumn({ name: 'user_id' })
      user!: User;
    }

    const result = resolveRelation(Profile, 'user');

    assert.equal(result.propertyName, 'user');
    assert.equal(result.kind, 'one-to-one');
    assert.equal(result.targetEntity, User);
    assert.equal(result.joinColumn, 'user_id');
    assert.deepEqual(result.primaryColumns, ['id']);
  });
});

// ---------------------------------------------------------------------------
// One-to-one inverse
// ---------------------------------------------------------------------------

describe('resolveRelation: one-to-one inverse', () => {
  it('resolves an inverse @OneToOne via the owning side FK', () => {
    // Circular type annotations cause TDZ; define the target (owning) entity
    // first without typed property annotation, then the entity under test.
    @Entity()
    class User extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @OneToOne(() => Profile, (profile) => profile.user)
      // Type annotation elided to avoid TDZ on the circular reference.
      profile: any;
    }

    @Entity()
    class Profile extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @OneToOne(() => User)
      @JoinColumn({ name: 'user_id' })
      user!: User;
    }

    const result = resolveRelation(User, 'profile');

    assert.equal(result.propertyName, 'profile');
    assert.equal(result.kind, 'one-to-one');
    assert.equal(result.targetEntity, Profile);
    // The join column lives on Profile (the owning side), so the descriptor
    // surfaces it as joinColumn on the resolved result.
    assert.equal(result.joinColumn, 'user_id');
    assert.deepEqual(result.primaryColumns, ['id']);
  });
});

// ---------------------------------------------------------------------------
// Many-to-many via @JoinTable (owning + inverse)
// ---------------------------------------------------------------------------

describe('resolveRelation: many-to-many @JoinTable', () => {
  it('resolves owning-side @ManyToMany with @JoinTable', () => {
    @Entity()
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToMany(() => Tag, (tag) => tag.posts)
      tags!: Tag[];
    }

    @Entity()
    class Tag extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToMany(() => Post, (post) => post.tags)
      @JoinTable({
        name: 'post_tags',
        joinColumn: { name: 'tag_id' },
        inverseJoinColumn: { name: 'post_id' },
      })
      posts!: Post[];
    }

    // Owning side: Tag.posts
    const owning = resolveRelation(Tag, 'posts');
    assert.equal(owning.propertyName, 'posts');
    assert.equal(owning.kind, 'many-to-many');
    assert.equal(owning.targetEntity, Post);
    assert.ok(owning.junction);
    assert.equal(owning.junction.table, 'post_tags');
    assert.equal(owning.junction.ownerColumn, 'tag_id');
    assert.equal(owning.junction.inverseColumn, 'post_id');
    assert.deepEqual(owning.primaryColumns, ['id']);

    // Inverse side: Post.tags
    const inverse = resolveRelation(Post, 'tags');
    assert.equal(inverse.propertyName, 'tags');
    assert.equal(inverse.kind, 'many-to-many');
    assert.equal(inverse.targetEntity, Tag);
    assert.ok(inverse.junction);
    assert.equal(inverse.junction.table, 'post_tags');
    // On the inverse side, owner = the FK pointing back to Post,
    // inverse = the FK pointing to Tag.
    assert.equal(inverse.junction.ownerColumn, 'post_id');
    assert.equal(inverse.junction.inverseColumn, 'tag_id');
    assert.deepEqual(inverse.primaryColumns, ['id']);
  });
});

// ---------------------------------------------------------------------------
// Many-to-many via explicit junction entity
// ---------------------------------------------------------------------------

describe('resolveRelation: many-to-many explicit junction', () => {
  it('resolves a @ManyToMany where the junction entity has explicit relations', () => {
    @Entity()
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToMany(() => Tag, (tag) => tag.posts)
      tags!: Tag[];
    }

    @Entity()
    class Tag extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToMany(() => Post, (post) => post.tags)
      @JoinTable({
        name: 'tag_post_map',
        joinColumn: { name: 'tag_id' },
        inverseJoinColumn: { name: 'post_id' },
      })
      posts!: Post[];
    }

    const result = resolveRelation(Tag, 'posts');
    assert.equal(result.kind, 'many-to-many');
    assert.ok(result.junction);
    assert.equal(result.junction.table, 'tag_post_map');
    assert.equal(result.junction.ownerColumn, 'tag_id');
    assert.equal(result.junction.inverseColumn, 'post_id');
  });
});

// ---------------------------------------------------------------------------
// Polymorphic
// ---------------------------------------------------------------------------

describe('resolveRelation: polymorphic', () => {
  afterEach(() => {
    clearPolymorphicRegistry();
  });

  it('resolves a @PolymorphicRelation property', () => {
    @Entity()
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity()
    class Comment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @PolymorphicRelation({ targets: [Post], relatedName: 'comments' })
      target!: unknown;
    }

    const result = resolveRelation(Comment, 'target');

    assert.equal(result.propertyName, 'target');
    assert.equal(result.kind, 'polymorphic');
    assert.equal(result.targetEntity, Post);
    assert.ok(result.polymorphic);
    assert.equal(result.polymorphic.typeColumn, 'target_type');
    assert.equal(result.polymorphic.idColumn, 'target_id');
    assert.deepEqual(result.primaryColumns, ['id']);
  });

  it('falls back to polymorphic when no TypeORM relation arg exists', () => {
    @Entity()
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity()
    class Comment extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      // No @ManyToOne — only the polymorphic decorator.
      @PolymorphicRelation({ targets: [Post], relatedName: 'comments' })
      target!: unknown;
    }

    const result = resolveRelation(Comment, 'target');
    assert.equal(result.kind, 'polymorphic');
  });
});

// ---------------------------------------------------------------------------
// Composite primary keys
// ---------------------------------------------------------------------------

describe('resolveRelation: composite primary keys', () => {
  it('lists all PK property names in order', () => {
    @Entity()
    class Org extends BaseEntity {
      @PrimaryColumn()
      tenantId!: number;

      @PrimaryColumn()
      orgId!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      name!: string;
    }

    @Entity()
    class Member extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => Org)
      @JoinColumn([
        { name: 'tenant_id', referencedColumnName: 'tenantId' },
        { name: 'org_id', referencedColumnName: 'orgId' },
      ])
      org!: Org;
    }

    const result = resolveRelation(Member, 'org');
    assert.equal(result.kind, 'many-to-one');
    assert.equal(result.targetEntity, Org);
    assert.deepEqual(result.primaryColumns, ['tenantId', 'orgId']);
  });
});

// ---------------------------------------------------------------------------
// resolveRelationPath: multi-hop resolution
// ---------------------------------------------------------------------------

describe('resolveRelationPath', () => {
  it('resolves a two-hop path via single-segment resolution', () => {
    @Entity()
    class City extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity()
    class Author extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => City)
      @JoinColumn({ name: 'city_id' })
      city!: City;
    }

    @Entity()
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => Author)
      @JoinColumn({ name: 'author_id' })
      author!: Author;
    }

    const results = resolveRelationPath(Post, 'author.city');

    assert.equal(results.length, 2);
    assert.equal(results[0]!.propertyName, 'author');
    assert.equal(results[0]!.kind, 'many-to-one');
    assert.equal(results[0]!.targetEntity, Author);
    assert.equal(results[1]!.propertyName, 'city');
    assert.equal(results[1]!.kind, 'many-to-one');
    assert.equal(results[1]!.targetEntity, City);
  });

  it('resolves a three-hop path', () => {
    @Entity()
    class Country extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity()
    class City extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => Country)
      @JoinColumn({ name: 'country_id' })
      country!: Country;
    }

    @Entity()
    class Author extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => City)
      @JoinColumn({ name: 'city_id' })
      city!: City;
    }

    @Entity()
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => Author)
      @JoinColumn({ name: 'author_id' })
      author!: Author;
    }

    const results = resolveRelationPath(Post, 'author.city.country');

    assert.equal(results.length, 3);
    assert.equal(results[0]!.targetEntity, Author);
    assert.equal(results[1]!.targetEntity, City);
    assert.equal(results[2]!.targetEntity, Country);
  });

  it('rejects an empty path', () => {
    @Entity()
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    assert.throws(() => resolveRelationPath(Post, ''), /must not be empty/);
  });

  it('rejects a path exceeding MAX_NESTING_DEPTH', () => {
    @Entity()
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    const deep = Array.from({ length: MAX_NESTING_DEPTH + 1 }, () => 'x').join('.');
    assert.throws(() => resolveRelationPath(Post, deep), /exceeds the maximum nesting depth/);
  });

  it('throws when an intermediate segment is not a relation', () => {
    @Entity()
    class Author extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      name!: string;
    }

    @Entity()
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => Author)
      @JoinColumn({ name: 'author_id' })
      author!: Author;
    }

    // author has no relation named 'nonexistent'
    assert.throws(() => resolveRelationPath(Post, 'author.nonexistent'), /No relation/);
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('resolveRelation: error cases', () => {
  it('throws RelationError for a property that is not a relation', () => {
    @Entity()
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      title!: string;
    }

    assert.throws(() => resolveRelation(Post, 'title'), /No relation/);
  });

  it('throws RelationError for a property not on the entity', () => {
    @Entity()
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    assert.throws(() => resolveRelation(Post, 'nonexistent'), /No relation/);
  });

  it('error message is value-free (no entity or property names)', () => {
    @Entity()
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    try {
      resolveRelation(Post, 'nonexistent');
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof RelationError);
      // The message must not leak the entity name or property name.
      assert.ok(!err.message.includes('Post'));
      assert.ok(!err.message.includes('nonexistent'));
    }
  });
});
