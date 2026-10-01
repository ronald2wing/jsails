/**
 * Per-route middleware for filesystem page and API routes.
 *
 * A compiled route module may export `middleware` — an array of Hono
 * {@link MiddlewareHandler} instances (typed to the JSails {@link AppEnv})
 * applied in declared order before the terminal handler. Each handler receives
 * a Hono {@link Context} and a `next` continuation: it either returns a
 * `Response` directly (short-circuit) or awaits `next()` to proceed down the
 * chain. The returned `Response` is used as-is (trusted producer output).
 *
 * Middleware are now composed by Hono's native `app.on()` handler chain rather
 * than a hand-rolled `runMiddleware`. {@link MiddlewareRegistry} and
 * {@link MiddlewareError} are deleted: Hono owns composition, and `next()` is
 * single-use by construction.
 *
 * Named middleware refs (strings) in route `middleware` exports are still
 * supported at the config/assembly layer — the application resolves them to
 * concrete `MiddlewareHandler` instances before handing them to `createApp`.
 */

import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../server/env.js';

/**
 * A per-route middleware handler. This is Hono's `MiddlewareHandler` typed to
 * the JSails `AppEnv`, so it composes natively with `app.use` and `app.on`.
 * The handler receives a Hono `Context<AppEnv>` and a `next` continuation;
 * returning without calling `next` short-circuits the chain.
 */
export type RouteMiddleware = MiddlewareHandler<AppEnv>;

/**
 * A route's `middleware` export entry: either an inline handler (passed through
 * by identity) or a string naming a handler registered in the app config's
 * `middleware` map. String refs are resolved at assembly time by the application
 * layer; an unknown name fails at assembly, not at request time.
 */
export type RouteMiddlewareRef = RouteMiddleware | string;

/**
 * Validate a module's `middleware` export structurally. `undefined` means no
 * middleware; anything else must be an array whose entries are each a function
 * ({@link RouteMiddleware}) or a non-empty string naming a registered handler
 * ({@link RouteMiddlewareRef}). Violations are reported through `describe`,
 * which the caller uses to attach route/module context — the value itself is
 * never echoed, so the resulting error is value-free.
 */
export function validateMiddlewareList(
  value: unknown,
  describe: (message: string) => Error,
): readonly RouteMiddlewareRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw describe('exports "middleware" as a non-array value');
  }
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] as unknown;
    if (typeof entry !== 'function' && typeof entry !== 'string') {
      throw describe(`exports a non-function middleware entry at index ${index}`);
    }
    if (typeof entry === 'string' && entry.length === 0) {
      throw describe(`exports an empty middleware name at index ${index}`);
    }
  }
  return value as readonly RouteMiddlewareRef[];
}
