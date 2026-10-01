import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ColumnDefinition,
  type ForeignKeyAction,
  type ForeignKeyDefinition,
  type IndexDefinition,
  MigrationError,
  type SchemaState,
  type TableDefinition,
  type UniqueDefinition,
  normalizeSchemaState,
  schemasEqual,
} from '../../src/migrations/schema-state.js';
import {
  type Operation,
  applyOperation,
  invertOperation,
  validateOperation,
} from '../../src/migrations/operations.js';
import {
  type MigrationDefinition,
  replayMigrationHistory,
  resolveMigrationOrder,
} from '../../src/migrations/history.js';
import { generateMigration } from '../../src/migrations/autodetector.js';

function pk(name = 'id'): ColumnDefinition {
  return { name, type: 'integer', nullable: false, primaryKey: true };
}

function int(name: string, nullable = true): ColumnDefinition {
  return { name, type: 'integer', nullable };
}

function str(name: string, length = 100, nullable = true): ColumnDefinition {
  return { name, type: 'varchar', length, nullable };
}

function table(name: string, ...columns: ColumnDefinition[]): TableDefinition {
  return { name, columns };
}

function schema(...tables: TableDefinition[]): SchemaState {
  return { tables };
}

function fk(
  name: string,
  columns: string[],
  referencedTable: string,
  referencedColumns: string[],
  onDelete?: ForeignKeyAction,
): ForeignKeyDefinition {
  const definition: ForeignKeyDefinition = { name, columns, referencedTable, referencedColumns };
  if (onDelete !== undefined) {
    definition.onDelete = onDelete;
  }
  return definition;
}

function replay(history: MigrationDefinition[]): SchemaState {
  return replayMigrationHistory(history);
}

describe('schema-state validation', () => {
  it('rejects invalid identifiers', () => {
    assert.throws(() => normalizeSchemaState(schema(table('bad name', pk()))), MigrationError);
    assert.throws(() => normalizeSchemaState(schema(table('1users', pk()))), MigrationError);
    assert.throws(
      () => normalizeSchemaState(schema({ name: 'users', columns: [{ ...pk(), name: 'x-y' }] })),
      MigrationError,
    );
  });

  it('rejects duplicate tables and duplicate columns', () => {
    assert.throws(
      () => normalizeSchemaState(schema(table('users', pk()), table('users', pk()))),
      MigrationError,
    );
    // A single non-integer PK column is still rejected (must be integer).
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(
            table('users', {
              name: 'id',
              type: 'varchar',
              length: 10,
              nullable: false,
              primaryKey: true,
            }),
          ),
        ),
      MigrationError,
    );
  });

  it('rejects invalid column combinations', () => {
    // varchar without length
    assert.throws(
      () =>
        normalizeSchemaState(schema(table('u', { name: 'v', type: 'varchar', nullable: true }))),
      MigrationError,
    );
    // length on a non-varchar type
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(table('u', { name: 'n', type: 'integer', nullable: true, length: 10 })),
        ),
      MigrationError,
    );
    // primary key must be integer
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(
            table('u', {
              name: 'id',
              type: 'varchar',
              length: 10,
              nullable: false,
              primaryKey: true,
            }),
          ),
        ),
      MigrationError,
    );
    // primary key must not be nullable
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(table('u', { name: 'id', type: 'integer', nullable: true, primaryKey: true })),
        ),
      MigrationError,
    );
    // default type mismatch
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(table('u', pk(), { name: 'n', type: 'integer', nullable: true, default: 'x' })),
        ),
      MigrationError,
    );
    // composite primary keys are now accepted; the single-PK integer requirement
    // only applies when there is exactly one PK column.
    normalizeSchemaState(schema(table('u', pk('a'), pk('b'))));
  });

  it('normalizes to a canonical order', () => {
    const s = schema(table('zebra', str('b', 10), pk(), int('a')), table('apple', int('z'), pk()));
    const normalized = normalizeSchemaState(s);
    assert.deepEqual(
      normalized.tables.map((t) => t.name),
      ['apple', 'zebra'],
    );
    assert.deepEqual(
      normalized.tables[1]?.columns.map((c) => c.name),
      ['id', 'a', 'b'],
    );
  });
});

describe('generateMigration: initial generation and replay', () => {
  it('generates a create_table migration for an empty history', () => {
    const desired = schema(table('users', pk(), str('email', 255, false)));
    const migration = generateMigration('create_users', [], desired);
    assert.ok(migration);
    assert.deepEqual(migration.dependencies, []);
    assert.equal(migration.operations.length, 1);
    assert.equal(migration.operations[0]?.kind, 'create_table');
    assert.ok(schemasEqual(replay([migration]), desired));
  });

  it('returns null when there is no change', () => {
    const desired = schema(table('users', pk(), str('email', 255)));
    const migration = generateMigration('create_users', [], desired);
    assert.ok(migration);
    const second = generateMigration('noop', [migration], desired);
    assert.equal(second, null);
  });

  it('adds a new table incrementally', () => {
    const first = generateMigration(
      'create_users',
      [],
      schema(table('users', pk(), str('email', 255))),
    );
    assert.ok(first);
    const second = generateMigration(
      'create_posts',
      [first],
      schema(table('users', pk(), str('email', 255)), table('posts', pk(), str('title', 200))),
    );
    assert.ok(second);
    assert.deepEqual(second.dependencies, ['create_users']);
    assert.equal(second.operations[0]?.kind, 'create_table');
    assert.ok(
      schemasEqual(
        replay([first, second]),
        schema(table('users', pk(), str('email', 255)), table('posts', pk(), str('title', 200))),
      ),
    );
  });

  it('adds a nullable column incrementally', () => {
    const first = generateMigration(
      'create_users',
      [],
      schema(table('users', pk(), str('email', 255))),
    );
    assert.ok(first);
    const second = generateMigration(
      'add_age',
      [first],
      schema(table('users', pk(), str('email', 255), int('age'))),
    );
    assert.ok(second);
    assert.equal(second.operations[0]?.kind, 'add_column');
  });
});

describe('generateMigration: determinism', () => {
  it('produces identical operations regardless of input ordering', () => {
    const a = schema(table('z', str('b', 10), pk(), int('a')), table('a', int('z'), pk()));
    const b = schema(table('a', pk(), int('z')), table('z', pk(), int('a'), str('b', 10)));
    const ma = generateMigration('m', [], a);
    const mb = generateMigration('m', [], b);
    assert.ok(ma && mb);
    assert.deepEqual(ma.operations, mb.operations);
  });
});

