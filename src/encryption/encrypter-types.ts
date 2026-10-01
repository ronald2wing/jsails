/**
 * Encryption contracts: the {@link Encrypter} port and the option bags for its
 * methods and construction.
 *
 * Pure interface definitions only — no I/O, no construction, no crypto.
 */

/**
 * The encryption port: encrypt a string and decrypt the envelope it produced.
 *
 * This is a **structural** contract, not the concrete AES adapter. Any plain
 * object with matching `encrypt`/`decrypt` methods is a valid `Encrypter`, which
 * is what keeps the framework's substitution seam open: `@jsails.encrypts()`
 * accepts a caller-supplied encrypter, and the model resolver's sentinel is a
 * bare object literal.
 */
export interface Encrypter {
  /** Encrypt `plaintext` and return a versioned envelope string. */
  encrypt(plaintext: string, opts?: EncryptOptions): string;

  /** Decrypt a versioned envelope produced by `encrypt`. */
  decrypt(token: string, opts?: DecryptOptions): string;
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

/** Constructor options for {@link AesEncrypter}. */
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
