/**
 * Declarative resource DSL: thin composition over the existing resource
 * primitives (`defineSerializer`, `createResourceHandlers`,
 * `createResourceRouter`) so every API resource is a single object.
 *
 * ## Composition
 *
 * `defineDeclarativeResource(spec)`:
 * 1. Validates `name` (non-empty safe URL segment), `serializer` (a
 *    {@link SerializerFields} map), `store` (implements {@link ResourceStore}),
 *    and `authorize` (an {@link Authorize} callback).
 * 2. Passes `spec.serializer` to {@link defineSerializer}.
 * 3. Passes `{ serializer, store, authorize }` to
 *    {@link createResourceHandlers}.
 * 4. Passes `{ prefix: '/', resources: { [name]: handlers } }` to
 *    {@link createResourceRouter}.
 * 5. Returns a frozen `{ name, serializer, handlers, routes, authorize }`.
 *
 * ## Authorization (default-deny)
 *
 * The returned `authorize` callback is the same one passed into
 * `createResourceHandlers`, which enforces default-deny: a request is allowed
 * only when `authorize` resolves to exactly `true`. The composed handlers
 * already carry this enforcement — callers that wire the handlers through a
 * Hono router without further authorization gates will apply it on every
 * request.
 *
 * ## Error model
 *
 * Every validation failure throws a value-free `DeclarativeResourceError`
 * whose message never echoes the invalid input. The underlying primitives
 * (`defineSerializer`, `createResourceHandlers`, `createResourceRouter`) may
 * also throw their own errors, which propagate unwrapped.
 */

import { defineSerializer } from './serialization.js';
import type { SerializerFields } from './serialization.js';
import { createResourceHandlers } from './resource.js';
import type { Authorize, ResourceHandlers, ResourceStore } from './resource.js';
import { createResourceRouter } from './router.js';
import type { RouteEntry } from './router.js';

/** Raised when the spec fails structural validation. Value-free: the message
 *  never echoes the invalid input. */
export class DeclarativeResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeclarativeResourceError';
  }
}

/** The declarative one-file resource produced by {@link defineDeclarativeResource}. */
export interface DeclarativeResource {
  /** The resource slug / route segment. */
  readonly name: string;
  /** Serializer built from `spec.serializer`. */
  readonly serializer: ReturnType<typeof defineSerializer>;
  /** Collection and detail handlers. */
  readonly handlers: ResourceHandlers;
  /** Deterministic route manifest (five entries: two collection + three detail). */
  readonly routes: readonly RouteEntry[];
  /** The `authorize` callback passed through verbatim. */
  readonly authorize: Authorize;
}

/** Options for {@link defineDeclarativeResource}. */
export interface DeclarativeResourceOptions {
  /** Resource slug / URL segment. Must be a non-empty safe segment (alphanumeric plus `_-`). */
  readonly name: string;
  /** Field map passed through to {@link defineSerializer}. */
  readonly serializer: SerializerFields;
  /** Persistence adapter with list/get/create/update/delete. */
  readonly store: ResourceStore;
  /** Required default-deny authorization callback. */
  readonly authorize: Authorize;
}

/** Safe URL segment: starts alphanumeric, then zero or more alphanumeric/`_-`. */
const SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Build a complete resource — serializer, handlers, route manifest, and
 * authorization — from one declarative spec.
 *
 * ```ts
 * const posts = defineDeclarativeResource({
 *   name: 'post',
 *   serializer: { id: number(), title: string(), body: optional(string()) },
 *   store,  // implements ResourceStore
 *   authorize: resourcePolicy({ list: require(isStaff) }),
 * });
 * // posts.handlers.collection.GET  — Hono worker
 * // posts.routes                   — mountable route manifest
 * ```
 */
export function defineDeclarativeResource(
  options: DeclarativeResourceOptions,
): DeclarativeResource {
  const { name, serializer: fields, store, authorize } = options;

  // -- validate name ----------------------------------------------------------
  if (typeof name !== 'string' || !SEGMENT_RE.test(name)) {
    throw new DeclarativeResourceError(
      'Resource name must be a non-empty safe URL segment (alphanumeric + "-_")',
    );
  }

  // -- validate serializer fields ---------------------------------------------
  if (
    fields === undefined ||
    fields === null ||
    typeof fields !== 'object' ||
    Array.isArray(fields)
  ) {
    throw new DeclarativeResourceError('serializer must be a non-null object of field definitions');
  }

  // -- validate store ---------------------------------------------------------
  if (
    store === undefined ||
    store === null ||
    typeof store !== 'object' ||
    typeof (store as unknown as Record<string, unknown>).list !== 'function'
  ) {
    throw new DeclarativeResourceError(
      'store must be a non-null object implementing ResourceStore',
    );
  }

  // -- validate authorize -----------------------------------------------------
  if (typeof authorize !== 'function') {
    throw new DeclarativeResourceError('authorize must be a function');
  }

  // -- compose ----------------------------------------------------------------
  const serializer = defineSerializer(fields);
  const handlers = createResourceHandlers({ serializer, store, authorize });
  const routes = createResourceRouter({
    prefix: '/',
    resources: { [name]: handlers },
  });

  return Object.freeze({ name, serializer, handlers, routes, authorize });
}
