/**
 * `create`: generate the starter file set, write it into the target directory,
 * and optionally run `npm install`. The name is derived from the directory
 * basename when `--name` is absent; nothing is installed unless `--install` is
 * given. A failed install propagates its exit code while the generated project
 * is kept, so the user can retry without losing the scaffold.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { basename, win32 } from 'node:path';

import { writeProjectFiles } from '../app/scaffold.js';
import { createStarterFiles } from '../app/starter/index.js';
import { killOwnedProcessTree } from './owned-process-tree.js';

import { waitForShutdownSignal, type ShutdownSignal } from './shutdown.js';

/** npm name the starter uses when a directory basename yields none. */
const DEFAULT_PACKAGE_NAME = 'jsails-app';

/** Longest name npm accepts for a new package. */
const MAX_PACKAGE_NAME_LENGTH = 214;

/**
 * Derive a valid npm package name from a directory basename: lowercase, keep
 * only the characters npm allows in an unscoped name, and drop a leading `.`
 * or `_`. A basename that yields nothing usable falls back to
 * {@link DEFAULT_PACKAGE_NAME}.
 */
function derivePackageName(dirName: string): string {
  let name = dirName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._]+/, '');
  if (!/^[a-z0-9]/.test(name)) {
    return DEFAULT_PACKAGE_NAME;
  }
  if (name.length > MAX_PACKAGE_NAME_LENGTH) {
    name = name.slice(0, MAX_PACKAGE_NAME_LENGTH);
  }
  return name;
}

/** Dependency seam for the `create` command's optional install step. */
export interface CreateDeps {
  /** Run `npm install` inside `cwd`; resolves to its process exit code. */
  install?(cwd: string): Promise<number>;
}

/** Options for {@link runCreateCommand}. */
export interface CreateOptions {
  /** npm package name; derived from the directory basename when absent. */
  readonly name?: string;
  /** `jsails` dependency specifier (e.g. `file:../jsails`). */
  readonly jsailsDependency?: string;
  /** Whether to run `npm install` inside the created project. */
  readonly install: boolean;
  /** Include the admin panel (the default starter is auth-only). */
  readonly admin: boolean;
  /** Include the first-party blog plugin and pages (implies `admin`). */
  readonly blog: boolean;
  /** Scaffold the CLI-only starter instead of the web starter (default false). */
  readonly cli?: boolean;
  /** Scaffold the static-site (SSG) starter instead of the web starter (default false). */
  readonly static?: boolean;
}

/** Terminate the owned process tree a detached child leads, best effort. */
function killChildGroup(child: ChildProcess | undefined): void {
  if (child === undefined || child.pid === undefined) {
    return;
  }
  killOwnedProcessTree(child.pid, 'SIGTERM');
}

/**
 * The npm-install spawn for the given platform. On Windows `npm` resolves to
 * `npm.cmd`, which Node refuses to spawn with `shell: false` (CVE-2024-27980),
 * so the install is invoked through `cmd.exe /d /s /c npm install` with a
 * fixed, non-interpolated command string. On POSIX `npm` is a shebang script
 * spawnable directly. No user-controlled shell is ever involved.
 *
 * Exported for the focused arg-assembly test; the real spawn happens in
 * {@link defaultInstallDependencies}.
 */
export function npmInstallSpawn(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    return {
      command: windowsCmdPath(env),
      args: ['/d', '/s', '/c', 'npm install'],
    };
  }
  return { command: 'npm', args: ['install'] };
}

/**
 * `cmd.exe` on Windows, resolved from the canonical `ComSpec` environment
 * variable (never the `PATH`, never a shell), falling back to a well-known
 * `SystemRoot` location when `ComSpec` is unset.
 */
function windowsCmdPath(env: NodeJS.ProcessEnv): string {
  const comspec = env.ComSpec;
  if (comspec !== undefined && comspec.trim() !== '') {
    return comspec;
  }
  const root = (env.SystemRoot ?? '').trim() || 'C:\\Windows';
  return win32.join(root, 'System32', 'cmd.exe');
}

/**
 * Run `npm install` inside `cwd` with a static argument array and no shell. The
 * child runs detached in its own process group so a SIGINT/SIGTERM interrupts
 * it without orphaning it: on a signal the group is terminated and the install
 * reports failure.
 */
function defaultInstallDependencies(cwd: string): Promise<number> {
  return new Promise<number>((resolve) => {
    let signal: ShutdownSignal | undefined;
    let settled = false;
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      signal?.dispose();
      resolve(code);
    };

    const { command, args } = npmInstallSpawn(process.platform, process.env);
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
      detached: true,
    });
    child.once('error', () => settle(1));
    child.once('exit', (code) => settle(code ?? 1));

    signal = waitForShutdownSignal();
    void signal.promise.then(() => {
      killChildGroup(child);
      settle(1);
    });
  });
}

const defaultCreateDeps: CreateDeps = {
  install: defaultInstallDependencies,
};

/** Print the created-project summary and the commands to run next. */
function printCreateResult(
  name: string,
  targetDir: string,
  installed: boolean,
  variant: 'web' | 'cli' | 'static',
): void {
  console.log(`Created ${name} in ${targetDir}.`);
  console.log('Next steps:');
  if (!installed) {
    console.log('  npm install');
  }
  if (variant === 'cli') {
    console.log('  npm run build');
    console.log('  npx jsails hello');
    console.log('  npx jsails about');
  } else if (variant === 'static') {
    console.log('  npm run build');
    console.log('  # deploy the generated out/ directory to any static host');
  } else {
    console.log('  npm run dev');
    console.log('  npm run build');
  }
}

/**
 * `create`: generate the starter file set, write it into the target directory,
 * and optionally run `npm install`. The name is derived from the directory
 * basename when `--name` is absent; nothing is installed unless `--install` is
 * given. A failed install propagates its exit code while the generated project
 * is kept, so the user can retry without losing the scaffold.
 */
export async function runCreateCommand(
  targetDir: string,
  options: CreateOptions,
  deps: CreateDeps = defaultCreateDeps,
): Promise<number> {
  const name = options.name ?? derivePackageName(basename(targetDir));
  const starterOptions = {
    name,
    ...(options.jsailsDependency === undefined
      ? {}
      : { jsailsDependency: options.jsailsDependency }),
    admin: options.admin,
    blog: options.blog,
    cli: options.cli === true,
    static: options.static === true,
  };
  const { files } = await createStarterFiles(starterOptions);
  const written = await writeProjectFiles(targetDir, files);
  const variant = options.cli === true ? 'cli' : options.static === true ? 'static' : 'web';

  if (!options.install) {
    printCreateResult(name, written.targetDir, false, variant);
    return 0;
  }

  const installCode = await (deps.install ?? defaultInstallDependencies)(written.targetDir);
  if (installCode !== 0) {
    console.error(
      `jsails: npm install failed (exit ${installCode}); the generated project was kept`,
    );
    console.error(`Run "npm install" inside ${written.targetDir} to retry.`);
    return installCode;
  }
  printCreateResult(name, written.targetDir, true, variant);
  return 0;
}