describe('migration history validation', () => {
  const createUsers = (): MigrationDefinition => ({
    name: 'create_users',
    dependencies: [],
    operations: [{ kind: 'create_table', table: table('users', pk()) }],
  });

  it('rejects duplicate names', () => {
    const m = createUsers();
    assert.throws(() => resolveMigrationOrder([m, m]), /duplicate migration name/);
  });

  it('rejects missing dependencies', () => {
    const m = createUsers();
    const bad: MigrationDefinition = { name: 'add_x', dependencies: ['nope'], operations: [] };
    assert.throws(() => resolveMigrationOrder([m, bad]), /unknown migration/);
  });

  it('rejects cycles', () => {
    const a: MigrationDefinition = { name: 'a', dependencies: ['b'], operations: [] };
    const b: MigrationDefinition = { name: 'b', dependencies: ['a'], operations: [] };
    assert.throws(() => resolveMigrationOrder([a, b]), /cycle/);
  });

  it('rejects multiple roots (branches)', () => {
    const a: MigrationDefinition = { name: 'a', dependencies: [], operations: [] };
    const b: MigrationDefinition = { name: 'b', dependencies: [], operations: [] };
    assert.throws(() => resolveMigrationOrder([a, b]), /multiple roots/);
  });

  it('rejects branching (a migration with multiple dependents)', () => {
    const root: MigrationDefinition = { name: 'root', dependencies: [], operations: [] };
    const a: MigrationDefinition = { name: 'a', dependencies: ['root'], operations: [] };
    const b: MigrationDefinition = { name: 'b', dependencies: ['root'], operations: [] };
    assert.throws(() => resolveMigrationOrder([root, a, b]), /branching/);
  });

  it('rejects merge nodes (multiple dependencies)', () => {
    const a: MigrationDefinition = { name: 'a', dependencies: [], operations: [] };
    const b: MigrationDefinition = { name: 'b', dependencies: ['a'], operations: [] };
    const c: MigrationDefinition = { name: 'c', dependencies: ['a', 'b'], operations: [] };
    assert.throws(() => resolveMigrationOrder([a, b, c]), /merge nodes/);
  });

  it('rejects unknown operation types at runtime', () => {
    const m: MigrationDefinition = {
      name: 'm',
      dependencies: [],
      operations: [{ kind: 'drop_database' } as unknown as Operation],
    };
    assert.throws(() => resolveMigrationOrder([m]), /unknown operation type/);
  });
});

describe('destructive changes and renames', () => {
  it('rejects dropping a table without allowDestructive', () => {
    const first = generateMigration('create_users', [], schema(table('users', pk())));
    assert.ok(first);
    assert.throws(() => generateMigration('drop_users', [first], schema()), /destructive/);
    const drop = generateMigration('drop_users', [first], schema(), { allowDestructive: true });
    assert.ok(drop);
    assert.equal(drop.operations[0]?.kind, 'drop_table');
    assert.ok(schemasEqual(replay([first, drop]), schema()));
  });

  it('rejects an ambiguous column removal without a rename hint or opt-in', () => {
    const first = generateMigration(
      'create_users',
      [],
      schema(table('users', pk(), str('old_name', 100))),
    );
    assert.ok(first);
    const desired = schema(table('users', pk(), str('new_name', 100)));
    assert.throws(() => generateMigration('rename_col', [first], desired), /ambiguous removal/);
    // destructive opt-in resolves it as drop + add
    const dropped = generateMigration('drop_col', [first], desired, { allowDestructive: true });
    assert.ok(dropped);
    assert.ok(dropped.operations.some((op) => op.kind === 'drop_column'));
    assert.ok(dropped.operations.some((op) => op.kind === 'add_column'));
  });

  it('applies an explicit rename hint safely', () => {
    const first = generateMigration(
      'create_users',
      [],
      schema(table('users', pk(), str('old_name', 100))),
    );
    assert.ok(first);
    const desired = schema(table('users', pk(), str('new_name', 100)));
    const renamed = generateMigration('rename_col', [first], desired, {
      renames: [{ table: 'users', from: 'old_name', to: 'new_name' }],
    });
    assert.ok(renamed);
    assert.equal(renamed.operations[0]?.kind, 'rename_column');
    assert.ok(schemasEqual(replay([first, renamed]), desired));
  });

  it('rejects adding a required column without a default to an existing table', () => {
    const first = generateMigration('create_users', [], schema(table('users', pk())));
    assert.ok(first);
    const desired = schema(
      table('users', pk(), { name: 'must', type: 'varchar', length: 10, nullable: false }),
    );
    assert.throws(() => generateMigration('add_required', [first], desired), /without a default/);
  });

  it('permits a required column when it has a default', () => {
    const first = generateMigration('create_users', [], schema(table('users', pk())));
    assert.ok(first);
    const desired = schema(
      table('users', pk(), {
        name: 'must',
        type: 'varchar',
        length: 10,
        nullable: false,
        default: 'x',
      }),
    );
    const added = generateMigration('add_required', [first], desired);
    assert.ok(added);
    assert.equal(added.operations[0]?.kind, 'add_column');
  });

  it('rejects a type alteration without allowDestructive', () => {
    const first = generateMigration('create_users', [], schema(table('users', pk(), int('age'))));
    assert.ok(first);
    const desired = schema(table('users', pk(), str('age', 10)));
    assert.throws(() => generateMigration('alter_age', [first], desired), /destructive/);
    const altered = generateMigration('alter_age', [first], desired, { allowDestructive: true });
    assert.ok(altered);
    assert.equal(altered.operations[0]?.kind, 'alter_column');
  });
});

describe('reverse operations roundtrip', () => {
  it('restores the original state after applying inverses in reverse', () => {
    const ops: Operation[] = [
      { kind: 'create_table', table: table('users', pk(), str('email', 255, false)) },
      { kind: 'add_column', table: 'users', column: int('age') },
      { kind: 'rename_column', table: 'users', from: 'age', to: 'years' },
      { kind: 'rename_table', from: 'users', to: 'accounts' },
      { kind: 'alter_column', table: 'accounts', column: str('years', 5), previous: int('years') },
    ];

    let state: SchemaState = { tables: [] };
    for (const op of ops) {
      state = applyOperation(state, op);
    }
    const forward = state;

    for (const op of [...ops].reverse()) {
      state = applyOperation(state, invertOperation(op));
    }
    assert.ok(schemasEqual(state, { tables: [] }));
    assert.ok(!schemasEqual(forward, { tables: [] }));
  });
});

describe('operation preconditions', () => {
  it('rejects create_table on an existing table', () => {
    const op: Operation = { kind: 'create_table', table: table('users', pk()) };
    assert.throws(() => applyOperation(applyOperation({ tables: [] }, op), op), /already exists/);
  });

  it('rejects drop_table with a mismatched recorded definition', () => {
    const created: Operation = { kind: 'create_table', table: table('users', pk()) };
    const state = applyOperation({ tables: [] }, created);
    const wrongDrop: Operation = { kind: 'drop_table', table: table('users', pk(), int('extra')) };
    assert.throws(() => applyOperation(state, wrongDrop), /does not match/);
  });

  it('rejects duplicate add_column', () => {
    const state = applyOperation(
      { tables: [] },
      { kind: 'create_table', table: table('users', pk()) },
    );
    const add: Operation = { kind: 'add_column', table: 'users', column: int('age') };
    assert.throws(() => applyOperation(applyOperation(state, add), add), /already exists/);
  });

  it('rejects rename_column when the target already exists', () => {
    const state = applyOperation(
      { tables: [] },
      { kind: 'create_table', table: table('users', pk(), int('age'), int('years')) },
    );
    const rename: Operation = { kind: 'rename_column', table: 'users', from: 'age', to: 'years' };
    assert.throws(() => applyOperation(state, rename), /already exists/);
  });

  it('rejects alter_column with a wrong previous definition', () => {
    const state = applyOperation(
      { tables: [] },
      { kind: 'create_table', table: table('users', pk(), int('age')) },
    );
    const alter: Operation = {
      kind: 'alter_column',
      table: 'users',
      column: str('age', 10),
      previous: int('age', false),
    };
    assert.throws(() => applyOperation(state, alter), /does not match/);
  });

  it('rejects an unknown operation type at runtime', () => {
    assert.throws(() => validateOperation({ kind: 'shuffle' }), /unknown operation type/);
  });
});

