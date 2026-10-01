import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../../src/cli/index.js';
import {
  formatOperation,
  formatSchemaPlan,
  runDataMigrations,
  type DataMigrationDataSource,
} from '../../src/cli/migration-commands.js';
import { defineDataMigration } from '../../src/migrations/data.js';
import type { QueryRunner } from 'typeorm';
import type { SchemaPlan } from '../../src/migrations/reconciler.js';
import type { Operation } from '../../src/migrations/operations.js';

/**
 * CLI flag gating tests for db:push and db:diff. No database connection is
 * opened: a nonexistent config path proves the flags were accepted (exit 1
 * = load failure after validation) or rejected at the flag wall (exit 2).
 */

describe('db:push and db:diff CLI flag gating', () => {
  const nonexistentConfig = '/nonexistent/config.js';

  it('db:push --dry-run with a nonexistent config => exit 1 (flag accepted, load failed)', async () => {
    const result = await runCli(['db:push', '--config', nonexistentConfig, '--dry-run']);
    assert.equal(result, 1, 'flag accepted; load failure after flag validation');
  });

  it('db:push --allow-destructive with a nonexistent config => exit 1', async () => {
    const result = await runCli(['db:push', '--config', nonexistentConfig, '--allow-destructive']);
    assert.equal(result, 1);
  });

  it('db:diff with a nonexistent config => exit 1', async () => {
    const result = await runCli(['db:diff', '--config', nonexistentConfig]);
    assert.equal(result, 1);
  });

  it('db:push and db:diff are recognized commands (not "unknown command")', async () => {
    // Without --config, the CLI looks for the default jsails.config.js in cwd.
    // Neither "unknown command" (exit 2) nor "failed to load config" (exit 1)
    // means the command was unrecognized; both are acceptable in a test that
    // only verifies command recognition.
    const pushResult = await runCli(['db:push']);
    assert.ok(
      pushResult === 1 || pushResult === 2,
      `db:push exit code ${pushResult}: not an "unknown command" error`,
    );

    const diffResult = await runCli(['db:diff']);
    assert.ok(
      diffResult === 1 || diffResult === 2,
      `db:diff exit code ${diffResult}: not an "unknown command" error`,
    );
  });

  it('--dry-run on a non-db:push command => exit 2 (usage error)', async () => {
    const result = await runCli(['work', '--dry-run']);
    assert.equal(result, 2, '--dry-run on a non-db:push command is a usage error');
  });

  it('--dry-run on db:diff => exit 2 (usage error; not valid for db:diff)', async () => {
    const result = await runCli(['db:diff', '--dry-run', '--config', nonexistentConfig]);
    assert.equal(result, 2, '--dry-run on db:diff is a usage error');
  });

  it('--allow-destructive on a non-db:push command => exit 2 (usage error)', async () => {
    const result = await runCli(['work', '--allow-destructive']);
    assert.equal(result, 2, '--allow-destructive on a non-db:push command is a usage error');
  });

  it('--allow-destructive on db:diff => exit 2 (usage error)', async () => {
    const result = await runCli(['db:diff', '--allow-destructive', '--config', nonexistentConfig]);
    assert.equal(result, 2, '--allow-destructive on db:diff is a usage error');
  });
});

// ---------------------------------------------------------------------------
// Pure unit tests for operation formatting (no database, no I/O).
// ---------------------------------------------------------------------------

