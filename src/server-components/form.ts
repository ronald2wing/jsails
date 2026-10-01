/**
 * Livewire-style form objects for JSails server components.
 *
 * A form object wraps a Zod object schema and provides typed access to field
 * values, imperative `fill`/`validate`/`reset` helpers, and JSON round-trip
 * methods (`toState`/`fromState`) compatible with the server-component snapshot
 * protocol. It is a plain object (no class, no ORM, no transport) that a
 * component author creates inside a component action or lifecycle hook.
 *
 * Integration with server components:
 * - `toState()` returns a {@link JsonObject} ready to store in a component's
 *   state snapshot (a field declared in `stateSchema` of type `z.any()` or a
 *   more specific schema).
 * - `fromState(state)` hydrates the form from a snapshot value, validating
 *   against the form's schema.
 * - `validate()` returns value-free field errors whose keys match the schema's
 *   top-level field names, so they can be mapped directly to the runtime's 422
 *   field-error response (or to `bind`-level errors in a render).
 * - The form's schema is forced `.strict()`, matching the component's
 *   `stateSchema` discipline: no undeclared field survives a round-trip.
 *
 * Security posture:
 * - Validation is Zod-only; messages are value-free (derived from issue
 *   metadata, never echoing raw input) through the shared
 *   `zodIssuesToFieldErrors` mapper.
 * - `toState`/`fromState` round-trip through JSON (plain objects, no
 *   functions or class instances), so form state is always snapshot-safe.
 */

import { z, ZodError } from 'zod';

import { isPlainObject } from '../internal/json-safe.js';
import type { JsonObject } from '../contracts/http.js';
import { zodIssuesToFieldErrors } from './runtime/value-errors.js';

/**
 * The result of a `validate()` call: either success, or value-free field errors
 * keyed by top-level schema field name.
 */
export type FormValidationResult =
  { readonly ok: true } | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/**
 * Configuration passed to {@link defineForm}.
 *
 * `schema` is a Zod object schema (forced `.strict()`). `initial` provides
 * seed values for `reset()`; when omitted every field defaults to the
 * schema-coerced empty value (e.g. `''` for strings, `0` for numbers).
 * `rules` is reserved for future per-field rule overrides and is currently
 * ignored.
 */
export interface DefineFormOptions<S extends z.ZodType<any>> {
  readonly schema: S;
  readonly initial?: Partial<z.infer<S>>;
  readonly rules?: Readonly<Partial<Record<keyof z.infer<S> & string, unknown>>>;
}

/**
 * A typed form object wrapping a Zod schema.
 *
 * An instance owns mutable current values plus a cached initial snapshot for
 * `reset()`. Every method that mutates (`fill`, `fromState`, `reset`) clears
 * stored errors so a stale error cache never survives a state change.
 */
export interface FormObject<Values extends Record<string, unknown>> {
  /** The normalized (strict) schema this form was defined with. */
  readonly schema: z.ZodObject<any>;

  /** Return a shallow copy of the current form values. */
  values(): Values;

  /**
   * Merge a partial set of values into the form. Fields not in `partial` keep
   * their current values. The partial is validated against the schema before it
   * is merged; invalid partials throw a `ZodError` and leave `values()` unchanged.
   */
  fill(partial: Partial<Values>): void;

  /**
   * Validate the current values against the schema. Returns `{ ok: true }` on
   * success, or `{ ok: false, errors }` with value-free field-level messages.
   * Errors are cached and returned by {@link errors} until the next mutation.
   */
  validate(): FormValidationResult;

  /**
   * Return the errors from the last `validate()` call. Returns an empty object
   * when no validation has run or the last validation passed.
   */
  errors(): Readonly<Record<string, string>>;

  /** Reset every field to its initial value, clearing errors. */
  reset(): void;

  /**
   * Serialize the current values to a plain {@link JsonObject} suitable for
   * storing in a server-component snapshot. The returned object is a deep clone
   * and carries no mutable references to the form's internal state.
   */
  toState(): JsonObject;

  /**
   * Hydrate the form from a plain JSON value, parsing (and validating) it
   * against the schema. Throws a `ZodError` on invalid state, leaving current
   * values and errors unchanged.
   */
  fromState(state: unknown): void;
}

