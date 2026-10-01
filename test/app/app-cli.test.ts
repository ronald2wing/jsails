import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import type { Application } from '../../src/app/application.js';
import type { ResolvedAppConfig } from '../../src/app/config/index.js';
import { runAppCommand, type AppDeps } from '../../src/cli/dispatch.js';
import type { ShutdownSignal } from '../../src/cli.js';

/**
 * Tests for the app CLI (`build` / `serve`) and the app command injection seam.
 *
 * Unit tests inject fake factories through `runAppCommand` to verify lifecycle,
 * close-once semantics, and signal disposal without a real server or config
 * module. Subprocess tests run the compiled CLI against real `jsails.app.js`
 * modules that use an in-memory service provider (no database is ever opened).
 */

// ---------------------------------------------------------------------------
// injection seam: fake factories
// ---------------------------------------------------------------------------

interface FakeAppHandle {
  config: ResolvedAppConfig;
  buildCalls: number;
  serveCalls: number;
  closeCalls: number;
}

function makeFakeAppDeps() {
  const events: string[] = [];
  const loadedConfigs: string[] = [];
  const apps: FakeAppHandle[] = [];
  let loadError: Error | undefined;
  let buildError: Error | undefined;
  let serveError: Error | undefined;
  let markServed!: () => void;
  const served = new Promise<void>((resolve) => {
    markServed = resolve;
  });

  const deps: AppDeps = {
    loadConfig: async (configPath) => {
      events.push('load');
      if (loadError) throw loadError;
      loadedConfigs.push(configPath);
      return { configPath } as unknown as ResolvedAppConfig;
    },
    createApplication: async (config) => {
      events.push('create');
      const handle: FakeAppHandle = { config, buildCalls: 0, serveCalls: 0, closeCalls: 0 };
      apps.push(handle);
      return {
        build: async () => {
          events.push('build');
          handle.buildCalls += 1;
          if (buildError) throw buildError;
          return { written: ['/out/index.html'], copied: [], skipped: ['/api/x'] };
        },
        serve: async () => {
          events.push('serve');
          handle.serveCalls += 1;
          if (serveError) throw serveError;
          markServed();
          return { url: 'http://127.0.0.1:9/' };
        },
        close: async () => {
          events.push('close');
          handle.closeCalls += 1;
        },
      } as unknown as Application;
    },
  };

  return {
    deps,
    events,
    loadedConfigs,
    apps,
    served,
    setLoadError: (error: Error) => {
      loadError = error;
    },
    setBuildError: (error: Error) => {
      buildError = error;
    },
    setServeError: (error: Error) => {
      serveError = error;
    },
  };
}

function makeSignal() {
  let disposed = 0;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  const signal: ShutdownSignal = {
    promise,
    dispose: () => {
      disposed += 1;
    },
  };
  return {
    signal,
    resolve: () => resolve(),
    disposeCount: () => disposed,
  };
}

// ---------------------------------------------------------------------------
// injection seam: build lifecycle
// ---------------------------------------------------------------------------

describe('runAppCommand: build', () => {
  it('loads, creates, builds, and closes exactly once', async () => {
    const fake = makeFakeAppDeps();
    const code = await runAppCommand('build', 'jsails.app.js', fake.deps);

    assert.equal(code, 0);
    assert.deepEqual(fake.loadedConfigs, ['jsails.app.js']);
    assert.equal(fake.apps.length, 1);
    assert.equal(fake.apps[0]?.buildCalls, 1);
    assert.equal(fake.apps[0]?.closeCalls, 1, 'app closed exactly once');
  });

  it('closes the app exactly once when the build fails', async () => {
    const fake = makeFakeAppDeps();
    fake.setBuildError(new Error('build boom'));

    await assert.rejects(runAppCommand('build', 'jsails.app.js', fake.deps), /build boom/);

    assert.equal(fake.apps[0]?.buildCalls, 1);
    assert.equal(fake.apps[0]?.closeCalls, 1, 'app closed exactly once on build failure');
  });

  it('owns nothing to close when the config module fails to load', async () => {
    const fake = makeFakeAppDeps();
    fake.setLoadError(new Error('bad config'));

    await assert.rejects(runAppCommand('build', 'jsails.app.js', fake.deps), /bad config/);

    assert.equal(fake.apps.length, 0, 'no application was created');
  });
});

// ---------------------------------------------------------------------------
// injection seam: serve lifecycle
// ---------------------------------------------------------------------------

