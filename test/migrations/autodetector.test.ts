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
} from '../../src/migrations/schema-types.js';
import { normalizeSchemaState } from '../../src/migrations/schema-normalize.js';
import { schemasEqual } from '../../src/migrations/schema-compare.js';
import {
  type Operation,
  applyOperation,
  applyOperations,
  validateOperation,
} from '../../src/migrations/operations.js';
import { buildSchemaPlan } from '../../src/migrations/reconciler.js';
import type { AutodetectOptions } from '../../src/migrations/autodetector.js';

const EMPTY: SchemaState = { tables: [] };

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

/**
 * Operations to reach `desired` from `current`. Replaces the removed
 * `generateMigration(name, [current], desired, options)`.
 */
function diff(
  current: SchemaState,
  desired: SchemaState,
  options?: AutodetectOptions,
): readonly Operation[] {
  return buildSchemaPlan(desired, current, options).operations;
}

/**
 * Fold operation lists over an empty schema, applying each list in order.
 * Replaces the removed `replayMigrationHistory`.
 */
function replay(opLists: readonly (readonly Operation[])[]): SchemaState {
  return opLists.reduce<SchemaState>(
    (state, operations) => applyOperations(state, [...operations]),
    EMPTY,
  );
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

describe('diffSchemaStates: initial generation and replay', () => {
  it('generates a create_table operation for an empty schema', () => {
    const desired = schema(table('users', pk(), str('email', 255, false)));
    const operations = diff(EMPTY, desired);
    assert.equal(operations.length, 1);
    assert.equal(operations[0]?.kind, 'create_table');
    assert.ok(schemasEqual(replay([operations]), desired));
  });

  it('returns no operations when there is no change', () => {
    const desired = schema(table('users', pk(), str('email', 255)));
    assert.ok(diff(EMPTY, desired).length > 0);
    assert.deepEqual(diff(desired, desired), []);
  });

  it('adds a new table incrementally', () => {
    const firstDesired = schema(table('users', pk(), str('email', 255)));
    const firstOps = diff(EMPTY, firstDesired);
    const bothDesired = schema(
      table('users', pk(), str('email', 255)),
      table('posts', pk(), str('title', 200)),
    );
    const secondOps = diff(firstDesired, bothDesired);
    assert.equal(secondOps[0]?.kind, 'create_table');
    assert.ok(
      schemasEqual(
        replay([firstOps, secondOps]),
        schema(table('users', pk(), str('email', 255)), table('posts', pk(), str('title', 200))),
      ),
    );
  });

  it('adds a nullable column incrementally', () => {
    const firstDesired = schema(table('users', pk(), str('email', 255)));
    const secondDesired = schema(table('users', pk(), str('email', 255), int('age')));
    const secondOps = diff(firstDesired, secondDesired);
    assert.equal(secondOps[0]?.kind, 'add_column');
  });
});

describe('diffSchemaStates: determinism', () => {
  it('produces identical operations regardless of input ordering', () => {
    const a = schema(table('z', str('b', 10), pk(), int('a')), table('a', int('z'), pk()));
    const b = schema(table('a', pk(), int('z')), table('z', pk(), int('a'), str('b', 10)));
    assert.deepEqual(diff(EMPTY, a), diff(EMPTY, b));
  });
});

describe('destructive changes and renames', () => {
  it('rejects dropping a table without allowDestructive', () => {
    const firstDesired = schema(table('users', pk()));
    const firstOps = diff(EMPTY, firstDesired);
    assert.throws(() => diff(firstDesired, schema()), /destructive/);
    const dropOps = diff(firstDesired, schema(), { allowDestructive: true });
    assert.equal(dropOps[0]?.kind, 'drop_table');
    assert.ok(schemasEqual(replay([firstOps, dropOps]), schema()));
  });

  it('rejects an ambiguous column removal without a rename hint or opt-in', () => {
    const firstDesired = schema(table('users', pk(), str('old_name', 100)));
    const desired = schema(table('users', pk(), str('new_name', 100)));
    assert.throws(() => diff(firstDesired, desired), /ambiguous removal/);
    // destructive opt-in resolves it as drop + add
    const droppedOps = diff(firstDesired, desired, { allowDestructive: true });
    assert.ok(droppedOps.some((op) => op.kind === 'drop_column'));
    assert.ok(droppedOps.some((op) => op.kind === 'add_column'));
  });

  it('applies an explicit rename hint safely', () => {
    const firstDesired = schema(table('users', pk(), str('old_name', 100)));
    const firstOps = diff(EMPTY, firstDesired);
    const desired = schema(table('users', pk(), str('new_name', 100)));
    const renamedOps = diff(firstDesired, desired, {
      renames: [{ table: 'users', from: 'old_name', to: 'new_name' }],
    });
    assert.equal(renamedOps[0]?.kind, 'rename_column');
    assert.ok(schemasEqual(replay([firstOps, renamedOps]), desired));
  });

  it('rejects adding a required column without a default to an existing table', () => {
    const firstDesired = schema(table('users', pk()));
    const desired = schema(
      table('users', pk(), { name: 'must', type: 'varchar', length: 10, nullable: false }),
    );
    assert.throws(() => diff(firstDesired, desired), /without a default/);
  });

  it('permits a required column when it has a default', () => {
    const firstDesired = schema(table('users', pk()));
    const desired = schema(
      table('users', pk(), {
        name: 'must',
        type: 'varchar',
        length: 10,
        nullable: false,
        default: 'x',
      }),
    );
    const addedOps = diff(firstDesired, desired);
    assert.equal(addedOps[0]?.kind, 'add_column');
  });

  it('rejects a type alteration without allowDestructive', () => {
    const firstDesired = schema(table('users', pk(), int('age')));
    const desired = schema(table('users', pk(), str('age', 10)));
    assert.throws(() => diff(firstDesired, desired), /destructive/);
    const alteredOps = diff(firstDesired, desired, { allowDestructive: true });
    assert.equal(alteredOps[0]?.kind, 'alter_column');
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
    const firstDesired = schema(table('users', pk(), str('email', 100)));
    const widened = schema(table('users', pk(), str('email', 200)));
    assert.throws(() => diff(firstDesired, widened), /destructive/);
    const optedOps = diff(firstDesired, widened, { allowDestructive: true });
    assert.equal(optedOps[0]?.kind, 'alter_column');
  });

  it('rejects narrowing without opt-in too', () => {
    const firstDesired = schema(table('users', pk(), str('email', 200)));
    const narrowed = schema(table('users', pk(), str('email', 100)));
    assert.throws(() => diff(firstDesired, narrowed), /destructive/);
  });

  it('allows a default-only change without opt-in', () => {
    const firstDesired = schema(table('users', pk(), emailDefault(100, 'a')));
    const changed = schema(table('users', pk(), emailDefault(100, 'b')));
    const operations = diff(firstDesired, changed);
    assert.equal(operations[0]?.kind, 'alter_column');
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
    const operations = diff(EMPTY, desired);
    assert.equal(operations[0]?.kind, 'create_table');
    assert.ok(schemasEqual(replay([operations]), desired));
  });

  it('emits add_index for a new index', () => {
    const firstDesired = schema(tbl('users', [pk(), str('email', 255)]));
    const secondDesired = schema(
      tbl('users', [pk(), str('email', 255)], [idx('idx_email', ['email'])]),
    );
    const secondOps = diff(firstDesired, secondDesired);
    assert.deepEqual(
      secondOps.map((op) => op.kind),
      ['add_index'],
    );
  });

  it('emits add_unique for a new unique constraint', () => {
    const firstDesired = schema(tbl('users', [pk(), str('email', 255)]));
    const secondDesired = schema(
      tbl('users', [pk(), str('email', 255)], undefined, [uq('uq_email', ['email'])]),
    );
    const secondOps = diff(firstDesired, secondDesired);
    assert.deepEqual(
      secondOps.map((op) => op.kind),
      ['add_unique'],
    );
  });

  it('requires allowDestructive to drop an index', () => {
    const firstDesired = schema(
      tbl('users', [pk(), str('email', 255)], [idx('idx_email', ['email'])]),
    );
    const firstOps = diff(EMPTY, firstDesired);
    const desired = schema(tbl('users', [pk(), str('email', 255)]));
    assert.throws(() => diff(firstDesired, desired), /destructive/);
    const droppedOps = diff(firstDesired, desired, { allowDestructive: true });
    assert.deepEqual(
      droppedOps.map((op) => op.kind),
      ['drop_index'],
    );
    assert.ok(schemasEqual(replay([firstOps, droppedOps]), desired));
  });

  it('requires allowDestructive to drop a unique constraint', () => {
    const firstDesired = schema(
      tbl('users', [pk(), str('email', 255)], undefined, [uq('uq_email', ['email'])]),
    );
    const desired = schema(tbl('users', [pk(), str('email', 255)]));
    assert.throws(() => diff(firstDesired, desired), /destructive/);
    const droppedOps = diff(firstDesired, desired, { allowDestructive: true });
    assert.deepEqual(
      droppedOps.map((op) => op.kind),
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
    const firstDesired = schema(
      tbl('users', [pk(), str('email', 255)], [idx('idx_email', ['email'])]),
    );
    const firstOps = diff(EMPTY, firstDesired);
    const desired = schema(
      tbl('users', [pk(), str('email', 255)], [idx('idx_email', ['email'], true)]),
    );
    assert.throws(() => diff(firstDesired, desired), /destructive/);
    const changedOps = diff(firstDesired, desired, { allowDestructive: true });
    assert.ok(changedOps.some((op) => op.kind === 'drop_index'));
    assert.ok(changedOps.some((op) => op.kind === 'add_index'));
    assert.ok(schemasEqual(replay([firstOps, changedOps]), desired));
  });

  it('cascades a column rename to index and unique references', () => {
    const firstDesired = schema(
      tbl(
        'users',
        [pk(), str('old_name', 100)],
        [idx('idx_old', ['old_name'])],
        [uq('uq_old', ['old_name'])],
      ),
    );
    const firstOps = diff(EMPTY, firstDesired);
    const desired = schema(
      tbl(
        'users',
        [pk(), str('new_name', 100)],
        [idx('idx_old', ['new_name'])],
        [uq('uq_old', ['new_name'])],
      ),
    );
    const renamedOps = diff(firstDesired, desired, {
      renames: [{ table: 'users', from: 'old_name', to: 'new_name' }],
    });
    assert.deepEqual(
      renamedOps.map((op) => op.kind),
      ['rename_column'],
    );
    assert.ok(schemasEqual(replay([firstOps, renamedOps]), desired));
  });

  it('orders index drops before column drops and adds after adds', () => {
    const firstDesired = schema(
      tbl('users', [pk(), str('email', 255)], [idx('idx_email', ['email'])]),
    );
    const droppedOps = diff(firstDesired, schema(tbl('users', [pk()])), {
      allowDestructive: true,
    });
    assert.deepEqual(
      droppedOps.map((op) => op.kind),
      ['drop_index', 'drop_column'],
    );

    const addedOps = diff(
      schema(tbl('users', [pk()])),
      schema(tbl('users', [pk(), str('email', 255)], [idx('idx_email', ['email'])])),
    );
    assert.deepEqual(
      addedOps.map((op) => op.kind),
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
    const operations = diff(EMPTY, desired);
    assert.deepEqual(
      operations.map((op) => op.kind),
      ['create_table', 'create_table', 'add_fk'],
    );
    for (const op of operations) {
      if (op.kind === 'create_table') {
        assert.equal(op.table.foreignKeys, undefined);
      }
    }
    const addFk = operations.find((op) => op.kind === 'add_fk');
    assert.ok(addFk && addFk.kind === 'add_fk');
    assert.deepEqual(addFk.foreignKey, {
      name: 'FK_posts_author',
      columns: ['author_id'],
      referencedTable: 'authors',
      referencedColumns: ['id'],
    });
    assert.ok(schemasEqual(replay([operations]), desired));
  });

  it('emits add_fk when a foreign key is added to existing tables', () => {
    const firstDesired = schema(authors(), table('posts', pk(), int('author_id', false)));
    const firstOps = diff(EMPTY, firstDesired);
    const secondDesired = schema(authors(), postsWithFk());
    const secondOps = diff(firstDesired, secondDesired);
    assert.deepEqual(
      secondOps.map((op) => op.kind),
      ['add_fk'],
    );
    assert.ok(schemasEqual(replay([firstOps, secondOps]), schema(authors(), postsWithFk())));
  });

  it('requires allowDestructive to drop a foreign key', () => {
    const firstDesired = schema(authors(), postsWithFk());
    const firstOps = diff(EMPTY, firstDesired);
    const desired = schema(authors(), table('posts', pk(), int('author_id', false)));
    assert.throws(() => diff(firstDesired, desired), /destructive/);
    const droppedOps = diff(firstDesired, desired, { allowDestructive: true });
    assert.deepEqual(
      droppedOps.map((op) => op.kind),
      ['drop_fk'],
    );
    assert.ok(schemasEqual(replay([firstOps, droppedOps]), desired));
  });

  it('requires allowDestructive to change a foreign key definition', () => {
    const firstDesired = schema(authors(), postsWithFk());
    const firstOps = diff(EMPTY, firstDesired);
    const changed = schema(authors(), postsWithFk('cascade'));
    assert.throws(() => diff(firstDesired, changed), /destructive/);
    const migratedOps = diff(firstDesired, changed, { allowDestructive: true });
    assert.deepEqual(
      migratedOps.map((op) => op.kind),
      ['drop_fk', 'add_fk'],
    );
    assert.ok(schemasEqual(replay([firstOps, migratedOps]), changed));
  });

  it('cascades a local column rename to the foreign key columns', () => {
    const firstDesired = schema(authors(), postsWithFk());
    const firstOps = diff(EMPTY, firstDesired);
    const desired = schema(authors(), {
      name: 'posts',
      columns: [pk(), int('authorId', false)],
      foreignKeys: [fk('FK_posts_author', ['authorId'], 'authors', ['id'])],
    });
    const renamedOps = diff(firstDesired, desired, {
      renames: [{ table: 'posts', from: 'author_id', to: 'authorId' }],
    });
    assert.deepEqual(
      renamedOps.map((op) => op.kind),
      ['rename_column'],
    );
    assert.ok(schemasEqual(replay([firstOps, renamedOps]), desired));
  });

  it('cascades a referenced-column rename to foreign keys on other tables', () => {
    const firstDesired = schema(authors(), postsWithFk());
    const firstOps = diff(EMPTY, firstDesired);
    const desired = schema(table('authors', pk('uuid')), {
      name: 'posts',
      columns: [pk(), int('author_id', false)],
      foreignKeys: [fk('FK_posts_author', ['author_id'], 'authors', ['uuid'])],
    });
    const renamedOps = diff(firstDesired, desired, {
      renames: [{ table: 'authors', from: 'id', to: 'uuid' }],
    });
    assert.deepEqual(
      renamedOps.map((op) => op.kind),
      ['rename_column'],
    );
    assert.ok(schemasEqual(replay([firstOps, renamedOps]), desired));
  });

  it('drops a foreign key before dropping its referenced table and column', () => {
    const firstDesired = schema(authors(), postsWithFk());
    const firstOps = diff(EMPTY, firstDesired);
    const desired = schema(table('posts', pk()));
    const migratedOps = diff(firstDesired, desired, { allowDestructive: true });
    const kinds = migratedOps.map((op) => op.kind);
    assert.ok(kinds.indexOf('drop_fk') < kinds.indexOf('drop_table'));
    assert.ok(kinds.indexOf('drop_fk') < kinds.indexOf('drop_column'));
    assert.ok(schemasEqual(replay([firstOps, migratedOps]), desired));
  });

  it('adds a foreign key after its join column', () => {
    const firstDesired = schema(authors(), table('posts', pk()));
    const firstOps = diff(EMPTY, firstDesired);
    // The join column is nullable so it can be added to an existing table
    // without a default (a required column would correctly trip the gate).
    const desired = schema(authors(), {
      name: 'posts',
      columns: [pk(), int('author_id')],
      foreignKeys: [fk('FK_posts_author', ['author_id'], 'authors', ['id'])],
    });
    const migratedOps = diff(firstDesired, desired);
    const kinds = migratedOps.map((op) => op.kind);
    assert.ok(kinds.indexOf('add_column') < kinds.indexOf('add_fk'));
    assert.ok(schemasEqual(replay([firstOps, migratedOps]), desired));
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
    const operations = diff(EMPTY, desired);
    // Three create_table ops (posts, tags, post_tags), then two add_fk ops.
    // The junction table must be created before its FKs are added, and the
    // referenced tables must be created before the junction table.
    assert.deepEqual(
      operations.map((op) => op.kind),
      ['create_table', 'create_table', 'create_table', 'add_fk', 'add_fk'],
    );
    // create_table ops carry no inline foreign keys.
    for (const op of operations) {
      if (op.kind === 'create_table') {
        assert.equal(op.table.foreignKeys, undefined);
      }
    }
    // The FK ops reference the correct tables.
    const fkKinds = operations.filter((op) => op.kind === 'add_fk');
    assert.equal(fkKinds.length, 2);
    const fkTables = fkKinds.map((op) => (op.kind === 'add_fk' ? op.table : '')).sort();
    assert.deepEqual(fkTables, ['post_tags', 'post_tags']);

    assert.ok(schemasEqual(replay([operations]), desired));
  });

  it('cascades a local column rename in a composite foreign key', () => {
    const firstDesired = schema(table('authors', pk('tenant_id'), pk('user_id')), {
      name: 'posts',
      columns: [pk(), int('a', false), int('b', false)],
      foreignKeys: [fk('FK_posts_authors', ['a', 'b'], 'authors', ['tenant_id', 'user_id'])],
    });
    const firstOps = diff(EMPTY, firstDesired);

    // Rename column 'a' to 'x' in the composite FK
    const desired = schema(table('authors', pk('tenant_id'), pk('user_id')), {
      name: 'posts',
      columns: [pk(), int('x', false), int('b', false)],
      foreignKeys: [fk('FK_posts_authors', ['x', 'b'], 'authors', ['tenant_id', 'user_id'])],
    });
    const renamedOps = diff(firstDesired, desired, {
      renames: [{ table: 'posts', from: 'a', to: 'x' }],
    });
    assert.deepEqual(
      renamedOps.map((op) => op.kind),
      ['rename_column'],
    );
    assert.ok(schemasEqual(replay([firstOps, renamedOps]), desired));
  });

  it('cascades a referenced-column rename in a composite foreign key', () => {
    const firstDesired = schema(table('authors', pk('tenant'), pk('user')), {
      name: 'posts',
      columns: [pk(), int('a', false), int('b', false)],
      foreignKeys: [fk('FK_posts_authors', ['a', 'b'], 'authors', ['tenant', 'user'])],
    });
    const firstOps = diff(EMPTY, firstDesired);

    // Rename referenced column 'tenant' to 'tenant_id'
    const desired = schema(table('authors', pk('tenant_id'), pk('user')), {
      name: 'posts',
      columns: [pk(), int('a', false), int('b', false)],
      foreignKeys: [fk('FK_posts_authors', ['a', 'b'], 'authors', ['tenant_id', 'user'])],
    });
    const renamedOps = diff(firstDesired, desired, {
      renames: [{ table: 'authors', from: 'tenant', to: 'tenant_id' }],
    });
    assert.deepEqual(
      renamedOps.map((op) => op.kind),
      ['rename_column'],
    );
    assert.ok(schemasEqual(replay([firstOps, renamedOps]), desired));
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
    const operations = diff(EMPTY, desired);
    // Three create_table ops, then two add_fk ops.
    assert.deepEqual(
      operations.map((op) => op.kind),
      ['create_table', 'create_table', 'create_table', 'add_fk', 'add_fk'],
    );
    for (const op of operations) {
      if (op.kind === 'create_table') {
        assert.equal(op.table.foreignKeys, undefined);
      }
    }
    assert.ok(schemasEqual(replay([operations]), desired));
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

describe('diffSchemaStates: table renames', () => {
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
    const firstDesired = schema(authorsTable('authors'), postsTable('authors', 'FK_posts_author'));
    const firstOps = diff(EMPTY, firstDesired);

    const desired = schema(authorsTable('writers'), postsTable('writers', 'FK_posts_author'));
    const renamedOps = diff(firstDesired, desired, {
      tableRenames: [{ from: 'authors', to: 'writers' }],
    });
    assert.ok(renamedOps.some((op) => op.kind === 'rename_table'));
    // Must NOT contain drop_table / create_table for the renamed table.
    assert.ok(!renamedOps.some((op) => op.kind === 'drop_table'));
    assert.ok(!renamedOps.some((op) => op.kind === 'create_table' && op.table.name === 'writers'));
    // FK should not trigger destructive add/drop because the table rename reconciles it.
    assert.ok(!renamedOps.some((op) => op.kind === 'drop_fk'));
    assert.ok(!renamedOps.some((op) => op.kind === 'add_fk'));

    assert.ok(schemasEqual(replay([firstOps, renamedOps]), desired));
  });

  it('rejects a hint that maps a table to itself', () => {
    const firstDesired = schema(table('users', pk()));
    const desired = schema(table('accounts', pk()));
    assert.throws(
      () =>
        diff(firstDesired, desired, {
          tableRenames: [{ from: 'users', to: 'users' }],
        }),
      /to itself/,
    );
  });

  it('rejects a hint when the from table does not exist in current', () => {
    const firstDesired = schema(table('users', pk()));
    const desired = schema(table('accounts', pk()));
    assert.throws(
      () =>
        diff(firstDesired, desired, {
          tableRenames: [{ from: 'nope', to: 'accounts' }],
        }),
      /not in the current schema/,
    );
  });

  it('rejects a hint when the to table does not exist in desired', () => {
    const firstDesired = schema(table('users', pk()));
    const desired = schema(table('accounts', pk()));
    assert.throws(
      () =>
        diff(firstDesired, desired, {
          tableRenames: [{ from: 'users', to: 'nope' }],
        }),
      /not in the desired schema/,
    );
  });

  it('table rename without hint still requires allowDestructive', () => {
    const firstDesired = schema(table('users', pk()));
    assert.throws(() => diff(firstDesired, schema(table('accounts', pk()))), /destructive/);
    const droppedOps = diff(firstDesired, schema(table('accounts', pk())), {
      allowDestructive: true,
    });
    assert.ok(droppedOps.some((op) => op.kind === 'drop_table'));
    assert.ok(droppedOps.some((op) => op.kind === 'create_table'));
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
    const { tablesEqual } = await import('../../src/migrations/schema-compare.js');
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
    const { tablesEqual } = await import('../../src/migrations/schema-compare.js');
    assert.ok(!tablesEqual(a, b));
  });
});
