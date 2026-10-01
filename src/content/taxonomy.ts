/**
 * Content taxonomy (`jsails/content`).
 *
 * `defineTaxonomy` groups a content collection's non-draft pages by a frontmatter
 * field (e.g. `tags`) and auto-generates term pages plus term lists — one term
 * per unique value, with a URL-safe slug, a deterministically sorted term list,
 * and static-path enumeration for a page module's `getStaticPaths`.
 *
 * Hugo's best idea, now typed and validated: a tag-index page at `/tags/[term]`
 * requires only one call, no hand-written enumeration, and every term is a typed
 * subset of the collection's pages.
 */

import { ContentError } from './errors.js';
import type {
  ContentCollection,
  ContentCollectionDescriptor,
  ContentPage,
} from './content-model.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One term in a taxonomy, grouping every non-draft page that carries it. */
export interface TaxonomyTerm<Data = Record<string, unknown>> {
  /** The raw, untransformed field value (one unique term). */
  readonly term: string;
  /** URL-safe slug derived from the term for use in route params. */
  readonly slug: string;
  /** Number of non-draft pages carrying this term. */
  readonly count: number;
  /** Every non-draft page whose frontmatter includes this term, in collection order. */
  readonly pages: readonly ContentPage<Data>[];
}

/**
 * A frozen, deterministic taxonomy over a content collection.
 *
 * Terms are sorted per the configured `order` (alphabetically by `term` by
 * default). Draft pages are excluded from every term, matching Slice 1's
 * nav/search exclusion.
 */
