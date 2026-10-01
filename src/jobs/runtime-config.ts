/**
 * Runtime configuration for the jobs CLI (`work` / `schedule`).
 *
 * The runtime config is a plain ESM module (`.js` or `.mjs`) that
 * default-exports an object describing the job registry, the Valkey/Redis
 * connection (or a custom adapter), and optional schedules:
 *
 *     export default {
 *       registry: createRegistry({ ... }),
 *       valkeyUrl: 'redis://...',   // or legacy `redisUrl`
 *       schedules: [{ id, job, cron }],
 *       queueName: 'default',
 *       prefix: 'bull',
 *       concurrency: 1,
 *       // alternative to valkeyUrl: a custom JobRuntimeAdapter (no URL needed)
 *       adapter: { name, createProducer, createWorker, upsertSchedules? },
 *     };
 *
 * Valkey is the default vocabulary: `valkeyUrl` is preferred, `redisUrl` is a
 * legacy alias, and the `VALKEY_URL` / `REDIS_URL` environment variables are
 * the last resort. The internal library APIs keep their `redisUrl` name; only
 * this config boundary maps the preferred/legacy names to the single resolved
 * `redis://`/`rediss://` URL handed to the built-in BullMQ adapter. URL
 * validation is explicit about the scheme and never echoes the value (a URL
 * may embed a password).
 *
 * When `adapter` is supplied, it is selected verbatim: the custom adapter owns
 * its transport, so no Valkey/Redis URL is required, read, or validated, and
 * the built-in BullMQ adapter is never constructed. A malformed adapter
 * (missing non-empty `name`, `createProducer`, or `createWorker`, or a
 * non-function `upsertSchedules`) is rejected without invoking any factory.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createBullMQAdapter } from './bullmq-adapter.js';
import { DEFAULT_PREFIX, DEFAULT_QUEUE_NAME } from './connection.js';
import { createRegistry, type JobDefinition, type JobRegistry } from './registry.js';
import { validateJobRuntimeAdapter, type JobRuntimeAdapter } from './runtime.js';
import type { ScheduleSpec } from './scheduler.js';

/** Default runtime config path for the `work` / `schedule` commands. */
export const DEFAULT_RUNTIME_CONFIG_PATH = 'jsails.runtime.js';

/** Error raised for any invalid runtime config or connection URL. */
export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
  }
}

/** The shape a runtime config module default-exports. */
export interface RuntimeConfig {
  /** Job name -> `{ schema, handler }`. Validated structurally, never executed. */
  readonly registry: JobRegistry;
  /**
   * Optional custom job runtime adapter. When present, it is used as-is (its
   * identity is preserved) and no Valkey/Redis URL is required, read, or
   * validated. When absent, the built-in BullMQ adapter is constructed from the
   * resolved Valkey/Redis URL.
   */
  readonly adapter?: JobRuntimeAdapter;
  /** Valkey/Redis URL (preferred). */
  readonly valkeyUrl?: string;
  /** Legacy alias of `valkeyUrl`. */
  readonly redisUrl?: string;
  /** Schedules to register. Defaults to `[]`. */
  readonly schedules?: readonly ScheduleSpec[];
  /** Queue name. Defaults to `"default"`. */
  readonly queueName?: string;
  /** Redis key prefix. Defaults to `"bull"`. */
  readonly prefix?: string;
  /** Worker concurrency. Defaults to 1. */
  readonly concurrency?: number;
}

/** A fully validated runtime config with the selected adapter bound. */
export interface ResolvedRuntimeConfig {
  readonly registry: JobRegistry;
  /**
   * The adapter the runtime must run against: the custom `config.adapter` when
   * provided (identity preserved), otherwise the built-in BullMQ adapter built
   * from the resolved URL. The CLI drives this adapter through the same neutral
   * job-runtime contract, not a separate built-in path.
   */
  readonly selectedAdapter: JobRuntimeAdapter;
  /**
   * The resolved `redis://`/`rediss://` URL handed to the built-in adapter.
   * Absent (`undefined`) when a custom adapter was supplied: that adapter owns
   * its transport and needs no URL.
   */
  readonly redisUrl?: string;
  readonly schedules: readonly ScheduleSpec[];
  readonly queueName: string;
  readonly prefix: string;
  readonly concurrency: number;
}

