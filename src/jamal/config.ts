/**
 * Jamal v1 configuration model.
 *
 * Jamal is becoming a TypeScript reimplementation of Kamal + Sail, and its
 * configuration is a SINGLE file: a plain ESM module named `jamal.config.js`
 * in the project root, whose default export is a {@link JamalConfig} object.
 * There is no `mode` concept — one file drives both local development and
 * production, with the environment-specific settings carried in the
 * non-destructive `local` and `production` overlay sections (DDEV's
 * `config.<env>` override pattern).
 *
 * The config layer is deliberately narrow and side-effect free:
 *
 * - {@link secret} builds a {@link SecretRef} — a branded reference that names
 *   a secret but never holds or resolves its value. The schema accepts a
 *   string or a `SecretRef` anywhere in `env`; resolution (reading the value
 *   from a vault, `.env`, or the host) is a later slice's job, never this
 *   module's.
 * - The Zod schema is strict: unknown keys and unsafe values (control
 *   characters, malformed/traversal volume paths, out-of-range ports) are
 *   rejected with {@link JamalConfigError}s whose messages are value-free.
 * - {@link normalizeJamalConfig} validates and merges base + overlays into a
 *   deeply frozen model without mutating the input; {@link loadJamalConfig}
 *   imports `<cwd>/jamal.config.js` and returns the same normalized model.
 * - {@link redactJamalConfig} produces plan-safe output in which every
 *   `SecretRef` renders as `secret(<name>)`, so `JSON.stringify` of the
 *   redacted model never contains a resolved secret value.
 *
 * No environment variable is read and no file is written here.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { isPlainObject } from '../internal/json-safe.js';

/** Default config module name, resolved against the working directory. */
export const DEFAULT_JAMAL_CONFIG_PATH = 'jamal.config.js';

/** C0 controls plus DEL — never valid in a config string. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** Record keys that would collide with `Object.prototype` when spread. */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Upper bound on a published port. */
const MAX_PORT = 65535;

/** Raised for any missing or invalid jamal config. Messages never embed input. */
export class JamalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JamalConfigError';
  }
}

/**
 * A branded reference to a secret by name. It never holds, resolves, or
 * serializes a secret value: `toString`/`toJSON` render the redacted
 * `secret(<name>)` form, so a `SecretRef` can be stringified for plans and
 * logs without leaking anything beyond its name. Class identity (`instanceof`)
 * is the brand — a plain `{ name: 'X' }` object is never a `SecretRef`.
 */
export class SecretRef {
  /** The secret's name, e.g. `DB_PASSWORD`. */
  readonly name: string;

  constructor(name: string) {
    assertSecretName(name);
    this.name = name;
  }

  /** Redacted form; never a resolved value. */
  toString(): string {
    return `secret(${this.name})`;
  }

  /** Keep `JSON.stringify` value-free: render the redacted form, not the name object. */
  toJSON(): string {
    return this.toString();
  }
}

/** A name is an identifier: non-empty, no whitespace or control characters. */
function assertSecretName(name: string): void {
  if (name.length === 0 || /\s/.test(name) || CONTROL_CHARS.test(name)) {
    throw new JamalConfigError(
      'secret names must be non-empty and contain no whitespace or control characters',
    );
  }
}

/**
 * Build a {@link SecretRef} for the given secret name. The reference is
 * validated but never resolved; the config layer treats it as opaque.
 */
export function secret(name: string): SecretRef {
  return new SecretRef(name);
}

/** A structured env entry with an optional alias and a clear flag. */
export interface JamalEnvEntry {
  readonly value: string | SecretRef;
  readonly alias: string | undefined;
  readonly clear: boolean;
}

/** A value in `env`: a literal string, a secret reference, or a structured entry. */
export type JamalEnvValue = string | SecretRef | JamalEnvEntry;

/** A parsed volume specification for `config.volumes`. */
export interface JamalVolumeSpec {
  /** Named volume name or host path. */
  readonly source: string;
  /** Absolute container mount path. */
  readonly containerPath: string;
  /** Access mode: `'ro'` or `'rw'`, or undefined. */
  readonly options: string | undefined;
  /** Whether the source is a host path rather than a named Docker volume. */
  readonly host: boolean;
}

