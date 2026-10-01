/**
 * Live database introspection round-trip tests.
 *
 * Uses the real TypeORM sqljs WASM driver — never mocked. Entity classes are
 * defined with standard TypeORM decorators; the declared schema is built from
 * their metadata via {@link JsailsDataSource.getModelSchema}, physical tables
 * are created through the same naming strategy, and the introspected live schema
 * must be byte-equal to the declared schema.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  BaseEntity,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  QueryRunner,
  Table,
  TableForeignKey,
  Unique,
} from 'typeorm';

import { JsailsDataSource } from '../../src/database/data-source.js';
import { buildSchemaStateFromQueryRunner } from '../../src/database/schema-introspect.js';

const tmpRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'schema-introspect-'),
);

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function dbPath(name: string): string {
  return join(tmpRoot, `${name}.db`);
}

async function openDataSource(entities: Function[], dbFile: string): Promise<JsailsDataSource> {
  const ds = new JsailsDataSource({
    type: 'sqljs',
    location: dbFile,
    entities,
    autoSave: true,
  });
  await ds.initialize();
  return ds;
}

// ---------------------------------------------------------------------------
// 1. Round-trip equality
// ---------------------------------------------------------------------------

describe('schema-introspect round-trip', () => {
  it('declared and live schemas are byte-equal for a normal schema', async () => {
    // --- Define entities ---
    @Entity('author')
    class Author extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 200, nullable: false })
      name!: string;

      @Column({ type: 'text', nullable: true })
      bio!: string | null;

      @Column({ type: 'boolean', nullable: false, default: true })
      active!: boolean;

      @Column({ type: 'datetime', nullable: true })
      joined_at!: Date | null;

      @Column({ type: 'integer', nullable: false, default: 0 })
      score!: number;
    }

    @Entity('post')
    class Post extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 120, nullable: false })
      @Index('IDX_post_slug', { unique: true })
      slug!: string;

      @Column({ type: 'text', nullable: true })
      body!: string | null;

      @Column({ type: 'integer', nullable: false, default: 0 })
      views!: number;

      @ManyToOne(() => Author, { nullable: false })
      @JoinColumn({ name: 'author_id' })
      @Index('IDX_post_author')
      author!: Author;
    }

    const dbFile = dbPath('roundtrip');
    const ds = await openDataSource([Author, Post], dbFile);

    // Build the declared schema from entity metadata.
    const declared = await ds.getModelSchema();

    // Create physical tables from the same entity metadata using the same
    // naming strategy, so constraint names match.
    const qr = ds.createQueryRunner();
    try {
      for (const meta of ds.entityMetadatas) {
        const table = Table.create(meta, ds.driver);

        // Table.create() does not include foreign keys — add them manually
        // from the entity metadata so createTable emits FK constraints.
        for (const fkMeta of meta.foreignKeys) {
          table.addForeignKey(TableForeignKey.create(fkMeta, ds.driver));
        }

        await qr.createTable(table);
      }

      // Introspect using the same QR.
      const live = await buildSchemaStateFromQueryRunner(qr, 'sqlite');

      assert.deepStrictEqual(live, declared);
    } finally {
      await qr.release();
      await ds.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 1b. Constraint-name synthesis: explicit @Unique + one-to-one unique
  // -----------------------------------------------------------------------

  it('declared and live agree on synthesized unique-constraint names', async () => {
    // --- Define entities ---
    @Entity('accounts')
    class Account extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      // Explicit column @Unique: TypeORM's DefaultNamingStrategy emits a
      // hash-based name (UQ_<hash>), not UQ_<table>_<column>.
      @Column({ type: 'varchar', length: 120, nullable: false })
      @Unique(['email'])
      email!: string;

      // Entity-level composite @Unique: also named by DefaultNamingStrategy.
      @Column({ type: 'varchar', length: 40, nullable: false })
      tenant!: string;

      @Column({ type: 'varchar', length: 40, nullable: false })
      slug!: string;
    }

    @Entity('account_settings')
    @Unique(['tenant', 'slug'])
    class AccountSettings extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 40, nullable: false })
      tenant!: string;

      @Column({ type: 'varchar', length: 40, nullable: false })
      slug!: string;

      // Owning-side one-to-one: TypeORM auto-declares a REL_<hash> unique on
      // the join column, so synthesizeOneToOneUniques skips its literal
      // UQ_<table>_<joinColumn> fallback. The live side must read the same
      // physical name back.
      @OneToOne(() => Account, { nullable: false })
      @JoinColumn({ name: 'account_id' })
      account!: Account;
    }

    const dbFile = dbPath('unique-names');
    const ds = await openDataSource([Account, AccountSettings], dbFile);

    const declared = await ds.getModelSchema();

    const qr = ds.createQueryRunner();
    try {
      for (const meta of ds.entityMetadatas) {
        const table = Table.create(meta, ds.driver);

        // Table.create() does not include foreign keys — add them manually
        // from the entity metadata so createTable emits FK constraints.
        for (const fkMeta of meta.foreignKeys) {
          table.addForeignKey(TableForeignKey.create(fkMeta, ds.driver));
        }

        await qr.createTable(table);
      }

      const live = await buildSchemaStateFromQueryRunner(qr, 'sqlite');

      assert.deepStrictEqual(live, declared);
    } finally {
      await qr.release();
      await ds.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 2. sqlite_sequence filtered
  // -----------------------------------------------------------------------

  it('filters sqlite_sequence from the introspected schema', async () => {
    @Entity('things')
    class Thing extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    const dbFile = dbPath('no-sqlite-seq');
    const ds = await openDataSource([Thing], dbFile);

    const qr = ds.createQueryRunner();
    try {
      const table = Table.create(ds.entityMetadatas[0]!, ds.driver);
      await qr.createTable(table);

      const live = await buildSchemaStateFromQueryRunner(qr, 'sqlite');

      // Only the user table appears; sqlite_sequence is absent.
      assert.equal(live.tables.length, 1);
      assert.equal(live.tables[0]!.name, 'things');
    } finally {
      await qr.release();
      await ds.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 3. Function default filtered
  // -----------------------------------------------------------------------

  it('filters function defaults (CURRENT_TIMESTAMP)', async () => {
    @Entity('events')
    class Event extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      name!: string;

      @Column({ type: 'datetime', nullable: false })
      created_at!: Date;
    }

    const dbFile = dbPath('func-default');
    const ds = await openDataSource([Event], dbFile);

    const qr = ds.createQueryRunner();
    try {
      // Create the table with a function default on created_at.
      await qr.query(
        `CREATE TABLE "events" (
          "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
          "name" varchar(100) NOT NULL,
          "created_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        )`,
      );

      const live = await buildSchemaStateFromQueryRunner(qr, 'sqlite');
      const eventsTable = live.tables.find((t) => t.name === 'events');
      assert.ok(eventsTable, 'events table is present');

      const createdAtCol = eventsTable.columns.find((c) => c.name === 'created_at');
      assert.ok(createdAtCol, 'created_at column is present');
      assert.strictEqual(createdAtCol.default, undefined, 'function default must be filtered');
    } finally {
      await qr.release();
      await ds.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 4. PK shape: single integer PK → non-nullable, primaryKey:true, no default
  // -----------------------------------------------------------------------

  it('single integer PK introspects with correct shape', async () => {
    @Entity('items')
    class Item extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 50, nullable: false })
      label!: string;
    }

    const dbFile = dbPath('pk-shape');
    const ds = await openDataSource([Item], dbFile);

    const qr = ds.createQueryRunner();
    try {
      const meta = ds.entityMetadatas[0];
      assert.ok(meta);
      const table = Table.create(meta, ds.driver);
      await qr.createTable(table);

      const live = await buildSchemaStateFromQueryRunner(qr, 'sqlite');
      const itemsTable = live.tables.find((t) => t.name === 'items');
      assert.ok(itemsTable);

      const pkCol = itemsTable.columns.find((c) => c.name === 'id');
      assert.ok(pkCol);
      assert.strictEqual(pkCol.type, 'integer');
      assert.strictEqual(pkCol.nullable, false);
      assert.strictEqual(pkCol.primaryKey, true);
      assert.strictEqual(pkCol.default, undefined);
    } finally {
      await qr.release();
      await ds.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 5. FK action mapped
  // -----------------------------------------------------------------------

  it('maps ON DELETE CASCADE foreign key action', async () => {
    @Entity('parent')
    class Parent extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity('child')
    class Child extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => Parent, { nullable: false, onDelete: 'CASCADE' })
      @JoinColumn({ name: 'parent_id' })
      parent!: Parent;
    }

    const dbFile = dbPath('fk-action');
    const ds = await openDataSource([Parent, Child], dbFile);

    const qr = ds.createQueryRunner();
    try {
      for (const meta of ds.entityMetadatas) {
        const table = Table.create(meta, ds.driver);
        for (const fkMeta of meta.foreignKeys) {
          table.addForeignKey(TableForeignKey.create(fkMeta, ds.driver));
        }
        await qr.createTable(table);
      }

      const live = await buildSchemaStateFromQueryRunner(qr, 'sqlite');

      // FK from child → parent
      const childTable = live.tables.find((t) => t.name === 'child');
      assert.ok(childTable);
      assert.ok(childTable.foreignKeys);
      assert.ok(childTable.foreignKeys.length > 0);

      const fk = childTable.foreignKeys.find((f) => f.referencedTable === 'parent');
      assert.ok(fk, 'FK to parent is present');
      assert.strictEqual(fk.onDelete, 'cascade');
    } finally {
      await qr.release();
      await ds.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 6. Index and unique present
  // -----------------------------------------------------------------------

  it('captures plain indexes and unique indexes', async () => {
    @Entity('products')
    class Product extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      @Index('IDX_product_sku', { unique: true })
      sku!: string;

      @Column({ type: 'varchar', length: 200, nullable: false })
      @Index('IDX_product_name')
      name!: string;
    }

    const dbFile = dbPath('indexes');
    const ds = await openDataSource([Product], dbFile);

    const qr = ds.createQueryRunner();
    try {
      const meta = ds.entityMetadatas[0];
      assert.ok(meta);
      const table = Table.create(meta, ds.driver);
      await qr.createTable(table);

      const live = await buildSchemaStateFromQueryRunner(qr, 'sqlite');
      const productsTable = live.tables.find((t) => t.name === 'products');
      assert.ok(productsTable);
      assert.ok(productsTable.indexes, 'indexes are present');
      assert.ok(productsTable.indexes.length >= 2);

      const skuIndex = productsTable.indexes.find((ix) => ix.name === 'IDX_product_sku');
      assert.ok(skuIndex);
      assert.strictEqual(skuIndex.unique, true);

      const nameIndex = productsTable.indexes.find((ix) => ix.name === 'IDX_product_name');
      assert.ok(nameIndex);
      assert.strictEqual(nameIndex.unique, false);
    } finally {
      await qr.release();
      await ds.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 7. varchar length parsed to a number
  // -----------------------------------------------------------------------

  it('parses varchar length as a number', async () => {
    @Entity('profiles')
    class Profile extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 80, nullable: false })
      handle!: string;
    }

    const dbFile = dbPath('varchar-len');
    const ds = await openDataSource([Profile], dbFile);

    const qr = ds.createQueryRunner();
    try {
      const meta = ds.entityMetadatas[0];
      assert.ok(meta);
      const table = Table.create(meta, ds.driver);
      await qr.createTable(table);

      const live = await buildSchemaStateFromQueryRunner(qr, 'sqlite');
      const profilesTable = live.tables.find((t) => t.name === 'profiles');
      assert.ok(profilesTable);

      const handleCol = profilesTable.columns.find((c) => c.name === 'handle');
      assert.ok(handleCol);
      assert.strictEqual(handleCol.type, 'varchar');
      assert.strictEqual(handleCol.length, 80);
      assert.strictEqual(typeof handleCol.length, 'number');
    } finally {
      await qr.release();
      await ds.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Postgres scoping + string-valued boolean defaults
// ---------------------------------------------------------------------------

/**
 * A stub QueryRunner that satisfies the two methods introspection uses:
 * `query(sql)` (scoped table-name resolution) and `getTables(names)` (metadata
 * load). It records the SQL and the names it was called with so the test can
 * assert the driver was scoped rather than handed `undefined` (which on the
 * real postgres driver enumerates `pg_catalog`).
 *
 * The returned table is a real TypeORM {@link Table} carrying a boolean column
 * whose `default` is the STRING `"true"` — exactly what TypeORM reports from a
 * live Postgres/MySQL column declared `DEFAULT true`. This pins the fix where
 * the bare `TRUE` keyword was previously filtered before the boolean branch
 * could canonicalize it, producing a phantom `alter_column` on the next diff.
 */
