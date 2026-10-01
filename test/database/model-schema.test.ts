import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BaseEntity,
  Check,
  Column,
  DefaultNamingStrategy,
  Entity,
  EntitySchema,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  OneToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Unique,
  ViewColumn,
  ViewEntity,
} from 'typeorm';
import type { MixedList } from 'typeorm';
import { JsailsDataSource, type JsailsDataSourceOptions } from '../../src/database/data-source.js';
import { RESERVED_MIGRATIONS_TABLE } from '../../src/database/model-schema.js';
import { MigrationError, type SchemaState } from '../../src/migrations/schema-state.js';
import { generateMigration } from '../../src/migrations/autodetector.js';
import { replayMigrationHistory } from '../../src/migrations/history.js';

type AnyEntity = Function | string | EntitySchema<unknown>;

function postgresOptions(entities: MixedList<AnyEntity>): JsailsDataSourceOptions {
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

function mysqlOptions(entities: MixedList<AnyEntity>): JsailsDataSourceOptions {
  return {
    type: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    username: 'placeholder',
    password: 'placeholder',
    database: 'placeholder',
    entities,
    synchronize: false,
  };
}

async function buildSchema(options: JsailsDataSourceOptions): Promise<SchemaState> {
  return new JsailsDataSource(options).getModelSchema();
}

describe('getModelSchema: offline metadata build', () => {
  @Entity('users')
  class User extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 255, nullable: false })
    email!: string;

    @Column({ type: 'varchar', length: 100, default: 'guest', name: 'display_name' })
    displayName!: string;

    @Column({ type: 'text', nullable: true })
    bio!: string | null;

    @Column({ type: 'boolean', default: false })
    active!: boolean;

    @Column({ type: Date, nullable: true })
    createdAt!: Date | null;
  }

  const expected: SchemaState = {
    tables: [
      {
        name: 'users',
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'active', type: 'boolean', nullable: false, default: false },
          { name: 'bio', type: 'text', nullable: true },
          { name: 'createdAt', type: 'datetime', nullable: true },
          { name: 'display_name', type: 'varchar', length: 100, nullable: false, default: 'guest' },
          { name: 'email', type: 'varchar', length: 255, nullable: false },
        ],
      },
    ],
  };

  it('builds identical portable schema on postgres and mysql without connecting', async () => {
    const dataSource = new JsailsDataSource(postgresOptions([User]));
    const postgres = await dataSource.getModelSchema();

    // Building metadata must not open a connection.
    assert.equal(dataSource.isInitialized, false);

    const mysql = await buildSchema(mysqlOptions([User]));

    assert.deepEqual(postgres, expected);
    assert.deepEqual(mysql, expected);
  });

  it('honors a custom naming strategy for table names', async () => {
    class PrefixedNamingStrategy extends DefaultNamingStrategy {
      override tableName(targetName: string, userSpecifiedName: string | undefined): string {
        return `app_${super.tableName(targetName, userSpecifiedName)}`;
      }
    }

    const schema = await buildSchema({
      ...postgresOptions([User]),
      namingStrategy: new PrefixedNamingStrategy(),
    });
    assert.deepEqual(
      schema.tables.map((t) => t.name),
      ['app_users'],
    );
  });

  it('builds the same schema from an EntitySchema as from a decorated entity', async () => {
    @Entity('users')
    class MinimalUser extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 255, nullable: false })
      email!: string;
    }

    const schema = new EntitySchema({
      name: 'users',
      columns: {
        id: { type: Number, primary: true, generated: 'increment' },
        email: { type: 'varchar', length: 255, nullable: false },
      },
    });

    const decorated = await buildSchema(postgresOptions([MinimalUser]));
    const entitySchema = await buildSchema(postgresOptions([schema]));

    assert.deepEqual(decorated, {
      tables: [
        {
          name: 'users',
          columns: [
            { name: 'id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'email', type: 'varchar', length: 255, nullable: false },
          ],
        },
      ],
    });
    assert.deepEqual(entitySchema, decorated);
  });

  it('rejects the reserved jsails_migrations table name', async () => {
    @Entity(RESERVED_MIGRATIONS_TABLE)
    class Reserved extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    await assert.rejects(buildSchema(postgresOptions([Reserved])), /reserved table name/);
  });
});

describe('getModelSchema: model change drives a migration', () => {
  @Entity('users')
  class UserV1 extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 255, nullable: false })
    email!: string;
  }

  @Entity('users')
  class UserV2 extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 255, nullable: false })
    email!: string;

    @Column({ type: 'integer', nullable: true })
    age!: number | null;

    @Column({ type: 'text', nullable: true })
    bio!: string | null;
  }

  it('emits add_column ops against prior history and no-ops when unchanged', async () => {
    const initial = await buildSchema(postgresOptions([UserV1]));
    const changed = await buildSchema(postgresOptions([UserV2]));

    const createUsers = generateMigration('create_users', [], initial);
    assert.ok(createUsers);
    assert.equal(createUsers.operations[0]?.kind, 'create_table');

    const addColumns = generateMigration('add_age_bio', [createUsers], changed);
    assert.ok(addColumns);
    assert.deepEqual(addColumns.dependencies, ['create_users']);
    const kinds = addColumns.operations.map((op) => op.kind);
    assert.deepEqual(kinds, ['add_column', 'add_column']);
    const added = addColumns.operations.map((op) =>
      op.kind === 'add_column' ? op.column.name : undefined,
    );
    assert.deepEqual(added.sort(), ['age', 'bio']);

    // The generated chain replays back to the desired schema.
    assert.deepEqual(replayMigrationHistory([createUsers, addColumns]), changed);

    // No further change produces no migration.
    assert.equal(generateMigration('noop', [createUsers, addColumns], changed), null);
  });
});

