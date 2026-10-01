import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StrError } from '../../src/support/strings.js';
import {
  Str,
  camel,
  constant,
  escapeHtml,
  excerpt,
  kebab,
  limit,
  mask,
  pascal,
  random,
  slug,
  snake,
  title,
  truncate,
  unescapeHtml,
  words,
} from '../../src/support/strings.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertValueFreeError(fn: () => unknown, offendingValue: string) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof StrError);
    assert.equal(err.code, 'invalid_argument');
    const message = err.message;
    assert.ok(!message.includes(offendingValue), `message should not echo input: ${message}`);
    return true;
  });
}

// ---------------------------------------------------------------------------
// camel
// ---------------------------------------------------------------------------

describe('camel', () => {
  it('converts to camelCase', () => {
    assert.equal(camel('hello world'), 'helloWorld');
    assert.equal(camel('foo bar baz'), 'fooBarBaz');
  });

  it('handles empty string', () => {
    assert.equal(camel(''), '');
  });

  it('throws value-free on non-string', () => {
    assertValueFreeError(() => camel(123 as unknown as string), '123');
  });
});

// ---------------------------------------------------------------------------
// pascal
// ---------------------------------------------------------------------------

describe('pascal', () => {
  it('converts to PascalCase', () => {
    assert.equal(pascal('hello world'), 'HelloWorld');
    assert.equal(pascal('foo bar baz'), 'FooBarBaz');
  });

  it('handles empty string', () => {
    assert.equal(pascal(''), '');
  });

  it('throws value-free on non-string', () => {
    assertValueFreeError(() => pascal(null as unknown as string), 'null');
  });
});

// ---------------------------------------------------------------------------
// snake
// ---------------------------------------------------------------------------

describe('snake', () => {
  it('converts to snake_case', () => {
    assert.equal(snake('hello world'), 'hello_world');
    assert.equal(snake('FooBar'), 'foo_bar');
  });

  it('handles empty string', () => {
    assert.equal(snake(''), '');
  });

  it('throws value-free on non-string', () => {
    assertValueFreeError(() => snake(undefined as unknown as string), 'undefined');
  });
});

// ---------------------------------------------------------------------------
// kebab
// ---------------------------------------------------------------------------

describe('kebab', () => {
  it('converts to kebab-case', () => {
    assert.equal(kebab('hello world'), 'hello-world');
    assert.equal(kebab('FooBar'), 'foo-bar');
  });

  it('handles empty string', () => {
    assert.equal(kebab(''), '');
  });

  it('throws value-free on non-string', () => {
    assertValueFreeError(() => kebab(42 as unknown as string), '42');
  });
});

// ---------------------------------------------------------------------------
// constant
// ---------------------------------------------------------------------------

describe('constant', () => {
  it('converts to CONSTANT_CASE', () => {
    assert.equal(constant('hello world'), 'HELLO_WORLD');
    assert.equal(constant('FooBar'), 'FOO_BAR');
  });

  it('handles empty string', () => {
    assert.equal(constant(''), '');
  });
});

// ---------------------------------------------------------------------------
// title
// ---------------------------------------------------------------------------

describe('title', () => {
  it('converts to Title Case', () => {
    assert.equal(title('hello world'), 'Hello World');
    assert.equal(title('foo bar baz'), 'Foo Bar Baz');
  });

  it('handles empty string', () => {
    assert.equal(title(''), '');
  });
});

// ---------------------------------------------------------------------------
// slug
// ---------------------------------------------------------------------------

