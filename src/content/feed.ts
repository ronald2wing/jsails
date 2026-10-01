/**
 * RSS/Atom feed generation (`jsails/content`).
 *
 * Two pure renderers that produce well-formed XML strings from a content
 * collection. Both escape text/attribute values so raw `&`/`<`/`>`/`"` in
 * user-authored content never corrupts the XML structure.
 *
 * The page URL derivation is shared with {@link ./blog.ts} through the
 * optional `urlFor` callback; when absent the default is `/<slug>`.
 */

import { ContentError } from './errors.js';
import { escapeAttr, escapeText } from './xml.js';
import type { ContentCollectionDescriptor, ContentPage } from './content-model.js';

// ---------------------------------------------------------------------------
// Shared options
// ---------------------------------------------------------------------------

/** Options shared by {@link renderRssFeed} and {@link renderAtomFeed}. */
export interface FeedOptions<Data = Record<string, unknown>> {
  /** Feed title (the `<title>` / `<channel><title>`). */
  readonly title: string;
  /** Optional feed description. */
  readonly description?: string;
  /**
   * The site's canonical public URL (e.g. `https://example.com`).
   *
   * Must be an absolute `http(s)` URL, otherwise a value-free
   * {@link ContentError} is thrown.
   */
  readonly siteUrl: string;
  /**
   * Optional feed URL (the URL where this feed lives). Defaults to
   * `siteUrl + '/feed.xml'` (RSS) or `siteUrl + '/atom.xml'` (Atom).
   */
  readonly feedUrl?: string;
  /**
   * Max number of non-draft pages to include. Defaults to all non-draft
   * pages, newest first by `date` then `order`.
   */
  readonly limit?: number;
  /**
   * Optional URL override for a single page. When absent, each page's URL
   * is `<siteUrl>/<slug>`.
   */
  readonly urlFor?: (page: ContentPage<Data>) => string;
}

// ---------------------------------------------------------------------------
// Page ordering and filtering
// ---------------------------------------------------------------------------

/**
 * Sort non-draft pages newest-first: `date` descending, then `order`
 * ascending, then `title` ascending, then `slug` ascending.
 */
function newestFirst<Data>(pages: readonly ContentPage<Data>[]): ContentPage<Data>[] {
  return [...pages].sort((a, b) => {
    const aDate = a.date ?? '';
    const bDate = b.date ?? '';
    if (aDate > bDate) return -1;
    if (aDate < bDate) return 1;
    if (a.order !== b.order) return a.order - b.order;
    if (a.title < b.title) return -1;
    if (a.title > b.title) return 1;
    if (a.slug < b.slug) return -1;
    if (a.slug > b.slug) return 1;
    return 0;
  });
}

function feedPages<Data>(
  collection: ContentCollectionDescriptor<Data>,
  options: FeedOptions<Data>,
): ContentPage<Data>[] {
  return newestFirst(collection.getEntries({ draft: false })).slice(0, options.limit);
}

// ---------------------------------------------------------------------------
// Page URL derivation
// ---------------------------------------------------------------------------

function pageUrl<Data>(page: ContentPage<Data>, options: FeedOptions<Data>): string {
  if (options.urlFor) return options.urlFor(page);
  return `${options.siteUrl.replace(/\/+$/, '')}/${page.slug}`;
}

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
// XML escaping (shared with sitemap.ts via xml.ts)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// RFC 822 / RFC 2822 datetime (for RSS pubDate)
// ---------------------------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Format a YYYY-MM-DD date string as an RFC 822 datetime string.
 * Falls back to the epoch when `date` is absent or unparseable.
 */
function toRfc822Date(date: string | undefined): string {
  if (!date) return 'Thu, 01 Jan 1970 00:00:00 +0000';
  const parsed = new Date(date + 'T00:00:00Z');
  if (isNaN(parsed.getTime())) return 'Thu, 01 Jan 1970 00:00:00 +0000';
  const day = WEEKDAYS[parsed.getUTCDay()];
  const d = String(parsed.getUTCDate()).padStart(2, '0');
  const month = MONTHS[parsed.getUTCMonth()];
  const y = parsed.getUTCFullYear();
  const hh = String(parsed.getUTCHours()).padStart(2, '0');
  const mm = String(parsed.getUTCMinutes()).padStart(2, '0');
  const ss = String(parsed.getUTCSeconds()).padStart(2, '0');
  return `${day}, ${d} ${month} ${y} ${hh}:${mm}:${ss} +0000`;
}

