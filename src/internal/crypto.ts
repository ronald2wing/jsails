/**
 * Internal constant-time comparison helpers.
 *
 * `safeEqualStrings` requires `node:crypto`, so this module is server-only: the
 * browser-safe `jsails/client` bundle must never import it (it imports only
 * `json-safe.ts` and `http.ts`, which are dependency-free). Nothing here is
 * re-exported from the package entry (`src/index.ts`).
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison that also handles differing lengths without
 * short-circuiting: unequal-length inputs are hashed to a fixed width and then
 * compared, so the length difference is not observable through timing.
 */
export function safeEqualStrings(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');
  if (aBuffer.length === bBuffer.length) {
    return timingSafeEqual(aBuffer, bBuffer);
  }
  const aDigest = createHash('sha256').update(aBuffer).digest();
  const bDigest = createHash('sha256').update(bBuffer).digest();
  return timingSafeEqual(aDigest, bDigest);
}
