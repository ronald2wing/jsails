import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Encoding,
  EncodingError,
  base64,
  base64Decode,
  base64url,
  base64urlDecode,
  hex,
  hexDecode,
  toDataUrl,
  parseDataUrl,
  nanoid,
  uuid,
  randomBytes,
} from '../../src/support/encoding.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function assertValueFreeDecodeError(fn: () => unknown, offendingValue: string) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof EncodingError);
    assert.equal(err.code, 'decode_failed');
    // Never echo the raw input in the error message (the value, not the framing).
    const message = err.message;
    const containsValue = offendingValue.length > 0 && message.includes(offendingValue);
    assert.ok(!containsValue, `message should not echo offending value: ${message}`);
    return true;
  });
}

function assertEncodingOutputHasNoSpecialChars(output: string) {
  assert.ok(!output.includes('+'), 'should not contain +');
  assert.ok(!output.includes('/'), 'should not contain /');
  assert.ok(!output.includes('='), 'should not contain =');
}

// ---------------------------------------------------------------------------
// base64 / base64Decode
// ---------------------------------------------------------------------------

describe('base64 / base64Decode', () => {
  it('round-trips ASCII text', () => {
    const input = 'hello world';
    const encoded = base64(input);
    const decoded = decodeUtf8(base64Decode(encoded));
    assert.equal(decoded, input);
  });

  it('round-trips UTF-8 text with accents', () => {
    const input = 'café résumé';
    const encoded = base64(input);
    const decoded = decodeUtf8(base64Decode(encoded));
    assert.equal(decoded, input);
  });

  it('round-trips UTF-8 text with emoji', () => {
    const input = 'hello 😀 world 🚀';
    const encoded = base64(input);
    const decoded = decodeUtf8(base64Decode(encoded));
    assert.equal(decoded, input);
  });

  it('round-trips raw bytes (including bytes > 127)', () => {
    const input = new Uint8Array([0, 255, 128, 64, 200, 1, 254]);
    const encoded = base64(input);
    const decoded = base64Decode(encoded);
    assert.deepEqual([...decoded], [...input]);
  });

  it('round-trips empty string', () => {
    const encoded = base64('');
    const decoded = decodeUtf8(base64Decode(encoded));
    assert.equal(decoded, '');
  });

  it('round-trips empty Uint8Array', () => {
    const encoded = base64(new Uint8Array(0));
    const decoded = base64Decode(encoded);
    assert.equal(decoded.length, 0);
  });

  it('malformed base64 throws decode_failed without echoing input', () => {
    assertValueFreeDecodeError(() => base64Decode('!!!not-valid!!!'), '!!!not-valid!!!');
  });

  it('EncodingError code is decode_failed for bad decode', () => {
    assert.throws(
      () => base64Decode('!!!'),
      (err: unknown) => err instanceof EncodingError && err.code === 'decode_failed',
    );
  });

  it('base64 throws for wrong input type', () => {
    assert.throws(() => base64(42 as unknown as string), EncodingError);
    assert.throws(() => base64(null as unknown as string), EncodingError);
  });

  it('base64Decode throws for wrong input type', () => {
    assert.throws(() => base64Decode(42 as unknown as string), EncodingError);
  });
});

// ---------------------------------------------------------------------------
// base64url / base64urlDecode
// ---------------------------------------------------------------------------

