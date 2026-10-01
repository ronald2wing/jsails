/**
 * Sitemap XML generation (`jsails/content`).
 *
 * A single pure renderer producing a well-formed sitemap from a content
 * collection. One `<url>` per non-draft page, with `<loc>` and an optional
 * `<lastmod>` derived from the page's `date` frontmatter field.
 */

import { ContentError } from './errors.js';
import { escapeText } from './xml.js';
import type { ContentCollectionDescriptor, ContentPage } from './content-model.js';

/** Options for {@link renderSitemap}. */
export interface SitemapOptions<Data = Record<string, unknown>> {
  /**
   * The site's canonical public URL (e.g. `https://example.com`).
   *
   * Must be an absolute `http(s)` URL, otherwise a value-free
   * {@link ContentError} is thrown.
   */
  readonly siteUrl: string;
  /**
   * Optional URL override for a single page. When absent, each page's URL
   * is `<siteUrl>/<slug>`.
   */
  readonly urlFor?: (page: ContentPage<Data>) => string;
}

// ---------------------------------------------------------------------------
// XML escaping (same scheme as feed.ts)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Site URL validation
// ---------------------------------------------------------------------------

const ABSOLUTE_URL_RE = /^https?:\/\/[^\s<>"'{}|\\^`]+$/;

function requireSiteUrl(siteUrl: string): string {
  const trimmed = siteUrl.trim();
  if (trimmed.length === 0 || !ABSOLUTE_URL_RE.test(trimmed)) {
    throw new ContentError('invalid_site_url', 'siteUrl must be an absolute http(s) URL');
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// renderSitemap
// ---------------------------------------------------------------------------

/**
 * Render a sitemap XML string from a content collection.
 *
 * Every non-draft page becomes one `<url>` with a `<loc>` and, when the page
 * has a `date`, a `<lastmod>` in YYYY-MM-DD format. Draft pages and pages
 * with no slug are excluded.
 */
export function renderSitemap<Data = Record<string, unknown>>(
  collection: ContentCollectionDescriptor<Data>,
  options: SitemapOptions<Data>,
): string {
  const siteUrl = requireSiteUrl(options.siteUrl);
  const base = siteUrl.replace(/\/+$/, '');
  const pages = collection.getEntries({ draft: false });

  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');

  for (const page of pages) {
    const url = options.urlFor !== undefined ? options.urlFor(page) : `${base}/${page.slug}`;
    parts.push('<url>');
    parts.push(`<loc>${escapeText(url)}</loc>`);
    if (page.date !== undefined) {
      // page.date is already YYYY-MM-DD from normalizeDate in discover.ts,
      // so we emit it directly (no timezone or time component).
      parts.push(`<lastmod>${escapeText(page.date)}</lastmod>`);
    }
    parts.push('</url>');
  }

  parts.push('</urlset>');
  return parts.join('\n') + '\n';
}
