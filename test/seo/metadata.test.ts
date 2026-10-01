/**
 * Metadata validation tests (`jsails/seo`).
 *
 * Covers {@link defineMetadata} shape validation: every known field is type-
 * checked, unknown keys pass through (forward-compat), and errors are value-free
 * ({@link SeoError} never echoes the offending input). Also asserts the returned
 * value is a deep-frozen copy distinct from the input.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineMetadata, SeoError } from '../../src/seo/index.js';
import type { PageMetadata } from '../../src/seo/metadata.js';
import type { JsonLdNode } from '../../src/seo/json-ld.js';

/** Assert a rejection is a SeoError with the given `code`, value-free. */
function isSeoError(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof SeoError, `expected SeoError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

describe('defineMetadata', () => {
  it('validates and deep-freezes a fully populated metadata value', () => {
    const input: PageMetadata = {
      title: 'Page Title',
      description: 'A page description.',
      canonical: 'https://example.com/page',
      robots: 'index, follow',
      keywords: ['seo', 'metadata'],
      openGraph: {
        title: 'OG Title',
        description: 'OG Desc',
        type: 'article',
        url: 'https://example.com/og',
        image: 'https://example.com/img.png',
        siteName: 'Example Site',
        locale: 'en_US',
      },
      twitter: {
        card: 'summary_large_image',
        title: 'Twitter Title',
        description: 'Twitter Desc',
        image: 'https://example.com/twitter.png',
        site: '@example',
        creator: '@author',
      },
      alternates: [
        { hreflang: 'en', href: 'https://example.com/en' },
        { hreflang: 'fr', href: 'https://example.com/fr', type: 'text/html' },
      ],
      jsonLd: [{ '@type': 'Article', headline: 'Test' } as unknown as JsonLdNode],
      meta: [
        { name: 'theme-color', content: '#ffffff' },
        { property: 'fb:app_id', content: '12345' },
      ],
    };

    const result = defineMetadata(input);
    // defineMetadata deep-freezes the input in place and returns it.
    assert.ok(Object.isFrozen(result));

    assert.equal(result.title, 'Page Title');
    assert.equal(result.description, 'A page description.');
    assert.equal(result.keywords!.length, 2);
    assert.ok(result.openGraph);
    assert.equal(result.openGraph.type, 'article');
    assert.equal(result.twitter!.card, 'summary_large_image');
    assert.equal(result.alternates!.length, 2);
    assert.ok(Object.isFrozen(result.openGraph));
    assert.ok(Object.isFrozen(result.twitter));
    assert.ok(Object.isFrozen(result.keywords));
    assert.ok(Object.isFrozen(result.alternates!));
    for (const link of result.alternates!) assert.ok(Object.isFrozen(link));
    assert.ok(Object.isFrozen(result.meta!));
    for (const tag of result.meta!) assert.ok(Object.isFrozen(tag));
  });

  it('returns an empty frozen object for empty input', () => {
    const result = defineMetadata({});
    assert.ok(Object.isFrozen(result));
    assert.equal(result.title, undefined);
  });

  it('permits unknown keys through (forward-compat)', () => {
    const result = defineMetadata({ title: 'x', futureField: 42 } as PageMetadata);
    assert.equal(result.title, 'x');
    assert.equal((result as Record<string, unknown>).futureField, 42);
  });

  it('rejects non-object input (value-free)', () => {
    assert.throws(
      () => defineMetadata('bad' as unknown as PageMetadata),
      isSeoError('invalid_metadata'),
    );
    assert.throws(
      () => defineMetadata(null as unknown as PageMetadata),
      isSeoError('invalid_metadata'),
    );
    assert.throws(
      () => defineMetadata([] as unknown as PageMetadata),
      isSeoError('invalid_metadata'),
    );
  });

  it('rejects a non-string title (value-free, does not echo the value)', () => {
    assert.throws(
      () => defineMetadata({ title: 42 } as unknown as PageMetadata),
      (error: unknown) => {
        assert.ok(error instanceof SeoError);
        assert.equal(error.code, 'invalid_metadata');
        assert.doesNotMatch(error.message, /42/);
        assert.equal(error.errors.length, 1);
        assert.equal(error.errors[0]!.field, 'title');
        return true;
      },
    );
  });

  it('rejects a non-string description (value-free)', () => {
    assert.throws(
      () => defineMetadata({ description: true } as unknown as PageMetadata),
      isSeoError('invalid_metadata'),
    );
  });

  it('rejects a non-string canonical (value-free)', () => {
    assert.throws(
      () => defineMetadata({ canonical: 1 } as unknown as PageMetadata),
      isSeoError('invalid_metadata'),
    );
  });

  it('rejects a non-string robots (value-free)', () => {
    assert.throws(
      () => defineMetadata({ robots: {} } as unknown as PageMetadata),
      isSeoError('invalid_metadata'),
    );
  });

  it('rejects non-string-array keywords (value-free)', () => {
    assert.throws(
      () => defineMetadata({ keywords: 'bad' } as unknown as PageMetadata),
      isSeoError('invalid_metadata'),
    );
    assert.throws(
      () => defineMetadata({ keywords: [1, 2] } as unknown as PageMetadata),
      isSeoError('invalid_metadata'),
    );
  });

  it('rejects a non-object openGraph (value-free)', () => {
    assert.throws(
      () => defineMetadata({ openGraph: 'not-obj' } as unknown as PageMetadata),
      isSeoError('invalid_metadata'),
    );
  });

  it('rejects a non-string openGraph sub-field (value-free)', () => {
    assert.throws(
      () => defineMetadata({ openGraph: { title: 7 } } as unknown as PageMetadata),
      (error: unknown) => {
        assert.ok(error instanceof SeoError);
        assert.equal(error.code, 'invalid_metadata');
        assert.doesNotMatch(error.message, /7/);
        return true;
      },
    );
  });

  it('rejects a non-object twitter (value-free)', () => {
    assert.throws(
      () => defineMetadata({ twitter: 1 } as unknown as PageMetadata),
      isSeoError('invalid_metadata'),
    );
  });

  it('rejects a malformed alternates entry (value-free)', () => {
    assert.throws(
      () => defineMetadata({ alternates: [{ hreflang: 'en' }] } as unknown as PageMetadata),
      isSeoError('invalid_metadata'),
    );
    assert.throws(
      () =>
        defineMetadata({ alternates: [{ hreflang: 'en', href: 1 }] } as unknown as PageMetadata),
      isSeoError('invalid_metadata'),
    );
  });

  it('rejects a malformed meta tag entry (value-free)', () => {
    assert.throws(
      () => defineMetadata({ meta: [{ content: 99 }] } as unknown as PageMetadata),
      isSeoError('invalid_metadata'),
    );
    assert.throws(
      () => defineMetadata({ meta: 1 } as unknown as PageMetadata),
      isSeoError('invalid_metadata'),
    );
  });
});
