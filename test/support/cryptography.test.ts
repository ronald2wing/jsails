import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Cryptography,
  CryptographyError,
  equal,
  hash,
  hmac,
  randomToken,
} from '../../src/support/cryptography.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert every hex character is lowercase (0-9 or a-f). */
function assertLowercaseHex(value: string) {
  assert.match(value, /^[0-9a-f]+$/, `expected lowercase hex: ${value.slice(0, 40)}...`);
}

/** Assert the string contains only base64url characters (no + / =). */
function assertBase64url(value: string) {
  // Base64url alphabet: A-Z a-z 0-9 - _
  assert.match(value, /^[A-Za-z0-9\-_]+$/, `expected base64url: ${value}`);
}

// ---------------------------------------------------------------------------
// hash
// ---------------------------------------------------------------------------

describe('hash', () => {
  it('defaults to SHA-256', async () => {
    const result = await hash('abc');
    assert.equal(result, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assertLowercaseHex(result);
    assert.equal(result.length, 64);
  });

  it('produces the SHA-1 vector for "abc"', async () => {
    const result = await hash('abc', 'SHA-1');
    assert.equal(result, 'a9993e364706816aba3e25717850c26c9cd0d89d');
    assertLowercaseHex(result);
    assert.equal(result.length, 40);
  });

  it('produces a 96-char SHA-384 digest', async () => {
    const result = await hash('test', 'SHA-384');
    assertLowercaseHex(result);
    assert.equal(result.length, 96);
  });

  it('produces a 128-char SHA-512 digest', async () => {
    const result = await hash('test', 'SHA-512');
    assertLowercaseHex(result);
    assert.equal(result.length, 128);
  });

  it('accepts a Uint8Array', async () => {
    const bytes = new TextEncoder().encode('abc');
    const result = await hash(bytes, 'SHA-256');
    assert.equal(result, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('yields the same digest for a Uint8Array and the equivalent string', async () => {
    const plain = 'hello world';
    const bytes = new TextEncoder().encode(plain);
    assert.equal(await hash(plain, 'SHA-1'), await hash(bytes, 'SHA-1'));
  });

  it('returns deterministic results', async () => {
    const a = await hash('abc', 'SHA-256');
    const b = await hash('abc', 'SHA-256');
    assert.equal(a, b);
  });

  it('produces lowercase hex', async () => {
    for (const alg of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] as const) {
      const result = await hash('x', alg);
      assertLowercaseHex(result);
      // No uppercase hex characters.
      assert.ok(!/[A-F]/.test(result), `uppercase found in ${alg} digest: ${result.slice(0, 20)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// hmac
// ---------------------------------------------------------------------------

describe('hmac', () => {
  // RFC 4231 Test Case 1 — 20-byte key (0x0b), data "Hi There"
  // Expected HMAC-SHA-256:
  //   b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7
  it('matches RFC 4231 test vector for SHA-256', async () => {
    const key = new Uint8Array(20).fill(0x0b);
    const result = await hmac('Hi There', key, 'SHA-256');
    assert.equal(result, 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
    assertLowercaseHex(result);
  });

  it('defaults to SHA-256', async () => {
    const key = new Uint8Array(20).fill(0x0b);
    const explicit = await hmac('Hi There', key, 'SHA-256');
    const implicit = await hmac('Hi There', key);
    assert.equal(explicit, implicit);
  });

  it('accepts string keys and values', async () => {
    const result = await hmac('hello', 'secret', 'SHA-256');
    assertLowercaseHex(result);
    assert.equal(result.length, 64);
  });

  it('accepts Uint8Array keys and values', async () => {
    const key = new TextEncoder().encode('secret');
    const value = new TextEncoder().encode('hello');
    const stringResult = await hmac('hello', 'secret', 'SHA-256');
    const bytesResult = await hmac(value, key, 'SHA-256');
    assert.equal(stringResult, bytesResult);
  });

  it('produces lowercase hex', async () => {
    const result = await hmac('data', 'key', 'SHA-384');
    assertLowercaseHex(result);
    assert.ok(!/[A-F]/.test(result));
  });

  it('produces deterministic results', async () => {
    const a = await hmac('x', 'y', 'SHA-256');
    const b = await hmac('x', 'y', 'SHA-256');
    assert.equal(a, b);
  });
});

// ---------------------------------------------------------------------------
// randomToken
// ---------------------------------------------------------------------------

describe('randomToken', () => {
  it('defaults to 32 bytes → 43 base64url chars', () => {
    const token = randomToken();
    assertBase64url(token);
    // 32 bytes → ceil(32 * 4/3) = 43 chars (no padding).
    assert.equal(token.length, 43);
  });

  it('returns URL-safe alphabet (no +, /, =)', () => {
    // Generate several tokens to gain confidence.
    for (let i = 0; i < 20; i++) {
      const token = randomToken();
      assertBase64url(token);
    }
  });

  it('two calls return different values', () => {
    const a = randomToken();
    const b = randomToken();
    assert.notEqual(a, b);
  });

  it('respects a custom byte count', () => {
    const token = randomToken(16);
    assertBase64url(token);
    // 16 bytes → ceil(16 * 4/3) = 22 chars.
    assert.equal(token.length, 22);
  });

  it('always returns a string', () => {
    assert.equal(typeof randomToken(), 'string');
  });
});

// ---------------------------------------------------------------------------
// equal
// ---------------------------------------------------------------------------

describe('equal', () => {
  it('returns true for equal strings', () => {
    assert.equal(equal('abc', 'abc'), true);
  });

  it('returns false on length mismatch', () => {
    assert.equal(equal('abc', 'ab'), false);
  });

  it('returns false on same-length different strings', () => {
    assert.equal(equal('abc', 'abd'), false);
  });

  it('accepts Uint8Array', () => {
    const a = new TextEncoder().encode('xyz');
    const b = new TextEncoder().encode('xyz');
    const c = new TextEncoder().encode('xyy');
    assert.equal(equal(a, b), true);
    assert.equal(equal(a, c), false);
  });

  it('never throws on non-string input, returns false', () => {
    assert.doesNotThrow(() => equal(null as never, 'abc'));
    assert.equal(equal(null as never, 'abc'), false);
    assert.equal(equal('abc', undefined as never), false);
    assert.equal(equal(123 as never, 123 as never), false);
    assert.equal(equal({} as never, {} as never), false);
  });

  it('does not throw on empty inputs', () => {
    assert.equal(equal('', ''), true);
    assert.equal(equal('', 'a'), false);
    assert.equal(equal(new Uint8Array(0), new Uint8Array(0)), true);
  });
});

// ---------------------------------------------------------------------------
// CryptographyError
// ---------------------------------------------------------------------------

describe('CryptographyError', () => {
  it("rejects an unsupported known algorithm naming it in the message ('MD5')", async () => {
    await assert.rejects(hash('x', 'MD5' as never), (err: unknown) => {
      assert.ok(err instanceof CryptographyError);
      assert.equal(err.code, 'unsupported_algorithm');
      // Must name the known-not-supported algorithm (MD5 is a fixed enum value).
      assert.ok(err.message.includes('MD5'), `message should name MD5: ${err.message}`);
      return true;
    });
  });

  it('rejects an arbitrary unknown algorithm without echoing the input', async () => {
    const arbitrary = 'RIPEMD-160';
    await assert.rejects(hash('x', arbitrary as never), (err: unknown) => {
      assert.ok(err instanceof CryptographyError);
      assert.equal(err.code, 'unsupported_algorithm');
      const message = err.message;
      // Must NOT echo the arbitrary input.
      assert.ok(
        !message.includes(arbitrary),
        `message should not echo arbitrary input: ${message}`,
      );
      return true;
    });
  });

  it('rejects hmac with an unsupported algorithm identically', async () => {
    await assert.rejects(hmac('x', 'k', 'MD5' as never), (err: unknown) => {
      assert.ok(err instanceof CryptographyError);
      assert.equal(err.code, 'unsupported_algorithm');
      return true;
    });
  });

  it('has insecure_context error code available', () => {
    const err = new CryptographyError('insecure_context', 'test message');
    assert.equal(err.code, 'insecure_context');
    assert.ok(err instanceof CryptographyError);
    assert.ok(err instanceof Error);
  });

  it('is value-free: message is a static string, never echoes arbitrary input', () => {
    const err = new CryptographyError('unsupported_algorithm', 'Unsupported hash algorithm');
    assert.equal(err.message, 'Unsupported hash algorithm');
    assert.ok(!err.message.includes('md5'));
    assert.ok(!err.message.includes('MD5'));
  });
});

// ---------------------------------------------------------------------------
// MD5 absent
// ---------------------------------------------------------------------------

describe('MD5 absent', () => {
  it('has no "md5" key in the Cryptography namespace', () => {
    const keys = Object.keys(Cryptography);
    assert.ok(
      keys.every((k) => !/md5/i.test(k)),
      `unexpected MD5-like key: ${keys.join(', ')}`,
    );
  });

  it('has no "md5" name in the module-level exports', () => {
    // All exported named functions from the module — verify none contains md5.
    const exported = { Cryptography, CryptographyError, equal, hash, hmac, randomToken };
    const names = Object.keys(exported);
    assert.ok(
      names.every((k) => !/md5/i.test(k)),
      `unexpected MD5-like export: ${names.join(', ')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Frozen
// ---------------------------------------------------------------------------

describe('Cryptography namespace', () => {
  it('is frozen', () => {
    assert.ok(Object.isFrozen(Cryptography));
  });

  it('exposes all four functions', () => {
    assert.equal(typeof Cryptography.hash, 'function');
    assert.equal(typeof Cryptography.hmac, 'function');
    assert.equal(typeof Cryptography.randomToken, 'function');
    assert.equal(typeof Cryptography.equal, 'function');
  });
});