/**
 * Services a Jamal app may declare. `mariadb`/`postgres`/`valkey` are backing
 * services (data/state stores the app depends on); `mailpit`/`adminer` are
 * dev-only tools rendered by the local Compose planner and ignored everywhere
 * else (the production planner never reads `services`).
 */
export type JamalServiceType = 'mariadb' | 'postgres' | 'valkey' | 'mailpit' | 'adminer';

/** Health-check settings: a path plus poll intervals. */
export interface JamalHealthConfig {
  /** An absolute path starting with `/`. */
  readonly path: string;
  /** Timeout per probe, in milliseconds (positive integer). */
  readonly timeoutMs: number;
  /** Interval between probes, in milliseconds (positive integer). */
  readonly intervalMs: number;
  /** Number of retries (>= 0); undefined means the executor default. */
  readonly retries: number | undefined;
  /** Delay between retry attempts, in milliseconds (> 0). */
  readonly retryDelayMs: number | undefined;
  /** Sleep before the first health probe, in milliseconds (> 0). */
  readonly readinessDelayMs: number | undefined;
}

/** SSH connection options for the production server. */
export interface JamalSshConfig {
  readonly user: string | undefined;
  readonly port: number | undefined;
  readonly proxyCommand: string | undefined;
  readonly logLevel: string | undefined;
  readonly keysOnly: boolean;
  readonly keys: readonly string[];
  readonly config: string | undefined;
  readonly forwardAgent: boolean;
}

/** A declared backing service. */
export interface JamalServiceConfig {
  readonly type: JamalServiceType;
}

/** Registry credentials for the production image host. */
export interface JamalRegistryConfig {
  readonly server: string;
  readonly username: string;
}

/** The local-development overlay: published ports and an optional build flag. */
export interface JamalLocalConfig {
  /** Port name -> published port (1..65535). */
  readonly ports: Readonly<Record<string, number>>;
  /** Whether to build the image locally instead of pulling. */
  readonly build: boolean;
}

/** The production overlay: the target server, optional domain/on-demand TLS, and registry. */
export interface JamalProductionConfig {
  readonly server: string;
  readonly domain: string | undefined;
  /**
   * On-demand TLS allowlist URL for kamal-proxy. Mutually exclusive with a
   * static `domain`: when set, the proxy routes unknown hostnames and authorizes
   * each at certificate-issuance time by calling this URL. An absolute
   * `http://`/`https://` URL or a local path starting with `/`.
   */
  readonly onDemandTlsUrl: string | undefined;
  readonly registry: JamalRegistryConfig | undefined;
  readonly ssh: JamalSshConfig | undefined;
}

/** Logging driver + options for container run step. */
export interface JamalLoggingConfig {
  readonly driver: string;
  readonly options: Readonly<Record<string, string>>;
}

/** The normalized, frozen v1 config model (base fields plus both overlays). */
export interface JamalConfig {
  readonly service: string;
  readonly image: string;
  readonly command: string | undefined;
  readonly health: JamalHealthConfig | undefined;
  readonly env: Readonly<Record<string, JamalEnvEntry>>;
  readonly services: Readonly<Record<string, JamalServiceConfig>>;
  readonly volumes: Readonly<Record<string, JamalVolumeSpec>>;
  readonly local: JamalLocalConfig;
  readonly production: JamalProductionConfig | undefined;
  readonly logging: JamalLoggingConfig | undefined;
}

/** Plan-safe model: identical to {@link JamalConfig} but with `env` values as strings. */
export interface RedactedJamalConfig {
  readonly service: string;
  readonly image: string;
  readonly command: string | undefined;
  readonly health: JamalHealthConfig | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly services: Readonly<Record<string, JamalServiceConfig>>;
  readonly volumes: Readonly<Record<string, JamalVolumeSpec>>;
  readonly local: JamalLocalConfig;
  readonly production: JamalProductionConfig | undefined;
  readonly logging: JamalLoggingConfig | undefined;
}

// ---------------------------------------------------------------------------
// Schema (shape + type + range checks; safety checks live in the resolver)
// ---------------------------------------------------------------------------

const serviceTypeSchema = z.enum(['mariadb', 'postgres', 'valkey', 'mailpit', 'adminer']);

