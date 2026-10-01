---
title: Content
order: 11
section: Building
---

# Content

The `jsails/content` subpath is the server-only Markdown/SSG content layer. It
discovers `.md` files from one directory tree, renders them to HTML with Shiki
syntax highlighting, derives a search corpus and previous/next navigation, and
provides taxonomies, section trees, version manifests, feeds, and sitemaps —
everything a docs site or blog needs from its content files.

It is deliberately **not** re-exported from the root `jsails` entry and is never
part of the browser-safe graph: it imports `node:fs`, `node:path`, `gray-matter`,
`markdown-it`, and `shiki`.

## The collection model

A content collection is a frozen, deterministic graph of every `.md` file under
one directory, rendered once per process (memoized per directory). Rendering
results are cached incrementally on disk; an unchanged file skips re-parsing
and re-highlighting. Symlinks are rejected at any depth.

```ts
import { defineContentCollection } from 'jsails/content';
import { z } from 'zod';

const docs = defineContentCollection({
  dir: 'content/docs',
  schema: z.object({
    title: z.string().min(1),
    description: z.string().optional(),
  }),
});
```

### Frontmatter

Every `.md` file must have a non-empty `title` in its frontmatter — a missing or
empty `title` throws a `ContentError` (`missing_required_field`). Optional fields:

| Field    | Type               | Default     | Behaviour                                      |
| -------- | ------------------ | ----------- | ---------------------------------------------- |
| `title`  | `string`           | **required** | Canonical page title.                          |
| `slug`   | `string`           | derived     | Override the filename-derived slug.            |
| `order`  | `number`           | `Infinity`  | Sort position (lower first).                   |
| `date`   | `string` or `Date` | —           | Publication date (ISO YYYY-MM-DD preferred).   |
| `draft`  | `boolean`          | —           | Exclude from navigation, search, and static paths. |
| `tags`   | `string[]`         | `[]`        | Taxonomy values for grouping.                  |
| `section`| —                  | derived     | First path segment under the content directory (read-only; set by file location). |

The frontmatter `title` is the canonical title; the body's leading `# Title` H1
is stripped at render time so it does not duplicate the page's `<h1>`.

### `ContentPage`

A discovered page is a frozen object:

```ts
interface ContentPage {
  readonly slug: string;         // filename-derived slug
  readonly section: string;      // first path segment ('' for top-level)
  readonly title: string;        // from frontmatter
  readonly order: number;        // from frontmatter or Infinity
  readonly html: string;         // rendered HTML with Shiki highlighting
  readonly toc: readonly { depth: number; id: string; text: string }[];
  readonly draft: boolean;       // from frontmatter
  readonly tags: readonly string[];
  readonly date?: string;        // YYYY-MM-DD
  readonly excerpt?: string;     // first paragraph text, max 200 chars
  readonly data: Record<string, unknown>; // raw frontmatter (typed when schema is given)
}
```

### `ContentCollectionDescriptor`

`defineContentCollection` returns a `Promise<ContentCollectionDescriptor>` with
typed pages and derived helpers:

```ts
const collection = await docs;

// Look up a single page.
const page = collection.getEntry('models');

// Filter pages by tag, section, or draft status.
const published = collection.getEntries({ draft: false });
const tagged = collection.getEntries({ tag: 'advanced' });

// Static-path enumeration for a page module's getStaticPaths.
export function getStaticPaths() {
  return collection.getStaticPaths();
}

// Previous/next navigation neighbours.
const { prev, next } = collection.prevNext('models');
```

Pages include drafts in `pages` and `getEntry` (they stay discoverable);
`getStaticPaths`, `prevNext`, and the `search` corpus exclude drafts.

### Search corpus

`collection.search` is a `readonly SearchRecord[]` — each entry carries `slug`,
`title`, and `text` (plain-text extraction of the rendered HTML, bounded to 4000
characters per page). Draft pages are excluded.

## `discoverContent`

```ts
import { discoverContent } from 'jsails/content';

const raw = await discoverContent('content/blog', { cacheDir: '.content-cache' });
// => ContentCollection (frozen, no schema validation)
```

The low-level primitive `defineContentCollection` wraps. It discovers every
`.md` file under the directory, requires a `title` frontmatter field, sorts by
`order` → `title` → `slug`, and returns a frozen `ContentCollection` with
`pages`, `bySlug`, `prevNext`, and `search`. Memoized per resolved directory.
The `cacheDir` option sets the incremental cache location (default
`.content-cache`).

## Taxonomies

### `defineTaxonomy`

Groups a collection's non-draft pages by a frontmatter field (e.g. `tags`) and
auto-generates term pages plus static-path enumeration.

```ts
import { defineTaxonomy } from 'jsails/content';

const tags = defineTaxonomy(docs, {
  field: 'tags',
  route: '/tags/[term]',
  order: 'count',  // 'count' | 'alphabetical' | 'custom'
});
```

Each `TaxonomyTerm` carries `term` (the raw value), `slug` (URL-safe), `count`
(number of pages), and `pages` (the matching non-draft pages in collection
order). `taxonomy.getTerm(slug)` looks up a term; `taxonomy.getStaticPaths()`
enumerates every term for a page module's `getStaticPaths`.

The route pattern accepts exactly one `[param]` token (default `[term]`); draft
pages are excluded from every term.

### `defineTaxonomies`

Defines several taxonomies over one collection in a single call.

