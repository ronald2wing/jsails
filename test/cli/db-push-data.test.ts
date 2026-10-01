/**
 * `db:push` phase-2 integration: data migrations run after schema
 * reconciliation, on every push, in declaration order, with no ledger.
 *
 * Uses a real sqljs (WASM SQLite) database through a temporary compiled config
 * module — the same `runDbPush` path a user exercises, minus the network. The
 * config module is written to disk and imported at runtime, exactly as
 * `loadDataSourceConfig`/`loadDataMigrationRegistry` do in production.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { after, describe, it } from 'node:test';

import { runDbPush } from '../../src/cli/migration-commands.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'db-push-data-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

interface SqlDatabase {
  exec(sql: string): { values: unknown[][] }[];
  close(): void;
}

async function readSqliteRow(dbPath: string, sql: string): Promise<unknown[][]> {
  const require = createRequire(import.meta.url);
  const initSqlJs = require('sql.js') as (config?: unknown) => Promise<unknown>;
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = (await initSqlJs({ locateFile: () => wasmPath })) as {
    Database: new (data: Uint8Array) => SqlDatabase;
  };
  const db = new SQL.Database(readFileSync(dbPath));
  try {
    return db.exec(sql)[0]?.values ?? [];
  } finally {
    db.close();
  }
}

/**
 * Write a compiled config module exporting a sqljs `JsailsDataSource` (one
 * `widgets` table) plus a `dataMigrations` map. `migrations` is the raw JS
 * source for the map body. Returns the config and sqljs file paths.
 */
function writeConfig(name: string, migrations: string): { configPath: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpRoot, `${name}-`));
  const dbPath = join(dir, 'data.db');
  const typeormEntry = pathToFileURL(createRequire(import.meta.url).resolve('typeorm')).href;
  const dataSourceModule = fileURLToPath(
    new URL('../../src/database/data-source.js', import.meta.url),
  );
  const dataModule = fileURLToPath(new URL('../../src/migrations/data.js', import.meta.url));
  const content = [
    `import { JsailsDataSource } from ${JSON.stringify(pathToFileURL(dataSourceModule).href)};`,
    `import { EntitySchema } from ${JSON.stringify(typeormEntry)};`,
    `import { defineDataMigration } from ${JSON.stringify(pathToFileURL(dataModule).href)};`,
    `const Widget = new EntitySchema({ name: 'Widget', tableName: 'widgets', columns: { id: { type: Number, primary: true, generated: true }, name: { type: String, length: 100, nullable: false } } });`,
    `const Note = new EntitySchema({ name: 'Note', tableName: 'notes', columns: { id: { type: Number, primary: true, generated: true }, body: { type: String, length: 200, nullable: true }, kind: { type: String, length: 20, nullable: false } } });`,
    `export const dataMigrations = { ${migrations} };`,
    `export default new JsailsDataSource({ type: 'sqljs', location: ${JSON.stringify(dbPath)}, entities: [Widget, Note] });`,
    '',
  ].join('\n');
  const configPath = join(dir, 'jsails.config.js');
  writeFileSync(configPath, content, 'utf8');
  return { configPath, dbPath };
}

describe('db:push phase 2 — data migrations', () => {
  it('applies the schema, then runs data migrations in declaration order', async () => {
    // Two migrations insert into the declared `notes` table in order. The first
    // inserts rowid 1, the second rowid 2, so declaration order is observable.
    const insert = (kind: string): string =>
      `await ctx.queryRunner.query("INSERT INTO notes (kind) VALUES ('${kind}')");`;

    const { configPath, dbPath } = writeConfig(
      'order',
      [
        `first: defineDataMigration({ name: 'first', up: async (ctx) => { ${insert('a')} }, down: async () => {} }),`,
        `second: defineDataMigration({ name: 'second', up: async (ctx) => { ${insert('b')} }, down: async () => {} }),`,
      ].join('\n'),
    );

    const code = await runDbPush(configPath, { dryRun: false, allowDestructive: false });
    assert.equal(code, 0, 'push succeeds');

    const rows = await readSqliteRow(dbPath, 'SELECT kind FROM notes ORDER BY id');
    assert.deepEqual(
      rows.map((row) => row[0]),
      ['a', 'b'],
      'migrations ran in declaration order after schema creation',
    );
  });

  it('runs data migrations on every push (no ledger, idempotent by contract)', async () => {
    // A guarded backfill: inserts a row only when none of that kind exists, so a
    // second push is a no-op even though `up` runs again.
    const { configPath, dbPath } = writeConfig(
      'idempotent',
      `seed: defineDataMigration({ name: 'seed', up: async (ctx) => {
        await ctx.queryRunner.query("INSERT INTO notes (kind) SELECT 'seed' WHERE NOT EXISTS (SELECT 1 FROM notes WHERE kind = 'seed')");
      }, down: async () => {} }),`,
    );

    const first = await runDbPush(configPath, { dryRun: false, allowDestructive: false });
    assert.equal(first, 0, 'first push succeeds');
    const second = await runDbPush(configPath, { dryRun: false, allowDestructive: false });
    assert.equal(second, 0, 'second push succeeds');

    const rows = await readSqliteRow(dbPath, "SELECT COUNT(*) FROM notes WHERE kind = 'seed'");
    assert.equal(rows[0]?.[0], 1, 'idempotent guard keeps a single row across two pushes');
  });

  it('runs data migrations even when the schema is already up to date', async () => {
    // The migration is deliberately non-idempotent so the row count proves it ran
    // on both pushes, including the second where the schema needs no change.
    const { configPath, dbPath } = writeConfig(
      'uptodate',
      `bump: defineDataMigration({ name: 'bump', up: async (ctx) => {
        await ctx.queryRunner.query("INSERT INTO notes (kind) VALUES ('tick')");
      }, down: async () => {} }),`,
    );

    assert.equal(await runDbPush(configPath, { dryRun: false, allowDestructive: false }), 0);
    assert.equal(await runDbPush(configPath, { dryRun: false, allowDestructive: false }), 0);

    const rows = await readSqliteRow(dbPath, "SELECT COUNT(*) FROM notes WHERE kind = 'tick'");
    assert.equal(rows[0]?.[0], 2, 'phase 2 runs regardless of up-to-date schema (no ledger)');
  });

  it('dry-run prints what it would run and applies nothing', async () => {
    // The migration appends to a marker file, so its non-execution is observable
    // even though a dry run never creates (or reads) the database file.
    const marker = join(tmpRoot, `dryrun-marker-${Date.now()}.txt`);
    const { configPath } = writeConfig(
      'dryrun',
      `nope: defineDataMigration({ name: 'nope', up: async () => {
        const { appendFileSync } = await import('node:fs');
        appendFileSync(${JSON.stringify(marker)}, 'ran\\n');
      }, down: async () => {} }),`,
    );

    const code = await runDbPush(configPath, { dryRun: true, allowDestructive: false });
    assert.equal(code, 0, 'dry run succeeds');

    // The marker file was never created: phase 2 did not run under --dry-run.
    assert.throws(() => readFileSync(marker, 'utf8'), /ENOENT/, 'dry run runs no data migration');
  });
});
