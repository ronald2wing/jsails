/**
 * Desired-state reconciler: end-to-end tests with the real sqljs driver.
 *
 * Every case sets up physical tables through TypeORM's query runner, builds
 * the declared and live schemas from a {@link JsailsDataSource}, and asserts
 * that {@link reconcileDataSource} (or {@link buildSchemaPlan}) produces the
 * expected plan.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, describe, it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn, Table } from 'typeorm';

import { JsailsDataSource } from '../../src/database/data-source.js';
import { clearModelRegistry, registerModel } from '../../src/database/model-registry.js';
import { MigrationError } from '../../src/migrations/schema-types.js';
import type { Operation } from '../../src/migrations/operations.js';
import { buildSchemaPlan, reconcileDataSource } from '../../src/migrations/reconciler.js';

/**
 * Find the single operation of the given kind, narrowed to its discriminated
 * member. The assertion is sound because `find`'s predicate proves the kind,
 * but TypeScript cannot carry that predicate into the return type, so the
 * narrowing assertion is confined here rather than scattered across every test.
 */
function opOfKind<K extends Operation['kind']>(
  operations: readonly Operation[],
  kind: K,
): Extract<Operation, { kind: K }> {
  const op = operations.find((candidate) => candidate.kind === kind);
  assert.ok(op, `expected an operation of kind "${kind}"`);
  return op as Extract<Operation, { kind: K }>;
}

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'reconciler-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  clearModelRegistry();
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
// 1. Up to date
// ---------------------------------------------------------------------------