describe('portable default validation', () => {
  const textDefault = (defaultValue: string): ColumnDefinition => ({
    name: 'bio',
    type: 'text',
    nullable: true,
    default: defaultValue,
  });
  const intDefault = (defaultValue: number): ColumnDefinition => ({
    name: 'age',
    type: 'integer',
    nullable: true,
    default: defaultValue,
  });
  const varcharDefault = (length: number, defaultValue: string): ColumnDefinition => ({
    name: 'label',
    type: 'varchar',
    length,
    nullable: true,
    default: defaultValue,
  });
  const datetimeDefault = (defaultValue: string): ColumnDefinition => ({
    name: 'created',
    type: 'datetime',
    nullable: true,
    default: defaultValue,
  });

  it('rejects a backslash in a string default', () => {
    assert.throws(
      () => normalizeSchemaState(schema(table('users', pk(), textDefault('a\\b')))),
      /backslash or control character/,
    );
  });

  it('rejects a trailing backslash in a string default', () => {
    assert.throws(
      () => normalizeSchemaState(schema(table('users', pk(), textDefault('a\\')))),
      /backslash or control character/,
    );
  });

  it('rejects control characters in a string default', () => {
    assert.throws(
      () => normalizeSchemaState(schema(table('users', pk(), textDefault('a\nb')))),
      /backslash or control character/,
    );
    assert.throws(
      () => normalizeSchemaState(schema(table('users', pk(), textDefault('a\x7fb')))),
      /backslash or control character/,
    );
  });

  it('accepts a quote-only string default (quotes are doubled, not rejected)', () => {
    const normalized = normalizeSchemaState(schema(table('users', pk(), textDefault("O'Brien"))));
    assert.equal(
      normalized.tables[0]?.columns.find((column) => column.name === 'bio')?.default,
      "O'Brien",
    );
  });

  it('rejects integer defaults outside the signed 32-bit range', () => {
    assert.throws(
      () => normalizeSchemaState(schema(table('users', pk(), intDefault(2147483648)))),
      /out of range/,
    );
    assert.throws(
      () => normalizeSchemaState(schema(table('users', pk(), intDefault(-2147483649)))),
      /out of range/,
    );
  });

  it('accepts integer defaults at the signed 32-bit boundaries', () => {
    normalizeSchemaState(schema(table('users', pk(), intDefault(2147483647))));
    normalizeSchemaState(schema(table('users', pk(), intDefault(-2147483648))));
  });

  it('measures varchar default length in Unicode code points', () => {
    // 'a' + a single astral code point = 2 code points, within length 2.
    normalizeSchemaState(schema(table('users', pk(), varcharDefault(2, 'a🚀'))));
    // 3 code points exceeds the declared length of 2.
    assert.throws(
      () => normalizeSchemaState(schema(table('users', pk(), varcharDefault(2, 'abc')))),
      /exceeding its declared length/,
    );
  });

  it('accepts a valid leap-day datetime default', () => {
    normalizeSchemaState(schema(table('users', pk(), datetimeDefault('2020-02-29 00:00:00'))));
  });

  it('rejects a Feb 29 default in a non-leap year', () => {
    assert.throws(
      () =>
        normalizeSchemaState(schema(table('users', pk(), datetimeDefault('2021-02-29 00:00:00')))),
      /invalid day/,
    );
  });

  it('rejects an invalid month', () => {
    assert.throws(
      () =>
        normalizeSchemaState(schema(table('users', pk(), datetimeDefault('2020-13-01 00:00:00')))),
      /invalid month/,
    );
  });

  it('rejects an invalid time', () => {
    assert.throws(
      () =>
        normalizeSchemaState(schema(table('users', pk(), datetimeDefault('2020-01-01 24:00:00')))),
      /invalid time/,
    );
  });

  it('rejects a timezone suffix (exact format, no timezone coercion)', () => {
    assert.throws(
      () =>
        normalizeSchemaState(schema(table('users', pk(), datetimeDefault('2020-01-01 00:00:00Z')))),
      /exactly "YYYY-MM-DD HH:MM:SS"/,
    );
  });

  it('rejects a datetime default outside the portable year range', () => {
    assert.throws(
      () =>
        normalizeSchemaState(schema(table('users', pk(), datetimeDefault('0999-12-31 23:59:59')))),
      /outside the portable range/,
    );
  });
});

describe('varchar length change requires allowDestructive', () => {
  const emailDefault = (length: number, defaultValue: string): ColumnDefinition => ({
    name: 'email',
    type: 'varchar',
    length,
    nullable: true,
    default: defaultValue,
  });

  it('rejects widening without opt-in and emits alter_column with opt-in', () => {
    const first = generateMigration(
      'create_users',
      [],
      schema(table('users', pk(), str('email', 100))),
    );
    assert.ok(first);
    const widened = schema(table('users', pk(), str('email', 200)));
    assert.throws(() => generateMigration('widen_email', [first], widened), /destructive/);
    const opted = generateMigration('widen_email', [first], widened, { allowDestructive: true });
    assert.ok(opted);
    assert.equal(opted.operations[0]?.kind, 'alter_column');
  });

  it('rejects narrowing without opt-in too', () => {
    const first = generateMigration(
      'create_users',
      [],
      schema(table('users', pk(), str('email', 200))),
    );
    assert.ok(first);
    const narrowed = schema(table('users', pk(), str('email', 100)));
    assert.throws(() => generateMigration('narrow_email', [first], narrowed), /destructive/);
  });

  it('allows a default-only change without opt-in', () => {
    const first = generateMigration(
      'create_users',
      [],
      schema(table('users', pk(), emailDefault(100, 'a'))),
    );
    assert.ok(first);
    const changed = schema(table('users', pk(), emailDefault(100, 'b')));
    const migration = generateMigration('change_default', [first], changed);
    assert.ok(migration);
    assert.equal(migration.operations[0]?.kind, 'alter_column');
  });
});

