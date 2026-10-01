/**
 * Blog assembly helpers (`jsails/content`).
 *
 * Convenience functions over a content collection and taxonomy so an app can
 * build a blog index, tag cloud, and common derived values without
 * hand-assembling the same three lines every time.
 *
 * Every function is pure: no I/O, no connection, no mutation.
 */

import type { ContentCollectionDescriptor, ContentPage } from './content-model.js';
import { htmlToText } from './render.js';
import type { Taxonomy, TaxonomyTerm } from './taxonomy.js';

// ---------------------------------------------------------------------------
// blogIndex
// ---------------------------------------------------------------------------

/** Options for {@link blogIndex}. */
export interface BlogIndexOptions<Data = Record<string, unknown>> {
  /** Max number of pages to return. Defaults to all non-draft pages. */
  readonly limit?: number;
  /** Only pages carrying this tag. Defaults to all non-draft pages. */
  readonly tag?: string;
  /**
   * Optional URL override for deriving page URLs. When absent, URLs are
   * `/` + `slug`.
   */
  readonly urlFor?: (page: ContentPage<Data>) => string;
}

/**
 * Return the collection's non-draft pages sorted newest-first (by `date`
 * descending, then `order` ascending, then title/slug for determinism).
 *
 * This is a convenience over `collection.getEntries({ draft: false })`
 * so a page module's `load` can call `blogIndex(await blog, { limit: 10 })`
 * without sorting or filtering inline.
 */
export function blogIndex<Data = Record<string, unknown>>(
  collection: ContentCollectionDescriptor<Data>,
  options?: BlogIndexOptions<Data>,
): readonly ContentPage<Data>[] {
  const pages = collection.getEntries({ draft: false, tag: options?.tag });
  const sorted = newestFirst(pages);
  if (options?.limit !== undefined) return sorted.slice(0, options.limit);
  return sorted;
}

// ---------------------------------------------------------------------------
// tagIndex
// ---------------------------------------------------------------------------

/**
 * Return the taxonomy's terms sorted by count descending, then term
 * ascending. This is the canonical sort for a tag-cloud or tag-index page:
 * the most common term first, with alphabetical tiebreaking.
 */
export function tagIndex<Data = Record<string, unknown>>(
  taxonomy: Taxonomy<Data>,
): readonly TaxonomyTerm<Data>[] {
  // The taxonomy's terms are already sorted alphabetically (from defineTaxonomy).
  // We sort by count desc, then preserve alphabetical order within ties.
  return [...taxonomy.terms].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    if (a.term < b.term) return -1;
    if (a.term > b.term) return 1;
    return 0;
  });
}

// ---------------------------------------------------------------------------
// pageUrl
// ---------------------------------------------------------------------------

/** Options for {@link pageUrl}. */
export interface PageUrlOptions<Data = Record<string, unknown>> {
  /**
   * Optional override that receives the page and returns its full URL.
   * When absent, the URL is `'/' + page.slug`.
   */
  readonly urlFor?: (page: ContentPage<Data>) => string;
}

/**
 * Derive the canonical URL for a content page.
 *
 * The default URL is `'/' + page.slug` (e.g. `/blog/hello`). Pass an
 * `urlFor` callback to override this (e.g. prepend a site host for feeds).
 */
export function pageUrl<Data = Record<string, unknown>>(
  page: ContentPage<Data>,
  options?: PageUrlOptions<Data>,
): string {
  if (options?.urlFor !== undefined) return options.urlFor(page);
  return `/${page.slug}`;
}

// ---------------------------------------------------------------------------
// readingTime
// ---------------------------------------------------------------------------

const WORDS_PER_MINUTE = 200;

/**
 * Estimate reading time in whole minutes from a page's rendered HTML.
 *
 * Strips HTML tags, counts words, and divides by 200 wpm. The result is
 * always at least 1. Returns 1 for an empty or whitespace-only body so
 * "0 min" never appears in a UI.
 */
export function readingTime(page: ContentPage): number {
  const text = htmlToText(page.html);
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  const minutes = Math.ceil(words / WORDS_PER_MINUTE);
  return Math.max(1, minutes);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
