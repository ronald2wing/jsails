import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueryRunner, Table } from 'typeorm';
import { RESERVED_MIGRATIONS_TABLE } from '../../src/database/model-schema.js';
import type { SchemaEditorDriver } from '../../src/database/schema-editor.js';
import {
  type DataMigration,
  defineDataMigration,
  createDataMigrationRegistry,
} from '../../src/migrations/data.js';
import type { MigrationDefinition } from '../../src/migrations/history.js';
import {
  MigrationError,
  type ColumnDefinition,
  type TableDefinition,
} from '../../src/migrations/schema-state.js';
import { migrate, rollbackTo } from '../../src/migrations/migrator.js';

// ---------------------------------------------------------------------------
// Test infrastructure (mirrors migration-runner.test.ts)
// ---------------------------------------------------------------------------

interface FakeRow {
  name: string;
  checksum: string;
  status: string;
  kind: string;
}

class FakeDb {
  tableExists = false;
  rows: FakeRow[] = [];
}

type FailPredicate = (method: string, args: unknown[]) => Error | null;

class FakeQueryRunner {
  readonly calls: { method: string; args: unknown[] }[] = [];
  released = false;

  constructor(
    private readonly db: FakeDb,
    private readonly fail: FailPredicate,
  ) {}

  async connect(): Promise<void> {
    this.calls.push({ method: 'connect', args: [] });
  }

  async release(): Promise<void> {
    this.released = true;
    this.calls.push({ method: 'release', args: [] });
  }

  async hasTable(name: string): Promise<boolean> {
    this.calls.push({ method: 'hasTable', args: [name] });
    return this.db.tableExists;
  }

  async createTable(table: Table, ...rest: unknown[]): Promise<void> {
    this.calls.push({ method: 'createTable', args: [table, ...rest] });
    const error = this.fail('createTable', [table, ...rest]);
    if (error) throw error;
    if (table.name === RESERVED_MIGRATIONS_TABLE) {
      this.db.tableExists = true;
    }
  }

  async startTransaction(): Promise<void> {
    this.calls.push({ method: 'startTransaction', args: [] });
  }

  async commitTransaction(): Promise<void> {
    this.calls.push({ method: 'commitTransaction', args: [] });
  }

  async rollbackTransaction(): Promise<void> {
    this.calls.push({ method: 'rollbackTransaction', args: [] });
  }

