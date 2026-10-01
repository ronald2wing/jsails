/**
 * CLI-internal development runtime: compile, watch, and serve one app.
 *
 * `runDev` orchestrates the toolchain around a JSails app:
 *
 * 1. An initial build runs `tsc -p tsconfig.json` (only when `tsconfig.json` is
 *    present) and `vite build` (only when a `vite.config.*` file is present).
 *    Each tool binary is resolved from the project's own `node_modules` through
 *    Node's module resolution — never `npx`, never the shell `PATH`. A tool
 *    whose config file is absent is skipped, so a precompiled app (no
 *    TypeScript, no Vite) still works; a tool whose config file is present but
 *    whose binary is missing is an error telling the user to run `npm install`.
 * 2. Once the initial build succeeds, the same tools are restarted in watch
 *    mode (`tsc --watch --preserveWatchOutput`, `vite build --watch`) and the
 *    app is served through nodemon (a framework dependency), which restarts
 *    `serve` whenever compiled JS or the app config changes.
 *
 * nodemon is driven with `--exec node` and the serve-child script as its first
 * positional argument so it `fork`s the child instead of running a shell
 * command. The serve-child (`./serve-child.js`) chdirs back to the project and
 * reads the app config path from the environment, so neither the config path
 * nor the project path is ever shell-interpolated.
 *
 * Every child runs in its own detached process group. `runDev` owns them all
 * and tears them down — bounded SIGTERM grace then SIGKILL — on SIGINT/SIGTERM,
 * a failed or aborted initial build, or an unexpected watcher exit. Only the
 * process groups created here are signalled, never the caller's session. The
 * SIGTERM/SIGKILL pass is a graceful signal on POSIX; on Windows the owned
 * trees are force-terminated (`taskkill.exe /T /F`), so no graceful-shutdown
 * claim is made there.
 */

import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_APP_CONFIG_PATH } from '../app/config.js';
import { killOwnedProcessTree } from '../cli/owned-process-tree.js';
import type { ShutdownSignal } from '../cli.js';

/** Environment variable carrying the project cwd into the serve child. */
export const DEV_CWD_ENV = 'JSAILS_DEV_CWD';
/** Environment variable carrying the app config path into the serve child. */
export const DEV_CONFIG_ENV = 'JSAILS_DEV_CONFIG';
/** Environment variable carrying the real HOME so the app can restore it. */
export const DEV_REAL_HOME_ENV = 'JSAILS_DEV_REAL_HOME';
/** Environment variable carrying the real HOMEPATH so the app can restore it. */
export const DEV_REAL_HOMEPATH_ENV = 'JSAILS_DEV_REAL_HOMEPATH';

/** Vite config filenames probed for in the project root. */
const VITE_CONFIG_FILES = [
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'vite.config.cjs',
  'vite.config.mts',
  'vite.config.cts',
] as const;

/**
 * Grace period between the SIGTERM and the SIGKILL pass when tearing children
 * down. At least the app's default shutdown timeout so the serve child has time
 * to close its own transport cleanly.
 */
const SHUTDOWN_GRACE_MS = 5000;

/** Nodemon extensions monitored, matching compiled JS plus the app config. */
const NODEMON_EXTENSIONS = 'js,mjs,cjs';

/** Options for {@link runDev}. */
export interface DevOptions {
  /** App config module, resolved against `cwd`. Defaults to `jsails.app.js`. */
  readonly configPath?: string;
  /** Project root. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

/** A minimal child-process handle returned by {@link DevDeps.spawn}. */
export interface DevChild {
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  on(event: 'exit' | 'error', listener: (...args: any[]) => void): void;
  once(event: 'exit' | 'error', listener: (...args: any[]) => void): void;
  removeListener(event: 'exit' | 'error', listener: (...args: any[]) => void): void;
}

/** Options accepted by {@link DevDeps.spawn}. */
export interface DevSpawnOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly detached?: boolean;
  readonly stdio?: unknown;
}

/**
 * Dependency seam for {@link runDev}. Tests inject fakes so no real compiler,
 * Vite, or nodemon process is started; the defaults are the real factories.
 */
