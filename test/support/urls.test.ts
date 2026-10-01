import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UrlError } from '../../src/support/urls.js';
import {
  Url,
  addParams,
  buildQuery,
  buildQueryDeep,
  join,
  parseQuery,
  parseQueryDeep,
  removeParams,
} from '../../src/support/urls.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertValueFreeError(fn: () => unknown, offendingValue: string) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof UrlError);
    assert.equal(err.code, 'invalid_argument');
    const message = err.message;
    assert.ok(!message.includes(offendingValue), `message should not echo input: ${message}`);
    return true;
  });
}

// ---------------------------------------------------------------------------
// parseQuery
// ---------------------------------------------------------------------------

describe('parseQuery', () => {
  it('parses a flat query string', () => {
    const result = parseQuery('a=1&b=2');
    assert.deepEqual(result, { a: '1', b: '2' });
  });

  it('handles a query string with a leading ?', () => {
    const result = parseQuery('?a=1&b=2');
    assert.deepEqual(result, { a: '1', b: '2' });
  });

  it('repeated keys take the last value', () => {
    const result = parseQuery('a=1&a=2');
    assert.deepEqual(result, { a: '2' });
  });

  it('decodes percent-encoded characters', () => {
    const result = parseQuery('key=hello%20world');
    assert.deepEqual(result, { key: 'hello world' });
  });

  it('handles empty query string', () => {
    assert.deepEqual(parseQuery(''), {});
  });

  it('handles key-only (no value)', () => {
    const result = parseQuery('flag');
    assert.deepEqual(result, { flag: '' });
  });

  it('accepts a URLSearchParams instance', () => {
    const params = new URLSearchParams('a=1&b=2');
    assert.deepEqual(parseQuery(params), { a: '1', b: '2' });
  });

  it('throws value-free on non-string', () => {
    assertValueFreeError(() => parseQuery(123 as unknown as string), '123');
  });
});

// ---------------------------------------------------------------------------
// buildQuery
// ---------------------------------------------------------------------------

describe('buildQuery', () => {
  it('builds a flat query string', () => {
    const result = buildQuery({ a: '1', b: '2' });
    assert.equal(result, 'a=1&b=2');
  });

  it('handles numbers and booleans', () => {
    const result = buildQuery({ count: 42, active: true });
    assert.equal(result, 'count=42&active=true');
  });

  it('omits null and undefined values', () => {
    const result = buildQuery({ a: '1', b: null, c: undefined });
    assert.equal(result, 'a=1');
  });

  it('round-trips with parseQuery', () => {
    const input = { key: 'hello world', page: '3' };
    const query = buildQuery(input);
    const parsed = parseQuery(query);
    assert.deepEqual(parsed, input);
  });

  it('encodes special characters', () => {
    const result = buildQuery({ key: 'hello world' });
    assert.equal(result, 'key=hello+world');
  });
});

// ---------------------------------------------------------------------------
// parseQueryDeep
// ---------------------------------------------------------------------------

describe('parseQueryDeep', () => {
  it('parses nested objects', () => {
    const result = parseQueryDeep('a=1&b[c]=2&b[d]=3');
    assert.deepEqual(result, { a: '1', b: { c: '2', d: '3' } });
  });

  it('parses arrays with brackets notation', () => {
    const result = parseQueryDeep('a[]=1&a[]=2');
    assert.deepEqual(result, { a: ['1', '2'] });
  });

  it('round-trips with buildQueryDeep', () => {
    const input = { a: '1', b: { c: '2', d: '3' } };
    const query = buildQueryDeep(input);
    const parsed = parseQueryDeep(query);
    assert.deepEqual(parsed, input);
  });

  it('round-trips arrays', () => {
    const input = { tags: ['js', 'ts'] };
    const query = buildQueryDeep(input, { addArraySuffix: true });
    const parsed = parseQueryDeep(query);
    assert.deepEqual(parsed, input);
  });

  it('throws value-free on non-string', () => {
    assertValueFreeError(() => parseQueryDeep(123 as unknown as string), '123');
  });
});

// ---------------------------------------------------------------------------
// buildQueryDeep
// ---------------------------------------------------------------------------

describe('buildQueryDeep', () => {
  it('builds nested objects', () => {
    const result = buildQueryDeep({ a: '1', b: { c: '2' } });
    assert.equal(result, 'a=1&b%5Bc%5D=2');
  });

  it('builds arrays (default format)', () => {
    const result = buildQueryDeep({ tags: ['a', 'b'] });
    assert.equal(result, 'tags%5B0%5D=a&tags%5B1%5D=b');
  });

  it('adds array suffix when option is set', () => {
    const result = buildQueryDeep({ tags: ['a', 'b'] }, { addArraySuffix: true });
    assert.equal(result, 'tags%5B%5D=a&tags%5B%5D=b');
  });

  it('uses indices when option is set', () => {
    const result = buildQueryDeep({ tags: ['a', 'b'] }, { arrayIndices: true });
    assert.equal(result, 'tags%5B0%5D=a&tags%5B1%5D=b');
  });

  it('encodes special characters', () => {
    const result = buildQueryDeep({ key: 'hello world' });
    assert.equal(result, 'key=hello%20world');
  });
});