const envEntrySchema = z
  .object({
    value: z.union([z.string(), z.instanceof(SecretRef)]),
    alias: z.string().optional(),
    clear: z.boolean().optional(),
  })
  .strict();

const envValueSchema = z.union([z.string(), z.instanceof(SecretRef), envEntrySchema]);

const healthSchema = z
  .object({
    path: z.string(),
    timeoutMs: z.number().int().positive(),
    intervalMs: z.number().int().positive(),
    retries: z.number().int().min(0).optional(),
    retryDelayMs: z.number().int().positive().optional(),
    readinessDelayMs: z.number().int().positive().optional(),
  })
  .strict();

const loggingSchema = z
  .object({
    driver: z.string(),
    options: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const sshSchema = z
  .object({
    user: z.string().optional(),
    port: z.number().int().min(1).max(MAX_PORT).optional(),
    proxyCommand: z.string().optional(),
    logLevel: z.string().optional(),
    keysOnly: z.boolean().optional(),
    keys: z.array(z.string()).optional(),
    config: z.string().optional(),
    forwardAgent: z.boolean().optional(),
  })
  .strict();

const serviceConfigSchema = z
  .object({
    type: serviceTypeSchema,
  })
  .strict();

const localSchema = z
  .object({
    ports: z.record(z.string(), z.number().int().min(1).max(MAX_PORT)).optional(),
    build: z.boolean().optional(),
  })
  .strict();

const registrySchema = z
  .object({
    server: z.string().min(1),
    username: z.string().min(1),
  })
  .strict();

const productionSchema = z
  .object({
    server: z.string().min(1),
    domain: z.string().min(1).optional(),
    onDemandTlsUrl: z.string().min(1).optional(),
    registry: registrySchema.optional(),
    ssh: sshSchema.optional(),
  })
  .strict();

const jamalConfigSchema = z
  .object({
    service: z.string().min(1),
    image: z.string().min(1),
    command: z.string().optional(),
    health: healthSchema.optional(),
    env: z.record(z.string(), envValueSchema).optional(),
    services: z.record(z.string(), serviceConfigSchema).optional(),
    volumes: z.record(z.string(), z.string()).optional(),
    local: localSchema.optional(),
    production: productionSchema.optional(),
    logging: loggingSchema.optional(),
  })
  .strict();

/** The parsed (unresolved) shape produced by the schema. */
type ParsedJamalConfig = z.infer<typeof jamalConfigSchema>;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Dynamically import `<cwd>/jamal.config.js` and return the normalized model.
 * A missing module, an import failure, or a module without a default export
 * each raise a distinct, value-free {@link JamalConfigError}. Importing the
 * module runs its own top-level code (inherent to ESM); this loader never
 * invokes a callback and never opens a connection.
 */
export async function loadJamalConfig(cwd: string = process.cwd()): Promise<JamalConfig> {
  const configPath = resolve(cwd, DEFAULT_JAMAL_CONFIG_PATH);
  if (!existsSync(configPath)) {
    throw new JamalConfigError(`jamal config "${DEFAULT_JAMAL_CONFIG_PATH}" not found in ${cwd}`);
  }
  let module: unknown;
  try {
    module = await import(pathToFileURL(configPath).href);
  } catch {
    // The module's own exception text may embed secrets; never re-throw it.
    throw new JamalConfigError(`failed to load jamal config "${DEFAULT_JAMAL_CONFIG_PATH}"`);
  }
  const defaultExport = (module as { default?: unknown }).default;
  if (defaultExport === undefined) {
    throw new JamalConfigError(
      `jamal config "${DEFAULT_JAMAL_CONFIG_PATH}" must default-export a config object`,
    );
  }
  return normalizeJamalConfig(defaultExport);
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Validate `raw` and return the normalized, deeply frozen model. The input is
 * never mutated. Base fields and the `local`/`production` overlays are merged
 * non-destructively — an overlay field wins over a base field of the same name,
 * and every other base field is retained. In v1 the overlays carry disjoint
 * fields (`local` = ports/build, `production` = server/domain/registry), so the
 * merge is additive; the precedence rule is stated for future overlay fields.
 *
 * Any non-{@link JamalConfigError} thrown while reading `raw` (for example a
 * throwing property getter) is replaced by a value-free error with no cause.
 */
export function normalizeJamalConfig(raw: unknown): JamalConfig {
  try {
    return resolveJamalConfig(raw);
  } catch (error) {
    if (error instanceof JamalConfigError) {
      throw error;
    }
    throw new JamalConfigError('the jamal config could not be read');
  }
}

function resolveJamalConfig(raw: unknown): JamalConfig {
  if (!isPlainObject(raw)) {
    throw new JamalConfigError('the jamal config must be a plain object');
  }
  // Zod's record parser assigns `result[key] = value`, so an own `__proto__`
  // key (for example from JSON.parse'd input) is silently dropped before the
  // post-parse safety checks run. Scan the raw input first to reject it.
  assertNoDangerousKeys(raw);
  const result = jamalConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new JamalConfigError(result.error.issues.map(describeIssue).join('; '));
  }
  assertSafeConfig(result.data);
  return deepFreeze(buildModel(result.data));
}

/** Map a Zod issue to a value-free message, naming the top-level field only. */
function describeIssue(issue: z.ZodIssue): string {
  if (issue.code === 'unrecognized_keys') {
    return 'config has an unrecognized field';
  }
  const top = typeof issue.path[0] === 'string' ? issue.path[0] : 'config';
  switch (issue.code) {
    case 'invalid_type':
      return `config.${top} has an invalid type`;
    case 'too_small':
      return `config.${top} is below the minimum`;
    case 'too_big':
      return `config.${top} is above the maximum`;
    case 'invalid_value':
    case 'custom':
      return `config.${top} has an invalid value`;
    default:
      return `config.${top} is invalid`;
  }
}

// ---------------------------------------------------------------------------
// Safety checks (value-free; no input value is ever echoed)
// ---------------------------------------------------------------------------

function assertNoControlChars(value: string, field: string): void {
  if (CONTROL_CHARS.test(value)) {
    throw new JamalConfigError(`config.${field} must not contain control characters`);
  }
}

/**
 * Reject own keys that collide with `Object.prototype` before Zod parsing.
 * Zod's record parser reassigns entries onto a fresh object, so an own
 * `__proto__` key (producible via `JSON.parse`) is silently dropped before the
 * post-parse `assertRecordKey` runs; this scan closes that gap.
 */
function assertNoDangerousKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoDangerousKeys(item);
    }
    return;
  }
  if (typeof value !== 'object' || value === null || value instanceof SecretRef) {
    return;
  }
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new JamalConfigError('config contains a reserved key');
    }
  }
  for (const child of Object.values(value)) {
    assertNoDangerousKeys(child);
  }
}