describe('new scalar types: now accepted', () => {
  it('accepts decimal column with precision and scale', async () => {
    @Entity('decimal_items')
    class DecimalItem extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'decimal', precision: 10, scale: 2, nullable: false, default: 0 })
      price!: number;
    }

    const schema = await buildSchema(postgresOptions([DecimalItem]));
    const col = schema.tables[0]?.columns.find((c) => c.name === 'price');
    assert.ok(col);
    assert.equal(col.type, 'decimal');
    assert.equal(col.precision, 10);
    assert.equal(col.scale, 2);
    assert.equal(col.default, 0);
  });

  it('accepts float column', async () => {
    @Entity('float_items')
    class FloatItem extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'float', nullable: true })
      score!: number | null;
    }

    const schema = await buildSchema(postgresOptions([FloatItem]));
    const col = schema.tables[0]?.columns.find((c) => c.name === 'score');
    assert.ok(col);
    assert.equal(col.type, 'float');
  });

  it('accepts bigint column', async () => {
    @Entity('big_items')
    class BigItem extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'bigint', nullable: true })
      count!: string | null;
    }

    const schema = await buildSchema(postgresOptions([BigItem]));
    const col = schema.tables[0]?.columns.find((c) => c.name === 'count');
    assert.ok(col);
    assert.equal(col.type, 'bigint');
  });

  it('accepts uuid column', async () => {
    @Entity('uuid_items')
    class UuidItem extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'uuid', nullable: true })
      ref!: string | null;
    }

    const schema = await buildSchema(postgresOptions([UuidItem]));
    const col = schema.tables[0]?.columns.find((c) => c.name === 'ref');
    assert.ok(col);
    assert.equal(col.type, 'uuid');
  });

  it('accepts json column', async () => {
    @Entity('json_items')
    class JsonItem extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'json', nullable: true })
      meta!: object | null;
    }

    const schema = await buildSchema(postgresOptions([JsonItem]));
    const col = schema.tables[0]?.columns.find((c) => c.name === 'meta');
    assert.ok(col);
    assert.equal(col.type, 'json');
  });

  it('accepts date column', async () => {
    @Entity('dated_items')
    class DatedItem extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'date', nullable: true })
      releaseDate!: string | null;
    }

    const schema = await buildSchema(postgresOptions([DatedItem]));
    const col = schema.tables[0]?.columns.find((c) => c.name === 'releaseDate');
    assert.ok(col);
    assert.equal(col.type, 'date');
  });

  it('accepts time column', async () => {
    @Entity('timed_items')
    class TimedItem extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'time', nullable: true })
      opensAt!: string | null;
    }

    const schema = await buildSchema(postgresOptions([TimedItem]));
    const col = schema.tables[0]?.columns.find((c) => c.name === 'opensAt');
    assert.ok(col);
    assert.equal(col.type, 'time');
  });

  it('accepts numeric as a decimal alias', async () => {
    @Entity('numeric_items')
    class NumericItem extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'numeric', precision: 8, scale: 2, nullable: false })
      amount!: number;
    }

    const schema = await buildSchema(postgresOptions([NumericItem]));
    const col = schema.tables[0]?.columns.find((c) => c.name === 'amount');
    assert.ok(col);
    assert.equal(col.type, 'decimal');
    assert.equal(col.precision, 8);
    assert.equal(col.scale, 2);
  });

  it('accepts double precision as a float alias', async () => {
    @Entity('dbl_items')
    class DblItem extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'double precision', nullable: true })
      val!: number | null;
    }

    const schema = await buildSchema(postgresOptions([DblItem]));
    const col = schema.tables[0]?.columns.find((c) => c.name === 'val');
    assert.ok(col);
    assert.equal(col.type, 'float');
  });

  it('accepts jsonb as a json alias', async () => {
    @Entity('jsonb_items')
    class JsonbItem extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'jsonb', nullable: true })
      data!: object | null;
    }

    const schema = await buildSchema(postgresOptions([JsonbItem]));
    const col = schema.tables[0]?.columns.find((c) => c.name === 'data');
    assert.ok(col);
    assert.equal(col.type, 'json');
  });
});

describe('decimal precision change is destructive in autodetection', () => {
  it('drives an alter_column when decimal precision changes', async () => {
    @Entity('decimal_test')
    class DecimalV1 extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'decimal', precision: 10, scale: 2, nullable: false, default: 0 })
      price!: number;
    }

    const initial = await buildSchema(postgresOptions([DecimalV1]));

    @Entity('decimal_test')
    class DecimalV2 extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'decimal', precision: 12, scale: 2, nullable: false, default: 0 })
      price!: number;
    }

    const changed = await buildSchema(postgresOptions([DecimalV2]));

    const createTables = generateMigration('create_tables', [], initial);
    assert.ok(createTables);

    // Without allowDestructive, a precision change must throw.
    assert.throws(
      () => generateMigration('change_precision', [createTables], changed),
      /destructive change rejected.*decimal precision/,
    );

    // With allowDestructive, it emits an alter_column.
    const migration = generateMigration('change_precision', [createTables], changed, {
      allowDestructive: true,
    });
    assert.ok(migration);
    assert.equal(migration.operations[0]?.kind, 'alter_column');
    assert.deepEqual(replayMigrationHistory([createTables, migration]), changed);
  });
});

