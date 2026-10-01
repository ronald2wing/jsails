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
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  ViewColumn,
  ViewEntity,
} from 'typeorm';
import type { MixedList } from 'typeorm';
import {
  JsailsDataSource,
  type JsailsDataSourceOptions,
} from '../src/database/jsails-data-source.js';
import { RESERVED_MIGRATIONS_TABLE } from '../src/database/model-schema.js';
import { MigrationError, type SchemaState } from '../src/migrations/schema-state.js';
import { generateMigration } from '../src/migrations/autodetector.js';
import { replayMigrationHistory } from '../src/migrations/history.js';

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

describe('unsupported features are rejected', () => {
  it('rejects relations and foreign keys', async () => {
    @Entity('authors')
    class Author extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @OneToMany(() => Post, (post) => post.author)
      posts!: Post[];
    }

    @Entity('posts')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => Author, (author) => author.posts)
      @JoinColumn()
      author!: Author;
    }

    await assert.rejects(buildSchema(postgresOptions([Author, Post])), /relations/);
  });

  it('rejects composite primary keys', async () => {
    @Entity('composite')
    class Composite extends BaseEntity {
      @PrimaryColumn()
      a!: number;

      @PrimaryColumn()
      b!: number;
    }

    await assert.rejects(buildSchema(postgresOptions([Composite])), /composite primary key/);
  });

  it('rejects unique constraints', async () => {
    @Entity('unique_users')
    class UniqueUser extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 50, unique: true })
      email!: string;
    }

    await assert.rejects(buildSchema(postgresOptions([UniqueUser])), /unique/);
  });

  it('rejects indexes', async () => {
    @Entity('indexed')
    @Index(['email'])
    class Indexed extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 50 })
      email!: string;
    }

    await assert.rejects(buildSchema(postgresOptions([Indexed])), /index/);
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

  it('rejects lossy column types such as bigint', async () => {
    @Entity('big')
    class Big extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'bigint', nullable: true })
      count!: string | null;
    }

    await assert.rejects(buildSchema(postgresOptions([Big])), /unsupported type "bigint"/);
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