function assertRecordKey(key: string, field: string): void {
  if (key.length === 0) {
    throw new JamalConfigError(`config.${field} keys must be non-empty`);
  }
  if (CONTROL_CHARS.test(key)) {
    throw new JamalConfigError(`config.${field} keys must not contain control characters`);
  }
  if (DANGEROUS_KEYS.has(key)) {
    throw new JamalConfigError(`config.${field} keys must not use a reserved key`);
  }
}

function assertHealthPath(path: string): void {
  if (!path.startsWith('/')) {
    throw new JamalConfigError('config.health.path must start with "/"');
  }
  if (path.includes('\\') || CONTROL_CHARS.test(path)) {
    throw new JamalConfigError(
      'config.health.path must not contain a backslash or control characters',
    );
  }
}

/**
 * Validate an on-demand TLS allowlist URL: an absolute `http://` or `https://`
 * URL, or a local path starting with `/`. Rejects whitespace/control characters
 * (so the value is a single unambiguous token) and any other scheme.
 */
function assertOnDemandTlsUrl(value: string): void {
  if (CONTROL_CHARS.test(value) || /\s/.test(value)) {
    throw new JamalConfigError(
      'config.production.onDemandTlsUrl must not contain whitespace or control characters',
    );
  }
  if (!value.startsWith('http://') && !value.startsWith('https://') && !value.startsWith('/')) {
    throw new JamalConfigError(
      'config.production.onDemandTlsUrl must be an absolute http:// or https:// URL, ' +
        'or a local path starting with "/"',
    );
  }
}

