import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Cookie,
  CookieError,
  parse,
  parseSetCookie,
  serialize,
} from '../../src/support/cookie.server.js';

describe('Cookie', () => {
  it('parses a Cookie header into a record', () => {
    assert.deepEqual(parse('a=1; b=2'), { a: '1', b: '2' });
  });

  it('URL-decodes values by default', () => {
    assert.deepEqual(parse('name=hello%20world'), { name: 'hello world' });
  });

  it('throws invalid_argument for a non-string header', () => {
    assert.throws(
      () => parse(42 as unknown as string),
      (error: unknown) => {
        assert.ok(error instanceof CookieError);
        assert.equal(error.code, 'invalid_argument');
        return true;
      },
    );
  });

  it('serializes a Set-Cookie header', () => {
    const header = serialize('session', 'abc', { path: '/', httpOnly: true });
    assert.match(header, /^session=abc/);
    assert.match(header, /Path=\//);
    assert.match(header, /HttpOnly/);
  });

  it('serializes SameSite and Secure attributes', () => {
    const header = serialize('t', 'v', { sameSite: 'none', secure: true });
    assert.match(header, /Secure/);
    assert.match(header, /SameSite=None/);
  });

  it('parses a single Set-Cookie header', () => {
    const [entry] = parseSetCookie('sid=xyz; Path=/; HttpOnly');
    assert.ok(entry);
    assert.equal(entry.name, 'sid');
    assert.equal(entry.value, 'xyz');
    assert.equal(entry.path, '/');
    assert.equal(entry.httpOnly, true);
  });

  it('parses an array of Set-Cookie headers', () => {
    const entries = parseSetCookie(['a=1; Path=/', 'b=2; Path=/x']);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.name, 'a');
    assert.equal(entries[1]?.name, 'b');
  });

  it('exposes a frozen namespace with the same functions', () => {
    assert.equal(Cookie.parse, parse);
    assert.equal(Cookie.serialize, serialize);
    assert.ok(Object.isFrozen(Cookie));
  });
});