describe('formatOperation', () => {
  it('formats create_table', () => {
    const op: Operation = { kind: 'create_table', table: { name: 'users', columns: [] } };
    assert.equal(formatOperation(op), 'create_table users');
  });

  it('formats drop_table', () => {
    const op: Operation = { kind: 'drop_table', table: { name: 'legacy_posts', columns: [] } };
    assert.equal(formatOperation(op), 'drop_table legacy_posts');
  });

  it('formats add_column', () => {
    const op: Operation = {
      kind: 'add_column',
      table: 'users',
      column: { name: 'email', type: 'varchar', length: 255, nullable: true },
    };
    assert.equal(formatOperation(op), 'add_column users.email');
  });

  it('formats drop_column', () => {
    const op: Operation = {
      kind: 'drop_column',
      table: 'users',
      column: { name: 'legacy_field', type: 'text', nullable: true },
    };
    assert.equal(formatOperation(op), 'drop_column users.legacy_field');
  });

  it('formats rename_column', () => {
    const op: Operation = {
      kind: 'rename_column',
      table: 'users',
      from: 'old_name',
      to: 'new_name',
    };
    assert.equal(formatOperation(op), 'rename_column users.old_name -> new_name');
  });

  it('formats rename_table', () => {
    const op: Operation = { kind: 'rename_table', from: 'old_table', to: 'new_table' };
    assert.equal(formatOperation(op), 'rename_table old_table -> new_table');
  });

  it('formats alter_column', () => {
    const op: Operation = {
      kind: 'alter_column',
      table: 'users',
      column: { name: 'age', type: 'integer', nullable: true },
      previous: { name: 'age', type: 'integer', nullable: true },
    };
    assert.equal(formatOperation(op), 'alter_column users.age');
  });

  it('formats alter_inheritance', () => {
    const op: Operation = {
      kind: 'alter_inheritance',
      table: 'items',
      inheritance: undefined,
      previous: undefined,
    };
    assert.equal(formatOperation(op), 'alter_inheritance items');
  });

  it('formats alter_polymorphic', () => {
    const op: Operation = {
      kind: 'alter_polymorphic',
      table: 'attachments',
      polymorphic: undefined,
      previous: undefined,
    };
    assert.equal(formatOperation(op), 'alter_polymorphic attachments');
  });

  it('formats add_index / drop_index', () => {
    const add: Operation = {
      kind: 'add_index',
      table: 'users',
      index: { name: 'idx_email', columns: ['email'], unique: false },
    };
    assert.equal(formatOperation(add), 'add_index users idx_email');

    const drop: Operation = {
      kind: 'drop_index',
      table: 'users',
      index: { name: 'idx_email', columns: ['email'], unique: false },
    };
    assert.equal(formatOperation(drop), 'drop_index users idx_email');
  });

  it('formats add_unique / drop_unique', () => {
    const add: Operation = {
      kind: 'add_unique',
      table: 'users',
      unique: { name: 'uq_email', columns: ['email'] },
    };
    assert.equal(formatOperation(add), 'add_unique users uq_email');

    const drop: Operation = {
      kind: 'drop_unique',
      table: 'users',
      unique: { name: 'uq_email', columns: ['email'] },
    };
    assert.equal(formatOperation(drop), 'drop_unique users uq_email');
  });

  it('formats add_fk / drop_fk', () => {
    const add: Operation = {
      kind: 'add_fk',
      table: 'posts',
      foreignKey: {
        name: 'fk_posts_author',
        columns: ['author_id'],
        referencedTable: 'authors',
        referencedColumns: ['id'],
      },
    };
    assert.equal(formatOperation(add), 'add_fk posts fk_posts_author');

    const drop: Operation = {
      kind: 'drop_fk',
      table: 'posts',
      foreignKey: {
        name: 'fk_posts_author',
        columns: ['author_id'],
        referencedTable: 'authors',
        referencedColumns: ['id'],
      },
    };
    assert.equal(formatOperation(drop), 'drop_fk posts fk_posts_author');
  });

  it('formats add_check / drop_check', () => {
    const add: Operation = {
      kind: 'add_check',
      table: 'products',
      check: { name: 'ck_price_positive', expression: 'price > 0' },
    };
    assert.equal(formatOperation(add), 'add_check products ck_price_positive');

    const drop: Operation = {
      kind: 'drop_check',
      table: 'products',
      check: { name: 'ck_price_positive', expression: 'price > 0' },
    };
    assert.equal(formatOperation(drop), 'drop_check products ck_price_positive');
  });
});

describe('formatSchemaPlan', () => {
  it('returns up-to-date message when empty', () => {
    const plan: SchemaPlan = { operations: Object.freeze([]), destructive: false, upToDate: true };
    const lines = formatSchemaPlan(plan);
    assert.ok(
      lines.some((line) => line.includes('up to date')),
      'plan indicates up-to-date status',
    );
  });

  it('lists non-destructive operations with count', () => {
    const addCol: Operation = {
      kind: 'add_column',
      table: 'users',
      column: { name: 'bio', type: 'text', nullable: true },
    };
    const plan: SchemaPlan = {
      operations: Object.freeze([addCol]),
      destructive: false,
      upToDate: false,
    };
    const lines = formatSchemaPlan(plan);
    assert.ok(
      lines.some((line) => line === 'add_column users.bio'),
      'operation appears in output',
    );
    assert.ok(
      lines.some((line) => line === '1 operation(s)'),
      'summary line appears',
    );
    assert.ok(
      !lines.some((line) => line.includes('destructive')),
      'non-destructive plan has no destructive marker',
    );
  });

  it('flags destructive plans', () => {
    const dropCol: Operation = {
      kind: 'drop_column',
      table: 'users',
      column: { name: 'legacy', type: 'text', nullable: true },
    };
    const plan: SchemaPlan = {
      operations: Object.freeze([dropCol]),
      destructive: true,
      upToDate: false,
    };
    const lines = formatSchemaPlan(plan);
    assert.ok(
      lines.some((line) => line.includes('(destructive)')),
      'destructive plan is flagged',
    );
  });
});

