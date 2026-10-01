/**
 * Shared Valkey/Redis connection machinery used by both the cache store and
 * the mutex store.  Exported only within the module — NOT re-exported from
 * `src/cache/index.ts`.
 *
 * Every function takes an injected error factory so the caller controls the
 * error class while the logic lives in one place.  The ValkeyRedisClient type
 * is imported as `import type` from store.ts, which avoids a runtime cycle.
 */

import { errnoCode } from '../internal/errors.js';
import type { ValkeyRedisClient } from './store.js';

/** Command-retry budget shared by both the cache and mutex stores. */
export const VALKEY_MAX_RETRIES_PER_REQUEST = 3;

/**
 * Validate and default a key prefix.  When `value` is `undefined` the
 * `fallback` is returned; a non-empty string is returned verbatim; anything
 * else throws `TypeError`.
 */
export function resolveValkeyPrefix(value: unknown, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('prefix must be a non-empty string');
  }
  return value;
}

/**
 * Resolve the connection URL (`valkeyUrl` → `VALKEY_URL`, skipping empty
 * values).  Returns `undefined` when nothing is configured.
 *
 * This function performs NO URL validation — call {@link assertValkeyUrl}
 * separately.  It never echoes the value.
 */
export function resolveValkeyUrl(
  options: { valkeyUrl?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const candidate of [options.valkeyUrl, env.VALKEY_URL]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Validate a connection URL as an explicit `redis://`/`rediss://` URL.
 * Throws via the injected `makeError` factory on failure; returns the value
 * on success.  Never echoes the value.
 */
export function assertValkeyUrl(value: unknown, makeError: (message: string) => Error): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw makeError(
      'the Valkey/Redis connection URL must be a non-empty redis:// or rediss:// URL',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw makeError('the Valkey/Redis connection URL must be a valid redis:// or rediss:// URL');
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw makeError('the Valkey/Redis connection URL must use the redis:// or rediss:// scheme');
  }
  return value;
}

/**
 * Reduce a backend error to a payload-free error via the injected factory.
 * The `label` is used as the error-message prefix (e.g. `"cache"` or
 * `"mutex"`).  When an errno code is extractable it is appended to the
 * message and forwarded to the factory.
 */
export function sanitizeValkeyError(
  error: unknown,
  label: string,
  makeError: (message: string, code: string | undefined) => Error,
): Error {
  const code = errnoCode(error);
  const message =
    code === undefined ? `${label} backend error` : `${label} backend error (${code})`;
  return makeError(message, code);
}

/**
 * Surface a post-connect backend error to `onError`, falling back to a
 * generic warning.  The observer is guarded so a throwing or rejecting
 * handler never becomes an unhandled rejection that could crash the process.
 */
export function reportValkeyError(
  error: unknown,
  onError: ((error: Error) => void) | undefined,
  label: string,
  makeError: (message: string, code: string | undefined) => Error,
): void {
  const sanitized = sanitizeValkeyError(error, label, makeError);
  if (onError === undefined) {
    process.emitWarning(sanitized);
    return;
  }
  try {
    void Promise.resolve(onError(sanitized)).catch(() => {
      // A rejecting observer must not surface as an unhandled rejection.
    });
  } catch {
    // A throwing observer is ignored; it must not take down the server.
  }
}

/** Best-effort disconnect used on the failure path; the primary error wins. */
export function disconnectQuietly(client: ValkeyRedisClient | undefined): void {
  if (client === undefined) {
    return;
  }
  try {
    void client.disconnect().catch(() => {
      // Teardown on the error path is best-effort.
    });
  } catch {
    // A synchronous disconnect failure is irrelevant to the reported error.
  }
}

/** Load the real ioredis class lazily, only when a seam is absent. */
export async function loadValkeyRedisClient(): Promise<
  new (url: string, options: object) => ValkeyRedisClient
> {
  const { Redis } = await import('ioredis');
  return Redis as unknown as new (url: string, options: object) => ValkeyRedisClient;
}
