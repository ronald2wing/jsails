/**
 * The framework-level encrypter used by `@jsails.encrypts()` model fields.
 *
 * A model's encryption hook is built by `defineModel`, which runs while the
 * migration/console/test/seed loaders evaluate the app config — **before** any
 * extension `setup` runs. The `encryptionPlugin`'s `encryptionToken` is not
 * resolvable at that point, so the only channel available to every loader is the
 * environment. This module resolves the encrypter from `JSAILS_ENCRYPTION_KEY`
 * (plus optional `JSAILS_ENCRYPTION_PREVIOUS_KEYS`) and memoizes it.
 *
 * When no key is configured the resolver returns a **sentinel** encrypter that
 * throws a value-free {@link EncryptionError} on first use. A model that declares
 * an encrypted field but ships no key fails loudly at the first write or read
 * rather than silently persisting plaintext. Migrations never invoke the hook
 * (DDL does not read or write rows), so a keyless migration run is unaffected.
 *
 * Server-only: reaches `node:crypto` through {@link AesEncrypter}.
 */

import { AesEncrypter } from './encrypter.js';
import { EncryptionError } from './errors.js';

import type { Encrypter } from './encrypter-types.js';

/** The environment variable holding the primary encryption key. */
export const ENCRYPTION_KEY_ENV = 'JSAILS_ENCRYPTION_KEY';

/** The environment variable holding comma-separated previous (decrypt-only) keys. */
export const ENCRYPTION_PREVIOUS_KEYS_ENV = 'JSAILS_ENCRYPTION_PREVIOUS_KEYS';

/**
 * A sentinel {@link Encrypter} that fails on first use. It is returned when no
 * key is configured so a misconfigured deployment fails at the point of use
 * rather than writing plaintext.
 */
const sentinelEncrypter: Encrypter = Object.freeze({
  encrypt(): string {
    throw new EncryptionError(
      'invalid_key',
      `no encryption key configured; set ${ENCRYPTION_KEY_ENV} to use @jsails.encrypts()`,
    );
  },
  decrypt(): string {
    throw new EncryptionError(
      'invalid_key',
      `no encryption key configured; set ${ENCRYPTION_KEY_ENV} to use @jsails.encrypts()`,
    );
  },
});

/** The memoized encrypter, resolved once from the environment. */
let cached: Encrypter | undefined;

/**
 * Resolve the framework-level encrypter from the environment, memoized.
 *
 * Reads `JSAILS_ENCRYPTION_KEY` (required for a real encrypter) and
 * `JSAILS_ENCRYPTION_PREVIOUS_KEYS` (comma-separated, decrypt-only). Returns the
 * sentinel encrypter when no primary key is set. A malformed key throws a
 * value-free {@link EncryptionError} from the {@link Encrypter} constructor.
 */
export function resolveModelEncrypter(source: NodeJS.ProcessEnv = process.env): Encrypter {
  if (cached !== undefined) {
    return cached;
  }

  const key = source[ENCRYPTION_KEY_ENV];
  if (typeof key !== 'string' || key.length === 0) {
    cached = sentinelEncrypter;
    return cached;
  }

  const previous = (source[ENCRYPTION_PREVIOUS_KEYS_ENV] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  cached = new AesEncrypter(previous.length > 0 ? { key, previousKeys: previous } : { key });
  return cached;
}

/** Clear the memoized encrypter. Test-only; production resolves once per process. */
export function resetModelEncrypter(): void {
  cached = undefined;
}
