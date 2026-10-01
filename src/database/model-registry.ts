/**
 * The JSails model registry: the runtime seam between compiler-emitted model
 * registration and {@link JsailsDataSource}.
 *
 * A JSails model is a class that declares only the shape of its data. The
 * compiler derives the entity, columns, relations, and lifecycle hooks from
 * that shape and emits a registration call — {@link registerModel} — that
 * records the class and its derived hook definitions here. {@link
 * JsailsDataSource} harvests the registry into its `entities` and `subscribers`
 * options, so an app never lists its models by hand.
 *
 * The registry is **module-level and deterministic**: entries are keyed by the
 * class identity and returned in registration order, so two data sources in the
 * same process see the same models in the same order. It is **test-reset-safe**:
 * {@link clearModelRegistry} empties it, and {@link registerModel} is idempotent
 * for a given class (re-registering replaces the prior entry in place, keeping
 * its original position) so a re-imported module never duplicates a model.
 *
 * This module is server-only — it is reached only through the data layer, never
 * a browser-safe entry.
 */

import type { ObjectLiteral } from 'typeorm';

import type { EntityHooksDefinition } from './entity-subscribers.js';
import type { ModelSpec } from '../models/define-model.js';

/** A registered model: the class plus the hook definitions derived for it. */
export interface RegisteredModel {
  /** The model class (a TypeORM entity target). */
  readonly entity: Function;
  /** Lifecycle hook definitions derived from the model's relation decorators. */
  readonly hooks: readonly EntityHooksDefinition<ObjectLiteral>[];
  /** The pure-data spec the compiler emitted; carries rename hints and other declarations. */
  readonly spec: ModelSpec;
}

/** Registration order is the harvest order; a Map preserves insertion order. */
const registry = new Map<Function, RegisteredModel>();

/**
 * Register a model class, its derived hook definitions, and the spec it was
 * lowered from. The spec is retained so consumers (e.g. the rename-hint
 * builder) can read declarations that never reach the TypeORM metadata.
 *
 * Idempotent per class: re-registering the same class replaces its entry in
 * place (preserving its original position) rather than appending a duplicate.
 * This keeps a re-imported module from double-registering a model while
 * preserving deterministic order.
 */
export function registerModel(
  entity: Function,
  hooks: readonly EntityHooksDefinition<ObjectLiteral>[],
  spec: ModelSpec,
): void {
  registry.set(entity, Object.freeze({ entity, hooks: Object.freeze([...hooks]), spec }));
}

/**
 * The registered models, in registration order. Returns a frozen snapshot so a
 * caller cannot mutate the registry through the returned array.
 */
export function registeredModels(): readonly RegisteredModel[] {
  return Object.freeze([...registry.values()]);
}

/**
 * Empty the registry. Intended for test isolation — a test that registers
 * models resets the registry in a teardown so the next test starts clean.
 */
export function clearModelRegistry(): void {
  registry.clear();
}
