/**
 * Deployment hooks for jamal production releases.
 *
 * {@link runHookPhase} runs an optional, user-owned script for one phase
 * (`pre-build`, `pre-deploy`, or `post-deploy`) from a hooks directory
 * (default `.jamal/hooks`). A phase is skipped silently when its script file
 * is absent or not executable, so hooks stay opt-in; when the script exists and
 * is executable it is run through the injected {@link HookRunner} with the
 * caller's working directory and an environment that carries `JAMAL_SERVER` and
 * `JAMAL_VERSION` on top of the caller-supplied base environment. A non-zero
 * exit raises a {@link HooksError} that names only the phase and the exit code
 * — the script path and its output are never surfaced.
 *
 * The filesystem is probed through the injected {@link HooksFilesystem}, and the
 * script is executed through the injected {@link HookRunner}, so a test never
 * touches the real filesystem or spawns a process. This module reads no
 * environment variable and writes no file.
 */

import { join } from 'node:path';

import type { CommandResult } from './command-runner.js';

/** The ordered deployment hook phases. */
type HookPhase = 'pre-build' | 'pre-deploy' | 'post-deploy';

/** All hook phases, in execution order. */
export const HOOK_PHASES: readonly HookPhase[] = ['pre-build', 'pre-deploy', 'post-deploy'];

/** Hooks directory used when the caller does not name one. */
export const DEFAULT_HOOKS_DIR = '.jamal/hooks';

/** Raised when a present hook exits non-zero. Names only the phase and exit code. */
export class HooksError extends Error {
  readonly phase: HookPhase;
  readonly exitCode: number;

  constructor(phase: HookPhase, exitCode: number, message: string) {
    super(message);
    this.name = 'HooksError';
    this.phase = phase;
    this.exitCode = exitCode;
  }
}

/** Minimal filesystem probe for discovering hook scripts. */
export interface HooksFilesystem {
  /** True when `path` exists (as a file or directory). */
  exists(path: string): boolean;
  /** True when `path` exists and is executable by the current user. */
  isExecutable(path: string): boolean;
}

/** Per-run options for a {@link HookRunner}. */
interface HookRunnerOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Run a fixed argv array with a working directory and environment. Unlike the
 * shared {@link CommandRunner}, this seam carries `cwd` and `env` so hook
 * scripts inherit the caller's directory and the `JAMAL_*` variables.
 */
export type HookRunner = (
  argv: readonly string[],
  options?: HookRunnerOptions,
) => Promise<CommandResult>;

/** Options for {@link runHookPhase}. */
interface RunHookOptions {
  /** The phase to run. */
  readonly phase: HookPhase;
  /** Hooks directory; defaults to {@link DEFAULT_HOOKS_DIR}. */
  readonly hooksDir?: string;
  /** The deploy target server, exported as `JAMAL_SERVER`. */
  readonly server: string;
  /** The release version (image tag), exported as `JAMAL_VERSION`. */
  readonly version: string;
  /** Filesystem probe (injected for tests). */
  readonly fs: HooksFilesystem;
  /** Process runner (injected for tests). */
  readonly runner: HookRunner;
  /** Working directory for the script; forwarded to the runner. */
  readonly cwd?: string;
  /** Base environment; `JAMAL_SERVER`/`JAMAL_VERSION` are layered on top. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Outcome of {@link runHookPhase}: the phase and whether its script ran. */
interface HookOutcome {
  readonly phase: HookPhase;
  readonly ran: boolean;
}

/**
 * Run the hook script for `options.phase` if it exists and is executable,
 * skipping silently otherwise. The script path is `<hooksDir>/<phase>`; the
 * runner receives it as a fixed argv with the caller's `cwd` and an environment
 * extended with `JAMAL_SERVER` and `JAMAL_VERSION`. A non-zero exit raises a
 * value-free {@link HooksError}.
 */
export async function runHookPhase(options: RunHookOptions): Promise<HookOutcome> {
  const { phase, server, version, fs, runner } = options;
  const scriptPath = join(options.hooksDir ?? DEFAULT_HOOKS_DIR, phase);

  if (!fs.exists(scriptPath) || !fs.isExecutable(scriptPath)) {
    return { phase, ran: false };
  }

  const env: Record<string, string> = {
    ...(options.env ?? {}),
    JAMAL_SERVER: server,
    JAMAL_VERSION: version,
  };

  const result = await runner([scriptPath], { cwd: options.cwd, env });
  if (result.exitCode !== 0) {
    throw new HooksError(
      phase,
      result.exitCode,
      `${phase} hook exited with code ${result.exitCode}`,
    );
  }
  return { phase, ran: true };
}

// ---------------------------------------------------------------------------
// Dev-time hook planner (S12)
// ---------------------------------------------------------------------------

/** Dev-time hook phases (local dev only; no `pre/post-composer`). */
export type DevHookPhase = 'pre-start' | 'post-start' | 'pre-import-db' | 'post-import-db';

/** A planned dev-time hook: the resolved script path and argv. */
export interface DevHookPlan {
  /** The hook phase. */
  readonly phase: DevHookPhase;
  /** Resolved script path `<hooksDir>/<phase>`. */
  readonly scriptPath: string;
  /** Argv for the hook runner: `[scriptPath]`. */
  readonly argv: readonly string[];
}

/** All valid dev-time hook phases. */
const DEV_HOOK_PHASES: ReadonlySet<string> = new Set([
  'pre-start',
  'post-start',
  'pre-import-db',
  'post-import-db',
]);

/** Raised when a dev hook phase is not recognized. Messages never echo the value. */
export class DevHookError extends Error {
  constructor() {
    super('unknown dev hook phase');
    this.name = 'DevHookError';
  }
}

/**
 * Build a {@link DevHookPlan} for a dev-time hook phase. The script path is
 * resolved to `<hooksDir>/<phase>`; the planner never checks whether the
 * script exists or is executable, and never executes it.
 *
 * @param phase - The dev hook phase.
 * @param hooksDir - Directory containing hook scripts.
 * @throws {@link DevHookError} for an unknown phase.
 */
export function planDevHook(phase: DevHookPhase, hooksDir: string): DevHookPlan {
  if (!DEV_HOOK_PHASES.has(phase)) {
    throw new DevHookError();
  }

  const scriptPath = join(hooksDir, phase);
  return {
    phase,
    scriptPath,
    argv: [scriptPath],
  };
}
