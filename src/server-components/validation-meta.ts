/**
 * Zod-derived validation metadata for server-component fields.
 *
 * `extractFieldRules(schema)` reduces a field's Zod schema to a bounded,
 * JSON-serializable {@link FieldValidationRules} object; `serializeFieldRules`
 * turns that object into the value of a `data-jsails-rules` marker the runtime
 * spreads onto a model-bound control. The client parses the marker and applies
 * the rules as instant (pre-round-trip) feedback only — the server schema stays
 * the sole authority, and every server render re-validates strictly.
 *
 * Rules are advisory by construction: anything this module cannot represent
 * (transforms, refinements, unions, nested objects, custom formats) is omitted
 * rather than guessed, so the client never asserts a constraint the schema does
 * not carry. Oversized metadata (a huge regex source or enum) throws a
 * value-free {@link ValidationMetaError} instead of being silently truncated.
 */

import { z } from 'zod';

import {
  MAX_OPTION_LENGTH,
  MAX_OPTIONS,
  MAX_PATTERN_LENGTH,
  MAX_RULES_JSON_LENGTH,
  type FieldRuleTypeHint,
  type FieldValidationRules,
} from './protocol.js';

export type { FieldValidationRules } from './protocol.js';

/** Raised when a field's schema cannot be represented within the metadata bounds. Value-free. */
export class ValidationMetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationMetaError';
  }
}

/** The mutable accumulator `extractFieldRules` fills in place. */
interface MutableRules {
  required: boolean;
  type?: FieldRuleTypeHint;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[];
}

/**
 * The slice of a Zod 4 check definition this module reads. Zod 4 stores checks
 * on `schema._zod.def.checks`; each check's `_zod.def` carries `check` plus
 * type-specific fields (`minimum`, `maximum`, `value`, `inclusive`, `format`,
 * `pattern`). Declared structurally so the module stays independent of the
 * private check unions.
 */
interface ZodCheckDef {
  readonly check?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly value?: number | bigint;
  readonly inclusive?: boolean;
  readonly format?: string;
  readonly pattern?: RegExp;
}

/** Read a schema's checks as a narrow structural shape, or `[]` when absent. */
function readChecks(schema: z.ZodType): readonly ZodCheckDef[] {
  const internals = (schema as { _zod?: { def?: { checks?: readonly unknown[] } } })._zod;
  const checks = internals?.def?.checks;
  if (checks === undefined) {
    return [];
  }
  const result: ZodCheckDef[] = [];
  for (const check of checks) {
    const def = (check as { _zod?: { def?: ZodCheckDef } } | null | undefined)?._zod?.def;
    if (def !== null && typeof def === 'object') {
      result.push(def);
    }
  }
  return result;
}

/** True when the schema is one of Zod's number types (`z.number()`, `.int()`, coerce). */
function isNumberSchema(schema: z.ZodType): schema is z.ZodType & {
  format: string | null;
} {
  return schema instanceof z.ZodNumber || schema instanceof z.ZodNumberFormat;
}

/**
 * Peel Optional/Nullable/Default wrappers (and a single Pipe hop) to the
 * underlying schema, tracking whether any wrapper allows an absent value.
 * `required` is the inverse: a field whose value may be omitted or null is not
 * required, so the client does not flag an empty control for it.
 */
function unwrap(schema: z.ZodType): { schema: z.ZodType; optional: boolean } {
  let current = schema;
  let optional = false;
  for (;;) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault
    ) {
      optional = true;
      current = current.unwrap() as unknown as z.ZodType;
      continue;
    }
    if (current instanceof z.ZodPipe) {
      const out = (current as unknown as { _zod?: { def?: { out?: z.ZodType } } })._zod?.def?.out;
      if (out !== undefined && out !== current) {
        current = out;
        continue;
      }
    }
    break;
  }
  return { schema: current, optional };
}