describe('base64url / base64urlDecode', () => {
  it('round-trips text', () => {
    const input = 'hello world';
    const encoded = base64url(input);
    assertEncodingOutputHasNoSpecialChars(encoded);
    const decoded = decodeUtf8(base64urlDecode(encoded));
    assert.equal(decoded, input);
  });

  it('round-trips UTF-8 text with emoji', () => {
    const input = '🚀 rocket';
    const encoded = base64url(input);
    assertEncodingOutputHasNoSpecialChars(encoded);
    const decoded = decodeUtf8(base64urlDecode(encoded));
    assert.equal(decoded, input);
  });

  it('round-trips raw bytes', () => {
    const input = new Uint8Array([0, 255, 128, 64, 200, 1, 254]);
    const encoded = base64url(input);
    assertEncodingOutputHasNoSpecialChars(encoded);
    const decoded = base64urlDecode(encoded);
    assert.deepEqual([...decoded], [...input]);
  });

  it('output has no + / or =', () => {
    // Generate many random inputs to ensure output never contains + / =
    for (let i = 0; i < 50; i++) {
      const bytes = randomBytes(32);
      const output = base64url(bytes);
      assertEncodingOutputHasNoSpecialChars(output);
    }
  });

  it('handles input with no padding needed', () => {
    // String whose base64 encoding length is an exact multiple of 4.
    const encoded = base64url('abc'); // 3 bytes -> 4 base64 chars -> no padding
    assert.equal(encoded, base64('abc').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
    assert.equal(decodeUtf8(base64urlDecode(encoded)), 'abc');
  });

  it('handles input needing all padding restored', () => {
    const encoded = base64url('a'); // 1 byte -> 2 base64 chars, needs == padding
    assert.equal(encoded.length, 2);
    const decoded = decodeUtf8(base64urlDecode(encoded));
    assert.equal(decoded, 'a');
  });

  it('malformed base64url throws decode_failed', () => {
    assert.throws(() => base64urlDecode('~~~'), EncodingError);
  });

  it('empty input round-trips', () => {
    const encoded = base64url('');
    assert.equal(encoded, '');
    const decoded = base64urlDecode('');
    assert.equal(decoded.length, 0);
  });
});

// ---------------------------------------------------------------------------
// hex / hexDecode
// ---------------------------------------------------------------------------

describe('hex / hexDecode', () => {
  it('round-trips text via hex', () => {
    const input = 'hello';
    const encoded = hex(input);
    const decoded = decodeUtf8(hexDecode(encoded));
    assert.equal(decoded, input);
  });

  it('round-trips raw bytes', () => {
    const input = new Uint8Array([0, 255, 128, 64, 200, 1, 254, 0xab, 0xcd, 0xef]);
    const encoded = hex(input);
    const decoded = hexDecode(encoded);
    assert.deepEqual([...decoded], [...input]);
  });

  it('output is lowercase hex', () => {
    const encoded = hex(new Uint8Array([0xab, 0xcd, 0xef]));
    assert.equal(encoded, 'abcdef');
  });

  it('hexDecode accepts uppercase input', () => {
    const encoded = 'ABCDEF';
    const decoded = hexDecode(encoded);
    assert.deepEqual([...decoded], [0xab, 0xcd, 0xef]);
  });

  it('hexDecode accepts mixed-case input', () => {
    const encoded = 'AbCdEf';
    const decoded = hexDecode(encoded);
    assert.deepEqual([...decoded], [0xab, 0xcd, 0xef]);
  });

  it('hex with emoji text round-trips', () => {
    const input = '🚀';
    const encoded = hex(input);
    const decoded = decodeUtf8(hexDecode(encoded));
    assert.equal(decoded, input);
  });

  it('malformed hex (odd length) throws decode_failed without echoing input', () => {
    assertValueFreeDecodeError(() => hexDecode('abc'), 'abc');
  });

  it('malformed hex (invalid chars) throws decode_failed without echoing input', () => {
    assertValueFreeDecodeError(() => hexDecode('gggg'), 'gggg');
  });

  it('EncodingError code is decode_failed for bad hex decode', () => {
    assert.throws(
      () => hexDecode('xyz'),
      (err: unknown) => err instanceof EncodingError && err.code === 'decode_failed',
    );
  });
});

// ---------------------------------------------------------------------------
// toDataUrl / parseDataUrl
// ---------------------------------------------------------------------------

describe('toDataUrl / parseDataUrl', () => {
  it('round-trips a data URL', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const url = toDataUrl('image/png', bytes);
    assert.ok(url.startsWith('data:image/png;base64,'));
    const parsed = parseDataUrl(url);
    assert.ok(parsed !== null);
    assert.equal(parsed.mime, 'image/png');
    assert.deepEqual([...parsed.bytes], [1, 2, 3, 4, 5]);
  });

  it('handles text/plain mime type', () => {
    const bytes = new TextEncoder().encode('hello');
    const url = toDataUrl('text/plain', bytes);
    assert.ok(url.startsWith('data:text/plain;base64,'));
    const parsed = parseDataUrl(url);
    assert.ok(parsed !== null);
    assert.equal(parsed.mime, 'text/plain');
    assert.equal(new TextDecoder().decode(parsed.bytes), 'hello');
  });

  it('parseDataUrl returns null for non-data-url string', () => {
    assert.equal(parseDataUrl('not-a-data-url'), null);
    assert.equal(parseDataUrl(''), null);
    assert.equal(parseDataUrl('http://example.com'), null);
  });

  it('parseDataUrl returns null for non-string input', () => {
    assert.equal(parseDataUrl(42 as unknown as string), null);
    assert.equal(parseDataUrl(null as unknown as string), null);
    assert.equal(parseDataUrl(undefined as unknown as string), null);
  });

  it('parseDataUrl returns null for data URL without base64', () => {
    assert.equal(parseDataUrl('data:text/plain,hello'), null);
  });

  it('parseDataUrl returns null for malformed base64 payload', () => {
    assert.equal(parseDataUrl('data:text/plain;base64,!!!not-valid!!!'), null);
  });
});

