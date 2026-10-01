/**
 * Jamal production deploy/rollback execution.
 *
 * {@link runDeployExecution} and {@link runRollbackExecution} are the one place
 * jamal actually performs a production release: they acquire the remote deploy
 * lock, run the opt-in pre-build/pre-deploy hooks, drive
 * {@link executeReleaseSteps} over
 * a {@link planProduction} plan, run the post-deploy hook on success, and always
 * release the lock. A failed step surfaces as a value-free
 * {@link DeployExecuteError} (or {@link RollbackError}) naming only the step kind
 * — the image reference, server, health URL, and any command output are never
 * echoed. Recording the success in the local deploy history is the caller's job,
 * not this module's.
 *
 * The module also carries the pure defaults the CLI wires in: a fetch-based
 * {@link createFetchHealthCheck}, the git-derived {@link defaultImageTag}, the
 * {@link deployLockDir}, the process-spawning {@link createProcessHookRunner}
 * and {@link createHooksFilesystem}, and the remote inspection argv builders
 * (`status`/`logs`/`exec`) that reconstruct a container from a recorded tag.
 */

import { accessSync, constants, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

import type { JamalConfig } from '../config.js';
import { acquireLock } from './lock.js';
import { planProduction, type ProductionPlan } from './plan.js';
import { runAccessories, AccessoryError } from './accessories.js';
import {
  executeReleaseSteps,
  type HealthCheck,
  type ReleaseLogger,
  type ReleaseSummary,
} from './release.js';
import { runHookPhase, type HookRunner, type HooksFilesystem } from './hooks.js';
import { type CommandResult, type CommandRunner } from './command-runner.js';
import type { RemoteRunner } from './transport.js';
import type { DeployHistoryEntry } from './history.js';

/** Raised for a failed or malformed deploy; the message is value-free. */
export class DeployExecuteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeployExecuteError';
  }
}

/** Raised for a failed rollback; the message is value-free. */
export class RollbackError extends DeployExecuteError {
  constructor(message: string) {
    super(message);
    this.name = 'RollbackError';
  }
}

/** Control characters plus DEL — never valid in a container name. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** The seams {@link runDeployExecution} injects; never touched in tests. */
export interface DeployExecutionOptions {
  readonly config: JamalConfig;
  readonly imageTag: string;
  readonly previousTag?: string;
  readonly commandRunner: CommandRunner;
  readonly remoteRunner: RemoteRunner;
  readonly healthCheck: HealthCheck;
  readonly hooksFs: HooksFilesystem;
  readonly hookRunner: HookRunner;
  readonly hooksDir?: string;
  readonly cwd?: string;
  readonly logger?: ReleaseLogger;
  /** Delay seam for the accessory health retry loop; defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The outcome of a successful release: the summary plus the history entry to record. */
export interface DeployExecutionResult {
  readonly summary: ReleaseSummary;
  readonly entry: DeployHistoryEntry;
}

/**
 * The deploy lock directory on the remote server for a service. Exported so the
 * CLI's tests can assert where the lock is created.
 */
export function deployLockDir(service: string): string {
  return `/tmp/jamal-deploy-${service}.lock`;
}

/** Poll a health URL until it returns `ok`; each probe is bounded by `timeoutMs`. */
export function createFetchHealthCheck(): HealthCheck {
  return async (url, options) => {
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      let healthy = false;
      try {
        const response = await fetch(url, { signal: controller.signal });
        healthy = response.ok;
      } catch {
        healthy = false;
      } finally {
        clearTimeout(timer);
      }
      if (healthy) {
        return;
      }
      await delay(options.intervalMs);
    }
  };
}

/** Resolve a promise after `ms`; never rejects. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Derive the default image tag: `git rev-parse --short HEAD` in `cwd` when it
 * succeeds with a safe value, else a `YYYYMMDDHHmmss` timestamp. The git output
 * is captured (never streamed), so it can be read back.
 */
export async function defaultImageTag(cwd: string): Promise<string> {
  const hash = await gitShortHash(cwd);
  return hash ?? timestampTag();
}

/** Run `git rev-parse --short HEAD` in `cwd`, resolving `undefined` on any failure. */
function gitShortHash(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(undefined);
        return;
      }
      const tag = stdout.trim();
      resolve(tag !== '' && !/\s/.test(tag) ? tag : undefined);
    });
  });
}