export interface DevDeps {
  /** Spawn a child process; defaults to `node:child_process.spawn`. */
  spawn(command: string, args: readonly string[], options?: DevSpawnOptions): DevChild;
  /** Terminate the owned process tree `pid` leads; defaults to the platform-aware kill. */
  killGroup(pid: number, signal: NodeJS.Signals): boolean;
  /** Install SIGINT/SIGTERM handlers that resolve on the first signal. */
  waitForShutdown(): ShutdownSignal;
  /** Resolve a project tool (`tsc`/`vite`) to its absolute JS entry, or `undefined`. */
  resolveTool(tool: 'tsc' | 'vite', cwd: string): string | undefined;
  /** Resolve the nodemon binary (a framework dependency). */
  resolveNodemon(): string;
  /** Resolve the serve-child entry module. */
  resolveServeChild(): string;
  /** Create the private nodemon working directory. */
  mkdtemp(prefix: string): string;
  /** Remove a directory recursively. */
  rmrf(path: string): void;
  /** SIGTERM-to-SIGKILL grace, defaulting to {@link SHUTDOWN_GRACE_MS}. */
  readonly graceMs?: number;
}

/** One completed (or aborted) initial build step. */
type BuildOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'failed'; readonly code: number }
  | { readonly kind: 'aborted' };

const require = createRequire(import.meta.url);

/** The real `child_process.spawn` adapter, always detached with inherited stdio. */
function defaultSpawn(
  command: string,
  args: readonly string[],
  options: DevSpawnOptions = {},
): DevChild {
  const child = spawnProcess(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached ?? true,
    stdio: (options.stdio ?? 'inherit') as 'inherit',
    shell: false,
  });
  return adaptChild(child);
}

/** Present a `ChildProcess` through the minimal {@link DevChild} surface. */
function adaptChild(child: ChildProcess): DevChild {
  return {
    get pid() {
      return child.pid;
    },
    get exitCode() {
      return child.exitCode;
    },
    on(event, listener) {
      child.on(event, listener);
    },
    once(event, listener) {
      child.once(event, listener);
    },
    removeListener(event, listener) {
      child.removeListener(event, listener);
    },
  };
}

/** Terminate the owned process tree `pid` leads, swallowing a vanished group. */
function defaultKillGroup(pid: number, signal: NodeJS.Signals): boolean {
  return killOwnedProcessTree(pid, signal);
}

/** Install SIGINT/SIGTERM handlers that resolve on the first signal. */
function waitForShutdownSignal(): ShutdownSignal {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  const listeners: Array<[NodeJS.Signals, () => void]> = [];
  for (const signal of signals) {
    const listener = () => resolvePromise();
    process.on(signal, listener);
    listeners.push([signal, listener]);
  }
  let disposed = false;
  return {
    promise,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [signal, listener] of listeners) {
        process.removeListener(signal, listener);
      }
    },
  };
}

