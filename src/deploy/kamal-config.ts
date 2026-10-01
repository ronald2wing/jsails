/**
 * Production Valkey + app/worker configuration generator (Kamal).
 *
 * These functions produce configuration FILES as strings — they never run
 * Docker, SSH, `kamal`, or pull/deploy anything. Valkey is emitted as a Kamal
 * accessory on a private network with no published port, persisting to a host
 * directory mounted at `/data`. Authentication is enabled: the accessory runs
 * a startup script that injects `requirepass` from the `VALKEY_PASSWORD`
 * secret, and the app/worker roles read `VALKEY_URL` — a `redis://` URL whose
 * password is embedded in the URL — as a separate secret (Kamal performs no
 * YAML variable substitution, so the full URL must be supplied complete).
 *
 * Topology is single-host only: web, worker, and the Valkey accessory must
 * share one host so they all join the private Kamal network. A multi-host
 * spread is rejected explicitly — containers on different hosts cannot reach
 * an accessory's private network, and this generator does not publish Valkey
 * or configure a shared endpoint.
 */

import {
  ValkeyConfigError,
  VALKEY_DEFAULT_IMAGE,
  VALKEY_DEFAULT_PASSWORD_ENV,
  VALKEY_DEFAULT_URL_ENV,
  VALKEY_CONF_MOUNT,
  VALKEY_SCRIPT_MOUNT,
  VALKEY_SECRET_PLACEHOLDER,
  assertDatabase,
  assertEnvName,
  assertIdentifier,
  assertImageRef,
  assertPinnedImage,
  buildStartupScript,
  buildValkeyConf,
} from './valkey-config.js';

/** Default Kamal network (the accessory attaches to the app's private network). */
export const KAMAL_DEFAULT_NETWORK = 'kamal';

/** Default accessory key and service/container name. */
export const KAMAL_DEFAULT_ACCESSORY = 'valkey';

/** Default host directory name mounted at `/data` for durability. */
export const KAMAL_DEFAULT_DIRECTORY = 'valkey-data';

/** Default env var name for the registry password secret. */
export const KAMAL_DEFAULT_REGISTRY_PASSWORD_ENV = 'KAMAL_REGISTRY_PASSWORD';

/** Host path (relative to the app root) of the base config uploaded to the accessory. */
export const KAMAL_VALKEY_CONF_FILE = 'config/valkey/valkey.conf';

/** Host path (relative to the app root) of the startup script uploaded to the accessory. */
export const KAMAL_VALKEY_SCRIPT_FILE = 'config/valkey/start-valkey.sh';

/**
 * Frozen worker command. The jsails CLI does not yet implement `work`; this
 * string is frozen for the integration writer and the generated config is not
 * runnable until that command exists.
 */
export const KAMAL_WORKER_CMD = 'node dist/src/cli.js work --config jsails.runtime.js';

/**
 * One-shot scheduler command referenced in the generated docs. BullMQ queues
 * register on worker startup; alternatively this command registers the
 * schedule once. It is not emitted as a role (a scheduler that exits would
 * crash an endless role).
 */
export const KAMAL_SCHEDULE_CMD = 'node dist/src/cli.js schedule --config jsails.runtime.js';

/** Web/worker role hosts. */
export interface KamalHosts {
  web: string[];
  worker: string[];
}

/** Docker registry the app image is pulled from. */
export interface KamalRegistry {
  /** Registry server, e.g. `ghcr.io`. Required. */
  server: string;
  /** Registry username. When set, the password is referenced via secret. */
  username?: string;
}

