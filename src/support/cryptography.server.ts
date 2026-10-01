import { createHash, createHmac, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

import { SupportError } from './errors.js';
import { Cryptography } from './cryptography.js';

// The server addendum does NOT re-export a second `Cryptography` namespace.
// `Cryptography` is one coherent, browser-safe, async surface (see
// `cryptography.ts`); the server only layers the genuinely server-only
// conveniences below under distinct names, so there is never a "server
// Cryptography" that shadows a "browser Cryptography".

export { Cryptography };

// ---------------------------------------------------------------------------
// Domain error
// ---------------------------------------------------------------------------

export type ServerCryptographyErrorCode = 'unsupported_algorithm' | 'invalid_argument';

export class CryptographyError extends SupportError {
  readonly code: ServerCryptographyErrorCode;

  constructor(code: ServerCryptographyErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Algorithms (synchronous, node:crypto — a strict superset of the browser subset)
// ---------------------------------------------------------------------------

/**
 * Hash algorithms available server-side — a superset of the browser subset,
 * adding MD5 (which WebCrypto lacks) and the SHA-3 family. These are reachable
 * through {@link hashSync} only; the shared async `Cryptography.hash` stays the
 * browser-safe SHA-1/256/384/512 surface so isomorphic code never diverges.
 */
export type ServerHashAlgorithm =
  'MD5' | 'SHA-1' | 'SHA-224' | 'SHA-256' | 'SHA-384' | 'SHA-512' | 'sha3-256' | 'sha3-512';

export type HmacAlgorithm = 'SHA-256' | 'SHA-384' | 'SHA-512';

const SUPPORTED_HASHES: readonly string[] = [
  'MD5',
  'SHA-1',
  'SHA-224',
  'SHA-256',
  'SHA-384',
  'SHA-512',
  'sha3-256',
  'sha3-512',
];

function validateHash(value: string): asserts value is ServerHashAlgorithm {
  if (SUPPORTED_HASHES.includes(value)) return;
  // Value-free: never echo the algorithm name back.
  throw new CryptographyError('unsupported_algorithm', 'Unsupported hash algorithm');
}

function validateHmac(value: string): asserts value is HmacAlgorithm {
  if (['SHA-256', 'SHA-384', 'SHA-512'].includes(value)) return;
  throw new CryptographyError('unsupported_algorithm', 'Unsupported HMAC algorithm');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBytes(value: string | Uint8Array): Buffer | Uint8Array {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
}

// ---------------------------------------------------------------------------
// Server-only synchronous API
// ---------------------------------------------------------------------------

/**
 * Lowercase-hex digest using any `node:crypto` hash algorithm (includes MD5 and
 * SHA-3). Synchronous — the server-only escape hatch for legacy interop hashes
 * the async browser-safe {@link Cryptography.hash} cannot express.
 */
export function hashSync(algorithm: ServerHashAlgorithm, data: string | Uint8Array): string {
  validateHash(algorithm);
  return createHash(algorithm).update(toBytes(data)).digest('hex');
}

/** HMAC digest as lowercase hex. Synchronous, server-only. */
export function hmacSync(
  algorithm: HmacAlgorithm,
  key: string | Uint8Array,
  data: string | Uint8Array,
): string {
  validateHmac(algorithm);
  return createHmac(algorithm, toBytes(key)).update(toBytes(data)).digest('hex');
}

/**
 * True constant-time byte comparison via `node:crypto.timingSafeEqual`.
 * Returns `false` on length mismatch (never throws for that case).
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.byteLength !== b.byteLength) return false;
  return nodeTimingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Frozen server-only namespace (the shared `Cryptography` is re-exported above)
// ---------------------------------------------------------------------------

export const ServerCryptography = Object.freeze({
  hashSync,
  hmacSync,
  timingSafeEqual,
  ...Cryptography,
});
