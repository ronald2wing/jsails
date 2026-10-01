import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Cryptography,
  CryptographyError,
  ServerCryptography,
  hmacSync,
  hashSync,
  timingSafeEqual,
} from '../../src/support/cryptography.server.js';

function assertLowercaseHex(value: string) {
  assert.match(value, /^[0-9a-f]+$/, `expected lowercase hex: ${value.slice(0, 40)}...`);
}

describe('server Cryptography', () => {
  it('hashes synchronously (returns a string, not a promise)', () => {
    const result = hashSync('SHA-256', 'abc');
    assert.equal(typeof result, 'string');
    assert.equal(result, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assertLowercaseHex(result);
  });

  it('produces the SHA-1 vector for "abc"', () => {
    assert.equal(hashSync('SHA-1', 'abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('offers MD5 (the browser-only gap)', () => {
    assert.equal(hashSync('MD5', 'abc'), '900150983cd24fb0d6963f7d28e17f72');
  });

  it('supports SHA-512', () => {
    assert.equal(hashSync('SHA-512', 'abc').length, 128);
  });

  it('throws unsupported_algorithm value-free for an unknown algorithm', () => {
    assert.throws(
      () => hashSync('NOPE-999' as unknown as 'SHA-256', 'abc'),
      (error: unknown) => {
        assert.ok(error instanceof CryptographyError);
        assert.equal(error.code, 'unsupported_algorithm');
        assert.equal(error.message.includes('NOPE'), false);
        return true;
      },
    );
  });

  it('computes HMAC-SHA256 (RFC 4231 test case 1)', () => {
    const mac = hmacSync('SHA-256', Buffer.alloc(20, 0x0b), 'Hi There');
    assert.equal(mac, 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  });

  it('throws unsupported_algorithm for an unsupported HMAC algorithm', () => {
    assert.throws(
      () => hmacSync('MD5' as unknown as 'SHA-256', 'k', 'd'),
      (error: unknown) => {
        assert.ok(error instanceof CryptographyError);
        assert.equal(error.code, 'unsupported_algorithm');
        return true;
      },
    );
  });

  it('timingSafeEqual returns true for equal buffers', () => {
    assert.equal(timingSafeEqual(Buffer.from('abc'), Buffer.from('abc')), true);
  });

  it('timingSafeEqual returns false for differing buffers', () => {
    assert.equal(timingSafeEqual(Buffer.from('abc'), Buffer.from('abd')), false);
  });

  it('timingSafeEqual returns false on length mismatch without throwing', () => {
    assert.equal(timingSafeEqual(Buffer.from('abc'), Buffer.from('abcd')), false);
  });

  it('inherits the shared async Cryptography and adds the sync conveniences', () => {
    assert.equal(ServerCryptography.hashSync, hashSync);
    assert.equal(ServerCryptography.hmacSync, hmacSync);
    assert.equal(ServerCryptography.timingSafeEqual, timingSafeEqual);
    // The shared async surface is present too (one coherent Cryptography).
    assert.equal(ServerCryptography.hash, Cryptography.hash);
    assert.ok(Object.isFrozen(ServerCryptography));
    assert.ok(Object.isFrozen(Cryptography));
  });
});