describe('indexes and unique constraints', () => {
  const idx = (name: string, columns: string[], unique = false): IndexDefinition => ({
    name,
    columns,
    unique,
  });
  const uq = (name: string, columns: string[]): UniqueDefinition => ({ name, columns });
  const tbl = (
    name: string,
    columns: ColumnDefinition[],
    indexes?: IndexDefinition[],
    uniques?: UniqueDefinition[],
  ): TableDefinition => {
    const table: TableDefinition = { name, columns };
    if (indexes) {
      table.indexes = indexes;
    }
    if (uniques) {
      table.uniques = uniques;
    }
    return table;
  };

  it('rejects an index referencing an unknown column', () => {
    assert.throws(
      () =>
        normalizeSchemaState(schema(tbl('u', [pk(), str('email', 100)], [idx('x', ['missing'])]))),
      /unknown column/,
    );
  });

  it('rejects a unique constraint referencing an unknown column', () => {
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(tbl('u', [pk(), str('email', 100)], undefined, [uq('x', ['missing'])])),
        ),
      /unknown column/,
    );
  });

  it('rejects duplicate index names and duplicate columns within one index', () => {
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(tbl('u', [pk(), str('email', 100)], [idx('x', ['email']), idx('x', ['email'])])),
        ),
      /more than one index/,
    );
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(tbl('u', [pk(), str('email', 100)], [idx('x', ['email', 'email'])])),
        ),
      /more than once/,
    );
  });

  it('rejects an empty index column list and a non-boolean unique flag', () => {
    assert.throws(
      () => normalizeSchemaState(schema(tbl('u', [pk()], [idx('x', [])]))),
      /at least one column/,
    );
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(
            tbl(
              'u',
              [pk(), str('e', 1)],
              [{ name: 'x', columns: ['e'], unique: 'yes' } as unknown as IndexDefinition],
            ),
          ),
        ),
      /"unique" must be a boolean/,
    );
  });

  it('sorts indexes and uniques by name deterministically', () => {
    const s = schema(
      tbl(
        'u',
        [pk(), str('a', 10), str('b', 10)],
        [idx('z', ['a']), idx('a', ['b'])],
        [uq('z_u', ['b']), uq('a_u', ['a'])],
      ),
    );
    const normalized = normalizeSchemaState(s);
    assert.deepEqual(
      normalized.tables[0]?.indexes?.map((i) => i.name),
      ['a', 'z'],
    );
    assert.deepEqual(
      normalized.tables[0]?.uniques?.map((u) => u.name),
      ['a_u', 'z_u'],
    );
  });

  it('replays create_table with indexes and uniques', () => {
    const desired = schema(
      tbl(
        'users',
        [pk(), str('email', 255, false)],
        [idx('idx_email', ['email'])],
        [uq('uq_email', ['email'])],
      ),
    );
    const migration = generateMigration('create_users', [], desired);
    assert.ok(migration);
    assert.equal(migration.operations[0]?.kind, 'create_table');
    assert.ok(schemasEqual(replay([migration]), desired));
  });

  it('emits add_index for a new index', () => {
    const first = generateMigration(
      'create_users',
      [],
      schema(tbl('users', [pk(), str('email', 255)])),
    );
    assert.ok(first);
    const second = generateMigration(
      'add_idx',
      [first],
      schema(tbl('users', [pk(), str('email', 255)], [idx('idx_email', ['email'])])),
    );
    assert.ok(second);
    assert.deepEqual(
      second.operations.map((op) => op.kind),
      ['add_index'],
    );
  });

  it('emits add_unique for a new unique constraint', () => {
    const first = generateMigration(
      'create_users',
      [],
      schema(tbl('users', [pk(), str('email', 255)])),
    );
    assert.ok(first);
    const second = generateMigration(
      'add_uq',
      [first],
      schema(tbl('users', [pk(), str('email', 255)], undefined, [uq('uq_email', ['email'])])),
    );
    assert.ok(second);
    assert.deepEqual(
      second.operations.map((op) => op.kind),
      ['add_unique'],
    );
  });

  it('requires allowDestructive to drop an index', () => {
    const first = generateMigration(
      'create_users',
      [],
      schema(tbl('users', [pk(), str('email', 255)], [idx('idx_email', ['email'])])),
    );
    assert.ok(first);
    const desired = schema(tbl('users', [pk(), str('email', 255)]));
    assert.throws(() => generateMigration('drop_idx', [first], desired), /destructive/);
    const dropped = generateMigration('drop_idx', [first], desired, { allowDestructive: true });
    assert.ok(dropped);
    assert.deepEqual(
      dropped.operations.map((op) => op.kind),
      ['drop_index'],
    );
    assert.ok(schemasEqual(replay([first, dropped]), desired));
  });

  it('requires allowDestructive to drop a unique constraint', () => {
    const first = generateMigration(
      'create_users',
      [],
      schema(tbl('users', [pk(), str('email', 255)], undefined, [uq('uq_email', ['email'])])),
    );
    assert.ok(first);
    const desired = schema(tbl('users', [pk(), str('email', 255)]));
    assert.throws(() => generateMigration('drop_uq', [first], desired), /destructive/);
    const dropped = generateMigration('drop_uq', [first], desired, { allowDestructive: true });
    assert.ok(dropped);
    assert.deepEqual(
      dropped.operations.map((op) => op.kind),
      ['drop_unique'],
    );
  });

  it('normalizes unique constraints with deferrable', () => {
    const normalized = normalizeSchemaState(
      schema(
        tbl('users', [pk(), str('email', 255, false)], undefined, [
          uq('uq_email', ['email']),
          { name: 'uq_def_email', columns: ['email'], deferrable: 'INITIALLY_DEFERRED' },
        ]),
      ),
    );
    const def = normalized.tables[0]?.uniques?.find((u) => u.name === 'uq_def_email');
    assert.ok(def);
    assert.equal(def.deferrable, 'INITIALLY_DEFERRED');
    const plain = normalized.tables[0]?.uniques?.find((u) => u.name === 'uq_email');
    assert.ok(plain);
    assert.equal(plain.deferrable, undefined);
  });

  it('rejects unknown deferrable value on a unique constraint', () => {
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(
            tbl('users', [pk(), str('email', 255, false)], undefined, [
              {
                name: 'uq_x',
                columns: ['email'],
                deferrable: 'VALID',
              } as unknown as UniqueDefinition,
            ]),
          ),
        ),
      /deferrable/,
    );
  });

  it('requires allowDestructive to change an index definition', () => {
    const first = generateMigration(
      'create_users',
      [],
      schema(tbl('users', [pk(), str('email', 255)], [idx('idx_email', ['email'])])),
    );
    assert.ok(first);
    const desired = schema(
      tbl('users', [pk(), str('email', 255)], [idx('idx_email', ['email'], true)]),
    );
    assert.throws(() => generateMigration('change_idx', [first], desired), /destructive/);
    const changed = generateMigration('change_idx', [first], desired, { allowDestructive: true });
    assert.ok(changed);
    assert.ok(changed.operations.some((op) => op.kind === 'drop_index'));
    assert.ok(changed.operations.some((op) => op.kind === 'add_index'));
    assert.ok(schemasEqual(replay([first, changed]), desired));
  });

  it('roundtrips index and unique operations through inverses', () => {
    const ops: Operation[] = [
      { kind: 'create_table', table: tbl('users', [pk(), str('email', 255, false)]) },
      { kind: 'add_index', table: 'users', index: idx('idx_email', ['email']) },
      { kind: 'add_unique', table: 'users', unique: uq('uq_email', ['email']) },
      { kind: 'drop_index', table: 'users', index: idx('idx_email', ['email']) },
    ];
    let state: SchemaState = { tables: [] };
    for (const op of ops) {
      state = applyOperation(state, op);
    }
    for (const op of [...ops].reverse()) {
      state = applyOperation(state, invertOperation(op));
    }
    assert.ok(schemasEqual(state, { tables: [] }));
  });

  it('cascades a column rename to index and unique references', () => {
    const first = generateMigration(
      'create_users',
      [],
      schema(
        tbl(
          'users',
          [pk(), str('old_name', 100)],
          [idx('idx_old', ['old_name'])],
          [uq('uq_old', ['old_name'])],
        ),
      ),
    );
    assert.ok(first);
    const desired = schema(
      tbl(
        'users',
        [pk(), str('new_name', 100)],
        [idx('idx_old', ['new_name'])],
        [uq('uq_old', ['new_name'])],
      ),
    );
    const renamed = generateMigration('rename', [first], desired, {
      renames: [{ table: 'users', from: 'old_name', to: 'new_name' }],
    });
    assert.ok(renamed);
    assert.deepEqual(
      renamed.operations.map((op) => op.kind),
      ['rename_column'],
    );
    assert.ok(schemasEqual(replay([first, renamed]), desired));
  });

  it('orders index drops before column drops and adds after adds', () => {
    const first = generateMigration(
      'create_users',
      [],
      schema(tbl('users', [pk(), str('email', 255)], [idx('idx_email', ['email'])])),
    );
    assert.ok(first);
    const dropped = generateMigration('drop_email', [first], schema(tbl('users', [pk()])), {
      allowDestructive: true,
    });
    assert.ok(dropped);
    assert.deepEqual(
      dropped.operations.map((op) => op.kind),
      ['drop_index', 'drop_column'],
    );

    const added = generateMigration(
      'add_email',
      [first, dropped],
      schema(tbl('users', [pk(), str('email', 255)], [idx('idx_email', ['email'])])),
    );
    assert.ok(added);
    assert.deepEqual(
      added.operations.map((op) => op.kind),
      ['add_column', 'add_index'],
    );
  });
});