describe('unsupported features are rejected', () => {
  it('accepts composite primary keys', async () => {
    @Entity('composite')
    class Composite extends BaseEntity {
      @PrimaryColumn()
      a!: number;

      @PrimaryColumn()
      b!: number;
    }

    const schema = await buildSchema(postgresOptions([Composite]));
    const table = schema.tables[0];
    assert.ok(table);
    assert.equal(table.columns.length, 2);
    assert.ok(table.columns.every((c) => c.primaryKey && c.type === 'integer' && !c.nullable));
  });

  it('rejects partial (filtered) indexes', async () => {
    @Entity('partial_indexed')
    @Index(['email'], { where: '"email" IS NOT NULL' })
    class PartialIndexed extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 50 })
      email!: string;
    }

    await assert.rejects(buildSchema(postgresOptions([PartialIndexed])), /partial/);
  });

  it('accepts deferrable unique constraints', async () => {
    @Entity('deferrable_users')
    @Unique('UQ_deferrable_email', ['email'], { deferrable: 'INITIALLY DEFERRED' })
    class DeferrableUsers extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 50 })
      email!: string;
    }

    const schema = await buildSchema(postgresOptions([DeferrableUsers]));
    assert.equal(schema.tables[0]?.uniques?.length, 1);
    assert.deepEqual(schema.tables[0]?.uniques?.[0], {
      name: 'UQ_deferrable_email',
      columns: ['email'],
      deferrable: 'INITIALLY_DEFERRED',
    });
  });

  it('rejects expression-typed unique constraints', async () => {
    @Entity('expression_unique')
    @Unique((_object) => ['email'])
    class ExpressionUnique extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 50 })
      email!: string;
    }

    await assert.rejects(buildSchema(postgresOptions([ExpressionUnique])), /expression or ordered/);
  });

  it('rejects check constraints', async () => {
    @Entity('checked')
    @Check('"age" > 0')
    class Checked extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'integer', nullable: true })
      age!: number | null;
    }

    await assert.rejects(buildSchema(postgresOptions([Checked])), /check/);
  });

  it('rejects views', async () => {
    @ViewEntity({ expression: 'SELECT 1 AS id' })
    class DummyView extends BaseEntity {
      @ViewColumn()
      id!: number;
    }

    await assert.rejects(buildSchema(postgresOptions([DummyView])), /view/);
  });

  it('rejects generated UUID primary keys', async () => {
    @Entity('uuid_users')
    class UuidUser extends BaseEntity {
      @PrimaryGeneratedColumn('uuid')
      id!: string;
    }

    await assert.rejects(buildSchema(postgresOptions([UuidUser])), /UUID/);
  });

  it('rejects custom value transformers', async () => {
    class UpperTransformer {
      to(value: string): string {
        return value;
      }
      from(value: string): string {
        return value;
      }
    }

    @Entity('transformed')
    class Transformed extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 50, transformer: new UpperTransformer() })
      value!: string;
    }

    await assert.rejects(buildSchema(postgresOptions([Transformed])), /transformer/);
  });

  it('rejects custom schema qualification', async () => {
    @Entity({ name: 'events', schema: 'analytics' })
    class Events extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    await assert.rejects(buildSchema(postgresOptions([Events])), /schema/);
  });

  it('rejects raw-function defaults', async () => {
    @Entity('fn_default')
    class FnDefault extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: Date, default: () => 'CURRENT_TIMESTAMP' })
      created!: Date;
    }

    await assert.rejects(buildSchema(postgresOptions([FnDefault])), /function default/);
  });

  it('rejects computed (generated) columns', async () => {
    @Entity('computed')
    class Computed extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'integer', asExpression: 'id + 1', generatedType: 'STORED', nullable: true })
      nextId!: number | null;
    }

    await assert.rejects(buildSchema(postgresOptions([Computed])), /computed/);
  });

  it('rejects a lossy column type such as an array column', async () => {
    @Entity('arr')
    class Arr extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'simple-array', nullable: true })
      tags!: string[] | null;
    }

    await assert.rejects(buildSchema(postgresOptions([Arr])), /unsupported/);
  });

  it('rejects varchar columns without an explicit length', async () => {
    @Entity('unbounded')
    class Unbounded extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      name!: string;
    }

    await assert.rejects(buildSchema(postgresOptions([Unbounded])), /explicit positive "length"/);
  });

  it('rejects an explicit null default while a defaultless column stays absent', async () => {
    @Entity('null_default')
    class NullDefault extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 10, default: null })
      name!: string;

      @Column({ type: 'varchar', length: 10, nullable: true })
      bio!: string | null;
    }

    await assert.rejects(buildSchema(postgresOptions([NullDefault])), /explicit null default/);
  });
});

describe('getModelSchema: indexes and unique constraints', () => {
  it('converts @Column({ unique: true }) into a unique constraint', async () => {
    @Entity('unique_users')
    class UniqueUser extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 50, unique: true })
      email!: string;
    }

    const schema = await buildSchema(postgresOptions([UniqueUser]));
    assert.equal(schema.tables[0]?.uniques?.length, 1);
    assert.deepEqual(schema.tables[0]?.uniques?.[0]?.columns, ['email']);
  });

  it('converts @Index into a non-unique index', async () => {
    @Entity('indexed')
    @Index(['email'])
    class Indexed extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 50 })
      email!: string;
    }

    const schema = await buildSchema(postgresOptions([Indexed]));
    assert.equal(schema.tables[0]?.indexes?.length, 1);
    assert.deepEqual(schema.tables[0]?.indexes?.[0]?.columns, ['email']);
    assert.equal(schema.tables[0]?.indexes?.[0]?.unique, false);
  });

  it('converts a unique index', async () => {
    @Entity('uniquely_indexed')
    @Index(['email'], { unique: true })
    class UniquelyIndexed extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 50 })
      email!: string;
    }

    const schema = await buildSchema(postgresOptions([UniquelyIndexed]));
    assert.equal(schema.tables[0]?.indexes?.length, 1);
    assert.equal(schema.tables[0]?.indexes?.[0]?.unique, true);
  });

  it('converts a composite @Unique constraint', async () => {
    @Entity('composite_unique')
    @Unique(['tenant', 'slug'])
    class CompositeUnique extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 50 })
      tenant!: string;

      @Column({ type: 'varchar', length: 50 })
      slug!: string;
    }

    const schema = await buildSchema(postgresOptions([CompositeUnique]));
    assert.equal(schema.tables[0]?.uniques?.length, 1);
    assert.deepEqual(schema.tables[0]?.uniques?.[0]?.columns, ['tenant', 'slug']);
  });

  it('builds indexes and uniques from an EntitySchema', async () => {
    const schema = new EntitySchema({
      name: 'users',
      columns: {
        id: { type: Number, primary: true, generated: 'increment' },
        email: { type: 'varchar', length: 255, nullable: false },
        tenant: { type: 'varchar', length: 50, nullable: false },
      },
      indices: [{ name: 'IDX_users_email', columns: ['email'] }],
      uniques: [{ name: 'UQ_users_tenant', columns: ['tenant'] }],
    });

    const built = await buildSchema(postgresOptions([schema]));
    assert.deepEqual(
      built.tables[0]?.indexes?.map((i) => ({
        name: i.name,
        columns: i.columns,
        unique: i.unique,
      })),
      [{ name: 'IDX_users_email', columns: ['email'], unique: false }],
    );
    assert.deepEqual(
      built.tables[0]?.uniques?.map((u) => ({ name: u.name, columns: u.columns })),
      [{ name: 'UQ_users_tenant', columns: ['tenant'] }],
    );
  });
});