/** Options for {@link generateKamalValkeyConfig}. */
export interface KamalValkeyOptions {
  /** App service name (container prefix). Required — no default. */
  service: string;
  /** App image reference. Required — no default. */
  image: string;
  /** Registry server (and optional username). Required — no default. */
  registry: KamalRegistry;
  /** Web and worker role hosts. Required — no default. */
  hosts: KamalHosts;
  /** Host the Valkey accessory runs on. Must equal every role host. */
  valkeyHost: string;
  /** Pinned Valkey image. Defaults to {@link VALKEY_DEFAULT_IMAGE}. */
  valkeyImage?: string;
  /** Kamal network name. Defaults to {@link KAMAL_DEFAULT_NETWORK}. */
  valkeyNetwork?: string;
  /** Host directory mounted at `/data`. Defaults to {@link KAMAL_DEFAULT_DIRECTORY}. */
  valkeyDirectory?: string;
  /** Accessory service/container name (also the `VALKEY_URL` host). */
  valkeyServiceName?: string;
  /** Valkey database index (0..15) embedded in `VALKEY_URL`. Defaults to 0. */
  database?: number;
  /** Worker command. Defaults to {@link KAMAL_WORKER_CMD}. */
  workerCmd?: string;
  /** Env var the app reads for the URL. Defaults to {@link VALKEY_DEFAULT_URL_ENV}. */
  valkeyUrlEnv?: string;
  /** Env var name for the Valkey password secret. Defaults to {@link VALKEY_DEFAULT_PASSWORD_ENV}. */
  passwordEnv?: string;
  /** Env var name for the registry password secret. */
  registryPasswordEnv?: string;
}

/** Generated production files as strings. */
export interface KamalValkeyFiles {
  /** `config/deploy.yml` content: roles, env, and the Valkey accessory. */
  deploy: string;
  /** Base `valkey.conf` (no secret; the startup script appends requirepass). */
  valkeyConfig: string;
  /** `start-valkey.sh` content: validates `VALKEY_PASSWORD` and injects requirepass. */
  startupScript: string;
  /** `.kamal/secrets` example: registry, `VALKEY_PASSWORD`, and `VALKEY_URL`. */
  secretsExample: string;
}

const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;

/** Hostname or IP (IPv4/IPv6), optionally with a port. No shell characters. */
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.:\-[\]]*$/;

/** Registry server: hostname/IP with optional port. */
const SERVER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.:-]*$/;

/** Validate a host string (no newlines, whitespace, or shell metacharacters). */
export function assertHost(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValkeyConfigError(`${label} must be a non-empty host`);
  }
  if (CONTROL_PATTERN.test(value) || !HOST_PATTERN.test(value)) {
    throw new ValkeyConfigError(
      `${label} is not a valid host: expected a hostname or IP (optionally with a port)`,
    );
  }
  return value;
}

/** Validate a registry server string. */
export function assertRegistryServer(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValkeyConfigError(`${label} must be a non-empty registry server`);
  }
  if (CONTROL_PATTERN.test(value) || !SERVER_PATTERN.test(value)) {
    throw new ValkeyConfigError(`${label} is not a valid registry server`);
  }
  return value;
}

/**
 * Validate a command string destined for a Kamal `cmd` field. Rejects newlines
 * and shell metacharacters that could break out of the emitted YAML scalar or
 * the container command; the value must be a single, fixed command line.
 */
export function assertCommandString(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValkeyConfigError(`${label} must be a non-empty command`);
  }
  if (CONTROL_PATTERN.test(value) || /[`$;&|<>"]/.test(value)) {
    throw new ValkeyConfigError(
      `${label} must not contain newlines or shell metacharacters (backtick, $, ;, &, |, <, >, ")`,
    );
  }
  return value;
}

interface NormalizedKamalOptions {
  service: string;
  image: string;
  registryServer: string;
  registryUsername: string | undefined;
  registryPasswordEnv: string;
  webHosts: string[];
  workerHosts: string[];
  valkeyHost: string;
  valkeyImage: string;
  valkeyNetwork: string;
  valkeyDirectory: string;
  valkeyServiceName: string;
  accessoryName: string;
  database: number;
  workerCmd: string;
  valkeyUrlEnv: string;
  passwordEnv: string;
}

/** Reject a multi-host spread: every role host must equal the Valkey host. */
function assertSingleHost(webHosts: string[], workerHosts: string[], valkeyHost: string): void {
  for (const [role, host] of [
    ...webHosts.map((h) => ['web', h] as const),
    ...workerHosts.map((h) => ['worker', h] as const),
  ]) {
    if (host !== valkeyHost) {
      throw new ValkeyConfigError(
        `multi-host configuration is not supported: the ${role} role runs on "${host}" ` +
          `but Valkey is an accessory on "${valkeyHost}". Containers on different hosts ` +
          `cannot share the private Kamal network, and this generator neither publishes ` +
          `Valkey nor configures a shared endpoint. Run web, worker, and Valkey on one host, ` +
          `or point VALKEY_URL at a managed Valkey and drop the accessory.`,
      );
    }
  }
}