describe('foreign keys', () => {
  const authors = (): TableDefinition => table('authors', pk());
  const postsWithFk = (onDelete?: ForeignKeyAction): TableDefinition => ({
    name: 'posts',
    columns: [pk(), int('author_id', false)],
    foreignKeys: [fk('FK_posts_author', ['author_id'], 'authors', ['id'], onDelete)],
  });

  it('normalizes foreign keys deterministically and preserves actions', () => {
    const normalized = normalizeSchemaState(schema(authors(), postsWithFk('cascade')));
    assert.deepEqual(normalized.tables[1]?.foreignKeys, [
      {
        name: 'FK_posts_author',
        columns: ['author_id'],
        referencedTable: 'authors',
        referencedColumns: ['id'],
        onDelete: 'cascade',
      },
    ]);
  });

  it('normalizes foreign keys with deferrable', () => {
    const notDeferrable = normalizeSchemaState(
      schema(authors(), {
        name: 'posts',
        columns: [pk(), int('author_id', false)],
        foreignKeys: [
          {
            name: 'FK_x',
            columns: ['author_id'],
            referencedTable: 'authors',
            referencedColumns: ['id'],
            deferrable: 'NOT_DEFERRABLE',
          },
        ],
      }),
    );
    assert.deepEqual(notDeferrable.tables[1]?.foreignKeys?.[0], {
      name: 'FK_x',
      columns: ['author_id'],
      referencedTable: 'authors',
      referencedColumns: ['id'],
      deferrable: 'NOT_DEFERRABLE',
    });

    const deferred = normalizeSchemaState(
      schema(authors(), {
        name: 'posts',
        columns: [pk(), int('author_id', false)],
        foreignKeys: [
          {
            name: 'FK_x',
            columns: ['author_id'],
            referencedTable: 'authors',
            referencedColumns: ['id'],
            deferrable: 'INITIALLY_DEFERRED',
          },
        ],
      }),
    );
    assert.deepEqual(deferred.tables[1]?.foreignKeys?.[0]?.deferrable, 'INITIALLY_DEFERRED');

    const immediate = normalizeSchemaState(
      schema(authors(), {
        name: 'posts',
        columns: [pk(), int('author_id', false)],
        foreignKeys: [
          {
            name: 'FK_x',
            columns: ['author_id'],
            referencedTable: 'authors',
            referencedColumns: ['id'],
            deferrable: 'INITIALLY_IMMEDIATE',
          },
        ],
      }),
    );
    assert.deepEqual(immediate.tables[1]?.foreignKeys?.[0]?.deferrable, 'INITIALLY_IMMEDIATE');
  });

  it('rejects unknown deferrable value on a foreign key', () => {
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(authors(), {
            name: 'posts',
            columns: [pk(), int('author_id', false)],
            foreignKeys: [
              {
                name: 'FK_x',
                columns: ['author_id'],
                referencedTable: 'authors',
                referencedColumns: ['id'],
                deferrable: 'NONSENSE',
              } as unknown as ForeignKeyDefinition,
            ],
          }),
        ),
      /deferrable/,
    );
  });

  it('rejects a foreign key referencing an unknown table', () => {
    assert.throws(
      () =>
        normalizeSchemaState(
          schema({
            name: 'posts',
            columns: [pk(), int('author_id', false)],
            foreignKeys: [fk('FK_x', ['author_id'], 'missing', ['id'])],
          }),
        ),
      /references unknown table/,
    );
  });

  it('rejects a foreign key referencing an unknown column', () => {
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(authors(), {
            name: 'posts',
            columns: [pk(), int('author_id', false)],
            foreignKeys: [fk('FK_x', ['author_id'], 'authors', ['nope'])],
          }),
        ),
      /references unknown column/,
    );
  });

  it('accepts composite foreign keys with matching column counts', () => {
    const normalized = normalizeSchemaState(
      schema(table('authors', pk('tenant_id'), pk('user_id'), str('name', 100)), {
        name: 'posts',
        columns: [pk(), int('tenant_id', false), int('user_id', false)],
        foreignKeys: [fk('FK_x', ['tenant_id', 'user_id'], 'authors', ['tenant_id', 'user_id'])],
      }),
    );
    const posts = normalized.tables.find((t) => t.name === 'posts');
    assert.ok(posts);
    assert.deepEqual(posts.foreignKeys?.[0]?.columns, ['tenant_id', 'user_id']);
    assert.deepEqual(posts.foreignKeys?.[0]?.referencedColumns, ['tenant_id', 'user_id']);
  });

  it('rejects a composite foreign key with mismatched column counts', () => {
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(authors(), {
            name: 'posts',
            columns: [pk(), int('a', false), int('b', false)],
            foreignKeys: [fk('FK_x', ['a', 'b'], 'authors', ['id'])],
          }),
        ),
      /they must match/,
    );
  });

  it('rejects an invalid onDelete action', () => {
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(authors(), {
            name: 'posts',
            columns: [pk(), int('author_id', false)],
            foreignKeys: [
              {
                name: 'FK_x',
                columns: ['author_id'],
                referencedTable: 'authors',
                referencedColumns: ['id'],
                onDelete: 'destroy' as never,
              },
            ],
          }),
        ),
      /must be one of cascade, restrict, setNull, noAction/,
    );
  });

  it('generates create_table ops then add_fk, with no inline foreign keys', () => {
    const desired = schema(authors(), postsWithFk());
    const migration = generateMigration('create', [], desired);
    assert.ok(migration);
    assert.deepEqual(
      migration.operations.map((op) => op.kind),
      ['create_table', 'create_table', 'add_fk'],
    );
    for (const op of migration.operations) {
      if (op.kind === 'create_table') {
        assert.equal(op.table.foreignKeys, undefined);
      }
    }
    const addFk = migration.operations.find((op) => op.kind === 'add_fk');
    assert.ok(addFk && addFk.kind === 'add_fk');
    assert.deepEqual(addFk.foreignKey, {
      name: 'FK_posts_author',
      columns: ['author_id'],
      referencedTable: 'authors',
      referencedColumns: ['id'],
    });
    assert.ok(schemasEqual(replay([migration]), desired));
  });

  it('emits add_fk when a foreign key is added to existing tables', () => {
    const first = generateMigration(
      'create',
      [],
      schema(authors(), table('posts', pk(), int('author_id', false))),
    );
    assert.ok(first);
    const second = generateMigration('add_fk', [first], schema(authors(), postsWithFk()));
    assert.ok(second);
    assert.deepEqual(
      second.operations.map((op) => op.kind),
      ['add_fk'],
    );
    assert.ok(schemasEqual(replay([first, second]), schema(authors(), postsWithFk())));
  });

  it('requires allowDestructive to drop a foreign key', () => {
    const first = generateMigration('create', [], schema(authors(), postsWithFk()));
    assert.ok(first);
    const desired = schema(authors(), table('posts', pk(), int('author_id', false)));
    assert.throws(() => generateMigration('drop_fk', [first], desired), /destructive/);
    const dropped = generateMigration('drop_fk', [first], desired, { allowDestructive: true });
    assert.ok(dropped);
    assert.deepEqual(
      dropped.operations.map((op) => op.kind),
      ['drop_fk'],
    );
    assert.ok(schemasEqual(replay([first, dropped]), desired));
  });

  it('requires allowDestructive to change a foreign key definition', () => {
    const first = generateMigration('create', [], schema(authors(), postsWithFk()));
    assert.ok(first);
    const changed = schema(authors(), postsWithFk('cascade'));
    assert.throws(() => generateMigration('change_fk', [first], changed), /destructive/);
    const migrated = generateMigration('change_fk', [first], changed, { allowDestructive: true });
    assert.ok(migrated);
    assert.deepEqual(
      migrated.operations.map((op) => op.kind),
      ['drop_fk', 'add_fk'],
    );
    assert.ok(schemasEqual(replay([first, migrated]), changed));
  });

  it('cascades a local column rename to the foreign key columns', () => {
    const first = generateMigration('create', [], schema(authors(), postsWithFk()));
    assert.ok(first);
    const desired = schema(authors(), {
      name: 'posts',
      columns: [pk(), int('authorId', false)],
      foreignKeys: [fk('FK_posts_author', ['authorId'], 'authors', ['id'])],
    });
    const renamed = generateMigration('rename', [first], desired, {
      renames: [{ table: 'posts', from: 'author_id', to: 'authorId' }],
    });
    assert.ok(renamed);
    assert.deepEqual(
      renamed.operations.map((op) => op.kind),
      ['rename_column'],
    );
    assert.ok(schemasEqual(replay([first, renamed]), desired));
  });

  it('cascades a referenced-column rename to foreign keys on other tables', () => {
    const first = generateMigration('create', [], schema(authors(), postsWithFk()));
    assert.ok(first);
    const desired = schema(table('authors', pk('uuid')), {
      name: 'posts',
      columns: [pk(), int('author_id', false)],
      foreignKeys: [fk('FK_posts_author', ['author_id'], 'authors', ['uuid'])],
    });
    const renamed = generateMigration('rename', [first], desired, {
      renames: [{ table: 'authors', from: 'id', to: 'uuid' }],
    });
    assert.ok(renamed);
    assert.deepEqual(
      renamed.operations.map((op) => op.kind),
      ['rename_column'],
    );
    assert.ok(schemasEqual(replay([first, renamed]), desired));
  });

  it('drops a foreign key before dropping its referenced table and column', () => {
    const first = generateMigration('create', [], schema(authors(), postsWithFk()));
    assert.ok(first);
    const desired = schema(table('posts', pk()));
    const migrated = generateMigration('drop', [first], desired, { allowDestructive: true });
    assert.ok(migrated);
    const kinds = migrated.operations.map((op) => op.kind);
    assert.ok(kinds.indexOf('drop_fk') < kinds.indexOf('drop_table'));
    assert.ok(kinds.indexOf('drop_fk') < kinds.indexOf('drop_column'));
    assert.ok(schemasEqual(replay([first, migrated]), desired));
  });

  it('adds a foreign key after its join column', () => {
    const first = generateMigration('create', [], schema(authors(), table('posts', pk())));
    assert.ok(first);
    // The join column is nullable so it can be added to an existing table
    // without a default (a required column would correctly trip the gate).
    const desired = schema(authors(), {
      name: 'posts',
      columns: [pk(), int('author_id')],
      foreignKeys: [fk('FK_posts_author', ['author_id'], 'authors', ['id'])],
    });
    const migrated = generateMigration('add', [first], desired);
    assert.ok(migrated);
    const kinds = migrated.operations.map((op) => op.kind);
    assert.ok(kinds.indexOf('add_column') < kinds.indexOf('add_fk'));
    assert.ok(schemasEqual(replay([first, migrated]), desired));
  });

  it('roundtrips add_fk/drop_fk through inverses', () => {
    const ops: Operation[] = [
      { kind: 'create_table', table: table('authors', pk()) },
      { kind: 'create_table', table: table('posts', pk(), int('author_id', false)) },
      {
        kind: 'add_fk',
        table: 'posts',
        foreignKey: fk('FK_posts_author', ['author_id'], 'authors', ['id']),
      },
    ];
    let state: SchemaState = { tables: [] };
    for (const op of ops) {
      state = applyOperation(state, op);
    }
    for (const op of [...ops].reverse()) {
      state = applyOperation(state, invertOperation(op));
    }
    assert.ok(schemasEqual(state, { tables: [] }));
  });

  it('roundtrips deferrable FK/unique through inverses', () => {
    const ops: Operation[] = [
      {
        kind: 'create_table',
        table: table('authors', pk()),
      },
      {
        kind: 'create_table',
        table: table('users', pk(), str('email', 255, false)),
      },
      {
        kind: 'add_unique',
        table: 'users',
        unique: { name: 'uq_email', columns: ['email'], deferrable: 'INITIALLY_DEFERRED' },
      },
      {
        kind: 'add_fk',
        table: 'users',
        foreignKey: {
          name: 'FK_u_a',
          columns: ['email'],
          referencedTable: 'authors',
          referencedColumns: ['id'],
          deferrable: 'INITIALLY_IMMEDIATE',
        } as unknown as ForeignKeyDefinition,
      },
    ];
    let state: SchemaState = { tables: [] };
    for (const op of ops) {
      state = applyOperation(state, op);
    }
    for (const op of [...ops].reverse()) {
      state = applyOperation(state, invertOperation(op));
    }
    assert.ok(schemasEqual(state, { tables: [] }));
  });

  it('generates create_table then add_fk ops for an M2M junction-table schema', () => {
    const desired = schema(
      table('posts', pk(), str('title', 200)),
      table('tags', pk(), str('name', 100)),
      {
        name: 'post_tags',
        columns: [pk(), int('post_id', false), int('tag_id', false)],
        foreignKeys: [
          fk('FK_post_tags_post', ['post_id'], 'posts', ['id'], 'cascade'),
          fk('FK_post_tags_tag', ['tag_id'], 'tags', ['id'], 'cascade'),
        ],
      },
    );
    const migration = generateMigration('create_m2m', [], desired);
    assert.ok(migration);
    // Three create_table ops (posts, tags, post_tags), then two add_fk ops.
    // The junction table must be created before its FKs are added, and the
    // referenced tables must be created before the junction table.
    assert.deepEqual(
      migration.operations.map((op) => op.kind),
      ['create_table', 'create_table', 'create_table', 'add_fk', 'add_fk'],
    );
    // create_table ops carry no inline foreign keys.
    for (const op of migration.operations) {
      if (op.kind === 'create_table') {
        assert.equal(op.table.foreignKeys, undefined);
      }
    }
    // The FK ops reference the correct tables.
    const fkKinds = migration.operations.filter((op) => op.kind === 'add_fk');
    assert.equal(fkKinds.length, 2);
    const fkTables = fkKinds.map((op) => (op.kind === 'add_fk' ? op.table : '')).sort();
    assert.deepEqual(fkTables, ['post_tags', 'post_tags']);

    assert.ok(schemasEqual(replay([migration]), desired));
  });

  it('roundtrips composite add_fk/drop_fk through inverses', () => {
    const ops: Operation[] = [
      {
        kind: 'create_table',
        table: table('authors', pk('tenant_id'), pk('user_id')),
      },
      { kind: 'create_table', table: table('posts', pk(), int('t', false), int('u', false)) },
      {
        kind: 'add_fk',
        table: 'posts',
        foreignKey: fk('FK_posts_authors', ['t', 'u'], 'authors', ['tenant_id', 'user_id']),
      },
    ];
    let state: SchemaState = { tables: [] };
    for (const op of ops) {
      state = applyOperation(state, op);
    }
    for (const op of [...ops].reverse()) {
      state = applyOperation(state, invertOperation(op));
    }
    assert.ok(schemasEqual(state, { tables: [] }));
  });

  it('cascades a local column rename in a composite foreign key', () => {
    const first = generateMigration(
      'create',
      [],
      schema(table('authors', pk('tenant_id'), pk('user_id')), {
        name: 'posts',
        columns: [pk(), int('a', false), int('b', false)],
        foreignKeys: [fk('FK_posts_authors', ['a', 'b'], 'authors', ['tenant_id', 'user_id'])],
      }),
    );
    assert.ok(first);

    // Rename column 'a' to 'x' in the composite FK
    const desired = schema(table('authors', pk('tenant_id'), pk('user_id')), {
      name: 'posts',
      columns: [pk(), int('x', false), int('b', false)],
      foreignKeys: [fk('FK_posts_authors', ['x', 'b'], 'authors', ['tenant_id', 'user_id'])],
    });
    const renamed = generateMigration('rename', [first], desired, {
      renames: [{ table: 'posts', from: 'a', to: 'x' }],
    });
    assert.ok(renamed);
    assert.deepEqual(
      renamed.operations.map((op) => op.kind),
      ['rename_column'],
    );
    assert.ok(schemasEqual(replay([first, renamed]), desired));
  });

  it('cascades a referenced-column rename in a composite foreign key', () => {
    const first = generateMigration(
      'create',
      [],
      schema(table('authors', pk('tenant'), pk('user')), {
        name: 'posts',
        columns: [pk(), int('a', false), int('b', false)],
        foreignKeys: [fk('FK_posts_authors', ['a', 'b'], 'authors', ['tenant', 'user'])],
      }),
    );
    assert.ok(first);

    // Rename referenced column 'tenant' to 'tenant_id'
    const desired = schema(table('authors', pk('tenant_id'), pk('user')), {
      name: 'posts',
      columns: [pk(), int('a', false), int('b', false)],
      foreignKeys: [fk('FK_posts_authors', ['a', 'b'], 'authors', ['tenant_id', 'user'])],
    });
    const renamed = generateMigration('rename', [first], desired, {
      renames: [{ table: 'authors', from: 'tenant', to: 'tenant_id' }],
    });
    assert.ok(renamed);
    assert.deepEqual(
      renamed.operations.map((op) => op.kind),
      ['rename_column'],
    );
    assert.ok(schemasEqual(replay([first, renamed]), desired));
  });

  it('generates create_table + add_fk for composite FK junction table', () => {
    const desired = schema(
      table('orders', pk(), str('product', 200)),
      table('items', pk(), str('name', 100)),
      {
        name: 'order_items',
        columns: [pk('order_id'), pk('item_id'), int('quantity', true)],
        foreignKeys: [
          fk('FK_o_i_order', ['order_id'], 'orders', ['id'], 'cascade'),
          fk('FK_o_i_item', ['item_id'], 'items', ['id'], 'cascade'),
        ],
      },
    );
    const migration = generateMigration('create_composite', [], desired);
    assert.ok(migration);
    // Three create_table ops, then two add_fk ops.
    assert.deepEqual(
      migration.operations.map((op) => op.kind),
      ['create_table', 'create_table', 'create_table', 'add_fk', 'add_fk'],
    );
    for (const op of migration.operations) {
      if (op.kind === 'create_table') {
        assert.equal(op.table.foreignKeys, undefined);
      }
    }
    assert.ok(schemasEqual(replay([migration]), desired));
  });

  it('accepts and normalizes a composite PK table', () => {
    const s = schema(table('order_items', pk('order_id'), pk('item_id'), int('quantity', true)));
    const normalized = normalizeSchemaState(s);
    const tbl = normalized.tables[0];
    assert.ok(tbl);
    assert.equal(tbl.columns.length, 3);
    // PK columns are sorted first, by name.
    assert.deepEqual(
      tbl.columns.map((c) => c.name),
      ['item_id', 'order_id', 'quantity'],
    );
    assert.ok(tbl.columns.every((c) => (c.primaryKey ? !c.nullable : true)));
  });
});