export interface Taxonomy<Data = Record<string, unknown>> {
  /** Every term, sorted per the configured `order` (alphabetical by default). */
  readonly terms: readonly TaxonomyTerm<Data>[];
  /** The route pattern this taxonomy was defined with (e.g. `'/tags/[term]'`). */
  readonly route: string;
  /** Look up a term by its URL-safe slug. Returns `undefined` when not found. */
  getTerm(slug: string): TaxonomyTerm<Data> | undefined;
  /**
   * Static-path parameter records for every term. The key is the `[param]` name
   * in the taxonomy's `route` (default `term`, so each record is `{ term: string }`).
   */
  getStaticPaths(): readonly { term: string }[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Sort order for a taxonomy's term list. */
export type TaxonomyOrder = 'alpha' | 'weight' | 'count';

/** Options for {@link defineTaxonomy}. */
export interface DefineTaxonomyOptions<Data = Record<string, unknown>> {
  /** A content collection (from {@link discoverContent}) or typed descriptor
   * (from {@link defineContentCollection}). Both expose `.pages`, so either works. */
  readonly collection: ContentCollection<Data> | ContentCollectionDescriptor<Data>;
  /** The frontmatter field to group by (e.g. `'tags'`). Must be a non-empty string. */
  readonly field: string;
  /**
   * Route pattern whose single `[param]` token names the static-path key.
   * Defaults to `'/tags/[term]'` (each static path is `{ term: string }`).
   */
  readonly route?: string;
  /**
   * Sort order for the term list. `'alpha'` (default) keeps the alphabetical
   * sort by `term`; `'count'` sorts by descending page count; `'weight'` sorts
   * by ascending minimum page weight (see {@link DefineTaxonomyOptions.weightField}).
   * Every non-alpha order tiebreaks alphabetically on `term`.
   */
  readonly order?: TaxonomyOrder;
  /**
   * Frontmatter field read from `page.data` to weight a term when
   * `order: 'weight'`. A term's weight is the minimum value across its pages;
   * when unset, `page.order` is used instead.
   */
  readonly weightField?: string;
  /**
   * Frontmatter field read from `page.data` as a per-term stable slug. The
   * first non-empty string value in collection order is used verbatim (no
   * `toSlug`); otherwise `toSlug(term)` is the fallback.
   */
  readonly slugField?: string;
}

// ---------------------------------------------------------------------------
// defineTaxonomy
// ---------------------------------------------------------------------------

/**
 * Define a taxonomy over a content collection.
 *
 * Groups every non-draft page by the named frontmatter field, normalises the
 * values within each entry (string or array, trimmed, empties dropped,
 * deduplicated), and produces a frozen, deterministic term list.
 *
 * ```ts
 * const tags = defineTaxonomy({ collection: await blog, field: 'tags' });
 *
 * // In pages/tags/[term].tsx:
 * export function getStaticPaths() {
 *   return tags.getStaticPaths(); // [{ term: 'api' }, { term: 'docs' }, ...]
 * }
 *
 * export async function load({ params }) {
 *   const term = tags.getTerm(params.term);
 *   return { term, pages: term?.pages ?? [] };
 * }
 * ```
 *
 * @throws {@link ContentError} for a malformed `field` or `route` (value-free).
 */
export function defineTaxonomy<Data = Record<string, unknown>>(
  options: DefineTaxonomyOptions<Data>,
): Taxonomy<Data> {
  const { collection, field } = options;
  const route = options.route ?? '/tags/[term]';
  const order = options.order ?? 'alpha';
  const weightField = options.weightField;
  const slugField = options.slugField;

  // --- Validate inputs ------------------------------------------------------
  if (typeof field !== 'string' || field.trim().length === 0) {
    throw new ContentError('invalid_field', 'Taxonomy field must be a non-empty string');
  }
  if (typeof route !== 'string' || route.length === 0) {
    throw new ContentError('invalid_route', 'Taxonomy route must be a non-empty string');
  }
  if (order !== 'alpha' && order !== 'weight' && order !== 'count') {
    throw new ContentError('invalid_order', 'Taxonomy order must be alpha, weight, or count');
  }
  if (
    weightField !== undefined &&
    (typeof weightField !== 'string' || weightField.trim().length === 0)
  ) {
    throw new ContentError('invalid_field', 'Taxonomy weightField must be a non-empty string');
  }
  if (slugField !== undefined && (typeof slugField !== 'string' || slugField.trim().length === 0)) {
    throw new ContentError('invalid_field', 'Taxonomy slugField must be a non-empty string');
  }

  const paramMatch = route.match(/\[([A-Za-z0-9_-]+)\]/);
  if (!paramMatch || paramMatch[1] === undefined) {
    throw new ContentError('invalid_route', 'Taxonomy route must contain a [param] token');
  }
  const paramName: string = paramMatch[1];

  // Guard against a collection that has no `pages` (trusted callers never hit
  // this; the check is a value-free fail-closed for corrupted in-memory state).
  const pages = (collection as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) {
    throw new ContentError('invalid_collection', 'Taxonomy collection must have pages');
  }

  // --- Group non-draft pages by field value ---------------------------------
  const termMap = new Map<string, ContentPage<Data>[]>();

  for (const page of pages as readonly ContentPage<Data>[]) {
    if (page.draft) continue;

    const values = normalizeTermValues((page.data as Record<string, unknown>)[field]);
    for (const value of values) {
      const existing = termMap.get(value);
      if (existing) {
        existing.push(page);
      } else {
        termMap.set(value, [page]);
      }
    }
  }

  // --- Build the term list --------------------------------------------------
  const terms: TaxonomyTerm<Data>[] = [];
  for (const [term, termPages] of termMap) {
    terms.push({
      term,
      slug: resolveSlug(term, termPages, slugField),
      count: termPages.length,
      pages: Object.freeze(termPages),
    });
  }

  // Deterministic sort, defaulting to alphabetical by term.
  sortTerms(terms, order, weightField);

  // Freeze each term descriptor after sorting so `terms` is fully immutable.
  for (const t of terms) Object.freeze(t);

  // --- Build slug→term lookup -----------------------------------------------
  // When two different terms produce the same slug (e.g. "HELLO" and "hello"),
  // the first in sorted order wins for `getTerm`. This is a v1 limit: mixed-case
  // duplicates in the same content directory are not expected in practice.
  const bySlug = new Map<string, TaxonomyTerm<Data>>();
  for (const t of terms) {
    if (!bySlug.has(t.slug)) bySlug.set(t.slug, t);
  }

  // --- Assemble the frozen descriptor ---------------------------------------
  const taxonomy: Taxonomy<Data> = {
    terms: Object.freeze(terms),
    route,
    getTerm(slug: string): TaxonomyTerm<Data> | undefined {
      return bySlug.get(slug);
    },
    getStaticPaths(): readonly { term: string }[] {
      const paths: { term: string }[] = [];
      for (const t of terms) {
        // The runtime key is the param name from the route pattern; TypeScript
        // sees `{ term: string }` (the default key). This matches the same
        // pattern used by `ContentCollectionDescriptor.getStaticPaths`, where
        // the return type is always `{ slug: string }[]` regardless of the
        // derived param name.
        paths.push({ [paramName]: t.slug } as unknown as { term: string });
      }
      return paths;
    },
  };

  return Object.freeze(taxonomy);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compare two strings alphabetically (UTF-16 code-unit order), the same
 * comparison used for the default term sort.
 */
function compareAlpha(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The weight of a single page for `order: 'weight'`.
 *
 * When `weightField` is given it is read from the page's frontmatter: a finite
 * number is that number, anything else (missing, string, NaN, Infinity) is
 * `Infinity` so it sorts last. Without a `weightField` the page's own `order`
 * is the weight.
 */
function pageWeight<Data>(page: ContentPage<Data>, weightField: string | undefined): number {
  if (weightField === undefined) return page.order;
  const value = (page.data as Record<string, unknown>)[weightField];
  return typeof value === 'number' && Number.isFinite(value) ? value : Infinity;
}

/**
 * The weight of a term for `order: 'weight'`: the minimum page weight across
 * its pages, so a term sorts by its earliest/lowest-ranked page.
 */
function termWeight<Data>(term: TaxonomyTerm<Data>, weightField: string | undefined): number {
  let min = Infinity;
  for (const page of term.pages) {
    const weight = pageWeight(page, weightField);
    if (weight < min) min = weight;
  }
  return min;
}

/**
 * Sort the term list in place for the configured order. Every non-alpha order
 * ends with an alphabetical tiebreak on `term`, so the result is deterministic.
 */
function sortTerms<Data>(
  terms: TaxonomyTerm<Data>[],
  order: TaxonomyOrder,
  weightField: string | undefined,
): void {
  if (order === 'alpha') {
    terms.sort((a, b) => compareAlpha(a.term, b.term));
    return;
  }
  if (order === 'count') {
    terms.sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return compareAlpha(a.term, b.term);
    });
    return;
  }
  // `order === 'weight'`.
  terms.sort((a, b) => {
    const aWeight = termWeight(a, weightField);
    const bWeight = termWeight(b, weightField);
    if (aWeight !== bWeight) return aWeight - bWeight;
    return compareAlpha(a.term, b.term);
  });
}

/**
 * Resolve a term's slug. When `slugField` is set, the first page in collection
 * order whose `data[slugField]` is a non-empty string (after trimming) supplies
 * the slug verbatim; otherwise `toSlug(term)` is the fallback.
 */
function resolveSlug<Data>(
  term: string,
  termPages: readonly ContentPage<Data>[],
  slugField: string | undefined,
): string {
  if (slugField !== undefined) {
    for (const page of termPages) {
      const value = (page.data as Record<string, unknown>)[slugField];
      if (typeof value === 'string' && value.trim().length > 0) return value;
    }
  }
  return toSlug(term);
}

/**
 * Extract and normalise term values from a frontmatter field.
 *
 * Accepts a string or a string[]; trims every value, drops empties, and
 * deduplicates within the entry. Non-string array elements are silently
 * dropped so a malformed tag value in mixed-typed YAML never surfaces.
 */
function normalizeTermValues(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/**
 * Convert a term to a URL-safe slug.
 *
 * Lowercase, replace every non-alphanumeric character with a dash, collapse
 * consecutive dashes, then trim leading and trailing dashes. The result is
 * never empty for a non-empty input because at least one alphanumeric
 * character must remain after the transform.
 */
function toSlug(term: string): string {
  return term
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}
