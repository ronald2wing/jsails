/**
 * Bounded schema validation, inspired by DRF serializers but deliberately
 * small and strict: explicit field builders, no implicit coercion, structured
 * error paths, and full TypeScript output inference.
 *
 * A `Schema<T>` validates untrusted `unknown` input into a typed value or
 * throws a `ValidationError` whose issues carry structured `path` locations
 * (e.g. `["user", "tags", 2]`) and stable `code`s. Messages never echo raw
 * input values, so secrets cannot leak through error text.
 *
 * Validation is backed by real Zod schemas: every field compiles to a
 * `z.ZodType` and every input is parsed with `safeParse`, so type checks,
 * bounds, and nested traversal are performed by Zod rather than bespoke
 * runtime checks. Zod issues are translated into the stable `ValidationIssue`
 * shape (paths, codes, and value-free messages) before surfacing, and the
 * raw `input`/`received` fields Zod attaches to issues are never copied into
 * messages.
 */

import { z } from 'zod';

/** A location inside a nested document: object keys then array indices. */
export type FieldPath = ReadonlyArray<string | number>;

/** A single validation failure, keyed by its structured location. */
export interface ValidationIssue {
  /** Where the failure occurred, e.g. `["user", "tags", 2]`. */
  readonly path: FieldPath;
  /** Stable machine code, e.g. `"type"`, `"min_length"`, `"unknown_field"`. */
  readonly code: string;
  /** Human-readable description. Never echoes input values. */
  readonly message: string;
}

/** Options shared by every field builder. */
export interface FieldOptions<T = unknown> {
  /** When true, an absent/undefined value validates as `undefined`. */
  optional?: boolean;
  /** When true, `null` validates as `null`. */
  nullable?: boolean;
  /**
   * Value substituted when the input is absent/undefined. Implies `optional`.
   * Must be a non-null value matching the field type.
   */
  default?: T;
}

/**
 * A field schema. Validates `unknown` into a typed value or throws
 * `ValidationError`.
 */
export interface Schema<T = unknown> {
  /** Validate input, returning the typed value. Throws `ValidationError`. */
  validate(input: unknown): T;
  /** @internal Validate into an existing issue list at a known path. */
  _validate(input: unknown, path: FieldPath, issues: ValidationIssue[]): T;
}

/** Extract the validated output type from a schema. */
export type Infer<S> = S extends Schema<infer T> ? T : never;

/** Thrown when validation fails. Carries structured issues, never raw input. */
export class ValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(issues.map(formatIssue).join('; '));
    this.name = 'ValidationError';
    this.issues = issues;
  }

  /** Dotted locations for every issue, e.g. `["user.tags.2"]`. */
  get paths(): readonly string[] {
    return this.issues.map((issue) => formatPath(issue.path));
  }
}

function formatPath(path: FieldPath): string {
  return path.join('.');
}

function formatIssue(issue: ValidationIssue): string {
  const location = issue.path.length > 0 ? `${formatPath(issue.path)}: ` : '';
  return `${location}${issue.message}`;
}

/** Computes the validated output type from a field's options. */
type FieldOutput<T, O extends FieldOptions<unknown>> = O extends { default: unknown }
  ? O extends { nullable: true }
    ? T | null
    : T
  : O extends { optional: true }
    ? O extends { nullable: true }
      ? T | null | undefined
      : T | undefined
    : O extends { nullable: true }
      ? T | null
      : T;

// ---------------------------------------------------------------------------
// Zod-backed internals
// ---------------------------------------------------------------------------

/**
 * Two Zod views of one field. `withDefault` applies the field's `default`
 * (used when the field is composed into an object so a defaulted key appears);
 * `base` suppresses it (used by `optional()` so PATCH validation never
 * fabricates defaults).
 */
interface ZodPair {
  readonly base: z.ZodType;
  readonly withDefault: z.ZodType;
}

interface ZodSchema<T = unknown> extends Schema<T> {
  readonly _zodPair: ZodPair;
}

function asZodSchema<T>(schema: Schema<T>): ZodSchema<T> {
  return schema as ZodSchema<T>;
}

/** Applies optional/nullable/default presence to a concrete-value Zod type. */
function withPresence(base: z.ZodType, options: FieldOptions<unknown>): ZodPair {
  let type = base;
  if (options.nullable === true) {
    type = type.nullable();
  }
  if (options.optional === true || options.default !== undefined) {
    type = type.optional();
  }
  const withDefault = options.default !== undefined ? type.default(options.default) : type;
  return { base: type, withDefault };
}

