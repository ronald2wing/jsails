import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { Session } from '../../src/contracts/http.js';
import { JsailsDataSource } from '../../src/database/data-source.js';
import { generateMigration } from '../../src/migrations/autodetector.js';
import { replayMigrationHistory } from '../../src/migrations/history.js';
import { migrate, type MigrationDataSource } from '../../src/migrations/migrator.js';
import { JsailsSession, SESSION_TABLE, sessionEntities } from '../../src/sessions/entity.js';
import { SessionStoreError, createDatabaseSessionStore } from '../../src/sessions/stores.js';

/**
 * The database-backed session store is exercised against a real on-disk sql.js
 * database (the actual WASM build TypeORM loads internally), with the
 * `jsails_session` table created by the real migration history — never by
 * runtime DDL.
 */

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'sessions-'));

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
    entities: [JsailsSession],
  });
  await dataSource.initialize();

  const schema = await dataSource.getModelSchema();
  const migration = generateMigration('create_jsails_session', [], schema);
  assert.ok(migration, 'expected a create_jsails_session migration');
  await migrate(asMigrationDataSource(dataSource), [migration]);
  return dataSource;
}

/** A fresh, well-formed session for round-trip tests. */
function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-id',
    csrfToken: 'csrf-token',
    data: { user: 'alice' },
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe('JsailsSession: portable schema and migration', () => {
  it('builds the expected portable schema offline without connecting', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'schema.db'),
      entities: [JsailsSession],
    });
    const schema = await dataSource.getModelSchema();

    assert.equal(dataSource.isInitialized, false);
    assert.deepEqual(schema, {
      tables: [
        {
          name: SESSION_TABLE,
          columns: [
            { name: 'id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'createdAt', type: 'datetime', nullable: false },
            { name: 'data', type: 'text', nullable: false },
            { name: 'expiresAt', type: 'datetime', nullable: false },
            { name: 'sessionId', type: 'varchar', length: 190, nullable: false },
          ],
        },
      ],
    });
  });

  it('emits a single create_table operation with the expected scalar columns', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'migration.db'),
      entities: [JsailsSession],
    });
    const schema = await dataSource.getModelSchema();
    const migration = generateMigration('create_jsails_session', [], schema);

    assert.ok(migration, 'expected a create_jsails_session migration');
    assert.deepEqual(migration.dependencies, []);
    assert.equal(migration.operations.length, 1);

    const operation = migration.operations[0];
    assert.ok(operation, 'expected a create_table operation');
    if (operation.kind !== 'create_table') {
      throw new Error('unreachable: operation is not create_table');
    }
    assert.equal(operation.table.name, SESSION_TABLE);
    assert.deepEqual(operation.table.columns, [
      { name: 'id', type: 'integer', nullable: false, primaryKey: true },
      { name: 'createdAt', type: 'datetime', nullable: false },
      { name: 'data', type: 'text', nullable: false },
      { name: 'expiresAt', type: 'datetime', nullable: false },
      { name: 'sessionId', type: 'varchar', length: 190, nullable: false },
    ]);

    assert.deepEqual(replayMigrationHistory([migration]), schema);
  });

  it('is the only entity in sessionEntities', () => {
    assert.deepEqual(sessionEntities, [JsailsSession]);
  });
});