describe('getModelSchema: foreign keys', () => {
  @Entity('authors')
  class Author extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;
  }

  it('converts a many-to-one into a single-column foreign key with onDelete', async () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => Author, { onDelete: 'CASCADE', onUpdate: 'NO ACTION' })
      @JoinColumn({ name: 'author_id', foreignKeyConstraintName: 'FK_posts_author' })
      author!: Author;
    }

    const schema = await buildSchema(postgresOptions([Author, Post]));
    const posts = schema.tables.find((t) => t.name === 'posts');
    assert.ok(posts);
    assert.deepEqual(posts.foreignKeys, [
      {
        name: 'FK_posts_author',
        columns: ['author_id'],
        referencedTable: 'authors',
        referencedColumns: ['id'],
        onDelete: 'cascade',
        onUpdate: 'noAction',
      },
    ]);
    const authorId = posts.columns.find((c) => c.name === 'author_id');
    assert.ok(authorId);
    assert.equal(authorId.type, 'integer');
  });

  it('drives an add_fk migration from a many-to-one change', async () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    const initial = await buildSchema(postgresOptions([Author, Post]));

    @Entity('posts')
    class PostWithAuthor extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => Author)
      @JoinColumn({ name: 'author_id', foreignKeyConstraintName: 'FK_posts_author' })
      author!: Author;
    }

    const changed = await buildSchema(postgresOptions([Author, PostWithAuthor]));

    const createTables = generateMigration('create_tables', [], initial);
    assert.ok(createTables);

    const addFk = generateMigration('add_fk', [createTables], changed);
    assert.ok(addFk);
    assert.deepEqual(
      addFk.operations.map((op) => op.kind),
      ['add_column', 'add_fk'],
    );
    assert.deepEqual(replayMigrationHistory([createTables, addFk]), changed);
  });

  it('converts an explicit junction table into columns and two foreign keys', async () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity('tags')
    class Tag extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity('post_tags')
    class PostTag extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => Post, { onDelete: 'CASCADE' })
      @JoinColumn({ name: 'post_id', foreignKeyConstraintName: 'FK_post_tags_post' })
      post!: Post;

      @ManyToOne(() => Tag, { onDelete: 'CASCADE' })
      @JoinColumn({ name: 'tag_id', foreignKeyConstraintName: 'FK_post_tags_tag' })
      tag!: Tag;
    }

    const schema = await buildSchema(postgresOptions([Post, Tag, PostTag]));

    const posts = schema.tables.find((t) => t.name === 'posts');
    const tags = schema.tables.find((t) => t.name === 'tags');
    const junction = schema.tables.find((t) => t.name === 'post_tags');
    assert.ok(posts);
    assert.ok(tags);
    assert.ok(junction);

    assert.deepEqual(junction.columns.map((c) => c.name).sort(), ['id', 'post_id', 'tag_id']);
    const postFk = junction.foreignKeys?.find((fk) => fk.referencedTable === 'posts');
    assert.ok(postFk);
    assert.deepEqual(postFk.columns, ['post_id']);
    assert.equal(postFk.onDelete, 'cascade');

    const tagFk = junction.foreignKeys?.find((fk) => fk.referencedTable === 'tags');
    assert.ok(tagFk);
    assert.deepEqual(tagFk.columns, ['tag_id']);
    assert.equal(tagFk.onDelete, 'cascade');
  });

  it('produces auto-generated @JoinTable junction table with composite PK + two FKs', async () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToMany(() => Tag, (tag) => tag.posts)
      tags!: Tag[];
    }

    @Entity('tags')
    class Tag extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToMany(() => Post, (post) => post.tags)
      @JoinTable()
      posts!: Post[];
    }

    const schema = await buildSchema(postgresOptions([Post, Tag]));
    // Expect three tables: posts, tags, and an auto-generated junction table
    // with a composite primary key (postId + tagId) and two foreign keys.
    // TypeORM auto-names @JoinTable junction tables; the name varies by driver
    // so we check that there IS a junction table with the expected shape.
    const junctionTable = schema.tables.find((t) => t.name !== 'posts' && t.name !== 'tags');
    assert.ok(junctionTable, 'expected a junction table beyond posts and tags');
    // Composite PK: both join columns should be primary key.
    const pkCols = junctionTable.columns.filter((c) => c.primaryKey);
    assert.equal(pkCols.length, 2);
    // Two foreign keys referencing posts and tags.
    assert.equal(junctionTable.foreignKeys?.length, 2);
    const fkTables = junctionTable.foreignKeys?.map((fk) => fk.referencedTable).sort() ?? [];
    assert.ok(fkTables.includes('posts'));
    assert.ok(fkTables.includes('tags'));
  });

  it('converts an owning-side one-to-one into a foreign key + synthesized unique constraint', async () => {
    @Entity('profiles')
    class Profile extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @OneToOne(() => Author, { onDelete: 'CASCADE' })
      @JoinColumn({ name: 'author_id', foreignKeyConstraintName: 'FK_profiles_author' })
      author!: Author;
    }

    const schema = await buildSchema(postgresOptions([Author, Profile]));
    const profiles = schema.tables.find((t) => t.name === 'profiles');
    assert.ok(profiles);

    // Foreign key is emitted by TypeORM and picked up by convertForeignKeys.
    assert.deepEqual(profiles.foreignKeys, [
      {
        name: 'FK_profiles_author',
        columns: ['author_id'],
        referencedTable: 'authors',
        referencedColumns: ['id'],
        onDelete: 'cascade',
        onUpdate: 'noAction',
      },
    ]);

    // Unique constraint over the join column — TypeORM auto-generates a
    // REL_<hash> unique for one-to-one join columns. JSails' synthesis
    // detects this and skips creating a duplicate.
    assert.equal(profiles.uniques?.length, 1);
    assert.deepEqual(profiles.uniques?.[0]?.columns, ['author_id']);

    // Join column is nullable by default (TypeORM one-to-one default).
    const authorId = profiles.columns.find((c) => c.name === 'author_id');
    assert.ok(authorId);
    assert.equal(authorId.type, 'integer');
    assert.equal(authorId.nullable, true);
  });

  it('the side without @JoinColumn (inverse) contributes no FK and no unique', async () => {
    // SimpleAuthor is defined first so Profile's decorator can safely
    // reference it — JavaScript does not hoist class declarations.
    @Entity('authors')
    class SimpleAuthor extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity('profiles')
    class Profile extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @OneToOne(() => SimpleAuthor)
      @JoinColumn({ name: 'author_id' })
      author!: SimpleAuthor;
    }

    const schema = await buildSchema(postgresOptions([SimpleAuthor, Profile]));
    const authors = schema.tables.find((t) => t.name === 'authors');
    assert.ok(authors);
    // SimpleAuthor has no @OneToOne of its own — it is the target, not the
    // owning side. The inverse side produces no FK and no unique constraint.
    assert.equal(authors.foreignKeys, undefined);
    assert.equal(authors.uniques, undefined);
  });

  it('does not duplicate the unique that TypeORM already emits for a one-to-one', async () => {
    // TypeORM auto-generates a REL_<hash> unique constraint on the join
    // column when building metadata for an owning-side one-to-one. The
    // synthesis detects this and must not create a second unique. This is
    // verified indirectly: the owning-side test above already asserts
    // profiles.uniques has exactly one entry.
    @Entity('profiles')
    class Profile extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @OneToOne(() => Author)
      @JoinColumn({ name: 'author_id' })
      author!: Author;
    }

    const schema = await buildSchema(postgresOptions([Author, Profile]));
    const profiles = schema.tables.find((t) => t.name === 'profiles');
    assert.ok(profiles);
    // TypeORM emits exactly one unique for the one-to-one join column;
    // the synthesis does not add a duplicate.
    assert.equal(profiles.uniques?.length, 1);
    assert.deepEqual(profiles.uniques?.[0]?.columns, ['author_id']);
  });

  it('preserves a required (non-nullable) one-to-one join column', async () => {
    @Entity('profiles')
    class Profile extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @OneToOne(() => Author, { nullable: false })
      @JoinColumn({ name: 'author_id', foreignKeyConstraintName: 'FK_profiles_author' })
      author!: Author;
    }

    const schema = await buildSchema(postgresOptions([Author, Profile]));
    const profiles = schema.tables.find((t) => t.name === 'profiles');
    assert.ok(profiles);
    const authorId = profiles.columns.find((c) => c.name === 'author_id');
    assert.ok(authorId);
    assert.equal(authorId.nullable, false);
  });

  it('round-trips through normalizeSchemaState without error', async () => {
    @Entity('profiles')
    class Profile extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @OneToOne(() => Author)
      @JoinColumn({ name: 'author_id', foreignKeyConstraintName: 'FK_profiles_author' })
      author!: Author;
    }

    const schema = await buildSchema(postgresOptions([Author, Profile]));
    // Import normalizeSchemaState and verify it does not throw.
    const { normalizeSchemaState } = await import('../../src/migrations/schema-state.js');
    const normalized = normalizeSchemaState(schema);
    assert.ok(normalized);
    const profiles = normalized.tables.find((t) => t.name === 'profiles');
    assert.ok(profiles);
    assert.ok(profiles.uniques);
    assert.ok(profiles.foreignKeys);
  });

  it('drives a migration when a one-to-one is added', async () => {
    @Entity('profiles')
    class Profile extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    const initial = await buildSchema(postgresOptions([Author, Profile]));

    @Entity('profiles')
    class ProfileWithOneToOne extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @OneToOne(() => Author, { onDelete: 'CASCADE' })
      @JoinColumn({ name: 'author_id', foreignKeyConstraintName: 'FK_profiles_author' })
      author!: Author;
    }

    const changed = await buildSchema(postgresOptions([Author, ProfileWithOneToOne]));

    const createTables = generateMigration('create_tables', [], initial);
    assert.ok(createTables);

    const addOneToOne = generateMigration('add_one_to_one', [createTables], changed);
    assert.ok(addOneToOne);
    // Expected operations: add_column (authorId), add_unique, add_fk.
    // The unique is synthesized in convertEntity before convertForeignKeys runs,
    // so the table definition lists uniques ahead of foreign keys.
    const kinds = addOneToOne.operations.map((op) => op.kind);
    assert.deepEqual(kinds, ['add_column', 'add_unique', 'add_fk']);
    assert.deepEqual(replayMigrationHistory([createTables, addOneToOne]), changed);
  });

  it('accepts deferrable foreign keys', async () => {
    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => Author, { deferrable: 'INITIALLY DEFERRED' })
      @JoinColumn({ name: 'author_id', foreignKeyConstraintName: 'FK_posts_author' })
      author!: Author;
    }

    const schema = await buildSchema(postgresOptions([Author, Post]));
    const posts = schema.tables.find((t) => t.name === 'posts');
    assert.ok(posts);
    assert.deepEqual(posts.foreignKeys?.[0]?.deferrable, 'INITIALLY_DEFERRED');
  });

  it('converts composite foreign keys from multiple @JoinColumn directives', async () => {
    @Entity('authors')
    class MultiKeyAuthor extends BaseEntity {
      @PrimaryColumn()
      tenant_id!: number;

      @PrimaryColumn()
      user_id!: number;
    }

    @Entity('posts')
    class MultiKeyPost extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => MultiKeyAuthor, { onDelete: 'RESTRICT' })
      @JoinColumn([
        { name: 'author_tenant', referencedColumnName: 'tenant_id' },
        { name: 'author_user', referencedColumnName: 'user_id' },
      ])
      author!: MultiKeyAuthor;
    }

    const schema = await buildSchema(postgresOptions([MultiKeyAuthor, MultiKeyPost]));
    const posts = schema.tables.find((t) => t.name === 'posts');
    assert.ok(posts);
    assert.equal(posts.foreignKeys?.length, 1);
    assert.deepEqual(posts.foreignKeys?.[0]?.columns, ['author_tenant', 'author_user']);
    assert.deepEqual(posts.foreignKeys?.[0]?.referencedColumns, ['tenant_id', 'user_id']);
    assert.equal(posts.foreignKeys?.[0]?.onDelete, 'restrict');
  });

  it('drives create_table + add_fk migration for composite foreign key', async () => {
    @Entity('authors')
    class KeyAuthor extends BaseEntity {
      @PrimaryColumn()
      tenant_id!: number;

      @PrimaryColumn()
      user_id!: number;
    }

    // Schema without FK
    @Entity('posts')
    class PostNoFk extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      // TypeORM @ManyToOne join columns are nullable by default; match that.
      @Column({ type: 'integer', nullable: true })
      author_tenant!: number;

      @Column({ type: 'integer', nullable: true })
      author_user!: number;
    }

    const initial = await buildSchema(postgresOptions([KeyAuthor, PostNoFk]));

    // Schema with composite FK
    @Entity('posts')
    class PostWithFk extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => KeyAuthor)
      @JoinColumn([
        { name: 'author_tenant', referencedColumnName: 'tenant_id' },
        { name: 'author_user', referencedColumnName: 'user_id' },
      ])
      author!: KeyAuthor;
    }

    const changed = await buildSchema(postgresOptions([KeyAuthor, PostWithFk]));

    const createTables = generateMigration('create_tables', [], initial);
    assert.ok(createTables);

    const addFk = generateMigration('add_composite_fk', [createTables], changed);
    assert.ok(addFk);
    assert.deepEqual(
      addFk.operations.map((op) => op.kind),
      ['add_fk'],
    );

    if (addFk.operations[0]?.kind === 'add_fk') {
      assert.deepEqual(addFk.operations[0].foreignKey.columns, ['author_tenant', 'author_user']);
      assert.deepEqual(addFk.operations[0].foreignKey.referencedColumns, ['tenant_id', 'user_id']);
    }

    assert.deepEqual(replayMigrationHistory([createTables, addFk]), changed);
  });
});