describe('rename_table operations', () => {
  it('renames a table and rewrites FK referencedTable on other tables', () => {
    const state = applyOperation(
      { tables: [] },
      { kind: 'create_table', table: table('authors', pk(), str('name', 100)) },
    );
    const withPosts = applyOperation(
      applyOperation(state, {
        kind: 'create_table',
        table: table('posts', pk(), int('author_id', false)),
      }),
      {
        kind: 'add_fk',
        table: 'posts',
        foreignKey: fk('FK_posts_author', ['author_id'], 'authors', ['id'], 'cascade'),
      },
    );

    const renamed = applyOperation(withPosts, {
      kind: 'rename_table',
      from: 'authors',
      to: 'writers',
    });

    // The table itself is renamed.
    assert.ok(renamed.tables.some((t) => t.name === 'writers'));
    assert.ok(!renamed.tables.some((t) => t.name === 'authors'));

    // The FK's referencedTable follows the rename.
    const posts = renamed.tables.find((t) => t.name === 'posts');
    assert.ok(posts);
    const postFk = posts.foreignKeys?.[0];
    assert.ok(postFk);
    assert.equal(postFk.referencedTable, 'writers');
    assert.equal(postFk.onDelete, 'cascade');
  });

  it('roundtrips through invertOperation', () => {
    const state = applyOperation(
      { tables: [] },
      { kind: 'create_table', table: table('users', pk(), str('email', 100)) },
    );
    const renamed = applyOperation(state, { kind: 'rename_table', from: 'users', to: 'accounts' });
    const inverse = invertOperation({ kind: 'rename_table', from: 'users', to: 'accounts' });
    assert.deepEqual(inverse, { kind: 'rename_table', from: 'accounts', to: 'users' });

    const restored = applyOperation(renamed, inverse);
    assert.ok(restored.tables.some((t) => t.name === 'users'));
    assert.ok(!restored.tables.some((t) => t.name === 'accounts'));
  });

  it('rejects from === to', () => {
    assert.throws(
      () =>
        applyOperation(schema(table('users', pk())), {
          kind: 'rename_table',
          from: 'users',
          to: 'users',
        }),
      /to itself/,
    );
  });

  it('rejects a missing source table', () => {
    assert.throws(
      () =>
        applyOperation({ tables: [] }, { kind: 'rename_table', from: 'missing', to: 'present' }),
      /does not exist/,
    );
  });

  it('rejects when the target table already exists', () => {
    const state = schema(table('users', pk()), table('admins', pk()));
    assert.throws(
      () => applyOperation(state, { kind: 'rename_table', from: 'users', to: 'admins' }),
      /already exists/,
    );
  });

  it('rejects an unknown rename_table operation from validateOperation', () => {
    // validateOperation must NOT reject 'rename_table' as unknown
    const op = validateOperation({ kind: 'rename_table', from: 'a', to: 'b' });
    assert.deepEqual(op, { kind: 'rename_table', from: 'a', to: 'b' });
  });

  it('rejects invalid identifiers in validateOperation', () => {
    assert.throws(
      () => validateOperation({ kind: 'rename_table', from: 'bad name', to: 'good' }),
      MigrationError,
    );
    assert.throws(
      () => validateOperation({ kind: 'rename_table', from: 'good', to: '1bad' }),
      MigrationError,
    );
  });
});