describe('createDatabaseSessionStore: round-trip', () => {
  it('stores and retrieves a session through the ORM repository', async () => {
    const dataSource = await migratedDataSource(join(tmpRoot, 'roundtrip.db'));
    const store = createDatabaseSessionStore({ dataSource });

    assert.equal(await store.get('session-id'), null);

    const value = session();
    await store.set(value);
    assert.deepEqual(await store.get('session-id'), value);

    await dataSource.destroy();
  });

  it('upserts by session id, preserving createdAt on update', async () => {
    const dataSource = await migratedDataSource(join(tmpRoot, 'upsert.db'));
    const store = createDatabaseSessionStore({ dataSource });
    const repository = dataSource.getRepository(JsailsSession);
    const now = Date.now();

    await store.set(session({ id: 's1', csrfToken: 'c1', data: { n: 1 }, expiresAt: now + 1000 }));
    const first = await repository.findOneByOrFail({ sessionId: 's1' });

    await store.set(session({ id: 's1', csrfToken: 'c2', data: { n: 2 }, expiresAt: now + 2000 }));

    assert.equal(await repository.count(), 1);
    const after = await repository.findOneByOrFail({ sessionId: 's1' });
    assert.equal(after.createdAt.getTime(), first.createdAt.getTime());

    const stored = await store.get('s1');
    assert.equal(stored?.csrfToken, 'c2');
    assert.deepEqual(stored?.data, { n: 2 });
    assert.equal(stored?.expiresAt, now + 2000);

    await dataSource.destroy();
  });

  it('deletes a session by id', async () => {
    const dataSource = await migratedDataSource(join(tmpRoot, 'delete.db'));
    const store = createDatabaseSessionStore({ dataSource });

    await store.set(session({ id: 'd1' }));
    assert.notEqual(await store.get('d1'), null);

    await store.delete('d1');
    assert.equal(await store.get('d1'), null);
    assert.equal(await dataSource.getRepository(JsailsSession).count(), 0);

    await dataSource.destroy();
  });

  it('returns null and lazily deletes expired rows against an injected clock', async () => {
    const dataSource = await migratedDataSource(join(tmpRoot, 'expiry.db'));
    let current = 1000;
    const store = createDatabaseSessionStore({ dataSource, now: () => current });
    const value = session({ id: 'expires', expiresAt: 2000 });

    await store.set(value);

    current = 1999;
    assert.deepEqual(await store.get('expires'), value);

    current = 2000;
    assert.equal(await store.get('expires'), null);
    assert.equal(await dataSource.getRepository(JsailsSession).count(), 0);

    await dataSource.destroy();
  });

  it('prunes expired rows in bulk and leaves future sessions intact', async () => {
    const dataSource = await migratedDataSource(join(tmpRoot, 'prune.db'));
    const store = createDatabaseSessionStore({ dataSource, now: () => 1000 });

    await store.set(session({ id: 'e1', expiresAt: 1000 }));
    await store.set(session({ id: 'e2', expiresAt: 500 }));
    await store.set(session({ id: 'future', expiresAt: 5000 }));

    assert.equal(await store.pruneExpired(), 2);
    assert.equal(await store.get('e1'), null);
    assert.equal(await store.get('e2'), null);
    assert.notEqual(await store.get('future'), null);

    await dataSource.destroy();
  });

  it('rejects a malformed stored row without echoing its contents', async () => {
    const dataSource = await migratedDataSource(join(tmpRoot, 'malformed.db'));
    const store = createDatabaseSessionStore({ dataSource });
    const repository = dataSource.getRepository(JsailsSession);

    await repository.save({
      sessionId: 'bad-json',
      data: 'this is not json',
      expiresAt: new Date(9000),
      createdAt: new Date(),
    });
    await assert.rejects(
      async () => store.get('bad-json'),
      (error: unknown) =>
        error instanceof SessionStoreError && !error.message.includes('this is not json'),
    );

    // A row whose stored id disagrees with its sessionId column is also malformed.
    await repository.save({
      sessionId: 'mismatch',
      data: JSON.stringify({ id: 'other', csrfToken: 'c', data: {}, expiresAt: 9000 }),
      expiresAt: new Date(9000),
      createdAt: new Date(),
    });
    await assert.rejects(async () => store.get('mismatch'), SessionStoreError);

    await dataSource.destroy();
  });

  it('rejects an invalid session before writing anything', async () => {
    const dataSource = await migratedDataSource(join(tmpRoot, 'invalid.db'));
    const store = createDatabaseSessionStore({ dataSource });

    await assert.rejects(
      async () => store.set(session({ id: '', csrfToken: 'c' })),
      SessionStoreError,
    );
    assert.equal(await dataSource.getRepository(JsailsSession).count(), 0);

    await dataSource.destroy();
  });
});

describe('createDatabaseSessionStore: missing table', () => {
  it('fails with a clear error when the table was never migrated', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'missing.db'),
      entities: [JsailsSession],
    });
    await dataSource.initialize();

    const store = createDatabaseSessionStore({ dataSource });
    await assert.rejects(async () => store.get('x'), /makemigrations|migrate/);
    await assert.rejects(async () => store.set(session()), /makemigrations|migrate/);
    await assert.rejects(async () => store.delete('x'), /makemigrations|migrate/);
    await assert.rejects(async () => store.pruneExpired(), /makemigrations|migrate/);

    await dataSource.destroy();
  });

  it('fails on an uninitialized data source without querying', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'uninitialized.db'),
      entities: [JsailsSession],
    });

    const store = createDatabaseSessionStore({ dataSource });
    await assert.rejects(async () => store.get('x'), /must be initialized/);
  });
});
