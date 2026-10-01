import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  DEV_CONFIG_ENV,
  DEV_CWD_ENV,
  DEV_REAL_HOME_ENV,
  DEV_REAL_HOMEPATH_ENV,
  runDev,
  type DevChild,
  type DevDeps,
  type DevSpawnOptions,
} from '../../src/dev/dev-runtime.js';
import { applyDefaultNodeEnv } from '../../src/dev/serve-child.js';

/**
 * Tests for the dev runtime orchestration (`runDev`).
 *
 * These drive the real orchestration against a fake process seam: no compiler,
 * Vite, or nodemon is ever started. The fake seam records every spawn, every
 * signal, and every temp-dir removal so the tests can assert on command order,
 * the nodemon argv, the isolated environment, and teardown ownership.
 */

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

/** A fake child process: an EventEmitter plus a manually-triggered exit/error. */
class FakeChild implements DevChild {
  private readonly emitter = new EventEmitter();
  readonly pid: number;
  exitCode: number | null = null;

  constructor(pid: number) {
    this.pid = pid;
  }

  on(event: 'exit' | 'error', listener: (...args: any[]) => void): void {
    this.emitter.on(event, listener);
  }

  once(event: 'exit' | 'error', listener: (...args: any[]) => void): void {
    this.emitter.once(event, listener);
  }

  removeListener(event: 'exit' | 'error', listener: (...args: any[]) => void): void {
    this.emitter.removeListener(event, listener);
  }

  exit(code: number): void {
    this.exitCode = code;
    this.emitter.emit('exit', code, null);
  }

  fail(): void {
    this.emitter.emit('error', new Error('spawn failed'));
  }
}

interface SpawnRecord {
  command: string;
  args: readonly string[];
  options: DevSpawnOptions | undefined;
  child: FakeChild;
}

interface Harness {
  deps: DevDeps;
  spawns: SpawnRecord[];
  killed: Array<{ pid: number; signal: string }>;
  removed: string[];
  tempDirs: string[];
  signal: () => void;
  disposeCount: () => number;
}

const createdDirs: string[] = [];