/** Read a package's `bin` map and return the requested entry, or `undefined`. */
function binEntry(bin: unknown, binName: string): string | undefined {
  if (typeof bin === 'string') return bin;
  if (bin !== null && typeof bin === 'object' && !Array.isArray(bin)) {
    const value = (bin as Record<string, unknown>)[binName];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/** Resolve a project tool's bin from the project's own `node_modules`. */
function defaultResolveTool(tool: 'tsc' | 'vite', cwd: string): string | undefined {
  const packageName = tool === 'tsc' ? 'typescript' : 'vite';
  try {
    const pkgJsonPath = require.resolve(`${packageName}/package.json`, {
      paths: [cwd],
    });
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
      bin?: unknown;
    };
    const entry = binEntry(pkg.bin, tool);
    return entry === undefined ? undefined : resolve(dirname(pkgJsonPath), entry);
  } catch {
    return undefined;
  }
}

/** Resolve the nodemon binary from the framework's own `node_modules`. */
function defaultResolveNodemon(): string {
  const pkgJsonPath = require.resolve('nodemon/package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
    bin?: unknown;
  };
  const entry = binEntry(pkg.bin, 'nodemon');
  if (entry === undefined) {
    throw new Error('the installed nodemon package declares no "nodemon" binary');
  }
  return resolve(dirname(pkgJsonPath), entry);
}

/** Resolve the serve-child entry next to this module. */
function defaultResolveServeChild(): string {
  return fileURLToPath(new URL('./serve-child.js', import.meta.url));
}

/** Create a private directory under the OS temp dir for the nodemon watcher. */
function defaultMkdtemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Remove a directory recursively, ignoring a missing path. */
function defaultRmrf(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

const defaultDevDeps: DevDeps = {
  spawn: defaultSpawn,
  killGroup: defaultKillGroup,
  waitForShutdown: waitForShutdownSignal,
  resolveTool: defaultResolveTool,
  resolveNodemon: defaultResolveNodemon,
  resolveServeChild: defaultResolveServeChild,
  mkdtemp: defaultMkdtemp,
  rmrf: defaultRmrf,
};

/**
 * Run the development toolchain to completion. Resolves `0` on a clean
 * signal-initiated shutdown, or a non-zero exit code on failure. The caller
 * owns printing the result; this function prints its own actionable errors.
 */
export async function runDev(
  options: DevOptions = {},
  deps: Partial<DevDeps> = {},
): Promise<number> {
  const d: DevDeps = { ...defaultDevDeps, ...deps };

  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(cwd, options.configPath ?? DEFAULT_APP_CONFIG_PATH);

  const hasTsconfig = existsSync(join(cwd, 'tsconfig.json'));
  const hasViteConfig = VITE_CONFIG_FILES.some((name) => existsSync(join(cwd, name)));

  const tscBin = hasTsconfig ? d.resolveTool('tsc', cwd) : undefined;
  if (hasTsconfig && tscBin === undefined) {
    console.error(
      'jsails dev: tsconfig.json is present but TypeScript is not installed; run npm install',
    );
    return 1;
  }
  const viteBin = hasViteConfig ? d.resolveTool('vite', cwd) : undefined;
  if (hasViteConfig && viteBin === undefined) {
    console.error(
      'jsails dev: a Vite config is present but Vite is not installed; run npm install',
    );
    return 1;
  }

  const nodemonBin = d.resolveNodemon();
  const serveChild = d.resolveServeChild();
  const privateDir = d.mkdtemp('jsails-dev-');

  const signal = d.waitForShutdown();
  const running = new Set<DevChild>();

  try {
    const build = await buildInitial(d, running, { tscBin, viteBin }, cwd, signal);
    if (build.kind === 'aborted') {
      return 0;
    }
    if (build.kind === 'failed') {
      console.error('jsails dev: the initial build failed');
      return build.code;
    }

    const watchers: Array<{ name: string; child: DevChild }> = [];
    if (tscBin !== undefined) {
      watchers.push({
        name: 'tsc',
        child: spawnTracked(
          d,
          running,
          process.execPath,
          [tscBin, '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'],
          { cwd },
        ),
      });
    }
    if (viteBin !== undefined) {
      watchers.push({
        name: 'vite',
        child: spawnTracked(d, running, process.execPath, [viteBin, 'build', '--watch'], { cwd }),
      });
    }
    const nodemonChild = spawnTracked(
      d,
      running,
      process.execPath,
      [nodemonBin, ...nodemonArgs(cwd, serveChild)],
      {
        cwd: privateDir,
        env: nodemonEnv(cwd, configPath, privateDir),
      },
    );
    watchers.push({ name: 'nodemon', child: nodemonChild });

    console.log(
      'Dev server ready. No hot module reload — reload your browser manually after changes.',
    );

    const outcome = await Promise.race([
      signal.promise.then(() => 'signal' as const),
      unexpectedWatcherExit(watchers),
    ]);

    if (outcome === 'signal') {
      return 0;
    }
    console.error(`jsails dev: the ${outcome} watcher exited unexpectedly`);
    return 1;
  } finally {
    signal.dispose();
    await shutdownAll(d, running, d.graceMs ?? SHUTDOWN_GRACE_MS);
    d.rmrf(privateDir);
  }
}

/**
 * Run the one-shot initial build steps in order (tsc, then Vite), returning the
 * first non-ok outcome. An aborted step means a shutdown signal arrived while a
 * build was still running; the child stays in `running` so `shutdownAll` kills it.
 */
async function buildInitial(
  d: DevDeps,
  running: Set<DevChild>,
  tools: {
    readonly tscBin: string | undefined;
    readonly viteBin: string | undefined;
  },
  cwd: string,
  signal: ShutdownSignal,
): Promise<BuildOutcome> {
  if (tools.tscBin !== undefined) {
    const outcome = await buildOnce(
      d,
      running,
      process.execPath,
      [tools.tscBin, '-p', 'tsconfig.json'],
      cwd,
      signal,
    );
    if (outcome.kind !== 'ok') return outcome;
  }
  if (tools.viteBin !== undefined) {
    const outcome = await buildOnce(
      d,
      running,
      process.execPath,
      [tools.viteBin, 'build'],
      cwd,
      signal,
    );
    if (outcome.kind !== 'ok') return outcome;
  }
  return { kind: 'ok' };
}

/** Run one one-shot build step, resolving on exit, spawn error, or shutdown signal. */
function buildOnce(
  d: DevDeps,
  running: Set<DevChild>,
  command: string,
  args: string[],
  cwd: string,
  signal: ShutdownSignal,
): Promise<BuildOutcome> {
  const child = spawnTracked(d, running, command, args, { cwd });
  return new Promise<BuildOutcome>((resolveOutcome) => {
    let settled = false;
    const settle = (outcome: BuildOutcome): void => {
      if (settled) return;
      settled = true;
      resolveOutcome(outcome);
    };
    child.once('exit', (code: number | null) =>
      settle(code === 0 ? { kind: 'ok' } : { kind: 'failed', code: code ?? 1 }),
    );
    child.once('error', () => settle({ kind: 'failed', code: 1 }));
    void signal.promise.then(() => settle({ kind: 'aborted' }));
  });
}

/** Spawn a detached child and track it in `running` until it exits or errors. */
function spawnTracked(
  d: DevDeps,
  running: Set<DevChild>,
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
): DevChild {
  const child = d.spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: 'inherit',
  });
  running.add(child);
  child.once('exit', () => running.delete(child));
  child.once('error', () => running.delete(child));
  return child;
}

