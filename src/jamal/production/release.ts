/**
 * Production release executor for jamal.
 *
 * {@link executeReleaseSteps} drives a {@link ProductionPlan} to completion, one step at
 * a time, through injected seams so it never spawns a process, opens an ssh
 * connection, or performs a real HTTP probe in tests:
 *
 * - `build` and `push` run locally via {@link runBuild}/{@link runPush}.
 * - `pull`, `run`, `stop`, and (when requested) `rollback` run remotely through
 *   the {@link RemoteRunner}, which assembles the `ssh` argv via
 *   {@link sshArgv}. A remote step whose plan argv is absent has nothing to do
 *   (a first deploy has no previous container to stop) and is skipped.
 * - `health` polls through the injected `healthCheck(url, { timeoutMs,
 *   intervalMs })`, which resolves on success and throws on failure.
 * - `switch` executes its argv — the `kamal-proxy deploy` command the plan
 *   supplies when a production domain is set — over ssh via the same remote
 *   executor; otherwise the proxy container switch is deferred and recorded as
 *   a warning.
 *
 * The release stops on the first failure and returns a {@link ReleaseSummary}
 * whose `failedStep` names only the step kind and exit code — the image
 * reference, server, health URL, and any command output are never echoed.
 * Rollback is opt-in via `rollback: true`; it is never performed automatically.
 */

import { BuildError, runBuild, runPush } from './build.js';
import type { ProductionPlan, ProductionStep, ProductionStepKind } from './plan.js';
import { ProcessRunnerError, type CommandResult, type CommandRunner } from './command-runner.js';
import type { RemoteRunner } from './transport.js';

/** Raised for a malformed release setup, not for a step failure. Value-free. */
class ReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseError';
  }
}

/** The health poll timings a {@link HealthCheck} receives. */
interface HealthPollOptions {
  readonly timeoutMs: number;
  readonly intervalMs: number;
}

/** Poll a health URL until it responds, or throw on failure/timeout. */
export type HealthCheck = (url: string, options: HealthPollOptions) => Promise<void>;

/** Delay seam; injected so tests avoid real timers. */
type Sleep = (ms: number) => Promise<void>;

/**
 * Retry policy for the health step. A failed health check is retried — a
 * container that is not ready yet should not fail a release — with a fixed
 * delay between attempts, bounded by a hard attempt cap.
 */
interface HealthRetryOptions {
  /** Number of retries after the first attempt. Defaults to {@link DEFAULT_HEALTH_RETRIES}. */
  readonly retries?: number;
  /** Delay between attempts, in milliseconds. Defaults to {@link DEFAULT_HEALTH_RETRY_DELAY_MS}. */
  readonly delayMs?: number;
  /** Hard cap on total attempts. Defaults to {@link DEFAULT_HEALTH_MAX_ATTEMPTS}. */
  readonly maxAttempts?: number;
}

/** Default retries after the first health-check attempt. */
const DEFAULT_HEALTH_RETRIES = 5;

/** Default delay between health-check attempts, in milliseconds. */
const DEFAULT_HEALTH_RETRY_DELAY_MS = 10_000;

/** Default hard cap on total health-check attempts. */
const DEFAULT_HEALTH_MAX_ATTEMPTS = 15;

/** Optional progress/warning sink; a silent default is used when omitted. */
export interface ReleaseLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** Options for {@link executeReleaseSteps}. */
interface RunReleaseOptions {
  readonly commandRunner: CommandRunner;
  readonly remoteRunner: RemoteRunner;
  readonly healthCheck: HealthCheck;
  readonly logger?: ReleaseLogger;
  /** Execute the rollback step; it is skipped unless exactly `true`. */
  readonly rollback?: boolean;
  /** Retry policy for the health step; defaults applied when omitted. */
  readonly healthRetry?: HealthRetryOptions;
  /** Delay seam for the health retry loop; defaults to `setTimeout`. */
  readonly sleep?: Sleep;
}

/** A failed step: its kind, exit code, and a value-free message. */
interface ReleaseFailure {
  readonly kind: ProductionStepKind;
  readonly exitCode: number;
  readonly message: string;
}

/** The outcome of a release: completed step kinds, an optional failure, warnings. */
export interface ReleaseSummary {
  readonly completed: readonly ProductionStepKind[];
  readonly failedStep?: ReleaseFailure;
  readonly warnings: readonly string[];
}

/** The result of executing one step: completed, skipped, or failed. */
type StepResult =
  | { readonly status: 'completed' }
  | { readonly status: 'skipped' }
  | { readonly status: 'failed'; readonly failure: ReleaseFailure };

const SILENT_LOGGER: ReleaseLogger = { info: () => {}, warn: () => {} };

const EXIT_CODE_PATTERN = /exited with code (\d+)/;

/** Extract the exit code embedded in a value-free {@link BuildError} message. */
function parseExitCode(message: string): number | undefined {
  const match = EXIT_CODE_PATTERN.exec(message);
  return match === null ? undefined : Number(match[1]);
}

/** Map a thrown step error to a value-free {@link ReleaseFailure}. */
function failureFromError(kind: ProductionStepKind, error: unknown): ReleaseFailure {
  if (error instanceof BuildError) {
    return { kind, exitCode: parseExitCode(error.message) ?? 1, message: error.message };
  }
  if (error instanceof ProcessRunnerError) {
    return { kind, exitCode: 1, message: error.message };
  }
  return { kind, exitCode: 1, message: `${kind} failed` };
}

/**
 * Execute a remote (`ssh`-prefixed) or local plan argv and convert a non-zero
 * exit into a value-free failure. An absent argv is a skip for `stop` (nothing
 * to stop) and an error for every other kind.
 */