  async query(sql: string, parameters?: unknown[], _structured?: unknown): Promise<unknown> {
    this.calls.push({ method: 'query', args: [sql, parameters] });
    const error = this.fail('query', [sql, parameters]);
    if (error) throw error;

    if (sql.includes('pg_try_advisory_lock')) {
      return { records: [{ acquired: true }] };
    }
    if (sql.includes('pg_advisory_unlock')) {
      return { records: [] };
    }
    if (sql.includes('GET_LOCK')) {
      return { records: [{ acquired: 1 }] };
    }
    if (sql.includes('RELEASE_LOCK')) {
      return { records: [] };
    }
    if (sql.startsWith('SELECT name, checksum, status, kind')) {
      return { records: this.db.rows.map((row) => ({ ...row })) };
    }
    if (sql.startsWith('INSERT INTO')) {
      const [name, checksum, status, kind] = parameters as [string, string, string, string];
      this.db.rows.push({ name, checksum, status, kind });
      return { records: [] };
    }
    if (sql.startsWith('UPDATE')) {
      const [status, name] = parameters as [string, string];
      const row = this.db.rows.find((candidate) => candidate.name === name);
      if (row) row.status = status;
      return { records: [] };
    }
    if (sql.startsWith('DELETE FROM')) {
      const [name] = parameters as [string];
      const index = this.db.rows.findIndex((candidate) => candidate.name === name);
      if (index !== -1) this.db.rows.splice(index, 1);
      return { records: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }

  async dropTable(...args: unknown[]): Promise<void> {
    await this.schemaCall('dropTable', args);
  }

  async addColumn(...args: unknown[]): Promise<void> {
    await this.schemaCall('addColumn', args);
  }

  async dropColumn(...args: unknown[]): Promise<void> {
    await this.schemaCall('dropColumn', args);
  }

  async renameColumn(...args: unknown[]): Promise<void> {
    await this.schemaCall('renameColumn', args);
  }

  async changeColumn(...args: unknown[]): Promise<void> {
    await this.schemaCall('changeColumn', args);
  }

  async createForeignKey(...args: unknown[]): Promise<void> {
    await this.schemaCall('createForeignKey', args);
  }

  async dropForeignKey(...args: unknown[]): Promise<void> {
    await this.schemaCall('dropForeignKey', args);
  }

  private async schemaCall(method: string, args: unknown[]): Promise<void> {
    this.calls.push({ method, args });
    const error = this.fail(method, args);
    if (error) throw error;
  }
}

class FakeDataSource {
  isInitialized = true;
  readonly options = { database: 'testdb' };
  readonly runners: FakeQueryRunner[] = [];

  constructor(
    readonly jsailsDriver: SchemaEditorDriver,
    readonly db: FakeDb,
    public fail: FailPredicate = () => null,
  ) {}

  createQueryRunner(): QueryRunner {
    const runner = new FakeQueryRunner(this.db, this.fail);
    this.runners.push(runner);
    return runner as unknown as QueryRunner;
  }
}

function pk(name = 'id'): ColumnDefinition {
  return { name, type: 'integer', nullable: false, primaryKey: true };
}

function table(name: string, ...columns: ColumnDefinition[]): TableDefinition {
  return { name, columns };
}

function createSchemaMigration(): MigrationDefinition {
  return {
    name: 'create_users',
    dependencies: [],
    operations: [{ kind: 'create_table', table: table('users', pk()) }],
  };
}

function createDataMigrationDef(): MigrationDefinition {
  return {
    name: 'backfill_emails',
    dependencies: ['create_users'],
    operations: [],
    kind: 'data',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('defineDataMigration', () => {
  it('creates a data migration with up and down handlers', () => {
    const dm = defineDataMigration({
      name: 'backfill',
      up: async () => {},
      down: async () => {},
    });
    assert.equal(dm.name, 'backfill');
    assert.equal(typeof dm.up, 'function');
    assert.equal(typeof dm.down, 'function');
  });

  it('rejects invalid identifiers', () => {
    assert.throws(
      () =>
        defineDataMigration({
          name: 'bad name',
          up: async () => {},
          down: async () => {},
        }),
      MigrationError,
    );
  });
});

describe('createDataMigrationRegistry', () => {
  it('validates and indexes data migrations by name', () => {
    const a = defineDataMigration({
      name: 'a',
      up: () => Promise.resolve(),
      down: () => Promise.resolve(),
    });
    const b = defineDataMigration({
      name: 'b',
      up: () => Promise.resolve(),
      down: () => Promise.resolve(),
    });
    const registry = createDataMigrationRegistry({ a, b });
    assert.equal(registry.size, 2);
  });

  it('rejects a key that does not match the migration name', () => {
    const a = defineDataMigration({
      name: 'real',
      up: () => Promise.resolve(),
      down: () => Promise.resolve(),
    });
    assert.throws(() => createDataMigrationRegistry({ wrong: a }), /does not match/);
  });

  it('rejects duplicate names', () => {
    const a = defineDataMigration({
      name: 'dup',
      up: () => Promise.resolve(),
      down: () => Promise.resolve(),
    });
    // Use a type assertion so we can supply entries with different keys but the
    // same DataMigration object; the duplicate check fires on the name before
    // the key/name mismatch check.
    assert.throws(() => createDataMigrationRegistry({ dup: a, other_key: a }), /duplicate/);
  });

  it('rejects a migration without an up function', () => {
    assert.throws(
      () =>
        createDataMigrationRegistry({
          bad: { name: 'bad', down: () => Promise.resolve() } as unknown as DataMigration,
        }),
      /"up" function/,
    );
  });

  it('rejects a migration without a down function', () => {
    assert.throws(
      () =>
        createDataMigrationRegistry({
          bad: { name: 'bad', up: () => Promise.resolve() } as unknown as DataMigration,
        }),
      /"down" function/,
    );
  });
});

describe('migrate: data migration apply', () => {
  it('executes the up handler for a data migration and records kind=data', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());
    let upCalled = false;

    const dm = defineDataMigration({
      name: 'backfill_emails',
      up: async () => {
        upCalled = true;
      },
      down: async () => {},
    });
    const registry = new Map([['backfill_emails', dm]]);
    const history = [createSchemaMigration(), createDataMigrationDef()];

    const result = await migrate(ds, history, { dataMigrations: registry });
    assert.deepEqual(result.applied, ['create_users', 'backfill_emails']);
    assert.ok(upCalled);

    const dataRow = ds.db.rows.find((row) => row.name === 'backfill_emails');
    assert.ok(dataRow);
    assert.equal(dataRow.kind, 'data');
    assert.equal(dataRow.status, 'applied');
  });

  it('throws when a data migration is not in the registry', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());
    const history = [createSchemaMigration(), createDataMigrationDef()];

    // Validation happens before any database work — no data migration registry
    // means the data migration in the history is rejected immediately.
    await assert.rejects(migrate(ds, history), /not registered/);
  });
});

describe('migrate: data migration on mysql/mariadb with dirty tracking', () => {
  it('applies a data migration with the applying-then-applied path on mysql', async () => {
    const ds = new FakeDataSource('mysql', new FakeDb());
    let upCalled = false;

    const dm = defineDataMigration({
      name: 'backfill_emails',
      up: async () => {
        upCalled = true;
      },
      down: async () => {},
    });
    const registry = new Map([['backfill_emails', dm]]);
    const history = [createSchemaMigration(), createDataMigrationDef()];

    await migrate(ds, history, { dataMigrations: registry });
    assert.ok(upCalled);
    const row = ds.db.rows.find((row) => row.name === 'backfill_emails');
    assert.ok(row);
    assert.equal(row.status, 'applied');
    assert.equal(row.kind, 'data');
  });
});