describe('generateMigration: table renames', () => {
  const authorsTable = (name: string): TableDefinition => ({
    name,
    columns: [pk(), str('name', 100)],
  });
  const postsTable = (authorTable: string, fkName: string): TableDefinition => ({
    name: 'posts',
    columns: [pk(), int('author_id', false)],
    foreignKeys: [fk(fkName, ['author_id'], authorTable, ['id'], 'cascade')],
  });

  it('emits rename_table from a tableRenames hint, without allowDestructive', () => {
    const first = generateMigration(
      'create',
      [],
      schema(authorsTable('authors'), postsTable('authors', 'FK_posts_author')),
    );
    assert.ok(first);

    const desired = schema(authorsTable('writers'), postsTable('writers', 'FK_posts_author'));
    const renamed = generateMigration('rename_authors', [first], desired, {
      tableRenames: [{ from: 'authors', to: 'writers' }],
    });
    assert.ok(renamed);
    assert.ok(renamed.operations.some((op) => op.kind === 'rename_table'));
    // Must NOT contain drop_table / create_table for the renamed table.
    assert.ok(!renamed.operations.some((op) => op.kind === 'drop_table'));
    assert.ok(
      !renamed.operations.some((op) => op.kind === 'create_table' && op.table.name === 'writers'),
    );
    // FK should not trigger destructive add/drop because the table rename reconciles it.
    assert.ok(!renamed.operations.some((op) => op.kind === 'drop_fk'));
    assert.ok(!renamed.operations.some((op) => op.kind === 'add_fk'));

    assert.ok(schemasEqual(replay([first, renamed]), desired));
  });

  it('rejects a hint that maps a table to itself', () => {
    const first = generateMigration('create', [], schema(table('users', pk())));
    assert.ok(first);
    const desired = schema(table('accounts', pk()));
    assert.throws(
      () =>
        generateMigration('bad_hint', [first], desired, {
          tableRenames: [{ from: 'users', to: 'users' }],
        }),
      /to itself/,
    );
  });

  it('rejects a hint when the from table does not exist in current', () => {
    const first = generateMigration('create', [], schema(table('users', pk())));
    assert.ok(first);
    const desired = schema(table('accounts', pk()));
    assert.throws(
      () =>
        generateMigration('bad_hint', [first], desired, {
          tableRenames: [{ from: 'nope', to: 'accounts' }],
        }),
      /not in the current schema/,
    );
  });

  it('rejects a hint when the to table does not exist in desired', () => {
    const first = generateMigration('create', [], schema(table('users', pk())));
    assert.ok(first);
    const desired = schema(table('accounts', pk()));
    assert.throws(
      () =>
        generateMigration('bad_hint', [first], desired, {
          tableRenames: [{ from: 'users', to: 'nope' }],
        }),
      /not in the desired schema/,
    );
  });

  it('table rename without hint still requires allowDestructive', () => {
    const first = generateMigration('create', [], schema(table('users', pk())));
    assert.ok(first);
    assert.throws(
      () => generateMigration('drop_users', [first], schema(table('accounts', pk()))),
      /destructive/,
    );
    const dropped = generateMigration('drop_users', [first], schema(table('accounts', pk())), {
      allowDestructive: true,
    });
    assert.ok(dropped);
    assert.ok(dropped.operations.some((op) => op.kind === 'drop_table'));
    assert.ok(dropped.operations.some((op) => op.kind === 'create_table'));
  });
});

