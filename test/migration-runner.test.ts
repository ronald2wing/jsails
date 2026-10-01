import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueryRunner, Table } from 'typeorm';
import { RESERVED_MIGRATIONS_TABLE } from '../src/database/model-schema.js';
import type { SchemaEditorDriver } from '../src/database/schema-editor.js';
import type { MigrationDefinition } from '../src/migrations/history.js';
import {
  MigrationError,
  type ColumnDefinition,
  type TableDefinition,
} from '../src/migrations/schema-state.js';
import { getMigrationStatus, migrate } from '../src/migrations/runner.js';

/** In-memory stand-in for the tracking table's persisted state. */
interface FakeRow {
  name: string;
  checksum: string;
  status: string;
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
    if (sql.startsWith('SELECT name, checksum, status')) {
      return { records: this.db.rows.map((row) => ({ ...row })) };
    }
    if (sql.startsWith('INSERT INTO')) {
      const [name, checksum, status] = parameters as [string, string, string];
      this.db.rows.push({ name, checksum, status });
      return { records: [] };
    }
    if (sql.startsWith('UPDATE')) {
      const [status, name] = parameters as [string, string];
      const row = this.db.rows.find((candidate) => candidate.name === name);
      if (row) row.status = status;
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

function createUsersMigration(): MigrationDefinition {
  return {
    name: 'create_users',
    dependencies: [],
    operations: [{ kind: 'create_table', table: table('users', pk()) }],
  };
}

function addEmailMigration(): MigrationDefinition {
  return {
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
}

function callIndex(
  runner: FakeQueryRunner,
  predicate: (call: { method: string; args: unknown[] }) => boolean,
): number {
  return runner.calls.findIndex(predicate);
}

describe('migrate: validation and preflight precede all database work', () => {
  it('rejects a malformed history without creating a query runner', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());
    const bad: MigrationDefinition = {
      name: 'bad',
      dependencies: ['create_users'],
      // varchar without a length is invalid.
      operations: [
        {
          kind: 'add_column',
          table: 'users',
          column: { name: 'x', type: 'varchar', nullable: true },
        },
      ],
    };
    await assert.rejects(migrate(ds, [createUsersMigration(), bad]), MigrationError);
    assert.equal(
      ds.runners.length,
      0,
      'no query runner should be created before validation passes',
    );
  });

  it('rejects an unsupported driver before any database work', async () => {
    const ds = new FakeDataSource('mssql' as SchemaEditorDriver, new FakeDb());
    await assert.rejects(migrate(ds, [createUsersMigration()]), /unsupported schema driver/);
    assert.equal(ds.runners.length, 0);
  });

  it('rejects an uninitialized data source', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());
    ds.isInitialized = false;
    await assert.rejects(migrate(ds, [createUsersMigration()]), /initialized/);
  });
});

describe('migrate: postgres transaction and record ordering', () => {
  it('wraps each migration in a transaction and records it after its operations', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());
    const result = await migrate(ds, [createUsersMigration()]);
    assert.deepEqual(result.applied, ['create_users']);

    const runner = ds.runners[0] as FakeQueryRunner;
    const txStart = callIndex(runner, (c) => c.method === 'startTransaction');
    const userCreate = callIndex(
      runner,
      (c) => c.method === 'createTable' && (c.args[0] as Table).name === 'users',
    );
    const insert = callIndex(
      runner,
      (c) =>
        c.method === 'query' &&
        typeof c.args[0] === 'string' &&
        c.args[0].startsWith('INSERT INTO'),
    );
    const commit = callIndex(runner, (c) => c.method === 'commitTransaction');

    assert.ok(txStart !== -1 && userCreate !== -1 && insert !== -1 && commit !== -1);
    assert.ok(txStart < userCreate, 'transaction starts before DDL');
    assert.ok(userCreate < insert, 'DDL precedes the applied record');
    assert.ok(insert < commit, 'record is written before commit');
    assert.equal(
      callIndex(runner, (c) => c.method === 'rollbackTransaction'),
      -1,
    );

    const insertCall = runner.calls[insert] as { args: unknown[] };
    const params = insertCall.args[1] as [string, string, string];
    assert.equal(params[0], 'create_users');
    assert.equal(params[2], 'applied');
    assert.equal(params[1].length, 64, 'checksum is a sha256 hex digest');
  });

  it('rolls back the transaction and writes no record on operation failure', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());
    ds.fail = (method, args) =>
      method === 'createTable' && (args[0] as Table).name === 'users' ? new Error('boom') : null;

    await assert.rejects(migrate(ds, [createUsersMigration()]), /boom/);

    const runner = ds.runners[0] as FakeQueryRunner;
    assert.ok(callIndex(runner, (c) => c.method === 'rollbackTransaction') !== -1);
    assert.equal(
      callIndex(runner, (c) => c.method === 'commitTransaction'),
      -1,
    );
    assert.equal(ds.db.rows.length, 0, 'no record survives a rolled-back migration');
  });
});