function assertVolumeName(name: string): void {
  if (name.length === 0) {
    throw new JamalConfigError('config.volumes names must be non-empty');
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new JamalConfigError('config.volumes names must not contain a path separator');
  }
  if (name === '.' || name === '..') {
    throw new JamalConfigError('config.volumes names must not be "." or ".."');
  }
  if (CONTROL_CHARS.test(name)) {
    throw new JamalConfigError('config.volumes names must not contain control characters');
  }
  if (DANGEROUS_KEYS.has(name)) {
    throw new JamalConfigError('config.volumes names must not use a reserved key');
  }
}

function assertContainerPath(path: string): void {
  if (!path.startsWith('/')) {
    throw new JamalConfigError(
      'config.volumes values must be absolute container paths starting with "/"',
    );
  }
  if (path.includes('\\') || CONTROL_CHARS.test(path)) {
    throw new JamalConfigError(
      'config.volumes values must not contain a backslash or control characters',
    );
  }
  for (const segment of path.split('/')) {
    if (segment === '..') {
      throw new JamalConfigError('config.volumes values must not contain a ".." traversal segment');
    }
  }
}

/** Reject a host volume source that carries a backslash, control characters, or ".." traversal. */
function assertHostPath(source: string): void {
  if (source.includes('\\')) {
    throw new JamalConfigError('config.volumes host paths must not contain a backslash');
  }
  if (CONTROL_CHARS.test(source)) {
    throw new JamalConfigError('config.volumes host paths must not contain control characters');
  }
  if (source.includes('..')) {
    throw new JamalConfigError(
      'config.volumes host paths must not contain a ".." traversal segment',
    );
  }
}

/**
 * Parse a volume value string into a {@link JamalVolumeSpec}. A value is a
 * named volume when its first colon-delimited segment is an identifier (no `/`,
 * no leading `.`), otherwise it is a host path. Host paths are detected by a
 * leading `/`, `./`, or `$PWD/`.
 *
 * Named volume form: `"<name>:<containerPath>"`
 * Host volume form:  `"<hostPath>:<containerPath>[:ro|rw]"`
 *
 * `$PWD/` host sources are preserved verbatim (the shell or Compose resolves
 * them); the parser never reads the filesystem.
 */
export function parseVolumeSpec(value: string): JamalVolumeSpec {
  const parts = value.split(':');

  // No colon: backward-compatible named volume (value is just the container path).
  if (parts.length === 1) {
    const containerPath = parts[0]!;
    assertContainerPath(containerPath);
    return Object.freeze({ source: '', containerPath, options: undefined, host: false });
  }

  // split always returns at least one element for any string input.
  const firstSegment = parts[0]!;
  const isHost =
    firstSegment.startsWith('/') ||
    firstSegment.startsWith('./') ||
    firstSegment.startsWith('$PWD/');

  if (isHost) {
    // Find the container path: the segment starting with '/',
    // skipping index 0 (which is part of the host source).
    let containerIdx = -1;
    for (let i = 1; i < parts.length; i++) {
      if (parts[i]!.startsWith('/')) {
        containerIdx = i;
        break;
      }
    }
    if (containerIdx < 0) {
      throw new JamalConfigError(
        'config.volumes values must include an absolute container path starting with "/"',
      );
    }
    const source = parts.slice(0, containerIdx).join(':');
    const containerPath = parts[containerIdx]!;
    const optionsPart = parts[containerIdx + 1];

    let options: string | undefined = undefined;
    if (optionsPart !== undefined) {
      if (optionsPart === 'ro' || optionsPart === 'rw') {
        options = optionsPart;
      } else {
        throw new JamalConfigError('config.volumes options must be "ro" or "rw"');
      }
    }

    assertHostPath(source);
    assertContainerPath(containerPath);

    return Object.freeze({ source, containerPath, options, host: true });
  }

  // Named volume: exactly two segments.
  if (parts.length !== 2) {
    throw new JamalConfigError('config.volumes values must be "<name>:<containerPath>"');
  }

  const name = parts[0]!;
  const containerPath = parts[1]!;

  assertVolumeName(name);
  assertContainerPath(containerPath);

  return Object.freeze({ source: name, containerPath, options: undefined, host: false });
}

/** A Zod-parsed env entry shape. */
type ParsedEnvEntry = { value: string | SecretRef; alias?: string; clear?: boolean };

