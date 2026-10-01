import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { EncryptionError } from '../../src/encryption/errors.js';
import {
  ENCRYPTION_KEY_ENV,
  ENCRYPTION_PREVIOUS_KEYS_ENV,
  resetModelEncrypter,
  resolveModelEncrypter,
} from '../../src/encryption/model-encrypter.js';

const KEY = 'a'.repeat(32);
const PREVIOUS_KEY = 'b'.repeat(32);

afterEach(() => {
  resetModelEncrypter();
});

describe('resolveModelEncrypter', () => {
  it('returns a sentinel that throws when no key is configured', () => {
    const encrypter = resolveModelEncrypter({});
    assert.throws(() => encrypter.encrypt('secret'), EncryptionError);
    assert.throws(() => encrypter.decrypt('v1.x.y.z'), EncryptionError);
  });

  it('round-trips through a configured key', () => {
    const encrypter = resolveModelEncrypter({ [ENCRYPTION_KEY_ENV]: KEY });
    const token = encrypter.encrypt('secret');
    assert.notEqual(token, 'secret');
    assert.equal(encrypter.decrypt(token), 'secret');
  });

  it('decrypts tokens from a previous key after rotation', () => {
    const old = resolveModelEncrypter({ [ENCRYPTION_KEY_ENV]: PREVIOUS_KEY });
    const token = old.encrypt('legacy');

    resetModelEncrypter();

    const rotated = resolveModelEncrypter({
      [ENCRYPTION_KEY_ENV]: KEY,
      [ENCRYPTION_PREVIOUS_KEYS_ENV]: PREVIOUS_KEY,
    });
    assert.equal(rotated.decrypt(token), 'legacy');
  });

  it('memoizes the resolved encrypter', () => {
    const first = resolveModelEncrypter({ [ENCRYPTION_KEY_ENV]: KEY });
    const second = resolveModelEncrypter({ [ENCRYPTION_KEY_ENV]: PREVIOUS_KEY });
    assert.equal(first, second);
  });

  it('throws a value-free error for a malformed key', () => {
    assert.throws(
      () => resolveModelEncrypter({ [ENCRYPTION_KEY_ENV]: 'too-short' }),
      (error: unknown) => error instanceof EncryptionError && !error.message.includes('too-short'),
    );
  });
});
