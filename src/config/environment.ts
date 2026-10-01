/**
 * Bounded application configuration read from a plain string source.
 *
 * This helper turns a `Record<string, string | undefined>` (by default
 * `process.env`) into typed configuration. It is deliberately narrow:
 *
 * - It never loads a `.env` file and never mutates the source or `process.env`.
 * - The default source (`process.env`) is resolved when a reader is *invoked*,
 *   not at import time, so importing this module opens no connections and
 *   reads no environment variables.
 * - Errors are `EnvironmentError`s carrying structured `{ path, code }` issues
 *   and value-free messages. Custom Zod messages/inputs and thrown
 *   transform/refine errors may embed credentials, so raw Zod text is never
 *   surfaced and `.cause` is never populated.
 *
 * Optional services are opt-in: `readDatabaseEnvironment` and
 * `readValkeyEnvironment` fail when their variables are absent rather than
 * inventing a connection, so a static app that never calls them needs no
 * database or Valkey at all.
 */

import type { z } from 'zod';

import { resolveRuntimeRedisUrl } from '../jobs/runtime-config.js';

/** `DATABASE_TYPE` environment variable name. */
export const DATABASE_TYPE_ENV = 'DATABASE_TYPE';
/** `DATABASE_HOST` environment variable name. */
export const DATABASE_HOST_ENV = 'DATABASE_HOST';
/** `DATABASE_PORT` environment variable name. */
export const DATABASE_PORT_ENV = 'DATABASE_PORT';
/** `DATABASE_NAME` environment variable name. */
export const DATABASE_NAME_ENV = 'DATABASE_NAME';
/** `DATABASE_USER` environment variable name. */
export const DATABASE_USER_ENV = 'DATABASE_USER';
/** `DATABASE_PASSWORD` environment variable name. */
export const DATABASE_PASSWORD_ENV = 'DATABASE_PASSWORD';
/** Preferred Valkey/Redis URL environment variable name. */
export const VALKEY_URL_ENV = 'VALKEY_URL';
/** Legacy alias of `VALKEY_URL`. */
export const REDIS_URL_ENV = 'REDIS_URL';

/** SQL drivers accepted by the bounded database reader. */
export type DatabaseType = 'mariadb' | 'postgres' | 'mysql';

/** A value-free validation failure: a schema path plus a stable code. */
export interface EnvironmentIssue {
  /** Location of the failure, e.g. `["DATABASE_PORT"]`. Never a raw value. */
  readonly path: readonly (string | number)[];
  /** Stable machine code, e.g. `"required"`, `"invalid_type"`, `"too_big"`. */
  readonly code: string;
  /** Short description derived only from the schema, never from input. */
  readonly message: string;
}

/** Raised for any missing or invalid environment configuration. */
export class EnvironmentError extends Error {
  /** Structured, value-free failures. Never contains raw input values. */
  readonly issues: readonly EnvironmentIssue[];

  constructor(issues: readonly EnvironmentIssue[]) {
    super(issues.map(formatIssue).join('; '));
    this.name = 'EnvironmentError';
    this.issues = issues;
  }
}

function formatIssue(issue: EnvironmentIssue): string {
  const location = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${location}: ${issue.message}`;
}

function issue(
  path: readonly (string | number)[],
  code: string,
  message: string,
): EnvironmentIssue {
  return { path, code, message };
}

function environmentError(
  path: readonly (string | number)[],
  code: string,
  message: string,
): EnvironmentError {
  return new EnvironmentError([issue(path, code, message)]);
}

/** Translate Zod issues into value-free issues, dropping all custom text. */
function mapZodIssues(error: z.ZodError): EnvironmentIssue[] {
  return error.issues.map(mapZodIssue);
}

function mapZodIssue(zodIssue: z.ZodIssue): EnvironmentIssue {
  const path = zodIssue.path as readonly (string | number)[];
  switch (zodIssue.code) {
    case 'invalid_type':
      return issue(path, 'invalid_type', `expected ${typeName(zodIssue.expected)}`);
    case 'too_small':
      return issue(path, 'too_small', `must be at least ${zodIssue.minimum}`);
    case 'too_big':
      return issue(path, 'too_big', `must be at most ${zodIssue.maximum}`);
    case 'unrecognized_keys':
      // `zodIssue.keys` are input-provided names that may be sensitive or
      // malicious; report the fact without echoing any key.
      return issue(path, 'unrecognized_keys', 'unrecognized field');
    default:
      return issue(path, zodIssue.code, 'invalid value');
  }
}

function typeName(expected: string): string {
  switch (expected) {
    case 'string':
      return 'a string';
    case 'number':
    case 'int':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'object':
    case 'record':
      return 'an object';
    case 'array':
    case 'tuple':
      return 'an array';
    default:
      return 'a valid value';
  }
}

/**
 * Validate the source against a Zod schema. Unknown keys are stripped unless
 * the schema opts into `.strict()`; the source object is never mutated.
 *
 * Transform/refine functions may throw arbitrary errors (including ones that
 * embed secrets), so any thrown value is replaced by a generic
 * `EnvironmentError` with no `.cause`.
 */
export function readEnvironment<T>(
  schema: z.ZodType<T>,
  source: Record<string, string | undefined> = process.env,
): T {
  try {
    // A shallow copy keeps a mutating preprocess/transform from touching the
    // caller's object (and `process.env`). Values are strings, so no nested
    // object survives the copy and the guard stays cheap.
    const result = schema.safeParse({ ...source });
    if (result.success) {
      return result.data;
    }
    throw new EnvironmentError(mapZodIssues(result.error));
  } catch (error) {
    // A ZodError was already mapped above; anything else is a thrown
    // transform/refine error whose text may embed credentials.
    if (error instanceof EnvironmentError) {
      throw error;
    }
    throw environmentError([], 'invalid', 'environment validation failed');
  }
}

/** The typed database configuration produced by `readDatabaseEnvironment`. */
export interface DatabaseEnvironment {
  readonly type: DatabaseType;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

/** The typed Valkey configuration produced by `readValkeyEnvironment`. */
export interface ValkeyEnvironment {
  /** A validated `redis://` or `rediss://` URL. */
  readonly redisUrl: string;
}