/** Extract the regex source from a string schema's `regex` check, bounded. */
function extractPattern(schema: z.ZodType): string | undefined {
  for (const check of readChecks(schema)) {
    if (check.check === 'string_format' && check.format === 'regex') {
      const source = check.pattern?.source;
      if (source === undefined) {
        return undefined;
      }
      if (source.length > MAX_PATTERN_LENGTH) {
        throw new ValidationMetaError('validation pattern exceeds the maximum length');
      }
      return source;
    }
  }
  return undefined;
}

/** Extract min/max/step bounds from a number schema's checks. */
function applyNumberBounds(schema: z.ZodType, rules: MutableRules): void {
  for (const check of readChecks(schema)) {
    if (check.check === 'greater_than' && typeof check.value === 'number') {
      // An exclusive `.gt(n)` bound is collapsed to its inclusive neighbor; the
      // hint is advisory and the server enforces the exact bound.
      rules.min = check.value;
    } else if (check.check === 'less_than' && typeof check.value === 'number') {
      rules.max = check.value;
    } else if (
      check.check === 'multiple_of' &&
      typeof check.value === 'number' &&
      check.value > 0
    ) {
      rules.step = check.value;
    }
  }
}

/** Extract a bounded, frozen copy of an enum's options. */
function extractOptions(options: readonly string[]): readonly string[] {
  if (options.length > MAX_OPTIONS) {
    throw new ValidationMetaError('field declares too many options');
  }
  for (const option of options) {
    if (option.length > MAX_OPTION_LENGTH) {
      throw new ValidationMetaError('field option exceeds the maximum length');
    }
  }
  return Object.freeze([...options]);
}

/**
 * Reduce a field's Zod schema to client-side validation rules.
 *
 * Only the portable scalar shapes are represented: strings (with length, email,
 * date, and regex constraints), numbers (with min/max/step), booleans, and
 * enums. Optional/nullable/default wrappers fold into `required: false`. Every
 * other schema (transforms, unions, literals, objects, arrays, custom formats)
 * yields only its `required` flag — the client has nothing more it can safely
 * assert, and the server re-validates regardless.
 */
export function extractFieldRules(schema: z.ZodType): FieldValidationRules {
  const { schema: base, optional } = unwrap(schema);
  const rules: MutableRules = { required: !optional };

  if (base instanceof z.ZodString || base instanceof z.ZodStringFormat) {
    const stringSchema = base as z.ZodType & {
      format: string | null;
      minLength: number | null;
      maxLength: number | null;
    };
    const format = stringSchema.format;
    if (format === 'email') {
      rules.type = 'email';
    } else if (format === 'date') {
      rules.type = 'date';
    } else {
      rules.type = 'string';
    }
    if (stringSchema.minLength !== null) {
      rules.minLength = stringSchema.minLength;
    }
    if (stringSchema.maxLength !== null) {
      rules.maxLength = stringSchema.maxLength;
    }
    if (format === 'regex') {
      rules.pattern = extractPattern(base);
    }
    return rules;
  }

  if (isNumberSchema(base)) {
    rules.type = 'number';
    applyNumberBounds(base, rules);
    return rules;
  }

  if (base instanceof z.ZodBoolean) {
    rules.type = 'boolean';
    return rules;
  }

  if (base instanceof z.ZodDate) {
    rules.type = 'date';
    return rules;
  }

  if (base instanceof z.ZodEnum) {
    rules.options = extractOptions(base.options.map((option) => String(option)));
    return rules;
  }

  return rules;
}

/**
 * Serialize rules to a `data-jsails-rules` marker value, or `undefined` when
 * the rules carry nothing the client can act on (only `required: false`).
 * Throws {@link ValidationMetaError} when the serialized form exceeds the
 * marker bound — metadata is bounded, never truncated.
 */
export function serializeFieldRules(rules: FieldValidationRules): string | undefined {
  const keys = Object.keys(rules);
  if (keys.length === 0 || (keys.length === 1 && rules.required === false)) {
    return undefined;
  }
  const json = JSON.stringify(rules);
  if (json.length > MAX_RULES_JSON_LENGTH) {
    throw new ValidationMetaError('validation rules exceed the maximum length');
  }
  return json;
}
