/**
 * First-party `encryption` plugin: exposes an {@link Encrypter} service under a
 * typed service token.
 *
 * `encryptionPlugin(options)` builds a {@link JsailsPlugin} named `encryption`
 * whose `setup` calls {@link createEncrypter} with the given options and
 * provides the result under {@link encryptionToken}.
 *
 * Construction is inert — no I/O and no crypto until `encrypt`/`decrypt` is
 * called. Options are validated eagerly during `setup` (an invalid key throws
 * `EncryptionError` at that point rather than on the first call).
 *
 * Cleanup is a no-op, so the runner's `close` stays idempotent.
 */

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import { createEncrypter } from './encrypter.js';
import type { Encrypter, EncrypterOptions } from './types.js';

/**
 * Opaque token for the application {@link Encrypter}. Defined once here and
 * shared by the provider (`encryptionPlugin`) and any consumer (e.g. an
 * extension's `requires`).
 */
export const encryptionToken: ServiceToken<Encrypter> = createServiceToken<Encrypter>('encryption');

/**
 * Build the first-party `encryption` plugin. Construction is inert — no I/O and
 * no crypto until a method is called.
 *
 * Options are passed through to {@link createEncrypter} and validated eagerly
 * during `setup`. An invalid key throws `EncryptionError` at that point rather
 * than silently degrading.
 */
export function encryptionPlugin(options: EncrypterOptions): JsailsPlugin {
  return definePlugin({
    name: 'encryption',
    setup({ services }) {
      services.provide(encryptionToken, createEncrypter(options));
    },
  });
}
