/**
 * Development Valkey configuration generator (Docker Compose).
 *
 * These functions produce configuration FILES as strings — they never run
 * Docker, pull images, or start services. The Valkey addon is bound to a
 * private Compose network with no published port, uses a pinned (never
 * `latest`) official image, persists via AOF into a named volume, and is
 * probed with a healthcheck.
 *
 * Authentication is enabled by default: a startup script validates the
 * `VALKEY_PASSWORD` environment variable at runtime and injects `requirepass`
 * into a private temporary config, so no secret is ever baked into the emitted
 * YAML or the shipped `valkey.conf`. The app still connects over the `redis://`
 * scheme because ioredis/BullMQ/Socket.IO speak the Redis protocol.
 *
 * The generated files are returned as plain strings; writing them to disk is
 * the caller's responsibility (the CLI integration writes them explicitly
 * later).
 */

import { assertIdentifier, assertPinnedImage } from './validators.js';

/** Default pinned Valkey image. A specific tag is required — `latest` is rejected. */
export const VALKEY_DEFAULT_IMAGE = 'valkey/valkey:8.0-alpine';

/** Default Compose service name (also the hostname the app connects to). */
const VALKEY_DEFAULT_SERVICE = 'valkey';

/** Default named volume that backs `/data`. */
const VALKEY_DEFAULT_VOLUME = 'valkey-data';

/** Default private Compose network. */
const VALKEY_DEFAULT_NETWORK = 'jsails';

/** Default env var name the app/worker reads for the Valkey URL. */
const VALKEY_DEFAULT_URL_ENV = 'VALKEY_URL';

/** Default env var name for the required password. */
const VALKEY_DEFAULT_PASSWORD_ENV = 'VALKEY_PASSWORD';

/** In-container path the startup script reads the base config from. */
const VALKEY_CONF_MOUNT = '/etc/valkey/valkey.conf';

/** In-container path of the generated startup script. */
const VALKEY_SCRIPT_MOUNT = '/etc/valkey/start-valkey.sh';

/**
 * Env var the healthcheck relies on for valkey-cli auth (no `-a` flag).
 *
 * The pinned image is valkey/valkey:8.0-alpine, whose valkey-cli still
 * inherits redis-cli's `REDISCLI_AUTH`; `VALKEYCLI_AUTH` was only introduced
 * in Valkey 9. Reading the protocol-era name keeps the probe authenticated
 * against the pinned 8.0 server.
 */
const REDISCLI_AUTH_ENV = 'REDISCLI_AUTH';

/**
 * Documented example secret used in generated examples where a real secret is
 * required. It is URL-safe and longer than 32 characters so it would pass the
 * startup script's own validation, but it is public and must never be used as
 * an actual secret.
 */
export const VALKEY_SECRET_PLACEHOLDER =
  'replace-with-a-long-url-safe-random-secret-at-least-32-chars';

/** Error raised for any invalid Valkey config option. */
export class ValkeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValkeyConfigError';
  }
}

/** Options for {@link generateDevValkeyConfig}. */
export interface ValkeyConfigOptions {
  /** Pinned Valkey image reference. Defaults to {@link VALKEY_DEFAULT_IMAGE}. */
  image?: string;
  /** Valkey database index (0..15) embedded in `VALKEY_URL`. Defaults to 0. */
  database?: number;
  /** Compose service name. Defaults to {@link VALKEY_DEFAULT_SERVICE}. */
  serviceName?: string;
  /** Named data volume. Defaults to {@link VALKEY_DEFAULT_VOLUME}. */
  volumeName?: string;
  /** Private Compose network name. Defaults to {@link VALKEY_DEFAULT_NETWORK}. */
  networkName?: string;
  /** Env var the app reads for the URL. Defaults to {@link VALKEY_DEFAULT_URL_ENV}. */
  valkeyUrlEnv?: string;
  /** Env var name for the required password. Defaults to {@link VALKEY_DEFAULT_PASSWORD_ENV}. */
  passwordEnv?: string;
}

/** Generated development files as strings. */
export interface ValkeyConfigFiles {
  /** `docker-compose.yml` content: the Valkey service, private network, and volume. */
  compose: string;
  /** `valkey.conf` content: AOF persistence and eviction policy (no secret). */
  valkeyConfig: string;
  /** `start-valkey.sh` content: validates `VALKEY_PASSWORD` and injects `requirepass`. */
  startupScript: string;
  /** `.env` example documenting `VALKEY_URL` and the required password. */
  envExample: string;
}

