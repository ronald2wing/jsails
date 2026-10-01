import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

/**
 * End-to-end CLI tests that spawn the compiled CLI as a real process. No live
 * database is ever contacted: makemigrations builds the schema offline, and
 * migrate/showmigrations run against fixture config modules whose exported
 * JsailsDataSource is a real instance with only its connection lifecycle and
 * query runner overridden by an in-memory recorder.
 */

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const indexUrl = pathToFileURL(fileURLToPath(new URL('../src/index.js', import.meta.url))).href;

// Fixtures live under dist/ so bare `typeorm` imports resolve to the repo's
// node_modules; the jsails package itself is imported via its built file URL.
const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'cli-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Build the content of a JS ESM config module for the given entity columns. */
function configContent(columns: string): string {
  return `
import { EntitySchema } from 'typeorm';
import { JsailsDataSource, BaseEntity } from '${indexUrl}';

// BaseEntity is available for Active Record models; this fixture defines its
// schema via EntitySchema so it runs in plain JS without compilation.
void BaseEntity;

const User = new EntitySchema({
  name: 'User',
  tableName: 'users',
  columns: ${columns},
});

export default new JsailsDataSource({
  type: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  username: 'placeholder',
  password: 'placeholder',
  database: 'placeholder',
  entities: [User],
});
`;
}

const USER_COLUMNS = `{
  id: { type: 'int', primary: true, generated: true },
  email: { type: 'varchar', length: 255, nullable: false },
}`;

/** Create a fixture directory with a config module and return its path. */
function makeFixture(name: string, columns = USER_COLUMNS): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'jsails.config.js'), configContent(columns));
  return dir;
}

function emptyDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface FakeTrackingState {
  tableExists: boolean;
  rows: Array<{ name: string; checksum: string; status: string }>;
}

/**
 * Create a fixture whose config default-exports a real JsailsDataSource with
 * `initialize`/`destroy`/`createQueryRunner` overridden by an in-memory
 * recorder for the given tracking state. `initialize` and `destroy` drop marker
 * files so tests can prove the database was consulted and always cleaned up.
 */
function makeFakeDbFixture(name: string, state: FakeTrackingState): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'jsails.config.js'),
    `
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EntitySchema } from 'typeorm';
import { JsailsDataSource } from '${indexUrl}';

const here = dirname(fileURLToPath(import.meta.url));
const state = ${JSON.stringify(state)};

const User = new EntitySchema({
  name: 'User',
  tableName: 'users',
  columns: { id: { type: 'int', primary: true, generated: true } },
});

const ds = new JsailsDataSource({
  type: 'postgres', host: '127.0.0.1', port: 5432,
  username: 'fake', password: 'fake', database: 'fake',
  entities: [User],
});

const runner = {
  async connect() {},
  async release() {},
  async hasTable() { return state.tableExists; },
  async query(sql) {
    if (sql.startsWith('SELECT name, checksum, status')) {
      return { records: state.rows.map((row) => ({ ...row })) };
    }
    throw new Error('unexpected query: ' + sql);
  },
};

ds.initialize = async () => {
  ds.isInitialized = true;
  writeFileSync(join(here, 'initialized.marker'), 'initialized');
};
ds.destroy = async () => {
  writeFileSync(join(here, 'destroyed.marker'), 'destroyed');
};
ds.createQueryRunner = () => runner;

export default ds;
`,
  );
  return dir;
}

describe('cli: help and argument handling', () => {
  it('prints help on --help without importing the config', () => {
    const dir = emptyDir('help');
    const result = runCli(['--help'], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /makemigrations/);
    assert.match(result.stdout, /migrate/);
    assert.match(result.stdout, /showmigrations/);
    assert.match(result.stdout, /--allow-destructive/);
    assert.match(result.stdout, /create <dir>/);
    assert.match(result.stdout, /^ {2}dev\s/m);
  });

  it('rejects an unknown command', () => {
    const result = runCli(['bogus'], fixturesRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown command/);
  });

  it('rejects an unknown flag', () => {
    const result = runCli(['migrate', '--bogus'], fixturesRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown option/);
  });

  it('rejects a missing command', () => {
    const result = runCli([], fixturesRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /command is required/);
  });

  it('requires --name for makemigrations', () => {
    const result = runCli(['makemigrations'], fixturesRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--name/);
  });

  it('rejects --name on migrate', () => {
    const result = runCli(['migrate', '--name', 'foo'], fixturesRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /only valid for makemigrations/);
  });

  it('rejects --allow-destructive on migrate', () => {
    const result = runCli(['migrate', '--allow-destructive'], fixturesRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /only valid for makemigrations/);
  });
});