describe('runAppCommand: serve', () => {
  it('installs signals before startup, then closes exactly once on signal', async () => {
    const fake = makeFakeAppDeps();
    const sig = makeSignal();

    const pending = runAppCommand('serve', 'jsails.app.js', {
      ...fake.deps,
      waitForShutdown: () => {
        fake.events.push('signal-install');
        return sig.signal;
      },
    });

    await fake.served;
    assert.equal(fake.apps[0]?.closeCalls, 0, 'app stays open while serving');

    sig.resolve();
    const code = await pending;

    assert.equal(code, 0);
    assert.equal(fake.apps[0]?.closeCalls, 1, 'app closed exactly once on shutdown');
    assert.equal(sig.disposeCount(), 1, 'signal listeners disposed on shutdown');
    assert.ok(
      fake.events.indexOf('signal-install') < fake.events.indexOf('create'),
      'signal handlers installed before application assembly',
    );
  });

  it('disposes signal listeners and closes the app when listen fails', async () => {
    const fake = makeFakeAppDeps();
    fake.setServeError(new Error('EADDRINUSE'));
    const sig = makeSignal();

    await assert.rejects(
      runAppCommand('serve', 'jsails.app.js', { ...fake.deps, waitForShutdown: () => sig.signal }),
      /EADDRINUSE/,
    );

    assert.equal(fake.apps[0]?.closeCalls, 1, 'app closed exactly once on listen failure');
    assert.equal(sig.disposeCount(), 1, 'signal listeners disposed on listen failure');
  });

  it('never installs signal handlers when config loading fails', async () => {
    const fake = makeFakeAppDeps();
    fake.setLoadError(new Error('bad config'));
    const sig = makeSignal();

    await assert.rejects(
      runAppCommand('serve', 'jsails.app.js', { ...fake.deps, waitForShutdown: () => sig.signal }),
      /bad config/,
    );

    assert.equal(fake.apps.length, 0, 'no application was created');
    assert.equal(sig.disposeCount(), 0, 'no signal handler installed');
  });
});

// ---------------------------------------------------------------------------
// subprocess: real CLI
// ---------------------------------------------------------------------------

const cliPath = fileURLToPath(new URL('../../src/cli.js', import.meta.url));
const indexUrl = pathToFileURL(fileURLToPath(new URL('../../src/index.js', import.meta.url))).href;

// Fixtures live under dist/ so bare imports resolve to the repo's node_modules.
const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'app-cli-fixture-'),
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

function writeConfig(dir: string, content: string, filename = 'jsails.app.js'): void {
  writeFileSync(join(dir, filename), content);
}

function writePage(dir: string, rel = 'index.js'): void {
  const path = join(dir, 'pages', rel);
  mkdirSync(join(dir, 'pages'), { recursive: true });
  writeFileSync(path, 'export default function Page() { return null; };\n');
}

/** A config with a custom renderer + an extension-provided in-memory service. */
const BUILD_CONFIG = `import { createServiceToken } from ${JSON.stringify(indexUrl)};

const GREETER = createServiceToken('greeter');

const greeterExtension = {
  name: 'greeter',
  setup(context) {
    context.services.provide(GREETER, { greeting: 'hello-from-extension' });
    return () => {};
  },
};

const renderer = {
  render(entry, context) {
    const greeting = context.services.get(GREETER).greeting;
    return '<html><body>' + greeting + ':' + entry.route + '</body></html>';
  },
};

export default { renderer, extensions: [greeterExtension] };
`;

/** A config whose `setup` cleanup writes a marker on shutdown (for `serve`). */
const SERVE_CONFIG = `import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default {
  port: 0,
  renderer: {
    render(entry) {
      return '<html><body>served:' + entry.route + '</body></html>';
    },
  },
  setup() {
    return () => {
      writeFileSync(join(here, 'cleanup.marker'), 'closed');
    };
  },
};
`;