describe('getModelSchema: multi-table inheritance (MTI)', () => {
  @Entity('animals')
  class Animal extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100, nullable: false })
    name!: string;

    @Column({ type: 'integer', nullable: true })
    age!: number | null;
  }

  @Entity('dogs')
  class Dog extends BaseEntity {
    @PrimaryColumn()
    id!: number;

    @OneToOne(() => Animal)
    @JoinColumn({ name: 'id', foreignKeyConstraintName: 'FK_dogs_animal' })
    animal!: Animal;

    @Column({ type: 'varchar', length: 50, nullable: true })
    breed!: string | null;
  }

  it('converts parent + child into two tables with no column duplication', async () => {
    const schema = await buildSchema(postgresOptions([Animal, Dog]));
    assert.equal(schema.tables.length, 2);

    const animals = schema.tables.find((t) => t.name === 'animals');
    const dogs = schema.tables.find((t) => t.name === 'dogs');
    assert.ok(animals);
    assert.ok(dogs);

    // Parent table is unaffected.
    assert.deepEqual(animals.columns.map((c) => c.name).sort(), ['age', 'id', 'name']);
    assert.equal(animals.foreignKeys, undefined);

    // Child table has only its own columns plus the shared PK.
    assert.deepEqual(dogs.columns.map((c) => c.name).sort(), ['breed', 'id']);
    // The PK column is NOT auto-generated — it inherits its value from the parent.
    const pk = dogs.columns.find((c) => c.name === 'id');
    assert.ok(pk);
    assert.equal(pk.primaryKey, true);
    assert.equal(pk.type, 'integer');
    assert.equal(pk.nullable, false);

    // Child does NOT duplicate non-PK parent columns.
    assert.equal(
      dogs.columns.find((c) => c.name === 'name'),
      undefined,
    );
    assert.equal(
      dogs.columns.find((c) => c.name === 'age'),
      undefined,
    );
  });

  it('child table has a foreign key to the parent on the shared PK column', async () => {
    const schema = await buildSchema(postgresOptions([Animal, Dog]));
    const dogs = schema.tables.find((t) => t.name === 'dogs');
    assert.ok(dogs);
    assert.equal(dogs.foreignKeys?.length, 1);
    assert.deepEqual(dogs.foreignKeys?.[0], {
      name: 'FK_dogs_animal',
      columns: ['id'],
      referencedTable: 'animals',
      referencedColumns: ['id'],
      onDelete: 'noAction',
      onUpdate: 'noAction',
    });
  });

  it('does not synthesize a redundant unique for the MTI PK (PK enforces uniqueness)', async () => {
    const schema = await buildSchema(postgresOptions([Animal, Dog]));
    const dogs = schema.tables.find((t) => t.name === 'dogs');
    assert.ok(dogs);
    // No unique constraint — the PK itself guarantees uniqueness for the join
    // column.  Neither TypeORM nor our synthesis emits a separate unique.
    assert.equal(dogs.uniques?.length, undefined);
  });

  it('schema state round-trips through normalizeSchemaState', async () => {
    const schema = await buildSchema(postgresOptions([Animal, Dog]));
    const { normalizeSchemaState } = await import('../../src/migrations/schema-state.js');
    const normalized = normalizeSchemaState(schema);
    assert.ok(normalized);
    const dogs = normalized.tables.find((t) => t.name === 'dogs');
    assert.ok(dogs);
    assert.ok(dogs.columns.find((c) => c.name === 'id' && c.primaryKey));
    assert.equal(dogs.foreignKeys?.length, 1);
    assert.equal(dogs.foreignKeys?.[0]?.referencedTable, 'animals');
  });

  it('drives a migration when an MTI child is added', async () => {
    // Initial state: only the parent.
    const initial = await buildSchema(postgresOptions([Animal]));

    // Desired state: parent + child.
    const desired = await buildSchema(postgresOptions([Animal, Dog]));

    const createTables = generateMigration('create_tables', [], initial);
    assert.ok(createTables);
    assert.equal(createTables.operations[0]?.kind, 'create_table');

    const addChild = generateMigration('add_dogs', [createTables], desired);
    assert.ok(addChild);
    // Expected: create_table (dogs) + add_fk.
    // No add_unique because the PK itself enforces uniqueness for the MTI join column.
    const kinds = addChild.operations.map((op) => op.kind);
    assert.deepEqual(kinds, ['create_table', 'add_fk']);
    assert.deepEqual(replayMigrationHistory([createTables, addChild]), desired);
  });

  it('plain extends (concrete table inheritance) is NOT rejected', async () => {
    // TypeORM plain @Entity extends produces CTI: the child duplicates parent
    // columns in its own table. This is accepted as two independent tables.
    @Entity('vehicles')
    class Vehicle extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      name!: string;
    }

    @Entity('cars')
    class Car extends Vehicle {
      @Column({ type: 'integer', nullable: true })
      doors!: number | null;
    }

    const schema = await buildSchema(postgresOptions([Vehicle, Car]));
    assert.equal(schema.tables.length, 2);

    const vehicles = schema.tables.find((t) => t.name === 'vehicles');
    const cars = schema.tables.find((t) => t.name === 'cars');
    assert.ok(vehicles);
    assert.ok(cars);
    // CTI: cars gets its own copy of all Vehicle columns plus its own.
    assert.equal(cars.columns.filter((c) => c.primaryKey).length, 1);
    assert.ok(cars.columns.find((c) => c.name === 'name'));
    assert.ok(cars.columns.find((c) => c.name === 'doors'));
  });

  it('STI via @TableInheritance + @ChildEntity is now accepted', async () => {
    const { ChildEntity, TableInheritance } = await import('typeorm');

    @Entity('vehicles')
    @TableInheritance({ column: { type: 'varchar', length: 50, name: 'type' } })
    class Vehicle extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      name!: string;
    }

    @ChildEntity('car')
    class Car extends Vehicle {
      @Column({ type: 'integer', nullable: true })
      doors!: number | null;
    }

    // STI is no longer rejected — it produces a single table.
    const schema = await buildSchema(postgresOptions([Vehicle, Car]));
    assert.equal(schema.tables.length, 1);

    const table = schema.tables[0];
    assert.ok(table);
    assert.equal(table.name, 'vehicles');

    // All columns from parent and child, plus the discriminator.
    const colNames = table.columns.map((c) => c.name).sort();
    assert.deepEqual(colNames, ['doors', 'id', 'name', 'type']);

    // Inheritance descriptor.
    assert.ok(table.inheritance);
    assert.deepEqual(table.inheritance, {
      strategy: 'single',
      discriminatorColumn: 'type',
      discriminatorValues: ['car'],
    });

    // Round-trips through normalizeSchemaState.
    const { normalizeSchemaState } = await import('../../src/migrations/schema-state.js');
    const normalized = normalizeSchemaState(schema);
    assert.ok(normalized.tables[0]?.inheritance);
    assert.deepEqual(normalized.tables[0]?.inheritance, table.inheritance);
  });
});

