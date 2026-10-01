/**
 * Encryption types: the {@link Encrypter} contract, its options, and the
 * factory options for {@link createEncrypter}.
 *
 * Pure interface definitions only — no I/O, no construction, no crypto.
 */

/** Symmetric encrypt/decrypt using AES-256-GCM. */
export interface Encrypter {
  /** Encrypt `plaintext` and return a versioned envelope string. */
  encrypt(plaintext: string, options?: EncryptOptions): string;

  /**
   * Decrypt a versioned envelope. Tries the primary key first, then each entry
   * in `previousKeys` in order; returns the plaintext from the first key that
   * authenticates.
   */
  decrypt(token: string, options?: DecryptOptions): string;
}

/** Options passed to {@link Encrypter.encrypt}. */
export interface EncryptOptions {
  /** Optional additional authenticated data (AAD) bound to the ciphertext. */
  readonly aad?: string;
}

/** Options passed to {@link Encrypter.decrypt}. */
export interface DecryptOptions {
  /** AAD that must match what was supplied to `encrypt`. */
  readonly aad?: string;
}

/** Factory options for {@link createEncrypter}. */
export interface EncrypterOptions {
  /**
   * Primary encryption key. A string is measured with `Buffer.byteLength(key,
   * 'utf8')` and must be at least 32 bytes; a `Uint8Array` must be exactly 32
   * bytes.
   */
  readonly key: string | Uint8Array;

  /**
   * Previous keys used only for decrypting older tokens. Each entry is
   * validated identically to `key`. When decrypting, the primary key is tried
   * first, then each entry in order.
   */
  readonly previousKeys?: readonly (string | Uint8Array)[];
}
