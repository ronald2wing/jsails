/**
 * Shared types for the content layer (`jsails/content`).
 *
 * A content collection is a directory tree of markdown files, discovered once
 * per process and reduced to a frozen, deterministic graph. The types here are
 * split from the runtime modules so `discoverContent` (the low-level primitive)
 * and `defineContentCollection` (the typed descriptor) share one vocabulary.
 */

/** A heading extracted from a rendered page, used to build a table of contents. */
export interface TocHeading {
  readonly depth: number;
  readonly id: string;
  readonly text: string;
}

/**
 * One discovered markdown page.
 *
 * `data` is the raw frontmatter object (plus any schema validation performed by
 * `defineContentCollection`). `section` is the first path segment under the
 * content directory (empty string for a top-level file). `order` defaults to
 * `Infinity` when the frontmatter omits it.
 */
export interface ContentPage<Data = Record<string, unknown>> {
  readonly slug: string;
  readonly section: string;
  readonly title: string;
  readonly order: number;
  readonly html: string;
  readonly toc: readonly TocHeading[];
  readonly draft: boolean;
  readonly tags: readonly string[];
  readonly date?: string;
  readonly excerpt?: string;
  readonly data: Data;
}

/** A single entry in the search corpus (plain text per non-draft page). */
export interface SearchRecord {
  readonly slug: string;
  readonly title: string;
  readonly text: string;
}

/** The neighbours of a page in the collection's deterministic order. */
export interface PrevNext {
  readonly prev: string | null;
  readonly next: string | null;
}

/**
 * A frozen, deterministic graph of every `.md` file under one directory.
 *
 * `pages` includes drafts (they stay discoverable); `prevNext` and `search`
 * exclude drafts so they never appear in navigation or the search corpus.
 */
export interface ContentCollection<Data = Record<string, unknown>> {
  readonly pages: readonly ContentPage<Data>[];
  readonly bySlug: ReadonlyMap<string, ContentPage<Data>>;
  readonly prevNext: ReadonlyMap<string, PrevNext>;
  readonly search: readonly SearchRecord[];
}

/** Options for {@link discoverContent}. */
export interface ContentOptions {
  /**
   * Directory for the incremental on-disk cache. Defaults to `.content-cache`
   * resolved against the process working directory.
   */
  readonly cacheDir?: string;
}

/** Filter for {@link ContentCollectionDescriptor.getEntries}. */
export interface EntryFilter {
  /** Only pages carrying this tag. */
  readonly tag?: string;
  /** Only pages in this section (first path segment). */
  readonly section?: string;
  /** Only draft (`true`) or non-draft (`false`) pages. */
  readonly draft?: boolean;
}

/**
 * A typed, schema-aware content collection descriptor.
 *
 * Produced by {@link defineContentCollection}. It adds the derived helpers over
 * the low-level {@link ContentCollection}: `getEntry` / `getEntries` look up
 * typed pages, `getStaticPaths` enumerates non-draft params for a page module's
 * `getStaticPaths`, and `prevNext` returns a page's navigation neighbours.
 */
export interface ContentCollectionDescriptor<Data = Record<string, unknown>> {
  readonly pages: readonly ContentPage<Data>[];
  readonly search: readonly SearchRecord[];
  getEntry(slug: string): ContentPage<Data> | undefined;
  getEntries(filter?: EntryFilter): readonly ContentPage<Data>[];
  /**
   * Static-path parameter records for every non-draft page. The key is the
   * `[param]` name in the collection's `route` (default `[slug]`, so each
   * record is `{ slug: string }`).
   */
  getStaticPaths(): readonly { slug: string }[];
  prevNext(slug: string): PrevNext | undefined;
}
