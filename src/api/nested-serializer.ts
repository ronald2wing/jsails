/**
 * Nested serializers: the DRF `ModelSerializer` nested-write analog over the
 * flat `defineSerializer` contract. A nested serializer wraps an existing flat
 * `base` serializer and declares relations that read and write as nested
 * objects instead of flat foreign-key or array columns.
 *
 * ## Contract
 *
 * `defineNestedSerializer({ base, relations })` returns a `Serializer` with the
 * same shape as `defineSerializer` — `{ fields, validate, toRepresentation }`:
 *
 * - **Read** (`toRepresentation`): starts from `base.toRepresentation(data)`,
 *   then, for each relation, removes the flat `key` column and inlines the
 *   loaded nested object(s) read from `data[name]` (falling back to
 *   `data[key]`). A to-many relation is an array; each element is serialized
 *   with the nested serializer. A raw foreign key (a scalar id, or an array of
 *   scalar ids) has no loaded object to inline, so the flat `key` column is
 *   passed through unchanged.
 *
 * - **Write** (`validate`): splits the nested keys off the payload, validates
 *   the remaining flat fields with `base`, validates each nested object (or
 *   array of objects) with its own serializer, and flattens the result back
 *   into the parent's `key` column. A `null` relation clears it. Absent
 *   relations are skipped, so `partial: true` never fabricates a nested value.
 *
 * The nested serializer performs no persistence and no I/O: on read it inlines
 * whatever object(s) the caller already loaded onto the parent row; on write it
 * only reshapes and validates. Creating or updating the related rows from a
 * nested payload is the `ResourceStore`'s job — the flat `key` column carries
 * the validated nested object(s) the store needs to do that.
 *
 * ## Constraints
 *
 * - `base` must NOT declare the relation `key` (or the relation name) itself:
 *   the nested serializer owns those columns, removing them on read and
 *   writing them on write. Declaring them on `base` makes `base.validate`
 *   require or reject them.
 * - To-one vs to-many is inferred from the runtime value shape (an array means
 *   "many") because the descriptor carries no `many` flag. The returned
 *   serializer is therefore typed `Serializer<unknown, unknown>` rather than a
 *   precise per-field projection.
 */

import { isForbiddenKey, isPlainObject } from '../internal/json-safe.js';
import type { Serializer, ValidateOptions } from './serialization.js';
import { ValidationError } from './validation.js';

/** Raised when the `relations` descriptor is malformed. Value-free: the message
 *  never echoes the offending name, key, or serializer. */
export class NestedSerializerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NestedSerializerError';
  }
}

/** A single relation: a nested serializer plus the parent column it maps to. */
export interface NestedRelationDescriptor {
  /** Serializer for the related object(s). */
  readonly serializer: Serializer<unknown, unknown>;
  /**
   * Parent column holding the foreign key (to-one) or array (to-many). Defaults
   * to the relation field name.
   */
  readonly key?: string;
}

export type NestedRelations = Readonly<Record<string, NestedRelationDescriptor>>;

export interface DefineNestedSerializerOptions {
  /** The flat serializer whose fields are augmented with nested relations. */
  readonly base: Serializer<unknown, unknown>;
  /** Relation field name -> nested descriptor. */
  readonly relations: NestedRelations;
}

interface NormalizedRelation {
  readonly name: string;
  readonly serializer: Serializer<unknown, unknown>;
  readonly key: string;
}

/**
 * Builds a nested serializer over a flat `base` serializer. The result composes
 * with `createResourceHandlers` exactly like `defineSerializer`'s: reads inline
 * loaded relations, writes accept nested objects and flatten them onto the
 * parent's `key` columns.
 */