describe('rollbackTo: data migration rollback', () => {
  it('executes the down handler when rolling back a data migration', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());
    let downCalled = false;

    const dm = defineDataMigration({
      name: 'backfill_emails',
      up: async () => {},
      down: async () => {
        downCalled = true;
      },
    });
    const registry = new Map([['backfill_emails', dm]]);
    const history = [createSchemaMigration(), createDataMigrationDef()];

    await migrate(ds, history, { dataMigrations: registry });
    const result = await rollbackTo(ds, history, { targetName: 'create_users' }, registry);
    assert.deepEqual(result.unapplied, ['backfill_emails']);
    assert.ok(downCalled);

    const remaining = ds.db.rows.find((row) => row.name === 'backfill_emails');
    assert.equal(remaining, undefined);
  });

  it('refuses rollback when a data migration has no down handler', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());

    const dmNoDown = defineDataMigration({
      name: 'backfill_emails',
      up: async () => {},
      down: async () => {},
    });
    // We override down after registration — this simulates a missing down.
    const corrupted = { ...dmNoDown, down: undefined as unknown as DataMigration['down'] };
    const registry = new Map([['backfill_emails', corrupted]]);

    const history = [createSchemaMigration(), createDataMigrationDef()];
    await migrate(ds, history, { dataMigrations: registry });

    await assert.rejects(
      rollbackTo(ds, history, { targetName: 'create_users' }, registry),
      /no "down" handler/,
    );
  });

  it('refuses rollback when a data migration is not in the registry on rollback', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());

    const dm = defineDataMigration({
      name: 'backfill_emails',
      up: async () => {},
      down: async () => {},
    });
    const registry = new Map([['backfill_emails', dm]]);
    const history = [createSchemaMigration(), createDataMigrationDef()];

    await migrate(ds, history, { dataMigrations: registry });

    // Rollback without the registry
    await assert.rejects(rollbackTo(ds, history, { targetName: 'create_users' }), /not registered/);
  });
});

describe('migrate: fake and fake-initial', () => {
  it('--fake records migrations without executing operations', async () => {
    const db = new FakeDb();
    db.tableExists = true; // skip tracking-table creation (which itself is a DDL call)
    const ds = new FakeDataSource('postgres', db);
    const history = [createSchemaMigration()];

    const result = await migrate(ds, history, { fake: true });
    assert.deepEqual(result.applied, ['create_users']);

    const row = ds.db.rows[0] as FakeRow;
    assert.equal(row.status, 'applied');
    assert.equal(row.kind, 'schema');

    // No DDL operations were executed.
    const runner = ds.runners[0] as FakeQueryRunner;
    const ddl = runner.calls.filter((c) =>
      ['createTable', 'addColumn', 'dropColumn'].includes(c.method),
    );
    assert.equal(ddl.length, 0, 'no DDL operations in fake mode');
  });

  it('--fake-initial records only the first migration', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());
    const second: MigrationDefinition = {
      name: 'add_email',
      dependencies: ['create_users'],
      operations: [
        {
          kind: 'add_column',
          table: 'users',
          column: { name: 'email', type: 'varchar', length: 100, nullable: true },
        },
      ],
    };
    const history = [createSchemaMigration(), second];

    const result = await migrate(ds, history, { fakeInitial: true });
    assert.deepEqual(result.applied, ['create_users', 'add_email']);

    const runner = ds.runners[0] as FakeQueryRunner;
    // The first migration should not have created the users table
    const userCreate = runner.calls.filter(
      (c) => c.method === 'createTable' && (c.args[0] as Table).name === 'users',
    );
    assert.equal(userCreate.length, 0, 'first migration was faked');

    // The second migration should have been executed
    const addCol = runner.calls.filter((c) => c.method === 'addColumn');
    assert.ok(addCol.length > 0, 'second migration was executed');
  });

  it('--fake and --fake-initial are mutually exclusive', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());
    await assert.rejects(
      migrate(ds, [createSchemaMigration()], { fake: true, fakeInitial: true }),
      /mutually exclusive/,
    );
  });

  it('--fake-initial on a non-empty tracking table is a no-op for fake', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());
    const first: MigrationDefinition = {
      name: 'first',
      dependencies: [],
      operations: [{ kind: 'create_table', table: table('t1', pk()) }],
    };
    const second: MigrationDefinition = {
      name: 'second',
      dependencies: ['first'],
      operations: [{ kind: 'create_table', table: table('t2', pk()) }],
    };

    // Apply first without fake
    await migrate(ds, [first]);

    // fake-initial should not affect the second migration (table is not empty)
    const result = await migrate(ds, [first, second], { fakeInitial: true });
    assert.deepEqual(result.applied, ['second']);

    const runner = ds.runners[1] as FakeQueryRunner;
    const t2Create = runner.calls.filter(
      (c) => c.method === 'createTable' && (c.args[0] as Table).name === 't2',
    );
    assert.ok(t2Create.length > 0, 'second migration was not faked');
  });
});