after(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Track a temp dir so the `after` hook can remove it. */
function makeProject(files: { tsconfig?: boolean; viteConfig?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-dev-proj-'));
  createdDirs.push(dir);
  if (files.tsconfig) writeFileSync(join(dir, 'tsconfig.json'), '{}');
  if (files.viteConfig) writeFileSync(join(dir, 'vite.config.js'), 'export default {};');
  return dir;
}

function createHarness(
  options: {
    resolveTool?: (tool: 'tsc' | 'vite') => string | undefined;
  } = {},
): Harness {
  const spawns: SpawnRecord[] = [];
  const killed: Array<{ pid: number; signal: string }> = [];
  const removed: string[] = [];
  const tempDirs: string[] = [];
  let nextPid = 1000;
  let resolveSignal!: () => void;
  let disposed = 0;
  const signalPromise = new Promise<void>((resolvePromise) => {
    resolveSignal = resolvePromise;
  });

  const resolveTool = options.resolveTool ?? ((tool) => `/tools/${tool}.js`);

  const deps: DevDeps = {
    spawn: (command, args, spawnOptions) => {
      const child = new FakeChild(nextPid);
      nextPid += 1;
      spawns.push({ command, args, options: spawnOptions, child });
      return child;
    },
    killGroup: (pid, signal) => {
      killed.push({ pid, signal });
      return true;
    },
    waitForShutdown: () => ({
      promise: signalPromise,
      dispose: () => {
        disposed += 1;
      },
    }),
    resolveTool: (tool) => resolveTool(tool),
    resolveNodemon: () => '/tools/nodemon.js',
    resolveServeChild: () => '/tools/serve-child.js',
    mkdtemp: (prefix) => {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      tempDirs.push(dir);
      createdDirs.push(dir);
      return dir;
    },
    rmrf: (path) => {
      removed.push(path);
    },
    graceMs: 10,
  };

  return {
    deps,
    spawns,
    killed,
    removed,
    tempDirs,
    signal: () => resolveSignal(),
    disposeCount: () => disposed,
  };
}

/** Capture `console.error` output so tests can assert on actionable messages. */
function captureErrors(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  return {
    errors,
    restore: () => {
      console.error = original;
    },
  };
}

const tick = (): Promise<void> => new Promise((resolveTick) => setTimeout(resolveTick, 0));

async function waitFor(cond: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${message}`);
    }
    await tick();
  }
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

describe('runDev: orchestration', () => {
  it('compiles (tsc then vite), then watches and serves, shutting down on signal', async () => {
    const dir = makeProject({ tsconfig: true, viteConfig: true });
    const h = createHarness();

    const pending = runDev({ cwd: dir }, h.deps);

    // Initial build: tsc first.
    assert.equal(h.spawns.length, 1);
    assert.equal(h.spawns[0]?.command, process.execPath);
    assert.deepEqual(h.spawns[0]?.args, ['/tools/tsc.js', '-p', 'tsconfig.json']);
    h.spawns[0]?.child.exit(0);

    // Then vite.
    await waitFor(() => h.spawns.length === 2, 'the vite initial build to spawn');
    assert.deepEqual(h.spawns[1]?.args, ['/tools/vite.js', 'build']);
    h.spawns[1]?.child.exit(0);

    // Then three watchers: tsc watch, vite watch, nodemon.
    await waitFor(() => h.spawns.length === 5, 'the watchers to spawn');
    assert.deepEqual(h.spawns[2]?.args, [
      '/tools/tsc.js',
      '-p',
      'tsconfig.json',
      '--watch',
      '--preserveWatchOutput',
    ]);
    assert.deepEqual(h.spawns[3]?.args, ['/tools/vite.js', 'build', '--watch']);

    const nodemon = h.spawns[4]!;
    assert.deepEqual(nodemon.args, [
      '/tools/nodemon.js',
      '--exec',
      'node',
      '--signal',
      'SIGTERM',
      '--ext',
      'js,mjs,cjs',
      '--watch',
      dir,
      '--ignore',
      join(dir, 'node_modules'),
      '--ignore',
      join(dir, 'public'),
      '--ignore',
      join(dir, 'out'),
      '--ignore',
      join(dir, '.git'),
      '--no-stdin',
      '/tools/serve-child.js',
    ]);

    // nodemon runs in the private cwd, not the project, as a detached group.
    const privateDir = h.tempDirs[0]!;
    assert.equal(nodemon.options?.cwd, privateDir);
    assert.equal(nodemon.options?.detached, true);

    h.signal();
    const code = await pending;

    assert.equal(code, 0);

    // Only the three watchers remain owned; each gets SIGTERM then SIGKILL.
    const watcherPids = [h.spawns[2].child.pid, h.spawns[3].child.pid, nodemon.child.pid];
    assert.deepEqual(h.killed, [
      { pid: watcherPids[0], signal: 'SIGTERM' },
      { pid: watcherPids[1], signal: 'SIGTERM' },
      { pid: watcherPids[2], signal: 'SIGTERM' },
      { pid: watcherPids[0], signal: 'SIGKILL' },
      { pid: watcherPids[1], signal: 'SIGKILL' },
      { pid: watcherPids[2], signal: 'SIGKILL' },
    ]);

    assert.equal(h.disposeCount(), 1, 'signal listeners disposed exactly once');
    assert.deepEqual(h.removed, [privateDir], 'the private dir is removed');
  });

  it('skips tools whose config files are absent (precompiled app, nodemon only)', async () => {
    const dir = makeProject();
    const h = createHarness();

    const pending = runDev({ cwd: dir }, h.deps);

    await waitFor(() => h.spawns.length === 1, 'nodemon to spawn');
    assert.equal(h.spawns[0]?.command, process.execPath);
    assert.equal(h.spawns[0]?.args[0], '/tools/nodemon.js');

    h.signal();
    assert.equal(await pending, 0);
  });

  it('aborts cleanly when a signal arrives during the initial build', async () => {
    const dir = makeProject({ tsconfig: true });
    const h = createHarness();

    const pending = runDev({ cwd: dir }, h.deps);

    // The tsc build is still running when the signal lands.
    assert.equal(h.spawns.length, 1);
    const build = h.spawns[0]!.child;
    h.signal();
    const code = await pending;

    assert.equal(code, 0);
    // The in-flight build is still owned and torn down.
    assert.deepEqual(h.killed, [
      { pid: build.pid, signal: 'SIGTERM' },
      { pid: build.pid, signal: 'SIGKILL' },
    ]);
    assert.equal(h.disposeCount(), 1);
    assert.deepEqual(h.removed, [h.tempDirs[0]]);
  });

  it('returns the build exit code when the initial build fails', async () => {
    const dir = makeProject({ tsconfig: true });
    const h = createHarness();

    const cap = captureErrors();
    let code: number;
    try {
      const pending = runDev({ cwd: dir }, h.deps);
      h.spawns[0]!.child.exit(2);
      code = await pending;
    } finally {
      cap.restore();
    }

    assert.equal(code, 2);
    assert.ok(cap.errors.some((e) => e.includes('initial build failed')));
    // The failed build already exited, so nothing is left to tear down.
    assert.equal(h.killed.length, 0);
    assert.equal(h.disposeCount(), 1);
    assert.deepEqual(h.removed, [h.tempDirs[0]]);
  });

  it('reports and exits non-zero when a watcher dies unexpectedly', async () => {
    const dir = makeProject({ tsconfig: true });
    const h = createHarness();

    const cap = captureErrors();
    let code: number;
    try {
      const pending = runDev({ cwd: dir }, h.deps);
      h.spawns[0]!.child.exit(0); // tsc build succeeds
      await waitFor(() => h.spawns.length === 3, 'the watchers to spawn');

      h.spawns[1]!.child.exit(1); // the tsc watcher dies
      code = await pending;
    } finally {
      cap.restore();
    }

    assert.equal(code, 1);
    assert.ok(cap.errors.some((e) => e.includes('the tsc watcher exited unexpectedly')));
    assert.equal(h.disposeCount(), 1);
  });
});

// ---------------------------------------------------------------------------
// missing tool bins
// ---------------------------------------------------------------------------

describe('runDev: missing tool bins', () => {
  it('errors with an install hint when tsconfig.json has no TypeScript', async () => {
    const dir = makeProject({ tsconfig: true });
    const h = createHarness({
      resolveTool: (tool) => (tool === 'tsc' ? undefined : '/tools/vite.js'),
    });

    const cap = captureErrors();
    let code: number;
    try {
      code = await runDev({ cwd: dir }, h.deps);
    } finally {
      cap.restore();
    }

    assert.equal(code, 1);
    assert.ok(cap.errors.some((e) => e.includes('run npm install')));
    assert.equal(h.spawns.length, 0, 'no process was spawned');
    assert.equal(h.disposeCount(), 0, 'no signal handler installed');
    assert.equal(h.tempDirs.length, 0, 'no temp dir created');
  });

  it('errors with an install hint when a Vite config has no Vite', async () => {
    const dir = makeProject({ viteConfig: true });
    const h = createHarness({
      resolveTool: (tool) => (tool === 'vite' ? undefined : '/tools/tsc.js'),
    });

    const cap = captureErrors();
    let code: number;
    try {
      code = await runDev({ cwd: dir }, h.deps);
    } finally {
      cap.restore();
    }

    assert.equal(code, 1);
    assert.ok(cap.errors.some((e) => e.includes('run npm install')));
    assert.equal(h.spawns.length, 0);
    assert.equal(h.disposeCount(), 0);
    assert.equal(h.tempDirs.length, 0);
  });
});

// ---------------------------------------------------------------------------
// nodemon environment isolation
// ---------------------------------------------------------------------------

describe('runDev: nodemon environment', () => {
  it('isolates HOME but preserves the real HOME and the requested config path', async () => {
    const dir = makeProject({ tsconfig: true });
    const h = createHarness();

    const originalHome = process.env.HOME;
    const originalHomePath = process.env.HOMEPATH;
    process.env.HOME = '/real/home';
    delete process.env.HOMEPATH;
    try {
      const pending = runDev({ cwd: dir, configPath: 'custom.app.js' }, h.deps);
      h.spawns[0]!.child.exit(0);
      await waitFor(() => h.spawns.length === 3, 'the watchers to spawn');

      const env = h.spawns[2]!.options?.env;
      const privateDir = h.tempDirs[0]!;
      assert.equal(env?.HOME, privateDir);
      assert.equal(env?.HOMEPATH, privateDir);
      assert.equal(env?.[DEV_REAL_HOME_ENV], '/real/home');
      assert.equal(env?.[DEV_REAL_HOMEPATH_ENV], undefined, 'no real HOMEPATH to preserve');
      assert.equal(env?.[DEV_CWD_ENV], dir);
      assert.equal(env?.[DEV_CONFIG_ENV], resolve(dir, 'custom.app.js'));

      h.signal();
      assert.equal(await pending, 0);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalHomePath === undefined) delete process.env.HOMEPATH;
      else process.env.HOMEPATH = originalHomePath;
    }
  });

  it('defaults the config path to jsails.app.js when none is requested', async () => {
    const dir = makeProject({ tsconfig: true });
    const h = createHarness();

    const pending = runDev({ cwd: dir }, h.deps);
    h.spawns[0]!.child.exit(0);
    await waitFor(() => h.spawns.length === 3, 'the watchers to spawn');

    assert.equal(h.spawns[2]!.options?.env?.[DEV_CONFIG_ENV], resolve(dir, 'jsails.app.js'));

    h.signal();
    assert.equal(await pending, 0);
  });
});

// ---------------------------------------------------------------------------
// serve-child: NODE_ENV defaulting
// ---------------------------------------------------------------------------

describe('serve-child: NODE_ENV defaulting', () => {
  it('defaults NODE_ENV to development only when it is unset', () => {
    const env: NodeJS.ProcessEnv = {};
    applyDefaultNodeEnv(env);
    assert.equal(env.NODE_ENV, 'development');
  });

  it('preserves an explicitly provided NODE_ENV', () => {
    for (const value of ['development', 'test', 'staging', 'production']) {
      const env: NodeJS.ProcessEnv = { NODE_ENV: value };
      applyDefaultNodeEnv(env);
      assert.equal(env.NODE_ENV, value);
    }
  });

  it('never mutates the parent process environment', () => {
    const original = process.env.NODE_ENV;
    const env: NodeJS.ProcessEnv = {};
    applyDefaultNodeEnv(env);
    assert.equal(process.env.NODE_ENV, original);
  });
});

// ---------------------------------------------------------------------------
// serve-child guard: a deleted project directory fails controlled
// ---------------------------------------------------------------------------

describe('serve-child: guard against a deleted project directory', () => {
  it('fails controlled instead of throwing an unhandled stack', () => {
    const serveChild = fileURLToPath(new URL('../../src/dev/serve-child.js', import.meta.url));
    const missingDir = join(tmpdir(), `jsails-dev-missing-${process.pid}`);

    const result = spawnSync(process.execPath, [serveChild], {
      env: { ...process.env, [DEV_CWD_ENV]: missingDir, [DEV_CONFIG_ENV]: 'jsails.app.js' },
      encoding: 'utf8',
    });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /jsails dev:/, 'a controlled message is printed');
    assert.doesNotMatch(result.stderr, /ENOENT/, 'no raw errno leaks to stderr');
    assert.doesNotMatch(result.stderr, /at process\.chdir/, 'no unhandled stack trace');
  });
});
