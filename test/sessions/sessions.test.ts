import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { Session } from '../../src/contracts/http.js';
import { JsailsDataSource } from '../../src/database/data-source.js';
import { diffSchemaStates } from '../../src/migrations/autodetector.js';
import { applyOperations } from '../../src/migrations/operations.js';
import { executeSchemaPlan } from '../../src/migrations/schema-executor.js';
import { JsailsSession, SESSION_TABLE, sessionEntities } from '../../src/sessions/entity.js';
import { SessionStoreError, DatabaseSessionStoreImpl } from '../../src/sessions/stores.js';

/**
 * The database-backed session store is exercised against a real on-disk sql.js
 * database (the actual WASM build TypeORM loads internally), with the
 * `jsails_session` table created by the declarative schema plan — never by
 * runtime DDL.
 */

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'sessions-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Initialize a file-backed data source and apply the entity schema. */
async function migratedDataSource(location: string): Promise<JsailsDataSource> {
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location,
    entities: [JsailsSession],
  });
  await dataSource.initialize();

  const schema = await dataSource.getModelSchema();
  const operations = diffSchemaStates({ tables: [] }, schema);
  await executeSchemaPlan(dataSource, operations);
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
    const operations = diffSchemaStates({ tables: [] }, schema);

    assert.equal(operations.length, 1);

    const operation = operations[0];
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

    assert.deepEqual(applyOperations({ tables: [] }, operations), schema);
  });

  it('is the only entity in sessionEntities', () => {
    assert.deepEqual(sessionEntities, [JsailsSession]);
  });
});

describe('DatabaseSessionStoreImpl: round-trip', () => {
  it('stores and retrieves a session through the ORM repository', async () => {
    const dataSource = await migratedDataSource(join(tmpRoot, 'roundtrip.db'));
    const store = new DatabaseSessionStoreImpl({ dataSource });

    assert.equal(await store.get('session-id'), null);

    const value = session();
    await store.set(value);
    assert.deepEqual(await store.get('session-id'), value);

    await dataSource.destroy();
  });

  it('upserts by session id, preserving createdAt on update', async () => {
    const dataSource = await migratedDataSource(join(tmpRoot, 'upsert.db'));
    const store = new DatabaseSessionStoreImpl({ dataSource });
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
    const store = new DatabaseSessionStoreImpl({ dataSource });

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
    const store = new DatabaseSessionStoreImpl({ dataSource, now: () => current });
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
    const store = new DatabaseSessionStoreImpl({ dataSource, now: () => 1000 });

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
    const store = new DatabaseSessionStoreImpl({ dataSource });
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
    const store = new DatabaseSessionStoreImpl({ dataSource });

    await assert.rejects(
      async () => store.set(session({ id: '', csrfToken: 'c' })),
      SessionStoreError,
    );
    assert.equal(await dataSource.getRepository(JsailsSession).count(), 0);

    await dataSource.destroy();
  });
});

describe('DatabaseSessionStoreImpl: missing table', () => {
  it('fails with a clear error when the table was never migrated', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'missing.db'),
      entities: [JsailsSession],
    });
    await dataSource.initialize();

    const store = new DatabaseSessionStoreImpl({ dataSource });
    await assert.rejects(async () => store.get('x'), /db:push/);
    await assert.rejects(async () => store.set(session()), /db:push/);
    await assert.rejects(async () => store.delete('x'), /db:push/);
    await assert.rejects(async () => store.pruneExpired(), /db:push/);

    await dataSource.destroy();
  });

  it('fails on an uninitialized data source without querying', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'uninitialized.db'),
      entities: [JsailsSession],
    });

    const store = new DatabaseSessionStoreImpl({ dataSource });
    await assert.rejects(async () => store.get('x'), /must be initialized/);
  });
});