class StubQueryRunner {
  readonly queries: string[] = [];
  readonly requestedNames: (string[] | undefined)[] = [];
  private readonly tables: Table[];

  constructor(tables: Table[]) {
    this.tables = tables;
  }

  query(sql: string): Promise<unknown> {
    this.queries.push(sql);
    if (sql.includes('information_schema.tables')) {
      return Promise.resolve([{ table_name: 'widgets' }]);
    }
    return Promise.resolve([]);
  }

  getTables(names?: string[]): Promise<Table[]> {
    this.requestedNames.push(names);
    return Promise.resolve(this.tables);
  }
}

describe('postgres introspection scoping and boolean defaults', () => {
  it('scopes getTables to current_schema base tables instead of enumerating pg_catalog', async () => {
    const table = new Table({ name: 'widgets' });
    const runner = new StubQueryRunner([table]);

    await buildSchemaStateFromQueryRunner(runner as unknown as QueryRunner, 'postgres');

    // The postgres branch must query information_schema with the current-schema
    // / BASE TABLE filter and hand the resulting names to getTables.
    assert.ok(
      runner.queries.some(
        (sql) =>
          sql.includes('information_schema.tables') &&
          sql.includes('current_schema()') &&
          sql.includes("table_type = 'BASE TABLE'"),
      ),
      'postgres scoping query was issued',
    );
    assert.deepStrictEqual(runner.requestedNames, [['widgets']]);
  });

  it('preserves a string-valued boolean default ("true") instead of dropping it', async () => {
    const table = new Table({ name: 'widgets' });
    table.addColumn({
      name: 'active',
      type: 'boolean',
      isNullable: false,
      default: 'true',
    } as Parameters<Table['addColumn']>[0]);

    const runner = new StubQueryRunner([table]);
    const live = await buildSchemaStateFromQueryRunner(
      runner as unknown as QueryRunner,
      'postgres',
    );

    const widgets = live.tables.find((t) => t.name === 'widgets');
    assert.ok(widgets, 'widgets table is present');
    const active = widgets.columns.find((c) => c.name === 'active');
    assert.ok(active, 'active column is present');
    assert.strictEqual(active.default, true, 'boolean default must survive introspection');
  });
});

