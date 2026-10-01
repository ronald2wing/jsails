import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueryRunner } from 'typeorm';
import type { Table, TableColumn, TableForeignKey, TableIndex, TableUnique } from 'typeorm';
import {
  type ColumnDefinition,
  type ForeignKeyDefinition,
  type IndexDefinition,
  MigrationError,
  type UniqueDefinition,
} from '../../src/migrations/schema-state.js';
import type { Operation } from '../../src/migrations/operations.js';
import {
  type SchemaEditorDriver,
  columnToTableColumn,
  executeSchemaOperation,
  foreignKeyToTableForeignKey,
  mapDeferrableForDdl,
  mapForeignKeyAction,
  mapScalarType,
  preflightSchemaOperation,
  preflightSchemaOperations,
  quoteLiteral,
  tableToTable,
} from '../../src/database/schema-editor.js';

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

  async renameTable(oldTable: Table | string, newTable: Table | string): Promise<void> {
    this.calls.push({ method: 'renameTable', args: [oldTable, newTable] });
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

  async createIndex(table: Table | string, index: TableIndex): Promise<void> {
    this.calls.push({ method: 'createIndex', args: [table, index] });
  }

  async dropIndex(table: Table | string, index: TableIndex | string): Promise<void> {
    this.calls.push({ method: 'dropIndex', args: [table, index] });
  }

  async createUniqueConstraint(table: Table | string, unique: TableUnique): Promise<void> {
    this.calls.push({ method: 'createUniqueConstraint', args: [table, unique] });
  }

  async dropUniqueConstraint(table: Table | string, unique: TableUnique | string): Promise<void> {
    this.calls.push({ method: 'dropUniqueConstraint', args: [table, unique] });
  }

  async createForeignKey(table: Table | string, fk: TableForeignKey): Promise<void> {
    this.calls.push({ method: 'createForeignKey', args: [table, fk] });
  }

  async dropForeignKey(table: Table | string, fk: TableForeignKey | string): Promise<void> {
    this.calls.push({ method: 'dropForeignKey', args: [table, fk] });
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

function idx(name: string, columns: string[], unique = false): IndexDefinition {
  return { name, columns, unique };
}

function uq(name: string, columns: string[]): UniqueDefinition {
  return { name, columns };
}

function fk(
  name: string,
  columns: string[],
  referencedTable: string,
  referencedColumns: string[],
): ForeignKeyDefinition {
  return { name, columns, referencedTable, referencedColumns };
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

  it('maps the seven new scalar types per driver', () => {
    // decimal → decimal (all drivers)
    for (const driver of ['postgres', 'mysql', 'mariadb', 'sqlite'] as SchemaEditorDriver[]) {
      assert.equal(mapScalarType('decimal', driver), 'decimal');
    }
    // float → double precision (postgres) / double (others)
    assert.equal(mapScalarType('float', 'postgres'), 'double precision');
    for (const driver of ['mysql', 'mariadb', 'sqlite'] as SchemaEditorDriver[]) {
      assert.equal(mapScalarType('float', driver), 'double');
    }
    // bigint → bigint (all)
    for (const driver of ['postgres', 'mysql', 'mariadb', 'sqlite'] as SchemaEditorDriver[]) {
      assert.equal(mapScalarType('bigint', driver), 'bigint');
    }
    // uuid → uuid (postgres) / varchar (others)
    assert.equal(mapScalarType('uuid', 'postgres'), 'uuid');
    for (const driver of ['mysql', 'mariadb', 'sqlite'] as SchemaEditorDriver[]) {
      assert.equal(mapScalarType('uuid', driver), 'varchar');
    }
    // json → jsonb (postgres) / json (mysql/mariadb) / text (sqlite)
    assert.equal(mapScalarType('json', 'postgres'), 'jsonb');
    assert.equal(mapScalarType('json', 'mysql'), 'json');
    assert.equal(mapScalarType('json', 'mariadb'), 'json');
    assert.equal(mapScalarType('json', 'sqlite'), 'text');
    // date → date (all)
    for (const driver of ['postgres', 'mysql', 'mariadb', 'sqlite'] as SchemaEditorDriver[]) {
      assert.equal(mapScalarType('date', driver), 'date');
    }
    // time → time (all)
    for (const driver of ['postgres', 'mysql', 'mariadb', 'sqlite'] as SchemaEditorDriver[]) {
      assert.equal(mapScalarType('time', driver), 'time');
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
      true,
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

  it('builds a table carrying indexes and uniques', () => {
    const table = tableToTable(
      {
        name: 'users',
        columns: [str('email', 255, false)],
        indexes: [idx('idx_email', ['email'], true)],
        uniques: [uq('uq_email', ['email'])],
      },
      'postgres',
    );
    assert.equal(table.indices.length, 1);
    assert.equal(table.indices[0]?.name, 'idx_email');
    assert.equal(table.indices[0]?.isUnique, true);
    assert.deepEqual(table.indices[0]?.columnNames, ['email']);
    assert.equal(table.uniques.length, 1);
    assert.equal(table.uniques[0]?.name, 'uq_email');
    assert.deepEqual(table.uniques[0]?.columnNames, ['email']);
  });

  it('maps sqlite scalar types to their SQLite equivalents', () => {
    const id = columnToTableColumn(
      { name: 'id', type: 'integer', nullable: false, primaryKey: true },
      'sqlite',
      true,
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

  it('builds a table carrying foreign keys', () => {
    const table = tableToTable(
      {
        name: 'posts',
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          int('author_id', false),
        ],
        foreignKeys: [fk('FK_posts_author', ['author_id'], 'authors', ['id'])],
      },
      'postgres',
    );
    assert.equal(table.foreignKeys.length, 1);
    const foreignKey = table.foreignKeys[0];
    assert.ok(foreignKey);
    assert.equal(foreignKey.name, 'FK_posts_author');
    assert.deepEqual(foreignKey.columnNames, ['author_id']);
    assert.equal(foreignKey.referencedTableName, 'authors');
    assert.deepEqual(foreignKey.referencedColumnNames, ['id']);
  });

  it('builds a table with deferrable unique and foreign key on postgres', () => {
    const table = tableToTable(
      {
        name: 'users',
        columns: [str('email', 255, false)],
        uniques: [
          {
            name: 'UQ_email',
            columns: ['email'],
            deferrable: 'INITIALLY_DEFERRED' as const,
          },
        ],
        foreignKeys: [
          {
            name: 'FK_u_a',
            columns: ['author_id'],
            referencedTable: 'authors',
            referencedColumns: ['id'],
            deferrable: 'INITIALLY_IMMEDIATE' as const,
          },
        ],
      },
      'postgres',
    );
    assert.equal(table.uniques.length, 1);
    assert.equal(table.uniques[0]?.deferrable, 'INITIALLY DEFERRED');
    assert.equal(table.foreignKeys.length, 1);
    assert.equal(table.foreignKeys[0]?.deferrable, 'INITIALLY IMMEDIATE');
  });

  it('rejects deferrable constraints on non-postgres in tableToTable', () => {
    assert.throws(
      () =>
        tableToTable(
          {
            name: 'users',
            columns: [str('email', 255, false)],
            uniques: [
              {
                name: 'UQ_email',
                columns: ['email'],
                deferrable: 'INITIALLY_DEFERRED' as const,
              },
            ],
          },
          'mysql',
        ),
      /requires Postgres/,
    );
    assert.throws(
      () =>
        tableToTable(
          {
            name: 'posts',
            columns: [int('author_id', false)],
            foreignKeys: [
              {
                name: 'FK_a',
                columns: ['author_id'],
                referencedTable: 'authors',
                referencedColumns: ['id'],
                deferrable: 'INITIALLY_DEFERRED' as const,
              },
            ],
          },
          'sqlite',
        ),
      /requires Postgres/,
    );
  });
});

describe('foreignKeyToTableForeignKey and mapForeignKeyAction', () => {
  it('maps each portable action to its native clause', () => {
    assert.equal(mapForeignKeyAction('cascade'), 'CASCADE');
    assert.equal(mapForeignKeyAction('restrict'), 'RESTRICT');
    assert.equal(mapForeignKeyAction('setNull'), 'SET NULL');
    assert.equal(mapForeignKeyAction('noAction'), 'NO ACTION');
  });

  it('omits unset actions and preserves a set onDelete', () => {
    const plain = foreignKeyToTableForeignKey(fk('FK_a', ['b_id'], 'bs', ['id']), 'postgres');
    assert.equal(plain.onDelete, undefined);
    assert.equal(plain.onUpdate, undefined);

    const cascading = foreignKeyToTableForeignKey(
      {
        name: 'FK_a',
        columns: ['b_id'],
        referencedTable: 'bs',
        referencedColumns: ['id'],
        onDelete: 'cascade',
        onUpdate: 'restrict',
      },
      'postgres',
    );
    assert.equal(cascading.onDelete, 'CASCADE');
    assert.equal(cascading.onUpdate, 'RESTRICT');
  });
  it('forwards FK deferrable to the TypeORM options', () => {
    const deferred = foreignKeyToTableForeignKey(
      {
        name: 'FK_a',
        columns: ['b_id'],
        referencedTable: 'bs',
        referencedColumns: ['id'],
        deferrable: 'INITIALLY_DEFERRED',
      },
      'postgres',
    );
    assert.equal(deferred.deferrable, 'INITIALLY DEFERRED');

    const immediate = foreignKeyToTableForeignKey(
      {
        name: 'FK_a',
        columns: ['b_id'],
        referencedTable: 'bs',
        referencedColumns: ['id'],
        deferrable: 'INITIALLY_IMMEDIATE',
      },
      'postgres',
    );
    assert.equal(immediate.deferrable, 'INITIALLY IMMEDIATE');
  });

  it('omits NOT_DEFERRABLE from the DDL', () => {
    const result = foreignKeyToTableForeignKey(
      {
        name: 'FK_a',
        columns: ['b_id'],
        referencedTable: 'bs',
        referencedColumns: ['id'],
        deferrable: 'NOT_DEFERRABLE',
      },
      'postgres',
    );
    assert.equal(result.deferrable, undefined);
  });

  it('rejects FK deferrable on a non-postgres driver', () => {
    assert.throws(
      () =>
        foreignKeyToTableForeignKey(
          {
            name: 'FK_a',
            columns: ['b_id'],
            referencedTable: 'bs',
            referencedColumns: ['id'],
            deferrable: 'INITIALLY_DEFERRED',
          },
          'mysql',
        ),
      /requires Postgres/,
    );
  });
});

describe('mapDeferrableForDdl: driver-gated conversion', () => {
  it('maps INITIALLY_IMMEDIATE and INITIALLY_DEFERRED on postgres', () => {
    assert.equal(mapDeferrableForDdl('INITIALLY_IMMEDIATE', 'postgres'), 'INITIALLY IMMEDIATE');
    assert.equal(mapDeferrableForDdl('INITIALLY_DEFERRED', 'postgres'), 'INITIALLY DEFERRED');
  });

  it('returns undefined for NOT_DEFERRABLE regardless of driver', () => {
    assert.equal(mapDeferrableForDdl('NOT_DEFERRABLE', 'postgres'), undefined);
    assert.equal(mapDeferrableForDdl('NOT_DEFERRABLE', 'mysql'), undefined);
    assert.equal(mapDeferrableForDdl('NOT_DEFERRABLE', 'sqlite'), undefined);
  });

  it('rejects a deferrable value on a non-postgres driver', () => {
    for (const driver of ['mysql', 'mariadb', 'sqlite'] as SchemaEditorDriver[]) {
      assert.throws(() => mapDeferrableForDdl('INITIALLY_DEFERRED', driver), /requires Postgres/);
      assert.throws(() => mapDeferrableForDdl('INITIALLY_IMMEDIATE', driver), /requires Postgres/);
    }
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

  it('renames a table via renameTable', async () => {
    const { runner, qr } = recordingRunner();
    await executeSchemaOperation(
      qr,
      { kind: 'rename_table', from: 'old_users', to: 'new_users' },
      'postgres',
    );
    assert.deepEqual(lastCall(runner.calls), {
      method: 'renameTable',
      args: ['old_users', 'new_users'],
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

  it('creates an index with column names and uniqueness', async () => {
    const { runner, qr } = recordingRunner();
    await executeSchemaOperation(
      qr,
      { kind: 'add_index', table: 'users', index: idx('idx_email', ['email'], true) },
      'postgres',
    );
    const call = lastCall(runner.calls);
    assert.equal(call.method, 'createIndex');
    assert.equal(call.args[0], 'users');
    const tableIndex = call.args[1] as TableIndex;
    assert.equal(tableIndex.name, 'idx_email');
    assert.deepEqual(tableIndex.columnNames, ['email']);
    assert.equal(tableIndex.isUnique, true);
  });

  it('drops an index by name', async () => {
    const { runner, qr } = recordingRunner();
    await executeSchemaOperation(
      qr,
      { kind: 'drop_index', table: 'users', index: idx('idx_email', ['email']) },
      'mysql',
    );
    assert.deepEqual(lastCall(runner.calls), { method: 'dropIndex', args: ['users', 'idx_email'] });
  });

  it('creates a unique constraint with column names', async () => {
    const { runner, qr } = recordingRunner();
    await executeSchemaOperation(
      qr,
      { kind: 'add_unique', table: 'users', unique: uq('uq_email', ['email']) },
      'postgres',
    );
    const call = lastCall(runner.calls);
    assert.equal(call.method, 'createUniqueConstraint');
    assert.equal(call.args[0], 'users');
    const tableUnique = call.args[1] as TableUnique;
    assert.equal(tableUnique.name, 'uq_email');
    assert.deepEqual(tableUnique.columnNames, ['email']);
  });

  it('drops a unique constraint by name', async () => {
    const { runner, qr } = recordingRunner();
    await executeSchemaOperation(
      qr,
      { kind: 'drop_unique', table: 'users', unique: uq('uq_email', ['email']) },
      'mysql',
    );
    assert.deepEqual(lastCall(runner.calls), {
      method: 'dropUniqueConstraint',
      args: ['users', 'uq_email'],
    });
  });

  it('creates a foreign key with mapped columns and actions', async () => {
    const { runner, qr } = recordingRunner();
    await executeSchemaOperation(
      qr,
      {
        kind: 'add_fk',
        table: 'posts',
        foreignKey: {
          name: 'FK_posts_author',
          columns: ['author_id'],
          referencedTable: 'authors',
          referencedColumns: ['id'],
          onDelete: 'cascade',
        },
      },
      'postgres',
    );
    const call = lastCall(runner.calls);
    assert.equal(call.method, 'createForeignKey');
    assert.equal(call.args[0], 'posts');
    const fk = call.args[1] as TableForeignKey;
    assert.equal(fk.name, 'FK_posts_author');
    assert.deepEqual(fk.columnNames, ['author_id']);
    assert.equal(fk.referencedTableName, 'authors');
    assert.deepEqual(fk.referencedColumnNames, ['id']);
    assert.equal(fk.onDelete, 'CASCADE');
  });

  it('drops a foreign key by name', async () => {
    const { runner, qr } = recordingRunner();
    await executeSchemaOperation(
      qr,
      {
        kind: 'drop_fk',
        table: 'posts',
        foreignKey: fk('FK_posts_author', ['author_id'], 'authors', ['id']),
      },
      'mysql',
    );
    assert.deepEqual(lastCall(runner.calls), {
      method: 'dropForeignKey',
      args: ['posts', 'FK_posts_author'],
    });
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

  it('rejects a malformed index operation without touching the query runner', async () => {
    const { runner, qr } = recordingRunner();
    await assert.rejects(
      executeSchemaOperation(
        qr,
        {
          kind: 'add_index',
          table: 'users',
          index: { name: 'bad_idx', columns: [], unique: false },
        },
        'postgres',
      ),
      /at least one column/,
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

  it('alter_polymorphic is metadata-only and records no DDL', async () => {
    const { runner, qr } = recordingRunner();
    await executeSchemaOperation(
      qr,
      {
        kind: 'alter_polymorphic',
        table: 'comments',
        polymorphic: { typeColumn: 'target_type', idColumn: 'target_id', targets: ['posts'] },
        previous: undefined,
      },
      'postgres',
    );
    assert.equal(runner.calls.length, 0, 'alter_polymorphic should emit no DDL');
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
    { kind: 'add_index', table: 'users', index: idx('idx_email', ['email']) },
    { kind: 'add_unique', table: 'users', unique: uq('uq_email', ['email']) },
  ];

  it('normalizes and returns every valid operation without a query runner', () => {
    const normalized = preflightSchemaOperations(ops, 'postgres');
    assert.equal(normalized.length, 6);
    assert.deepEqual(
      normalized.map((op) => op.kind),
      ['create_table', 'add_column', 'rename_column', 'alter_column', 'add_index', 'add_unique'],
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
    assert.equal(normalized.length, 6);
    assert.deepEqual(
      normalized.map((op) => op.kind),
      ['create_table', 'add_column', 'rename_column', 'alter_column', 'add_index', 'add_unique'],
    );
  });

  it('returns a normalized single operation', () => {
    const op = preflightSchemaOperation(ops[2] as Operation, 'mysql');
    assert.deepEqual(op, { kind: 'rename_column', table: 'users', from: 'age', to: 'years' });
  });

  it('accepts and normalizes foreign key operations', () => {
    const fkOps: Operation[] = [
      {
        kind: 'add_fk',
        table: 'posts',
        foreignKey: fk('FK_posts_author', ['author_id'], 'authors', ['id']),
      },
      {
        kind: 'drop_fk',
        table: 'posts',
        foreignKey: fk('FK_posts_author', ['author_id'], 'authors', ['id']),
      },
    ];
    const normalized = preflightSchemaOperations(fkOps, 'postgres');
    assert.deepEqual(
      normalized.map((op) => op.kind),
      ['add_fk', 'drop_fk'],
    );
  });
});

describe('composite primary keys', () => {
  it('maps a decimal column with precision and scale', () => {
    const col = columnToTableColumn(
      {
        name: 'price',
        type: 'decimal',
        precision: 10,
        scale: 2,
        nullable: false,
        default: 0,
      },
      'postgres',
    );
    assert.equal(col.name, 'price');
    assert.equal(col.type, 'decimal');
    assert.equal(col.precision, 10);
    assert.equal(col.scale, 2);
    assert.equal(col.default, '0');

    const mysqlCol = columnToTableColumn(
      { name: 'price', type: 'decimal', precision: 8, scale: 4, nullable: true },
      'mysql',
    );
    assert.equal(mysqlCol.precision, 8);
    assert.equal(mysqlCol.scale, 4);
  });

  it('maps uuid column: postgres gets uuid type, others get varchar(36)', () => {
    const pg = columnToTableColumn({ name: 'ref', type: 'uuid', nullable: false }, 'postgres');
    assert.equal(pg.type, 'uuid');
    assert.equal(pg.length, '');

    for (const driver of ['mysql', 'mariadb', 'sqlite'] as SchemaEditorDriver[]) {
      const col = columnToTableColumn({ name: 'ref', type: 'uuid', nullable: false }, driver);
      assert.equal(col.type, 'varchar');
      assert.equal(col.length, '36');
    }
  });

  it('builds a table with a composite PK — no column is auto-generated', () => {
    const table = tableToTable(
      {
        name: 'order_items',
        columns: [
          { name: 'order_id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'item_id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'quantity', type: 'integer', nullable: true },
        ],
      },
      'postgres',
    );
    assert.equal(table.name, 'order_items');
    const orderId = table.findColumnByName('order_id');
    assert.ok(orderId);
    assert.equal(orderId.isPrimary, true);
    assert.equal(orderId.isGenerated, false);
    assert.equal(orderId.generationStrategy, undefined);

    const itemId = table.findColumnByName('item_id');
    assert.ok(itemId);
    assert.equal(itemId.isPrimary, true);
    assert.equal(itemId.isGenerated, false);

    const quantity = table.findColumnByName('quantity');
    assert.ok(quantity);
    assert.equal(quantity.isPrimary, false);
    assert.equal(quantity.isGenerated, false);
  });

  it('a single PK column is still auto-generated', () => {
    const table = tableToTable(
      {
        name: 'users',
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'email', type: 'varchar', length: 255, nullable: false },
        ],
      },
      'postgres',
    );
    const id = table.findColumnByName('id');
    assert.ok(id);
    assert.equal(id.isPrimary, true);
    assert.equal(id.isGenerated, true);
    assert.equal(id.generationStrategy, 'increment');
  });
});

describe('composite foreign keys', () => {
  it('builds a table with a composite foreign key', () => {
    const table = tableToTable(
      {
        name: 'posts',
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'author_tenant', type: 'integer', nullable: false },
          { name: 'author_user', type: 'integer', nullable: false },
        ],
        foreignKeys: [
          {
            name: 'FK_posts_author',
            columns: ['author_tenant', 'author_user'],
            referencedTable: 'authors',
            referencedColumns: ['tenant_id', 'user_id'],
            onDelete: 'restrict',
          },
        ],
      },
      'postgres',
    );
    assert.equal(table.foreignKeys.length, 1);
    const fk = table.foreignKeys[0];
    assert.ok(fk);
    assert.equal(fk.name, 'FK_posts_author');
    assert.deepEqual(fk.columnNames, ['author_tenant', 'author_user']);
    assert.equal(fk.referencedTableName, 'authors');
    assert.deepEqual(fk.referencedColumnNames, ['tenant_id', 'user_id']);
    assert.equal(fk.onDelete, 'RESTRICT');
  });

  it('creates a composite foreign key via foreignKeyToTableForeignKey', () => {
    const fkObj = foreignKeyToTableForeignKey(
      {
        name: 'FK_oi_order',
        columns: ['order_id', 'line'],
        referencedTable: 'orders',
        referencedColumns: ['id', 'version'],
      },
      'postgres',
    );
    assert.equal(fkObj.name, 'FK_oi_order');
    assert.deepEqual(fkObj.columnNames, ['order_id', 'line']);
    assert.deepEqual(fkObj.referencedColumnNames, ['id', 'version']);
  });
});
