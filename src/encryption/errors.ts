/**
 * Encryption errors: a value-free error class for the encryption service.
 *
 * Every error message is constructed from the fixed `code` and a developer-facing
 * description — never from a caller-supplied value — so errors are safe to
 * introspect in any environment. Key material, plaintext, ciphertext, tokens,
 * and AAD values are never embedded in error messages.
 */

/** Discriminated codes for errors raised by the encryption service. */
export type EncryptionErrorCode =
  'invalid_key' | 'invalid_options' | 'invalid_token' | 'decryption_failed' | 'unsupported_version';

/**
 * A value-free error raised by the encryption service. The message explains the
 * condition that failed but never echoes a caller-supplied value (e.g. the key
 * material or token string).
 */
export class EncryptionError extends Error {
  readonly code: EncryptionErrorCode;

  constructor(code: EncryptionErrorCode, message: string) {
    super(message);
    this.name = 'EncryptionError';
    this.code = code;
  }
}
