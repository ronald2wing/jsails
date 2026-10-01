/**
 * Attribute encryption: an entity hook bridge that encrypts named fields before
 * persistence and decrypts them after load.
 *
 * {@link encrypts} returns an {@link EntityHooksDefinition} gating
 * `beforeInsert`/`beforeUpdate` (encrypt) and `afterLoad` (decrypt) on the
 * fields declared.  Wire it through {@link createEntitySubscriber} into a
 * {@link JsailsDataSource} `subscribers` array, exactly like
 * {@link entityValidationHooks}.
 *
 * Two modes are available:
 *
 * - **Non-deterministic (default)** — uses the caller-supplied {@link Encrypter}
 *   (AES-256-GCM, random IV). Ciphertext is different every call even for
 *   identical plaintext. The encrypted column is **not queryable by equality**.
 *
 * - **Deterministic** (`deterministic: true`) — uses a local AES-256-GCM cipher
 *   whose IV is derived from the plaintext (SHA-256 → first 12 bytes), so equal
 *   plaintexts always yield equal ciphertext and the column **is** queryable by
 *   equality.  This is opt-in because **equality of ciphertext leaks equality of
 *   plaintext**.  A separate `deterministicKey` is required; the primary
 *   encrypter's key is never extracted.
 *
 * On decrypt failure (tampered or foreign ciphertext) the hook throws a
 * value-free {@link EncryptionError} (`decryption_failed`) — the field value
 * is never echoed.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync } from 'node:crypto';
import type { EntityTarget, ObjectLiteral } from 'typeorm';

import { EncryptionError } from '../encryption/errors.js';
import type { Encrypter } from '../encryption/types.js';
import { defineEntityHooks, type EntityHooksDefinition } from './entity-subscribers.js';

// -- types --------------------------------------------------------------------

/** Options controlling the {@link encrypts} hook bridge. */
export interface EncryptsOptions {
  /**
   * When `true`, a local deterministic cipher is used so equal plaintexts
   * produce equal ciphertext (equality-queryable).  Defaults to `false`
   * (non-deterministic, random IV).
   */
  readonly deterministic?: boolean;

  /**
   * Additional authenticated data bound to every encrypt/decrypt call.
   * Must match on both sides; a mismatch fails decryption.
   */
  readonly aad?: string;

  /**
   * The key for the **deterministic** cipher path.  Required when
   * `deterministic` is `true`; ignored otherwise.  A string must be at least
   * 32 bytes (a 32-byte AES key is derived via HKDF-SHA256); a `Uint8Array`
   * must be exactly 32 bytes.
   */
  readonly deterministicKey?: string | Uint8Array;
}

// -- constants ----------------------------------------------------------------

const AES_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const MIN_STRING_KEY_BYTES = 32;
const ENVELOPE_VERSION = 'v1';
const ENVELOPE_SEPARATOR = '.';

// Domain-separation salts for the deterministic cipher's key derivation.
// Distinct from the Encrypter's salt so the same secret passed to both
// never produces the same key material.
const DET_KEY_SALT = Buffer.from('jsails/attribute-encryption/det/v1', 'utf8');
const DET_KEY_INFO = Buffer.from('aes-256-gcm-det', 'utf8');

// -- key extraction (deterministic path) --------------------------------------

/**
 * Validate and extract a 32-byte AES key for the deterministic cipher path.
 * Mirrors the Encrypter's `extractKeyBytes` but uses a distinct HKDF salt
 * for domain separation.
 */
function extractDetKeyBytes(key: string | Uint8Array): Buffer {
  if (typeof key === 'string') {
    const byteLen = Buffer.byteLength(key, 'utf8');
    if (byteLen < MIN_STRING_KEY_BYTES) {
      throw new EncryptionError(
        'invalid_key',
        'deterministic encryption key must be at least 32 bytes',
      );
    }
    return Buffer.from(
      hkdfSync('sha256', Buffer.from(key, 'utf8'), DET_KEY_SALT, DET_KEY_INFO, KEY_LENGTH),
    );
  }

  if (key instanceof Uint8Array) {
    if (key.byteLength !== KEY_LENGTH) {
      throw new EncryptionError(
        'invalid_key',
        'deterministic encryption key must be exactly 32 bytes',
      );
    }
    return Buffer.from(key.buffer, key.byteOffset, key.byteLength);
  }

  throw new EncryptionError(
    'invalid_key',
    'deterministic encryption key must be a string or Uint8Array',
  );
}

// -- deterministic cipher -----------------------------------------------------

