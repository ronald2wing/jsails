/**
 * Jamal execution verbs: local Docker Compose (`up`/`down`/`ps`/`logs`/`exec`)
 * and the production release verbs (`deploy`, `rollback`, `status`, and remote
 * `logs`/`exec`).
 *
 * `deploy` on the default Docker/SSH (kamal) engine **executes by default** and
 * `--dry-run` prints the pure {@link planProduction} plan; `rollback` behaves
 * the same way. These are the only paths that spawn a process or drive the
 * remote release engine; they import the shared seam and helpers from `plan.ts`.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { loadJamalConfig, type JamalConfig } from './config.js';
import { LOCAL_COMPOSE_PATH, planLocal } from './compose.js';
import {
  COMPOSE_FILENAME,
  composeArgv,
  execArgv,
  type CommandResult,
  type DockerVerb,
} from './docker.js';
import {
  appendDeployEntry,
  readDeployHistory,
  type DeployHistory,
  type DeployHistoryEntry,
} from './production/history.js';
import type { HookRunner, HooksFilesystem } from './production/hooks.js';
import {
  createProcessRunner,
  type CommandRunner as ReleaseCommandRunner,
} from './production/command-runner.js';
import { createRemoteRunner, type RemoteRunner } from './production/transport.js';
import type { HealthCheck, ReleaseLogger } from './production/release.js';
import { containerNameForTag, formatProductionPlan, planProduction } from './production/plan.js';
import {
  createFetchHealthCheck,
  createHooksFilesystem,
  createProcessHookRunner,
  defaultImageTag,
  remoteExecArgv,
  remoteLogsArgv,
  remoteStatusArgv,
  runDeployExecution,
  runRollbackExecution,
} from './production/execute.js';
import {
  defaultRemoteRunner,
  formatError,
  isErrno,
  resolveTargetDir,
  type JamalDeps,
  usageError,
} from './plan-command.js';

/** Absolute path of the managed `.jamal/compose.yml` inside a project root. */
function managedComposePath(targetDir: string): string {
  return join(targetDir, ...LOCAL_COMPOSE_PATH.split('/'));
}

/**
 * Load the jamal config from `configDir`, reporting a value-free failure and
 * resolving `undefined` so the caller can return a non-zero exit code. The
 * `JamalConfigError` messages never embed config values.
 */
async function loadConfig(deps: JamalDeps, configDir: string): Promise<JamalConfig | undefined> {
  const loader = deps.loadJamalConfig ?? ((dir: string) => loadJamalConfig(dir));
  try {
    return await loader(configDir);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return undefined;
  }
}

/**
 * Materialize `.jamal/compose.yml` for `config` into `targetDir`. The file is
 * written only when its content differs from the deterministic plan, so repeat
 * runs leave an unchanged file untouched. Returns the absolute destination, or
 * `undefined` after reporting an error.
 */
async function materializeManagedCompose(
  deps: JamalDeps,
  targetDir: string,
  config: JamalConfig,
): Promise<string | undefined> {
  let plan: ReturnType<typeof planLocal>;
  try {
    plan = planLocal(config);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return undefined;
  }
  const dest = join(targetDir, ...plan.path.split('/'));
  let current: string | undefined;
  try {
    current = await readFile(dest, 'utf8');
  } catch {
    current = undefined; // Missing or unreadable: (re)write the canonical plan.
  }
  if (current === plan.contents) {
    return dest;
  }
  try {
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, plan.contents);
  } catch (error) {
    deps.stderr(`jsails: could not write ${plan.path}: ${formatError(error)}`);
    return undefined;
  }
  return dest;
}

/**
 * Spawn one fixed compose argv and forward its output/exit code. The one place
 * jamal spawns a process; the `runCommand` seam lets tests avoid Docker. A
 * missing seam reports "unavailable", an `ENOENT` spawn reports the install
 * hint, and any other failure is sanitized into a single line.
 */
