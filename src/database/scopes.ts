/**
 * Named scopes — reusable, curried query fragments applied to a
 * {@link ModelQuery}.
 *
 * A scope is a function that mutates (and/or returns) a query; a **name** makes
 * it reusable by key and lets a chain spell the intent:
 *
 * ```ts
 * import { scope } from 'jsails/database';
 *
 * const published = (q, threshold = 10) => q.where(qGte('likes', threshold));
 * scope('popular', published)(Post);
 *
 * query(Post).scope('popular', 10).getMany();   // model-level registration
 * applyScope(query(Post), 'popular', 10);       // standalone helper
 * ```
 *
 * Scopes are registered per model constructor and resolved by exact name. There
 * is no automatic inference from enum columns or any other marker — a scope is
 * always declared explicitly, so a name can never collide with a method or be
 * silently shadowed. Registration is a curried function (usable as a class
 * decorator or called directly) mirroring {@link delegate}.
 */

import type { ModelQuery } from './model-query.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A scope body: mutates the query in place and may return it (a returned value
 * is ignored — the same query is always yielded back).
 */
export type ScopeFunction<T extends object> = (
  query: ModelQuery<T>,
  ...args: unknown[]
) => void | ModelQuery<T>;

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

type ScopeErrorCode = 'invalid_name' | 'invalid_scope' | 'duplicate_scope' | 'unknown_scope';

/** Raised for an invalid scope declaration or an unknown scope lookup. Value-free. */
export class ScopeError extends Error {
  readonly code: ScopeErrorCode;

  constructor(code: ScopeErrorCode, message: string) {
    super(message);
    this.name = 'ScopeError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Scopes per model constructor; module-level and keyed by the class itself. */
const registry = new WeakMap<Function, Map<string, ScopeFunction<object>>>();

function validateName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ScopeError('invalid_name', 'Scope name must be a non-empty string');
  }
}

function validateFn(fn: unknown): asserts fn is ScopeFunction<object> {
  if (typeof fn !== 'function') {
    throw new ScopeError('invalid_scope', 'Scope body must be a function');
  }
}

function registerScope(model: Function, name: string, fn: ScopeFunction<object>): void {
  const scopes = registry.get(model) ?? new Map<string, ScopeFunction<object>>();
  if (scopes.has(name)) {
    throw new ScopeError('duplicate_scope', 'a scope with this name is already defined');
  }
  scopes.set(name, fn);
  registry.set(model, scopes);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Declare a named scope for one model. Returns a curried registrar usable as a
 * class decorator (`@scope('popular', fn)`) or called directly
 * (`scope('popular', fn)(Post)`). The name and body are validated eagerly;
 * a duplicate name for the same model is rejected at registration time.
 *
 * @throws {ScopeError} (`invalid_name` / `invalid_scope` / `duplicate_scope`).
 */
export function scope(name: string, fn: ScopeFunction<object>): (model: Function) => void {
  validateName(name);
  validateFn(fn);
  return (model: Function): void => {
    registerScope(model, name, fn);
  };
}

/**
 * Resolve a named scope for a model constructor, or `undefined` when absent.
 * A null-safe lookup — never throws.
 */
export function resolveScope(model: Function, name: string): ScopeFunction<object> | undefined {
  return registry.get(model)?.get(name);
}

/**
 * Apply a named scope to a query, forwarding `args` to the scope body. A thin
 * convenience over {@link ModelQuery.scope}.
 *
 * @throws {ScopeError} (`unknown_scope`) when the model has no such scope.
 */
export function applyScope<T extends object>(
  modelQuery: ModelQuery<T>,
  name: string,
  ...args: unknown[]
): ModelQuery<T> {
  return modelQuery.scope(name, ...args);
}