/** POSIX-style env var name. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** RFC 3986 unreserved characters — the only set safe unencoded in a URL. */
const URL_SAFE_CHARS = 'A-Za-z0-9._~-';

/** Validate an environment variable name. */
function assertEnvName(value: string, label: string): string {
  if (typeof value !== 'string' || !ENV_NAME_PATTERN.test(value)) {
    throw new ValkeyConfigError(`${label} must match [A-Za-z_][A-Za-z0-9_]*`);
  }
  return value;
}

/** Validate a Valkey database index (the stock server exposes 0..15). */
function assertDatabase(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 15) {
    throw new ValkeyConfigError(`${label} must be an integer between 0 and 15`);
  }
  return value;
}

/**
 * Valkey base config: AOF append-only persistence with `everysec` fsync,
 * `noeviction` eviction policy, and `/data` as the durable directory.
 *
 * `requirepass` is deliberately absent: the stock image does not expand
 * environment variables in `valkey.conf`, and baking a password in literally
 * would leak it. The startup script instead appends a validated `requirepass`
 * from `VALKEY_PASSWORD` to a private runtime copy of this file.
 */
export function generateValkeyConf(): string {
  return [
    '# Valkey configuration generated by JSails.',
    '#',
    '# Persistence: append-only file, fsync every second (everysec).',
    '# Eviction: noeviction (never drop keys; writers get errors instead).',
    '# Data lives in the mounted /data volume.',
    '#',
    '# Authentication is NOT declared here. The start-valkey.sh startup script',
    '# validates $VALKEY_PASSWORD and appends a requirepass directive to a',
    '# private runtime copy of this config, so the secret never reaches a',
    '# shipped file.',
    '',
    'appendonly yes',
    'appendfsync everysec',
    'maxmemory-policy noeviction',
    'dir /data',
    '',
  ].join('\n');
}

/**
 * Startup script that injects `requirepass` at runtime.
 *
 * It reads `VALKEY_PASSWORD`, rejects a missing, non-URL-safe, or short
 * (< 32 chars) value, copies the base config into a private temp file
 * (`umask 077`), appends the validated password as a `requirepass` line, and
 * `exec`s `valkey-server` with that temp config. The secret never appears on
 * the command line or in any shipped file. The password is restricted to URL
 * safe characters, so it cannot contain a newline or otherwise break out of
 * the config line.
 */
export function generateValkeyStartupScript(baseConf: string = VALKEY_CONF_MOUNT): string {
  return [
    '#!/bin/sh',
    '# JSails Valkey startup: inject requirepass from $VALKEY_PASSWORD at runtime.',
    '# The password is validated, appended to a private temp config, and the',
    "# server is exec'd with that config; the secret never hits the command line.",
    'set -eu',
    '',
    'password=${VALKEY_PASSWORD-}',
    '',
    'if [ -z "$password" ]; then',
    '  echo "jsails: VALKEY_PASSWORD is required (>= 32 URL-safe characters)" >&2',
    '  exit 1',
    'fi',
    '',
    'case "$password" in',
    `  *[!${URL_SAFE_CHARS}]*)`,
    '    echo "jsails: VALKEY_PASSWORD must contain only URL-safe characters [A-Za-z0-9._~-]" >&2',
    '    exit 1',
    '    ;;',
    'esac',
    '',
    'if [ "${#password}" -lt 32 ]; then',
    '  echo "jsails: VALKEY_PASSWORD must be at least 32 characters long" >&2',
    '  exit 1',
    'fi',
    '',
    `base_conf=${baseConf}`,
    'private_conf=$(mktemp /tmp/valkey-conf.XXXXXX)',
    'trap \'rm -f "$private_conf"\' EXIT',
    '',
    '# 077 so the temp config (which holds the password) is unreadable by others.',
    'umask 077',
    '',
    '# Base config (AOF/everysec/noeviction) plus the runtime requirepass. The',
    '# password is restricted to URL-safe characters, so it cannot contain a',
    '# newline or anything that would break out of the config line.',
    'cat "$base_conf" > "$private_conf"',
    'printf \'requirepass %s\\n\' "$password" >> "$private_conf"',
    '',
    '# The temp config is removed on pre-exec failures via the trap above; after',
    '# exec it lives in the container /tmp for the lifetime of the server.',
    'exec valkey-server "$private_conf"',
    '',
  ].join('\n');
}

interface DevComposeInput {
  image: string;
  serviceName: string;
  volumeName: string;
  networkName: string;
  passwordEnv: string;
}