describe('slug', () => {
  it('slugifies a string', () => {
    assert.equal(slug('Hello World'), 'Hello-World');
  });

  it('slugifies with lower option', () => {
    assert.equal(slug('Hello World', { lower: true }), 'hello-world');
  });

  it('handles empty string', () => {
    assert.equal(slug(''), '');
  });

  it('handles unicode input', () => {
    // slugify strips non-ASCII characters by default.
    assert.equal(slug('Café au Lait'), 'Cafe-au-Lait');
    assert.equal(slug('日本語のテスト'), '');
  });

  it('throws value-free on non-string', () => {
    assertValueFreeError(() => slug(true as unknown as string), 'true');
  });
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe('truncate', () => {
  it('does nothing when string is shorter than length', () => {
    assert.equal(truncate('hi', 10), 'hi');
  });

  it('does nothing when string equals length', () => {
    assert.equal(truncate('hello', 5), 'hello');
  });

  it('truncates and appends default ellipsis', () => {
    const result = truncate('hello world', 8);
    assert.equal(result, 'hello w…');
    assert.equal(result.length, 8);
  });

  it('uses custom ellipsis', () => {
    const result = truncate('hello world', 10, { ellipsis: '...' });
    assert.equal(result, 'hello w...');
    assert.equal(result.length, 10);
  });

  it('returns only ellipsis when length is very small', () => {
    // length=2, ellipsis '…' (1 char), keepLength = 2-1 = 1 → "h…" (length 2)
    const result = truncate('hello', 2);
    assert.equal(result, 'h…');
  });

  it('handles ellipsis longer than length', () => {
    // length=2, ellipsis '...' (3 chars), keepLength = 2-3 = -1 → "...".slice(0,2) → ".."
    const result = truncate('hello', 2, { ellipsis: '...' });
    assert.equal(result, '..');
    assert.equal(result.length, 2);
  });

  it('handles empty string', () => {
    assert.equal(truncate('', 10), '');
  });

  it('handles unicode input', () => {
    // 'café résumé' — 11 chars. length=8, ellipsis '…' (1 char). keepLength=7 → 'café ré…' (8 chars).
    const result = truncate('café résumé', 8);
    assert.equal(result, 'café ré…');
    assert.equal(result.length, 8);
  });

  it('handles emoji input', () => {
    const input = 'hello 🌍 world';
    const result = truncate(input, 10);
    // emoji may take 2 JS chars (surrogate pair), but length counts JS chars
    assert.equal(result.length, 10);
  });

  it('throws value-free on non-string value', () => {
    assertValueFreeError(() => truncate(123 as unknown as string, 5), '123');
  });

  it('throws value-free on non-integer length', () => {
    assertValueFreeError(() => truncate('hello', 1.5), '1.5');
  });

  it('throws value-free on zero length', () => {
    assertValueFreeError(() => truncate('hello', 0), '0');
  });

  it('throws value-free on negative length', () => {
    assertValueFreeError(() => truncate('hello', -1), '-1');
  });
});

// ---------------------------------------------------------------------------
// excerpt
// ---------------------------------------------------------------------------

describe('excerpt', () => {
  it('does nothing when string is shorter than length', () => {
    assert.equal(excerpt('hello', 10), 'hello');
  });

  it('truncates at a word boundary', () => {
    const result = excerpt('hello world foo bar', 18);
    assert.equal(result, 'hello world foo...');
  });

  it('hard-cuts when there is no word boundary before length', () => {
    const result = excerpt('abcdefghijklmnop', 8);
    assert.equal(result, 'abcdefgh...');
  });

  it('does not cut before the first word when space is at the start', () => {
    const result = excerpt(' hello world', 4);
    // slice(0,4) = ' hel', lastSpace matches the leading space at index 0
    // index 0 means no word boundary found, hard cut
    assert.equal(result, ' hel...');
  });

  it('handles empty string', () => {
    assert.equal(excerpt('', 10), '');
  });

  it('handles unicode input', () => {
    const result = excerpt('café résumé sur', 10);
    // 'café résu' has space at index 4
    assert.equal(result, 'café...');
  });

  it('throws value-free on non-string value', () => {
    assertValueFreeError(() => excerpt(123 as unknown as string, 5), '123');
  });

  it('throws value-free on invalid length', () => {
    assertValueFreeError(() => excerpt('hello', 0), '0');
  });
});

// ---------------------------------------------------------------------------
// words
// ---------------------------------------------------------------------------

describe('words', () => {
  it('splits on whitespace', () => {
    assert.deepEqual(words('hello world'), ['hello', 'world']);
    assert.deepEqual(words('foo  bar\tbaz\nqux'), ['foo', 'bar', 'baz', 'qux']);
  });

  it('handles empty string', () => {
    assert.deepEqual(words(''), []);
  });

  it('handles whitespace-only string', () => {
    assert.deepEqual(words('   \t \n  '), []);
  });

  it('handles unicode input', () => {
    assert.deepEqual(words('café résumé'), ['café', 'résumé']);
  });

  it('throws value-free on non-string', () => {
    assertValueFreeError(() => words(42 as unknown as string), '42');
  });
});

// ---------------------------------------------------------------------------
// limit
// ---------------------------------------------------------------------------

describe('limit', () => {
  it('hard-cuts to length with no ellipsis', () => {
    assert.equal(limit('hello world', 5), 'hello');
  });

  it('returns full string when shorter than length', () => {
    assert.equal(limit('hi', 10), 'hi');
  });

  it('handles empty string', () => {
    assert.equal(limit('', 5), '');
  });

  it('throws value-free on non-string', () => {
    assertValueFreeError(() => limit(123 as unknown as string, 5), '123');
  });

  it('throws value-free on invalid length', () => {
    assertValueFreeError(() => limit('hello', 0), '0');
  });
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  it('escapes exactly five entities', () => {
    assert.equal(escapeHtml('&'), '&amp;');
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('>'), '&gt;');
    assert.equal(escapeHtml('"'), '&quot;');
    assert.equal(escapeHtml("'"), '&#39;');
  });

  it('escapes all five in a single string', () => {
    assert.equal(escapeHtml('a & b < c > d " e \' f'), 'a &amp; b &lt; c &gt; d &quot; e &#39; f');
  });

  it('does not escape anything else', () => {
    assert.equal(escapeHtml('hello world'), 'hello world');
    assert.equal(escapeHtml('/'), '/');
    assert.equal(escapeHtml('`'), '`');
  });

  it('handles empty string', () => {
    assert.equal(escapeHtml(''), '');
  });

  it('throws value-free on non-string', () => {
    assertValueFreeError(() => escapeHtml(123 as unknown as string), '123');
  });
});

// ---------------------------------------------------------------------------
// unescapeHtml
// ---------------------------------------------------------------------------

describe('unescapeHtml', () => {
  it('unescapes exactly five entities', () => {
    assert.equal(unescapeHtml('&amp;'), '&');
    assert.equal(unescapeHtml('&lt;'), '<');
    assert.equal(unescapeHtml('&gt;'), '>');
    assert.equal(unescapeHtml('&quot;'), '"');
    assert.equal(unescapeHtml('&#39;'), "'");
  });

  it('also handles hex and apos variants of single quote', () => {
    assert.equal(unescapeHtml('&#x27;'), "'");
    assert.equal(unescapeHtml('&apos;'), "'");
  });

  it('round-trips with escapeHtml', () => {
    const original = 'foo & bar < baz > qux " end \' last';
    assert.equal(unescapeHtml(escapeHtml(original)), original);
  });

  it('handles empty string', () => {
    assert.equal(unescapeHtml(''), '');
  });

  it('throws value-free on non-string', () => {
    assertValueFreeError(() => unescapeHtml(123 as unknown as string), '123');
  });
});

// ---------------------------------------------------------------------------
// random
// ---------------------------------------------------------------------------

describe('random', () => {
  it('returns a string of the requested length', () => {
    const result = random(32);
    assert.equal(result.length, 32);
    assert.ok(/^[A-Za-z0-9]+$/.test(result));
  });

  it('returns 16 chars by default', () => {
    const result = random();
    assert.equal(result.length, 16);
  });

  it('returns empty string for length 0', () => {
    assert.equal(random(0), '');
  });

  it('returns only alphanumeric characters', () => {
    for (let i = 0; i < 10; i++) {
      assert.ok(/^[A-Za-z0-9]+$/.test(random(64)));
    }
  });

  it('throws value-free on negative length', () => {
    assertValueFreeError(() => random(-1), '-1');
  });

  it('throws value-free on non-integer length', () => {
    assertValueFreeError(() => random(3.5), '3.5');
  });
});

// ---------------------------------------------------------------------------
// mask
// ---------------------------------------------------------------------------

describe('mask', () => {
  it('masks entire string by default', () => {
    assert.equal(mask('secret'), '******');
  });

  it('reveals leading characters', () => {
    assert.equal(mask('hello world', { revealLeading: 3 }), 'hel********');
  });

  it('reveals trailing characters', () => {
    assert.equal(mask('hello world', { revealTrailing: 3 }), '********rld');
  });

  it('reveals leading and trailing characters', () => {
    assert.equal(mask('hello world', { revealLeading: 2, revealTrailing: 2 }), 'he*******ld');
  });

  it('uses custom mask character', () => {
    assert.equal(mask('secret', { maskChar: '#' }), '######');
  });

  it('returns the full string when reveal covers it entirely', () => {
    assert.equal(mask('abc', { revealLeading: 2, revealTrailing: 2 }), 'abc');
  });

  it('handles empty string', () => {
    assert.equal(mask(''), '');
  });

  it('handles revealLeading equal to length', () => {
    assert.equal(mask('abc', { revealLeading: 3 }), 'abc');
  });

  it('throws value-free on non-string value', () => {
    assertValueFreeError(() => mask(123 as unknown as string), '123');
  });

  it('throws value-free on invalid maskChar', () => {
    assert.throws(
      () => mask('hello', { maskChar: '' }),
      (err: unknown) => err instanceof StrError && err.code === 'invalid_argument',
    );
  });

  it('throws value-free on negative revealLeading', () => {
    assertValueFreeError(() => mask('hello', { revealLeading: -1 }), '-1');
  });
});

// ---------------------------------------------------------------------------
// Str namespace
// ---------------------------------------------------------------------------

describe('Str namespace', () => {
  it('is frozen', () => {
    assert.ok(Object.isFrozen(Str));
  });

  it('exports all functions', () => {
    const expected = [
      'camel',
      'pascal',
      'snake',
      'kebab',
      'constant',
      'title',
      'slug',
      'truncate',
      'excerpt',
      'words',
      'limit',
      'escapeHtml',
      'unescapeHtml',
      'random',
      'mask',
    ];
    for (const name of expected) {
      assert.ok(typeof (Str as Record<string, unknown>)[name] === 'function', `Str.${name}`);
    }
  });

  it('named exports equal namespace members', () => {
    assert.equal(Str.camel, camel);
    assert.equal(Str.truncate, truncate);
    assert.equal(Str.escapeHtml, escapeHtml);
    assert.equal(Str.random, random);
    assert.equal(Str.mask, mask);
  });
});