/**
 * MySQL's driver reports literal defaults single-quoted (`"'1'"`, `"'0'"`),
 * unlike MariaDB which returns them bare (`"1"`, `"0"`). The canonicalizer must
 * unquote before the boolean/integer coercion or the default is dropped,
 * producing a phantom (and destructive) `alter_column` on every reconcile —
 * exactly the failure mode this pins.
 */
class MysqlStubQueryRunner {
  readonly queries: string[] = [];
  private readonly tables: Table[];

  constructor(tables: Table[]) {
    this.tables = tables;
  }

  query(sql: string): Promise<unknown> {
    this.queries.push(sql);
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
      return Promise.resolve([{ TABLE_NAME: 'widgets' }]);
    }
    return Promise.resolve([]);
  }

  getTables(): Promise<Table[]> {
    return Promise.resolve(this.tables);
  }
}

describe('mysql introspection preserves quoted literal defaults', () => {
  it('canonicalizes a single-quoted boolean default ("\'1\'") to true', async () => {
    const table = new Table({ name: 'widgets' });
    table.addColumn({
      name: 'active',
      type: 'tinyint',
      isNullable: false,
      default: "'1'",
    } as Parameters<Table['addColumn']>[0]);

    const runner = new MysqlStubQueryRunner([table]);
    const live = await buildSchemaStateFromQueryRunner(runner as unknown as QueryRunner, 'mysql');

    const active = live.tables
      .find((t) => t.name === 'widgets')
      ?.columns.find((c) => c.name === 'active');
    assert.ok(active, 'active column is present');
    assert.strictEqual(active.default, true, 'quoted boolean default must survive introspection');
  });

  it('canonicalizes a single-quoted integer default ("\'0\'") to 0', async () => {
    const table = new Table({ name: 'widgets' });
    table.addColumn({
      name: 'count',
      type: 'int',
      isNullable: false,
      default: "'0'",
    } as Parameters<Table['addColumn']>[0]);

    const runner = new MysqlStubQueryRunner([table]);
    const live = await buildSchemaStateFromQueryRunner(runner as unknown as QueryRunner, 'mysql');

    const count = live.tables
      .find((t) => t.name === 'widgets')
      ?.columns.find((c) => c.name === 'count');
    assert.ok(count, 'count column is present');
    assert.strictEqual(count.default, 0, 'quoted integer default must survive introspection');
  });
});
