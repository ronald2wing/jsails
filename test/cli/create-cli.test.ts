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
} from '../../src/cli/dispatch.js';
import {
  killOwnedProcessTree,
  type TreeKillChild,
  type TreeKillSpawn,
} from '../../src/cli/owned-process-tree.js';
import { createCliCommandRegistry } from '../../src/cli/command-registry.js';

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
  '.env.auth.example',
  '.gitignore',
  'AGENTS.md',
  'api/me.ts',
  'app/application-auth.ts',
  'app/application-client.ts',
  'app/application-command.ts',
  'app/application-component.ts',
  'app/application-job.ts',
  'app/application-plugin.ts',
  'app/application-record.ts',
  'app/application-resource.ts',
  'app/application-testing.ts',
  'app/registry.ts',
  'auth/README.md',
  'client/main.tsx',
  'commands/login.ts',
  'commands/logout.ts',
  'commands/whoami.ts',
  'components/task-list.tsx',
  'jamal.config.js',
  'jsails.app.js',
  'jsails.config.js',
  'package.json',
  'pages/about.tsx',
  'pages/dashboard.tsx',
  'pages/device.tsx',
  'pages/index.tsx',
  'pages/login.tsx',
  'pages/tasks.tsx',
  'playwright.config.ts',
  'scripts/auth-migrate.mjs',
  'scripts/create-user.mjs',
  'scripts/db-migrate.mjs',
  'scripts/run-tests.mjs',
  'test/app.test.ts',
  'test/auth.test.ts',
  'test/browser/auth.spec.ts',
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

/** Every file the `--cli` variant must produce (order-independent). */
const EXPECTED_CLI_FILES = [
  '.gitignore',
  'AGENTS.md',
  'app/application-command.ts',
  'commands/hello.ts',
  'jsails.app.js',
  'package.json',
  'tsconfig.json',
].sort();