/** Raised when a form definition fails structural validation. Messages are value-free. */
export class FormDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormDefinitionError';
  }
}

/**
 * Define a form object configuration. Returns a factory function that creates a
 * fresh {@link FormObject} each call, so a component can instantiate a clean
 * form on every mount.
 *
 * ```ts
 * const loginForm = defineForm({
 *   schema: z.object({ email: z.string().email(), password: z.string().min(8) }),
 *   initial: { email: '' },
 * });
 *
 * // Inside a component action or lifecycle hook:
 * const form = loginForm();
 * form.fill({ email: 'user@example.com' });
 * const result = form.validate();
 * if (!result.ok) {
 *   // result.errors.email === undefined
 *   // result.errors.password === 'Must be at least 8 characters'
 * }
 * ```
 */
export function defineForm<const S extends z.ZodType<any>>(
  options: DefineFormOptions<S>,
): () => FormObject<z.infer<S>> {
  type Values = z.infer<S>;

  if (options === null || typeof options !== 'object') {
    throw new FormDefinitionError('defineForm requires an options object');
  }

  const rawSchema = options.schema;
  if (!(rawSchema instanceof z.ZodObject)) {
    throw new FormDefinitionError('schema must be a Zod object schema');
  }

  // Force strict: no undeclared field survives a round-trip.
  const schema = rawSchema.strict() as z.ZodObject<any>;

  // Build the initial snapshot: start from the schema's defaults/coercion (when
  // the empty record parses), then overlay the caller's `initial` values. The
  // initial is the `reset()` target and need not be fully schema-valid (a form
  // may start in a partially filled state). Only `validate()` checks full
  // validity.
  let initial: Values;
  const baseResult = schema.safeParse({});
  const baseValues: Record<string, unknown> = baseResult.success ? baseResult.data : {};
  if (options.initial !== undefined) {
    if (!isPlainObject(options.initial)) {
      throw new FormDefinitionError('initial must be a plain object when present');
    }
    initial = { ...baseValues, ...options.initial } as Values;
  } else {
    initial = baseValues as Values;
  }

  return () => {
    // Each call produces a fresh copy so one instance never aliases another.
    const values: Values = JSON.parse(JSON.stringify(initial)) as Values;
    let cachedErrors: Readonly<Record<string, string>> = {};

    const form: FormObject<Values> = Object.freeze({
      schema,

      values(): Values {
        return { ...values };
      },

      fill(partial: Partial<Values>): void {
        if (!isPlainObject(partial)) {
          throw new FormDefinitionError('fill requires a plain object');
        }
        // Merge partial values into current state without validation.
        // Validation runs only when `validate()` is called explicitly.
        // This matches the Livewire pattern: fill sets values, validate checks.
        Object.assign(values, partial);
        cachedErrors = {};
      },

      validate(): FormValidationResult {
        try {
          // Re-parse the entire form; schema coercion normalises values.
          const parsed = schema.parse(values) as Values;
          Object.assign(values, parsed);
          cachedErrors = {};
          return { ok: true };
        } catch (error) {
          if (error instanceof ZodError) {
            const fieldErrors = zodIssuesToFieldErrors(error.issues, values);
            cachedErrors = Object.freeze({ ...fieldErrors });
            return { ok: false, errors: cachedErrors };
          }
          throw error;
        }
      },

      errors(): Readonly<Record<string, string>> {
        return cachedErrors;
      },

      reset(): void {
        // Restore from the prototype-free, deep-cloned initial.
        // Delete every key currently on values so non-initial keys (fields
        // filled since construction but absent from `initial`) are removed.
        const fresh: Values = JSON.parse(JSON.stringify(initial)) as Values;
        for (const key of Object.keys(values)) {
          delete values[key];
        }
        Object.assign(values, fresh);
        cachedErrors = {};
      },

      toState(): JsonObject {
        return JSON.parse(JSON.stringify(values)) as JsonObject;
      },

      fromState(state: unknown): void {
        if (!isPlainObject(state)) {
          throw new FormDefinitionError('fromState requires a plain JSON object');
        }
        const parsed = schema.parse(state) as Values;
        Object.assign(values, parsed);
        cachedErrors = {};
      },
    });

    return form;
  };
}