describe('cli: config loading', () => {
  it('fails with a clear error when the config is missing', () => {
    const dir = emptyDir('missing-config');
    const result = runCli(['migrate', '--config', 'nope.js'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to load config/);
    assert.doesNotMatch(result.stderr, /password/);
  });

  it('rejects a TypeScript config path with a compile hint', () => {
    const dir = emptyDir('ts-config');
    const result = runCli(['migrate', '--config', 'jsails.config.ts'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /compile it to JavaScript first/);
  });

  it('never prints data source credentials', () => {
    const dir = emptyDir('no-creds');
    writeFileSync(
      join(dir, 'jsails.config.js'),
      `
import { JsailsDataSource } from '${indexUrl}';
const ds = new JsailsDataSource({
  type: 'postgres', host: 'h', port: 5432,
  username: 'secret-user', password: 'super-secret-123', database: 'd',
  entities: [],
});
throw new Error('deliberate config failure');
export default ds;
`,
    );
    const result = runCli(['migrate'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /deliberate config failure/);
    assert.doesNotMatch(result.stderr, /super-secret-123/);
    assert.doesNotMatch(result.stderr, /secret-user/);
  });
});

describe('cli: makemigrations (offline)', () => {
  it('generates an initial migration JSON without a database', () => {
    const dir = makeFixture('initial');
    const result = runCli(['makemigrations', '--name', 'create_users'], dir);
    assert.equal(result.status, 0, result.stderr);

    const parsed = JSON.parse(readFileSync(join(dir, 'migrations', 'create_users.json'), 'utf8'));
    assert.equal(parsed.name, 'create_users');
    assert.deepEqual(parsed.dependencies, []);
    assert.equal(parsed.operations.length, 1);
    assert.equal(parsed.operations[0].kind, 'create_table');
    assert.equal(parsed.operations[0].table.name, 'users');
  });

  it('is a no-op when the model matches the on-disk history', () => {
    const dir = makeFixture('noop');
    assert.equal(runCli(['makemigrations', '--name', 'create_users'], dir).status, 0);

    const result = runCli(['makemigrations', '--name', 'noop'], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No changes detected/);

    assert.throws(
      () => readFileSync(join(dir, 'migrations', 'noop.json'), 'utf8'),
      /ENOENT/,
      'no-op must not write a file',
    );
  });

  it('generates an add_column migration after a model change', () => {
    const dir = makeFixture('model-change');
    assert.equal(runCli(['makemigrations', '--name', 'create_users'], dir).status, 0);

    writeFileSync(
      join(dir, 'jsails.config.js'),
      configContent(`{
  id: { type: 'int', primary: true, generated: true },
  email: { type: 'varchar', length: 255, nullable: false },
  bio: { type: 'text', nullable: true },
}`),
    );

    const result = runCli(['makemigrations', '--name', 'add_bio'], dir);
    assert.equal(result.status, 0, result.stderr);

    const parsed = JSON.parse(readFileSync(join(dir, 'migrations', 'add_bio.json'), 'utf8'));
    assert.deepEqual(parsed.dependencies, ['create_users']);
    assert.equal(parsed.operations[0].kind, 'add_column');
    assert.equal(parsed.operations[0].column.name, 'bio');
  });

  it('refuses to overwrite an existing migration (immutable history)', () => {
    const dir = makeFixture('immutable');
    assert.equal(runCli(['makemigrations', '--name', 'create_users'], dir).status, 0);

    writeFileSync(
      join(dir, 'jsails.config.js'),
      configContent(`{
  id: { type: 'int', primary: true, generated: true },
  email: { type: 'varchar', length: 255, nullable: false },
  bio: { type: 'text', nullable: true },
}`),
    );

    const filePath = join(dir, 'migrations', 'create_users.json');
    const before = readFileSync(filePath, 'utf8');
    const result = runCli(['makemigrations', '--name', 'create_users'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing to overwrite/);
    assert.equal(readFileSync(filePath, 'utf8'), before, 'existing file must be unchanged');
  });
});

describe('cli: corrupt history rejection', () => {
  it('rejects a migration file that is not valid JSON', () => {
    const dir = makeFixture('corrupt-json');
    mkdirSync(join(dir, 'migrations'), { recursive: true });
    writeFileSync(join(dir, 'migrations', 'broken.json'), '{ not json');

    const result = runCli(['makemigrations', '--name', 'x'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not valid JSON/);
  });

  it('rejects a structurally invalid migration via history validation', () => {
    const dir = makeFixture('corrupt-struct');
    mkdirSync(join(dir, 'migrations'), { recursive: true });
    writeFileSync(
      join(dir, 'migrations', 'bad.json'),
      JSON.stringify({ name: 'bad name', dependencies: [], operations: [] }),
    );

    const result = runCli(['makemigrations', '--name', 'x'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid identifier/);
  });

  it('rejects corrupt history for migrate before connecting', () => {
    const dir = makeFixture('corrupt-migrate');
    mkdirSync(join(dir, 'migrations'), { recursive: true });
    writeFileSync(
      join(dir, 'migrations', 'bad.json'),
      JSON.stringify({ name: 'bad name', dependencies: [], operations: [] }),
    );

    const result = runCli(['migrate'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid identifier/);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED|connect/i);
  });
});

describe('cli: database commands verify tracking on empty local history', () => {
  const orphanState: FakeTrackingState = {
    tableExists: true,
    rows: [{ name: 'ghost', checksum: '0'.repeat(64), status: 'applied' }],
  };

  it('migrate rejects orphaned applied rows instead of reporting success', () => {
    const dir = makeFakeDbFixture('migrate-orphan', orphanState);
    const result = runCli(['migrate'], dir);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /unknown migration/);
    assert.ok(existsSync(join(dir, 'initialized.marker')), 'database was consulted');
    assert.ok(existsSync(join(dir, 'destroyed.marker')), 'connection is cleaned up');
  });

  it('migrate succeeds against an empty database after verifying tracking', () => {
    const dir = makeFakeDbFixture('migrate-clean', { tableExists: false, rows: [] });
    const result = runCli(['migrate'], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No migrations found/);
    assert.ok(existsSync(join(dir, 'initialized.marker')), 'database was consulted');
    assert.ok(existsSync(join(dir, 'destroyed.marker')), 'connection is cleaned up');
  });

  it('showmigrations rejects orphaned applied rows', () => {
    const dir = makeFakeDbFixture('show-orphan', orphanState);
    const result = runCli(['showmigrations'], dir);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /unknown migration/);
    assert.ok(existsSync(join(dir, 'initialized.marker')), 'database was consulted');
    assert.ok(existsSync(join(dir, 'destroyed.marker')), 'connection is cleaned up');
  });

  it('showmigrations succeeds against an empty database after verifying tracking', () => {
    const dir = makeFakeDbFixture('show-clean', { tableExists: false, rows: [] });
    const result = runCli(['showmigrations'], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No migrations found/);
    assert.ok(existsSync(join(dir, 'initialized.marker')), 'database was consulted');
    assert.ok(existsSync(join(dir, 'destroyed.marker')), 'connection is cleaned up');
  });
});

/** Write a compiled command module under `dir/commands/<filename>` (creates parents). */
function writeCommandModule(dir: string, filename: string, body: string): void {
  const filePath = join(dir, 'commands', filename);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, body);
}

describe('cli: audience-aware dispatch and help', () => {
  it('global --help lists both sections with a discovered user command and imports no config', () => {
    const dir = emptyDir('audience-global-help');
    // A config that would write a marker if imported: proves --help never loads it.
    writeFileSync(
      join(dir, 'jsails.app.js'),
      `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./imported.marker', import.meta.url), 'x');
export default { commands: [] };
`,
    );
    writeCommandModule(
      dir,
      'login.js',
      `import { defineCommand } from '${indexUrl}';
export default defineCommand({
  signature: 'login {--no-open}',
  summary: 'Sign in from the CLI via a browser approval page',
  audience: 'user',
  run() { return 0; },
});
`,
    );

    const result = runCli(['--help'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Developer commands:/);
    assert.match(result.stdout, /User commands:/);
    assert.match(result.stdout, /login - Sign in from the CLI via a browser approval page/);
    assert.equal(existsSync(join(dir, 'imported.marker')), false, 'config was not imported');
  });

  it('labels a discovered command as a user command in `jsails <cmd> --help`', () => {
    const dir = emptyDir('audience-user-help');
    writeCommandModule(
      dir,
      'login.js',
      `import { defineCommand } from '${indexUrl}';
export default defineCommand({
  signature: 'login {--no-open}',
  summary: 'Sign in from the CLI via a browser approval page',
  audience: 'user',
  run() { return 0; },
});
`,
    );

    const result = runCli(['login', '--help'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /login - Sign in from the CLI via a browser approval page/);
    assert.match(result.stdout, /Audience: user command/);
    assert.match(result.stdout, /jsails login \[--no-open\]/);
  });

  it('labels a config-declared command as a developer command in `jsails <cmd> --help`', () => {
    const dir = emptyDir('audience-developer-help');
    writeFileSync(
      join(dir, 'jsails.app.js'),
      `export default { commands: [{ name: 'deploy', summary: 'deploy it', run() { return 0; } }] };
`,
    );

    const result = runCli(['deploy', '--help'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Audience: developer command/);
    assert.match(result.stdout, /deploy - deploy it/);
  });

  it('runs a discovered user command without loading a present app config', () => {
    const dir = emptyDir('audience-user-skips-config');
    writeFileSync(
      join(dir, 'jsails.app.js'),
      `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./imported.marker', import.meta.url), 'x');
export default { commands: [{ name: 'deploy', summary: 'deploy', run() { return 0; } }] };
`,
    );
    writeCommandModule(
      dir,
      'login.js',
      `export default { name: 'login', summary: 'Sign in', audience: 'user', run(rawArgs, ctx) { ctx.stdout('logged in'); } };
`,
    );

    const result = runCli(['login'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'logged in\n');
    assert.equal(
      existsSync(join(dir, 'imported.marker')),
      false,
      'user command must not import the config',
    );
  });

  it('loads the app config for a config-declared developer command', () => {
    const dir = emptyDir('audience-developer-loads-config');
    writeFileSync(
      join(dir, 'jsails.app.js'),
      `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./imported.marker', import.meta.url), 'x');
export default { commands: [{ name: 'deploy', summary: 'deploy', run(rawArgs, ctx) { ctx.stdout('deployed'); } }] };
`,
    );

    const result = runCli(['deploy'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'deployed\n');
    assert.equal(
      existsSync(join(dir, 'imported.marker')),
      true,
      'developer command loads the config',
    );
  });
});