/** A `YYYYMMDDHHmmss` fallback tag, deterministic per second. */
function timestampTag(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** The real filesystem probe for hook scripts: `existsSync` plus an `X_OK` check. */
export function createHooksFilesystem(): HooksFilesystem {
  return {
    exists: (path) => existsSync(path),
    isExecutable: (path) => {
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The default hook runner: spawn the fixed argv with the caller's `cwd` and an
 * environment extended with the hook variables, streaming stdio to the parent.
 */
export function createProcessHookRunner(): HookRunner {
  return (argv, options = {}) =>
    new Promise<CommandResult>((resolve, reject) => {
      const command = argv[0];
      if (command === undefined) {
        reject(new Error('empty hook argv'));
        return;
      }
      const child = spawn(command, argv.slice(1), {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        resolve({ exitCode: code ?? (signal === null ? 0 : 1), stdout: '', stderr: '' });
      });
    });
}

/** Reject a container name that cannot be a safe `docker` argv token, value-free. */
function assertContainerName(container: string): void {
  if (typeof container !== 'string' || container.length === 0) {
    throw new DeployExecuteError('the container name must be a non-empty string');
  }
  if (/\s/.test(container) || CONTROL_CHARS.test(container)) {
    throw new DeployExecuteError(
      'the container name must not contain whitespace or control characters',
    );
  }
  if (container.startsWith('-')) {
    throw new DeployExecuteError('the container name must not start with "-"');
  }
}

/** The remote `status` argv: list every container on the server. */
export function remoteStatusArgv(): readonly string[] {
  return ['docker', 'ps'];
}

/** The remote `logs` argv for a container, with an optional `--follow`. */
export function remoteLogsArgv(container: string, follow: boolean): readonly string[] {
  assertContainerName(container);
  return follow ? ['docker', 'logs', '--follow', container] : ['docker', 'logs', container];
}

/** The remote `exec` argv for a container and a fixed command. */
export function remoteExecArgv(container: string, command: readonly string[]): readonly string[] {
  assertContainerName(container);
  return ['docker', 'exec', container, ...command];
}

/** Shared release flow for deploy and rollback, differing only in the failure label. */
async function executeRelease(
  options: DeployExecutionOptions & { readonly kind: 'deploy' | 'rollback' },
): Promise<DeployExecutionResult> {
  const production = options.config.production;
  if (production === undefined) {
    throw new DeployExecuteError('config.production is required to deploy');
  }
  const plan = planProduction(options.config, {
    imageTag: options.imageTag,
    previousTag: options.previousTag,
  });
  // Accessory steps (backing services) run first and are the app release's own
  // concern; the app-only plan handed to `executeReleaseSteps` must never carry an
  // `accessory` step, which its executor rejects as an unknown kind.
  const accessorySteps = plan.steps.filter((step) => step.kind === 'accessory');
  const appPlan: ProductionPlan = {
    ...plan,
    steps: plan.steps.filter((step) => step.kind !== 'accessory'),
  };
  const server = production.server;
  const lock = await acquireLock(options.remoteRunner, {
    server,
    lockDir: deployLockDir(options.config.service),
  });
  try {
    const hookOptions = {
      server,
      version: options.imageTag,
      fs: options.hooksFs,
      runner: options.hookRunner,
      hooksDir: options.hooksDir,
      cwd: options.cwd,
    };
    await runHookPhase({ ...hookOptions, phase: 'pre-build' });
    await runHookPhase({ ...hookOptions, phase: 'pre-deploy' });
    try {
      await runAccessories(accessorySteps, {
        remoteRunner: options.remoteRunner,
        logger: options.logger,
        sleep: options.sleep,
      });
    } catch (error) {
      if (error instanceof AccessoryError) {
        const message = `${options.kind} failed at accessory step "${error.action}"`;
        throw options.kind === 'rollback'
          ? new RollbackError(message)
          : new DeployExecuteError(message);
      }
      throw error;
    }
    const summary = await executeReleaseSteps(appPlan, {
      commandRunner: options.commandRunner,
      remoteRunner: options.remoteRunner,
      healthCheck: options.healthCheck,
      logger: options.logger,
    });
    if (summary.failedStep !== undefined) {
      const message = `${options.kind} failed at step "${summary.failedStep.kind}"`;
      throw options.kind === 'rollback'
        ? new RollbackError(message)
        : new DeployExecuteError(message);
    }
    await runHookPhase({ ...hookOptions, phase: 'post-deploy' });
    return {
      summary,
      entry: {
        service: options.config.service,
        tag: options.imageTag,
        timestamp: new Date().toISOString(),
      },
    };
  } finally {
    await lock.release().catch(() => {
      // A lock that fails to release is left on the server and surfaces as
      // contention on the next deploy, never as a failure of this one; the
      // operator clears it by hand.
    });
  }
}

/**
 * Run a full production deploy for `options.imageTag` (stopping the container
 * at `options.previousTag` when given). Returns the release summary plus the
 * history entry to record; the caller owns writing it.
 */
export function runDeployExecution(
  options: DeployExecutionOptions,
): Promise<DeployExecutionResult> {
  return executeRelease({ ...options, kind: 'deploy' });
}

/**
 * Run a production rollback: deploy `options.imageTag` (the prior release) and
 * stop the container at `options.previousTag` (the current release). The flow is
 * identical to a deploy — the caller derives the two tags from deploy history —
 * but a failed step raises a {@link RollbackError}.
 */
export function runRollbackExecution(
  options: DeployExecutionOptions,
): Promise<DeployExecutionResult> {
  return executeRelease({ ...options, kind: 'rollback' });
}