async function executeCompose(
  argv: readonly string[],
  cwd: string,
  label: string,
  deps: JamalDeps,
): Promise<number> {
  if (deps.runCommand === undefined) {
    deps.stderr('jsails: docker compose is not available in this environment');
    return 127;
  }

  let result: CommandResult;
  try {
    result = await deps.runCommand(argv, { cwd });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      deps.stderr(
        'jsails: docker compose is not available; install Docker with the compose plugin and ensure "docker" is on PATH',
      );
      return 127;
    }
    deps.stderr(`jsails: failed to run docker compose ${label}: ${formatError(error)}`);
    return 1;
  }

  if (result.stdout !== '') {
    deps.stdout(result.stdout.replace(/\n$/, ''));
  }
  if (result.stderr !== '') {
    deps.stderr(result.stderr.replace(/\n$/, ''));
  }
  if (result.exitCode !== 0) {
    deps.stderr(`jsails: docker compose ${label} exited with code ${result.exitCode}`);
  }
  return result.exitCode;
}

/**
 * Run one execution verb (`up`/`down`/`ps`/`logs`) against the local project.
 * `up` always drives the managed `.jamal/compose.yml` materialized from
 * `jamal.config.js`; the read/teardown verbs use that same managed file/project
 * when it exists and otherwise fall back to the legacy `docker-compose.yml`
 * generated by `jamal dev --write`, so existing users are not broken. This is
 * the one place jamal spawns a process; it never builds the registry, runs a
 * generator, or starts other services.
 */
export async function runDockerVerb(
  verb: DockerVerb,
  rest: readonly string[],
  values: { readonly dir?: string; readonly follow: boolean },
  deps: JamalDeps,
): Promise<number> {
  if (verb !== 'logs' && rest.length > 0) {
    return usageError(deps, `"jamal ${verb}" takes no arguments`);
  }
  if (verb === 'logs' && rest.length > 1) {
    return usageError(deps, `"jamal logs" takes at most one service name; got: ${rest.join(' ')}`);
  }

  let targetDir: string;
  try {
    targetDir = resolveTargetDir(deps.cwd, values.dir);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }

  const service = verb === 'logs' ? rest[0] : undefined;

  if (verb === 'up') {
    const config = await loadConfig(deps, targetDir);
    if (config === undefined) {
      return 1;
    }
    if ((await materializeManagedCompose(deps, targetDir, config)) === undefined) {
      return 1;
    }
    const argv = composeArgv('up', {
      file: LOCAL_COMPOSE_PATH,
      project: config.service,
      wait: true,
    });
    return executeCompose(argv, targetDir, 'up', deps);
  }

  if (existsSync(managedComposePath(targetDir))) {
    const config = await loadConfig(deps, targetDir);
    if (config === undefined) {
      return 1;
    }
    const argv = composeArgv(verb, {
      follow: values.follow,
      service,
      file: LOCAL_COMPOSE_PATH,
      project: config.service,
    });
    return executeCompose(argv, targetDir, verb, deps);
  }

  if (!existsSync(join(targetDir, COMPOSE_FILENAME))) {
    deps.stderr(
      `jsails: no ${COMPOSE_FILENAME} found in ${targetDir}; run "jsails jamal dev --write" to generate it first`,
    );
    return 1;
  }

  const argv = composeArgv(verb, { follow: values.follow, service });
  return executeCompose(argv, targetDir, verb, deps);
}

/**
 * Run `jamal exec <service> -- <cmd...>` against the managed
 * `.jamal/compose.yml`. The `--` separator is required so the command's own
 * flags are never interpreted by jamal or `docker compose`; the managed file
 * must already exist (created by `jamal up`).
 */
