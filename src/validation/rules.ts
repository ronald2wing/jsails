/**
 * Composable, value-free validation rules built on Zod.
 *
 * Each rule returns either a Zod schema (directly composable into
 * `z.object({...})`) or a `ValidationRule` predicate used as an extra
 * cross-field check. Messages never echo input values.
 *
 * ## Zod-backed rules (compose into z.object)
 *
 * - {@link required}  — non-empty string
 * - {@link email}     — valid email address
 * - {@link url}       — valid URL
 * - {@link minLength} / {@link maxLength} — string length bounds
 * - {@link min} / {@link max} — numeric bounds
 * - {@link regex}     — pattern match
 * - {@link inList}    — value must be in a whitelist
 *
 * ## Predicate-based rules (standalone cross-field checks)
 *
 * - {@link confirmed} — field must match `<field>_confirmation`
 * - {@link when}      — apply a rule only when a condition holds
 *
 * ## Bulk validation
 *
 * - {@link validateFields} — runs a Zod object schema against values and
 *   returns value-free field errors.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A cross-field or conditional validation predicate. */
export interface ValidationRule {
  /**
   * Validate a single field value, optionally with access to all submitted
   * values (needed by `confirmed` / `when`). Returns `null` on success, or a
   * value-free error message on failure.
   */
  check(value: unknown, allValues?: Record<string, unknown>): string | null;
}

/** A single value-free field error. */
export interface FieldError {
  readonly field: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Primitive Zod-backed rules
// ---------------------------------------------------------------------------

/**
 * Require a non-empty string. Rejects `undefined`, `null`, and whitespace-only
 * values.
 */
export function required(message?: string): z.ZodString {
  return z
    .string()
    .trim()
    .min(1, message ?? 'This field is required.');
}

/**
 * Validate a string as a well-formed email address. Delegates to Zod's
 * built-in `email()` check.
 */
export function email(message?: string): z.ZodString {
  return z.string().email(message ?? 'A valid email address is required.');
}

/**
 * Validate a string as a well-formed URL. Delegates to Zod's built-in `url()`
 * check.
 */
export function url(message?: string): z.ZodString {
  return z.string().url(message ?? 'A valid URL is required.');
}

/** Require a string with at least `n` characters. */
export function minLength(n: number, message?: string): z.ZodString {
  return z.string().min(n, message ?? `Must be at least ${String(n)} characters.`);
}

/** Require a string with at most `n` characters. */
export function maxLength(n: number, message?: string): z.ZodString {
  return z.string().max(n, message ?? `Must be at most ${String(n)} characters.`);
}

/** Require a number at or above `n`. */
export function min(n: number, message?: string): z.ZodNumber {
  return z.number().min(n, message ?? `Must be at least ${String(n)}.`);
}

/** Require a number at or below `n`. */
export function max(n: number, message?: string): z.ZodNumber {
  return z.number().max(n, message ?? `Must be at most ${String(n)}.`);
}

/** Require a string matching a regular expression. */
export function regex(pattern: RegExp, message?: string): z.ZodString {
  return z.string().regex(pattern, message ?? 'Invalid format.');
}

/** Require a value to be one of a whitelist of allowed strings. */
export function inList(values: readonly string[], message?: string): z.ZodString {
  const set = new Set(values);
  return z.string().refine((v) => set.has(v), message ?? 'Invalid selection.');
}

// ---------------------------------------------------------------------------
// Predicate-based rules
// ---------------------------------------------------------------------------

/**
 * Require a field to match its `<field>_confirmation` companion. The companion
 * field must also be present in `allValues`; otherwise the check fails.
 */
export function confirmed(field: string, message?: string): ValidationRule {
  const confirmationField = `${field}_confirmation`;

  return {
    check(_value: unknown, allValues?: Record<string, unknown>): string | null {
      if (allValues === undefined) {
        return message ?? `The ${field} confirmation could not be verified.`;
      }
      if (!(confirmationField in allValues)) {
        return message ?? `The ${field} confirmation is required.`;
      }
      const original = String(allValues[field] ?? '');
      const confirmation = String(allValues[confirmationField] ?? '');
      if (original !== confirmation) {
        return message ?? `The ${field} confirmation does not match.`;
      }
      return null;
    },
  };
}

/**
 * Apply a rule only when a condition over all submitted values holds. When
 * the condition is `false`, the rule is skipped (passes).
 */
export function when(
  condition: (values: Record<string, unknown>) => boolean,
  rule: z.ZodType | ValidationRule,
): ValidationRule {
  const isZod = rule instanceof z.ZodType;

  return {
    check(value: unknown, allValues?: Record<string, unknown>): string | null {
      const values = allValues ?? {};
      if (!condition(values)) {
        return null;
      }
      if (isZod) {
        const zodRule: z.ZodType = rule;
        const result = zodRule.safeParse(value);
        if (result.success) {
          return null;
        }
        return result.error.issues[0]?.message ?? 'Invalid value.';
      }
      const validationRule: ValidationRule = rule;
      return validationRule.check(value, values);
    },
  };
}

// ---------------------------------------------------------------------------
// Bulk validation helper
// ---------------------------------------------------------------------------

/**
 * Validate values against a Zod object schema and return value-free field
 * errors. Zod issue paths are flattened to dotted field names; messages never
 * echo input values.
 */
export function validateFields(schema: z.ZodObject<z.ZodRawShape>, values: unknown): FieldError[] {
  const result = schema.safeParse(values);
  if (result.success) {
    return [];
  }

  return result.error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join('.') : '_root';
    return {
      field,
      message: issue.message,
    };
  });
}