describe('migrate: mysql/mariadb dirty tracking', () => {
  it('leaves an "applying" marker after a failed migration and blocks re-runs', async () => {
    const ds = new FakeDataSource('mysql', new FakeDb());
    ds.fail = (method, args) =>
      method === 'createTable' && (args[0] as Table).name === 'users'
        ? new Error('ddl boom')
        : null;

    await assert.rejects(migrate(ds, [createUsersMigration()]), /ddl boom/);

    assert.equal(ds.db.rows.length, 1);
    assert.equal(ds.db.rows[0]?.name, 'create_users');
    assert.equal(ds.db.rows[0]?.status, 'applying');

    // A re-run must refuse to retry half-applied non-transactional DDL.
    ds.fail = () => null;
    await assert.rejects(migrate(ds, [createUsersMigration()]), /applying/);
    const second = ds.runners[1] as FakeQueryRunner;
    assert.equal(
      callIndex(second, (c) => c.method === 'createTable' && (c.args[0] as Table).name === 'users'),
      -1,
      'the dirty migration must not be retried',
    );
  });

  it('mariadb uses the same applying-then-applied path as mysql', async () => {
    const ds = new FakeDataSource('mariadb', new FakeDb());
    const result = await migrate(ds, [createUsersMigration()]);
    assert.deepEqual(result.applied, ['create_users']);
    assert.equal(ds.db.rows[0]?.status, 'applied');
    const runner = ds.runners[0] as FakeQueryRunner;
    assert.ok(
      runner.calls.some((c) => typeof c.args[0] === 'string' && c.args[0].includes('GET_LOCK')),
    );
  });
});

describe('migrate: sqlite transactional path and no session lock', () => {
  it('wraps each migration in a transaction and records it after its operations', async () => {
    const ds = new FakeDataSource('sqlite', new FakeDb());
    const result = await migrate(ds, [createUsersMigration()]);
    assert.deepEqual(result.applied, ['create_users']);

    const runner = ds.runners[0] as FakeQueryRunner;
    const txStart = callIndex(runner, (c) => c.method === 'startTransaction');
    const userCreate = callIndex(
      runner,
      (c) => c.method === 'createTable' && (c.args[0] as Table).name === 'users',
    );
    const insert = callIndex(
      runner,
      (c) =>
        c.method === 'query' &&
        typeof c.args[0] === 'string' &&
        c.args[0].startsWith('INSERT INTO'),
    );
    const commit = callIndex(runner, (c) => c.method === 'commitTransaction');

    assert.ok(txStart !== -1 && userCreate !== -1 && insert !== -1 && commit !== -1);
    assert.ok(txStart < userCreate, 'transaction starts before DDL');
    assert.ok(userCreate < insert, 'DDL precedes the applied record');
    assert.ok(insert < commit, 'record is written before commit');
    assert.equal(
      callIndex(runner, (c) => c.method === 'rollbackTransaction'),
      -1,
    );
  });

  it('takes no session lock (single-process serialization)', async () => {
    const ds = new FakeDataSource('sqlite', new FakeDb());
    await migrate(ds, [createUsersMigration()]);
    const runner = ds.runners[0] as FakeQueryRunner;
    const lockCalls = runner.calls.filter(
      (c) =>
        typeof c.args[0] === 'string' &&
        (c.args[0].includes('pg_try_advisory_lock') || c.args[0].includes('GET_LOCK')),
    );
    assert.equal(lockCalls.length, 0);
  });

  it('rolls back the transaction and writes no record on operation failure', async () => {
    const ds = new FakeDataSource('sqlite', new FakeDb());
    ds.fail = (method, args) =>
      method === 'createTable' && (args[0] as Table).name === 'users' ? new Error('boom') : null;

    await assert.rejects(migrate(ds, [createUsersMigration()]), /boom/);

    const runner = ds.runners[0] as FakeQueryRunner;
    assert.ok(callIndex(runner, (c) => c.method === 'rollbackTransaction') !== -1);
    assert.equal(
      callIndex(runner, (c) => c.method === 'commitTransaction'),
      -1,
    );
    assert.equal(ds.db.rows.length, 0, 'no record survives a rolled-back migration');
  });
});