describe('cli: build subprocess', () => {
  it('builds a static site with a custom renderer + extension service (no database)', () => {
    const dir = makeDir('build-static');
    writePage(dir);
    mkdirSync(join(dir, 'api'), { recursive: true });
    writeFileSync(
      join(dir, 'api', 'hello.js'),
      'export async function GET() { return new Response("{}"); }\n',
    );
    writeConfig(dir, BUILD_CONFIG);

    const result = runCli(['build'], dir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Built 1 output file/);
    assert.match(result.stdout, /Skipped 1 API route/);

    const html = readFileSync(join(dir, 'out', 'index.html'), 'utf8');
    assert.match(html, /hello-from-extension:\//);
  });

  it('rejects a TypeScript app config with a compile hint', () => {
    const dir = makeDir('ts-app-config');
    const result = runCli(['build', '--config', 'jsails.app.ts'], dir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /compile it to JavaScript first/);
  });

  it('rejects a missing app config without leaking filesystem details', () => {
    const dir = makeDir('missing-app-config');
    const result = runCli(['build', '--config', 'nope.js'], dir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to load app config/);
  });

  it('does not echo a config module exception', () => {
    const dir = makeDir('throwing-app-config');
    writeConfig(dir, `throw new Error('supersecret-password'); export default {};`);

    const result = runCli(['build'], dir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to load app config/);
    assert.doesNotMatch(result.stderr, /supersecret-password/);
  });

  it('does not echo an extension setup error that embeds a secret', () => {
    const dir = makeDir('extension-secret');
    writeConfig(
      dir,
      `import { createServiceToken } from ${JSON.stringify(indexUrl)};
const T = createServiceToken('x');
export default {
  extensions: [{ name: 'boom', setup() { throw new Error('supersecret-password'); } }],
};`,
    );

    const result = runCli(['build'], dir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /the application command failed/);
    assert.doesNotMatch(result.stderr, /supersecret-password/);
  });

  it('does not echo a renderer error that embeds a secret', () => {
    const dir = makeDir('renderer-secret');
    writePage(dir);
    writeConfig(
      dir,
      `export default {
  renderer: { render() { throw new Error('another-supersecret'); } },
};`,
    );

    const result = runCli(['build'], dir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /the application command failed/);
    assert.doesNotMatch(result.stderr, /another-supersecret/);
  });

  it('rejects migration-only flags on app commands', () => {
    const dir = makeDir('app-flags');
    writeConfig(dir, `export default {};`);

    assert.equal(runCli(['build', '--migrations', 'x'], dir).status, 2);
    assert.equal(runCli(['serve', '--name', 'x'], dir).status, 2);
  });
});

describe('cli: serve subprocess', () => {
  it('serves an ephemeral-port HTTP response, then SIGTERM shuts down and runs cleanup', async () => {
    const dir = makeDir('serve-ephemeral');
    writePage(dir);
    writeConfig(dir, SERVE_CONFIG);

    const { child, waitForUrl } = startServe(dir);
    try {
      const url = await waitForUrl();

      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /served:/);

      const exit = await signalAndWait(child, 'SIGTERM');
      assert.equal(exit.code, 0, 'serve exits cleanly after SIGTERM');
      assert.ok(existsSync(join(dir, 'cleanup.marker')), 'setup cleanup ran on SIGTERM');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  });
});

describe('cli: help keeps every command', () => {
  it('lists migration, work, schedule, build, and serve in --help', () => {
    const result = runCli(['--help'], makeDir('help'));

    assert.equal(result.status, 0, result.stderr);
    for (const name of [
      'makemigrations',
      'migrate',
      'showmigrations',
      'work',
      'schedule',
      'build',
      'serve',
    ]) {
      assert.match(result.stdout, new RegExp(name), `help must list ${name}`);
    }
    assert.match(result.stdout, /jsails\.app\.js/);
  });
});

// ---------------------------------------------------------------------------
// subprocess helpers
// ---------------------------------------------------------------------------

/** Start `jsails serve` and return the child plus a URL waiter. */
function startServe(dir: string): {
  child: ChildProcess;
  waitForUrl: () => Promise<string>;
  output: () => { stdout: string; stderr: string };
} {
  const child = spawn(process.execPath, [cliPath, 'serve'], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const waitForUrl = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const match = /Serving at (http:\/\/\S+)/.exec(stdout);
        if (match) {
          clearInterval(timer);
          resolve(match[1]!);
        } else if (Date.now() - started > 15000) {
          clearInterval(timer);
          reject(new Error(`timed out waiting for serve URL; stdout: ${stdout}`));
        }
      }, 25);
    });

  return { child, waitForUrl, output: () => ({ stdout, stderr }) };
}

/** Send `signal` and resolve when the child exits, or reject on timeout. */
function signalAndWait(
  child: ChildProcess,
  signal: NodeJS.Signals,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });
  child.kill(signal);
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`timed out waiting for exit after ${signal}`)), 15000);
  });
  return Promise.race([exited, timeout]);
}