function makeSchema<T>(pair: ZodPair): Schema<T> {
  const schema: ZodSchema<T> = {
    _zodPair: pair,
    validate(input: unknown): T {
      const issues: ValidationIssue[] = [];
      const value = parseWith(pair.withDefault, input, [], issues);
      if (issues.length > 0) {
        throw new ValidationError(issues);
      }
      return value as T;
    },
    _validate(input: unknown, path: FieldPath, issues: ValidationIssue[]): T {
      return parseWith(pair.withDefault, input, path, issues) as T;
    },
  };
  return schema;
}

/** Parses with a Zod type, appending mapped issues for any failures. */
function parseWith(
  schema: z.ZodType,
  input: unknown,
  prefix: FieldPath,
  issues: ValidationIssue[],
): unknown {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  for (const issue of mapZodError(result.error, input, prefix)) {
    issues.push(issue);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Zod issue -> ValidationIssue mapping (value-free, stable codes)
// ---------------------------------------------------------------------------

function mapZodError(error: z.ZodError, input: unknown, prefix: FieldPath): ValidationIssue[] {
  const mapped: ValidationIssue[] = [];
  for (const issue of error.issues) {
    mapped.push(...mapIssue(issue, input, prefix));
  }
  return mapped;
}

function mapIssue(issue: z.ZodIssue, input: unknown, prefix: FieldPath): ValidationIssue[] {
  const path: FieldPath = [...prefix, ...(issue.path as unknown as FieldPath)];
  switch (issue.code) {
    case 'invalid_type':
      return [mapInvalidType(issue, input, path)];
    case 'too_small':
      return [mapBound(issue.origin, issue.minimum, path, 'min')];
    case 'too_big':
      return [mapBound(issue.origin, issue.maximum, path, 'max')];
    case 'unrecognized_keys':
      return issue.keys.map((key) => ({
        path: [...path, key],
        code: 'unknown_field',
        message: `Unknown field "${key}"`,
      }));
    default:
      // Zod can emit other issue kinds (e.g. invalid_format); emit a generic,
      // value-free message and keep the structured path. Never echo the input.
      return [{ path, code: 'invalid', message: 'Invalid value' }];
  }
}

function mapInvalidType(
  issue: Extract<z.ZodIssue, { code: 'invalid_type' }>,
  input: unknown,
  path: FieldPath,
): ValidationIssue {
  const received = valueAtPath(input, issue.path);
  if (received === undefined) {
    return { path, code: 'required', message: 'This field is required' };
  }
  if (received === null) {
    return { path, code: 'null_not_allowed', message: 'Value must not be null' };
  }
  return { path, code: 'type', message: typeMessage(issue.expected) };
}

function mapBound(
  origin: string,
  bound: number | bigint,
  path: FieldPath,
  kind: 'min' | 'max',
): ValidationIssue {
  switch (origin) {
    case 'string':
      return {
        path,
        code: kind === 'min' ? 'min_length' : 'max_length',
        message: `Must be at ${kind === 'min' ? 'least' : 'most'} ${bound} characters`,
      };
    case 'number':
    case 'int':
      return {
        path,
        code: kind === 'min' ? 'min_value' : 'max_value',
        message: `Must be at ${kind === 'min' ? 'least' : 'most'} ${bound}`,
      };
    case 'array':
      return {
        path,
        code: kind === 'min' ? 'min_length' : 'max_length',
        message: `Must have at ${kind === 'min' ? 'least' : 'most'} ${bound} items`,
      };
    default:
      return { path, code: 'invalid', message: 'Invalid value' };
  }
}

function typeMessage(expected: string): string {
  switch (expected) {
    case 'string':
      return 'Expected a string';
    case 'number':
    case 'int':
      return 'Expected an integer';
    case 'boolean':
      return 'Expected a boolean';
    case 'object':
    case 'record':
      return 'Expected an object';
    case 'array':
    case 'tuple':
      return 'Expected an array';
    default:
      return 'Expected a valid value';
  }
}

/** Walks `input` to the value at `path`, without ever copying it into text. */
function valueAtPath(input: unknown, path: readonly PropertyKey[]): unknown {
  let value = input;
  for (const segment of path) {
    if (value === null || value === undefined || typeof value !== 'object') {
      return undefined;
    }
    value = (value as Record<PropertyKey, unknown>)[segment];
  }
  return value;
}

// ---------------------------------------------------------------------------
// Field builders
// ---------------------------------------------------------------------------

export interface StringOptions extends FieldOptions<string> {
  /** Minimum length in characters (inclusive). */
  min?: number;
  /** Maximum length in characters (inclusive). */
  max?: number;
  /** When true, trims leading/trailing whitespace before length checks. */
  trim?: boolean;
}

/** A strict string field: no coercion, optional trim, optional bounds. */
export function string<const O extends StringOptions = {}>(
  options: O = {} as O,
): Schema<FieldOutput<string, O>> {
  const trimmed = options.trim === true ? z.string().trim() : z.string();
  const withMin = options.min !== undefined ? trimmed.min(options.min) : trimmed;
  const withMax = options.max !== undefined ? withMin.max(options.max) : withMin;
  return makeSchema<FieldOutput<string, O>>(withPresence(withMax, options));
}

export interface IntegerOptions extends FieldOptions<number> {
  /** Minimum value (inclusive). */
  min?: number;
  /** Maximum value (inclusive). */
  max?: number;
}

/** A strict integer field: rejects floats, `NaN`, and numeric strings. */
export function integer<const O extends IntegerOptions = {}>(
  options: O = {} as O,
): Schema<FieldOutput<number, O>> {
  const int = z.number().int();
  const withMin = options.min !== undefined ? int.min(options.min) : int;
  const withMax = options.max !== undefined ? withMin.max(options.max) : withMin;
  return makeSchema<FieldOutput<number, O>>(withPresence(withMax, options));
}

export interface BooleanOptions extends FieldOptions<boolean> {}

/**
 * A strict boolean field: only `true`/`false` are accepted. `1`, `0`,
 * `"true"`, and `"false"` are rejected — there is no coercion.
 */
export function boolean<const O extends BooleanOptions = {}>(
  options: O = {} as O,
): Schema<FieldOutput<boolean, O>> {
  return makeSchema<FieldOutput<boolean, O>>(withPresence(z.boolean(), options));
}

export interface ObjectOptions extends FieldOptions<unknown> {
  /** When true, unknown keys are allowed instead of rejected. Default false. */
  allowUnknown?: boolean;
}

type ObjectOutput<F extends Record<string, Schema<unknown>>> = {
  [K in keyof F]: Infer<F[K]>;
};

/**
 * A strict object field. Rejects unknown keys by default and validates every
 * declared field against its schema.
 */
export function object<
  const F extends Record<string, Schema<unknown>>,
  const O extends ObjectOptions = {},
>(fields: F, options: O = {} as O): Schema<FieldOutput<ObjectOutput<F>, O>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, fieldSchema] of Object.entries(fields)) {
    shape[key] = asZodSchema(fieldSchema)._zodPair.withDefault;
  }
  const base = options.allowUnknown === true ? z.object(shape) : z.object(shape).strict();
  return makeSchema<FieldOutput<ObjectOutput<F>, O>>(withPresence(base, options));
}

export interface ArrayOptions<E = unknown> extends FieldOptions<E[]> {
  /** Minimum number of elements (inclusive). */
  min?: number;
  /** Maximum number of elements (inclusive). */
  max?: number;
}

/** A strict array field; every element is validated against `item`. */
export function array<T, const O extends ArrayOptions<T> = {}>(
  item: Schema<T>,
  options: O = {} as O,
): Schema<FieldOutput<T[], O>> {
  const base = z.array(asZodSchema(item)._zodPair.withDefault);
  const withMin = options.min !== undefined ? base.min(options.min) : base;
  const withMax = options.max !== undefined ? withMin.max(options.max) : withMin;
  return makeSchema<FieldOutput<T[], O>>(withPresence(withMax, options));
}

/**
 * Wraps a schema so an absent value validates as `undefined` without applying
 * its default or required rules. Useful for composing reusable fields and for
 * partial (PATCH) validation where defaults must not be applied.
 */
export function optional<T>(schema: Schema<T>): Schema<T | undefined> {
  const base = asZodSchema(schema)._zodPair.base.optional();
  return makeSchema<T | undefined>({ base, withDefault: base });
}
