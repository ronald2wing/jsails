/**
 * SEO-layer error (`jsails/seo`).
 *
 * Value-free: a `SeoError` never echoes a metadata value, a page title, a URL,
 * or rendered HTML. The `message` may name a field path because that is
 * structural metadata, not user content.
 */

import type { FieldError } from '../validation/rules.js';

/** Raised for malformed metadata, an invalid base URL, or an unbuildable sitemap. */
export class SeoError extends Error {
  /** Stable machine-readable code (e.g. `invalid_metadata`). */
  readonly code: string;

  /**
   * Field-level validation errors, present only when thrown by
   * {@link defineMetadata} shape validation. Each entry is the same value-free
   * `{ field, message }` shape as `jsails/validation`; paths are dotted.
   */
  readonly errors: readonly FieldError[];

  constructor(code: string, message: string, errors: readonly FieldError[] = []) {
    super(message);
    this.name = 'SeoError';
    this.code = code;
    this.errors = Object.freeze(errors);
  }
}