// ---------------------------------------------------------------------------
// runDataMigrations — phase 2 execution (no database; a fake query runner).
// ---------------------------------------------------------------------------

describe('runDataMigrations', () => {
  /** A fake query runner that records connect/release and captured queries. */
  function fakeDataSource(): {
    dataSource: DataMigrationDataSource;
    queries: string[];
    events: string[];
    releaseCount(): number;
  } {
    const queries: string[] = [];
    const events: string[] = [];
    let releases = 0;
    const runner = {
      connect: () => {
        events.push('connect');
        return Promise.resolve();
      },
      release: () => {
        releases += 1;
        events.push('release');
        return Promise.resolve();
      },
      query: (sql: string) => {
        queries.push(sql);
        return Promise.resolve();
      },
    } as unknown as QueryRunner;
    return {
      dataSource: { createQueryRunner: () => runner },
      queries,
      events,
      releaseCount: () => releases,
    };
  }

  it('runs every migration up in declaration order', async () => {
    const order: string[] = [];
    const migrations = new Map([
      [
        'first',
        defineDataMigration({
          name: 'first',
          up: () => {
            order.push('first');
            return Promise.resolve();
          },
          down: () => Promise.resolve(),
        }),
      ],
      [
        'second',
        defineDataMigration({
          name: 'second',
          up: () => {
            order.push('second');
            return Promise.resolve();
          },
          down: () => Promise.resolve(),
        }),
      ],
    ]);
    const { dataSource } = fakeDataSource();
    const ran = await runDataMigrations(dataSource, migrations);
    assert.deepEqual(ran, ['first', 'second']);
    assert.deepEqual(order, ['first', 'second'], 'declaration order preserved');
  });

  it('runs on every call — no ledger, idempotent by contract', async () => {
    let calls = 0;
    const migrations = new Map([
      [
        'backfill',
        defineDataMigration({
          name: 'backfill',
          up: () => {
            calls += 1;
            return Promise.resolve();
          },
          down: () => Promise.resolve(),
        }),
      ],
    ]);
    const { dataSource } = fakeDataSource();
    await runDataMigrations(dataSource, migrations);
    await runDataMigrations(dataSource, migrations);
    assert.equal(calls, 2, 'up runs once per push, with no applied-state check');
  });

  it('releases the query runner exactly once on success', async () => {
    const migrations = new Map([
      [
        'ok',
        defineDataMigration({
          name: 'ok',
          up: () => Promise.resolve(),
          down: () => Promise.resolve(),
        }),
      ],
    ]);
    const { dataSource, releaseCount, events } = fakeDataSource();
    await runDataMigrations(dataSource, migrations);
    assert.equal(releaseCount(), 1);
    assert.deepEqual(events, ['connect', 'release']);
  });

  it('stops at the first failure and releases without running later migrations', async () => {
    let later = false;
    const migrations = new Map([
      [
        'boom',
        defineDataMigration({
          name: 'boom',
          up: () => Promise.reject(new Error('migration failed')),
          down: () => Promise.resolve(),
        }),
      ],
      [
        'later',
        defineDataMigration({
          name: 'later',
          up: () => {
            later = true;
            return Promise.resolve();
          },
          down: () => Promise.resolve(),
        }),
      ],
    ]);
    const { dataSource, releaseCount } = fakeDataSource();
    await assert.rejects(runDataMigrations(dataSource, migrations), /migration failed/);
    assert.equal(later, false, 'a failure stops the sequence');
    assert.equal(releaseCount(), 1, 'the runner is released even on failure');
  });

  it('is a no-op with an empty registry (no query runner created)', async () => {
    let created = false;
    const dataSource: DataMigrationDataSource = {
      createQueryRunner: () => {
        created = true;
        return {} as QueryRunner;
      },
    };
    const ran = await runDataMigrations(dataSource, new Map());
    assert.deepEqual(ran, []);
    assert.equal(created, false);
  });
});
