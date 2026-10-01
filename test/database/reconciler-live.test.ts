/**
 * Live MariaDB verification for the declarative reconciler.
 *
 * Env-gated (`JSAILS_LIVE_DB=1` plus `DATABASE_*`): opens a real MariaDB
 * connection and asserts the declared schema reconciles to up-to-date against
 * the live database. This is the only coverage that exercises the MySQL/MariaDB
 * introspection path end to end — the default suite runs on sqljs, which does
 * not reproduce the driver-specific behaviours below.
 *
 * Two driver-specific regressions are pinned here:
 * - TypeORM's unfiltered `getTables()` throws on MariaDB (it returns rows from
 *   `performance_schema`, whose collation lookup is undefined); introspection
 *   must scope the call to the connected database.
 * - TypeORM emits `tinyint` for a declared `boolean` column on MariaDB, so the
 *   live `tinyint` must map back to the portable `boolean` type.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BaseEntity, Column, Entity, Index, PrimaryGeneratedColumn, Table } from 'typeorm';

import { JsailsDataSource } from '../../src/database/data-source.js';
import { reconcileDataSource } from '../../src/migrations/reconciler.js';

const HAS_DB = process.env.JSAILS_LIVE_DB === '1';

@Entity('verify_accounts')
class Account extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 255, nullable: false })
  @Index({ unique: true })
  email!: string;

  @Column({ type: 'boolean', nullable: false, default: true })
  active!: boolean;

  @Column({ type: 'text', nullable: true })
  bio!: string | null;
}

test('live MariaDB: declared schema reconciles to up-to-date', { skip: !HAS_DB }, async () => {
  const ds = new JsailsDataSource({
    type: 'mariadb',
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT ?? 3306),
    username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    entities: [Account],
  });
  await ds.initialize();
  try {
    const qr = ds.createQueryRunner();
    try {
      await qr.query('DROP TABLE IF EXISTS verify_accounts');
      await qr.createTable(Table.create(ds.entityMetadatas[0]!, ds.driver));
    } finally {
      await qr.release();
    }

    // Introspection must not throw on the unfiltered `getTables()` path.
    const live = await ds.getLiveSchema();
    const table = live.tables.find((t) => t.name === 'verify_accounts');
    assert.ok(table, 'live table must be introspected');
    const active = table.columns.find((c) => c.name === 'active');
    assert.equal(active?.type, 'boolean', 'MariaDB tinyint must map back to boolean');

    const plan = await reconcileDataSource(ds);
    assert.deepStrictEqual(
      plan.operations.map((op) => op.kind),
      [],
      'declared schema should match live MariaDB exactly',
    );
    assert.equal(plan.upToDate, true);
  } finally {
    const qr = ds.createQueryRunner();
    await qr.query('DROP TABLE IF EXISTS verify_accounts').catch(() => undefined);
    await qr.release();
    await ds.destroy();
  }
});