/** Every file `create --static` must produce, order-independent (mirrors starter tests). */
const EXPECTED_STATIC_FILES = [
  '.gitignore',
  'AGENTS.md',
  'app/application-client.ts',
  'client/main.tsx',
  'jsails.app.js',
  'package.json',
  'pages/about.tsx',
  'pages/index.tsx',
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
  it('writes the full 47-file starter set and derives the name', async () => {
    const dir = caseDir('fresh');
    const code = await runCreateCommand(dir, { admin: false, blog: false, install: false });

    assert.equal(code, 0);
    assert.deepEqual(listFiles(dir), EXPECTED_FILES);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
    };
    assert.equal(pkg.name, 'fresh');
  });

  it('derives a valid npm name from a messy directory basename', async () => {
    const dir = caseDir('My App!');
    const code = await runCreateCommand(dir, { admin: false, blog: false, install: false });

    assert.equal(code, 0);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
    };
    assert.equal(pkg.name, 'myapp');
  });

  it('honours an explicit --name', async () => {
    const dir = caseDir('named');
    const code = await runCreateCommand(dir, {
      name: 'my-counter',
      admin: false,
      blog: false,
      install: false,
    });

    assert.equal(code, 0);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
    };
    assert.equal(pkg.name, 'my-counter');
  });

  it('honours a jsails dependency override', async () => {
    const dir = caseDir('dep-override');
    const code = await runCreateCommand(dir, {
      jsailsDependency: 'file:../jsails',
      admin: false,
      blog: false,
      install: false,
    });

    assert.equal(code, 0);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies['jsails'], 'file:../jsails');
  });

  it('--cli writes the 7-file CLI-only set and no web surface', async () => {
    const dir = caseDir('cli-unit');
    const code = await runCreateCommand(dir, {
      admin: false,
      blog: false,
      cli: true,
      install: false,
    });

    assert.equal(code, 0);
    assert.deepEqual(listFiles(dir), EXPECTED_CLI_FILES);
    assert.equal(existsSync(join(dir, 'jsails.app.js')), true, 'the CLI shape ships an app config');
    const appConfig = readFileSync(join(dir, 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /plugins: \{ use: \[\] \}/);
    assert.match(appConfig, /name: 'about'/);
    assert.equal(existsSync(join(dir, 'pages')), false, 'no pages/ in the CLI shape');
    assert.equal(existsSync(join(dir, 'api')), false, 'no api/ in the CLI shape');
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      scripts: Record<string, string>;
    };
    assert.equal(pkg.name, 'cli-unit');
    assert.equal(pkg.scripts['build'], 'tsc -p tsconfig.json');
    assert.equal(pkg.scripts['dev'], undefined, 'no dev script in the CLI shape');
  });

  it('rejects --cli combined with --admin or --blog without writing anything', async () => {
    for (const extra of [{ admin: true }, { blog: true }] as const) {
      const dir = caseDir(`cli-conflict-${'admin' in extra ? 'admin' : 'blog'}`);
      await assert.rejects(
        runCreateCommand(dir, { admin: false, blog: false, cli: true, install: false, ...extra }),
        /options\.cli cannot be combined with options\.admin, options\.blog, or options\.static/,
      );
      assert.equal(existsSync(dir), false, 'no directory is created on a conflict');
    }
  });

  it('--static writes the 15-file static-site set and no server surface', async () => {
    const dir = caseDir('static-unit');
    const code = await runCreateCommand(dir, {
      admin: false,
      blog: false,
      static: true,
      install: false,
    });

    assert.equal(code, 0);
    assert.deepEqual(listFiles(dir), EXPECTED_STATIC_FILES);
    assert.equal(
      existsSync(join(dir, 'jsails.app.js')),
      true,
      'the static shape ships an app config',
    );
    const appConfig = readFileSync(join(dir, 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /use: \[\]/);
    assert.doesNotMatch(appConfig, /enabled:/);
    assert.equal(existsSync(join(dir, 'api')), false, 'no api/ in the static shape');
    assert.equal(
      existsSync(join(dir, 'components')),
      false,
      'no server components in the static shape',
    );
    assert.equal(
      existsSync(join(dir, 'jamal.config.js')),
      false,
      'no Jamal config in the static shape',
    );
    assert.equal(
      existsSync(join(dir, 'jsails.config.js')),
      false,
      'no migration config in the static shape',
    );
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      scripts: Record<string, string>;
    };
    assert.equal(pkg.name, 'static-unit');
    assert.match(pkg.scripts['build'] ?? '', /jsails build --config jsails\.app\.js/);
    assert.equal(pkg.scripts['auth:migrate'], undefined, 'no auth script in the static shape');
  });

  it('rejects --static combined with --admin, --blog, or --cli without writing anything', async () => {
    for (const extra of [{ admin: true }, { blog: true }, { cli: true }] as const) {
      const label = 'admin' in extra ? 'admin' : 'blog' in extra ? 'blog' : 'cli';
      const dir = caseDir(`static-conflict-${label}`);
      await assert.rejects(
        runCreateCommand(dir, {
          admin: false,
          blog: false,
          static: true,
          install: false,
          ...extra,
        }),
        /options\.(static|cli) cannot be combined/,
      );
      assert.equal(existsSync(dir), false, 'no directory is created on a conflict');
    }
  });

  it('ships the auth-only starter by default (no --admin/--blog)', async () => {
    const dir = caseDir('auth-unit');
    const code = await runCreateCommand(dir, { admin: false, blog: false, install: false });

    assert.equal(code, 0);
    assert.ok(existsSync(join(dir, 'app/application-auth.ts')), 'auth shim is generated');
    assert.ok(existsSync(join(dir, 'auth/README.md')), 'auth README is generated');
    assert.ok(existsSync(join(dir, 'pages/login.tsx')), 'login page is generated');
    assert.ok(existsSync(join(dir, 'pages/device.tsx')), 'device approval page is generated');
    assert.ok(existsSync(join(dir, 'commands/login.ts')), 'login command is generated');
    assert.ok(existsSync(join(dir, 'commands/whoami.ts')), 'whoami command is generated');
    assert.ok(existsSync(join(dir, 'commands/logout.ts')), 'logout command is generated');
    assert.ok(existsSync(join(dir, '.env.auth.example')), 'env example is generated');
    assert.ok(existsSync(join(dir, 'pages/index.tsx')), 'base pages remain');
    assert.ok(existsSync(join(dir, 'components/task-list.tsx')), 'base components remain');
    const appConfig = readFileSync(join(dir, 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /jsails\/auth/);
    assert.match(appConfig, /jsails\/server-components/);
    // The default starter is auth-only: no admin panel is registered.
    assert.doesNotMatch(appConfig, /defineAdminPanel/);
    assert.doesNotMatch(appConfig, /jsails\/admin/);
    assert.match(
      appConfig,
      /enabled: \['plugin-tools', 'auth', 'cache', 'filesystem', 'mail', 'server-components'\]/,
    );
    assert.match(appConfig, /managed: true/);
  });

  it('--admin adds the admin panel and its plugin id', async () => {
    const dir = caseDir('admin-unit');
    const code = await runCreateCommand(dir, { admin: true, blog: false, install: false });

    assert.equal(code, 0);
    const appConfig = readFileSync(join(dir, 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /defineAdminPanel/);
    assert.match(appConfig, /jsails\/admin/);
    assert.match(appConfig, /auth: authSessionToken/);
    assert.match(
      appConfig,
      /enabled: \['plugin-tools', 'auth', 'admin', 'cache', 'filesystem', 'mail', 'server-components'\]/,
    );
    assert.doesNotMatch(appConfig, /jsails\/blog/);
    assert.doesNotMatch(appConfig, /pluginManagerPlugin/);
  });

  it('--blog adds the blog plugin, admin, plugin manager, and two blog pages', async () => {
    const dir = caseDir('blog-unit');
    const code = await runCreateCommand(dir, { admin: true, blog: true, install: false });

    assert.equal(code, 0);
    assert.ok(existsSync(join(dir, 'pages/blog/index.tsx')), 'blog index page is generated');
    assert.ok(existsSync(join(dir, 'pages/blog/[slug].tsx')), 'blog detail page is generated');
    const appConfig = readFileSync(join(dir, 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /jsails\/blog/);
    assert.match(appConfig, /blogAdmin/);
    assert.match(appConfig, /createDatabaseBlogStore/);
    assert.match(appConfig, /pluginManagerPlugin/);
    assert.match(
      appConfig,
      /enabled: \['plugin-tools', 'auth', 'admin', 'blog', 'cache', 'filesystem', 'mail', 'server-components'\]/,
    );
  });

  it('rejects an invalid name without writing anything', async () => {
    const dir = caseDir('invalid-name');

    await assert.rejects(
      runCreateCommand(dir, { name: 'Invalid Name', admin: false, blog: false, install: false }),
      /valid npm package name/,
    );
    assert.equal(existsSync(dir), false, 'no directory is created on an invalid name');
  });

  it('writes into an existing empty directory', async () => {
    const dir = caseDir('empty');
    mkdirSync(dir);

    const code = await runCreateCommand(dir, { admin: false, blog: false, install: false });

    assert.equal(code, 0);
    assert.deepEqual(listFiles(dir), EXPECTED_FILES);
  });

  it('refuses a non-empty target and leaves it unchanged', async () => {
    const dir = caseDir('nonempty');
    mkdirSync(dir);
    writeFileSync(join(dir, 'keep.txt'), 'do not touch');

    await assert.rejects(
      runCreateCommand(dir, { admin: false, blog: false, install: false }),
      /not empty/,
    );

    assert.deepEqual(readdirSync(dir), ['keep.txt']);
    assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'do not touch');
  });

  it('refuses a symlink target and leaves it unchanged', async () => {
    const real = caseDir('symlink-real');
    mkdirSync(real);
    const link = join(workspace, 'symlink-link');
    symlinkSync(real, link);

    await assert.rejects(
      runCreateCommand(link, { admin: false, blog: false, install: false }),
      /symbolic link/,
    );

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

    const code = await runCreateCommand(dir, { admin: false, blog: false, install: false }, deps);

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

    const code = await runCreateCommand(dir, { admin: false, blog: false, install: true }, deps);

    assert.equal(code, 0);
    assert.deepEqual(installed, [resolve(dir)]);
    assert.ok(existsSync(join(dir, 'package.json')));
  });

  it('keeps the project and propagates the exit code when install fails', async () => {
    const dir = caseDir('install-fails');
    const deps: CreateDeps = { install: async () => 3 };

    const code = await runCreateCommand(dir, { admin: false, blog: false, install: true }, deps);

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
    const spawns: Array<{
      command: string;
      args: readonly string[];
      options: unknown;
    }> = [];
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
    assert.deepEqual(spawns[0]?.options, {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
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

    const result = killOwnedProcessTree(999999999, 'SIGTERM', {
      platform: 'linux',
      spawn,
    });

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
    assert.deepEqual(npmInstallSpawn('linux', {}), {
      command: 'npm',
      args: ['install'],
    });
  });
});

// ---------------------------------------------------------------------------
// subprocess: real CLI
// ---------------------------------------------------------------------------

const cliPath = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

/** The framework package root, resolved from the compiled test module. */
const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The repo's own TypeScript compiler binary (used to compile the CLI fixture). */
const TSC_PATH = join(PACKAGE_ROOT, 'node_modules', '@typescript', 'native', 'bin', 'tsc');

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
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
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

  it('scaffolds the auth-only starter by default (no --admin/--blog)', () => {
    const result = runCli(['create', 'sub-auth'], workspace);

    assert.equal(result.status, 0, result.stderr);
    const dir = join(workspace, 'sub-auth');
    for (const key of [
      'app/application-auth.ts',
      'auth/README.md',
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
      assert.ok(existsSync(join(dir, key)), `starter must generate ${key}`);
    }
    // The base files remain and jsails.app.js is the consolidated auth-only config.
    assert.ok(existsSync(join(dir, 'pages/index.tsx')));
    assert.ok(existsSync(join(dir, 'components/task-list.tsx')));
    const appConfig = readFileSync(join(dir, 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /jsails\/auth/);
    assert.match(appConfig, /jsails\/server-components/);
    assert.doesNotMatch(appConfig, /defineAdminPanel/);
    assert.doesNotMatch(appConfig, /jsails\/admin/);
    assert.match(
      appConfig,
      /enabled: \['plugin-tools', 'auth', 'cache', 'filesystem', 'mail', 'server-components'\]/,
    );
    assert.match(appConfig, /managed: true/);

    // Auth ships inside the framework's `auth` plugin, so Better Auth + Kysely +
    // mysql2 are transitive framework dependencies, never direct starter
    // dependencies — and the former SQLite stack stays absent.
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const dep of ['better-auth', 'kysely', 'mysql2']) {
      assert.equal(pkg.dependencies[dep], undefined, `starter must not directly depend on ${dep}`);
    }
    assert.equal(pkg.dependencies['better-sqlite3'], undefined);
    assert.equal(pkg.devDependencies?.['@types/better-sqlite3'], undefined);

    // The env example documents the MariaDB connection variables.
    const envExample = readFileSync(join(dir, '.env.auth.example'), 'utf8');
    assert.match(envExample, /DATABASE_HOST/);
    assert.match(envExample, /DATABASE_NAME/);
  });

  it('--admin registers the admin panel and its plugin id', () => {
    const result = runCli(['create', 'sub-admin', '--admin'], workspace);

    assert.equal(result.status, 0, result.stderr);
    const appConfig = readFileSync(join(workspace, 'sub-admin', 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /defineAdminPanel/);
    assert.match(appConfig, /jsails\/admin/);
    assert.match(appConfig, /auth: authSessionToken/);
    assert.match(
      appConfig,
      /enabled: \['plugin-tools', 'auth', 'admin', 'cache', 'filesystem', 'mail', 'server-components'\]/,
    );
    assert.doesNotMatch(appConfig, /jsails\/blog/);
  });

  it('--blog registers the admin panel, blog plugin, plugin manager, and blog pages', () => {
    const result = runCli(['create', 'sub-blog', '--blog'], workspace);

    assert.equal(result.status, 0, result.stderr);
    const dir = join(workspace, 'sub-blog');
    // Two blog pages are added on top of the 47-file base set (49 total).
    assert.ok(existsSync(join(dir, 'pages/blog/index.tsx')), 'blog index page is generated');
    assert.ok(existsSync(join(dir, 'pages/blog/[slug].tsx')), 'blog detail page is generated');
    assert.equal(listFiles(dir).length, 49);
    const appConfig = readFileSync(join(dir, 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /jsails\/blog/);
    assert.match(appConfig, /blogAdmin/);
    assert.match(appConfig, /createDatabaseBlogStore/);
    assert.match(appConfig, /pluginManagerPlugin/);
    assert.match(appConfig, /defineAdminPanel/);
    assert.match(
      appConfig,
      /enabled: \['plugin-tools', 'auth', 'admin', 'blog', 'cache', 'filesystem', 'mail', 'server-components'\]/,
    );
  });

  it('--cli scaffolds the 7-file CLI-only project with no web surface', () => {
    const result = runCli(['create', 'sub-cli', '--cli'], workspace);

    assert.equal(result.status, 0, result.stderr);
    const dir = join(workspace, 'sub-cli');
    assert.deepEqual(listFiles(dir), EXPECTED_CLI_FILES);
    assert.equal(existsSync(join(dir, 'jsails.app.js')), true);
    assert.equal(existsSync(join(dir, 'pages')), false);
    assert.equal(existsSync(join(dir, 'client')), false);
    assert.equal(existsSync(join(dir, 'vite.config.js')), false);
    // The CLI shape prints build/run next steps, not the dev server.
    assert.match(result.stdout, /npm run build/);
    assert.match(result.stdout, /npx jsails hello/);
    assert.match(result.stdout, /npx jsails about/);
    assert.doesNotMatch(result.stdout, /npm run dev/);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      scripts: Record<string, string>;
    };
    assert.equal(pkg.name, 'sub-cli');
    assert.equal(pkg.scripts['build'], 'tsc -p tsconfig.json');
  });

  it('rejects --cli on non-create commands', () => {
    for (const args of [
      ['dev', '--cli'],
      ['serve', '--cli'],
      ['build', '--cli'],
    ]) {
      const result = runCli(args, workspace);
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
      assert.match(result.stderr, /--cli/);
    }
  });

  it('--static scaffolds the 15-file static-site project with no server surface', () => {
    const result = runCli(['create', 'sub-static', '--static'], workspace);

    assert.equal(result.status, 0, result.stderr);
    const dir = join(workspace, 'sub-static');
    assert.deepEqual(listFiles(dir), EXPECTED_STATIC_FILES);
    assert.equal(existsSync(join(dir, 'jsails.app.js')), true);
    assert.equal(existsSync(join(dir, 'pages/index.tsx')), true);
    assert.equal(existsSync(join(dir, 'pages/about.tsx')), true);
    assert.equal(existsSync(join(dir, 'client/main.tsx')), true);
    assert.equal(existsSync(join(dir, 'vite.config.js')), true);
    assert.equal(existsSync(join(dir, 'api')), false, 'no api/ in the static shape');
    assert.equal(
      existsSync(join(dir, 'components')),
      false,
      'no server components in the static shape',
    );
    assert.equal(
      existsSync(join(dir, 'jamal.config.js')),
      false,
      'no Jamal config in the static shape',
    );
    // The static shape prints build + deploy next steps, not the dev server.
    assert.match(result.stdout, /npm run build/);
    assert.match(result.stdout, /deploy the generated out\/ directory/);
    assert.doesNotMatch(result.stdout, /npm run dev/);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      scripts: Record<string, string>;
    };
    assert.equal(pkg.name, 'sub-static');
    assert.match(pkg.scripts['build'] ?? '', /jsails build --config jsails\.app\.js/);
  });

  it('rejects --static on non-create commands', () => {
    for (const args of [
      ['dev', '--static'],
      ['serve', '--static'],
      ['build', '--static'],
    ]) {
      const result = runCli(args, workspace);
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
      assert.match(result.stderr, /--static/);
    }
  });

  it('rejects --static combined with --admin, --blog, or --cli', () => {
    for (const args of [
      ['create', 'sub-static-admin', '--static', '--admin'],
      ['create', 'sub-static-blog', '--static', '--blog'],
      ['create', 'sub-static-cli', '--static', '--cli'],
    ]) {
      const result = runCli(args, workspace);
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
      assert.match(result.stderr, /--(static|cli) cannot be combined/);
      assert.equal(existsSync(join(workspace, args[1] as string)), false, 'no directory created');
    }
  });

  it('rejects --cli combined with --admin or --blog', () => {
    for (const args of [
      ['create', 'sub-cli-admin', '--cli', '--admin'],
      ['create', 'sub-cli-blog', '--cli', '--blog'],
      ['create', 'sub-cli-both', '--cli', '--admin', '--blog'],
    ]) {
      const result = runCli(args, workspace);
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
      assert.match(result.stderr, /--cli cannot be combined with --admin, --blog, or --static/);
      assert.equal(existsSync(join(workspace, args[1] as string)), false, 'no directory created');
    }
  });

  it('rejects --admin and --blog on non-create commands', () => {
    for (const args of [
      ['dev', '--admin'],
      ['serve', '--blog'],
      ['build', '--admin'],
      ['migrate', '--blog'],
    ]) {
      const result = runCli(args, workspace);
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
    }
  });

  it('rejects the removed --auth flag', () => {
    const result = runCli(['create', 'sub-auth-flag', '--auth'], workspace);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--auth/);
    assert.equal(existsSync(join(workspace, 'sub-auth-flag')), false);
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
      {
        args: ['dev', '--jsails-dependency', 'file:../jsails'],
        pattern: /--jsails-dependency/,
      },
      { args: ['dev', '--install'], pattern: /--install/ },
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
    assert.match(result.stdout, /--admin/);
    assert.match(result.stdout, /--blog/);
    assert.match(result.stdout, /--cli/);
    assert.doesNotMatch(result.stdout, /--auth/);
  });
});

