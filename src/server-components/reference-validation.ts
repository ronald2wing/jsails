/**
 * Shared key/claim validation for the server-component reference signers.
 *
 * Upload and download references validate the same key bytes and claim shapes;
 * these helpers live here (server-only) so the two surfaces cannot drift. The
 * snapshot signer keeps its own stricter subject semantics and does not reuse
 * the `validateSubject` below.
 */

import { SAFE_SEGMENT_PATTERN } from './reference-constants.js';

/** Coerce a signing key to a `Buffer`, invoking `fail` for a wrong type. */
export function normalizeKey(
  key: string | Uint8Array,
  fail: (code: 'invalid_input', message: string) => never,
): Buffer {
  if (typeof key === 'string') return Buffer.from(key, 'utf8');
  if (key instanceof Uint8Array) return Buffer.from(key);
  return fail('invalid_input', 'reference key must be a string or Uint8Array');
}

/** Validate a component name: non-empty, `<= 255` chars. */
export function validateComponent(value: unknown, fail: () => never): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 255) {
    fail();
  }
  return value;
}

/** Validate a nullable subject: `null` allowed, else a safe path segment. */
export function validateSubject(value: unknown, fail: () => never): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !SAFE_SEGMENT_PATTERN.test(value)) {
    fail();
  }
  return value;
}
