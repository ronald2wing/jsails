/**
 * Bounded field serialization, inspired by DRF serializers. A serializer
 * whitelists exactly the declared fields, distinguishes write input from read
 * output, and applies `readOnly`/`writeOnly` semantics so secrets (e.g. a
 * hashed password) never leak into a representation.
 */

import type { Schema, ValidationIssue } from './validation.js';
import { ValidationError, object, optional } from './validation.js';

/** A field declaration: either a bare schema (read+write) or a tagged shape. */
export type SerializerField<T = unknown> =
  Schema<T> | { schema: Schema<T>; readOnly?: boolean; writeOnly?: boolean };

export type SerializerFields = Record<string, SerializerField<unknown>>;

type FieldValue<F> = F extends { schema: Schema<infer T> }
  ? T
  : F extends Schema<infer T>
    ? T
    : never;
type IsReadOnly<F> = F extends { readOnly: true } ? true : false;
type IsWriteOnly<F> = F extends { writeOnly: true } ? true : false;

type WriteKeys<F extends SerializerFields> = {
  [K in keyof F]: IsReadOnly<F[K]> extends true ? never : K;
}[keyof F];

type ReadKeys<F extends SerializerFields> = {
  [K in keyof F]: IsWriteOnly<F[K]> extends true ? never : K;
}[keyof F];

/** The validated input type: readOnly fields are absent, writeOnly fields included. */
export type WriteInput<F extends SerializerFields> = { [K in WriteKeys<F>]: FieldValue<F[K]> };

/** The representation type: writeOnly fields are absent, readOnly fields included. */
export type ReadOutput<F extends SerializerFields> = { [K in ReadKeys<F>]: FieldValue<F[K]> };

export interface ValidateOptions {
  /**
   * When true, only present fields are validated and required/default rules
   * are skipped for absent fields. Use for PATCH so missing fields are not
   * defaulted or overwritten.
   */
  partial?: boolean;
}

/** A serializer: validates write input and renders a whitelisted read output. */
export interface Serializer<TInput, TOutput> {
  /** The declared fields, keyed by name. */
  readonly fields: Readonly<SerializerFields>;
  /** Validate a full write payload; readOnly fields are rejected as unknown. */
  validate(input: unknown, options: { partial: true }): Partial<TInput>;
  validate(input: unknown, options?: ValidateOptions): TInput;
  /** Serialize an instance into a whitelisted read representation. */
  toRepresentation(data: unknown): TOutput;
}

interface NormalizedField {
  readonly name: string;
  readonly schema: Schema<unknown>;
  readonly readOnly: boolean;
  readonly writeOnly: boolean;
}

function normalizeFields(fields: SerializerFields): NormalizedField[] {
  const normalized: NormalizedField[] = [];
  for (const [name, raw] of Object.entries(fields)) {
    if (raw !== null && typeof raw === 'object' && 'schema' in raw) {
      const def = raw;
      if (def.readOnly === true && def.writeOnly === true) {
        throw new Error(`Serializer field "${name}" cannot be both readOnly and writeOnly`);
      }
      normalized.push({
        name,
        schema: def.schema,
        readOnly: def.readOnly === true,
        writeOnly: def.writeOnly === true,
      });
    } else {
      normalized.push({ name, schema: raw, readOnly: false, writeOnly: false });
    }
  }
  return normalized;
}

/** Builds the input schema: writeOnly + both fields, readOnly fields excluded. */
function buildInputSchema(
  fields: readonly NormalizedField[],
  partial: boolean,
): Schema<Record<string, unknown>> {
  const fieldMap: Record<string, Schema<unknown>> = {};
  for (const field of fields) {
    if (field.readOnly) {
      continue;
    }
    fieldMap[field.name] = partial ? optional(field.schema) : field.schema;
  }
  return object(fieldMap);
}

/** Builds the whitelisted read representation (readOnly + both fields). */
function buildRepresentation(
  fields: readonly NormalizedField[],
  data: unknown,
): Record<string, unknown> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ValidationError([{ path: [], code: 'type', message: 'Expected an object' }]);
  }
  const source = data as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const issues: ValidationIssue[] = [];
  for (const field of fields) {
    if (field.writeOnly) {
      continue;
    }
    const raw = source[field.name];
    if (raw === undefined) {
      continue;
    }
    output[field.name] = field.schema._validate(raw, [field.name], issues);
  }
  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
  return output;
}

/**
 * Defines a serializer from a field map. Fields declared as a bare schema are
 * read+write; wrapping a schema in `{ schema, readOnly?, writeOnly? }` tags it.
 * `readOnly` fields are excluded from input (supplying them is an unknown
 * field error) and `writeOnly` fields are excluded from the representation.
 */
export function defineSerializer<const F extends SerializerFields>(
  fields: F,
): Serializer<WriteInput<F>, ReadOutput<F>> {
  const normalized = normalizeFields(fields);
  const inputSchema = buildInputSchema(normalized, false);
  const partialInputSchema = buildInputSchema(normalized, true);

  function validate(input: unknown, options: { partial: true }): Partial<WriteInput<F>>;
  function validate(input: unknown, options?: ValidateOptions): WriteInput<F>;
  function validate(
    input: unknown,
    options?: ValidateOptions,
  ): WriteInput<F> | Partial<WriteInput<F>> {
    const schema = options?.partial === true ? partialInputSchema : inputSchema;
    return schema.validate(input) as WriteInput<F>;
  }

  return {
    fields,
    validate,
    toRepresentation(data: unknown): ReadOutput<F> {
      return buildRepresentation(normalized, data) as ReadOutput<F>;
    },
  };
}