export function defineNestedSerializer(
  options: DefineNestedSerializerOptions,
): Serializer<unknown, unknown> {
  const { base, relations } = options;
  if (!isSerializer(base)) {
    throw new NestedSerializerError('base must be a serializer');
  }
  const normalized = normalizeRelations(relations);
  const relationNames = new Set(normalized.map((relation) => relation.name));

  function toRepresentation(data: unknown): unknown {
    const out = base.toRepresentation(data) as Record<string, unknown>;
    if (!isPlainObject(data)) {
      // base.toRepresentation rejects non-objects before this; a defensive no-op.
      return out;
    }
    for (const { name, serializer, key } of normalized) {
      const nested = readNested(data, name, key);
      if (nested === undefined) {
        continue; // relation not loaded: keep the flat column visible
      }
      const inlined = inlineNested(nested, serializer);
      if (inlined === undefined) {
        continue; // raw foreign key / id array: nothing to inline
      }
      delete out[key];
      out[name] = inlined;
    }
    return out;
  }

  function validate(input: unknown, options: { partial: true }): Partial<unknown>;
  function validate(input: unknown, options?: ValidateOptions): unknown;
  function validate(input: unknown, options?: ValidateOptions): unknown {
    const { flat, nested } = splitInput(input, relationNames);
    const baseResult = base.validate(flat, options) as Record<string, unknown>;
    const result: Record<string, unknown> = { ...baseResult };
    for (const { name, serializer, key } of normalized) {
      if (!hasOwn(nested, name)) {
        continue; // absent relation: required/default/overwrite semantics stay on the base layer
      }
      result[key] = flattenNested(nested[name], serializer);
    }
    return result;
  }

  return { fields: base.fields, validate, toRepresentation };
}

/** Structural serializer check: enough shape to interop with the contract. */
function isSerializer(value: unknown): value is Serializer<unknown, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { validate?: unknown; toRepresentation?: unknown };
  return (
    typeof candidate.validate === 'function' && typeof candidate.toRepresentation === 'function'
  );
}

function normalizeRelations(relations: NestedRelations): NormalizedRelation[] {
  if (!isPlainObject(relations)) {
    throw new NestedSerializerError('relations must be a non-null object of relation descriptors');
  }
  const normalized: NormalizedRelation[] = [];
  for (const [name, descriptor] of Object.entries(relations)) {
    if (name.length === 0) {
      throw new NestedSerializerError('a relation name must be a non-empty string');
    }
    if (isForbiddenKey(name)) {
      throw new NestedSerializerError('a relation name must not be a reserved prototype key');
    }
    if (!isPlainObject(descriptor)) {
      throw new NestedSerializerError('a relation descriptor must be an object');
    }
    if (!isSerializer(descriptor.serializer)) {
      throw new NestedSerializerError('a relation descriptor requires a serializer');
    }
    const key = descriptor.key ?? name;
    if (typeof key !== 'string' || key.length === 0 || isForbiddenKey(key)) {
      throw new NestedSerializerError('a relation key must be a non-empty, non-reserved string');
    }
    normalized.push({ name, serializer: descriptor.serializer, key });
  }
  return normalized;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Routes the nested relation keys away from the flat payload passed to `base`. */
function splitInput(
  input: unknown,
  relationNames: ReadonlySet<string>,
): { flat: Record<string, unknown>; nested: Record<string, unknown> } {
  if (!isPlainObject(input)) {
    throw new ValidationError([{ path: [], code: 'type', message: 'Expected an object' }]);
  }
  const flat = Object.create(null) as Record<string, unknown>;
  const nested = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    (relationNames.has(key) ? nested : flat)[key] = input[key];
  }
  return { flat, nested };
}

/** Reads the loaded relation, preferring the relation name over the `key` column. */
function readNested(source: Record<string, unknown>, name: string, key: string): unknown {
  if (source[name] !== undefined) {
    return source[name];
  }
  return source[key];
}

/**
 * Inlines a loaded relation value, or returns `undefined` when it is a raw
 * reference (a scalar foreign key, or an array of scalar ids) that cannot be
 * serialized without the loaded object(s).
 */
function inlineNested(nested: unknown, serializer: Serializer<unknown, unknown>): unknown {
  if (nested === null) {
    return null;
  }
  if (Array.isArray(nested)) {
    if (nested.length === 0) {
      return [];
    }
    if (nested.every((item) => isPlainObject(item))) {
      return nested.map((item) => serializer.toRepresentation(item));
    }
    return undefined;
  }
  if (isPlainObject(nested)) {
    return serializer.toRepresentation(nested);
  }
  return undefined;
}

/** Validates a nested write value and flattens it onto the parent `key` column. */
function flattenNested(raw: unknown, serializer: Serializer<unknown, unknown>): unknown {
  if (raw === null) {
    return null;
  }
  if (Array.isArray(raw)) {
    return raw.map((item) => serializer.validate(item));
  }
  return serializer.validate(raw);
}