/** Structural guard for an env entry object (not a string or SecretRef). */
function isEnvEntry(value: unknown): value is ParsedEnvEntry {
  return (
    typeof value === 'object' && value !== null && !(value instanceof SecretRef) && 'value' in value
  );
}

type ParsedSshConfig = z.infer<typeof sshSchema>;

function assertSafeToken(value: string, field: string): void {
  if (CONTROL_CHARS.test(value) || /\s/.test(value)) {
    throw new JamalConfigError(`config.${field} must not contain whitespace or control characters`);
  }
}

function assertSshConfig(ssh: ParsedSshConfig): void {
  if (ssh.user !== undefined) {
    if (ssh.user.startsWith('-')) {
      throw new JamalConfigError('config.production.ssh.user must not start with "-"');
    }
    assertSafeToken(ssh.user, 'production.ssh.user');
  }
  if (ssh.proxyCommand !== undefined) {
    assertSafeToken(ssh.proxyCommand, 'production.ssh.proxyCommand');
  }
  if (ssh.logLevel !== undefined) {
    assertSafeToken(ssh.logLevel, 'production.ssh.logLevel');
  }
  if (ssh.config !== undefined) {
    assertSafeToken(ssh.config, 'production.ssh.config');
  }
  for (const key of ssh.keys ?? []) {
    assertSafeToken(key, 'production.ssh.keys');
  }
}

function assertSafeConfig(config: ParsedJamalConfig): void {
  assertNoControlChars(config.service, 'service');
  assertNoControlChars(config.image, 'image');
  if (config.command !== undefined) {
    assertNoControlChars(config.command, 'command');
  }
  if (config.health !== undefined) {
    assertHealthPath(config.health.path);
  }
  for (const [key, value] of Object.entries(config.env ?? {})) {
    assertRecordKey(key, 'env');
    if (typeof value === 'string') {
      assertNoControlChars(value, 'env');
    }
    if (isEnvEntry(value)) {
      if (typeof value.value === 'string') {
        assertNoControlChars(value.value, 'env');
      }
      if (value.alias !== undefined) {
        assertSafeToken(value.alias, 'env');
        if (DANGEROUS_KEYS.has(value.alias)) {
          throw new JamalConfigError('config.env aliases must not use a reserved key');
        }
      }
    }
  }
  for (const key of Object.keys(config.services ?? {})) {
    assertRecordKey(key, 'services');
  }
  for (const [name, value] of Object.entries(config.volumes ?? {})) {
    assertVolumeName(name);
    parseVolumeSpec(value);
  }
  for (const key of Object.keys(config.local?.ports ?? {})) {
    assertRecordKey(key, 'local.ports');
  }
  if (config.production !== undefined) {
    assertNoControlChars(config.production.server, 'production.server');
    if (config.production.domain !== undefined) {
      assertNoControlChars(config.production.domain, 'production.domain');
    }
    if (config.production.onDemandTlsUrl !== undefined) {
      assertOnDemandTlsUrl(config.production.onDemandTlsUrl);
    }
    if (config.production.domain !== undefined && config.production.onDemandTlsUrl !== undefined) {
      throw new JamalConfigError(
        'config.production.domain and config.production.onDemandTlsUrl are mutually exclusive',
      );
    }
    if (config.production.registry !== undefined) {
      assertNoControlChars(config.production.registry.server, 'production.registry.server');
      assertNoControlChars(config.production.registry.username, 'production.registry.username');
    }
    if (config.production.ssh !== undefined) {
      assertSshConfig(config.production.ssh);
    }
  }
  if (config.logging !== undefined) {
    assertSafeToken(config.logging.driver, 'logging.driver');
    for (const [key, value] of Object.entries(config.logging.options ?? {})) {
      assertSafeToken(key, 'logging.options');
      assertSafeToken(value, 'logging.options');
    }
  }
}

// ---------------------------------------------------------------------------
// Model assembly + redaction
// ---------------------------------------------------------------------------

