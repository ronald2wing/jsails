import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueryRunner } from 'typeorm';
import type { Table, TableColumn } from 'typeorm';
import { type ColumnDefinition, MigrationError } from '../src/migrations/schema-state.js';
import type { Operation } from '../src/migrations/operations.js';
import {
  type SchemaEditorDriver,
  columnToTableColumn,
  executeSchemaOperation,
  mapScalarType,
  preflightSchemaOperation,
  preflightSchemaOperations,
  quoteLiteral,
  tableToTable,
} from '../src/database/schema-editor.js';

/** Records every QueryRunner schema call and its arguments. */
class RecordingQueryRunner {
  calls: { method: string; args: unknown[] }[] = [];

  async createTable(table: Table, ...rest: unknown[]): Promise<void> {
    this.calls.push({ method: 'createTable', args: [table, ...rest] });
  }

  async dropTable(table: Table | string, ...rest: unknown[]): Promise<void> {
    this.calls.push({ method: 'dropTable', args: [table, ...rest] });
  }

  async addColumn(table: Table | string, column: TableColumn): Promise<void> {
    this.calls.push({ method: 'addColumn', args: [table, column] });
  }

  async dropColumn(
    table: Table | string,
    column: TableColumn | string,
    ...rest: unknown[]
  ): Promise<void> {
    this.calls.push({ method: 'dropColumn', args: [table, column, ...rest] });
  }

  async renameColumn(
    table: Table | string,
    oldColumn: TableColumn | string,
    newColumn: TableColumn | string,
  ): Promise<void> {
    this.calls.push({ method: 'renameColumn', args: [table, oldColumn, newColumn] });
  }

  async changeColumn(
    table: Table | string,
    oldColumn: TableColumn | string,
    newColumn: TableColumn,
  ): Promise<void> {
    this.calls.push({ method: 'changeColumn', args: [table, oldColumn, newColumn] });
  }
}

function recordingRunner(): { runner: RecordingQueryRunner; qr: QueryRunner } {
  const r = new RecordingQueryRunner();
  return { runner: r, qr: r as unknown as QueryRunner };
}

function int(name: string, nullable = true): ColumnDefinition {
  return { name, type: 'integer', nullable };
}

function str(name: string, length = 100, nullable = true): ColumnDefinition {
  return { name, type: 'varchar', length, nullable };
}

function lastCall(calls: { method: string; args: unknown[] }[]): {
  method: string;
  args: unknown[];
} {
  const call = calls[calls.length - 1];
  assert.ok(call);
  return call;
}

describe('mapScalarType: portable to concrete driver types', () => {
  const cases: [string, SchemaEditorDriver, string][] = [
    ['integer', 'postgres', 'integer'],
    ['integer', 'mysql', 'int'],
    ['integer', 'mariadb', 'int'],
    ['integer', 'sqlite', 'integer'],
    ['varchar', 'postgres', 'character varying'],
    ['varchar', 'mysql', 'varchar'],
    ['varchar', 'mariadb', 'varchar'],
    ['varchar', 'sqlite', 'varchar'],
    ['text', 'postgres', 'text'],
    ['text', 'mysql', 'text'],
    ['text', 'mariadb', 'text'],
    ['text', 'sqlite', 'text'],
    ['boolean', 'postgres', 'boolean'],
    ['boolean', 'mysql', 'tinyint'],
    ['boolean', 'mariadb', 'tinyint'],
    ['boolean', 'sqlite', 'boolean'],
    ['datetime', 'postgres', 'timestamp without time zone'],
    ['datetime', 'mysql', 'datetime'],
    ['datetime', 'mariadb', 'datetime'],
    ['datetime', 'sqlite', 'datetime'],
  ];

  it('maps every portable type for every supported driver', () => {
    for (const [type, driver, expected] of cases) {
      assert.equal(mapScalarType(type as never, driver), expected, `${type} on ${driver}`);
    }
  });
});

