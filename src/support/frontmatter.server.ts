import matter from 'gray-matter';
import { serializeError as serializeErrorLib } from 'serialize-error';

import { SupportError } from './errors.js';

// ---------------------------------------------------------------------------
// Domain error
// ---------------------------------------------------------------------------

export type FrontmatterErrorCode = 'invalid_argument';

export class FrontmatterError extends SupportError {
  readonly code: FrontmatterErrorCode;

  constructor(code: FrontmatterErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FrontmatterResult<T = Record<string, unknown>> {
  readonly data: T;
  readonly content: string;
}

/** A JSON-safe projection of an arbitrary thrown value. */
export type SerializedError = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a Markdown document's YAML frontmatter.
 *
 * Returns `{ data, content }` where `data` is the parsed frontmatter and
 * `content` is the body with the frontmatter block removed. Throws a
 * value-free `FrontmatterError` on a malformed document.
 */
export function parseFrontmatter<T = Record<string, unknown>>(input: string): FrontmatterResult<T> {
  if (typeof input !== 'string') {
    throw new FrontmatterError('invalid_argument', 'parseFrontmatter: expected a string');
  }
  try {
    const parsed = matter(input);
    return { data: parsed.data as T, content: parsed.content };
  } catch (error) {
    throw new FrontmatterError('invalid_argument', 'parseFrontmatter: malformed document', {
      cause: error,
    });
  }
}

/**
 * Turn any thrown value into a plain, JSON-safe object.
 *
 * A non-`Error` value is represented without echoing it verbatim.
 */
export function serializeError(error: unknown): SerializedError {
  return serializeErrorLib(error);
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

export const Frontmatter = Object.freeze({
  parse: parseFrontmatter,
  serializeError,
});
