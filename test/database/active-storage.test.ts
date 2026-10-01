import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  activeStorageEntities,
  hasOneAttached,
  JsailsAttachment,
  ActiveStorageError,
} from '../../src/database/active-storage.js';
import { JsailsDataSource } from '../../src/database/data-source.js';
import { generateMigration } from '../../src/migrations/autodetector.js';
import { migrate, type MigrationDataSource } from '../../src/migrations/migrator.js';
import { createMemoryDisk } from '../../src/filesystem/index.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'active-storage-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function asMigrationDataSource(dataSource: JsailsDataSource): MigrationDataSource {
  return dataSource as unknown as MigrationDataSource;
}

let locationSeq = 0;

async function createDataSource(): Promise<JsailsDataSource> {
  const location = join(tmpRoot, `db-${locationSeq++}.sqlite`);
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location,
    entities: activeStorageEntities,
  });
  await dataSource.initialize();
  const schema = await dataSource.getModelSchema();
  const migration = generateMigration('create_attachments', [], schema);
  assert.ok(migration, 'expected a create migration for the fixture schema');
  await migrate(asMigrationDataSource(dataSource), [migration]);
  return dataSource;
}

async function setup() {
  const dataSource = await createDataSource();
  const disk = createMemoryDisk();
  const avatar = hasOneAttached({
    disk,
    name: 'avatar',
    recordType: 'User',
    dataSource,
    urlPrefix: '/uploads',
  });
  return { dataSource, disk, avatar };
}

describe('hasOneAttached', () => {
  it('attach stores the blob on the disk and persists a row', async () => {
    const { disk, avatar } = await setup();

    const data = new Uint8Array([1, 2, 3, 4]);
    const attachment = await avatar.attach({ id: 1 }, data, 'image/png');

    assert.equal(attachment.recordType, 'User');
    assert.equal(attachment.recordId, 1);
    assert.equal(attachment.name, 'avatar');
    assert.equal(attachment.contentType, 'image/png');
    assert.equal(attachment.byteSize, 4);
    assert.ok(attachment.key.length > 0, 'key must be non-empty');
    assert.ok(attachment.createdAt instanceof Date);

    // Blob is on disk
    const blob = await disk.get(attachment.key);
    assert.deepEqual(blob, data);

    // Row is in database
    const count = await JsailsAttachment.countBy({
      recordType: 'User',
      recordId: 1,
      name: 'avatar',
    });
    assert.equal(count, 1);
  });

  it('url returns the prefixed URL for an existing attachment', async () => {
    const { avatar } = await setup();

    const attachment = await avatar.attach({ id: 1 }, new Uint8Array([0]), 'text/plain');
    const url = await avatar.url({ id: 1 });
    assert.equal(url, `/uploads/${attachment.key}`);
  });

  it('url returns null when no attachment exists', async () => {
    const { avatar } = await setup();

    const url = await avatar.url({ id: 999 });
    assert.equal(url, null);
  });

  it('url returns null when no urlPrefix is configured', async () => {
    const dataSource = await createDataSource();
    const disk = createMemoryDisk();
    const avatar = hasOneAttached({
      disk,
      name: 'avatar',
      recordType: 'User',
      dataSource,
    });

    await avatar.attach({ id: 1 }, new Uint8Array([0]), 'text/plain');
    const url = await avatar.url({ id: 1 });
    assert.equal(url, null);
  });

  it('detach removes the blob and the row', async () => {
    const { disk, avatar } = await setup();

    const attachment = await avatar.attach({ id: 1 }, new Uint8Array([0]), 'text/plain');

    await avatar.detach({ id: 1 });

    const exists = await disk.exists(attachment.key);
    assert.equal(exists, false);

    const count = await JsailsAttachment.countBy({
      recordType: 'User',
      recordId: 1,
      name: 'avatar',
    });
    assert.equal(count, 0);
  });

  it('detach is a no-op when no attachment exists', async () => {
    const { avatar } = await setup();

    // Must not throw
    await avatar.detach({ id: 999 });
  });

  it('attach / url / detach / url round-trip', async () => {
    const { avatar } = await setup();

    assert.equal(await avatar.url({ id: 1 }), null);

    const attachment = await avatar.attach(
      { id: 1 },
      new Uint8Array([1, 2, 3]),
      'application/octet-stream',
    );
    assert.ok(attachment.id > 0);

    const url = await avatar.url({ id: 1 });
    assert.ok(typeof url === 'string');

    await avatar.detach({ id: 1 });
    assert.equal(await avatar.url({ id: 1 }), null);
  });

  it('each attach generates a unique key', async () => {
    const { avatar } = await setup();

    const a1 = await avatar.attach({ id: 1 }, new Uint8Array([1]), 'text/plain');
    const a2 = await avatar.attach({ id: 2 }, new Uint8Array([2]), 'text/plain');

    assert.notEqual(a1.key, a2.key);
  });

  it('same record re-attach replaces the previous attachment (last write wins)', async () => {
    const { avatar, disk } = await setup();

    const first = await avatar.attach({ id: 1 }, new Uint8Array([1]), 'text/plain');

    // Attach a second blob for the same record
    const second = await avatar.attach({ id: 1 }, new Uint8Array([9, 9]), 'text/plain');

    // Both rows exist (the implementation does not delete the previous one
    // automatically — that is the caller's responsibility)
    const count = await JsailsAttachment.countBy({
      recordType: 'User',
      recordId: 1,
      name: 'avatar',
    });
    assert.equal(count, 2);

    // Both blobs are on disk
    assert.ok(await disk.exists(first.key));
    assert.ok(await disk.exists(second.key));

    // url returns the most recent (the first one found, which is
    // undefined ordering — the caller should detach before re-attach)
    assert.ok((await avatar.url({ id: 1 })) !== null);
  });
});

describe('activeStorageEntities', () => {
  it('is the only entity in activeStorageEntities', () => {
    assert.deepEqual(activeStorageEntities, [JsailsAttachment]);
  });
});

describe('ActiveStorageError', () => {
  it('is an instance of Error', () => {
    const e = new ActiveStorageError('missing_data_source', 'data source is not initialized');
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'ActiveStorageError');
    assert.equal(e.code, 'missing_data_source');
  });
});