/**
 * Derive a fixed 12-byte IV from the plaintext.  SHA-256(plaintext)[0:12].
 * This is what makes the cipher deterministic: the same plaintext always
 * produces the same IV, and AES-256-GCM with the same (key, IV, plaintext, AAD)
 * always produces the same ciphertext.
 *
 * Security note: reusing a (key, IV) pair for different plaintexts in GCM
 * leaks the XOR of the plaintexts.  This is an accepted risk for deterministic
 * attribute-level encryption — the caller opts in and the field is equality-
 * queryable precisely because ciphertext equality reveals plaintext equality.
 */
function deriveDeterministicIv(plaintext: string): Buffer {
  return createHash('sha256').update(plaintext, 'utf8').digest().subarray(0, IV_LENGTH);
}

function deterministicEncrypt(
  keyBytes: Buffer,
  plaintext: string,
  aad: string | undefined,
): string {
  const iv = deriveDeterministicIv(plaintext);
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

function deterministicDecrypt(keyBytes: Buffer, token: string, aad: string | undefined): string {
  const parts = token.split(ENVELOPE_SEPARATOR);
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new EncryptionError('invalid_token', 'invalid encryption token');
  }

  const iv = decodeEnvelopePart(parts[1]!);
  const tag = decodeEnvelopePart(parts[2]!);
  const ciphertext = decodeEnvelopePart(parts[3]!);

  const decipher = createDecipheriv(AES_ALGORITHM, keyBytes, iv);
  decipher.setAuthTag(tag);

  if (aad !== undefined) {
    decipher.setAAD(Buffer.from(aad, 'utf8'));
  }

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new EncryptionError('decryption_failed', 'decryption failed');
  }
}

function decodeEnvelopePart(part: string): Buffer {
  const buf = Buffer.from(part, 'base64url');
  if (buf.length === 0 && part.length > 0) {
    throw new EncryptionError('invalid_token', 'invalid encryption token');
  }
  return buf;
}

// -- public API ---------------------------------------------------------------

/**
 * Build an entity hook definition that transparently encrypts and decrypts the
 * named fields.
 *
 * `beforeInsert` and `beforeUpdate` encrypt every non-empty-string value in
 * `fields`; `afterLoad` decrypts them.  The hooks are synchronous — all crypto
 * operations use `node:crypto`'s synchronous APIs.
 *
 * @param entity  - The TypeORM entity target (class, `EntitySchema`, or name).
 * @param encrypter - The non-deterministic {@link Encrypter} (AES-256-GCM).
 * @param fields  - Field names to encrypt/decrypt.
 * @param options - Optional encryption mode and AAD.
 * @throws {EncryptionError} (`invalid_options`) when `fields` is empty or
 *         `deterministic: true` is set without `deterministicKey`.
 * @throws {EncryptionError} (`decryption_failed`) on afterLoad when a stored
 *         ciphertext cannot be decrypted — value-free, field value never echoed.
 */
export function encrypts<T extends ObjectLiteral>(
  entity: EntityTarget<T>,
  encrypter: Encrypter,
  fields: readonly string[],
  options?: EncryptsOptions,
): EntityHooksDefinition<T> {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new EncryptionError('invalid_options', 'fields must be a non-empty array');
  }

  const deterministic = options?.deterministic ?? false;
  const aad = options?.aad;

  const detKeyBytes: Buffer | undefined =
    deterministic && options?.deterministicKey !== undefined
      ? extractDetKeyBytes(options.deterministicKey)
      : undefined;

  if (deterministic && detKeyBytes === undefined) {
    throw new EncryptionError(
      'invalid_options',
      'deterministicKey is required when deterministic is true',
    );
  }

  /** Encrypt fields on a data object (beforeInsert / beforeUpdate). */
  const encryptFields = (data: Record<string, unknown>): void => {
    for (const field of fields) {
      const value = data[field];
      if (typeof value !== 'string' || value.length === 0) continue;

      data[field] = deterministic
        ? deterministicEncrypt(detKeyBytes!, value, aad)
        : encrypter.encrypt(value, { aad });
    }
  };

  /** Decrypt fields on a data object (afterLoad). */
  const decryptFields = (data: Record<string, unknown>): void => {
    for (const field of fields) {
      const value = data[field];
      if (typeof value !== 'string' || value.length === 0) continue;

      try {
        data[field] = deterministic
          ? deterministicDecrypt(detKeyBytes!, value, aad)
          : encrypter.decrypt(value, { aad });
      } catch (err) {
        if (err instanceof EncryptionError) throw err;
        throw new EncryptionError('decryption_failed', 'decryption failed');
      }
    }
  };

  return defineEntityHooks<T>(entity, {
    beforeInsert({ data }) {
      encryptFields(data);
    },
    beforeUpdate({ data }) {
      encryptFields(data);
    },
    afterLoad({ data }) {
      decryptFields(data);
    },
  });
}
