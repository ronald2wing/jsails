/**
 * The database-backed feature flag store is exercised against a real on-disk
 * sql.js database (the actual WASM build TypeORM loads internally), with the
 * `jsails_feature_flag` table created by the real migration history — never by
 * runtime DDL. Also covers the portable schema/migration the entity produces,
 * fail-closed behavior on a missing table or uninitialized data source, scope
 * isolation, and the value-free error guarantee.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { JsailsDataSource } from '../../src/database/data-source.js';
import {
  FeatureFlagError,
  createDatabaseFeatureFlagStore,
  FEATURE_FLAG_TABLE,
  featureFlagEntities,
  JsailsFeatureFlag,
} from '../../src/flags/index.js';
import { generateMigration } from '../../src/migrations/autodetector.js';
import { replayMigrationHistory } from '../../src/migrations/history.js';
import { migrate, type MigrationDataSource } from '../../src/migrations/migrator.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'flags-db-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Mirror the CLI's structural cast: the runner's narrow contract predates sqljs. */
function asMigrationDataSource(dataSource: JsailsDataSource): MigrationDataSource {
  return dataSource as unknown as MigrationDataSource;
}

/** Initialize a file-backed data source and apply the entity migration. */
async function migratedDataSource(location: string): Promise<JsailsDataSource> {
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location,
    entities: [JsailsFeatureFlag],
  });
  await dataSource.initialize();

  const schema = await dataSource.getModelSchema();
  const migration = generateMigration('create_jsails_feature_flag', [], schema);
  assert.ok(migration, 'expected a create_jsails_feature_flag migration');
  await migrate(asMigrationDataSource(dataSource), [migration]);
  return dataSource;
}

const EXPECTED_COLUMNS = [
  { name: 'id', type: 'integer', nullable: false, primaryKey: true },
  { name: 'key', type: 'varchar', length: 190, nullable: false },
  { name: 'scope', type: 'varchar', length: 190, nullable: false },
  { name: 'updatedAt', type: 'datetime', nullable: false },
  { name: 'value', type: 'boolean', nullable: false },
];

describe('JsailsFeatureFlag: portable schema and migration', () => {
  it('builds the expected portable schema offline without connecting', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'schema.db'),
      entities: [JsailsFeatureFlag],
    });
    const schema = await dataSource.getModelSchema();

    assert.equal(dataSource.isInitialized, false);
    assert.deepEqual(schema, { tables: [{ name: FEATURE_FLAG_TABLE, columns: EXPECTED_COLUMNS }] });
  });

  it('emits a single create_table operation with the expected scalar columns', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'migration.db'),
      entities: [JsailsFeatureFlag],
    });
    const schema = await dataSource.getModelSchema();
    const migration = generateMigration('create_jsails_feature_flag', [], schema);

    assert.ok(migration, 'expected a create_jsails_feature_flag migration');
    assert.deepEqual(migration.dependencies, []);
    assert.equal(migration.operations.length, 1);

    const operation = migration.operations[0];
    assert.ok(operation, 'expected a create_table operation');
    if (operation.kind !== 'create_table') {
      throw new Error('unreachable: operation is not create_table');
    }
    assert.equal(operation.table.name, FEATURE_FLAG_TABLE);
    assert.deepEqual(operation.table.columns, EXPECTED_COLUMNS);

    assert.deepEqual(replayMigrationHistory([migration]), schema);
  });

  it('is the only entity in featureFlagEntities', () => {
    assert.deepEqual(featureFlagEntities, [JsailsFeatureFlag]);
  });
});

describe('createDatabaseFeatureFlagStore: round-trip', () => {
  it('stores and retrieves a flag through the ORM repository', async () => {
    const dataSource = await migratedDataSource(join(tmpRoot, 'roundtrip.db'));
    const store = createDatabaseFeatureFlagStore({ dataSource });

    assert.equal(await store.get('new-checkout'), null);

    await store.set('new-checkout', true);
    assert.equal(await store.get('new-checkout'), true);

    await store.set('new-checkout', false);
    assert.equal(await store.get('new-checkout'), false);

    await dataSource.destroy();
  });

  it('upserts by key + scope, keeping one row per flag', async () => {
    const dataSource = await migratedDataSource(join(tmpRoot, 'upsert.db'));
    const store = createDatabaseFeatureFlagStore({ dataSource });
    const repository = dataSource.getRepository(JsailsFeatureFlag);

    await store.set('beta', true);
    await store.set('beta', false);

    assert.equal(await repository.count(), 1);
    assert.equal(await store.get('beta'), false);

    await dataSource.destroy();
  });

  it('isolates the global scope from scoped namespaces', async () => {
    const dataSource = await migratedDataSource(join(tmpRoot, 'scope.db'));
    const store = createDatabaseFeatureFlagStore({ dataSource });

    await store.set('beta', true);
    await store.set('beta', true, 'user-1');
    await store.set('beta', false, 'user-2');

    assert.equal(await store.get('beta'), true);
    assert.equal(await store.get('beta', 'user-1'), true);
    assert.equal(await store.get('beta', 'user-2'), false);
    assert.equal(await store.get('beta', 'user-3'), null);

    assert.deepEqual(await store.all(), { beta: true });
    assert.deepEqual(await store.all('user-2'), { beta: false });

    await dataSource.destroy();
  });

  it('lists every flag in a scope and deletes by key + scope', async () => {
    const dataSource = await migratedDataSource(join(tmpRoot, 'all.db'));
    const store = createDatabaseFeatureFlagStore({ dataSource });
    const repository = dataSource.getRepository(JsailsFeatureFlag);

    await store.set('a', true);
    await store.set('b', false);
    await store.set('a', true, 'user-1');

    assert.deepEqual(await store.all(), { a: true, b: false });
    assert.deepEqual(await store.all('user-1'), { a: true });

    await store.delete('a');
    assert.equal(await store.get('a'), null);
    assert.equal(await store.get('a', 'user-1'), true, 'the scoped flag is untouched');
    assert.equal(await repository.count(), 2);

    await dataSource.destroy();
  });

  it('rejects an invalid key or value before writing anything', async () => {
    const dataSource = await migratedDataSource(join(tmpRoot, 'invalid.db'));
    const store = createDatabaseFeatureFlagStore({ dataSource });
    const repository = dataSource.getRepository(JsailsFeatureFlag);

    await assert.rejects(store.set('', true), FeatureFlagError);
    await assert.rejects(store.set('ok', 'yes' as never), FeatureFlagError);
    assert.equal(await repository.count(), 0);

    await dataSource.destroy();
  });
});

describe('createDatabaseFeatureFlagStore: missing table', () => {
  it('fails with a clear error when the table was never migrated', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'missing.db'),
      entities: [JsailsFeatureFlag],
    });
    await dataSource.initialize();

    const store = createDatabaseFeatureFlagStore({ dataSource });
    await assert.rejects(async () => store.get('x'), /makemigrations|migrate/);
    await assert.rejects(async () => store.set('x', true), /makemigrations|migrate/);
    await assert.rejects(async () => store.delete('x'), /makemigrations|migrate/);
    await assert.rejects(async () => store.all(), /makemigrations|migrate/);

    await dataSource.destroy();
  });

  it('fails on an uninitialized data source without querying', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'uninitialized.db'),
      entities: [JsailsFeatureFlag],
    });

    const store = createDatabaseFeatureFlagStore({ dataSource });
    assert.equal(dataSource.isInitialized, false, 'construction opens no connection');
    await assert.rejects(async () => store.get('x'), /must be initialized/);
  });
});
