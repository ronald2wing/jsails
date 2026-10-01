/**
 * Encryption: symmetric AES-256-GCM encryption with key rotation.
 *
 * This barrel exports the core types, the value-free error, the encrypter
 * factory, and the first-party plugin with its service token.
 */

export { EncryptionError, type EncryptionErrorCode } from './errors.js';
export { createEncrypter } from './encrypter.js';
export { encryptionPlugin, encryptionToken } from './plugin.js';
export type { DecryptOptions, Encrypter, EncrypterOptions, EncryptOptions } from './types.js';

// The `encryption` plugin is the subpath's default export, matching every other
// first-party plugin subpath: `plugins.use` resolves a specifier by importing
// the default export and calling it with the options tuple.
export { encryptionPlugin as default } from './plugin.js';
