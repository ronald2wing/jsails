import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { CommandDiscoveryError, discoverAppCommands } from '../../src/cli/discovery.js';

/**
 * Tests for compiled command discovery. Unit tests drive `discoverAppCommands`
 * directly against self-contained fixture modules under `dist/`; subprocess
 * tests spawn the compiled CLI to exercise the full `commands/` and
 * `dist/commands` conventions, help rendering, duplicate rejection, and
 * value-free error reporting.
 *
 * Fixtures live under `dist/` so the repo's `"type": "module"` makes plain
 * `.js` files ESM and bare package imports resolve; command fixtures import the
 * package itself through its built file URL.
 */

const cliPath = fileURLToPath(new URL('../../src/cli.js', import.meta.url));
const indexUrl = pathToFileURL(fileURLToPath(new URL('../../src/index.js', import.meta.url))).href;

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'cli-discovery-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a compiled command module at `dir/commands/<filename>`, creating parents. */
function writeCommandModule(dir: string, filename: string, body: string): void {
  const filePath = join(dir, 'commands', filename);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, body);
}

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

describe('discoverAppCommands', () => {
  it('returns compiled commands in lexical order', async () => {
    const dir = makeDir('lexical');
    writeCommandModule(
      dir,
      'b.js',
      `export default { name: 'beta', summary: 'b', run() { return 0; } };`,
    );
    writeCommandModule(
      dir,
      'a.js',
      `export default { name: 'alpha', summary: 'a', run() { return 0; } };`,
    );

    const commands = await discoverAppCommands(dir);

    assert.deepEqual(
      commands.map((command) => command.name),
      ['alpha', 'beta'],
    );
  });

  it('accepts .mjs modules and recurses into subdirectories', async () => {
    const dir = makeDir('nested');
    writeCommandModule(
      dir,
      'nested/two.mjs',
      `export default { name: 'two', summary: '2', run() { return 0; } };`,
    );
    writeCommandModule(
      dir,
      'one.js',
      `export default { name: 'one', summary: '1', run() { return 0; } };`,
    );

    const commands = await discoverAppCommands(dir);

    // The walk is depth-first in sorted dirent order, so the `nested` directory
    // (which sorts before `one.js`) yields `two` before the top-level `one`.
    assert.deepEqual(
      commands.map((command) => command.name),
      ['two', 'one'],
    );
  });

  it('skips .ts sources, non-module files, and symlinks', async () => {
    const dir = makeDir('skip');
    const commandsDir = join(dir, 'commands');
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(
      join(commandsDir, 'real.js'),
      `export default { name: 'real', summary: 'r', run() { return 0; } };`,
    );
    writeFileSync(join(commandsDir, 'source.ts'), `not a compiled module`);
    writeFileSync(join(commandsDir, 'notes.txt'), `not a command`);
    symlinkSync(join(commandsDir, 'real.js'), join(commandsDir, 'linked.js'));

    const commands = await discoverAppCommands(dir);

    assert.deepEqual(
      commands.map((command) => command.name),
      ['real'],
    );
  });

  it('returns an empty list when no commands directory exists', async () => {
    const dir = makeDir('empty');
    assert.deepEqual(await discoverAppCommands(dir), []);
  });

  it('rejects a module without a default export', async () => {
    const dir = makeDir('no-default');
    writeCommandModule(dir, 'x.js', `export const named = 1;`);

    await assert.rejects(discoverAppCommands(dir), /must default-export a CliCommand/);
  });

  it('rejects a command missing its run function', async () => {
    const dir = makeDir('no-run');
    writeCommandModule(dir, 'x.js', `export default { name: 'x', summary: 'x' };`);

    await assert.rejects(discoverAppCommands(dir), /must declare a "run" function/);
  });

  it('rejects a command with an empty summary', async () => {
    const dir = makeDir('empty-summary');
    writeCommandModule(
      dir,
      'x.js',
      `export default { name: 'x', summary: '   ', run() { return 0; } };`,
    );

    await assert.rejects(discoverAppCommands(dir), /must declare a non-empty "summary"/);
  });

  it('rejects a command with an invalid name', async () => {
    const dir = makeDir('bad-name');
    writeCommandModule(
      dir,
      'x.js',
      `export default { name: 'bad name', summary: 'x', run() { return 0; } };`,
    );

    await assert.rejects(discoverAppCommands(dir), /has an invalid "name"/);
  });

  it('defaults discovered commands to the user audience', async () => {
    const dir = makeDir('audience-default');
    writeCommandModule(
      dir,
      'x.js',
      `export default { name: 'x', summary: 'x', run() { return 0; } };`,
    );

    const commands = await discoverAppCommands(dir);

    assert.equal(commands[0]?.audience, 'user');
  });

  it('lets an explicit audience override the discovery default', async () => {
    const dir = makeDir('audience-explicit');
    writeCommandModule(
      dir,
      'x.js',
      `export default { name: 'x', summary: 'x', audience: 'developer', run() { return 0; } };`,
    );

    const commands = await discoverAppCommands(dir);

    assert.equal(commands[0]?.audience, 'developer');
  });

  it('applies a caller defaultAudience to discovered commands', async () => {
    const dir = makeDir('audience-option');
    writeCommandModule(
      dir,
      'x.js',
      `export default { name: 'x', summary: 'x', run() { return 0; } };`,
    );

    const commands = await discoverAppCommands(dir, { defaultAudience: 'developer' });

    assert.equal(commands[0]?.audience, 'developer');
  });

  it('rejects an invalid audience without echoing the value', async () => {
    const dir = makeDir('audience-invalid');
    writeCommandModule(
      dir,
      'x.js',
      `export default { name: 'x', summary: 'x', audience: 'admin', run() { return 0; } };`,
    );

    await assert.rejects(discoverAppCommands(dir), (error: unknown) => {
      assert.ok(error instanceof CommandDiscoveryError);
      assert.match(error.message, /has an invalid "audience"/);
      assert.doesNotMatch(error.message, /admin/);
      return true;
    });
  });

  it('rejects a module that throws while loading, without leaking its message', async () => {
    const dir = makeDir('throws');
    writeCommandModule(dir, 'boom.js', `throw new Error('super-secret-token-abc');`);

    await assert.rejects(discoverAppCommands(dir), (error: unknown) => {
      assert.ok(error instanceof CommandDiscoveryError);
      assert.match(error.message, /failed to load command module "boom\.js"/);
      assert.doesNotMatch(error.message, /super-secret-token-abc/);
      return true;
    });
  });
});

