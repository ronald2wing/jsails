/**
 * Form body parsing for plain pages and API handlers.
 *
 * `readForm(request, schema)` reads the request body with a hard byte bound,
 * decodes it as `application/x-www-form-urlencoded` (or JSON when the
 * content-type says so), and validates the result against a {@link Schema}. It
 * returns a discriminated result — typed values on success, or a value-free list
 * of field errors on failure — so a handler renders the errors itself rather
 * than throwing:
 *
 * ```ts
 * const result = await readForm(request, object({ email: string({ min: 1 }), age: integer() }));
 * if (!result.ok) {
 *   return json({ errors: result.errors }, 400);
 * }
 * result.value; // typed
 * ```
 *
 * Form semantics are deliberately strict, matching the rest of the API surface:
 * `application/x-www-form-urlencoded` yields strings (repeated keys become
 * string arrays), and there is **no implicit coercion** — a form field feeding an
 * `integer()`/`boolean()` schema must already be that type, which JSON bodies
 * carry natively. For an HTML form, use `string()` fields (the common login/
 * registration case) or interpret the values in the handler.
 *
 * A missing or empty `content-type` is treated as form-urlencoded. Any other
 * content type yields an `unsupported_content_type` error. Non-field failures
 * (body too large, malformed JSON, unsupported type) are represented as single
 * issues with an empty path and a stable code, so every failure has the same
 * shape as a field error and none ever echo the raw body.
 */

import { concatBytes } from '../internal/bytes.js';
import {
  ValidationError,
  type FieldPath,
  type Schema,
  type ValidationIssue,
} from './validation.js';

/** Options for {@link readForm}. */
export interface ReadFormOptions {
  /** Upper bound on the request body, in bytes. Defaults to 64 KiB. */
  readonly maxBytes?: number;
}

/** The result of reading and validating a form body. */
export type FormResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] };

const DEFAULT_MAX_BYTES = 64 * 1024;

/**
 * Read and validate a form/JSON request body. Returns typed values on success,
 * or a value-free field-error result on any validation or body failure. Never
 * throws for a malformed or oversized body.
 */
export async function readForm<T>(
  request: Request,
  schema: Schema<T>,
  options: ReadFormOptions = {},
): Promise<FormResult<T>> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('maxBytes must be a positive integer');
  }

  const text = await readBodyText(request, maxBytes);
  if (text === null) {
    return { ok: false, errors: [issue([], 'body_too_large', 'Request body too large')] };
  }

  const contentType = detectContentType(request.headers.get('content-type'));
  let value: unknown;
  if (contentType === 'json') {
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, errors: [issue([], 'invalid_json', 'Invalid JSON body')] };
    }
  } else if (contentType === 'form') {
    value = parseFormUrlEncoded(text);
  } else {
    return {
      ok: false,
      errors: [issue([], 'unsupported_content_type', 'Unsupported content type')],
    };
  }

  try {
    return { ok: true, value: schema.validate(value) };
  } catch (error) {
    if (error instanceof ValidationError) {
      return { ok: false, errors: error.issues };
    }
    throw error;
  }
}

/** Reads and decodes the body with a hard byte bound; `null` means too large. */
async function readBodyText(request: Request, maxBytes: number): Promise<string | null> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return null;
    }
  }

  const body = request.body;
  if (body === null) {
    return '';
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined) {
        received += value.byteLength;
        if (received > maxBytes) {
          return null;
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concatBytes(chunks));
}

/** Maps a content-type header to a body kind; empty/missing defaults to form. */
function detectContentType(header: string | null): 'json' | 'form' | 'unknown' {
  const mime = (header ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mime.length === 0 || mime === 'application/x-www-form-urlencoded') {
    return 'form';
  }
  if (mime === 'application/json' || mime.endsWith('+json')) {
    return 'json';
  }
  return 'unknown';
}

/** Decodes form-urlencoded text; repeated keys become string arrays. */
function parseFormUrlEncoded(text: string): Record<string, string | string[]> {
  const params = new URLSearchParams(text);
  const record: Record<string, string | string[]> = {};
  for (const [key, value] of params) {
    const existing = record[key];
    if (existing === undefined) {
      record[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      record[key] = [existing, value];
    }
  }
  return record;
}

function issue(path: FieldPath, code: string, message: string): ValidationIssue {
  return { path, code, message };
}