function buildDeploy(input: NormalizedKamalOptions): string {
  const lines: string[] = [
    '# JSails production deployment (Kamal).',
    '#',
    '# Valkey is a single-host accessory on a private network with no published',
    '# port. Authentication is enabled: the accessory runs a startup script that',
    '# injects requirepass from the VALKEY_PASSWORD secret, so the password never',
    '# appears in this file or in the valkey.conf on disk.',
    '',
    `service: ${input.service}`,
    `image: ${input.image}`,
    '',
  ];

  lines.push('registry:');
  lines.push(`  server: ${input.registryServer}`);
  if (input.registryUsername !== undefined) {
    lines.push(`  username: ${input.registryUsername}`);
    lines.push('  password:');
    lines.push(`    - ${input.registryPasswordEnv}`);
  }
  lines.push('');

  lines.push('servers:', '  web:');
  for (const host of input.webHosts) {
    lines.push(`    - ${host}`);
  }
  lines.push(
    '  # BullMQ queues register on worker startup; alternatively run the',
    `  # one-shot scheduler: ${KAMAL_SCHEDULE_CMD}`,
    '  worker:',
    '    hosts:',
  );
  for (const host of input.workerHosts) {
    lines.push(`      - ${host}`);
  }
  lines.push(`    cmd: "${input.workerCmd}"`);
  lines.push('');

  lines.push(
    'env:',
    '  # VALKEY_URL carries the password inside the redis:// URL, so the whole',
    '  # value is a secret. Kamal performs no YAML variable substitution, so the',
    '  # complete URL must be supplied in .kamal/secrets (see the example).',
    '  secret:',
    `    - ${input.valkeyUrlEnv}`,
    '',
  );

  lines.push(
    'accessories:',
    `  ${input.accessoryName}:`,
    `    service: ${input.valkeyServiceName}`,
    `    image: ${input.valkeyImage}`,
    `    host: ${input.valkeyHost}`,
    `    network: ${input.valkeyNetwork}`,
    '    # Run as the unprivileged valkey user, matching the official image.',
    '    options:',
    '      user: valkey',
    '    env:',
    '      secret:',
    `        - ${input.passwordEnv}`,
    '    files:',
    `      - ${KAMAL_VALKEY_CONF_FILE}:${VALKEY_CONF_MOUNT}:ro`,
    `      - ${KAMAL_VALKEY_SCRIPT_FILE}:${VALKEY_SCRIPT_MOUNT}:ro`,
    '    # Host directory mounted at /data. The official valkey image runs as',
    '    # uid 999 (user valkey); on Alpine the valkey group is gid 1000, so a',
    '    # freshly created host directory must be owned 999:1000 or persistence',
    '    # writes fail. (The Debian variant uses 999:999, hence the explicit',
    '    # numbers rather than a name.)',
    '    directories:',
    `      - local: ${input.valkeyDirectory}`,
    '        remote: /data',
    '        owner: "999:1000"',
    `    cmd: /bin/sh ${VALKEY_SCRIPT_MOUNT}`,
    '',
  );

  return lines.join('\n');
}

function buildSecretsExample(input: NormalizedKamalOptions): string {
  const lines: string[] = [
    '# JSails production secrets (Kamal). Place in .kamal/secrets; never commit.',
    '#',
    '# Docker registry credentials (referenced by registry.password).',
    `${input.registryPasswordEnv}=`,
    '',
    '# Valkey access password for the accessory (referenced by the accessory',
    '# env.secret). Required: at least 32 characters, URL-safe ([A-Za-z0-9._~-])',
    '# only. The startup script rejects a missing, non-URL-safe, or short value.',
    '# Replace the placeholder with a random value.',
    `${input.passwordEnv}=${VALKEY_SECRET_PLACEHOLDER}`,
    '',
    '# App/worker connection URL (referenced by env.secret). The password is',
    '# embedded in the URL after "redis://:" and must match the value above. The',
    '# scheme stays redis:// because ioredis/BullMQ/Socket.IO speak that protocol.',
    `${input.valkeyUrlEnv}=redis://:${VALKEY_SECRET_PLACEHOLDER}@${input.valkeyServiceName}:6379/${input.database}`,
    '',
  ];
  return lines.join('\n');
}

