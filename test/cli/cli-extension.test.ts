import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

/**
 * End-to-end tests for user-defined CLI commands. They spawn the compiled CLI
 * as a real subprocess against plain `jsails.app.js` fixtures whose commands are
 * ordinary objects/classes, so the entire path is exercised: config discovery,
 * structural command collection, registry validation, raw argument forwarding,
 * help rendering, exit-code propagation, and value-free error reporting.
 *
 * No application is assembled, no extension `setup` runs, and no service is
 * contacted. Each config module is self-contained and imports nothing from the
 * package.
 */

const cliPath = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

// Fixtures live under dist/ so the spawned CLI resolves from the repo root.
const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'cli-extension-fixture-'),
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

function makeDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write an app config fixture whose default export is `body`. */
function writeConfig(dir: string, body: string, filename = 'jsails.app.js'): void {
  writeFileSync(join(dir, filename), `export default ${body};\n`);
}

describe('cli custom commands: dispatch', () => {
  it('runs an app-level command declared in the config', () => {
    const dir = makeDir('app-command');
    writeConfig(
      dir,
      `{
  commands: [
    {
      name: 'hello',
      summary: 'say hello',
      usage: 'hello [name]',
      run(rawArgs, ctx) {
        ctx.stdout('hello ' + (rawArgs.join(',') || 'world'));
      },
    },
  ],
}`,
    );

    const result = runCli(['hello', '--config', 'jsails.app.js', 'bob'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'hello bob\n');
  });

  it('discovers the default jsails.app.js when --config is omitted', () => {
    const dir = makeDir('default-config');
    writeConfig(
      dir,
      `{
  commands: [{ name: 'ping', summary: 'ping', run(rawArgs, ctx) { ctx.stdout('pong'); } }],
}`,
    );

    const result = runCli(['ping'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'pong\n');
  });

  it('runs a command declared by an extension without invoking setup', () => {
    const dir = makeDir('extension-command');
    writeConfig(
      dir,
      `{
  extensions: [
    {
      name: 'greeter',
      setup() {},
      commands: [
        {
          name: 'ext-hello',
          summary: 'from an extension',
          run(rawArgs, ctx) { ctx.stdout('ext:' + rawArgs.join('-')); },
        },
      ],
    },
  ],
}`,
    );

    const result = runCli(['ext-hello', '--config', 'jsails.app.js', 'a', 'b'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'ext:a-b\n');
  });
});

describe('cli custom commands: raw arguments', () => {
  it('forwards unknown flags and preserves order, including the -- delimiter', () => {
    const dir = makeDir('raw-args');
    writeConfig(
      dir,
      `{
  commands: [
    {
      name: 'raw',
      summary: 'echo raw args',
      run(rawArgs, ctx) { ctx.stdout('args=' + rawArgs.join('|')); },
    },
  ],
}`,
    );

    const result = runCli(
      ['raw', '--config', 'jsails.app.js', '--unknown', 'value', '--', '--config', 'after'],
      dir,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'args=--unknown|value|--|--config|after\n');
  });
});

describe('cli custom commands: help and lifecycle', () => {
  it('prints command help for --help without running the handler', () => {
    const dir = makeDir('custom-help');
    writeConfig(
      dir,
      `{
  commands: [
    {
      name: 'helpme',
      summary: 'help summary here',
      usage: 'helpme [--flag]',
      run() { throw new Error('handler-ran'); },
    },
  ],
}`,
    );

    const result = runCli(['helpme', '--config', 'jsails.app.js', '--help'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /help summary here/);
    assert.match(result.stdout, /jsails helpme \[--flag\]/);
    assert.doesNotMatch(result.stderr, /handler-ran/);
  });

  it('keeps global --help free of any config import', () => {
    const dir = makeDir('global-help');
    writeFileSync(
      join(dir, 'jsails.app.js'),
      `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./imported.marker', import.meta.url), 'x');
export default {};
`,
    );

    const result = runCli(['--help'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.equal(existsSync(join(dir, 'imported.marker')), false, 'config was not imported');
  });

  it('preserves method this and returns the handler exit code', () => {
    const dir = makeDir('method-this');
    writeFileSync(
      join(dir, 'jsails.app.js'),
      `class Counter {
  constructor() { this.prefix = 'count'; }
  get name() { return 'counter'; }
  get summary() { return 'counts something'; }
  run(rawArgs, ctx) {
    ctx.stdout(this.prefix + ':' + (rawArgs[0] || ''));
    return 7;
  }
}
export default { commands: [new Counter()] };
`,
    );

    const result = runCli(['counter', '--config', 'jsails.app.js', 'x'], dir);

    assert.equal(result.status, 7, result.stderr);
    assert.equal(result.stdout, 'count:x\n');
  });

  it('redacts a secret thrown by a command handler', () => {
    const dir = makeDir('secret');
    writeConfig(
      dir,
      `{
  commands: [
    {
      name: 'leak',
      summary: 'leaks a secret',
      run() { throw new Error('super-secret-token-abc'); },
    },
  ],
}`,
    );

    const result = runCli(['leak', '--config', 'jsails.app.js'], dir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /the command failed/);
    assert.doesNotMatch(result.stderr, /super-secret-token-abc/);
  });
});

describe('cli custom commands: argument errors', () => {
  it('fails on a missing config, duplicate --config, and --config without a value', () => {
    const dir = makeDir('config-errors');
    writeConfig(dir, `{ commands: [] }`);

    const missing = runCli(['db', '--config', 'nope.js'], dir);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /failed to load app config/);
    assert.doesNotMatch(missing.stderr, /ENOENT/);

    const duplicate = runCli(['db', '--config', 'jsails.app.js', '--config', 'other.js'], dir);
    assert.equal(duplicate.status, 2);
    assert.match(duplicate.stderr, /--config specified more than once/);

    const noValue = runCli(['db', '--config'], dir);
    assert.equal(noValue.status, 2);
    assert.match(noValue.stderr, /--config requires a value/);
  });
});
