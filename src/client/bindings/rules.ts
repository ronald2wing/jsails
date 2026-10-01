/**
 * Client-side field validation for the component binding layer.
 *
 * Owns the server-derived `data-jsails-rules` marker contract: parsing it into
 * bounded {@link FieldValidationRules} (`parseFieldRules`), evaluating a value
 * against those rules (`evaluateFieldRules`), and applying the outcome to a
 * bound control (`applyFieldValidation`) or across a whole root (`validateAll`).
 * Rules are advisory only — the server re-validates strictly on every update —
 * so a hostile marker is re-bounded here rather than trusted to drive unbounded
 * work. The structural DOM contract (`ComponentElement`) is imported type-only
 * from `./controller.js`.
 */

import type { JsonValue } from '../../contracts/http.js';
import {
  ERROR_FOR_ATTRIBUTE,
  MAX_OPTIONS,
  MAX_OPTION_LENGTH,
  MAX_PATTERN_LENGTH,
  MAX_RULES_JSON_LENGTH,
  MODEL_ATTRIBUTE,
  RULES_ATTRIBUTE,
  type FieldRuleTypeHint,
  type FieldValidationRules,
} from '../../server-components/protocol.js';
import type { ComponentElement } from './controller.js';
import { MODEL_SELECTOR, readControlValue, type ResolveOwner } from './control-values.js';

/** The slice of a live binding rule application touches: the root to search. */
interface RuleBindingView {
  readonly element: ComponentElement;
}

/** Loose shape check for an email string; advisory, the server re-validates. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** ISO `yyyy-mm-dd` shape produced by a native date input. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Mutable accumulator {@link parseFieldRules} fills in place. */
interface MutableFieldValidationRules {
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

/** True for a bounded, safe integer the client may use as a rule bound. */
function isSafeBound(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Parse a control's `data-jsails-rules` marker into rules, or `null` when the
 * marker is absent, malformed, or out of bounds. The marker is served HTML, but
 * it is still untrusted client input: every field is re-validated and bounded
 * here so a hostile marker never drives an unbounded comparison.
 */
export function parseFieldRules(raw: string | null): FieldValidationRules | null {
  if (raw === null || raw === '' || raw.length > MAX_RULES_JSON_LENGTH) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.required !== 'boolean') {
    return null;
  }

  const rules: MutableFieldValidationRules = { required: record.required };

  const type = record.type;
  if (
    type === 'string' ||
    type === 'number' ||
    type === 'boolean' ||
    type === 'email' ||
    type === 'date'
  ) {
    rules.type = type;
  }

  if (isSafeBound(record.minLength)) {
    rules.minLength = record.minLength;
  }
  if (isSafeBound(record.maxLength)) {
    rules.maxLength = record.maxLength;
  }

  if (typeof record.pattern === 'string' && record.pattern.length <= MAX_PATTERN_LENGTH) {
    rules.pattern = record.pattern;
  }

  if (typeof record.min === 'number' && Number.isFinite(record.min)) {
    rules.min = record.min;
  }
  if (typeof record.max === 'number' && Number.isFinite(record.max)) {
    rules.max = record.max;
  }
  if (typeof record.step === 'number' && Number.isFinite(record.step) && record.step > 0) {
    rules.step = record.step;
  }

  if (Array.isArray(record.options) && record.options.length <= MAX_OPTIONS) {
    const options = record.options.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length <= MAX_OPTION_LENGTH,
    );
    if (options.length === record.options.length) {
      rules.options = options;
    }
  }

  return rules;
}

/** Test a rule pattern defensively; a malformed pattern is treated as matching. */
function matchesPattern(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern).test(text);
  } catch {
    // The server still enforces the real schema; a malformed client hint is
    // never allowed to produce a false validation error.
    return true;
  }
}

/** True when `value` is a whole multiple of `step` within float tolerance. */
function isMultipleOf(value: number, step: number): boolean {
  const quotient = value / step;
  return Math.abs(quotient - Math.round(quotient)) < 1e-9;
}