describe('inheritance descriptor validation (normalizeTable)', () => {
  const tbl = (
    name: string,
    columns: ColumnDefinition[],
    inheritance?: TableDefinition['inheritance'],
  ): TableDefinition => {
    const table: TableDefinition = { name, columns };
    if (inheritance !== undefined) {
      table.inheritance = inheritance;
    }
    return table;
  };

  it('accepts a valid STI inheritance descriptor', () => {
    const normalized = normalizeSchemaState(
      schema(
        tbl(
          'vehicles',
          [
            pk(),
            str('name', 100, false),
            { name: 'type', type: 'varchar', length: 50, nullable: false },
          ],
          {
            strategy: 'single',
            discriminatorColumn: 'type',
            discriminatorValues: ['car', 'truck'],
          },
        ),
      ),
    );
    assert.deepEqual(normalized.tables[0]?.inheritance, {
      strategy: 'single',
      discriminatorColumn: 'type',
      discriminatorValues: ['car', 'truck'],
    });
  });

  it('accepts a table without any inheritance descriptor', () => {
    const normalized = normalizeSchemaState(schema(table('users', pk(), str('name', 100))));
    assert.equal(normalized.tables[0]?.inheritance, undefined);
  });

  it('rejects a non-object inheritance descriptor', () => {
    assert.throws(
      () =>
        normalizeSchemaState(
          schema({
            name: 'items',
            columns: [pk()],
            inheritance: 'single',
          } as unknown as TableDefinition),
        ),
      /"inheritance" must be an object/,
    );
  });

  it('rejects an unknown inheritance strategy', () => {
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(
            tbl('items', [pk(), { name: 'type', type: 'varchar', length: 50, nullable: false }], {
              strategy: 'joined',
              discriminatorColumn: 'type',
              discriminatorValues: ['book'],
            } as unknown as TableDefinition['inheritance']),
          ),
        ),
      /"inheritance.strategy" must be "single"/,
    );
  });

  it('rejects empty discriminatorValues', () => {
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(
            tbl('items', [pk(), { name: 'type', type: 'varchar', length: 50, nullable: false }], {
              strategy: 'single',
              discriminatorColumn: 'type',
              discriminatorValues: [],
            }),
          ),
        ),
      /must be a non-empty array/,
    );
  });

  it('rejects an invalid discriminatorColumn identifier', () => {
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(
            tbl('items', [pk()], {
              strategy: 'single',
              discriminatorColumn: 'bad name',
              discriminatorValues: ['book'],
            }),
          ),
        ),
      /invalid identifier/,
    );
  });

  it('rejects a discriminatorColumn that does not exist in the table', () => {
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(
            tbl('items', [pk(), str('name', 100)], {
              strategy: 'single',
              discriminatorColumn: 'missing_col',
              discriminatorValues: ['book'],
            }),
          ),
        ),
      /does not exist in the table/,
    );
  });

  it('rejects duplicate discriminator values', () => {
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(
            tbl('items', [pk(), { name: 'type', type: 'varchar', length: 50, nullable: false }], {
              strategy: 'single',
              discriminatorColumn: 'type',
              discriminatorValues: ['book', 'book'],
            }),
          ),
        ),
      /duplicate discriminator value/,
    );
  });

  it('rejects non-string discriminator values', () => {
    assert.throws(
      () =>
        normalizeSchemaState(
          schema(
            tbl('items', [pk(), { name: 'type', type: 'varchar', length: 50, nullable: false }], {
              strategy: 'single',
              discriminatorColumn: 'type',
              discriminatorValues: [42 as unknown as string],
            }),
          ),
        ),
      /must be a string/,
    );
  });

  it('preserves inheritance descriptor through tablesEqual', async () => {
    const a = tbl(
      'items',
      [pk(), { name: 'type', type: 'varchar', length: 50, nullable: false }, str('name', 100)],
      { strategy: 'single', discriminatorColumn: 'type', discriminatorValues: ['a', 'b'] },
    );
    const b = tbl(
      'items',
      [pk(), { name: 'type', type: 'varchar', length: 50, nullable: false }, str('name', 100)],
      { strategy: 'single', discriminatorColumn: 'type', discriminatorValues: ['a', 'b'] },
    );
    const { tablesEqual } = await import('../../src/migrations/schema-state.js');
    assert.ok(tablesEqual(a, b));
  });

  it('distinguishes tables by inheritance descriptor', async () => {
    const a = tbl('items', [pk(), { name: 'type', type: 'varchar', length: 50, nullable: false }], {
      strategy: 'single',
      discriminatorColumn: 'type',
      discriminatorValues: ['a'],
    });
    const b = tbl('items', [pk(), { name: 'type', type: 'varchar', length: 50, nullable: false }], {
      strategy: 'single',
      discriminatorColumn: 'type',
      discriminatorValues: ['a', 'b'],
    });
    const { tablesEqual } = await import('../../src/migrations/schema-state.js');
    assert.ok(!tablesEqual(a, b));
  });
});