// ---------------------------------------------------------------------------
// subprocess: --cli end-to-end smoke (scaffold + compile + run)
// ---------------------------------------------------------------------------

describe('cli: --cli smoke', () => {
  it('scaffolds, compiles, and runs the hello command end to end', () => {
    const create = runCli(['create', 'cli-smoke', '--cli'], workspace);
    assert.equal(create.status, 0, create.stderr);

    const dir = join(workspace, 'cli-smoke');

    // Resolve `jsails` and `@types/node` without a real `npm install`: symlink
    // the repo's own packages into the fixture's node_modules, then compile
    // with the repo's TypeScript. This keeps the smoke fast and offline.
    const nodeModules = join(dir, 'node_modules');
    mkdirSync(join(nodeModules, '@types'), { recursive: true });
    symlinkSync(PACKAGE_ROOT, join(nodeModules, 'jsails'), 'dir');
    symlinkSync(
      join(PACKAGE_ROOT, 'node_modules', '@types', 'node'),
      join(nodeModules, '@types', 'node'),
      'dir',
    );

    const build = spawnSync(process.execPath, [TSC_PATH, '-p', join(dir, 'tsconfig.json')], {
      encoding: 'utf8',
    });
    assert.equal(build.status, 0, build.stderr);
    assert.ok(existsSync(join(dir, 'dist', 'commands', 'hello.js')), 'hello.js is compiled');
    assert.ok(existsSync(join(dir, 'dist', 'app', 'application-command.js')), 'shim is compiled');

    // Run the sample command with an explicit name (no interactive prompt).
    const run = runCli(['hello', 'World'], dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Hello, World!/);

    // `jsails <name>` discovers compiled commands; the CLI shape also ships a
    // real app config, so a config-declared command loads it.
    assert.equal(existsSync(join(dir, 'jsails.app.js')), true);
    const help = runCli(['hello', '--help'], dir);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /hello - Greet someone by name/);

    // The app config declares an `about` command; run it after tsc compiles the
    // config (plain ESM, no `dist/` import, so it loads fine).
    const about = runCli(['about'], dir);
    assert.equal(about.status, 0, about.stderr);
    assert.match(about.stdout, /JSails CLI project/);
  });
});
