/**
 * Owned process-tree teardown shared by the dev runtime and the `create`
 * install step.
 *
 * Every child these surfaces start is spawned detached, so it leads its own
 * process group/tree. Teardown must terminate that group — and only that group
 * — never the caller's session or unrelated processes.
 *
 * On POSIX a detached child leads a process group, so `process.kill(-pid,
 * signal)` signals the whole group and nothing else. On Windows `process.kill`
 * cannot target a tree, so the group is force-terminated with the well-known
 * `taskkill.exe /PID <pid> /T /F`. `taskkill.exe` is resolved from `SystemRoot`
 * (a Windows-provided environment variable), never the `PATH` and never a
 * shell, and its argv is fixed — no user input is interpolated into it. Windows
 * teardown is therefore a hard kill, not a graceful signal, and no
 * graceful-shutdown claim is made for it.
 *
 * An already-exited PID is never an error: POSIX swallows the `ESRCH` from a
 * vanished group, and `taskkill.exe` reports "not found" as a normal non-zero
 * exit rather than a spawn failure.
 */

import { spawn as spawnProcess } from 'node:child_process';
import { win32 } from 'node:path';

/** The minimal child surface the tree kill needs (for test injection). */
export interface TreeKillChild {
  once(event: 'error', listener: () => void): void;
}

/** Spawn options for the Windows `taskkill.exe` call. */
interface TreeKillSpawnOptions {
  readonly detached?: boolean;
  readonly stdio?: 'ignore';
  readonly shell: false;
}

/** The spawn surface the tree kill needs (for test injection). */
export interface TreeKillSpawn {
  (command: string, args: readonly string[], options: TreeKillSpawnOptions): TreeKillChild;
}

/** Dependencies for {@link killOwnedProcessTree}, injectable for tests. */
interface OwnedProcessTreeDeps {
  readonly platform: NodeJS.Platform;
  readonly spawn: TreeKillSpawn;
  /** Windows `SystemRoot`; falls back to a well-known default when unset. */
  readonly systemRoot?: string | undefined;
}

/** Spawn `taskkill.exe` with a fixed argv; never a shell, never the PATH. */
function defaultSpawn(
  command: string,
  args: readonly string[],
  options: TreeKillSpawnOptions,
): TreeKillChild {
  return spawnProcess(command, [...args], {
    detached: options.detached ?? true,
    stdio: options.stdio ?? 'ignore',
    shell: options.shell,
  });
}

const defaultDeps: OwnedProcessTreeDeps = {
  platform: process.platform,
  spawn: defaultSpawn,
  systemRoot: process.env.SystemRoot,
};

/** The `taskkill.exe` location on Windows, resolved from `SystemRoot`. */
function taskkillPath(systemRoot: string | undefined): string {
  const root = (systemRoot ?? '').trim() || 'C:\\Windows';
  return win32.join(root, 'System32', 'taskkill.exe');
}

/**
 * Best-effort terminate of the process tree led by `pid`, never throwing.
 * Returns `true` when a teardown was issued, `false` when the PID was already
 * gone.
 */
export function killOwnedProcessTree(
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM',
  deps: OwnedProcessTreeDeps = defaultDeps,
): boolean {
  if (deps.platform === 'win32') {
    const child = deps.spawn(taskkillPath(deps.systemRoot), ['/PID', String(pid), '/T', '/F'], {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    // A missing `taskkill.exe` must surface as an 'error' event, never an
    // unhandled rejection; the teardown itself is fire-and-forget.
    child.once('error', () => {});
    return true;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}
