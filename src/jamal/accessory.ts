/**
 * Jamal accessory lifecycle verbs: `jamal accessory <verb> [name]`.
 *
 * The seven verbs mirror Kamal's `kamal accessory <verb>` surface, operating
 * on backing service containers (mariadb, postgres, valkey) declared in
 * `config.services`. Dev tools (mailpit, adminer) are rejected as unknown
 * accessory names, and every verb requires `config.production` for the target
 * SSH server. `--dry-run` prints the exact `ssh` argv without running it.
 *
 * These verbs are pure CLI lifecycle verbs that run one or more remote `docker`
 * commands per invocation; they never touch the app, restart the deploy engine,
 * or mutate history. A failed command returns the child's exit code (or 1 for a
 * spawn failure) without affecting other independent services.
 */

import { parseArgs } from 'node:util';

import { loadJamalConfig, type JamalConfig, type JamalEnvValue } from './config.js';
import { defaultRemoteRunner, formatError, type JamalDeps, usageError } from './plan-command.js';
import {
  CONVENTIONS,
  accessoryRunArgv,
  isBackingService,
  type AccessoryServiceType,
} from './production/accessories.js';
import { ACCESSORY_USAGE } from './usage.js';

/** The recognised accessory lifecycle verbs. */
const VERBS = new Set(['boot', 'start', 'stop', 'reboot', 'logs', 'remove', 'details']);