describe('getModelSchema: single-table inheritance (STI)', () => {
  it('parent + two children produce ONE table with all columns', async () => {
    const { ChildEntity, TableInheritance } = await import('typeorm');

    @Entity('animals')
    @TableInheritance({ column: { type: 'varchar', length: 50, name: 'kind' } })
    class Animal extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      name!: string;
    }

    @ChildEntity('dog')
    class Dog extends Animal {
      @Column({ type: 'varchar', length: 50, nullable: true })
      breed!: string | null;
    }

    @ChildEntity('cat')
    class Cat extends Animal {
      @Column({ type: 'integer', nullable: true })
      lives!: number | null;
    }

    const schema = await buildSchema(postgresOptions([Animal, Dog, Cat]));
    assert.equal(schema.tables.length, 1);

    const table = schema.tables[0];
    assert.ok(table);
    assert.equal(table.name, 'animals');

    // All columns: id, name, kind (discriminator), breed (Dog), lives (Cat).
    const colNames = table.columns.map((c) => c.name).sort();
    assert.deepEqual(colNames, ['breed', 'id', 'kind', 'lives', 'name']);

    // Inheritance descriptor with sorted discriminator values.
    assert.deepEqual(table.inheritance, {
      strategy: 'single',
      discriminatorColumn: 'kind',
      discriminatorValues: ['cat', 'dog'],
    });
  });

  it('inheritance descriptor has sorted discriminator values', async () => {
    const { ChildEntity, TableInheritance } = await import('typeorm');

    @Entity('items')
    @TableInheritance({ column: { type: 'varchar', length: 30, name: 'item_type' } })
    class Item extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @ChildEntity('book')
    class Book extends Item {
      @Column({ type: 'varchar', length: 200, nullable: true })
      author!: string | null;
    }

    @ChildEntity('article')
    class Article extends Item {
      @Column({ type: 'varchar', length: 200, nullable: true })
      source!: string | null;
    }

    const schema = await buildSchema(postgresOptions([Item, Book, Article]));
    assert.equal(schema.tables.length, 1);

    const inheritance = schema.tables[0]?.inheritance;
    assert.ok(inheritance);
    assert.equal(inheritance.strategy, 'single');
    assert.equal(inheritance.discriminatorColumn, 'item_type');
    // Alphabetically sorted.
    assert.deepEqual(inheritance.discriminatorValues, ['article', 'book']);
  });

  it('round-trips through normalizeSchemaState without error', async () => {
    const { ChildEntity, TableInheritance } = await import('typeorm');

    @Entity('animals')
    @TableInheritance({ column: { type: 'varchar', length: 50, name: 'kind' } })
    class Animal extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      name!: string;
    }

    @ChildEntity('dog')
    class Dog extends Animal {
      @Column({ type: 'varchar', length: 50, nullable: true })
      breed!: string | null;
    }

    const schema = await buildSchema(postgresOptions([Animal, Dog]));
    const { normalizeSchemaState } = await import('../../src/migrations/schema-state.js');
    const normalized = normalizeSchemaState(schema);
    assert.deepEqual(normalized.tables[0]?.inheritance, {
      strategy: 'single',
      discriminatorColumn: 'kind',
      discriminatorValues: ['dog'],
    });
  });

  it('child redeclaring a parent column with same definition is accepted', async () => {
    const { ChildEntity, TableInheritance } = await import('typeorm');

    @Entity('animals')
    @TableInheritance({ column: { type: 'varchar', length: 50, name: 'kind' } })
    class Animal extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      name!: string;
    }

    // Dog redeclares `name` with the same definition — TypeORM already
    // merges this at the metadata level, so no conflict is detected.
    @ChildEntity('dog')
    class Dog extends Animal {
      @Column({ type: 'varchar', length: 100, nullable: false })
      declare name: string;

      @Column({ type: 'varchar', length: 50, nullable: true })
      breed!: string | null;
    }

    const schema = await buildSchema(postgresOptions([Animal, Dog]));
    assert.equal(schema.tables.length, 1);
    // `name` appears exactly once, not twice.
    const colNames = schema.tables[0]?.columns.map((c) => c.name);
    assert.equal(colNames?.filter((n) => n === 'name').length, 1);
    assert.ok(colNames?.includes('breed'));
  });

  it('deduplicates identical column definitions across STI entities', async () => {
    const { ChildEntity, TableInheritance } = await import('typeorm');

    @Entity('animals')
    @TableInheritance({ column: { type: 'varchar', length: 50, name: 'kind' } })
    class Animal extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      name!: string;
    }

    // Dog redeclares `name` identically — not a conflict, just a duplicate.
    // TypeORM merges identical column declarations. Use `declare` so TS
    // allows the override without a type error.
    @ChildEntity('dog')
    class Dog extends Animal {
      @Column({ type: 'varchar', length: 100, nullable: false })
      declare name: string;

      @Column({ type: 'varchar', length: 50, nullable: true })
      breed!: string | null;
    }

    const schema = await buildSchema(postgresOptions([Animal, Dog]));
    assert.equal(schema.tables.length, 1);
    const names = schema.tables[0]?.columns.map((c) => c.name);
    // `name` appears exactly once (deduplicated).
    assert.equal(names?.filter((n) => n === 'name').length, 1);
  });

  it('adds a child entity without emitting destructive operations', async () => {
    const { ChildEntity, TableInheritance } = await import('typeorm');

    @Entity('animals')
    @TableInheritance({ column: { type: 'varchar', length: 50, name: 'kind' } })
    class Animal extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      name!: string;
    }

    @ChildEntity('dog')
    class Dog extends Animal {
      @Column({ type: 'varchar', length: 50, nullable: true })
      breed!: string | null;
    }

    // Initial schema: parent + dog.
    const initial = await buildSchema(postgresOptions([Animal, Dog]));

    // Add a cat child (declared after, so it's a "new" entity).
    @ChildEntity('cat')
    class Cat extends Animal {
      @Column({ type: 'integer', nullable: true })
      lives!: number | null;
    }

    // Desired schema: parent + dog + cat.
    const desired = await buildSchema(postgresOptions([Animal, Dog, Cat]));

    const createTables = generateMigration('create_tables', [], initial);
    assert.ok(createTables);
    assert.equal(createTables.operations[0]?.kind, 'create_table');

    const addCat = generateMigration('add_cat', [createTables], desired);
    assert.ok(addCat);

    // The new child column `lives` appears as an add_column.
    // There must be NO destructive operations (no drop_table, drop_column, etc.).
    const kinds = addCat.operations.map((op) => op.kind);
    assert.ok(!kinds.includes('drop_table'));
    assert.ok(!kinds.includes('drop_column'));
    assert.ok(kinds.includes('add_column'));

    // The chain replays to the desired schema.
    assert.deepEqual(replayMigrationHistory([createTables, addCat]), desired);
  });

  it('adding a disc-only child (no new columns) produces no migration', async () => {
    const { ChildEntity, TableInheritance } = await import('typeorm');

    @Entity('animals')
    @TableInheritance({ column: { type: 'varchar', length: 50, name: 'kind' } })
    class Animal extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      name!: string;
    }

    @ChildEntity('dog')
    class Dog extends Animal {
      @Column({ type: 'varchar', length: 50, nullable: true })
      breed!: string | null;
    }

    const initial = await buildSchema(postgresOptions([Animal, Dog]));

    // A second child that adds no new columns (pure discriminator).
    @ChildEntity('cat')
    class Cat extends Animal {}

    const desired = await buildSchema(postgresOptions([Animal, Dog, Cat]));

    const createTables = generateMigration('create_tables', [], initial);
    assert.ok(createTables);

    // No structural DDL — the discriminator value change alone needs no
    // table-level operation. It is recorded as a metadata-only
    // `alter_inheritance` so replay reconstructs the descriptor.
    const discOnly = generateMigration('add_cat_disc_only', [createTables], desired);
    assert.ok(discOnly);
    assert.deepEqual(
      discOnly.operations.map((op) => op.kind),
      ['alter_inheritance'],
    );
    assert.deepEqual(replayMigrationHistory([createTables, discOnly]), desired);
  });

  it('STI with entity-level index on a child is included in the shared table', async () => {
    const { ChildEntity, TableInheritance } = await import('typeorm');

    @Entity('vehicles')
    @TableInheritance({ column: { type: 'varchar', length: 50, name: 'type' } })
    class Vehicle extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      name!: string;
    }

    @ChildEntity('car')
    @Index(['doors'])
    class Car extends Vehicle {
      @Column({ type: 'integer', nullable: true })
      doors!: number | null;
    }

    const schema = await buildSchema(postgresOptions([Vehicle, Car]));
    assert.equal(schema.tables.length, 1);
    const table = schema.tables[0];
    assert.ok(table);

    // The index defined on the child entity is present on the shared table.
    assert.ok(table.indexes);
    const doorsIndex = table.indexes?.find((idx) => idx.columns.includes('doors'));
    assert.ok(doorsIndex);
  });

  it('builds identical STI schema on postgres and mysql', async () => {
    const { ChildEntity, TableInheritance } = await import('typeorm');

    @Entity('items')
    @TableInheritance({ column: { type: 'varchar', length: 30, name: 'item_type' } })
    class Item extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      title!: string;
    }

    @ChildEntity('book')
    class Book extends Item {
      @Column({ type: 'integer', nullable: true })
      pages!: number | null;
    }

    const postgres = await buildSchema(postgresOptions([Item, Book]));
    const mysql = await buildSchema(mysqlOptions([Item, Book]));

    assert.deepEqual(postgres, mysql);
    assert.equal(postgres.tables.length, 1);
    assert.deepEqual(postgres.tables[0]?.inheritance, {
      strategy: 'single',
      discriminatorColumn: 'item_type',
      discriminatorValues: ['book'],
    });
  });
});

