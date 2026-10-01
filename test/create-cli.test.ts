import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  npmInstallSpawn,
  runCreateCommand,
  runDevCommand,
  type CreateDeps,
  type DevCommandDeps,
} from '../src/cli.js';
import {
  killOwnedProcessTree,
  type TreeKillChild,
  type TreeKillSpawn,
} from '../src/cli/owned-process-tree.js';
import { createCliCommandRegistry } from '../src/cli/commands.js';

/**
 * Tests for the `create` and `dev` CLI commands.
 *
 * Unit tests drive `runCreateCommand` and `runDevCommand` directly with an
 * injected install/toolchain seam so no real `npm install`, compiler, or
 * watcher is ever started. Subprocess tests spawn the compiled CLI for the
 * argument-parsing, flag-restriction, help, and on-disk scaffold paths that
 * need the real entry point.
 */

/** Every file `create` must produce, order-independent (mirrors starter tests). */
const EXPECTED_FILES = [
  'AGENTS.md',
  '.gitignore',
  'client/main.tsx',
  'components/task-list.tsx',
  'jsails.app.js',
  'package.json',
  'pages/about.tsx',
  'pages/index.tsx',
  'pages/tasks.tsx',
  'playwright.config.ts',
  'scripts/run-tests.mjs',
  'test/app.test.ts',
  'test/browser/fixtures.ts',
  'test/browser/home.spec.ts',
  'tsconfig.client.json',
  'tsconfig.json',
  'ui/components.tsx',
  'ui/counter.tsx',
  'ui/layout.tsx',
  'ui/styles.css',
  'vite.config.js',
].sort();

const workspace = mkdtempSync(join(tmpdir(), 'jsails-create-cli-'));

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** A fresh absolute path under the workspace (absent until written). */
function caseDir(name: string): string {
  return join(workspace, name);
}

