/**
 * Browser-safe model primitive: a one-way projection of server-owned component
 * state into `@preact/signals`.
 *
 * Livewire-style reactivity needs a place to hold server state that re-renders
 * as it changes, without ever letting the client become a second authority over
 * that state. `createModel` builds that place: each declared field is backed by
 * a plain signal, and those signals are a projection *of* the last snapshot —
 * they are written only by `project(state)` (snapshot → signal) or by an
 * explicit local `set`. `snapshot()` reads the projection back out, but it never
 * feeds a signal back into the authoritative snapshot, and it always excludes
 * the client-only (`ephemeral`) fields that the server does not know about.
 *
 * The module imports only `@preact/signals`, which has no DOM dependency, so it
 * is safe to import and test under plain Node as well as in the browser.
 */
import { batch, signal, type ReadonlySignal, type Signal } from '@preact/signals';

import { isPlainObject } from '../../internal/json-safe.js';

/** Stable machine codes carried by {@link ModelError}. */
export type ModelErrorCode = 'invalid_definition' | 'invalid_state' | 'unknown_field' | 'disposed';

/** Raised for misuse or an invalid model definition. Value-free by construction. */
export class ModelError extends Error {
  readonly code: ModelErrorCode;

  constructor(message: string, code: ModelErrorCode) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
  }
}

/** Per-field configuration accepted by {@link ModelDefinition}. */
export interface ModelFieldOptions {
  /** Mark a field as client-only scratch state, excluded from `snapshot()`. */
  readonly ephemeral?: boolean;
}

/** The declaration a model is built from; frozen on construction. */
export interface ModelDefinition {
  readonly fields: Record<string, ModelFieldOptions>;
}

/**
 * A projected model of server state.
 *
 * - `signal(field)` returns the read-only signal backing a field, the reactive
 *   handle consumers subscribe to for re-renders.
 * - `value(field)` reads a field's current projection.
 * - `set(field, value)` applies an explicit local edit to a field.
 * - `project(state)` replaces the synced-field projections from a snapshot; it
 *   is strictly one-way and never touches ephemeral fields.
 * - `snapshot()` serializes the current synced projections back to a plain
 *   object, excluding ephemeral fields.
 * - `dispose()` idempotently drops the model; every operation afterwards throws
 *   a `disposed` {@link ModelError}.
 */
export interface Model {
  readonly signal: (field: string) => ReadonlySignal<unknown>;
  value(field: string): unknown;
  set(field: string, value: unknown): void;
  project(state: Record<string, unknown>): void;
  snapshot(): Record<string, unknown>;
  dispose(): void;
}

/**
 * Validate a definition, then freeze it (the object, its `fields` map, and each
 * field option) so a shared, already-consumed config cannot be mutated out from
 * under a constructed model. Returns the frozen fields map.
 */
function freezeDefinition(definition: ModelDefinition): Record<string, ModelFieldOptions> {
  if (!isPlainObject(definition)) {
    throw new ModelError('model definition must be an object', 'invalid_definition');
  }
  const fields = definition.fields;
  if (!isPlainObject(fields)) {
    throw new ModelError('model definition fields must be an object', 'invalid_definition');
  }
  for (const [name, options] of Object.entries(fields)) {
    if (name.length === 0) {
      throw new ModelError('model field name must not be empty', 'invalid_definition');
    }
    if (!isPlainObject(options)) {
      throw new ModelError('model field options must be an object', 'invalid_definition');
    }
    if (options.ephemeral !== undefined && typeof options.ephemeral !== 'boolean') {
      throw new ModelError('model field ephemeral must be a boolean', 'invalid_definition');
    }
  }

  for (const options of Object.values(fields)) {
    Object.freeze(options);
  }
  Object.freeze(fields);
  Object.freeze(definition);
  return fields;
}

/** Build a model from a definition; throws a value-free {@link ModelError}. */
export function createModel(definition: ModelDefinition): Model {
  const fields = freezeDefinition(definition);

  // Two signal maps: synced fields form the snapshot projection, while
  // ephemeral fields hold client-only scratch state. Keeping them separate means
  // `snapshot()` can serialize one without ever consulting the other, and the
  // field's classification is frozen by which map it lands in.
  const synced = new Map<string, Signal<unknown>>();
  const ephemeral = new Map<string, Signal<unknown>>();

  for (const [name, options] of Object.entries(fields)) {
    const ephemeralFlag = options.ephemeral === true;
    const target = ephemeralFlag ? ephemeral : synced;
    target.set(name, signal<unknown>(undefined, { name }));
  }

  let disposed = false;

  function ensureActive(): void {
    if (disposed) {
      throw new ModelError('model is disposed', 'disposed');
    }
  }

  /** Resolve a declared field's signal, or throw a value-free error. */
  function resolveField(field: string): Signal<unknown> {
    ensureActive();
    const resolved = synced.get(field) ?? ephemeral.get(field);
    if (resolved === undefined) {
      throw new ModelError('unknown model field', 'unknown_field');
    }
    return resolved;
  }

  return Object.freeze({
    signal(field: string): ReadonlySignal<unknown> {
      return resolveField(field);
    },

    value(field: string): unknown {
      return resolveField(field).value;
    },

    set(field: string, value: unknown): void {
      resolveField(field).value = value;
    },

    project(state: Record<string, unknown>): void {
      ensureActive();
      if (!isPlainObject(state)) {
        throw new ModelError('projected state must be a plain object', 'invalid_state');
      }
      // Snapshot → signals only. Iterating the declared *synced* fields (rather
      // than the snapshot's keys) means an unknown snapshot key can never
      // install a new field, and `batch` coalesces the writes so reactive
      // consumers observe one commit instead of a flush per field.
      batch(() => {
        for (const [name, field] of synced) {
          field.value = state[name];
        }
      });
    },

    snapshot(): Record<string, unknown> {
      ensureActive();
      const entries: Array<[string, unknown]> = [];
      for (const [name, field] of synced) {
        // `peek()` reads without subscribing, so serializing the projection can
        // never bind `snapshot()` into a surrounding effect.
        entries.push([name, field.peek()]);
      }
      // `Object.fromEntries` creates own data properties, so even a field named
      // `__proto__` cannot hijack the returned object's prototype.
      return Object.fromEntries(entries);
    },

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      synced.clear();
      ephemeral.clear();
    },
  });
}
