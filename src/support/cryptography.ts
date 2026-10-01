import { SupportError } from './errors.js';

// ---------------------------------------------------------------------------
// Domain error
// ---------------------------------------------------------------------------

export class CryptographyError extends SupportError {
  readonly code: string;

  constructor(code: 'unsupported_algorithm' | 'insecure_context', message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Algorithm validation
// ---------------------------------------------------------------------------

export type HashAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

const SUPPORTED_ALGORITHMS: readonly string[] = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'];

/**
 * Algorithms that are known hash algorithms but deliberately not offered in the
 * browser subset. Naming one of these in an error is safe — the value is a
 * fixed enumeration, not arbitrary user input.
 */
const KNOWN_UNSUPPORTED = new Set(['MD5']);

function validateAlgorithm(value: string): asserts value is HashAlgorithm {
  if (SUPPORTED_ALGORITHMS.includes(value)) return;

  if (KNOWN_UNSUPPORTED.has(value)) {
    throw new CryptographyError(
      'unsupported_algorithm',
      `Algorithm '${value}' is not supported browser-side; supported: SHA-1, SHA-256, SHA-384, SHA-512`,
    );
  }

  // Arbitrary / unknown input — value-free.
  throw new CryptographyError('unsupported_algorithm', 'Unsupported hash algorithm');
}

// ---------------------------------------------------------------------------
// SubtleCrypto guard
// ---------------------------------------------------------------------------

function requireSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new CryptographyError(
      'insecure_context',
      'Web Crypto requires a secure context (crypto.subtle is unavailable)',
    );
  }
  return subtle;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBytes(value: string | Uint8Array): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  // Copy into a fresh buffer with a concrete ArrayBuffer backing so the
  // result satisfies BufferSource for Web Crypto API signatures.
  return new Uint8Array(value);
}

function bufferToHex(buffer: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < buffer.length; i++) {
    hex += (buffer[i] ?? 0).toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Base64url encoding: standard base64 made URL-safe by replacing `+` with `-`,
 * `/` with `_`, and stripping trailing `=` padding.
 */
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce a lowercase hex digest of `value` using the given hash algorithm.
 *
 * Input is UTF-8 encoded when a string.  Defaults to SHA-256.
 */
export async function hash(
  value: string | Uint8Array,
  algorithm: HashAlgorithm = 'SHA-256',
): Promise<string> {
  validateAlgorithm(algorithm);
  const subtle = requireSubtle();
  const data = toBytes(value);
  const digest = await subtle.digest(algorithm, data as unknown as BufferSource);
  return bufferToHex(new Uint8Array(digest));
}

/**
 * Produce an HMAC digest as lowercase hex.
 *
 * The `key` and `value` are UTF-8 encoded when strings.  Defaults to SHA-256.
 */
export async function hmac(
  value: string | Uint8Array,
  key: string | Uint8Array,
  algorithm: HashAlgorithm = 'SHA-256',
): Promise<string> {
  validateAlgorithm(algorithm);
  const subtle = requireSubtle();
  const keyBytes = toBytes(key);
  const dataBytes = toBytes(value);

  const cryptoKey = await subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'HMAC', hash: algorithm as unknown as AlgorithmIdentifier },
    false,
    ['sign'],
  );

  const signature = await subtle.sign('HMAC', cryptoKey, dataBytes as unknown as BufferSource);
  return bufferToHex(new Uint8Array(signature));
}

/**
 * Generate a URL-safe random token; `bytes` defaults to 32.
 *
 * Uses `crypto.getRandomValues` — the host must be in a secure context.
 */
export function randomToken(bytes = 32): string {
  // randomToken reads from crypto.getRandomValues, which is available in
  // insecure contexts even when subtle is not.  Only gate on getRandomValues
  // being missing (practically unreachable in any modern runtime).
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return base64url(buf);
}

/**
 * Constant-time best-effort string comparison.
 *
 * Returns `false` on length mismatch and never throws.  JS cannot guarantee
 * true constant-time against a JIT, but this avoids the early-return timing
 * leak of `===` by comparing every byte.
 */
export function equal(a: string | Uint8Array, b: string | Uint8Array): boolean {
  if (typeof a !== 'string' && !(a instanceof Uint8Array)) return false;
  if (typeof b !== 'string' && !(b instanceof Uint8Array)) return false;

  const bufA = typeof a === 'string' ? new TextEncoder().encode(a) : a;
  const bufB = typeof b === 'string' ? new TextEncoder().encode(b) : b;

  if (bufA.byteLength !== bufB.byteLength) return false;

  let result = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    result |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  }
  return result === 0;
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

export const Cryptography = Object.freeze({
  hash,
  hmac,
  randomToken,
  equal,
});