describe('unsafe options are rejected at construction', () => {
  const base = () => ({
    type: 'postgres' as const,
    host: '127.0.0.1',
    port: 5432,
    username: 'placeholder',
    password: 'placeholder',
    database: 'placeholder',
    entities: [] as MixedList<AnyEntity>,
  });

  it('rejects synchronize: true', () => {
    assert.throws(() => new JsailsDataSource({ ...base(), synchronize: true }), MigrationError);
  });

  it('rejects dropSchema: true', () => {
    assert.throws(() => new JsailsDataSource({ ...base(), dropSchema: true }), MigrationError);
  });

  it('rejects migrationsRun: true', () => {
    assert.throws(() => new JsailsDataSource({ ...base(), migrationsRun: true }), MigrationError);
  });

  it('rejects TypeORM migrations configuration', () => {
    class FakeMigration {
      async up(): Promise<void> {}
      async down(): Promise<void> {}
    }
    assert.throws(
      () => new JsailsDataSource({ ...base(), migrations: [FakeMigration] }),
      /TypeORM migrations/,
    );
  });

  it('rejects unsupported database drivers', () => {
    assert.throws(
      () =>
        new JsailsDataSource({
          ...base(),
          type: 'cockroachdb',
        } as unknown as JsailsDataSourceOptions),
      /unsupported database type/,
    );
  });

  it('exposes the validated driver type', () => {
    const dataSource = new JsailsDataSource(postgresOptions([]));
    assert.equal(dataSource.jsailsDriver, 'postgres');
  });
});
