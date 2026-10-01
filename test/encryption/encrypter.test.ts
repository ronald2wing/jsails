/**
 * Encrypter tests: round-trip, non-determinism, tamper resistance, AAD binding,
 * version rejection, malformed tokens, key rotation, key validation, and the
 * value-free error guarantee.
 *
 * All tests use a fixed test key so the test suite is deterministic and
 * side-effect-free.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EncryptionError } from '../../src/encryption/errors.js';
import { createEncrypter } from '../../src/encryption/encrypter.js';
import type { DecryptOptions, EncryptOptions, Encrypter } from '../../src/encryption/types.js';

// -- helpers ------------------------------------------------------------------

/** A 32-byte key for use as the primary key in most tests. */
const KEY_A = new Uint8Array(32).fill(0x41); // all 'A' bytes

/** Another 32-byte key for rotation and wrong-key tests. */
const KEY_B = new Uint8Array(32).fill(0x42); // all 'B' bytes

function makeEncrypter(key?: Uint8Array): Encrypter {
  return createEncrypter({ key: key ?? KEY_A });
}

// -- round-trip ---------------------------------------------------------------

describe('createEncrypter', () => {
  describe('round-trip', () => {
    it('encrypts and decrypts ASCII text', () => {
      const enc = makeEncrypter();
      const plaintext = 'hello world';
      const token = enc.encrypt(plaintext);
      const decrypted = enc.decrypt(token);
      assert.equal(decrypted, plaintext);
    });

    it('encrypts and decrypts an empty string', () => {
      const enc = makeEncrypter();
      const token = enc.encrypt('');
      const decrypted = enc.decrypt(token);
      assert.equal(decrypted, '');
    });

    it('encrypts and decrypts unicode text (emoji, CJK, combining marks)', () => {
      const enc = makeEncrypter();
      const plaintext = 'Hello 世界 🌍✨ Café résumé 🏳️‍🌈';
      const token = enc.encrypt(plaintext);
      const decrypted = enc.decrypt(token);
      assert.equal(decrypted, plaintext);
    });

    it('encrypts and decrypts a large payload without truncation', () => {
      const enc = makeEncrypter();
      // ~1 MiB of repeating ASCII.
      const plaintext = 'x'.repeat(1_048_576);
      const token = enc.encrypt(plaintext);
      const decrypted = enc.decrypt(token);
      assert.equal(decrypted.length, plaintext.length);
      assert.equal(decrypted, plaintext);
    });
  });

  // -- envelope shape ---------------------------------------------------------

  describe('envelope format', () => {
    it('matches the expected v1.<iv>.<tag>.<ciphertext> shape', () => {
      const enc = makeEncrypter();
      const token = enc.encrypt('test');
      const pattern = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
      assert.match(token, pattern);
    });
  });

  // -- non-determinism --------------------------------------------------------

  describe('non-determinism', () => {
    it('produces different tokens for the same plaintext', () => {
      const enc = makeEncrypter();
      const token1 = enc.encrypt('test');
      const token2 = enc.encrypt('test');
      assert.notEqual(token1, token2);
    });
  });

  // -- tamper resistance ------------------------------------------------------

  describe('tamper resistance', () => {
    it('rejects a token with a flipped ciphertext byte', () => {
      const enc = makeEncrypter();
      const token = enc.encrypt('secret message');

      // Find the last dot (ciphertext starts after it) and flip a byte there.
      const lastDot = token.lastIndexOf('.');
      const tampered =
        token.substring(0, lastDot + 1) +
        String.fromCharCode(token.charCodeAt(lastDot + 1) ^ 1) +
        token.substring(lastDot + 2);

      assert.throws(
        () => enc.decrypt(tampered),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'decryption_failed');
          return true;
        },
      );
    });

    it('rejects a token with a flipped auth tag byte', () => {
      const enc = makeEncrypter();
      const token = enc.encrypt('secret message');

      // Parts: v1.IV.TAG.CIPHERTEXT. Flip a byte in the tag part (index 2).
      const parts = token.split('.');
      // The tag is a base64url string — flip the first character's codepoint.
      const tagChars = parts[2]!.split('');
      const orig = tagChars[0]!;
      // Cycle to a different valid base64url character.
      tagChars[0] = orig === 'A' ? 'B' : 'A';
      parts[2] = tagChars.join('');
      const tampered = parts.join('.');

      assert.throws(
        () => enc.decrypt(tampered),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'decryption_failed');
          return true;
        },
      );
    });
  });

  // -- wrong key --------------------------------------------------------------

  describe('wrong key', () => {
    it('rejects a token encrypted with a different key', () => {
      const encA = createEncrypter({ key: KEY_A });
      const encB = createEncrypter({ key: KEY_B });

      const token = encA.encrypt('secret');
      assert.throws(
        () => encB.decrypt(token),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'decryption_failed');
          return true;
        },
      );
    });
  });

  // -- AAD binding ------------------------------------------------------------

  describe('AAD binding', () => {
    it('round-trips when AAD matches', () => {
      const enc = makeEncrypter();
      const aad = 'session-id:abc123';
      const token = enc.encrypt('secret', { aad });
      const decrypted = enc.decrypt(token, { aad });
      assert.equal(decrypted, 'secret');
    });

    it('rejects when AAD is different', () => {
      const enc = makeEncrypter();
      const token = enc.encrypt('secret', { aad: 'original-aad' });
      assert.throws(
        () => enc.decrypt(token, { aad: 'different-aad' }),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'decryption_failed');
          return true;
        },
      );
    });

    it('rejects when AAD is absent on decrypt but was set on encrypt', () => {
      const enc = makeEncrypter();
      const token = enc.encrypt('secret', { aad: 'bound-aad' });
      assert.throws(
        () => enc.decrypt(token),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'decryption_failed');
          return true;
        },
      );
    });
  });

  // -- unsupported version ----------------------------------------------------

  describe('version handling', () => {
    it('rejects a v2 envelope as unsupported_version', () => {
      const enc = makeEncrypter();
      const token = enc.encrypt('test');
      // Replace v1 with v2.
      const tampered = 'v2' + token.substring(2);

      assert.throws(
        () => enc.decrypt(tampered),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'unsupported_version');
          return true;
        },
      );
    });
  });

  // -- malformed tokens -------------------------------------------------------

  describe('malformed tokens', () => {
    it('rejects a token with the wrong part count', () => {
      const enc = makeEncrypter();
      assert.throws(
        () => enc.decrypt('v1.abc'),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'invalid_token');
          return true;
        },
      );
      assert.throws(
        () => enc.decrypt('v1.abc.def.ghi.extra'),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'invalid_token');
          return true;
        },
      );
    });

    it('rejects a token with non-base64url parts', () => {
      const enc = makeEncrypter();
      assert.throws(
        () => enc.decrypt('v1.!!!.!!!.!!!'),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'invalid_token');
          return true;
        },
      );
    });

    it('rejects an empty token string', () => {
      const enc = makeEncrypter();
      assert.throws(
        () => enc.decrypt(''),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'invalid_token');
          return true;
        },
      );
    });
  });

  // -- key rotation -----------------------------------------------------------

  describe('key rotation', () => {
    it('decrypts with a previous key when the primary key has rotated', () => {
      // Encrypt with KEY_A.
      const oldEnc = createEncrypter({ key: KEY_A });
      const token = oldEnc.encrypt('rotate-me');

      // A new encrypter with KEY_B as primary and KEY_A as a previous key.
      const newEnc = createEncrypter({ key: KEY_B, previousKeys: [KEY_A] });
      const decrypted = newEnc.decrypt(token);
      assert.equal(decrypted, 'rotate-me');
    });

    it('fails when the previous key is omitted', () => {
      const oldEnc = createEncrypter({ key: KEY_A });
      const token = oldEnc.encrypt('rotate-me');

      // Only KEY_B, no previous keys.
      const newEnc = createEncrypter({ key: KEY_B });
      assert.throws(
        () => newEnc.decrypt(token),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'decryption_failed');
          return true;
        },
      );
    });
  });

  // -- key validation ---------------------------------------------------------

  describe('key validation', () => {
    it('rejects a short string key', () => {
      assert.throws(
        () => createEncrypter({ key: 'short' }),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'invalid_key');
          return true;
        },
      );
    });

    it('rejects a Uint8Array of 16 bytes', () => {
      assert.throws(
        () => createEncrypter({ key: new Uint8Array(16) }),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'invalid_key');
          return true;
        },
      );
    });

    it('rejects a Uint8Array of 31 bytes', () => {
      assert.throws(
        () => createEncrypter({ key: new Uint8Array(31) }),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'invalid_key');
          return true;
        },
      );
    });

    it('rejects a Uint8Array of 33 bytes', () => {
      assert.throws(
        () => createEncrypter({ key: new Uint8Array(33) }),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'invalid_key');
          return true;
        },
      );
    });

    it('accepts a 32-byte Uint8Array', () => {
      const enc = createEncrypter({ key: new Uint8Array(32) });
      const token = enc.encrypt('valid');
      assert.equal(enc.decrypt(token), 'valid');
    });

    it('accepts a string key of exactly 32 bytes', () => {
      const key = 'a'.repeat(32);
      const enc = createEncrypter({ key });
      const token = enc.encrypt('valid');
      assert.equal(enc.decrypt(token), 'valid');
    });

    it('derives distinct keys from strings sharing a 32-byte prefix', () => {
      // Truncating a string key to its first 32 bytes would make these two
      // secrets interchangeable; HKDF derivation must keep them distinct.
      const prefix = 'p'.repeat(32);
      const encA = createEncrypter({ key: `${prefix}A` });
      const encB = createEncrypter({ key: `${prefix}B` });
      const token = encA.encrypt('secret');
      assert.throws(
        () => encB.decrypt(token),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'decryption_failed');
          return true;
        },
      );
    });

    it('rejects invalid previousKeys entries eagerly', () => {
      assert.throws(
        () => createEncrypter({ key: KEY_A, previousKeys: [new Uint8Array(16)] }),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'invalid_key');
          return true;
        },
      );
    });

    it('rejects non-plain-object encrypt options', () => {
      const enc = makeEncrypter();
      assert.throws(
        () => enc.encrypt('test', [] as unknown as EncryptOptions),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'invalid_options');
          return true;
        },
      );
    });

    it('rejects non-plain-object decrypt options', () => {
      const enc = makeEncrypter();
      const token = enc.encrypt('test');
      assert.throws(
        () => enc.decrypt(token, [] as unknown as DecryptOptions),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'invalid_options');
          return true;
        },
      );
    });

    it('rejects null encrypt options', () => {
      const enc = makeEncrypter();
      assert.throws(
        () => enc.encrypt('test', null as unknown as EncryptOptions),
        (err: unknown) => {
          assert.ok(err instanceof EncryptionError);
          assert.equal(err.code, 'invalid_options');
          return true;
        },
      );
    });
  });

  // -- value-free errors ------------------------------------------------------

  describe('value-free errors', () => {
    const key = new Uint8Array(32).fill(0xab);

    it('invalid_key error message does not contain the key bytes', () => {
      try {
        createEncrypter({ key: new Uint8Array(16) });
        assert.fail('expected EncryptionError');
      } catch (err) {
        assert.ok(err instanceof EncryptionError);
        const msg = err.message;
        assert.ok(!msg.includes('0000'), 'message must not contain hex key material');
      }
    });

    it('decryption_failed error message does not contain the token or plaintext', () => {
      const enc = createEncrypter({ key });
      const token = enc.encrypt('sensitive data');

      // Decrypt with a wrong key to trigger decryption_failed.
      const wrongEnc = createEncrypter({ key: KEY_B });
      try {
        wrongEnc.decrypt(token);
        assert.fail('expected EncryptionError');
      } catch (err) {
        assert.ok(err instanceof EncryptionError);
        const msg = err.message;
        // The plaintext 'sensitive data' must not appear.
        assert.ok(!msg.includes('sensitive'), 'message must not contain plaintext');
        // A well-formed token must not appear in the error message.
        assert.ok(!msg.includes('v1.'), 'message must not contain the token version prefix');
      }
    });

    it('invalid_token error message does not contain the token value', () => {
      const enc = createEncrypter({ key });
      try {
        enc.decrypt('');
        assert.fail('expected EncryptionError');
      } catch (err) {
        assert.ok(err instanceof EncryptionError);
        const msg = err.message;
        // Never echoes the input — the input was empty, so any message is fine
        // as long as it is fixed text.
        assert.ok(msg.length > 0, 'error message must be present');
      }

      try {
        enc.decrypt('v1.abc');
        assert.fail('expected EncryptionError');
      } catch (err) {
        assert.ok(err instanceof EncryptionError);
        const msg = err.message;
        assert.ok(!msg.includes('abc'), 'message must not contain the token text');
      }
    });

    it('unsupported_version error message does not contain the token version', () => {
      const enc = createEncrypter({ key });
      // Build a well-formed envelope with a bad version marker that does not
      // contain the real token content.
      try {
        enc.decrypt('v9.AAAAAAAAAAAAAA.AAAAAAAAAAAAAA.AAAAAAAAAAAAAA');
        assert.fail('expected EncryptionError');
      } catch (err) {
        assert.ok(err instanceof EncryptionError);
        assert.equal(err.code, 'unsupported_version');
        const msg = err.message;
        assert.ok(!msg.includes('v9'), 'message must not contain the version value');
      }
    });
  });
});
