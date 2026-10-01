/**
 * Encryption: symmetric AES-256-GCM encryption with key rotation.
 *
 * This barrel exports the {@link Encrypter} port, the {@link AesEncrypter}
 * adapter, the value-free error, and the first-party plugin with its service
 * token.
 */

export { EncryptionError, type EncryptionErrorCode } from './errors.js';
export { AesEncrypter } from './encrypter.js';
export {
  ENCRYPTION_KEY_ENV,
  ENCRYPTION_PREVIOUS_KEYS_ENV,
  resetModelEncrypter,
  resolveModelEncrypter,
} from './model-encrypter.js';
export { encryptionPlugin, encryptionToken } from './plugin.js';
export type {
  DecryptOptions,
  Encrypter,
  EncrypterOptions,
  EncryptOptions,
} from './encrypter-types.js';

// The `encryption` plugin is the subpath's default export, matching every other
// first-party plugin subpath: `plugins.use` resolves a specifier by importing
// the default export and calling it with the options tuple.
export { encryptionPlugin as default } from './plugin.js';
