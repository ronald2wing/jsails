/**
 * Production service accessories for jamal.
 *
 * A production deploy runs more than the application container: the backing
 * services a config declares (`mariadb`, `postgres`, `valkey`) must exist on
 * the target server before the app starts, or the app fails its database/Valkey
 * connection at boot. {@link planAccessories} turns those services into
 * value-free accessory steps — one data-volume creation, one container start,
 * and one health poll per service, mirroring the local Compose planner's pinned
 * images, volume names, and health probes — and {@link runAccessories} executes
 * them over the injected {@link RemoteRunner} with reuse semantics (an
 * already-running container is never recreated) and a bounded health retry.
 *
 * No secret value reaches a plan or a command. Credentials are read from
 * `config.env` (`DATABASE_NAME`/`DATABASE_USER`/`DATABASE_PASSWORD`/
 * `VALKEY_PASSWORD`): a {@link SecretRef} contributes only its NAME, a literal
 * value passes through, and an absent credential omits the flag entirely. The
 * app-facing env refs point at `127.0.0.1` — the loopback address the accessory
 * containers publish on — so a value-free plan can still wire the app to them.
 */

import { JamalConfigError, SecretRef, type JamalConfig, type JamalEnvValue } from '../config.js';
import type { CommandResult } from './command-runner.js';
import type { ReleaseLogger } from './release.js';
import type { ProductionStep } from './plan.js';
import type { RemoteRunner } from './transport.js';

/** Backing service types that get a production accessory; dev tools are skipped. */
export type AccessoryServiceType = 'mariadb' | 'postgres' | 'valkey';

/** The three accessory actions per service. */
export type AccessoryAction = 'volume' | 'run' | 'health';

/** Hard cap on accessory health attempts before a deploy aborts. */
export const ACCESSORY_HEALTH_MAX_ATTEMPTS = 10;

/** Delay between accessory health attempts, in milliseconds. */
export const ACCESSORY_HEALTH_RETRY_DELAY_MS = 5000;

/** Raised for a failed accessory step; the message is value-free. */
export class AccessoryError extends Error {
  /** The action that failed, so the deploy executor can name the step. */
  readonly action: AccessoryAction;

  constructor(action: AccessoryAction, message: string) {
    super(message);
    this.name = 'AccessoryError';
    this.action = action;
  }
}

/** Structured metadata carried by an accessory {@link ProductionStep}. */
export interface AccessoryStep {
  readonly action: AccessoryAction;
  readonly service: AccessoryServiceType;
  /** The container name (`config.services` key) the run/health steps address. */
  readonly name: string;
}

/** An env entry appended to the app run step: a name and its value (never a secret). */
interface AccessoryEnvEntry {
  readonly name: string;
  readonly value: string;
}

/** The accessory plan: the prepended steps plus the app run-step env refs. */
interface AccessoryPlan {
  readonly steps: readonly ProductionStep[];
  readonly appEnv: readonly AccessoryEnvEntry[];
}