/** Flags the accessory verbs accept; parsed independently of the top-level set. */
const ACCESSORY_OPTIONS = {
  follow: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

/**
 * All backing services declared in `config.services`, in sorted key order.
 * Dev tools (`mailpit`/`adminer`) are never included.
 */
function allAccessoryNames(config: JamalConfig): { name: string; type: AccessoryServiceType }[] {
  const names: { name: string; type: AccessoryServiceType }[] = [];
  for (const name of Object.keys(config.services).sort()) {
    const service = config.services[name];
    if (service !== undefined && isBackingService(service.type)) {
      names.push({ name, type: service.type });
    }
  }
  return names;
}

/**
 * The sorted list of valid accessory names for error messages, from config.
 * Dev tools are excluded so the message only names legitimate targets.
 */
function sortedAccessoryNames(config: JamalConfig): string[] {
  return allAccessoryNames(config).map((entry) => entry.name);
}

/**
 * Require that `name` is a declared backing service in `config.services`.
 * Returns the resolved service type; throws a value-free error naming the valid
 * accessory names when the name is unknown or is a dev tool.
 */
function resolveAccessoryName(config: JamalConfig, name: string): AccessoryServiceType {
  const service = config.services[name];
  if (service === undefined || !isBackingService(service.type)) {
    const valid = sortedAccessoryNames(config);
    throw new Error(
      valid.length === 0
        ? `unknown accessory "${name}"; no backing services are declared`
        : `unknown accessory "${name}"; valid: ${valid.join(', ')}`,
    );
  }
  return service.type;
}

/**
 * Run one remote command over ssh and forward its output. Returns the command's
 * exit code; a spawn failure returns 1. Mirrors the remote inspection verbs'
 * executor in `exec.ts`.
 */
async function runRemoteCommand(
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

/** Print the exact ssh argv a run would execute, without executing it. */
function printDryRun(deps: JamalDeps, server: string, argv: readonly string[]): void {
  deps.stdout(`[dry-run] ssh ${server} ${argv.join(' ')}`);
}

/**
 * Build a `docker volume create` argv for one service. Idempotent — the volume
 * is left intact when it already exists.
 */
function bootVolumeArgv(type: AccessoryServiceType): string[] {
  const convention = CONVENTIONS[type];
  return ['docker', 'volume', 'create', convention.volume];
}

/**
 * Build a `docker inspect` argv for one service (check whether the container
 * already exists). Returns exit 0 when it exists.
 */
function inspectArgv(name: string): string[] {
  return ['docker', 'inspect', name];
}

/** Build a `docker run` argv via the shared accessory builder. */
function bootRunArgv(
  type: AccessoryServiceType,
  name: string,
  env: Readonly<Record<string, JamalEnvValue>>,
): string[] {
  return accessoryRunArgv(type, name, env);
}

/** Build a `docker logs` argv for one service, optionally following. */
function logsArgv(name: string, follow: boolean): string[] {
  return follow ? ['docker', 'logs', '--follow', name] : ['docker', 'logs', name];
}

/**
 * Run one complete `boot` for a single accessory: volume create (idempotent),
 * then inspect-check, then potentially `docker run`. Returns the exit code of
 * the last operation that ran (0 when the container is already running).
 */
async function bootOne(
  deps: JamalDeps,
  server: string,
  name: string,
  type: AccessoryServiceType,
  env: Readonly<Record<string, JamalEnvValue>>,
): Promise<number> {
  // Volume create is idempotent.
  const volArgv = bootVolumeArgv(type);
  const volCode = await runRemoteCommand(deps, server, volArgv, `accessory boot ${name} volume`);
  if (volCode !== 0) {
    return volCode;
  }

  // Check whether the container already exists.
  const inspectCode = await runRemoteCommand(
    deps,
    server,
    inspectArgv(name),
    `accessory boot ${name} inspect`,
  );
  if (inspectCode === 0) {
    return 0; // Container already exists — no need to recreate.
  }

  // Start the container.
  const runArgv = bootRunArgv(type, name, env);
  return runRemoteCommand(deps, server, runArgv, `accessory boot ${name} run`);
}

/**
 * Print the `--dry-run` ssh commands for one `boot`.
 */
function bootDryRun(
  deps: JamalDeps,
  server: string,
  name: string,
  type: AccessoryServiceType,
  env: Readonly<Record<string, JamalEnvValue>>,
): void {
  printDryRun(deps, server, bootVolumeArgv(type));
  // In dry-run mode, print both the inspect check and the potential run.
  printDryRun(deps, server, inspectArgv(name));
  printDryRun(deps, server, bootRunArgv(type, name, env));
}

/**
 * Run the `jamal accessory` command over the tokens after `accessory`. Resolves
 * to a process exit code: 0 on success (including a dry run), 2 for a usage
 * error, and 1 for a config or remote-run failure.
 */
export async function runAccessoryCommand(
  deps: JamalDeps,
  args: readonly string[],
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: ACCESSORY_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usageError(deps, formatError(error));
  }

  const { values, positionals } = parsed;

  if (values.help) {
    deps.stdout(ACCESSORY_USAGE);
    return 0;
  }

  const verb = positionals[0];
  if (verb === undefined || !VERBS.has(verb)) {
    return usageError(
      deps,
      'a verb is required (boot | start | stop | reboot | logs | remove | details)',
    );
  }

  // `follow` is only valid for `logs`.
  if (values.follow && verb !== 'logs') {
    return usageError(deps, '--follow is only valid for `jamal accessory logs`');
  }

  const rawName = positionals[1];

  // `logs` and `details` require a single service name.
  if ((verb === 'logs' || verb === 'details') && rawName === undefined) {
    return usageError(deps, `"jamal accessory ${verb}" requires a service name`);
  }
  if (positionals.length > 2) {
    return usageError(deps, `unexpected argument: ${positionals.slice(2).join(' ')}`);
  }

  // Load the config and require production.
  const loader = deps.loadJamalConfig ?? ((dir: string) => loadJamalConfig(dir));
  let config: JamalConfig;
  try {
    config = await loader(deps.cwd);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }
  if (config.production === undefined) {
    deps.stderr('jsails: config.production is required for `jamal accessory`');
    return 1;
  }
  const server = config.production.server;

  // Resolve the accessory name(s) to operate on.
  let names: { name: string; type: AccessoryServiceType }[];
  if (rawName !== undefined) {
    let type: AccessoryServiceType;
    try {
      type = resolveAccessoryName(config, rawName);
    } catch (error) {
      return usageError(deps, formatError(error));
    }
    names = [{ name: rawName, type }];
  } else {
    names = allAccessoryNames(config);
    if (names.length === 0) {
      deps.stderr('jsails: no backing services are declared in config.services');
      return 1;
    }
  }

  // Execute each service in order; a failure stops the chain.
  for (const { name, type } of names) {
    let exitCode: number;

    switch (verb) {
      case 'boot':
        if (values['dry-run']) {
          bootDryRun(deps, server, name, type, config.env);
          exitCode = 0;
        } else {
          exitCode = await bootOne(deps, server, name, type, config.env);
        }
        break;

      case 'start':
        if (values['dry-run']) {
          printDryRun(deps, server, ['docker', 'start', name]);
          exitCode = 0;
        } else {
          exitCode = await runRemoteCommand(
            deps,
            server,
            ['docker', 'start', name],
            `accessory start ${name}`,
          );
        }
        break;

      case 'stop':
        if (values['dry-run']) {
          printDryRun(deps, server, ['docker', 'stop', name]);
          exitCode = 0;
        } else {
          exitCode = await runRemoteCommand(
            deps,
            server,
            ['docker', 'stop', name],
            `accessory stop ${name}`,
          );
        }
        break;

      case 'reboot':
        if (values['dry-run']) {
          printDryRun(deps, server, ['docker', 'restart', name]);
          exitCode = 0;
        } else {
          exitCode = await runRemoteCommand(
            deps,
            server,
            ['docker', 'restart', name],
            `accessory reboot ${name}`,
          );
        }
        break;

      case 'logs':
        if (values['dry-run']) {
          printDryRun(deps, server, logsArgv(name, values.follow));
          exitCode = 0;
        } else {
          exitCode = await runRemoteCommand(
            deps,
            server,
            logsArgv(name, values.follow),
            `accessory logs ${name}`,
          );
        }
        break;

      case 'remove':
        if (values['dry-run']) {
          printDryRun(deps, server, ['docker', 'rm', '-f', name]);
          exitCode = 0;
        } else {
          exitCode = await runRemoteCommand(
            deps,
            server,
            ['docker', 'rm', '-f', name],
            `accessory remove ${name}`,
          );
        }
        break;

      case 'details':
        if (values['dry-run']) {
          printDryRun(deps, server, ['docker', 'inspect', name]);
          exitCode = 0;
        } else {
          exitCode = await runRemoteCommand(
            deps,
            server,
            ['docker', 'inspect', name],
            `accessory details ${name}`,
          );
        }
        break;

      default:
        return usageError(deps, `unknown verb: ${verb}`);
    }

    if (exitCode !== 0) {
      return exitCode;
    }
  }

  return 0;
}