function buildDevCompose(input: DevComposeInput): string {
  const requireRef = `\${${input.passwordEnv}:?${input.passwordEnv} must be set in .env}`;
  return [
    '# JSails development Valkey (Docker Compose).',
    '# Private network, no published port: Valkey is reachable only by services',
    '# on the same network. Authentication is enabled via the startup script,',
    '# which reads the password from the environment at runtime.',
    'services:',
    `  ${input.serviceName}:`,
    `    image: ${input.image}`,
    '    user: valkey',
    `    command: ["sh", "${VALKEY_SCRIPT_MOUNT}"]`,
    '    volumes:',
    `      - ./valkey.conf:${VALKEY_CONF_MOUNT}:ro`,
    `      - ./start-valkey.sh:${VALKEY_SCRIPT_MOUNT}:ro`,
    `      - ${input.volumeName}:/data`,
    '    environment:',
    `      ${input.passwordEnv}: ${requireRef}`,
    `      ${REDISCLI_AUTH_ENV}: ${requireRef}`,
    '    healthcheck:',
    '      test: ["CMD", "valkey-cli", "ping"]',
    '      interval: 5s',
    '      timeout: 3s',
    '      retries: 5',
    '    restart: unless-stopped',
    '    networks:',
    `      - ${input.networkName}`,
    '',
    'networks:',
    `  ${input.networkName}:`,
    '    driver: bridge',
    '',
    'volumes:',
    `  ${input.volumeName}:`,
    '',
  ].join('\n');
}

interface DevEnvInput {
  valkeyUrlEnv: string;
  passwordEnv: string;
  serviceName: string;
  database: number;
}

function buildDevEnvExample(input: DevEnvInput): string {
  return [
    '# JSails development Valkey (copy to .env).',
    '# Valkey is bound to a private Compose network and publishes no port.',
    '# Authentication is required; the generated start-valkey.sh script validates',
    '# and applies the password below. The stock valkey image does NOT read this',
    '# variable on its own.',
    '',
    '# Required access password: at least 32 characters, URL-safe characters only',
    '# ([A-Za-z0-9._~-]). Replace the placeholder with a random value.',
    `${input.passwordEnv}=${VALKEY_SECRET_PLACEHOLDER}`,
    '',
    '# Connection URL for the app and worker. The password (after "redis://:")',
    '# must match the value above. The trailing number is the Valkey database',
    '# index. The scheme stays redis:// because ioredis/BullMQ/Socket.IO speak',
    '# that protocol.',
    `${input.valkeyUrlEnv}=redis://:${VALKEY_SECRET_PLACEHOLDER}@${input.serviceName}:6379/${input.database}`,
    '',
  ].join('\n');
}

/**
 * Generate the development Valkey addon: a `docker-compose.yml` fragment, a
 * `valkey.conf`, a `start-valkey.sh` startup script, and a `.env` example.
 * Returns strings only; nothing is run or written to disk.
 */
export function generateDevValkeyConfig(options: ValkeyConfigOptions = {}): ValkeyConfigFiles {
  const image = assertPinnedImage(
    options.image ?? VALKEY_DEFAULT_IMAGE,
    'options.image',
    ValkeyConfigError,
  );
  const database = assertDatabase(options.database ?? 0, 'options.database');
  const serviceName = assertIdentifier(
    options.serviceName ?? VALKEY_DEFAULT_SERVICE,
    'options.serviceName',
    ValkeyConfigError,
  );
  const volumeName = assertIdentifier(
    options.volumeName ?? VALKEY_DEFAULT_VOLUME,
    'options.volumeName',
    ValkeyConfigError,
  );
  const networkName = assertIdentifier(
    options.networkName ?? VALKEY_DEFAULT_NETWORK,
    'options.networkName',
    ValkeyConfigError,
  );
  const valkeyUrlEnv = assertEnvName(
    options.valkeyUrlEnv ?? VALKEY_DEFAULT_URL_ENV,
    'options.valkeyUrlEnv',
  );
  const passwordEnv = assertEnvName(
    options.passwordEnv ?? VALKEY_DEFAULT_PASSWORD_ENV,
    'options.passwordEnv',
  );

  return {
    compose: buildDevCompose({ image, serviceName, volumeName, networkName, passwordEnv }),
    valkeyConfig: generateValkeyConf(),
    startupScript: generateValkeyStartupScript(),
    envExample: buildDevEnvExample({ valkeyUrlEnv, passwordEnv, serviceName, database }),
  };
}