/**
 * Generate the production deployment: a `config/deploy.yml`, a base
 * `valkey.conf`, a `start-valkey.sh` startup script, and a `.kamal/secrets`
 * example. Returns strings only; nothing is run or written to disk.
 */
export function generateKamalValkeyConfig(options: KamalValkeyOptions): KamalValkeyFiles {
  const service = assertIdentifier(options.service, 'options.service');
  const image = assertImageRef(options.image, 'options.image');
  if (typeof options.registry !== 'object' || options.registry === null) {
    throw new ValkeyConfigError('options.registry is required (server and optional username)');
  }
  const registryServer = assertRegistryServer(options.registry.server, 'options.registry.server');
  const registryUsername =
    options.registry.username === undefined
      ? undefined
      : assertIdentifier(options.registry.username, 'options.registry.username');

  if (typeof options.hosts !== 'object' || options.hosts === null) {
    throw new ValkeyConfigError('options.hosts is required (web and worker role hosts)');
  }
  if (!Array.isArray(options.hosts.web) || options.hosts.web.length === 0) {
    throw new ValkeyConfigError('options.hosts.web must be a non-empty list of hosts');
  }
  if (!Array.isArray(options.hosts.worker) || options.hosts.worker.length === 0) {
    throw new ValkeyConfigError('options.hosts.worker must be a non-empty list of hosts');
  }
  const webHosts = options.hosts.web.map((host) => assertHost(host, 'options.hosts.web'));
  const workerHosts = options.hosts.worker.map((host) => assertHost(host, 'options.hosts.worker'));
  const valkeyHost = assertHost(options.valkeyHost, 'options.valkeyHost');
  assertSingleHost(webHosts, workerHosts, valkeyHost);

  const valkeyImage = assertPinnedImage(
    options.valkeyImage ?? VALKEY_DEFAULT_IMAGE,
    'options.valkeyImage',
  );
  const valkeyNetwork = assertIdentifier(
    options.valkeyNetwork ?? KAMAL_DEFAULT_NETWORK,
    'options.valkeyNetwork',
  );
  const valkeyDirectory = assertIdentifier(
    options.valkeyDirectory ?? KAMAL_DEFAULT_DIRECTORY,
    'options.valkeyDirectory',
  );
  const valkeyServiceName = assertIdentifier(
    options.valkeyServiceName ?? KAMAL_DEFAULT_ACCESSORY,
    'options.valkeyServiceName',
  );
  const database = assertDatabase(options.database ?? 0, 'options.database');
  const workerCmd = assertCommandString(options.workerCmd ?? KAMAL_WORKER_CMD, 'options.workerCmd');
  const valkeyUrlEnv = assertEnvName(
    options.valkeyUrlEnv ?? VALKEY_DEFAULT_URL_ENV,
    'options.valkeyUrlEnv',
  );
  const passwordEnv = assertEnvName(
    options.passwordEnv ?? VALKEY_DEFAULT_PASSWORD_ENV,
    'options.passwordEnv',
  );
  const registryPasswordEnv = assertEnvName(
    options.registryPasswordEnv ?? KAMAL_DEFAULT_REGISTRY_PASSWORD_ENV,
    'options.registryPasswordEnv',
  );

  const normalized: NormalizedKamalOptions = {
    service,
    image,
    registryServer,
    registryUsername,
    registryPasswordEnv,
    webHosts,
    workerHosts,
    valkeyHost,
    valkeyImage,
    valkeyNetwork,
    valkeyDirectory,
    valkeyServiceName,
    accessoryName: KAMAL_DEFAULT_ACCESSORY,
    database,
    workerCmd,
    valkeyUrlEnv,
    passwordEnv,
  };

  return {
    deploy: buildDeploy(normalized),
    valkeyConfig: buildValkeyConf(),
    startupScript: buildStartupScript(),
    secretsExample: buildSecretsExample(normalized),
  };
}
