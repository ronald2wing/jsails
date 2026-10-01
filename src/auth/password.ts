/**
 * Password hashing primitives built on Node's `scrypt`.
 *
 * A stored hash is a single self-describing string that encodes the algorithm,
 * a version, the scrypt cost parameters, the random per-password salt, and the
 * derived key, all in base64url. Verifying a hash parses only that string
 * against fixed, bounded, trusted parameter ranges, so an attacker-supplied
 * hash can never force unbounded work (no CPU/memory DoS via crafted params).
 *
 * Policy decisions (minimum password length, complexity) are deliberately left
 * to the application: this module only enforces an absolute ceiling on input
 * bytes so that a single `hash`/`verify` call stays bounded regardless of input
 * size.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'scrypt';
const VERSION = 1;

/** Salt length in bytes. Fixed so `verify` can validate length cheaply. */
const SALT_BYTES = 16;
/** Derived key length in bytes. Fixed so every hash has an identical shape. */
const KEY_BYTES = 64;

/**
 * Trusted scrypt cost ranges. `hash` only produces parameters inside these
 * bounds, and `verify` rejects any encoded parameters outside them as malformed
 * (returning `false` rather than running scrypt with attacker-chosen costs).
 */
const MIN_N = 16; // 2^4
const MAX_N = 16384; // 2^14
const DEFAULT_N = 16384;
const MIN_R = 1;
const MAX_R = 8;
const DEFAULT_R = 8;
const MIN_P = 1;
const MAX_P = 4;
const DEFAULT_P = 1;

/**
 * Backstop memory bound passed to scrypt. Well above the ~16 MiB that the
 * maximum allowed parameters (MAX_N * MAX_R) require, so it never rejects a
 * legitimate hash while still capping runaway allocation if the parameter
 * bounds above are ever bypassed. (OpenSSL also allocates a small extra block
 * of `128 * r * (p + 2)` bytes beyond `128 * N * r`, so the cap must leave
 * headroom.)
 */
const MAX_MEM = 64 * 1024 * 1024;

/**
 * Absolute ceiling on the password input, measured in UTF-8 bytes. There is no
 * minimum here: the application owns password-length policy.
 */
export const MAX_PASSWORD_BYTES = 1024;

/** Optional scrypt cost overrides for `hashPassword`; all optional with sane defaults. */
export interface PasswordHashOptions {
  /** CPU/memory cost; a power of two in [16, 16384]. Defaults to 16384. */
  N?: number;
  /** Block size; an integer in [1, 8]. Defaults to 8. */
  r?: number;
  /** Parallelization; an integer in [1, 4]. Defaults to 1. */
  p?: number;
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  expected: Buffer;
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function assertValidParams(N: number, r: number, p: number): void {
  if (!Number.isInteger(N) || !isPowerOfTwo(N) || N < MIN_N || N > MAX_N) {
    throw new RangeError(`scrypt N must be a power of two in [${MIN_N}, ${MAX_N}]; got ${N}`);
  }
  if (!Number.isInteger(r) || r < MIN_R || r > MAX_R) {
    throw new RangeError(`scrypt r must be an integer in [${MIN_R}, ${MAX_R}]; got ${r}`);
  }
  if (!Number.isInteger(p) || p < MIN_P || p > MAX_P) {
    throw new RangeError(`scrypt p must be an integer in [${MIN_P}, ${MAX_P}]; got ${p}`);
  }
}

function assertPasswordBytes(password: string): void {
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes > MAX_PASSWORD_BYTES) {
    throw new RangeError(
      `password is ${bytes} bytes, exceeding the ${MAX_PASSWORD_BYTES}-byte limit`,
    );
  }
}

function scryptAsync(
  password: Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) {
        reject(err);
      } else {
        resolve(derivedKey);
      }
    });
  });
}

/** Strict unsigned-integer parse: digits only, within [min, max], safe integer. */
function parseBoundedInt(value: string | undefined, min: number, max: number): number | null {
  if (value === undefined || value === '' || !/^\d+$/.test(value)) {
    return null;
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    return null;
  }
  return n;
}

/**
 * Strictly decode a base64url field to exactly `expectedBytes` bytes, rejecting
 * any character outside the alphabet, wrong length, or non-canonical form.
 * Returns `null` on any malformation rather than throwing.
 */
function decodeBase64Url(value: string | undefined, expectedBytes: number): Buffer | null {
  if (value === undefined || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  const buffer = Buffer.from(value, 'base64url');
  if (buffer.length !== expectedBytes) {
    return null;
  }
  // Canonical round-trip: `Buffer.from(..., 'base64url')` is lenient, so a
  // re-encode must reproduce the input exactly for it to be well-formed.
  if (buffer.toString('base64url') !== value) {
    return null;
  }
  return buffer;
}

/**
 * Parse an encoded hash into its components, or return `null` when the string
 * is malformed or uses parameters outside the trusted bounds. Never throws.
 */
function parseEncoded(encoded: string): ParsedHash | null {
  const parts = encoded.split('$');
  if (parts.length !== 7) {
    return null;
  }
  if (parts[0] !== ALGORITHM || parts[1] !== String(VERSION)) {
    return null;
  }
  const N = parseBoundedInt(parts[2], MIN_N, MAX_N);
  const r = parseBoundedInt(parts[3], MIN_R, MAX_R);
  const p = parseBoundedInt(parts[4], MIN_P, MAX_P);
  if (N === null || r === null || p === null || !isPowerOfTwo(N)) {
    return null;
  }
  const salt = decodeBase64Url(parts[5], SALT_BYTES);
  const expected = decodeBase64Url(parts[6], KEY_BYTES);
  if (salt === null || expected === null) {
    return null;
  }
  return { N, r, p, salt, expected };
}

/**
 * Hash a password with a fresh random salt and return a self-describing,
 * versioned string. Throws on invalid cost parameters or an oversized password
 * (both developer errors); see {@link verifyPassword} for the untrusted path.
 */
export async function hashPassword(
  password: string,
  options: PasswordHashOptions = {},
): Promise<string> {
  const N = options.N ?? DEFAULT_N;
  const r = options.r ?? DEFAULT_R;
  const p = options.p ?? DEFAULT_P;
  assertValidParams(N, r, p);
  assertPasswordBytes(password);

  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(Buffer.from(password, 'utf8'), salt, KEY_BYTES, {
    N,
    r,
    p,
    maxmem: MAX_MEM,
  });

  return [ALGORITHM, VERSION, N, r, p, salt.toString('base64url'), key.toString('base64url')].join(
    '$',
  );
}

/**
 * Verify a password against an encoded hash in constant time. Returns `false`
 * (never throws) for a wrong password, an oversized password, or any malformed
 * or out-of-bounds hash string.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof encoded !== 'string') {
    return false;
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return false;
  }

  const parsed = parseEncoded(encoded);
  if (parsed === null) {
    return false;
  }

  const actual = await scryptAsync(Buffer.from(password, 'utf8'), parsed.salt, KEY_BYTES, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem: MAX_MEM,
  });

  return timingSafeEqual(actual, parsed.expected);
}