async function executePlanArgv(
  step: ProductionStep,
  options: RunReleaseOptions,
): Promise<StepResult> {
  const argv = step.argv;
  if (argv === undefined) {
    if (step.kind === 'stop') return { status: 'skipped' };
    throw new ReleaseError('a production step has no argv to execute');
  }

  let result: CommandResult;
  if (argv[0] === 'ssh') {
    const server = argv[1];
    if (server === undefined) {
      throw new ReleaseError('a remote production step has a malformed ssh argv');
    }
    result = await options.remoteRunner.run(server, argv.slice(2));
  } else {
    result = await options.commandRunner(argv);
  }

  if (result.exitCode !== 0) {
    return {
      status: 'failed',
      failure: {
        kind: step.kind,
        exitCode: result.exitCode,
        message: `${step.kind} exited with code ${result.exitCode}`,
      },
    };
  }
  return { status: 'completed' };
}

/** Run the local build/push step through {@link runBuild}/{@link runPush}. */
async function runLocalStep(
  step: ProductionStep,
  imageRef: string,
  commandRunner: CommandRunner,
): Promise<StepResult> {
  try {
    if (step.kind === 'build') {
      await runBuild(imageRef, commandRunner);
    } else {
      await runPush(imageRef, commandRunner);
    }
    return { status: 'completed' };
  } catch (error) {
    return { status: 'failed', failure: failureFromError(step.kind, error) };
  }
}

/** Resolve the health-step retry policy with defaults applied. */
function resolveRetryPolicy(options?: HealthRetryOptions): Required<HealthRetryOptions> {
  return {
    retries: options?.retries ?? DEFAULT_HEALTH_RETRIES,
    delayMs: options?.delayMs ?? DEFAULT_HEALTH_RETRY_DELAY_MS,
    maxAttempts: options?.maxAttempts ?? DEFAULT_HEALTH_MAX_ATTEMPTS,
  };
}

/** The default delay seam: resolve after `ms` via `setTimeout`. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the health step through the injected {@link HealthCheck}, retrying a
 * failed attempt up to the configured policy before declaring the step failed.
 * The budget is `1 + retries` attempts capped by `maxAttempts`; a delay
 * separates attempts so a not-yet-ready container has time to come up.
 */
async function runHealthStep(
  plan: ProductionPlan,
  options: RunReleaseOptions,
): Promise<StepResult> {
  const retry = resolveRetryPolicy(options.healthRetry);
  const sleep = options.sleep ?? defaultSleep;

  const effectiveRetries = plan.healthRetries !== undefined ? plan.healthRetries : retry.retries;
  const effectiveDelayMs =
    plan.healthRetryDelayMs !== undefined ? plan.healthRetryDelayMs : retry.delayMs;
  const maxAttempts = Math.max(1, Math.min(retry.maxAttempts, effectiveRetries + 1));
  const pollOptions: HealthPollOptions = {
    timeoutMs: plan.healthTimeoutMs,
    intervalMs: plan.healthIntervalMs,
  };

  if (plan.healthReadinessDelayMs !== undefined && plan.healthReadinessDelayMs > 0) {
    await sleep(plan.healthReadinessDelayMs);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await options.healthCheck(plan.healthUrl, pollOptions);
      return { status: 'completed' };
    } catch {
      if (attempt < maxAttempts) {
        await sleep(effectiveDelayMs);
      }
    }
  }

  return {
    status: 'failed',
    failure: { kind: 'health', exitCode: 1, message: 'the health check timed out' },
  };
}

/**
 * Execute `plan.steps` in order and return a summary. The first failing step
 * ends the release immediately; completed steps and any warnings (the plan's
 * reminders plus a deferred proxy switch) are reported value-free.
 */
export async function executeReleaseSteps(
  plan: ProductionPlan,
  options: RunReleaseOptions,
): Promise<ReleaseSummary> {
  const { commandRunner, remoteRunner, healthCheck } = options;
  if (commandRunner === undefined || remoteRunner === undefined || healthCheck === undefined) {
    throw new ReleaseError(
      'executeReleaseSteps requires a command runner, a remote runner, and a health check',
    );
  }
  const logger = options.logger ?? SILENT_LOGGER;

  const completed: ProductionStepKind[] = [];
  const warnings: string[] = [...plan.warnings];
  for (const warning of plan.warnings) {
    logger.warn(warning);
  }

  for (const step of plan.steps) {
    logger.info(step.description);
    const result = await runStep(step, plan, options, warnings, logger);
    if (result.status === 'failed') {
      return { completed, failedStep: result.failure, warnings };
    }
    if (result.status === 'completed') {
      completed.push(step.kind);
    }
  }

  return { completed, warnings };
}

/** Dispatch one step to its executor, mutating `warnings` for a deferred switch. */
async function runStep(
  step: ProductionStep,
  plan: ProductionPlan,
  options: RunReleaseOptions,
  warnings: string[],
  logger: ReleaseLogger,
): Promise<StepResult> {
  switch (step.kind) {
    case 'build':
    case 'push':
      return runLocalStep(step, plan.imageRef, options.commandRunner);
    case 'pull':
    case 'run':
    case 'stop':
      return executePlanArgv(step, options);
    case 'health':
      return runHealthStep(plan, options);
    case 'switch':
      if (step.argv === undefined) {
        const warning = 'the proxy switch is deferred: no explicit switch argv was provided';
        warnings.push(warning);
        logger.warn(warning);
        return { status: 'skipped' };
      }
      return executePlanArgv(step, options);
    case 'rollback':
      if (options.rollback !== true) {
        return { status: 'skipped' };
      }
      return executePlanArgv(step, options);
    default:
      throw new ReleaseError('unknown production step kind');
  }
}