describe('reconciler', () => {
  it('returns up-to-date when the live DB matches the declared schema', async () => {
    @Entity('widgets')
    class Widget extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      label!: string;

      @Column({ type: 'integer', nullable: true })
      count!: number | null;
    }

    const dbFile = dbPath('uptodate');
    const ds = await openDataSource([Widget], dbFile);

    const qr = ds.createQueryRunner();
    try {
      const table = Table.create(ds.entityMetadatas[0]!, ds.driver);
      await qr.createTable(table);

      const plan = await reconcileDataSource(ds);
      assert.strictEqual(plan.upToDate, true, 'schemas should match');
      assert.strictEqual(plan.operations.length, 0, 'no operations needed');
      assert.strictEqual(plan.destructive, false);
    } finally {
      await qr.release();
      await ds.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 2. Add a column
  // -----------------------------------------------------------------------

  it('emits add_column when the model declares a column missing from live', async () => {
    // Define an entity with an extra column that the live table lacks.
    @Entity('products')
    class Product extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      name!: string;

      // This column will NOT exist in the physical table.
      @Column({ type: 'text', nullable: true })
      description!: string | null;
    }

    const dbFile = dbPath('addcol');
    const ds = await openDataSource([Product], dbFile);

    const qr = ds.createQueryRunner();
    try {
      // Create the table with only the id + name columns, omitting description.
      const meta = ds.entityMetadatas[0]!;
      const tableWithoutDesc = Table.create(meta, ds.driver);
      const descColIdx = tableWithoutDesc.columns.findIndex((c) => c.name === 'description');
      assert.ok(
        descColIdx !== -1,
        'Table.create must include the description column from metadata',
      );
      tableWithoutDesc.columns.splice(descColIdx, 1);
      await qr.createTable(tableWithoutDesc);

      const plan = await reconcileDataSource(ds);
      assert.strictEqual(plan.upToDate, false);
      assert.strictEqual(plan.operations.length, 1);

      const op = opOfKind(plan.operations, 'add_column');
      assert.strictEqual(op.table, 'products');
      assert.strictEqual(op.column.name, 'description');
      assert.strictEqual(plan.destructive, false);
    } finally {
      await qr.release();
      await ds.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 3. Drop a column (destructive)
  // -----------------------------------------------------------------------

  it('emits drop_column with destructive:true when a live column is absent from the model', async () => {
    // First pass: entity with the column; second pass: entity without it.

    // Entity used to materialise the live table (with the `obsolete` column).
    @Entity('records')
    class RecordV1 extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      name!: string;

      @Column({ type: 'integer', nullable: true })
      obsolete!: number | null;
    }

    // Entity used for the declared schema (without `obsolete`).
    @Entity('records')
    class RecordV2 extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 100, nullable: false })
      name!: string;
    }

    const dbFile = dbPath('dropcol');

    // 3a. Create the live table with the obsolete column using RecordV1.
    {
      const ds = await openDataSource([RecordV1], dbFile);
      const qr = ds.createQueryRunner();
      try {
        const table = Table.create(ds.entityMetadatas[0]!, ds.driver);
        await qr.createTable(table);
      } finally {
        await qr.release();
        await ds.destroy();
      }
    }

    // 3b. Open a second data source with RecordV2. The live table still has
    //     `obsolete`; the declared schema does not.
    {
      const ds = await openDataSource([RecordV2], dbFile);
      try {
        // Without allowDestructive, diffSchemas throws because drop_column
        // is gated by requireDestructive.
        await assert.rejects(
          () => reconcileDataSource(ds),
          (err: unknown) =>
            err instanceof MigrationError && err.message.includes('dropping column'),
          'drop_column without allowDestructive must throw MigrationError',
        );

        // With allowDestructive, the plan includes exactly one drop_column and
        // is classified destructive.
        const plan = await reconcileDataSource(ds, { allowDestructive: true });
        assert.strictEqual(plan.upToDate, false);
        assert.strictEqual(plan.destructive, true);
        assert.strictEqual(plan.operations.length, 1);

        const op = opOfKind(plan.operations, 'drop_column');
        assert.strictEqual(op.table, 'records');
        assert.strictEqual(op.column.name, 'obsolete');
      } finally {
        await ds.destroy();
      }
    }
  });

  // -----------------------------------------------------------------------
  // 4. Rename via explicit hints (buildSchemaPlan path)
  // -----------------------------------------------------------------------

  it('emits rename_column from explicit renames instead of drop+add', async () => {
    // Entity V1: has `old_col` — used to create the live table.
    @Entity('items')
    class ItemV1 extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 80, nullable: false })
      old_col!: string;
    }

    // Entity V2: has `new_col` — used for the declared schema.
    @Entity('items')
    class ItemV2 extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 80, nullable: false })
      new_col!: string;
    }

    const dbFile = dbPath('rename-explicit');

    // 4a. Create the live table with old_col.
    {
      const ds = await openDataSource([ItemV1], dbFile);
      const qr = ds.createQueryRunner();
      try {
        const table = Table.create(ds.entityMetadatas[0]!, ds.driver);
        await qr.createTable(table);
      } finally {
        await qr.release();
        await ds.destroy();
      }
    }

    // 4b. Open a second data source with ItemV2 and feed explicit renames.
    clearModelRegistry(); // V1 registrations must not confuse this.
    {
      const ds = await openDataSource([ItemV2], dbFile);
      try {
        const desired = await ds.getModelSchema();
        const current = await ds.getLiveSchema();

        const plan = buildSchemaPlan(desired, current, {
          renames: [{ table: 'items', from: 'old_col', to: 'new_col' }],
        });

        assert.strictEqual(plan.upToDate, false);
        assert.strictEqual(plan.destructive, false, 'rename is non-destructive');

        // The plan must contain rename_column, no drop_column or add_column.
        const kinds = plan.operations.map((op) => op.kind);
        assert.ok(
          kinds.includes('rename_column'),
          `expected rename_column, got ${kinds.join(',')}`,
        );
        assert.ok(
          !kinds.includes('drop_column') && !kinds.includes('add_column'),
          `rename should not produce drop/add, got ${kinds.join(',')}`,
        );

        const rename = opOfKind(plan.operations, 'rename_column');
        assert.strictEqual(rename.table, 'items');
        assert.strictEqual(rename.from, 'old_col');
        assert.strictEqual(rename.to, 'new_col');
      } finally {
        await ds.destroy();
      }
    }
  });

  // -----------------------------------------------------------------------
  // 4b. Rename via registry (@jsails.renamedFrom via reconcileDataSource)
  // -----------------------------------------------------------------------

  it('emits rename_column from the model registry via reconcileDataSource', async () => {
    // Entity V1: has `old_field` — used to create the live table.
    @Entity('entries')
    class EntryV1 extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'text', nullable: true })
      old_field!: string | null;
    }

    // Entity V2: has `new_field` — used for the declared schema.
    @Entity('entries')
    class EntryV2 extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'text', nullable: true })
      new_field!: string | null;
    }

    const dbFile = dbPath('rename-registry');

    // 4b.1. Create the live table with old_field.
    {
      const ds = await openDataSource([EntryV1], dbFile);
      const qr = ds.createQueryRunner();
      try {
        const table = Table.create(ds.entityMetadatas[0]!, ds.driver);
        await qr.createTable(table);
      } finally {
        await qr.release();
        await ds.destroy();
      }
    }

    // 4b.2. Register EntryV2 with a spec carrying renamedFrom so
    //       buildRenameHintsFromRegistry() picks it up.
    clearModelRegistry();

    registerModel(EntryV2, [], {
      table: 'entries',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [
        {
          name: 'new_field',
          type: 'text',
          nullable: true,
          renamedFrom: 'old_field',
        },
      ],
      relations: [],
    });

    {
      // EntryV2 is passed explicitly; harvestRegisteredModels deduplicates it.
      const ds = await openDataSource([EntryV2], dbFile);
      try {
        const plan = await reconcileDataSource(ds);
        assert.strictEqual(plan.upToDate, false);
        assert.strictEqual(plan.destructive, false);

        const rename = opOfKind(plan.operations, 'rename_column');
        assert.strictEqual(rename.table, 'entries');
        assert.strictEqual(rename.from, 'old_field');
        assert.strictEqual(rename.to, 'new_field');

        // No drop_column or add_column should appear alongside the rename.
        const dropAdd = plan.operations.filter(
          (op) => op.kind === 'drop_column' || op.kind === 'add_column',
        );
        assert.strictEqual(dropAdd.length, 0, 'rename should not leave drop/add residue');
      } finally {
        await ds.destroy();
      }
    }
  });

  // -----------------------------------------------------------------------
  // 5. Create a new table
  // -----------------------------------------------------------------------

  it('emits create_table when the model declares a table absent from live', async () => {
    @Entity('inventory')
    class Inventory extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'varchar', length: 60, nullable: false })
      sku!: string;
    }

    const dbFile = dbPath('createtable');
    const ds = await openDataSource([Inventory], dbFile);

    try {
      // The database file is empty — no table exists, so the live schema
      // has zero tables while the declared schema has one.
      const plan = await reconcileDataSource(ds);
      assert.strictEqual(plan.upToDate, false);
      assert.strictEqual(plan.destructive, false, 'create_table is non-destructive');
      assert.strictEqual(plan.operations.length, 1);

      const op = opOfKind(plan.operations, 'create_table');
      assert.strictEqual(op.table.name, 'inventory');

      const cols = op.table.columns.map((column) => column.name);
      assert.deepStrictEqual(cols, ['id', 'sku']);
    } finally {
      await ds.destroy();
    }
  });
});
