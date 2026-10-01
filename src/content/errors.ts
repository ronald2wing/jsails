/**
 * Content-layer error (`jsails/content`).
 *
 * Value-free: a `ContentError` never echoes a field value, frontmatter body, or
 * rendered HTML. The `message` may carry a source location (file path or slug)
 * because that is metadata needed to find the offending entry, not user input.
 */

import type { FieldError } from '../validation/rules.js';

/** Raised for a malformed content entry or an invalid collection definition. */
export class ContentError extends Error {
  /** Stable machine-readable code (e.g. `missing_required_field`). */
  readonly code: string;

  /**
   * Field-level validation errors, present only when thrown by frontmatter
   * schema validation. Each entry is the same value-free `{ field, message }`
   * shape as `jsails/validation`; paths are dotted and messages come from the
   * authored Zod schema (`issue.message`).
   */
  readonly errors: readonly FieldError[];

  constructor(code: string, message: string, errors: readonly FieldError[] = []) {
    super(message);
    this.name = 'ContentError';
    this.code = code;
    this.errors = Object.freeze(errors);
  }
}