export async function runDockerExec(
  tokens: readonly string[],
  hasTerminator: boolean,
  values: { readonly dir?: string },
  deps: JamalDeps,
): Promise<number> {
  if (!hasTerminator) {
    return usageError(
      deps,
      '"jamal exec" requires "--" before the command: jsails jamal exec <service> -- <cmd...>',
    );
  }
  const service = tokens[0];
  const command = tokens.slice(1);
  if (service === undefined || service === '') {
    return usageError(
      deps,
      '"jamal exec" requires a service name: jsails jamal exec <service> -- <cmd...>',
    );
  }
  if (command.length === 0) {
    return usageError(deps, '"jamal exec" requires a command after "--"');
  }

  let targetDir: string;
  try {
    targetDir = resolveTargetDir(deps.cwd, values.dir);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }

  if (!existsSync(managedComposePath(targetDir))) {
    deps.stderr(
      `jsails: no ${LOCAL_COMPOSE_PATH} found in ${targetDir}; run "jsails jamal up" to generate it first`,
    );
    return 1;
  }

  const config = await loadConfig(deps, targetDir);
  if (config === undefined) {
    return 1;
  }

  const argv = execArgv(service, command, {
    file: LOCAL_COMPOSE_PATH,
    project: config.service,
  });
  return executeCompose(argv, targetDir, 'exec', deps);
}

/** The parsed values the `deploy`/`rollback` verbs read. */
interface ExecuteValues {
  readonly tag?: string;
  readonly write: boolean;
  readonly dir?: string;
  readonly target?: string;
  readonly 'dry-run': boolean;
}

/** The production seams a deploy/rollback injects; every one has a real default. */
interface ExecutionSeams {
  readonly commandRunner: ReleaseCommandRunner;
  readonly remoteRunner: RemoteRunner;
  readonly healthCheck: HealthCheck;
  readonly hooksFs: HooksFilesystem;
  readonly hookRunner: HookRunner;
}

/** Resolve the production seams from the injected deps, defaulting to real ones. */
function resolveExecutionSeams(deps: JamalDeps): ExecutionSeams {
  const processRunner = deps.processRunner ?? createProcessRunner();
  return {
    commandRunner: processRunner,
    remoteRunner: deps.remoteRunner ?? createRemoteRunner({ processRunner }),
    healthCheck: deps.healthCheck ?? createFetchHealthCheck(),
    hooksFs: deps.hooksFs ?? createHooksFilesystem(),
    hookRunner: deps.hookRunner ?? createProcessHookRunner(),
  };
}

/** A release logger that forwards step progress and warnings to the sinks. */
function releaseLogger(deps: JamalDeps): ReleaseLogger {
  return {
    info: (message) => deps.stdout(message),
    warn: (message) => deps.stderr(message),
  };
}

/** Resolve the image tag: `--tag` wins, else the injected resolver. */
async function resolveImageTag(deps: JamalDeps, explicit: string | undefined): Promise<string> {
  if (explicit !== undefined) {
    return explicit;
  }
  const resolver = deps.resolveTag ?? ((cwd: string) => defaultImageTag(cwd));
  return resolver(deps.cwd);
}

/** Read the deploy history, reporting a value-free failure and resolving undefined. */
async function readHistorySafe(deps: JamalDeps): Promise<DeployHistory | undefined> {
  const reader = deps.readHistory ?? ((dir: string) => readDeployHistory(dir));
  try {
    return await reader(deps.cwd);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return undefined;
  }
}

/** Record a deploy history entry; a write failure is a warning, never fatal. */
async function recordHistory(deps: JamalDeps, entry: DeployHistoryEntry): Promise<void> {
  const append =
    deps.appendHistory ??
    ((dir: string, value: DeployHistoryEntry) => appendDeployEntry(dir, value));
  try {
    await append(deps.cwd, entry);
  } catch (error) {
    deps.stderr(`jsails: warning: could not record deploy history: ${formatError(error)}`);
  }
}

/**
 * Run one remote inspection command over ssh and forward its output. Returns
 * the command's exit code; a spawn failure or timeout returns 1.
 */
export async function runRemoteCommand(
  deps: JamalDeps,
  server: string,
  argv: readonly string[],
  label: string,
): Promise<number> {
  const remote = deps.remoteRunner ?? defaultRemoteRunner;
  let result;
  try {
    result = await remote.run(server, argv);
  } catch (error) {
    deps.stderr(`jsails: ${label} failed: ${formatError(error)}`);
    return 1;
  }
  if (result.stdout !== '') {
    deps.stdout(result.stdout.replace(/\n$/, ''));
  }
  if (result.stderr !== '') {
    deps.stderr(result.stderr.replace(/\n$/, ''));
  }
  if (result.exitCode !== 0) {
    deps.stderr(`jsails: ${label} exited with code ${result.exitCode}`);
  }
  return result.exitCode;
}