const DATABASE_TYPES: readonly DatabaseType[] = ['mariadb', 'postgres', 'mysql'];
const DRIVER_DEFAULT_PORT: Readonly<Record<DatabaseType, number>> = {
  mariadb: 3306,
  mysql: 3306,
  postgres: 5432,
};
const MAX_PORT = 65535;
/** Canonical decimal only: no sign, decimal point, exponent, hex, or spaces. */
const PORT_PATTERN = /^[0-9]+$/;

function requireValue(source: Record<string, string | undefined>, name: string): string {
  const value = source[name];
  if (value === undefined || value === '') {
    throw environmentError([name], 'required', 'is required and must not be empty');
  }
  return value;
}

function readDatabaseType(source: Record<string, string | undefined>): DatabaseType {
  const raw = source[DATABASE_TYPE_ENV];
  if (raw === undefined) {
    return 'mariadb';
  }
  if ((DATABASE_TYPES as readonly string[]).includes(raw)) {
    return raw as DatabaseType;
  }
  // The offending value is intentionally not echoed: it is application input.
  throw environmentError(
    [DATABASE_TYPE_ENV],
    'invalid_type',
    'must be one of mariadb, postgres, mysql',
  );
}

function readDatabasePort(source: Record<string, string | undefined>, type: DatabaseType): number {
  const raw = source[DATABASE_PORT_ENV];
  if (raw === undefined) {
    return DRIVER_DEFAULT_PORT[type];
  }
  if (!PORT_PATTERN.test(raw)) {
    throw environmentError(
      [DATABASE_PORT_ENV],
      'invalid_format',
      'must be a canonical decimal integer',
    );
  }
  const port = Number(raw);
  if (port <= 0 || port > MAX_PORT) {
    throw environmentError(
      [DATABASE_PORT_ENV],
      'out_of_range',
      `must be between 1 and ${MAX_PORT}`,
    );
  }
  return port;
}

/**
 * Read the database connection settings from the source. The driver defaults
 * to MariaDB and the port defaults per driver (3306 for mariadb/mysql, 5432
 * for postgres). Host, user, password, and database name are required when
 * this reader is invoked: there is no implicit database for static apps.
 *
 * The password is returned exactly as provided (never trimmed or normalized);
 * database and user names are ordinary strings with no identifier
 * restrictions. No value is ever interpolated into a connection URL.
 */
export function readDatabaseEnvironment(
  source: Record<string, string | undefined> = process.env,
): DatabaseEnvironment {
  const type = readDatabaseType(source);
  return {
    type,
    host: requireValue(source, DATABASE_HOST_ENV),
    port: readDatabasePort(source, type),
    username: requireValue(source, DATABASE_USER_ENV),
    password: requireValue(source, DATABASE_PASSWORD_ENV),
    database: requireValue(source, DATABASE_NAME_ENV),
  };
}

/**
 * Resolve the Valkey/Redis connection URL from the source using the existing
 * runtime resolver: `VALKEY_URL` is preferred, `REDIS_URL` is the fallback.
 * The resolved URL is validated but never echoed. An explicit `source` is the
 * only place consulted; `process.env` is never used as a fallback.
 */
export function readValkeyEnvironment(
  source: Record<string, string | undefined> = process.env,
): ValkeyEnvironment {
  try {
    return { redisUrl: resolveRuntimeRedisUrl({}, source) };
  } catch {
    throw environmentError(
      [VALKEY_URL_ENV],
      'invalid_value',
      `expected a redis:// or rediss:// URL in ${VALKEY_URL_ENV} or ${REDIS_URL_ENV}`,
    );
  }
}