// ---------------------------------------------------------------------------
// nanoid
// ---------------------------------------------------------------------------

describe('nanoid', () => {
  it('returns a string of default size 21', () => {
    const id = nanoid();
    assert.equal(typeof id, 'string');
    assert.equal(id.length, 21);
  });

  it('returns a string of custom size', () => {
    assert.equal(nanoid(10).length, 10);
    assert.equal(nanoid(32).length, 32);
  });

  it('output contains only URL-safe characters', () => {
    for (let i = 0; i < 100; i++) {
      const id = nanoid();
      assert.ok(/^[A-Za-z0-9_-]+$/.test(id), `unexpected chars in nanoid: ${id}`);
      assert.ok(!id.includes('+'), 'should not contain +');
      assert.ok(!id.includes('/'), 'should not contain /');
    }
  });

  it('two calls produce different ids', () => {
    const a = nanoid();
    const b = nanoid();
    assert.notEqual(a, b);
  });

  it('throws for invalid size (0)', () => {
    assert.throws(() => nanoid(0), EncodingError);
  });

  it('throws for invalid size (negative)', () => {
    assert.throws(() => nanoid(-1), EncodingError);
  });

  it('throws for invalid size (non-integer)', () => {
    assert.throws(() => nanoid(1.5), EncodingError);
  });
});

// ---------------------------------------------------------------------------
// uuid (crypto.randomUUID)
// ---------------------------------------------------------------------------

describe('uuid', () => {
  it('returns a valid UUID v4 string', () => {
    const id = uuid();
    assert.equal(typeof id, 'string');
    assert.equal(id.length, 36);
    assert.ok(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
      `not a valid UUID v4: ${id}`,
    );
  });

  it('two calls produce different UUIDs', () => {
    assert.notEqual(uuid(), uuid());
  });
});

// ---------------------------------------------------------------------------
// randomBytes (crypto.getRandomValues)
// ---------------------------------------------------------------------------

describe('randomBytes', () => {
  it('returns Uint8Array of given size', () => {
    const bytes = randomBytes(16);
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(bytes.length, 16);
  });

  it('returns different values on successive calls', () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    assert.ok(a.some((v, i) => v !== b[i]));
  });

  it('throws for invalid size', () => {
    assert.throws(() => randomBytes(0), EncodingError);
    assert.throws(() => randomBytes(-5), EncodingError);
    assert.throws(() => randomBytes(1.5), EncodingError);
  });
});

// ---------------------------------------------------------------------------
// Error: value-free
// ---------------------------------------------------------------------------

describe('EncodingError', () => {
  it('extends SupportError', () => {
    const err = new EncodingError('test', 'decode_failed');
    assert.ok(err instanceof Error);
    assert.equal(err.code, 'decode_failed');
    assert.equal(err.name, 'EncodingError');
  });

  it('message never contains the offending input for malformed base64', () => {
    const bruteInput = '!!INJECTED_SECRET!!';
    assertValueFreeDecodeError(() => base64Decode(bruteInput), bruteInput);
  });

  it('message never contains the offending input for malformed hex', () => {
    const bruteInput = '!!INJECTED_SECRET!!';
    assertValueFreeDecodeError(() => hexDecode(bruteInput), bruteInput);
  });
});

// ---------------------------------------------------------------------------
// Encoding namespace is frozen
// ---------------------------------------------------------------------------

describe('Encoding namespace', () => {
  it('is frozen', () => {
    assert.ok(Object.isFrozen(Encoding));
  });

  it('throws when adding a property', () => {
    assert.throws(() => {
      (Encoding as Record<string, unknown>).foo = 'bar';
    });
  });
});