describe('quoteLiteral: safe scalar literal quoting', () => {
  it('single-quotes strings and doubles embedded quotes', () => {
    assert.equal(quoteLiteral('guest', 'postgres'), "'guest'");
    assert.equal(quoteLiteral("O'Brien", 'postgres'), "'O''Brien'");
    assert.equal(quoteLiteral('"quoted"', 'mysql'), '\'"quoted"\'');
  });

  it('neutralizes a SQL-injection default', () => {
    const hostile = "x'; DROP TABLE users; --";
    assert.equal(quoteLiteral(hostile, 'postgres'), "'x''; DROP TABLE users; --'");
  });

  it('emits numbers bare', () => {
    assert.equal(quoteLiteral(42, 'postgres'), '42');
    assert.equal(quoteLiteral(-7, 'mysql'), '-7');
  });

  it('emits booleans per driver', () => {
    assert.equal(quoteLiteral(true, 'postgres'), 'true');
    assert.equal(quoteLiteral(false, 'postgres'), 'false');
    assert.equal(quoteLiteral(true, 'mysql'), '1');
    assert.equal(quoteLiteral(false, 'mysql'), '0');
    assert.equal(quoteLiteral(true, 'mariadb'), '1');
    assert.equal(quoteLiteral(true, 'sqlite'), '1');
    assert.equal(quoteLiteral(false, 'sqlite'), '0');
  });

  it('rejects a backslash in a string literal', () => {
    assert.throws(() => quoteLiteral('a\\b', 'postgres'), /backslash or control character/);
    assert.throws(() => quoteLiteral('a\\', 'mysql'), /backslash or control character/);
  });

  it('rejects control characters in a string literal', () => {
    assert.throws(() => quoteLiteral('a\nb', 'postgres'), /backslash or control character/);
    assert.throws(() => quoteLiteral('a\x7fb', 'postgres'), /backslash or control character/);
  });

  it('still doubles embedded quotes (quote-only remains accepted)', () => {
    assert.equal(quoteLiteral("O'Brien", 'postgres'), "'O''Brien'");
  });
});

describe('columnToTableColumn and tableToTable', () => {
  it('maps a postgres varchar column with length and nullability', () => {
    const col = columnToTableColumn(str('email', 255, false), 'postgres');
    assert.equal(col.name, 'email');
    assert.equal(col.type, 'character varying');
    assert.equal(col.length, '255');
    assert.equal(col.isNullable, false);
    assert.equal(col.isPrimary, false);
    assert.equal(col.isGenerated, false);
    assert.equal(col.default, undefined);
  });

  it('maps a generated integer primary key', () => {
    const col = columnToTableColumn(
      { name: 'id', type: 'integer', nullable: false, primaryKey: true },
      'mysql',
    );
    assert.equal(col.type, 'int');
    assert.equal(col.isPrimary, true);
    assert.equal(col.isGenerated, true);
    assert.equal(col.generationStrategy, 'increment');
    assert.equal(col.default, undefined);
  });

  it('embeds a quoted default', () => {
    const pg = columnToTableColumn(
      { name: 'active', type: 'boolean', nullable: false, default: false },
      'postgres',
    );
    assert.equal(pg.default, 'false');
    const my = columnToTableColumn(
      { name: 'active', type: 'boolean', nullable: false, default: true },
      'mysql',
    );
    assert.equal(my.default, '1');
    const ts = columnToTableColumn(
      { name: 'created', type: 'datetime', nullable: false, default: '2020-01-01 00:00:00' },
      'mysql',
    );
    assert.equal(ts.type, 'datetime');
    assert.equal(ts.default, "'2020-01-01 00:00:00'");
  });

  it('builds a full table', () => {
    const table = tableToTable(
      {
        name: 'users',
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'bio', type: 'text', nullable: true },
        ],
      },
      'postgres',
    );
    assert.equal(table.name, 'users');
    const id = table.findColumnByName('id');
    assert.ok(id);
    assert.equal(id.type, 'integer');
    assert.equal(id.isGenerated, true);
    const bio = table.findColumnByName('bio');
    assert.ok(bio);
    assert.equal(bio.type, 'text');
    assert.equal(bio.isNullable, true);
  });

  it('maps sqlite scalar types to their SQLite equivalents', () => {
    const id = columnToTableColumn(
      { name: 'id', type: 'integer', nullable: false, primaryKey: true },
      'sqlite',
    );
    assert.equal(id.type, 'integer');
    assert.equal(id.isGenerated, true);
    assert.equal(id.generationStrategy, 'increment');

    const email = columnToTableColumn(str('email', 255, false), 'sqlite');
    assert.equal(email.type, 'varchar');
    assert.equal(email.length, '255');

    const active = columnToTableColumn(
      { name: 'active', type: 'boolean', nullable: false, default: true },
      'sqlite',
    );
    assert.equal(active.type, 'boolean');
    assert.equal(active.default, '1');
  });
});