/** Options for {@link runAccessories}. */
interface RunAccessoriesOptions {
  readonly remoteRunner: RemoteRunner;
  readonly logger?: ReleaseLogger;
  /** Delay seam for the health retry loop; defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Image/volume/port conventions shared with the local Compose planner. */
interface AccessoryConvention {
  readonly image: string;
  readonly port: number;
  readonly volume: string;
  readonly dataDir: string;
}

/** Container env var names a database image consumes for its bootstrap database. */
interface DatabaseEnvVars {
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

const MARIADB: AccessoryConvention = {
  image: 'mariadb:11.4',
  port: 3306,
  volume: 'mariadb-data',
  dataDir: '/var/lib/mysql',
};

const POSTGRES: AccessoryConvention = {
  image: 'postgres:16-alpine',
  port: 5432,
  volume: 'postgres-data',
  dataDir: '/var/lib/postgresql/data',
};

const VALKEY: AccessoryConvention = {
  image: 'valkey/valkey:8.0-alpine',
  port: 6379,
  volume: 'valkey-data',
  dataDir: '/data',
};

const CONVENTIONS: Readonly<Record<AccessoryServiceType, AccessoryConvention>> = {
  mariadb: MARIADB,
  postgres: POSTGRES,
  valkey: VALKEY,
};

export { CONVENTIONS };

/** True for a backing service (not a `mailpit`/`adminer` dev tool). */
export function isBackingService(type: string): type is AccessoryServiceType {
  return type === 'mariadb' || type === 'postgres' || type === 'valkey';
}

const MARIADB_ENV: DatabaseEnvVars = {
  database: 'MARIADB_DATABASE',
  user: 'MARIADB_USER',
  password: 'MARIADB_PASSWORD',
};

const POSTGRES_ENV: DatabaseEnvVars = {
  database: 'POSTGRES_DB',
  user: 'POSTGRES_USER',
  password: 'POSTGRES_PASSWORD',
};

const DATABASE_ENV_VARS: Readonly<Record<'mariadb' | 'postgres', DatabaseEnvVars>> = {
  mariadb: MARIADB_ENV,
  postgres: POSTGRES_ENV,
};

const SILENT_LOGGER: ReleaseLogger = { info: () => {}, warn: () => {} };

/** Resolve a credential to a value-free string: a secret contributes only its name. */
function credentialValue(value: JamalEnvValue | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  // A structured env entry wraps its value; a SecretRef names a secret without
  // embedding it. Unwrap the entry first so a secret name (not its value) and a
  // literal string both reduce to a plain string.
  const resolved = typeof value === 'object' && 'value' in value ? value.value : value;
  return resolved instanceof SecretRef ? resolved.name : resolved;
}

/** The `-e NAME=VALUE` flags a database container needs for its bootstrap database. */
function databaseRunFlags(
  vars: DatabaseEnvVars,
  env: Readonly<Record<string, JamalEnvValue>>,
): string[] {
  const flags: string[] = [];
  const database = credentialValue(env['DATABASE_NAME']);
  const user = credentialValue(env['DATABASE_USER']);
  const password = credentialValue(env['DATABASE_PASSWORD']);
  if (database !== undefined) {
    flags.push('-e', `${vars.database}=${database}`);
  }
  if (user !== undefined) {
    flags.push('-e', `${vars.user}=${user}`);
  }
  if (password !== undefined) {
    flags.push('-e', `${vars.password}=${password}`);
  }
  return flags;
}

/** The `docker run` argv (after `ssh <server>`) that starts one accessory container. */
function runArgv(
  type: AccessoryServiceType,
  name: string,
  convention: AccessoryConvention,
  env: Readonly<Record<string, JamalEnvValue>>,
): string[] {
  const base = [
    'docker',
    'run',
    '-d',
    '--restart',
    'unless-stopped',
    '--name',
    name,
    '-p',
    `127.0.0.1:${convention.port}:${convention.port}`,
    '-v',
    `${convention.volume}:${convention.dataDir}`,
  ];
  if (type === 'mariadb' || type === 'postgres') {
    return [...base, ...databaseRunFlags(DATABASE_ENV_VARS[type], env), convention.image];
  }
  // valkey: AOF persistence on, and requirepass only when a password is present.
  const argv = [...base, convention.image, '--appendonly', 'yes'];
  const password = credentialValue(env['VALKEY_PASSWORD']);
  if (password !== undefined) {
    argv.push('--requirepass', password);
  }
  return argv;
}

/**
 * Build the `docker run` argv for a backing accessory service.
 *
 * Exported for the `jamal accessory` lifecycle verbs so they share the exact
 * same run argv as {@link planAccessories}. The public name differs from the
 * internal `runArgv` so callers outside this module have a clear entry point.
 */
export function accessoryRunArgv(
  type: AccessoryServiceType,
  name: string,
  env: Readonly<Record<string, JamalEnvValue>>,
): string[] {
  const convention = CONVENTIONS[type];
  return runArgv(type, name, convention, env);
}

/** The health-probe argv (after `ssh <server>`) that proves one accessory is up. */
function healthArgv(
  type: AccessoryServiceType,
  name: string,
  env: Readonly<Record<string, JamalEnvValue>>,
): string[] {
  if (type === 'mariadb') {
    return ['docker', 'exec', name, 'mariadb-admin', 'ping'];
  }
  if (type === 'postgres') {
    return ['docker', 'exec', name, 'pg_isready'];
  }
  const argv = ['docker', 'exec'];
  const password = credentialValue(env['VALKEY_PASSWORD']);
  if (password !== undefined) {
    argv.push('-e', `REDISCLI_AUTH=${password}`);
  }
  return [...argv, name, 'valkey-cli', 'ping'];
}

/** The env refs the app run step needs to reach one accessory on loopback. */
function appEnvEntries(
  type: AccessoryServiceType,
  convention: AccessoryConvention,
  env: Readonly<Record<string, JamalEnvValue>>,
): AccessoryEnvEntry[] {
  if (type === 'valkey') {
    return [{ name: 'VALKEY_URL', value: `redis://127.0.0.1:${convention.port}` }];
  }
  const entries: AccessoryEnvEntry[] = [
    { name: 'DATABASE_HOST', value: '127.0.0.1' },
    { name: 'DATABASE_PORT', value: String(convention.port) },
    { name: 'DATABASE_TYPE', value: type },
  ];
  const database = credentialValue(env['DATABASE_NAME']);
  const user = credentialValue(env['DATABASE_USER']);
  const password = credentialValue(env['DATABASE_PASSWORD']);
  if (database !== undefined) {
    entries.push({ name: 'DATABASE_NAME', value: database });
  }
  if (user !== undefined) {
    entries.push({ name: 'DATABASE_USER', value: user });
  }
  if (password !== undefined) {
    entries.push({ name: 'DATABASE_PASSWORD', value: password });
  }
  return entries;
}

/**
 * Plan the production accessory steps for `config`: per backing service, a
 * volume-creation step, a container-start step, and a health-poll step (all
 * `ssh`-prefixed), plus the app run-step env refs. Dev tools (`mailpit`/
 * `adminer`) are skipped. Pure and deterministic: stable key order, no
 * timestamps, and no secret value (only secret NAMES).
 */
export function planAccessories(config: JamalConfig): AccessoryPlan {
  const production = config.production;
  if (production === undefined) {
    throw new JamalConfigError('config.production is required to plan production accessories');
  }
  const server = production.server;

  const steps: ProductionStep[] = [];
  const appEnv: AccessoryEnvEntry[] = [];

  for (const name of Object.keys(config.services).sort()) {
    const service = config.services[name];
    if (service === undefined || !isBackingService(service.type)) {
      // mailpit/adminer are dev-only tools, never production accessories.
      continue;
    }
    const type = service.type;
    const convention = CONVENTIONS[type];

    // `docker volume create` is idempotent, so it runs on every deploy.
    steps.push({
      kind: 'accessory',
      description: `Create the ${convention.volume} data volume for ${name} on ${server}.`,
      argv: ['ssh', server, 'docker', 'volume', 'create', convention.volume],
      accessory: { action: 'volume', service: type, name },
    });

    steps.push({
      kind: 'accessory',
      description: `Start the ${type} container ${name} on ${server}.`,
      argv: ['ssh', server, ...runArgv(type, name, convention, config.env)],
      accessory: { action: 'run', service: type, name },
    });

    steps.push({
      kind: 'accessory',
      description: `Wait for the ${type} container ${name} to become healthy on ${server}.`,
      argv: ['ssh', server, ...healthArgv(type, name, config.env)],
      accessory: { action: 'health', service: type, name },
    });

    appEnv.push(...appEnvEntries(type, convention, config.env));
  }

  return { steps, appEnv };
}

/** Resolve after `ms` via `setTimeout`; the default health-retry delay seam. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run a step's `ssh <server> ...` argv over the remote runner, or reject. */
async function runAccessoryArgv(
  step: ProductionStep,
  remote: RemoteRunner,
): Promise<CommandResult> {
  const argv = step.argv;
  if (argv === undefined || argv[0] !== 'ssh' || argv[1] === undefined) {
    throw new AccessoryError('run', 'an accessory step has a malformed ssh argv');
  }
  return remote.run(argv[1], argv.slice(2));
}

/**
 * Start an accessory container unless it already exists. Reuse is the
 * in-place-deploy semantics: an existing container (identified by `docker
 * inspect` exit 0) is left alone so its data and uptime survive a redeploy.
 */
async function runAccessoryContainer(step: ProductionStep, remote: RemoteRunner): Promise<void> {
  const name = step.accessory?.name;
  const server = step.argv?.[1];
  if (name === undefined || server === undefined) {
    throw new AccessoryError('run', 'an accessory run step has no container name');
  }
  const inspect = await remote.run(server, ['docker', 'inspect', name]);
  if (inspect.exitCode === 0) {
    return;
  }
  const result = await runAccessoryArgv(step, remote);
  if (result.exitCode !== 0) {
    throw new AccessoryError('run', 'the accessory container failed to start');
  }
}

/** Poll an accessory health probe, bounded, then fail value-free. */
async function runAccessoryHealth(
  step: ProductionStep,
  remote: RemoteRunner,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 1; attempt <= ACCESSORY_HEALTH_MAX_ATTEMPTS; attempt += 1) {
    const result = await runAccessoryArgv(step, remote);
    if (result.exitCode === 0) {
      return;
    }
    if (attempt < ACCESSORY_HEALTH_MAX_ATTEMPTS) {
      await sleep(ACCESSORY_HEALTH_RETRY_DELAY_MS);
    }
  }
  throw new AccessoryError('health', 'the accessory health check did not become healthy');
}

/**
 * Execute accessory steps in order over the injected remote runner. A failed
 * volume/run/health step raises an {@link AccessoryError} naming the action, so
 * the deploy executor can abort before the app release with a value-free error.
 */
export async function runAccessories(
  steps: readonly ProductionStep[],
  options: RunAccessoriesOptions,
): Promise<void> {
  const { remoteRunner } = options;
  if (remoteRunner === undefined) {
    throw new AccessoryError('run', 'runAccessories requires a remote runner');
  }
  const logger = options.logger ?? SILENT_LOGGER;
  const sleep = options.sleep ?? defaultSleep;

  for (const step of steps) {
    logger.info(step.description);
    switch (step.accessory?.action) {
      case 'volume': {
        const result = await runAccessoryArgv(step, remoteRunner);
        if (result.exitCode !== 0) {
          throw new AccessoryError('volume', 'the accessory volume could not be created');
        }
        break;
      }
      case 'run':
        await runAccessoryContainer(step, remoteRunner);
        break;
      case 'health':
        await runAccessoryHealth(step, remoteRunner, sleep);
        break;
      default:
        throw new AccessoryError('run', 'an accessory step has no recognized action');
    }
  }
}