/** Evaluate number min/max/step bounds, returning the first failing message. */
function evaluateNumberBounds(value: number, rules: FieldValidationRules): string | undefined {
  if (rules.min !== undefined && value < rules.min) {
    return `Must be at least ${rules.min}`;
  }
  if (rules.max !== undefined && value > rules.max) {
    return `Must be at most ${rules.max}`;
  }
  if (rules.step !== undefined && !isMultipleOf(value, rules.step)) {
    return `Must be a multiple of ${rules.step}`;
  }
  return undefined;
}

/**
 * Evaluate a control's value against its rules, returning a value-free
 * validation message or `undefined` when valid. Advisory only: it never
 * asserts a constraint the rules do not carry, and the server re-validates
 * strictly on every update.
 */
export function evaluateFieldRules(
  value: JsonValue,
  rules: FieldValidationRules,
): string | undefined {
  if (rules.required && (value === null || value === undefined || value === '')) {
    return 'This field is required';
  }
  if (rules.required && Array.isArray(value) && value.length === 0) {
    return 'This field is required';
  }
  // An empty, non-required value satisfies every remaining check.
  if (value === null || value === undefined || value === '') {
    return undefined;
  }

  const type = rules.type ?? 'string';
  switch (type) {
    case 'email': {
      const text = typeof value === 'string' ? value : String(value);
      if (!EMAIL_PATTERN.test(text)) {
        return 'Enter a valid email address';
      }
      break;
    }
    case 'number': {
      if (typeof value === 'string') {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
          return 'Enter a number';
        }
        return evaluateNumberBounds(parsed, rules);
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 'Enter a number';
      }
      return evaluateNumberBounds(value, rules);
    }
    case 'date': {
      if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
        return 'Enter a valid date';
      }
      break;
    }
    case 'boolean':
      break;
    case 'string': {
      const text = typeof value === 'string' ? value : String(value);
      if (rules.minLength !== undefined && text.length < rules.minLength) {
        return `Must be at least ${rules.minLength} characters`;
      }
      if (rules.maxLength !== undefined && text.length > rules.maxLength) {
        return `Must be at most ${rules.maxLength} characters`;
      }
      if (rules.pattern !== undefined && !matchesPattern(rules.pattern, text)) {
        return 'Invalid format';
      }
      break;
    }
  }

  if (rules.options !== undefined && rules.options.length > 0) {
    const text = String(value);
    if (!rules.options.includes(text)) {
      return 'Invalid selection';
    }
  }

  return undefined;
}

/** Find the error-display element for a field, if the author provided one. */
function findErrorElement(binding: RuleBindingView, name: string): ComponentElement | null {
  for (const element of Array.from(binding.element.querySelectorAll(`[${ERROR_FOR_ATTRIBUTE}]`))) {
    if (element.getAttribute(ERROR_FOR_ATTRIBUTE) === name) {
      return element;
    }
  }
  return null;
}

/**
 * Apply a field's rules to its current value: set/clear `aria-invalid` and
 * write/clear the author's error element (when present). Returns the message,
 * or `undefined` when valid. The error element is never created here — its
 * markup and placement belong to the author.
 */
export function applyFieldValidation(
  binding: RuleBindingView,
  control: ComponentElement,
  name: string,
  value: JsonValue,
): string | undefined {
  const rules = parseFieldRules(control.getAttribute(RULES_ATTRIBUTE));
  const message = rules === null ? undefined : evaluateFieldRules(value, rules);
  if (message === undefined) {
    control.removeAttribute('aria-invalid');
  } else {
    control.setAttribute('aria-invalid', 'true');
  }
  const errorElement = findErrorElement(binding, name);
  if (errorElement !== null) {
    errorElement.textContent = message ?? '';
  }
  return message;
}

/** Validate every bound control; returns the first invalid control or `null`. */
export function validateAll(
  binding: RuleBindingView,
  resolveOwner: ResolveOwner,
): ComponentElement | null {
  for (const control of Array.from(binding.element.querySelectorAll(MODEL_SELECTOR))) {
    if (resolveOwner(control) !== binding.element) {
      continue;
    }
    const name = control.getAttribute(MODEL_ATTRIBUTE);
    if (name === null || name === '') {
      continue;
    }
    const message = applyFieldValidation(binding, control, name, readControlValue(control));
    if (message !== undefined) {
      return control;
    }
  }
  return null;
}
