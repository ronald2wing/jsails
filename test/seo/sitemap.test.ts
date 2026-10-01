/**
 * Sitemap and robots.txt generation tests (`jsails/seo`).
 *
 * Covers {@link buildSitemapXml} (async XML generation with URL validation),
 * and {@link buildRobotsTxt} (synchronous plain-text generation). Every test
 * asserts observed output — no guesswork about the `sitemap` package's XML
 * serialization format.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildRobotsTxt, buildSitemapXml, SeoError } from '../../src/seo/index.js';
import type { RobotsOptions, SitemapEntry } from '../../src/seo/index.js';

describe('buildSitemapXml', () => {
  it('produces a valid XML urlset with loc entries', async () => {
    const entries: SitemapEntry[] = [
      { loc: 'https://example.com/' },
      { loc: 'https://example.com/about' },
    ];
    const xml = await buildSitemapXml(entries);
    assert.match(xml, /<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<urlset[^>]*>/);
    assert.match(xml, /<\/urlset>/);
    assert.match(xml, /<loc>https:\/\/example\.com\/<\/loc>/);
    assert.match(xml, /<loc>https:\/\/example\.com\/about<\/loc>/);
  });

  it('includes lastmod when provided', async () => {
    const xml = await buildSitemapXml([
      { loc: 'https://example.com/', lastmod: '2024-01-15T10:30:00.000Z' },
    ]);
    assert.match(xml, /<lastmod>2024-01-15T10:30:00\.000Z<\/lastmod>/);
  });

  it('throws for an empty entry set (the sitemap package rejects an unwritten stream)', async () => {
    await assert.rejects(buildSitemapXml([]), /ended the stream without writing/);
  });

  it('rejects a non-absolute loc (value-free)', async () => {
    await assert.rejects(
      buildSitemapXml([{ loc: '/relative' }, { loc: 'https://example.com/' }]),
      (error: unknown) => {
        assert.ok(error instanceof SeoError);
        assert.equal(error.code, 'invalid_sitemap_url');
        assert.doesNotMatch(error.message, /\/relative/);
        return true;
      },
    );
  });

  it('rejects a non-URL-like loc (value-free)', async () => {
    await assert.rejects(buildSitemapXml([{ loc: 'not-a-url' }]), (error: unknown) => {
      assert.ok(error instanceof SeoError);
      assert.equal(error.code, 'invalid_sitemap_url');
      assert.doesNotMatch(error.message, /not-a-url/);
      return true;
    });
  });
});

describe('buildRobotsTxt', () => {
  it('produces a permissive document with defaults', () => {
    const txt = buildRobotsTxt();
    assert.equal(txt, 'User-agent: *\n');
  });

  it('uses a custom user-agent when provided', () => {
    const txt = buildRobotsTxt({ userAgent: 'Googlebot' });
    assert.equal(txt, 'User-agent: Googlebot\n');
  });

  it('includes Allow and Disallow rules', () => {
    const options: RobotsOptions = {
      allow: ['/public/', '/assets/'],
      disallow: ['/admin/', '/api/'],
    };
    const txt = buildRobotsTxt(options);
    assert.match(txt, /^User-agent: \*\n/);
    assert.match(txt, /Allow: \/public\//);
    assert.match(txt, /Allow: \/assets\//);
    assert.match(txt, /Disallow: \/admin\//);
    assert.match(txt, /Disallow: \/api\//);
    // Trailing newline.
    assert.ok(txt.endsWith('\n'));
  });

  it('includes a sitemap directive', () => {
    const txt = buildRobotsTxt({ sitemap: 'https://example.com/sitemap.xml' });
    assert.match(txt, /Sitemap: https:\/\/example\.com\/sitemap\.xml/);
  });

  it('includes a host directive', () => {
    const txt = buildRobotsTxt({ host: 'example.com' });
    assert.match(txt, /Host: example\.com/);
  });

  it('rejects a sitemap directive that is not an absolute URL (value-free)', () => {
    assert.throws(
      () => buildRobotsTxt({ sitemap: '/sitemap.xml' }),
      (error: unknown) => {
        assert.ok(error instanceof SeoError);
        assert.equal(error.code, 'invalid_robots');
        assert.doesNotMatch(error.message, /\/sitemap\.xml/);
        return true;
      },
    );
  });

  it('rejects directive values containing line breaks (value-free)', () => {
    assert.throws(
      () => buildRobotsTxt({ userAgent: 'Bad\nAgent' }),
      (error: unknown) => {
        assert.ok(error instanceof SeoError);
        assert.equal(error.code, 'invalid_robots');
        assert.doesNotMatch(error.message, /Bad/);
        return true;
      },
    );
    assert.throws(
      () => buildRobotsTxt({ disallow: ['/safe', '/bad\rpath'] }),
      (error: unknown) => {
        assert.ok(error instanceof SeoError);
        assert.equal(error.code, 'invalid_robots');
        assert.doesNotMatch(error.message, /bad.*path/);
        return true;
      },
    );
  });

  it('produces the full set of directives in order', () => {
    const options: RobotsOptions = {
      userAgent: 'Googlebot',
      allow: ['/public/'],
      disallow: ['/admin/'],
      sitemap: 'https://example.com/sitemap.xml',
      host: 'example.com',
    };
    const txt = buildRobotsTxt(options);
    assert.equal(
      txt,
      'User-agent: Googlebot\nAllow: /public/\nDisallow: /admin/\nSitemap: https://example.com/sitemap.xml\nHost: example.com\n',
    );
  });
});