/** `jamal status`: list containers on the production server. */
export async function runRemoteStatusVerb(deps: JamalDeps): Promise<number> {
  const config = await loadConfig(deps, deps.cwd);
  if (config === undefined) {
    return 1;
  }
  if (config.production === undefined) {
    deps.stderr('jsails: config.production is required for `jamal status`');
    return 1;
  }
  return runRemoteCommand(deps, config.production.server, remoteStatusArgv(), 'status');
}

/**
 * Route `logs`/`exec` to the remote container when a production config is
 * present, else resolve `undefined` so the caller falls back to the local
 * Compose project. The container is the latest recorded deploy.
 */
export async function routeRemoteLogsOrExec(
  deps: JamalDeps,
  verb: 'logs' | 'exec',
  rest: readonly string[],
  values: { readonly follow: boolean },
  args: readonly string[],
): Promise<number | undefined> {
  const config = await loadConfig(deps, deps.cwd);
  if (config === undefined || config.production === undefined) {
    return undefined;
  }
  const history = await readHistorySafe(deps);
  if (history === undefined) {
    return 1;
  }
  const entry = history.entries[history.entries.length - 1];
  if (entry === undefined) {
    deps.stderr('jsails: no deploy history to inspect');
    return 1;
  }
  const container = containerNameForTag(config.service, entry.tag);
  const server = config.production.server;
  if (verb === 'logs') {
    if (rest.length > 0) {
      return usageError(
        deps,
        `"jamal logs" takes no arguments in remote mode; got: ${rest.join(' ')}`,
      );
    }
    return runRemoteCommand(deps, server, remoteLogsArgv(container, values.follow), 'logs');
  }
  if (!args.includes('--')) {
    return usageError(
      deps,
      '"jamal exec" requires "--" before the command: jsails jamal exec -- <cmd...>',
    );
  }
  if (rest.length === 0) {
    return usageError(deps, '"jamal exec" requires a command after "--"');
  }
  return runRemoteCommand(deps, server, remoteExecArgv(container, rest), 'exec');
}

/** `jamal deploy`: perform a real production deploy. */
async function runDeployExecute(deps: JamalDeps, values: ExecuteValues): Promise<number> {
  const config = await requireProductionConfig(deps, 'deploy');
  if (config === undefined) {
    return 1;
  }

  let tag: string;
  try {
    tag = await resolveImageTag(deps, values.tag);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }

  const history = await readHistorySafe(deps);
  if (history === undefined) {
    return 1;
  }
  const previousTag = history.entries[history.entries.length - 1]?.tag;
  const seams = resolveExecutionSeams(deps);

  let result;
  try {
    result = await runDeployExecution({
      config,
      imageTag: tag,
      previousTag,
      commandRunner: seams.commandRunner,
      remoteRunner: seams.remoteRunner,
      healthCheck: seams.healthCheck,
      hooksFs: seams.hooksFs,
      hookRunner: seams.hookRunner,
      cwd: deps.cwd,
      logger: releaseLogger(deps),
    });
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }

  await recordHistory(deps, result.entry);
  deps.stdout(`deployed ${config.image}:${tag}`);
  return 0;
}

/** `jamal rollback`: deploy the previous recorded tag. */
async function runRollbackExecute(deps: JamalDeps): Promise<number> {
  const config = await requireProductionConfig(deps, 'rollback');
  if (config === undefined) {
    return 1;
  }
  const resolved = await resolveRollbackTags(deps);
  if (resolved === undefined) {
    return 1;
  }
  const seams = resolveExecutionSeams(deps);

  let result;
  try {
    result = await runRollbackExecution({
      config,
      imageTag: resolved.target.tag,
      previousTag: resolved.current.tag,
      commandRunner: seams.commandRunner,
      remoteRunner: seams.remoteRunner,
      healthCheck: seams.healthCheck,
      hooksFs: seams.hooksFs,
      hookRunner: seams.hookRunner,
      cwd: deps.cwd,
      logger: releaseLogger(deps),
    });
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }

  await recordHistory(deps, result.entry);
  deps.stdout(`rolled back to ${config.image}:${resolved.target.tag}`);
  return 0;
}

