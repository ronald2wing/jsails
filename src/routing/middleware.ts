/**
 * Per-route middleware for filesystem page and API routes.
 *
 * A compiled route module may export `middleware` — an array of JSails-agnostic
 * handlers applied in declared order before the terminal handler. Each handler
 * receives the per-request {@link RequestContext} and a `next` continuation:
 * it either returns a `Response` directly (short-circuit) or awaits `next()` to
 * proceed down the chain. The returned `Response` is used as-is (trusted
 * producer output); a thrown or rejected handler becomes the standard sanitized
 * 500 through the HTTP layer's error envelope.
 *
 * The chain is request-scoped: a fresh continuation is built per invocation, so
 * a handler's `next` is callable at most once. A second call is rejected
 * (`{@link MiddlewareError}`) rather than silently double-dispatching the tail
 * of the chain.
 */

import type { RequestContext } from '../contracts/http.js';

/**
 * A per-route middleware handler. `context` is the same per-request context
 * threaded to pages and API handlers; `next` advances to the next middleware in
 * the chain (or the terminal handler at the end) and resolves to its `Response`.
 * Returning without calling `next` short-circuits the chain.
 */
export type RouteMiddleware = (
  context: RequestContext,
  next: () => Promise<Response>,
) => Response | Promise<Response>;

/**
 * A route's `middleware` export entry: either an inline handler (passed through
 * by identity) or a string naming a handler registered in a
 * {@link MiddlewareRegistry}. Registration and resolution are separate so the
 * registry is built at assembly time while refs are resolved at route-load time
 * (or lazily per-request).
 */
export type RouteMiddlewareRef = RouteMiddleware | string;

/**
 * A named middleware registry, built at assembly time from a map of name →
 * handler. Provides O(1) lookup for string-based {@link RouteMiddlewareRef}
 * resolution. The registry is read-only after construction — it records the
 * registered names and their handlers but never executes them.
 */
export interface MiddlewareRegistry {
  /** True when a handler is registered under `name`. */
  has(name: string): boolean;
  /** The registered handler, or `undefined` when `name` is unknown. */
  get(name: string): RouteMiddleware | undefined;
  /** Every registered name, sorted deterministically so callers get a stable order. */
  names(): readonly string[];
}

/**
 * Build a named middleware registry from a map of name → handler.
 *
 * Every value must be a function and every name must be non-empty. Violations
 * are reported through `describe`; the message never echoes a handler or its
 * source code, so the resulting error is value-free.
 *
 * The `describe` callback is the same contract used by
 * {@link validateMiddlewareList} so callers can attach route/module context
 * without leaking middleware internals.
 */
export function createMiddlewareRegistry(
  entries: Readonly<Record<string, RouteMiddleware>>,
  describe: (message: string) => Error,
): MiddlewareRegistry {
  const map = new Map<string, RouteMiddleware>();
  for (const [name, handler] of Object.entries(entries)) {
    if (name.length === 0) {
      throw describe('a middleware entry has an empty name');
    }
    if (typeof handler !== 'function') {
      throw describe(`middleware entry is not a function`);
    }
    map.set(name, handler);
  }
  return {
    has(name: string): boolean {
      return map.has(name);
    },
    get(name: string): RouteMiddleware | undefined {
      return map.get(name);
    },
    names(): readonly string[] {
      // Deterministic sort so callers get a stable listing order unrelated to
      // insertion order or a JS engine's internal Map iteration.
      return [...map.keys()].sort();
    },
  };
}

/**
 * Resolve a route's middleware refs (inline functions and registered names)
 * into a concrete handler chain.
 *
 * Each {@link RouteMiddleware} function passes through by identity. Each string
 * is looked up in the `registry`; an unknown name throws through `describe` with
 * a message that includes the **index** (e.g. `"an unregistered middleware at
 * index 2"`) but never the name or value itself, so the error stays value-free
 * while pinpointing the position for the developer.
 *
 * The returned array is a fresh, ordered list of resolved handlers ready for
 * {@link runMiddleware}. The caller owns the registry and the resolved array;
 * this function is pure and never calls a handler.
 */
export function resolveMiddlewareRefs(
  refs: readonly RouteMiddlewareRef[],
  registry: MiddlewareRegistry,
  describe: (message: string) => Error,
): readonly RouteMiddleware[] {
  return refs.map((ref, index) => {
    if (typeof ref === 'function') {
      return ref;
    }
    if (typeof ref === 'string') {
      const handler = registry.get(ref);
      if (!handler) {
        throw describe(`an unregistered middleware at index ${index}`);
      }
      return handler;
    }
    // Defensive: by the time refs reach this function, validateMiddlewareList
    // should have already rejected non-function, non-string entries.
    throw describe(`an invalid middleware entry at index ${index}`);
  });
}

/**
 * Raised when a middleware handler calls `next()` more than once. Reusing a
 * continuation would double-dispatch the remaining handlers and the terminal
 * handler, so the second call is rejected instead of silently running twice.
 * The message is value-free and maps to the standard 500 through the HTTP layer.
 */
export class MiddlewareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MiddlewareError';
  }
}

/**
 * Compose a middleware chain over a terminal handler.
 *
 * Handlers run in declared order; each receives a continuation that resolves to
 * the downstream `Response`. `final` is invoked only when every handler calls
 * `next()`. A handler that returns without calling `next()` short-circuits, and
 * its `Response` is the chain's result. Callers own structural validation of
 * `handlers` (see {@link validateMiddlewareList}); `runMiddleware` assumes a
 * validated array of functions.
 */
export function runMiddleware(
  handlers: readonly RouteMiddleware[],
  context: RequestContext,
  final: () => Response | Promise<Response>,
): Promise<Response> {
  return dispatch(0);

  function dispatch(index: number): Promise<Response> {
    if (index >= handlers.length) {
      return Promise.resolve().then(final);
    }
    const handler = handlers[index] as RouteMiddleware;
    let nextCalled = false;
    const next = (): Promise<Response> => {
      if (nextCalled) {
        throw new MiddlewareError('next() called more than once');
      }
      nextCalled = true;
      return dispatch(index + 1);
    };
    return Promise.resolve().then(() => handler(context, next));
  }
}

/**
 * Validate a module's `middleware` export structurally. `undefined` means no
 * middleware; anything else must be an array whose entries are each a function
 * ({@link RouteMiddleware}) or a string naming a registered handler
 * ({@link RouteMiddlewareRef}). Violations are reported through `describe`,
 * which the caller uses to attach route/module context — the value itself is
 * never echoed, so the resulting error is value-free.
 *
 * NOTE: The return type annotation is `readonly RouteMiddleware[]` for backward
 * compatibility with existing call sites (`src/server/`). When a route contains
 * string refs the array does contain strings, but the type-unsafe cast is
 * deliberate: string refs are resolved downstream by
 * {@link resolveMiddlewareRefs}, and the server-layer call sites will be updated
 * in a follow-up slice to wire the registry through. This is a transitional
 * type, not a permanent lie.
 */
export function validateMiddlewareList(
  value: unknown,
  describe: (message: string) => Error,
): readonly RouteMiddleware[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw describe('exports "middleware" as a non-array value');
  }
  for (let index = 0; index < value.length; index++) {
    if (typeof value[index] !== 'function' && typeof value[index] !== 'string') {
      throw describe(`exports a non-function middleware entry at index ${index}`);
    }
  }
  return value as readonly RouteMiddleware[];
}