describe('executeSchemaOperation: dispatches to QueryRunner', () => {
  it('creates a table with every column mapped', async () => {
    const { runner, qr } = recordingRunner();
    await executeSchemaOperation(
      qr,
      {
        kind: 'create_table',
        table: {
          name: 'users',
          columns: [
            { name: 'id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'email', type: 'varchar', length: 255, nullable: false },
            { name: 'active', type: 'boolean', nullable: false, default: true },
            { name: 'created_at', type: 'datetime', nullable: true },
          ],
        },
      },
      'postgres',
    );
    assert.equal(runner.calls.length, 1);
    const call = lastCall(runner.calls);
    assert.equal(call.method, 'createTable');
    const table = call.args[0] as Table;
    assert.equal(table.name, 'users');
    const email = table.findColumnByName('email');
    assert.ok(email);
    assert.equal(email.type, 'character varying');
    assert.equal(email.length, '255');
    const active = table.findColumnByName('active');
    assert.ok(active);
    assert.equal(active.type, 'boolean');
    assert.equal(active.default, 'true');
    const created = table.findColumnByName('created_at');
    assert.ok(created);
    assert.equal(created.type, 'timestamp without time zone');
  });

  it('drops a table by name', async () => {
    const { runner, qr } = recordingRunner();
    await executeSchemaOperation(
      qr,
      { kind: 'drop_table', table: { name: 'users', columns: [int('id', false)] } },
      'mysql',
    );
    assert.deepEqual(lastCall(runner.calls), { method: 'dropTable', args: ['users'] });
  });

  it('adds a column', async () => {
    const { runner, qr } = recordingRunner();
    await executeSchemaOperation(
      qr,
      { kind: 'add_column', table: 'users', column: str('email', 100) },
      'mysql',
    );
    const call = lastCall(runner.calls);
    assert.equal(call.method, 'addColumn');
    assert.equal(call.args[0], 'users');
    assert.equal((call.args[1] as TableColumn).type, 'varchar');
  });

  it('drops a column by name', async () => {
    const { runner, qr } = recordingRunner();
    await executeSchemaOperation(
      qr,
      { kind: 'drop_column', table: 'users', column: int('age') },
      'postgres',
    );
    assert.deepEqual(lastCall(runner.calls), { method: 'dropColumn', args: ['users', 'age'] });
  });

  it('renames a column via renameColumn', async () => {
    const { runner, qr } = recordingRunner();
    await executeSchemaOperation(
      qr,
      { kind: 'rename_column', table: 'users', from: 'old_name', to: 'new_name' },
      'mysql',
    );
    assert.deepEqual(lastCall(runner.calls), {
      method: 'renameColumn',
      args: ['users', 'old_name', 'new_name'],
    });
  });

  it('alters a column via changeColumn using previous and new definitions', async () => {
    const { runner, qr } = recordingRunner();
    await executeSchemaOperation(
      qr,
      {
        kind: 'alter_column',
        table: 'users',
        column: str('age', 10, false),
        previous: int('age'),
      },
      'postgres',
    );
    const call = lastCall(runner.calls);
    assert.equal(call.method, 'changeColumn');
    assert.equal(call.args[0], 'users');
    assert.equal((call.args[1] as TableColumn).type, 'integer');
    assert.equal((call.args[2] as TableColumn).type, 'character varying');
  });
});

describe('executeSchemaOperation: validation precedes DDL', () => {
  it('rejects a malformed operation without touching the query runner', async () => {
    const { runner, qr } = recordingRunner();
    await assert.rejects(
      executeSchemaOperation(
        qr,
        {
          kind: 'add_column',
          table: 'users',
          column: { name: 'x', type: 'varchar', nullable: true },
        },
        'postgres',
      ),
      MigrationError,
    );
    assert.equal(runner.calls.length, 0);
  });

  it('rejects an invalid default without touching the query runner', async () => {
    const { runner, qr } = recordingRunner();
    await assert.rejects(
      executeSchemaOperation(
        qr,
        {
          kind: 'add_column',
          table: 'users',
          column: { name: 'n', type: 'integer', nullable: true, default: 'x' },
        },
        'postgres',
      ),
      /does not match its type/,
    );
    assert.equal(runner.calls.length, 0);
  });

  it('rejects a backslash string default before any DDL reaches the query runner', async () => {
    const { runner, qr } = recordingRunner();
    await assert.rejects(
      executeSchemaOperation(
        qr,
        {
          kind: 'add_column',
          table: 'users',
          column: { name: 'bio', type: 'text', nullable: true, default: 'a\\b' },
        },
        'postgres',
      ),
      /backslash or control character/,
    );
    assert.equal(runner.calls.length, 0);
  });

  it('rejects an unknown operation kind without touching the query runner', async () => {
    const { runner, qr } = recordingRunner();
    await assert.rejects(
      executeSchemaOperation(qr, { kind: 'shuffle' } as unknown as Operation, 'postgres'),
      /unknown operation type/,
    );
    assert.equal(runner.calls.length, 0);
  });

  it('rejects an unsupported driver without touching the query runner', async () => {
    const { runner, qr } = recordingRunner();
    await assert.rejects(
      executeSchemaOperation(
        qr,
        { kind: 'drop_table', table: { name: 'users', columns: [int('id', false)] } },
        'mssql' as SchemaEditorDriver,
      ),
      /unsupported schema driver/,
    );
    assert.equal(runner.calls.length, 0);
  });
});

describe('preflight: pure validation with zero query-runner calls', () => {
  const ops: Operation[] = [
    {
      kind: 'create_table',
      table: { name: 'users', columns: [int('id', false), str('email', 255)] },
    },
    { kind: 'add_column', table: 'users', column: int('age') },
    { kind: 'rename_column', table: 'users', from: 'age', to: 'years' },
    {
      kind: 'alter_column',
      table: 'users',
      column: str('years', 10),
      previous: int('years'),
    },
  ];

  it('normalizes and returns every valid operation without a query runner', () => {
    const normalized = preflightSchemaOperations(ops, 'postgres');
    assert.equal(normalized.length, 4);
    assert.deepEqual(
      normalized.map((op) => op.kind),
      ['create_table', 'add_column', 'rename_column', 'alter_column'],
    );
  });

  it('rejects an invalid operation in the batch before any is applied', () => {
    const bad: Operation[] = [
      ops[0] as Operation,
      {
        kind: 'add_column',
        table: 'users',
        column: { name: 'v', type: 'varchar', nullable: true },
      },
    ];
    assert.throws(() => preflightSchemaOperations(bad, 'postgres'), MigrationError);
  });

  it('rejects an unsupported driver', () => {
    assert.throws(
      () => preflightSchemaOperations(ops, 'mssql' as SchemaEditorDriver),
      /unsupported schema driver/,
    );
  });

  it('accepts sqlite and returns every operation unchanged', () => {
    const normalized = preflightSchemaOperations(ops, 'sqlite');
    assert.equal(normalized.length, 4);
    assert.deepEqual(
      normalized.map((op) => op.kind),
      ['create_table', 'add_column', 'rename_column', 'alter_column'],
    );
  });

  it('returns a normalized single operation', () => {
    const op = preflightSchemaOperation(ops[2] as Operation, 'mysql');
    assert.deepEqual(op, { kind: 'rename_column', table: 'users', from: 'age', to: 'years' });
  });
});