/** Assemble the normalized model from parsed data, applying defaults. */
function buildModel(config: ParsedJamalConfig): JamalConfig {
  return {
    service: config.service,
    image: config.image,
    command: config.command,
    health:
      config.health === undefined
        ? undefined
        : {
            path: config.health.path,
            timeoutMs: config.health.timeoutMs,
            intervalMs: config.health.intervalMs,
            retries: config.health.retries,
            retryDelayMs: config.health.retryDelayMs,
            readinessDelayMs: config.health.readinessDelayMs,
          },
    env: Object.freeze(
      Object.fromEntries(
        Object.entries(config.env ?? {}).map(([name, value]) => {
          if (typeof value === 'string' || value instanceof SecretRef) {
            return [name, Object.freeze({ value, alias: undefined, clear: false })];
          }
          return [
            name,
            Object.freeze({
              value: value.value,
              alias: value.alias,
              clear: value.clear ?? false,
            }),
          ];
        }),
      ),
    ),
    services: { ...(config.services ?? {}) },
    volumes: Object.freeze(
      Object.fromEntries(
        Object.entries(config.volumes ?? {}).map(([name, value]) => {
          const spec = parseVolumeSpec(value);
          // Named volumes in backward-compatible format (no source in value)
          // default source to the volume name.
          if (!spec.host && spec.source === '') {
            return [name, Object.freeze({ ...spec, source: name })];
          }
          return [name, spec];
        }),
      ),
    ),
    local: {
      ports: { ...(config.local?.ports ?? {}) },
      build: config.local?.build ?? false,
    },
    logging:
      config.logging === undefined
        ? undefined
        : {
            driver: config.logging.driver,
            options: { ...(config.logging.options ?? {}) },
          },
    production:
      config.production === undefined
        ? undefined
        : {
            server: config.production.server,
            domain: config.production.domain,
            onDemandTlsUrl: config.production.onDemandTlsUrl,
            registry:
              config.production.registry === undefined
                ? undefined
                : { ...config.production.registry },
            ssh:
              config.production.ssh === undefined
                ? undefined
                : {
                    user: config.production.ssh.user,
                    port: config.production.ssh.port,
                    proxyCommand: config.production.ssh.proxyCommand,
                    logLevel: config.production.ssh.logLevel,
                    keysOnly: config.production.ssh.keysOnly ?? false,
                    keys: [...(config.production.ssh.keys ?? [])],
                    config: config.production.ssh.config,
                    forwardAgent: config.production.ssh.forwardAgent ?? false,
                  },
          },
  };
}

/**
 * Return a plan-safe deep copy of the model in which every {@link SecretRef} in
 * `env` is rendered as `secret(<name>)`. The output never contains a resolved
 * secret value (it never held one), so `JSON.stringify` of the result is safe
 * to print, persist, or hand to a plan. The model itself is not mutated.
 */
export function redactJamalConfig(model: JamalConfig): RedactedJamalConfig {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(model.env)) {
    const v = value.value;
    env[key] = v instanceof SecretRef ? v.toString() : v;
  }
  return deepFreeze({
    service: model.service,
    image: model.image,
    command: model.command,
    health:
      model.health === undefined
        ? undefined
        : {
            path: model.health.path,
            timeoutMs: model.health.timeoutMs,
            intervalMs: model.health.intervalMs,
            retries: model.health.retries,
            retryDelayMs: model.health.retryDelayMs,
            readinessDelayMs: model.health.readinessDelayMs,
          },
    env,
    services: { ...model.services },
    volumes: { ...model.volumes },
    local: { ports: { ...model.local.ports }, build: model.local.build },
    logging:
      model.logging === undefined
        ? undefined
        : { driver: model.logging.driver, options: { ...model.logging.options } },
    production:
      model.production === undefined
        ? undefined
        : {
            server: model.production.server,
            domain: model.production.domain,
            onDemandTlsUrl: model.production.onDemandTlsUrl,
            registry:
              model.production.registry === undefined
                ? undefined
                : { ...model.production.registry },
            ssh:
              model.production.ssh === undefined
                ? undefined
                : {
                    user: model.production.ssh.user,
                    port: model.production.ssh.port,
                    proxyCommand: model.production.ssh.proxyCommand,
                    logLevel: model.production.ssh.logLevel,
                    keysOnly: model.production.ssh.keysOnly,
                    keys: [...model.production.ssh.keys],
                    config: model.production.ssh.config,
                    forwardAgent: model.production.ssh.forwardAgent,
                  },
          },
  });
}

/** Deep-freeze a value, recursing into plain objects but leaving SecretRefs alone. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || value instanceof SecretRef) {
    return value;
  }
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