```ts
import { defineTaxonomies } from 'jsails/content';

const taxonomies = defineTaxonomies({
  collection: docs,
  taxonomies: [
    { name: 'tags', field: 'tags', route: '/tags/[term]' },
    { name: 'categories', field: 'category', route: '/categories/[category]' },
  ],
});

taxonomies.get('tags').getStaticPaths();
```

Each taxonomy is validated and frozen through the same `defineTaxonomy` code
path. `getStaticPaths` concatenates terms from every taxonomy in declaration
order with no dedup across taxonomies.

## `defineSections`

Derives a pure, frozen section tree from page slugs. No I/O — slugs alone
determine the hierarchy. Ghost nodes fill intermediate segments; index pages
(`<section>/index.md`) are detected deterministically.

```ts
import { defineSections } from 'jsails/content';

const tree = defineSections(docs);
const section = tree.getSection('extending');
const crumbs = tree.breadcrumb('extending/symbols');
```

The tree carries `root` (a `SectionNode`), `getSection(slug)`, and
`breadcrumb(slug)` (ancestors outermost-first, excluding root). Every node and
array is frozen. Sections do not render nested URLs — a `[slug]` param cannot
carry `/` in the current router; this is a data structure for navigation, not a
routing layer.

## `readContentVersions` / `defineContentVersions`

Multi-version docs converge on directory-per-version plus an author-ordered
manifest.

```ts
import { defineContentVersions } from 'jsails/content';

const versions = await defineContentVersions({
  dir: 'content/docs',
  manifest: 'content/docs/versions.json',
});
```

The manifest (`versions.json`) declares `current` (the mutable working tree),
`latest` (the version the bare prefix serves), `default` (the version the
selector opens on), and `versions` — an author-ordered array of version entries
(`name`, `label`, `path`, optional `tag`, `banner`, `noIndex`, `hidden`).
Position is never auto-sorted — it encodes banner derivation (entries before
`latest` get `unreleased`, after get `unmaintained`). Each version's content
directory is `dir/name`.

`defineContentVersions` discovers each version's content, validates the
manifest, and resolves `current`/`latest`/`default` and `banner` labels.
`readContentVersions` reads and validates the manifest only — no content
discovery.

## Feeds and sitemap

### `renderRssFeed` / `renderAtomFeed`

```ts
import { renderRssFeed, renderAtomFeed } from 'jsails/content';

const rss = renderRssFeed(blog, {
  title: 'My Blog',
  siteUrl: 'https://example.com',
  limit: 20,
});
```

Pure XML string generators from a content collection. Both escape text values
(`&`/`<`/`>`/`"`) so user-authored content never corrupts the XML structure.
`siteUrl` must be an absolute `http(s)` URL. Non-draft pages are sorted
newest-first by `date` descending, then `order`. The optional `urlFor` callback
overrides the default `<siteUrl>/<slug>` URL for a page.

### `renderSitemap`

```ts
import { renderSitemap } from 'jsails/content';

const xml = renderSitemap(docs, { siteUrl: 'https://example.com' });
```

One `<url>` per non-draft page with `<loc>` and, when the page has a `date`, a
`<lastmod>` in YYYY-MM-DD format.

## Blog helpers

```ts
import { blogIndex, tagIndex, pageUrl, readingTime } from 'jsails/content';
```

Pure convenience functions over a collection and taxonomy:

- **`blogIndex(collection, options?)`** — non-draft pages sorted newest-first by
  `date` descending, optionally filtered by `tag` and bounded by `limit`.
- **`tagIndex(taxonomy)`** — taxonomy terms sorted by `count` descending, then
  `term` ascending.
- **`pageUrl(page, options?)`** — canonical URL (`/<slug>` by default, or via
  `urlFor`).
- **`readingTime(page)`** — whole-minute estimate (words / 200 wpm, minimum 1).

## `createMarkdownStaticPaths`

A one-line bridge for a page module's `getStaticPaths`:

```ts
import { createMarkdownStaticPaths } from 'jsails/content';

export function getStaticPaths() {
  return createMarkdownStaticPaths(await blog);
}
```

## `ContentError`

All content-layer failures are `ContentError` instances with a stable `code`:

| Code                      | Cause                                                 |
| ------------------------- | ----------------------------------------------------- |
| `missing_required_field`  | `title` frontmatter field is missing or empty.         |
| `invalid_frontmatter`     | Schema validation failure; `.errors` carries `FieldError[]`. |
| `symlink_rejected`        | A file or directory under the content root is a symlink. |
| `invalid_site_url`        | `siteUrl` in a feed/sitemap is not an absolute http(s) URL. |

The error is value-free — it never echoes a field value, frontmatter body, or
rendered HTML. File paths and slugs may appear in the message because they are
metadata needed to locate the offending entry, not user input.

## Honest limits

- **Server-only.** The subpath imports `node:fs`, `node:path`, `gray-matter`,
  `markdown-it`, and `shiki`. It must never enter the browser-safe graph.
- **No file/env resolution.** The content layer resolves directories against the
  process working directory; there is no automatic `CONTENT_DIR` or
  `CONTENT_PATH` environment fallback. Callers supply the directory.
- **No nested routing.** Sections produce a tree data structure but do not
  render nested URLs — a `[slug]` route param cannot carry `/`.
- **No content-type plugin.** The content layer is not an extension and has no
  service token. It is a leaf module imported directly by page modules.

## Next steps

- [SEO](/docs/seo) — metadata, JSON-LD, sitemap, and robots.
- [Routing](/docs/routing) — pages, API routes, and layouts.