// ---------------------------------------------------------------------------
// ISO 8601 datetime (for Atom updated)
// ---------------------------------------------------------------------------

/**
 * Format a YYYY-MM-DD date string as an ISO 8601 datetime string.
 * Falls back to the epoch when `date` is absent or unparseable.
 */
function toIso8601(date: string | undefined): string {
  if (!date) return '1970-01-01T00:00:00Z';
  const parsed = new Date(date + 'T00:00:00Z');
  if (isNaN(parsed.getTime())) return '1970-01-01T00:00:00Z';
  return parsed.toISOString();
}

// ---------------------------------------------------------------------------
// RSS 2.0
// ---------------------------------------------------------------------------

/**
 * Render an RSS 2.0 feed XML string from a content collection.
 *
 * Each non-draft page becomes an `<item>` with `<title>`, `<link>`,
 * `<description>` (the page's `excerpt`), `<pubDate>`, and `<guid>` (the page
 * URL serving as the permalink guid).
 */
export function renderRssFeed<Data = Record<string, unknown>>(
  collection: ContentCollectionDescriptor<Data>,
  options: FeedOptions<Data>,
): string {
  const siteUrl = requireSiteUrl(options.siteUrl);
  const feedUrl =
    options.feedUrl !== undefined ? options.feedUrl : `${siteUrl.replace(/\/+$/, '')}/feed.xml`;
  const pages = feedPages(collection, options);

  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
  parts.push('<channel>');
  parts.push(`<title>${escapeText(options.title)}</title>`);
  parts.push(`<link>${escapeText(siteUrl)}</link>`);
  if (options.description !== undefined) {
    parts.push(`<description>${escapeText(options.description)}</description>`);
  }
  // Atom self-link for feed readers that discover from the channel.
  parts.push(`<atom:link href="${escapeAttr(feedUrl)}" rel="self" type="application/rss+xml"/>`);

  for (const page of pages) {
    const url = pageUrl(page, options);
    parts.push('<item>');
    parts.push(`<title>${escapeText(page.title)}</title>`);
    parts.push(`<link>${escapeText(url)}</link>`);
    if (page.excerpt !== undefined) {
      parts.push(`<description>${escapeText(page.excerpt)}</description>`);
    }
    parts.push(`<pubDate>${toRfc822Date(page.date)}</pubDate>`);
    parts.push(`<guid isPermaLink="true">${escapeText(url)}</guid>`);
    parts.push('</item>');
  }

  parts.push('</channel>');
  parts.push('</rss>');
  return parts.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Atom 1.0
// ---------------------------------------------------------------------------

/**
 * Render an Atom 1.0 feed XML string from a content collection.
 *
 * Each non-draft page becomes an `<entry>` with `<title>`, `<link>`,
 * `<summary>` (the page's `excerpt`), `<updated>`, and `<id>`.
 */
export function renderAtomFeed<Data = Record<string, unknown>>(
  collection: ContentCollectionDescriptor<Data>,
  options: FeedOptions<Data>,
): string {
  const siteUrl = requireSiteUrl(options.siteUrl);
  const feedUrl =
    options.feedUrl !== undefined ? options.feedUrl : `${siteUrl.replace(/\/+$/, '')}/atom.xml`;
  const pages = feedPages(collection, options);
  const updated = pages.length > 0 ? toIso8601(pages[0]?.date) : toIso8601(undefined);

  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<feed xmlns="http://www.w3.org/2005/Atom">');
  parts.push(`<title>${escapeText(options.title)}</title>`);
  if (options.description !== undefined) {
    parts.push(`<subtitle>${escapeText(options.description)}</subtitle>`);
  }
  parts.push(`<link href="${escapeAttr(feedUrl)}" rel="self"/>`);
  parts.push(`<link href="${escapeAttr(siteUrl)}"/>`);
  parts.push(`<id>${escapeText(feedUrl)}</id>`);
  parts.push(`<updated>${updated}</updated>`);

  for (const page of pages) {
    const url = pageUrl(page, options);
    parts.push('<entry>');
    parts.push(`<title>${escapeText(page.title)}</title>`);
    parts.push(`<link href="${escapeAttr(url)}"/>`);
    parts.push(`<id>${escapeText(url)}</id>`);
    parts.push(`<updated>${toIso8601(page.date)}</updated>`);
    if (page.excerpt !== undefined) {
      parts.push(`<summary>${escapeText(page.excerpt)}</summary>`);
    }
    parts.push('</entry>');
  }

  parts.push('</feed>');
  return parts.join('\n') + '\n';
}
