import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ColumnDefinition, TableDefinition } from '../../src/migrations/schema-state.js';
import { MigrationError, schemasEqual } from '../../src/migrations/schema-state.js';
import type { MigrationDefinition } from '../../src/migrations/history.js';
import { replayMigrationHistory } from '../../src/migrations/history.js';
import { squashMigrations } from '../../src/migrations/squash.js';

function pk(name = 'id'): ColumnDefinition {
  return { name, type: 'integer', nullable: false, primaryKey: true };
}

function str(name: string, length = 100): ColumnDefinition {
  return { name, type: 'varchar', length, nullable: true };
}

function int(name: string): ColumnDefinition {
  return { name, type: 'integer', nullable: true };
}

function table(name: string, ...columns: ColumnDefinition[]): TableDefinition {
  return { name, columns };
}

describe('squashMigrations', () => {
  it('returns null for an empty history', () => {
    const result = squashMigrations([], { name: 'squashed' });
    assert.equal(result, null);
  });

  it('squashes a single migration into an equivalent definition', () => {
    const history: MigrationDefinition[] = [
      {
        name: 'create_users',
        dependencies: [],
        operations: [{ kind: 'create_table', table: table('users', pk(), str('email', 255)) }],
      },
    ];
    const squashed = squashMigrations(history, { name: 'squashed_init' });
    assert.ok(squashed);
    assert.equal(squashed.name, 'squashed_init');
    assert.deepEqual(squashed.dependencies, []);
    assert.equal(squashed.operations.length, 1);
    assert.equal(squashed.operations[0]?.kind, 'create_table');

    const originalSchema = replayMigrationHistory(history);
    const squashedSchema = replayMigrationHistory([squashed]);
    assert.ok(schemasEqual(originalSchema, squashedSchema));
  });

  it('squashes multiple schema migrations into one', () => {
    const history: MigrationDefinition[] = [
      {
        name: 'create_users',
        dependencies: [],
        operations: [{ kind: 'create_table', table: table('users', pk(), str('email', 255)) }],
      },
      {
        name: 'add_age',
        dependencies: ['create_users'],
        operations: [{ kind: 'add_column', table: 'users', column: int('age') }],
      },
      {
        name: 'create_posts',
        dependencies: ['add_age'],
        operations: [{ kind: 'create_table', table: table('posts', pk(), str('title', 200)) }],
      },
    ];

    const squashed = squashMigrations(history, { name: 'squashed_all' });
    assert.ok(squashed);
    assert.deepEqual(squashed.dependencies, []);
    assert.equal(squashed.operations.length, 3);

    const originalSchema = replayMigrationHistory(history);
    const squashedSchema = replayMigrationHistory([squashed]);
    assert.ok(schemasEqual(originalSchema, squashedSchema));
  });

  it('produces deterministic output for the same input', () => {
    const history: MigrationDefinition[] = [
      {
        name: 'create_users',
        dependencies: [],
        operations: [{ kind: 'create_table', table: table('users', pk(), str('email', 255)) }],
      },
      {
        name: 'add_age',
        dependencies: ['create_users'],
        operations: [{ kind: 'add_column', table: 'users', column: int('age') }],
      },
    ];

    const a = squashMigrations(history, { name: 'sq' });
    const b = squashMigrations(history, { name: 'sq' });
    assert.ok(a && b);
    assert.deepEqual(a.operations, b.operations);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it('rejects name with invalid identifier', () => {
    const history: MigrationDefinition[] = [
      {
        name: 'create_users',
        dependencies: [],
        operations: [{ kind: 'create_table', table: table('users', pk()) }],
      },
    ];
    assert.throws(() => squashMigrations(history, { name: 'bad name' }), MigrationError);
  });

  it('rejects squashing across a data migration without allowCrossKind', () => {
    const history: MigrationDefinition[] = [
      {
        name: 'create_users',
        dependencies: [],
        operations: [{ kind: 'create_table', table: table('users', pk()) }],
        kind: 'schema',
      },
      {
        name: 'backfill',
        dependencies: ['create_users'],
        operations: [],
        kind: 'data',
      },
    ];

    assert.throws(
      () => squashMigrations(history, { name: 'squashed' }),
      /cannot squash across data migration/,
    );
  });

  it('allows cross-kind squashing with allowCrossKind', () => {
    const history: MigrationDefinition[] = [
      {
        name: 'create_users',
        dependencies: [],
        operations: [{ kind: 'create_table', table: table('users', pk()) }],
        kind: 'schema',
      },
      {
        name: 'backfill',
        dependencies: ['create_users'],
        operations: [],
        kind: 'data',
      },
    ];

    const squashed = squashMigrations(history, { name: 'squashed', allowCrossKind: true });
    assert.ok(squashed);
    assert.equal(squashed.operations.length, 1);
    assert.equal(squashed.operations[0]?.kind, 'create_table');
  });

  it('returns null for history with only empty data migrations', () => {
    const history: MigrationDefinition[] = [
      {
        name: 'backfill',
        dependencies: [],
        operations: [],
        kind: 'data',
      },
    ];

    const squashed = squashMigrations(history, { name: 'squashed', allowCrossKind: true });
    assert.equal(squashed, null);
  });

  it('preserves and concatenates operations from all squashed migrations', () => {
    const history: MigrationDefinition[] = [
      {
        name: 'create_users',
        dependencies: [],
        operations: [{ kind: 'create_table', table: table('users', pk()) }],
      },
      {
        name: 'create_posts',
        dependencies: ['create_users'],
        operations: [{ kind: 'create_table', table: table('posts', pk(), int('user_id')) }],
      },
    ];

    const squashed = squashMigrations(history, { name: 'squashed_both' });
    assert.ok(squashed);
    assert.equal(squashed.operations.length, 2);
    assert.deepEqual(
      squashed.operations.map((op) => op.kind),
      ['create_table', 'create_table'],
    );
  });
});