/** Resolve with the name of the first watcher to exit or error unexpectedly. */
function unexpectedWatcherExit(
  watchers: ReadonlyArray<{ name: string; child: DevChild }>,
): Promise<string> {
  return new Promise<string>((resolveName) => {
    for (const { name, child } of watchers) {
      child.once('exit', () => resolveName(name));
      child.once('error', () => resolveName(name));
    }
  });
}

/** The nodemon argv: fork-safe `node` exec plus watch/ignore and the child. */
function nodemonArgs(cwd: string, serveChild: string): string[] {
  return [
    '--exec',
    'node',
    '--signal',
    'SIGTERM',
    '--ext',
    NODEMON_EXTENSIONS,
    '--watch',
    cwd,
    '--ignore',
    join(cwd, 'node_modules'),
    '--ignore',
    join(cwd, 'public'),
    '--ignore',
    join(cwd, 'out'),
    '--ignore',
    join(cwd, '.git'),
    '--no-stdin',
    serveChild,
  ];
}

/**
 * The nodemon environment: isolate `HOME`/`HOMEPATH` so a global
 * `~/.nodemon.json` is never loaded, and carry the project cwd, the app config
 * path, and the real HOME through to the serve child so the app sees its own
 * environment. The real HOME is passed as a dedicated variable, never written
 * to a file, and the whole `process.env` is inherited normally.
 */
function nodemonEnv(cwd: string, configPath: string, privateDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: privateDir,
    HOMEPATH: privateDir,
    [DEV_CWD_ENV]: cwd,
    [DEV_CONFIG_ENV]: configPath,
  };
  if (process.env.HOME !== undefined) {
    env[DEV_REAL_HOME_ENV] = process.env.HOME;
  }
  if (process.env.HOMEPATH !== undefined) {
    env[DEV_REAL_HOMEPATH_ENV] = process.env.HOMEPATH;
  }
  return env;
}

/** SIGTERM every owned group, wait the grace period, then SIGKILL stragglers. */
async function shutdownAll(d: DevDeps, running: Set<DevChild>, graceMs: number): Promise<void> {
  for (const child of [...running]) {
    if (child.pid !== undefined) {
      d.killGroup(child.pid, 'SIGTERM');
    }
  }
  await waitForRunningEmpty(running, graceMs);
  for (const child of [...running]) {
    if (child.pid !== undefined) {
      d.killGroup(child.pid, 'SIGKILL');
    }
  }
}

/** Resolve when `running` is empty or the grace period elapses, whichever first. */
function waitForRunningEmpty(running: Set<DevChild>, timeoutMs: number): Promise<void> {
  return new Promise((resolveWait) => {
    if (running.size === 0) {
      resolveWait();
      return;
    }
    const interval = setInterval(() => {
      if (running.size === 0) {
        clearInterval(interval);
        clearTimeout(timer);
        resolveWait();
      }
    }, 25);
    const timer = setTimeout(() => {
      clearInterval(interval);
      resolveWait();
    }, timeoutMs);
  });
}