/** Whether the path is a TypeScript module that has not been compiled. */
function isTypeScriptConfig(path: string): boolean {
  return /\.(?:ts|mts|cts)$/.test(path);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Import the runtime config module and return its default export. Rejects
 * TypeScript paths (compile first) and wraps import failures without echoing
 * module internals beyond the author's own error message.
 */
export async function loadRuntimeConfigModule(configPath: string): Promise<unknown> {
  const absolute = resolve(configPath);
  if (isTypeScriptConfig(absolute)) {
    throw new RuntimeConfigError(
      `config "${configPath}" is a TypeScript module; compile it to JavaScript first ` +
        `(e.g. tsc) and point --config at the compiled output`,
    );
  }
  let module: unknown;
  try {
    module = await import(pathToFileURL(absolute).href);
  } catch (error) {
    throw new RuntimeConfigError(
      `failed to load runtime config "${configPath}": ${formatError(error)}`,
    );
  }
  return (module as { default?: unknown }).default;
}

/**
 * Validate a connection URL is an explicit `redis://` or `rediss://` URL. The
 * value is never included in the error message: a URL may embed a password.
 */
export function assertRedisUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RuntimeConfigError(
      'the Valkey/Redis connection URL must be a non-empty redis:// or rediss:// URL',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RuntimeConfigError(
      'the Valkey/Redis connection URL must be a valid redis:// or rediss:// URL',
    );
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new RuntimeConfigError(
      'the Valkey/Redis connection URL must use the redis:// or rediss:// scheme',
    );
  }
  return value;
}

/**
 * Resolve the connection URL with the documented precedence:
 * `config.valkeyUrl` -> `config.redisUrl` -> `env.VALKEY_URL` -> `env.REDIS_URL`.
 * The resolved value is validated as an explicit `redis://`/`rediss://` URL.
 */
export function resolveRuntimeRedisUrl(
  config: { valkeyUrl?: unknown; redisUrl?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidate = config.valkeyUrl ?? config.redisUrl ?? env.VALKEY_URL ?? env.REDIS_URL;
  if (candidate === undefined || candidate === null) {
    throw new RuntimeConfigError(
      'no Valkey/Redis URL configured: set `valkeyUrl` (or `redisUrl`) in the runtime ' +
        'config, or set VALKEY_URL (or REDIS_URL) in the environment',
    );
  }
  return assertRedisUrl(candidate);
}

/** Validate the registry shape without executing any job handler. */
function validateRegistry(value: unknown): JobRegistry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeConfigError(
      'config.registry must be an object mapping job names to { schema, handler }',
    );
  }
  // createRegistry checks that every entry has a schema and a function handler;
  // it never invokes a handler.
  return createRegistry(value as Record<string, JobDefinition>);
}

function validateString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value === '') {
    throw new RuntimeConfigError(`${label} must be a non-empty string`);
  }
  return value;
}

function validateConcurrency(value: unknown): number {
  if (value === undefined) {
    return 1;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new RuntimeConfigError('config.concurrency must be a positive integer');
  }
  return value;
}

/**
 * Validate a user-supplied adapter's shape (non-empty `name`, `createProducer`,
 * `createWorker`, optional `upsertSchedules`) without invoking any factory, and
 * return it unchanged so its identity is preserved. Reuses the runtime's own
 * contract check so config validation and `createJobsRuntime` never disagree;
 * its value-free messages are wrapped in a `RuntimeConfigError`.
 */
function validateAdapter(value: unknown): JobRuntimeAdapter {
  try {
    validateJobRuntimeAdapter(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimeConfigError(`config.adapter is invalid: ${detail}`);
  }
  return value;
}

/**
 * Validate the runtime config default export: the registry structure (without
 * executing handlers), the selected adapter, and the queue/prefix/concurrency/
 * schedules shape. With a custom `adapter` no URL is required or read; without
 * one, the URL is resolved (valkeyUrl -> redisUrl -> env) and the built-in
 * BullMQ adapter is constructed from it (lazily — no connection yet).
 * Schedules are checked to be an array here; the per-schedule validation
 * (known jobs, exclusivity, payload) is left to `upsertSchedules`, which
 * validates the whole list before any registration.
 */
export function validateRuntimeConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedRuntimeConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RuntimeConfigError('the runtime config must default-export an object');
  }
  const config = raw as Record<string, unknown>;

  const registry = validateRegistry(config.registry);

  let selectedAdapter: JobRuntimeAdapter;
  let redisUrl: string | undefined;
  if (config.adapter !== undefined) {
    selectedAdapter = validateAdapter(config.adapter);
    redisUrl = undefined;
  } else {
    redisUrl = resolveRuntimeRedisUrl(
      { valkeyUrl: config.valkeyUrl, redisUrl: config.redisUrl },
      env,
    );
    selectedAdapter = createBullMQAdapter({ redisUrl });
  }

  let schedules: readonly ScheduleSpec[];
  if (config.schedules === undefined) {
    schedules = [];
  } else if (!Array.isArray(config.schedules)) {
    throw new RuntimeConfigError('config.schedules must be an array of schedule specs');
  } else {
    schedules = config.schedules as readonly ScheduleSpec[];
  }

  return {
    registry,
    selectedAdapter,
    redisUrl,
    schedules,
    queueName: validateString(config.queueName, 'config.queueName') ?? DEFAULT_QUEUE_NAME,
    prefix: validateString(config.prefix, 'config.prefix') ?? DEFAULT_PREFIX,
    concurrency: validateConcurrency(config.concurrency),
  };
}
