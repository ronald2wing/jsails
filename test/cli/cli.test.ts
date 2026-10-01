import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

/**
 * End-to-end CLI tests that spawn the compiled CLI as a real process. No live
 * database is ever contacted: `db:push`/`db:diff` reconcile the declared model
 * schema against the live schema, so these cases exercise only argument
 * handling and config loading, which fail before any connection is opened.
 * Audience-aware dispatch, which never loads an app config for a discovered
 * user command, runs entirely offline.
 */

const cliPath = fileURLToPath(new URL('../../src/cli/index.js', import.meta.url));
const indexUrl = pathToFileURL(fileURLToPath(new URL('../../src/index.js', import.meta.url))).href;

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

function emptyDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a compiled command module under `dir/commands/<filename>` (creates parents). */
function writeCommandModule(dir: string, filename: string, body: string): void {
  const filePath = join(dir, 'commands', filename);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, body);
}

describe('cli: help and argument handling', () => {
  it('prints help on --help without importing the config', () => {
    const dir = emptyDir('help');
    const result = runCli(['--help'], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /db:push/);
    assert.match(result.stdout, /db:diff/);
    assert.match(result.stdout, /--allow-destructive/);
    assert.match(result.stdout, /--dry-run/);
    assert.match(result.stdout, /create <dir>/);
    assert.match(result.stdout, /^ {2}dev\s/m);
  });

  it('rejects an unknown command', () => {
    const result = runCli(['bogus'], fixturesRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown command/);
  });

  it('rejects an unknown flag', () => {
    const result = runCli(['db:push', '--bogus'], fixturesRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown option/);
  });

  it('rejects a missing command', () => {
    const result = runCli([], fixturesRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /command is required/);
  });

  it('rejects --allow-destructive on db:diff', () => {
    const result = runCli(['db:diff', '--allow-destructive'], fixturesRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /only valid for db:push/);
  });

  it('rejects --dry-run on db:diff', () => {
    const result = runCli(['db:diff', '--dry-run'], fixturesRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /only valid for db:push/);
  });

  it('rejects unexpected positional arguments', () => {
    const result = runCli(['db:push', 'extra'], fixturesRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unexpected argument/);
  });
});

describe('cli: config loading', () => {
  it('fails with a clear error when the config is missing', () => {
    const dir = emptyDir('missing-config');
    const result = runCli(['db:push', '--config', 'nope.js'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to load config/);
    assert.doesNotMatch(result.stderr, /password/);
  });

  it('rejects a TypeScript config path with a compile hint', () => {
    const dir = emptyDir('ts-config');
    const result = runCli(['db:push', '--config', 'jsails.config.ts'], dir);
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
    const result = runCli(['db:push'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /deliberate config failure/);
    assert.doesNotMatch(result.stderr, /super-secret-123/);
    assert.doesNotMatch(result.stderr, /secret-user/);
  });
});

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
