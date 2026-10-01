/**
 * Encrypter factory: symmetric AES-256-GCM encryption and decryption with
 * key rotation support.
 *
 * Every operation is pure — construction validates keys eagerly and returns an
 * inert {@link Encrypter} whose `encrypt`/`decrypt` methods use `node:crypto`
 * on every call. The envelope format is `v1.<iv>.<tag>.<ciphertext>` where each
 * part is base64url-encoded without padding.
 *
 * A string key is a high-entropy secret of at least 32 bytes from which a
 * 32-byte AES key is derived with HKDF-SHA256; a `Uint8Array` key is used
 * verbatim and must be exactly 32 bytes.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { EncryptionError } from './errors.js';
import type { DecryptOptions, EncryptOptions, Encrypter, EncrypterOptions } from './types.js';

// -- constants -----------------------------------------------------------------

const AES_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const ENVELOPE_VERSION = 'v1';
const ENVELOPE_SEPARATOR = '.';
const MIN_STRING_KEY_BYTES = 32;

// Domain-separation salt for deriving an AES key from a string secret. A fixed
// salt is correct here: the input is a high-entropy secret, not a password, so
// the salt's only job is to separate this derivation from any other use of the
// same secret. Truncating the string instead would silently discard entropy and
// let two secrets sharing a 32-byte prefix collide.
const KEY_DERIVATION_SALT = Buffer.from('jsails/encryption/v1', 'utf8');
const KEY_DERIVATION_INFO = Buffer.from('aes-256-gcm', 'utf8');

// -- validation ----------------------------------------------------------------

/**
 * Validate a single key entry and return a 32-byte buffer suitable for
 * `createCipheriv` / `createDecipheriv`.
 *
 * A string key is utf8-encoded and its byte length must be at least 32; a
 * 32-byte AES key is then derived from it with HKDF-SHA256, so the full secret
 * contributes to the key. A `Uint8Array` key must be exactly 32 bytes and is
 * used verbatim.
 */
function extractKeyBytes(key: string | Uint8Array): Buffer {
  if (typeof key === 'string') {
    const byteLen = Buffer.byteLength(key, 'utf8');
    if (byteLen < MIN_STRING_KEY_BYTES) {
      throw new EncryptionError('invalid_key', 'encryption key must be at least 32 bytes');
    }
    return Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(key, 'utf8'),
        KEY_DERIVATION_SALT,
        KEY_DERIVATION_INFO,
        KEY_LENGTH,
      ),
    );
  }

  if (key instanceof Uint8Array) {
    if (key.byteLength !== KEY_LENGTH) {
      throw new EncryptionError('invalid_key', 'encryption key must be exactly 32 bytes');
    }
    return Buffer.from(key.buffer, key.byteOffset, key.byteLength);
  }

  throw new EncryptionError('invalid_key', 'encryption key must be a string or Uint8Array');
}

/** Reject a non-plain-object options argument before crypto operations run. */
function assertPlainObject(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EncryptionError('invalid_options', 'invalid encrypter options');
  }
}

// -- key material --------------------------------------------------------------

/** Immutable descriptor holding pre-validated key material. */
interface KeyMaterial {
  readonly primary: Buffer;
  readonly rotation: readonly Buffer[];
}

function resolveKeyMaterial(options: EncrypterOptions): KeyMaterial {
  const primary = extractKeyBytes(options.key);

  const previous = options.previousKeys ?? [];
  const rotation: Buffer[] = [];
  for (let i = 0; i < previous.length; i++) {
    // Validate each previous key eagerly so a misconfigured rotation set fails
    // at construction rather than on the first decrypt call.
    try {
      rotation.push(extractKeyBytes(previous[i]!));
    } catch {
      throw new EncryptionError('invalid_key', `previous key at index ${i} is invalid`);
    }
  }

  return Object.freeze({ primary, rotation });
}

// -- encryption ----------------------------------------------------------------