/** Recursively list relative file paths under `dir`, sorted. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort()) {
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(d, entry.name), rel);
      } else {
        out.push(rel);
      }
    }
  };
  walk(dir, '');
  return out.sort();
}

// ---------------------------------------------------------------------------
// unit: runCreateCommand
// ---------------------------------------------------------------------------

describe('runCreateCommand: scaffold', () => {
  it('writes the full 21-file starter set and derives the name', async () => {
    const dir = caseDir('fresh');
    const code = await runCreateCommand(dir, { install: false });

    assert.equal(code, 0);
    assert.deepEqual(listFiles(dir), EXPECTED_FILES);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string };
    assert.equal(pkg.name, 'fresh');
  });

  it('derives a valid npm name from a messy directory basename', async () => {
    const dir = caseDir('My App!');
    const code = await runCreateCommand(dir, { install: false });

    assert.equal(code, 0);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string };
    assert.equal(pkg.name, 'myapp');
  });

  it('honours an explicit --name', async () => {
    const dir = caseDir('named');
    const code = await runCreateCommand(dir, { name: 'my-counter', install: false });

    assert.equal(code, 0);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string };
    assert.equal(pkg.name, 'my-counter');
  });

  it('honours a jsails dependency override', async () => {
    const dir = caseDir('dep-override');
    const code = await runCreateCommand(dir, {
      jsailsDependency: 'file:../jsails',
      install: false,
    });

    assert.equal(code, 0);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies['jsails'], 'file:../jsails');
  });

  it('passes auth through to generate the auth variant', async () => {
    const dir = caseDir('auth-unit');
    const code = await runCreateCommand(dir, { install: false, auth: true });

    assert.equal(code, 0);
    assert.ok(existsSync(join(dir, 'auth/better-auth.ts')), 'auth module is generated');
    assert.ok(existsSync(join(dir, 'auth/cli-client.ts')), 'auth CLI client is generated');
    assert.ok(existsSync(join(dir, 'pages/login.tsx')), 'login page is generated');
    assert.ok(existsSync(join(dir, 'pages/device.tsx')), 'device approval page is generated');
    assert.ok(existsSync(join(dir, 'commands/login.ts')), 'login command is generated');
    assert.ok(existsSync(join(dir, 'commands/whoami.ts')), 'whoami command is generated');
    assert.ok(existsSync(join(dir, 'commands/logout.ts')), 'logout command is generated');
    assert.ok(existsSync(join(dir, '.env.auth.example')), 'env example is generated');
    assert.ok(existsSync(join(dir, 'pages/index.tsx')), 'base pages remain');
    assert.ok(existsSync(join(dir, 'components/task-list.tsx')), 'base components remain');
    assert.match(readFileSync(join(dir, 'jsails.app.js'), 'utf8'), /createAuth/);
  });

  it('rejects an invalid name without writing anything', async () => {
    const dir = caseDir('invalid-name');

    await assert.rejects(
      runCreateCommand(dir, { name: 'Invalid Name', install: false }),
      /valid npm package name/,
    );
    assert.equal(existsSync(dir), false, 'no directory is created on an invalid name');
  });

  it('writes into an existing empty directory', async () => {
    const dir = caseDir('empty');
    mkdirSync(dir);

    const code = await runCreateCommand(dir, { install: false });

    assert.equal(code, 0);
    assert.deepEqual(listFiles(dir), EXPECTED_FILES);
  });

  it('refuses a non-empty target and leaves it unchanged', async () => {
    const dir = caseDir('nonempty');
    mkdirSync(dir);
    writeFileSync(join(dir, 'keep.txt'), 'do not touch');

    await assert.rejects(runCreateCommand(dir, { install: false }), /not empty/);

    assert.deepEqual(readdirSync(dir), ['keep.txt']);
    assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'do not touch');
  });

  it('refuses a symlink target and leaves it unchanged', async () => {
    const real = caseDir('symlink-real');
    mkdirSync(real);
    const link = join(workspace, 'symlink-link');
    symlinkSync(real, link);

    await assert.rejects(runCreateCommand(link, { install: false }), /symbolic link/);

    assert.equal(lstatSync(link).isSymbolicLink(), true, 'the symlink is untouched');
    assert.deepEqual(readdirSync(real), [], 'the symlink target is untouched');
  });
});

describe('runCreateCommand: install', () => {
  it('does not install unless requested', async () => {
    const dir = caseDir('no-install');
    let calls = 0;
    const deps: CreateDeps = {
      install: async () => {
        calls += 1;
        return 0;
      },
    };

    const code = await runCreateCommand(dir, { install: false }, deps);

    assert.equal(code, 0);
    assert.equal(calls, 0);
    assert.ok(existsSync(join(dir, 'package.json')));
  });

  it('invokes install inside the created target only when requested', async () => {
    const dir = caseDir('install');
    const installed: string[] = [];
    const deps: CreateDeps = {
      install: async (cwd) => {
        installed.push(cwd);
        return 0;
      },
    };

    const code = await runCreateCommand(dir, { install: true }, deps);

    assert.equal(code, 0);
    assert.deepEqual(installed, [resolve(dir)]);
    assert.ok(existsSync(join(dir, 'package.json')));
  });

  it('keeps the project and propagates the exit code when install fails', async () => {
    const dir = caseDir('install-fails');
    const deps: CreateDeps = { install: async () => 3 };

    const code = await runCreateCommand(dir, { install: true }, deps);

    assert.equal(code, 3);
    assert.ok(existsSync(join(dir, 'package.json')), 'the project is kept on install failure');
  });
});

// ---------------------------------------------------------------------------
// unit: runDevCommand
// ---------------------------------------------------------------------------

describe('runDevCommand', () => {
  it('dispatches to runDev with the resolved config path', async () => {
    let captured: { configPath?: string } = {};
    const deps: DevCommandDeps = {
      runDev: async (options) => {
        captured = options;
        return 0;
      },
    };

    const code = await runDevCommand('jsails.app.js', deps);

    assert.equal(code, 0);
    assert.deepEqual(captured, { configPath: 'jsails.app.js' });
  });

  it('propagates the dev exit code and installs no signal handlers', async () => {
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const deps: DevCommandDeps = { runDev: async () => 7 };

    const code = await runDevCommand('custom.app.js', deps);

    assert.equal(code, 7);
    assert.equal(process.listenerCount('SIGINT'), beforeInt, 'no SIGINT handler added');
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm, 'no SIGTERM handler added');
  });
});

describe('create and dev are reserved builtin names', () => {
  it('cannot be shadowed by a user command', () => {
    for (const name of ['create', 'dev']) {
      assert.throws(
        () => createCliCommandRegistry([{ name, summary: 'x', run: () => 0 }]),
        /reserved/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// owned process-tree teardown and npm-install arg assembly
// ---------------------------------------------------------------------------

describe('killOwnedProcessTree: arg assembly', () => {
  it('force-terminates the owned tree on win32 via taskkill.exe /PID /T /F', () => {
    const spawns: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
    let errorListener = false;
    const spawn: TreeKillSpawn = (command, args, options) => {
      spawns.push({ command, args, options });
      const child: TreeKillChild = {
        once(event) {
          if (event === 'error') errorListener = true;
        },
      };
      return child;
    };

    const result = killOwnedProcessTree(4321, 'SIGTERM', {
      platform: 'win32',
      spawn,
      systemRoot: 'C:\\Windows',
    });

    assert.equal(result, true);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0]?.command, 'C:\\Windows\\System32\\taskkill.exe');
    assert.deepEqual(spawns[0]?.args, ['/PID', '4321', '/T', '/F']);
    assert.deepEqual(spawns[0]?.options, { detached: true, stdio: 'ignore', shell: false });
    assert.equal(errorListener, true, 'an error listener prevents an unhandled spawn error');
  });

  it('resolves taskkill.exe from a well-known SystemRoot when none is given', () => {
    let command = '';
    const spawn: TreeKillSpawn = (c) => {
      command = c;
      return { once() {} };
    };

    killOwnedProcessTree(1, 'SIGKILL', { platform: 'win32', spawn });

    assert.equal(command, 'C:\\Windows\\System32\\taskkill.exe');
  });

  it('swallows an already-gone PID on POSIX and reports it as false', () => {
    const spawn: TreeKillSpawn = () => ({ once() {} });

    const result = killOwnedProcessTree(999999999, 'SIGTERM', { platform: 'linux', spawn });

    assert.equal(result, false);
  });
});

describe('npmInstallSpawn: platform command assembly', () => {
  it('uses cmd.exe with a fixed, non-interpolated command on win32', () => {
    assert.deepEqual(npmInstallSpawn('win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }), {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm install'],
    });
  });

  it('falls back to SystemRoot for cmd.exe when ComSpec is unset', () => {
    assert.deepEqual(npmInstallSpawn('win32', { SystemRoot: 'C:\\Win' }), {
      command: 'C:\\Win\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm install'],
    });
  });

  it('spawns npm directly on POSIX', () => {
    assert.deepEqual(npmInstallSpawn('linux', {}), { command: 'npm', args: ['install'] });
  });
});

// ---------------------------------------------------------------------------
// subprocess: real CLI
// ---------------------------------------------------------------------------

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

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

describe('cli: create subprocess', () => {
  it('scaffolds a fresh project and prints the next steps', () => {
    const result = runCli(['create', 'sub-fresh'], workspace);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(listFiles(join(workspace, 'sub-fresh')), EXPECTED_FILES);
    assert.match(result.stdout, /npm install/);
    assert.match(result.stdout, /npm run dev/);
    assert.match(result.stdout, /npm run build/);
  });

  it('derives the package name from the target directory', () => {
    const result = runCli(['create', 'my-new-app'], workspace);

    assert.equal(result.status, 0, result.stderr);
    const pkg = JSON.parse(readFileSync(join(workspace, 'my-new-app', 'package.json'), 'utf8')) as {
      name: string;
    };
    assert.equal(pkg.name, 'my-new-app');
  });

  it('honours --name and --jsails-dependency together', () => {
    const result = runCli(
      ['create', 'overridden', '--name', 'custom-pkg', '--jsails-dependency', 'file:../jsails'],
      workspace,
    );

    assert.equal(result.status, 0, result.stderr);
    const pkg = JSON.parse(readFileSync(join(workspace, 'overridden', 'package.json'), 'utf8')) as {
      name: string;
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.name, 'custom-pkg');
    assert.equal(pkg.dependencies['jsails'], 'file:../jsails');
  });

  it('scaffolds the auth variant with --auth', () => {
    const result = runCli(['create', 'sub-auth', '--auth'], workspace);

    assert.equal(result.status, 0, result.stderr);
    const dir = join(workspace, 'sub-auth');
    for (const key of [
      'auth/better-auth.ts',
      'auth/cli-client.ts',
      'auth/routes.ts',
      'pages/login.tsx',
      'pages/dashboard.tsx',
      'pages/device.tsx',
      'commands/login.ts',
      'commands/whoami.ts',
      'commands/logout.ts',
      'api/me.ts',
      '.env.auth.example',
      'scripts/auth-migrate.mjs',
      'scripts/create-user.mjs',
      'test/auth.test.ts',
      'test/browser/auth.spec.ts',
    ]) {
      assert.ok(existsSync(join(dir, key)), `auth variant must generate ${key}`);
    }
    // The base files remain and jsails.app.js is the auth config.
    assert.ok(existsSync(join(dir, 'pages/index.tsx')));
    assert.ok(existsSync(join(dir, 'components/task-list.tsx')));
    assert.match(readFileSync(join(dir, 'jsails.app.js'), 'utf8'), /createAuth/);
  });

  it('rejects a missing target directory argument', () => {
    const result = runCli(['create'], workspace);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /target directory/);
  });

  it('rejects --config (create needs no app config)', () => {
    const result = runCli(['create', 'with-config', '--config', 'jsails.app.js'], workspace);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--config/);
    assert.equal(existsSync(join(workspace, 'with-config')), false);
  });

  it('rejects an invalid --name without creating the directory', () => {
    const result = runCli(['create', 'bad-name', '--name', 'Invalid Name'], workspace);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /valid npm package name/);
    assert.equal(existsSync(join(workspace, 'bad-name')), false);
  });

  it('refuses to overwrite a non-empty directory', () => {
    const dir = join(workspace, 'occupied');
    mkdirSync(dir);
    writeFileSync(join(dir, 'keep.txt'), 'sentinel');

    const result = runCli(['create', 'occupied'], workspace);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /not empty/);
    assert.deepEqual(readdirSync(dir), ['keep.txt']);
    assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'sentinel');
  });
});

describe('cli: dev subprocess (flag validation only, no toolchain)', () => {
  it('rejects every create- or migration-only flag before starting dev', () => {
    const cases: Array<{ args: string[]; pattern: RegExp }> = [
      { args: ['dev', '--name', 'x'], pattern: /--name/ },
      { args: ['dev', '--jsails-dependency', 'file:../jsails'], pattern: /--jsails-dependency/ },
      { args: ['dev', '--install'], pattern: /--install/ },
      { args: ['dev', '--auth'], pattern: /--auth/ },
      { args: ['dev', '--migrations', 'x'], pattern: /--migrations/ },
      { args: ['dev', '--allow-destructive'], pattern: /--allow-destructive/ },
    ];
    for (const { args, pattern } of cases) {
      const result = runCli(args, workspace);
      assert.equal(result.status, 2, `dev ${args.slice(1).join(' ')} must be a usage error`);
      assert.match(result.stderr, pattern);
    }
  });

  it('rejects create-only flags on migration/app commands too', () => {
    for (const args of [
      ['migrate', '--install'],
      ['build', '--jsails-dependency', 'x'],
      ['serve', '--install'],
      ['migrate', '--auth'],
      ['build', '--auth'],
    ]) {
      const result = runCli(args, workspace);
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
    }
  });
});

describe('cli: help lists create and dev', () => {
  it('prints create and dev without importing any config', () => {
    const result = runCli(['--help'], workspace);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /create <dir>/);
    assert.match(result.stdout, /^ {2}dev\s/m);
    assert.match(result.stdout, /--auth/);
  });
});