// ---------------------------------------------------------------------------
// join
// ---------------------------------------------------------------------------

describe('join', () => {
  it('resolves a relative path segment against a base URL', () => {
    const result = join('https://example.com/a/', 'b/c');
    assert.equal(result, 'https://example.com/a/b/c');
  });

  it('handles a base without a trailing slash', () => {
    const result = join('https://example.com/path', 'segment');
    assert.equal(result, 'https://example.com/path/segment');
  });

  it('replaces the path with an absolute-path segment', () => {
    const result = join('https://example.com/a/b', '/c/d');
    assert.equal(result, 'https://example.com/c/d');
  });

  it('handles multiple segments', () => {
    const result = join('https://example.com/a/', 'b', 'c');
    assert.equal(result, 'https://example.com/a/b/c');
  });

  it('returns base when no segments are given', () => {
    const result = join('https://example.com/a/');
    assert.equal(result, 'https://example.com/a/');
  });

  it('handles query-only segment', () => {
    const result = join('https://example.com/path', '?q=1');
    assert.equal(result, 'https://example.com/path?q=1');
  });

  it('handles hash-only segment', () => {
    const result = join('https://example.com/path', '#section');
    assert.equal(result, 'https://example.com/path#section');
  });

  it('throws value-free on non-URL base', () => {
    assertValueFreeError(() => join('not-a-url'), 'not-a-url');
  });

  it('throws value-free on non-string segment', () => {
    assertValueFreeError(() => join('https://example.com/', 123 as unknown as string), '123');
  });
});

// ---------------------------------------------------------------------------
// addParams
// ---------------------------------------------------------------------------

describe('addParams', () => {
  it('adds params to a URL with no existing query', () => {
    const result = addParams('https://example.com/path', { a: '1' });
    assert.equal(result, 'https://example.com/path?a=1');
  });

  it('adds params without clobbering unrelated params', () => {
    const result = addParams('https://example.com/path?existing=keep', { added: 'yes' });
    const parsed = new URL(result);
    assert.equal(parsed.searchParams.get('existing'), 'keep');
    assert.equal(parsed.searchParams.get('added'), 'yes');
  });

  it('overwrites an existing key', () => {
    const result = addParams('https://example.com/path?key=old', { key: 'new' });
    const parsed = new URL(result);
    assert.equal(parsed.searchParams.get('key'), 'new');
  });

  it('adds multiple params at once', () => {
    const result = addParams('https://example.com/path', { a: '1', b: '2' });
    const parsed = new URL(result);
    assert.equal(parsed.searchParams.get('a'), '1');
    assert.equal(parsed.searchParams.get('b'), '2');
  });

  it('encodes param values', () => {
    const result = addParams('https://example.com/path', { q: 'hello world' });
    const parsed = new URL(result);
    assert.equal(parsed.searchParams.get('q'), 'hello world');
  });

  it('throws value-free on invalid URL', () => {
    assertValueFreeError(() => addParams('not-a-url', { a: '1' }), 'not-a-url');
  });
});

// ---------------------------------------------------------------------------
// removeParams
// ---------------------------------------------------------------------------

describe('removeParams', () => {
  it('removes listed keys', () => {
    const result = removeParams('https://example.com/path?a=1&b=2', ['a']);
    assert.equal(result, 'https://example.com/path?b=2');
  });

  it('removes multiple keys', () => {
    const result = removeParams('https://example.com/path?a=1&b=2&c=3', ['a', 'c']);
    assert.equal(result, 'https://example.com/path?b=2');
  });

  it('leaves other params untouched', () => {
    const result = removeParams('https://example.com/path?a=1&b=2', ['c']);
    assert.equal(new URL(result).searchParams.toString(), 'a=1&b=2');
  });

  it('removes all params to produce a clean URL', () => {
    const result = removeParams('https://example.com/path?a=1&b=2', ['a', 'b']);
    assert.equal(result, 'https://example.com/path');
  });

  it('throws value-free on invalid URL', () => {
    assertValueFreeError(() => removeParams('not-a-url', ['a']), 'not-a-url');
  });
});

// ---------------------------------------------------------------------------
// Url namespace
// ---------------------------------------------------------------------------

describe('Url namespace', () => {
  it('is frozen', () => {
    assert.ok(Object.isFrozen(Url));
  });

  it('exports all expected methods', () => {
    const keys = Object.keys(Url);
    assert.deepEqual(keys.sort(), [
      'addParams',
      'buildQuery',
      'buildQueryDeep',
      'join',
      'parseQuery',
      'parseQueryDeep',
      'removeParams',
    ]);
  });
});