describe('migrate: tracking table integrity guards', () => {
  it('rejects a checksum mismatch on an applied migration', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());
    await migrate(ds, [createUsersMigration()]);
    (ds.db.rows[0] as FakeRow).checksum = '0'.repeat(64);
    await assert.rejects(migrate(ds, [createUsersMigration()]), /checksum mismatch/);
  });

  it('rejects a tracking table that is not a prefix of the history', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());
    const history: MigrationDefinition[] = [
      {
        name: 'a',
        dependencies: [],
        operations: [{ kind: 'create_table', table: table('a_t', pk()) }],
      },
      {
        name: 'b',
        dependencies: ['a'],
        operations: [{ kind: 'create_table', table: table('b_t', pk()) }],
      },
      {
        name: 'c',
        dependencies: ['b'],
        operations: [{ kind: 'create_table', table: table('c_t', pk()) }],
      },
    ];
    await migrate(ds, history);
    ds.db.rows.splice(
      ds.db.rows.findIndex((row) => row.name === 'b'),
      1,
    );
    await assert.rejects(migrate(ds, history), /prefix/);
  });

  it('rejects an unknown migration row', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());
    ds.db.tableExists = true;
    ds.db.rows.push({ name: 'ghost', checksum: '0'.repeat(64), status: 'applied' });
    await assert.rejects(migrate(ds, [createUsersMigration()]), /unknown migration/);
  });

  it('rejects a duplicate migration row', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());
    await migrate(ds, [createUsersMigration()]);
    ds.db.rows.push({ ...(ds.db.rows[0] as FakeRow) });
    await assert.rejects(migrate(ds, [createUsersMigration()]), /duplicate/);
  });
});

describe('migrate: lock and query runner release', () => {
  it('surfaces the primary error and still releases the runner when lock release also fails', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());
    ds.fail = (method, args) => {
      if (method === 'createTable' && (args[0] as Table).name === 'users') {
        return new Error('primary failure');
      }
      if (
        method === 'query' &&
        typeof args[0] === 'string' &&
        args[0].includes('pg_advisory_unlock')
      ) {
        return new Error('release failure');
      }
      return null;
    };
    await assert.rejects(migrate(ds, [createUsersMigration()]), /primary failure/);
    assert.ok(
      (ds.runners[0] as FakeQueryRunner).released,
      'query runner is released despite both failures',
    );
  });

  it('surfaces a lock-release error when the migration itself succeeds', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());
    ds.fail = (method, args) =>
      method === 'query' && typeof args[0] === 'string' && args[0].includes('pg_advisory_unlock')
        ? new Error('release failure')
        : null;
    await assert.rejects(migrate(ds, [createUsersMigration()]), /release failure/);
    assert.ok((ds.runners[0] as FakeQueryRunner).released);
  });
});

describe('migrate: idempotence', () => {
  it('re-running an applied history is a no-op', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());
    const history = [createUsersMigration(), addEmailMigration()];

    const first = await migrate(ds, history);
    assert.deepEqual(first.applied, ['create_users', 'add_email']);

    const second = await migrate(ds, history);
    assert.deepEqual(second.applied, []);

    const runner = ds.runners[1] as FakeQueryRunner;
    assert.equal(
      callIndex(runner, (c) => c.method === 'createTable' && (c.args[0] as Table).name === 'users'),
      -1,
    );
    assert.equal(
      callIndex(runner, (c) => c.method === 'addColumn'),
      -1,
    );
    assert.deepEqual(
      ds.db.rows.map((row) => [row.name, row.status]),
      [
        ['create_users', 'applied'],
        ['add_email', 'applied'],
      ],
    );
  });
});

describe('getMigrationStatus', () => {
  it('reads without creating the tracking table', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());
    const status = await getMigrationStatus(ds, [createUsersMigration()]);

    assert.equal(status.tableExists, false);
    assert.deepEqual(status.applied, []);
    assert.deepEqual(status.pending, ['create_users']);
    assert.deepEqual(status.dirty, []);

    const runner = ds.runners[0] as FakeQueryRunner;
    assert.equal(
      callIndex(runner, (c) => c.method === 'createTable'),
      -1,
    );
    assert.equal(ds.db.tableExists, false);
  });

  it('reports applied and pending migrations after a run', async () => {
    const ds = new FakeDataSource('postgres', new FakeDb());
    const history = [createUsersMigration(), addEmailMigration()];
    await migrate(ds, history);

    const status = await getMigrationStatus(ds, history);
    assert.equal(status.tableExists, true);
    assert.deepEqual(status.applied, ['create_users', 'add_email']);
    assert.deepEqual(status.pending, []);
    assert.deepEqual(status.dirty, []);
  });

  it('reports a dirty migration without creating the table', async () => {
    const ds = new FakeDataSource('mysql', new FakeDb());
    ds.fail = (method, args) =>
      method === 'createTable' && (args[0] as Table).name === 'users' ? new Error('boom') : null;
    await assert.rejects(migrate(ds, [createUsersMigration()]), /boom/);

    const status = await getMigrationStatus(ds, [createUsersMigration()]);
    assert.equal(status.tableExists, true);
    assert.deepEqual(status.applied, []);
    assert.deepEqual(status.pending, []);
    assert.deepEqual(status.dirty, ['create_users']);
  });
});