function encryptWithKey(keyBytes: Buffer, plaintext: string, aad: string | undefined): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(AES_ALGORITHM, keyBytes, iv);

  if (aad !== undefined) {
    cipher.setAAD(Buffer.from(aad, 'utf8'));
  }

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(ENVELOPE_SEPARATOR);
}

// -- decryption ----------------------------------------------------------------

/**
 * Decode a base64url envelope part. Rejects an empty result — a well-formed
 * IV/tag/ciphertext part is never zero-length after decoding, so an empty
 * buffer indicates non-base64url input.
 */
function decodeEnvelopePart(part: string): Buffer {
  // Buffer.from with 'base64url' silently skips invalid characters, which can
  // produce an empty buffer for entirely non-base64url input. Reject that
  // explicitly so the caller gets `invalid_token`.
  const buf = Buffer.from(part, 'base64url');
  if (buf.length === 0 && part.length > 0) {
    throw new EncryptionError('invalid_token', 'invalid encryption token');
  }
  return buf;
}

function decryptWithKey(
  keyBytes: Buffer,
  iv: Buffer,
  tag: Buffer,
  ciphertext: Buffer,
  aad: string | undefined,
): string {
  const decipher = createDecipheriv(AES_ALGORITHM, keyBytes, iv);
  decipher.setAuthTag(tag);

  if (aad !== undefined) {
    decipher.setAAD(Buffer.from(aad, 'utf8'));
  }

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

// -- factory -------------------------------------------------------------------

/**
 * Create an {@link Encrypter} backed by the given options.
 *
 * Validates the primary key and every `previousKeys` entry eagerly (throwing
 * `EncryptionError` with code `invalid_key` on failure) so a misconfigured key
 * set fails before any encrypt/decrypt call.
 *
 * Returns a frozen descriptor with `encrypt` and `decrypt` methods that use
 * `node:crypto`'s AES-256-GCM on every call.
 */
export function createEncrypter(options: EncrypterOptions): Encrypter {
  if (typeof options !== 'object' || options === null) {
    throw new EncryptionError('invalid_options', 'invalid encrypter options');
  }

  const { primary, rotation } = resolveKeyMaterial(options);

  return Object.freeze({
    encrypt(plaintext: string, opts?: EncryptOptions): string {
      assertPlainObject(opts);
      return encryptWithKey(primary, plaintext, opts?.aad);
    },

    decrypt(token: string, opts?: DecryptOptions): string {
      assertPlainObject(opts);

      // Split on the envelope separator. Require exactly 4 parts.
      const parts = token.split(ENVELOPE_SEPARATOR);
      if (parts.length !== 4) {
        throw new EncryptionError('invalid_token', 'invalid encryption token');
      }

      // Version check — only v1 is currently supported.
      if (parts[0] !== ENVELOPE_VERSION) {
        throw new EncryptionError('unsupported_version', 'unsupported encryption token version');
      }

      // Decode and validate the IV, tag, and ciphertext parts.
      // Any decoding failure (including an empty decoded part) raises
      // `invalid_token`.
      let iv: Buffer;
      let tag: Buffer;
      let ciphertext: Buffer;
      try {
        iv = decodeEnvelopePart(parts[1]!);
        tag = decodeEnvelopePart(parts[2]!);
        ciphertext = decodeEnvelopePart(parts[3]!);
      } catch (err) {
        if (err instanceof EncryptionError) throw err;
        throw new EncryptionError('invalid_token', 'invalid encryption token');
      }

      // Try the primary key first, then each rotation key in order. The first
      // key that successfully authenticates and decrypts wins.
      const allKeys = [primary, ...rotation];
      for (let i = 0; i < allKeys.length; i++) {
        try {
          return decryptWithKey(allKeys[i]!, iv, tag, ciphertext, opts?.aad);
        } catch {
          // Authentication or decryption failure with this key — try the next.
        }
      }

      // No key authenticated the token — return a value-free error.
      throw new EncryptionError('decryption_failed', 'decryption failed');
    },
  });
}
