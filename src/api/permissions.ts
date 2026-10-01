/**
 * Composable permission predicates for API authorization.
 *
 * A {@link PermissionPredicate} has the same signature as the resource
 * `Authorize` callback — `(context, action, resource?) => boolean | Promise<boolean>`
 * — so these helpers compose with `createResourceHandlers` without any change to
 * the handler layer. Semantics are always default-deny and strict: a predicate
 * "allows" only when it resolves to exactly `true`; a falsy value, a truthy
 * non-boolean, a throw, or a rejection all deny.
 *
 * - `require(predicate)` normalizes a single (possibly loose) callback into that
 *   strict contract, catching throws and coercing to an exact boolean.
 * - `and(...predicates)` and `or(...predicates)` combine predicates with the same
 *   strict semantics, short-circuiting on the first denial / allowance.
 * - `resourcePolicy({ list, get, create, update, delete })` maps the CRUD shape
 *   onto the resource action names (`retrieve`/`delete` are driven by `get`/
 *   `delete`) and denies any action whose predicate is absent.
 *
 * A policy or predicate is passed to `createResourceHandlers` as the `authorize`
 * option, e.g. `authorize: resourcePolicy({ list: require(isStaff), ... })`.
 */

import type { Authorize, ResourceAction } from './resource.js';
import type { RequestContext } from '../contracts/http.js';

/**
 * A permission check with the resource `Authorize` signature. Aliased so
 * consumers can speak about "predicates" rather than "authorize callbacks".
 */
export type PermissionPredicate<TResource = unknown> = Authorize<TResource>;

/**
 * Wrap a predicate so it resolves to exactly `true` on allow and `false` on any
 * other outcome (falsy, truthy non-boolean, throw, or rejection). This is the
 * strictness glue that makes `and`/`or` and `resourcePolicy` safe to feed
 * arbitrary callbacks.
 */
export function require<TResource>(
  predicate: PermissionPredicate<TResource>,
): PermissionPredicate<TResource> {
  if (typeof predicate !== 'function') {
    throw new TypeError('require expects a predicate function');
  }
  return async (context, action, resource) => {
    let result: unknown;
    try {
      result = await predicate(context, action, resource);
    } catch {
      result = false;
    }
    return result === true;
  };
}

/** Combine predicates with AND semantics; denies on the first non-allow. */
export function and<TResource>(
  ...predicates: readonly PermissionPredicate<TResource>[]
): PermissionPredicate<TResource> {
  return async (context, action, resource) => {
    for (const predicate of predicates) {
      if (!(await evaluate(predicate, context, action, resource))) {
        return false;
      }
    }
    return true;
  };
}

/** Combine predicates with OR semantics; allows on the first allow. */
export function or<TResource>(
  ...predicates: readonly PermissionPredicate<TResource>[]
): PermissionPredicate<TResource> {
  return async (context, action, resource) => {
    for (const predicate of predicates) {
      if (await evaluate(predicate, context, action, resource)) {
        return true;
      }
    }
    return false;
  };
}

/** Per-action predicates in CRUD shape. Every key is optional; absent means deny. */
export interface ResourcePolicy<TResource = unknown> {
  readonly list?: PermissionPredicate<TResource>;
  readonly get?: PermissionPredicate<TResource>;
  readonly create?: PermissionPredicate<TResource>;
  readonly update?: PermissionPredicate<TResource>;
  readonly delete?: PermissionPredicate<TResource>;
}

/**
 * Build a resource `Authorize` from a CRUD-shaped policy. `retrieve` is driven
 * by `get` and `delete` by `delete`; any action whose predicate is missing is
 * denied. The returned callback is directly assignable to the `authorize` option
 * of `createResourceHandlers`.
 */
export function resourcePolicy<TResource>(policy: ResourcePolicy<TResource>): Authorize<TResource> {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new TypeError('resourcePolicy expects a policy object');
  }
  return (context, action, resource) => {
    const predicate = predicateFor(policy, action);
    if (predicate === undefined) {
      return false;
    }
    return evaluate(predicate, context, action, resource);
  };
}

function predicateFor<TResource>(
  policy: ResourcePolicy<TResource>,
  action: ResourceAction,
): PermissionPredicate<TResource> | undefined {
  switch (action) {
    case 'list':
      return policy.list;
    case 'retrieve':
      return policy.get;
    case 'create':
      return policy.create;
    case 'update':
      return policy.update;
    case 'delete':
      return policy.delete;
  }
}

// ---------------------------------------------------------------------------
// Permissions registry
// ---------------------------------------------------------------------------

/**
 * A named registry of {@link PermissionPredicate}s. Registered predicates carry
 * the same strict exact-`true` semantics as the standalone helpers, so a
 * retrieved predicate composes with {@link and}, {@link or}, and
 * {@link resourcePolicy} without any extra normalization.
 */
export interface PermissionRegistry {
  /** Register a predicate under `name`; throws when `name` is empty or already taken. */
  register(name: string, predicate: PermissionPredicate): void;
  /** Return the predicate registered under `name`, or `undefined` when absent. */
  get(name: string): PermissionPredicate | undefined;
  /** Return `true` when a predicate is registered under `name`. */
  has(name: string): boolean;
  /** Return a frozen snapshot of every registered name in insertion order. */
  names(): readonly string[];
}

/**
 * Create a named permission registry, optionally seeding from `initial`.
 * Duplicate and empty names are rejected value-free at construction and on every
 * `register` call; the map itself is never exposed, so a retrieved predicate
 * cannot be mutated by the caller.
 */
export function createPermissionRegistry(
  initial?: Record<string, PermissionPredicate>,
): PermissionRegistry {
  const entries = new Map<string, PermissionPredicate>();

  const add = (name: string, predicate: PermissionPredicate) => {
    if (!name) {
      throw new TypeError('permission name must not be empty');
    }
    if (entries.has(name)) {
      throw new TypeError('permission already registered');
    }
    entries.set(name, predicate);
  };

  if (initial) {
    for (const [name, predicate] of Object.entries(initial)) {
      add(name, predicate);
    }
  }

  return {
    register(name, predicate) {
      add(name, predicate);
    },
    get(name) {
      return entries.get(name);
    },
    has(name) {
      return entries.has(name);
    },
    names() {
      return Object.freeze([...entries.keys()]);
    },
  };
}

/** Strict evaluation: exactly `true` allows; anything else denies. */
async function evaluate<TResource>(
  predicate: PermissionPredicate<TResource>,
  context: RequestContext,
  action: ResourceAction,
  resource?: TResource,
): Promise<boolean> {
  try {
    return (await predicate(context, action, resource)) === true;
  } catch {
    return false;
  }
}
