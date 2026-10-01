/**
 * Tests for the rich-text surface: sanitizer invocation, plain-text extraction,
 * length bound enforcement, and the caller-owns-sanitization contract.
 *
 * No HTML parser or external dependency is required — sanitizers are plain
 * functions injected by the test.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRichText, type RichText } from '../../src/filesystem/rich-text.js';

/** Pass-through sanitizer: returns input unchanged (for testing only — never in production). */
function noopSanitize(html: string): string {
  return html;
}

/** Sanitizer that strips <script> and event handlers. */
function stripScripts(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\s+on\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\s+on\w+\s*=\s*'[^']*'/gi, '');
}

// ---------------------------------------------------------------------------
// Factory creation
// ---------------------------------------------------------------------------

describe('createRichText', () => {
  it('returns a factory with fromHtml', () => {
    const factory = createRichText({ sanitize: noopSanitize });
    assert.equal(typeof factory.fromHtml, 'function');
  });

  it('rejects a non-function sanitize', () => {
    assert.throws(
      () => createRichText({ sanitize: 'not-a-function' as unknown as (h: string) => string }),
      /sanitize must be a function/,
    );
  });

  it('rejects an invalid maxLength', () => {
    assert.throws(
      () => createRichText({ sanitize: noopSanitize, maxLength: 0 }),
      /positive integer/,
    );
    assert.throws(
      () => createRichText({ sanitize: noopSanitize, maxLength: -1 }),
      /positive integer/,
    );
    assert.throws(
      () => createRichText({ sanitize: noopSanitize, maxLength: 1.5 }),
      /positive integer/,
    );
  });

  it('defaults maxLength to 65536', () => {
    const factory = createRichText({ sanitize: noopSanitize });
    // The default is an internal constant; we verify it by passing a string
    // at the boundary — 65536 chars should still be accepted without truncation.
    const input = 'a'.repeat(65_536);
    const result = factory.fromHtml(input);
    assert.equal(result.html.length, 65_536);
  });
});

// ---------------------------------------------------------------------------
// Sanitizer invocation
// ---------------------------------------------------------------------------

describe('sanitizer invocation', () => {
  it('calls the sanitizer exactly once per fromHtml', () => {
    let callCount = 0;
    const sanitize = (html: string) => {
      callCount++;
      return html;
    };
    const factory = createRichText({ sanitize });

    factory.fromHtml('<p>hello</p>');
    assert.equal(callCount, 1);

    factory.fromHtml('<p>world</p>');
    assert.equal(callCount, 2);
  });

  it('passes the raw HTML to the sanitizer', () => {
    let received = '';
    const sanitize = (html: string) => {
      received = html;
      return html.toUpperCase();
    };
    const factory = createRichText({ sanitize });

    factory.fromHtml('<p>Test</p>');
    assert.equal(received, '<p>Test</p>');
  });

  it('uses the sanitizer output as the html property', () => {
    const sanitize = (_html: string): string => '<b>SAFE</b>';
    const factory = createRichText({ sanitize });

    const result = factory.fromHtml('<script>alert(1)</script>');
    assert.equal(result.html, '<b>SAFE</b>');
  });

  it('html property reflects whatever the sanitizer returned', () => {
    const sanitize = (_html: string): string => '<custom-element>content</custom-element>';
    const factory = createRichText({ sanitize });

    const result = factory.fromHtml('anything');
    assert.equal(result.html, '<custom-element>content</custom-element>');
  });

  it('sanitizer can remove dangerous content', () => {
    const factory = createRichText({ sanitize: stripScripts });

    const result = factory.fromHtml(
      '<h1>Title</h1><script>alert(1)</script><p onclick="bad()">Text</p>',
    );
    assert.ok(!result.html.includes('<script>'), 'script tags must be removed');
    assert.ok(!result.html.includes('onclick'), 'event handlers must be removed');
    assert.ok(result.html.includes('<h1>Title</h1>'));
  });
});

// ---------------------------------------------------------------------------
// Plain-text extraction
// ---------------------------------------------------------------------------

