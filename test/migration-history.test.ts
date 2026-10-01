import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ColumnDefinition,
  MigrationError,
  type SchemaState,
  type TableDefinition,
  normalizeSchemaState,
  schemasEqual,
} from '../src/migrations/schema-state.js';
import {
  type Operation,
  applyOperation,
  invertOperation,
  validateOperation,
} from '../src/migrations/operations.js';
import {
  type MigrationDefinition,
  replayMigrationHistory,
  resolveMigrationOrder,
} from '../src/migrations/history.js';
import { generateMigration } from '../src/migrations/autodetector.js';

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
    assert.throws(
      () => normalizeSchemaState(schema(table('users', pk(), pk('id2')))),
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
    // two primary keys
    assert.throws(() => normalizeSchemaState(schema(table('u', pk('a'), pk('b')))), MigrationError);
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
      { kind: 'alter_column', table: 'users', column: str('years', 5), previous: int('years') },
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