describe('compiled command discovery via the CLI', () => {
  it('runs a command discovered from ./commands', () => {
    const dir = makeDir('commands-at-root');
    writeCommandModule(
      dir,
      'hello.js',
      `
import { defineCommand } from '${indexUrl}';
export default defineCommand({
  signature: 'hello {name}',
  run(input, ctx) { ctx.stdout('hello ' + input.arguments.name); },
});
`,
    );

    const result = runCli(['hello', 'Bob'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'hello Bob\n');
  });

  it('runs a command discovered from ./dist/commands', () => {
    const dir = makeDir('commands-in-dist');
    const commandsDir = join(dir, 'dist', 'commands');
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(
      join(commandsDir, 'hello.js'),
      `
import { defineCommand } from '${indexUrl}';
export default defineCommand({
  signature: 'hello {name}',
  run(input, ctx) { ctx.stdout('hello ' + input.arguments.name); },
});
`,
    );

    const result = runCli(['hello', 'Bob'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'hello Bob\n');
  });

  it('rejects a name claimed by both the config and a discovered module', () => {
    const dir = makeDir('duplicate');
    writeFileSync(
      join(dir, 'jsails.app.js'),
      `export default {
  commands: [{ name: 'hello', summary: 'config hello', run(rawArgs, ctx) { ctx.stdout('config'); } }],
};
`,
    );
    writeCommandModule(
      dir,
      'hello.js',
      `
import { defineCommand } from '${indexUrl}';
export default defineCommand({ signature: 'hello {name}', run() { return 0; } });
`,
    );

    const result = runCli(['hello', '--config', 'jsails.app.js', 'Bob'], dir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /duplicate command name "hello"/);
  });

  it('prints help from the signature-derived usage without running the handler', () => {
    const dir = makeDir('help');
    writeCommandModule(
      dir,
      'hello.js',
      `
import { defineCommand } from '${indexUrl}';
export default defineCommand({
  signature: 'hello {name} {--loud}',
  summary: 'greet someone',
  run() { throw new Error('handler-ran'); },
});
`,
    );

    const result = runCli(['hello', '--help'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /hello - greet someone/);
    assert.match(result.stdout, /jsails hello name \[--loud\]/);
    assert.doesNotMatch(result.stderr, /handler-ran/);
  });

  it('reports an unknown command without importing anything', () => {
    const dir = makeDir('unknown');
    writeCommandModule(
      dir,
      'hello.js',
      `
import { defineCommand } from '${indexUrl}';
export default defineCommand({ signature: 'hello {name}', run() { return 0; } });
`,
    );

    const result = runCli(['bogus', 'Bob'], dir);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown command "bogus"/);
  });

  it('redacts a secret thrown by a discovered module while loading', () => {
    const dir = makeDir('redact');
    writeCommandModule(dir, 'leak.js', `throw new Error('super-secret-token-abc');`);

    const result = runCli(['leak'], dir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to load command module/);
    assert.doesNotMatch(result.stderr, /super-secret-token-abc/);
  });
});