/** Load the config and require a production section; report failures and resolve undefined. */
async function requireProductionConfig(
  deps: JamalDeps,
  label: string,
): Promise<JamalConfig | undefined> {
  const config = await loadConfig(deps, deps.cwd);
  if (config === undefined) {
    return undefined;
  }
  if (config.production === undefined) {
    deps.stderr(`jsails: config.production is required for \`jamal ${label}\``);
    return undefined;
  }
  return config;
}

/** The two history entries a rollback deploys between: target (prior) and current (latest). */
interface RollbackTags {
  readonly target: DeployHistoryEntry;
  readonly current: DeployHistoryEntry;
}

/** Derive the rollback tags from history, reporting a value-free failure otherwise. */
async function resolveRollbackTags(deps: JamalDeps): Promise<RollbackTags | undefined> {
  const history = await readHistorySafe(deps);
  if (history === undefined) {
    return undefined;
  }
  const entries = history.entries;
  if (entries.length === 0) {
    deps.stderr('jsails: no deploy history to roll back');
    return undefined;
  }
  if (entries.length < 2) {
    deps.stderr('jsails: no previous deploy to roll back to');
    return undefined;
  }
  const current = entries[entries.length - 1];
  const target = entries[entries.length - 2];
  if (current === undefined || target === undefined) {
    deps.stderr('jsails: no previous deploy to roll back to');
    return undefined;
  }
  return { target, current };
}

/** Render a production plan to stdout for `--dry-run`, or report a plan failure. */
function printPlanDryRun(
  deps: JamalDeps,
  config: JamalConfig,
  imageTag: string,
  previousTag?: string,
): number {
  let plan;
  try {
    plan = planProduction(config, { imageTag, previousTag });
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }
  deps.stdout(formatProductionPlan(plan));
  return 0;
}

/** `jamal deploy --dry-run`: print the production plan and execute nothing. */
async function runDeployDryRun(deps: JamalDeps, values: ExecuteValues): Promise<number> {
  const config = await requireProductionConfig(deps, 'deploy');
  if (config === undefined) {
    return 1;
  }
  let tag: string;
  try {
    tag = await resolveImageTag(deps, values.tag);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }
  const history = await readHistorySafe(deps);
  if (history === undefined) {
    return 1;
  }
  const previousTag = history.entries[history.entries.length - 1]?.tag;
  return printPlanDryRun(deps, config, tag, previousTag);
}

/** `jamal rollback --dry-run`: print the rollback plan and execute nothing. */
async function runRollbackDryRun(deps: JamalDeps): Promise<number> {
  const config = await requireProductionConfig(deps, 'rollback');
  if (config === undefined) {
    return 1;
  }
  const resolved = await resolveRollbackTags(deps);
  if (resolved === undefined) {
    return 1;
  }
  return printPlanDryRun(deps, config, resolved.target.tag, resolved.current.tag);
}

/**
 * `jamal deploy` on the kamal engine: execute by default, preview with
 * `--dry-run`. The YAML-planning flags (`--write`/`--dir`) never apply to the
 * engine, which generates no files.
 */
export async function runDeployCommand(deps: JamalDeps, values: ExecuteValues): Promise<number> {
  if (values.write) {
    return usageError(deps, '--write is not valid for `deploy --target kamal`');
  }
  if (values.dir !== undefined) {
    return usageError(deps, '--dir is not valid for `deploy --target kamal`');
  }
  if (values['dry-run']) {
    return runDeployDryRun(deps, values);
  }
  return runDeployExecute(deps, values);
}

/**
 * `jamal rollback`: execute by default, preview with `--dry-run`.
 */
export async function runRollbackCommand(deps: JamalDeps, values: ExecuteValues): Promise<number> {
  if (values['dry-run']) {
    return runRollbackDryRun(deps);
  }
  return runRollbackExecute(deps);
}