describe('plain-text extraction', () => {
  it('strips all HTML tags from the sanitized output', () => {
    const factory = createRichText({ sanitize: noopSanitize });

    const result = factory.fromHtml('<p>Hello <strong>world</strong></p>');
    assert.equal(result.plain, 'Hello world');
  });

  it('removes self-closing tags', () => {
    // A simple regex tag-stripper removes <br> but does not insert spaces
    // between adjacent text nodes — that would require HTML semantics.
    const factory = createRichText({ sanitize: noopSanitize });

    const result = factory.fromHtml('Line 1<br><br>Line 2<br/>Line 3');
    assert.equal(result.plain, 'Line 1Line 2Line 3');
  });

  it('decodes XML named entities', () => {
    const factory = createRichText({ sanitize: noopSanitize });

    const result = factory.fromHtml(
      '&amp; ampersand &lt; less-than &gt; greater-than &quot; double-quote',
    );
    assert.equal(result.plain, '& ampersand < less-than > greater-than " double-quote');
  });

  it('decodes numeric apostrophe references', () => {
    const factory = createRichText({ sanitize: noopSanitize });

    const result = factory.fromHtml('it&#39;s a test and it&#x27;s fine');
    assert.equal(result.plain, "it's a test and it's fine");
  });

  it('collapses multiple whitespace sequences', () => {
    const factory = createRichText({ sanitize: noopSanitize });

    const result = factory.fromHtml('foo   bar\t\t\nbaz');
    assert.equal(result.plain, 'foo bar baz');
  });

  it('trims leading and trailing whitespace', () => {
    const factory = createRichText({ sanitize: noopSanitize });

    const result = factory.fromHtml('   <p>  padded  </p>  ');
    assert.equal(result.plain, 'padded');
  });

  it('plain text derives from sanitized HTML, not raw input', () => {
    // If sanitizer strips a tag, plain should not show its text content.
    const sanitize = (html: string): string => html.replace(/<secret>[\s\S]*?<\/secret>/g, '');
    const factory = createRichText({ sanitize });

    const result = factory.fromHtml('<p>visible</p><secret>hidden</secret>');
    assert.equal(result.plain, 'visible');
    assert.ok(!result.plain.includes('hidden'));
  });

  it('returns empty string for empty or only-tag input', () => {
    const factory = createRichText({ sanitize: noopSanitize });

    assert.equal(factory.fromHtml('').plain, '');
    assert.equal(factory.fromHtml('<p></p>').plain, '');
    assert.equal(factory.fromHtml('<br><br>').plain, '');
  });

  it('preserves text inside known-safe tags', () => {
    // Adjacent tags with no separating whitespace produce concatenated text —
    // the tag-stripper has no HTML semantics and cannot insert spaces.
    const factory = createRichText({ sanitize: noopSanitize });

    const result = factory.fromHtml('<h1>Heading</h1><div>Content</div><span>span text</span>');
    assert.equal(result.plain, 'HeadingContentspan text');
  });

  it('removes comments and raw CDATA sections', () => {
    const factory = createRichText({ sanitize: noopSanitize });

    // Both are enclosed in <...> tokens so the tag-stripper catches them.
    const result = factory.fromHtml('<!-- hidden --><p>shown</p><![CDATA[ <raw> ]]>');
    assert.equal(result.plain, 'shown');
  });

  it('returns both html and plain on every RichText value', () => {
    const factory = createRichText({ sanitize: noopSanitize });

    const value: RichText = factory.fromHtml('<em>italic</em>');
    assert.equal(value.html, '<em>italic</em>');
    assert.equal(value.plain, 'italic');
  });
});

// ---------------------------------------------------------------------------
// Length bound
// ---------------------------------------------------------------------------

describe('length bound', () => {
  it('passes input shorter than maxLength through unchanged', () => {
    const factory = createRichText({ sanitize: noopSanitize, maxLength: 100 });
    const result = factory.fromHtml('<p>short</p>');
    assert.equal(result.html, '<p>short</p>');
  });

  it('truncates input exceeding maxLength before sanitization', () => {
    const factory = createRichText({ sanitize: noopSanitize, maxLength: 20 });

    // The sanitizer will see only the first 20 chars.
    // So '<p>very long paragraph</p>' → '<p>very long paragra' (20 chars)
    const result = factory.fromHtml('<p>very long paragraph</p>');
    assert.equal(result.html, '<p>very long paragra');
    assert.ok(result.html.length <= 20);
  });

  it('truncation happens before the sanitizer is called', () => {
    let receivedLength = 0;
    const sanitize = (html: string) => {
      receivedLength = html.length;
      return html;
    };
    const factory = createRichText({ sanitize, maxLength: 5 });

    factory.fromHtml('1234567890');
    assert.equal(receivedLength, 5);
  });

  it('exactly maxLength input is not truncated', () => {
    const input = 'x'.repeat(50);
    const factory = createRichText({ sanitize: noopSanitize, maxLength: 50 });
    const result = factory.fromHtml(input);
    assert.equal(result.html.length, 50);
  });

  it('truncation is silent — no error is thrown', () => {
    const factory = createRichText({ sanitize: noopSanitize, maxLength: 5 });
    const result = factory.fromHtml('very long string');
    assert.equal(result.html, 'very ');
  });
});

// ---------------------------------------------------------------------------
// Immutability and reuse
// ---------------------------------------------------------------------------

describe('factory reuse', () => {
  it('is safe to reuse the factory', () => {
    const factory = createRichText({ sanitize: noopSanitize });

    const r1 = factory.fromHtml('<p>first</p>');
    const r2 = factory.fromHtml('<p>second</p>');

    assert.equal(r1.html, '<p>first</p>');
    assert.equal(r2.html, '<p>second</p>');
    assert.notEqual(r1.html, r2.html);
  });

  it('returns independent RichText objects', () => {
    const factory = createRichText({ sanitize: noopSanitize });

    const r1 = factory.fromHtml('<p>a</p>');
    const r2 = factory.fromHtml('<p>b</p>');

    assert.equal(r1.html, '<p>a</p>');
    assert.equal(r2.html, '<p>b</p>');

    // Mutating one should not affect the other (they are plain frozen-ish objects).
    assert.notEqual(r1, r2);
  });
});
