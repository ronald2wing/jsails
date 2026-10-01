/**
 * Head-tag building and injection tests (`jsails/seo`).
 *
 * Covers {@link buildHeadTags} (metadata → unhead → serialized tags),
 * {@link injectHead} (tag injection into a document), and {@link assertOrigin}.
 * Every test asserts observed output — no guesswork about unhead tag order or
 * formatting.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertOrigin, buildHeadTags, injectHead, jsonLd, SeoError } from '../../src/seo/index.js';
import type { JsonLdNode, PageMetadata } from '../../src/seo/index.js';

describe('buildHeadTags', () => {
  it('returns an empty string when nothing is set', () => {
    assert.equal(buildHeadTags({}), '');
  });

  it('renders a title tag', () => {
    const tags = buildHeadTags({ title: 'Hello' });
    assert.match(tags, /<title>Hello<\/title>/);
    assert.doesNotMatch(tags, /<meta/);
  });

  it('renders description and robots meta tags', () => {
    const tags = buildHeadTags({ description: 'A page', robots: 'noindex' });
    assert.match(tags, /<meta name="description" content="A page">/);
    assert.match(tags, /<meta name="robots" content="noindex">/);
  });

  it('renders keywords as a comma-separated meta tag', () => {
    const tags = buildHeadTags({ keywords: ['seo', 'typescript'] });
    assert.match(tags, /<meta name="keywords" content="seo, typescript">/);
  });

  it('renders an absolute canonical link unchanged', () => {
    const tags = buildHeadTags({ canonical: 'https://example.com/page' });
    assert.match(tags, /<link rel="canonical" href="https:\/\/example\.com\/page">/);
  });

  it('resolves a relative canonical against a configured origin', () => {
    const tags = buildHeadTags({ canonical: '/about' }, { origin: 'https://example.com' });
    assert.match(tags, /<link rel="canonical" href="https:\/\/example\.com\/about">/);
  });

  it('keeps a relative canonical as-is when no origin is configured', () => {
    const tags = buildHeadTags({ canonical: '/about' });
    assert.match(tags, /<link rel="canonical" href="\/about">/);
  });

  it('renders Open Graph meta tags, falling og:url back to canonical', () => {
    const tags = buildHeadTags({
      title: 'Article',
      canonical: 'https://example.com/article',
      openGraph: { title: 'OG Title', image: 'https://example.com/img.png', type: 'article' },
    });
    assert.match(tags, /<title>Article<\/title>/);
    assert.match(tags, /<meta property="og:title" content="OG Title">/);
    assert.match(tags, /<meta property="og:type" content="article">/);
    assert.match(tags, /<meta property="og:url" content="https:\/\/example\.com\/article">/);
    assert.match(tags, /<meta property="og:image" content="https:\/\/example\.com\/img\.png">/);
  });

  it('renders Twitter card meta tags', () => {
    const tags = buildHeadTags({
      title: 'Tweet',
      twitter: { card: 'summary', site: '@example' },
    });
    assert.match(tags, /<meta name="twitter:card" content="summary">/);
    assert.match(tags, /<meta name="twitter:site" content="@example">/);
  });

  it('renders alternate link tags with resolved URLs', () => {
    const tags = buildHeadTags(
      {
        alternates: [
          { hreflang: 'en', href: '/en' },
          { hreflang: 'fr', href: 'https://example.fr/page' },
        ],
      },
      { origin: 'https://example.com' },
    );
    assert.match(tags, /<link rel="alternate" href="https:\/\/example\.com\/en" hreflang="en">/);
    assert.match(tags, /<link rel="alternate" href="https:\/\/example\.fr\/page" hreflang="fr">/);
  });

  it('renders raw meta tags through the escape hatch', () => {
    const meta: PageMetadata = {
      meta: [
        { name: 'theme-color', content: '#000000' },
        { property: 'fb:app_id', content: '12345' },
        { httpEquiv: 'content-security-policy', content: "default-src 'self'" },
        // A bare tag with only content still emits (name='')
        { content: 'bare-only' },
      ],
    };
    const tags = buildHeadTags(meta);
    assert.match(tags, /<meta name="theme-color" content="#000000">/);
    assert.match(tags, /<meta property="fb:app_id" content="12345">/);
    assert.match(tags, /<meta http-equiv="content-security-policy" content="default-src 'self'">/);
    assert.match(tags, /<meta name content="bare-only">/);
  });

  it('renders JSON-LD script tags with escaping', () => {
    const node = { '@type': 'Article', headline: 'Test</script>' } as unknown as JsonLdNode;
    const prepared = jsonLd({ '@type': 'WebSite', name: 'Example Site' } as unknown as JsonLdNode);
    const tags = buildHeadTags({ title: 'Page', jsonLd: [node, prepared] });
    // Both entries are emitted as separate script tags. unhead deduplicates
    // identical content, so the two entries must be distinct for this test.
    assert.match(
      tags,
      /<script type="application\/ld\+json">.*"headline":"Test\\u003c\/script>".*<\/script>/,
    );
    assert.match(tags, /<script type="application\/ld\+json">.*"name":"Example Site".*<\/script>/);
    const scriptCount = (tags.match(/<script type="application\/ld\+json">/g) ?? []).length;
    assert.equal(scriptCount, 2);
  });

  it('merges app-level defaults underneath page metadata', () => {
    const defaults: PageMetadata = {
      title: 'Default Title',
      description: 'Default desc',
      robots: 'index, follow',
      openGraph: { siteName: 'Site' },
    };
    const page: PageMetadata = { title: 'Page Title', robots: 'noindex, nofollow' };
    const tags = buildHeadTags(page, { defaults });

    // Page title wins over default.
    assert.match(tags, /<title>Page Title<\/title>/);
    // Default description fills in where page is silent.
    assert.match(tags, /<meta name="description" content="Default desc">/);
    // Page robots wins over default.
    assert.match(tags, /<meta name="robots" content="noindex, nofollow">/);
    // Default openGraph.siteName is present (page had no openGraph).
    assert.match(tags, /<meta property="og:site_name" content="Site">/);
  });

  it('fills openGraph.siteName from runtime options', () => {
    const tags = buildHeadTags({ openGraph: { title: 'OG' } }, { siteName: 'Runtime Site' });
    assert.match(tags, /<meta property="og:site_name" content="Runtime Site">/);
  });
});

describe('injectHead', () => {
  it('returns the document unchanged when headTags is empty', () => {
    const doc = '<html><head></head><body></body></html>';
    assert.equal(injectHead(doc, ''), doc);
  });

  it('inserts tags before the closing </head>', () => {
    const result = injectHead(
      '<html><head><meta charset="utf-8"></head><body>Content</body></html>',
      '<title>Hello</title>',
    );
    assert.equal(
      result,
      '<html><head><meta charset="utf-8"><title>Hello</title></head><body>Content</body></html>',
    );
  });

  it('creates a <head> when the document has <html> but no <head>', () => {
    const result = injectHead(
      '<!DOCTYPE html><html lang="en"><body><p>Content</p></body></html>',
      '<title>Hello</title>',
    );
    assert.equal(
      result,
      '<!DOCTYPE html><html lang="en"><head><title>Hello</title></head><body><p>Content</p></body></html>',
    );
  });

  it('prepends a <head> for a bare fragment with no html element', () => {
    const result = injectHead('<p>Bare text</p>', '<title>Hello</title>');
    assert.equal(result, '<head><title>Hello</title></head><p>Bare text</p>');
  });

  it('matches </head> case-insensitively', () => {
    const result = injectHead('<HTML><HEAD></HEAD><BODY></BODY></HTML>', '<title>X</title>');
    assert.equal(result, '<HTML><HEAD><title>X</title></HEAD><BODY></BODY></HTML>');
  });
});

describe('assertOrigin', () => {
  it('returns the normalized origin for a valid http URL', () => {
    assert.equal(assertOrigin('http://example.com'), 'http://example.com');
  });

  it('returns the normalized origin for a valid https URL with port', () => {
    assert.equal(assertOrigin('https://example.com:3000'), 'https://example.com:3000');
  });

  it('rejects a non-http(s) scheme (value-free)', () => {
    assert.throws(
      () => assertOrigin('ftp://example.com'),
      (error: unknown) => {
        assert.ok(error instanceof SeoError);
        assert.equal(error.code, 'invalid_origin');
        assert.doesNotMatch(error.message, /ftp:\/\/example\.com/);
        return true;
      },
    );
  });

  it('rejects a malformed URL (value-free, does not echo input)', () => {
    assert.throws(
      () => assertOrigin('not-a-url'),
      (error: unknown) => {
        assert.ok(error instanceof SeoError);
        assert.equal(error.code, 'invalid_origin');
        assert.doesNotMatch(error.message, /not-a-url/);
        return true;
      },
    );
  });
});
