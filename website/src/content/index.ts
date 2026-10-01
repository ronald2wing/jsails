/**
 * Content pipeline for the JSails docs site.
 *
 * Delegates markdown discovery, rendering (gray-matter + markdown-it + Shiki),
 * incremental caching, TOC extraction, excerpting, prev/next, and the search
 * corpus to `jsails/content` (`discoverContent`).  The single docs-specific
 * piece is versioning — `build()` maps an optional version label to
 * `content/docs/` (latest) or `content/versions/<label>/` (frozen release).
 *
 * `buildBlog()` is a second independent collection for blog/news content that
 * re-sorts by date and enforces a required `date` frontmatter field (which
 * `jsails/content` does not require — only `title` is mandatory).
 */

import {
  ContentError,
  discoverContent,
  readContentVersions,
  defineContentVersions,
} from 'jsails/content';
import type { ContentVersions, PrevNext, SearchRecord } from 'jsails/content';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDocsVersions } from './versions.js';

// ---------------------------------------------------------------------------
// Local page shapes
//
// `jsails/content`'s `ContentPage` has `readonly TocHeading[]` and a `data`
// field, but the pages' inline prop types expect mutable toc arrays and never
// reference `data`.  These local interfaces match the old module's shape
// exactly so NO page or layout file changes.  At the boundary we spread
// `ContentPage` into these shapes with a shallow-copied `toc` — zero runtime
// cost beyond a one-time O(N) walk of already-discovered pages.
// ---------------------------------------------------------------------------

interface TocHeading {
  depth: number;
  id: string;
  text: string;
}

interface DocsPage {
  slug: string;
  title: string;
  order: number;
  html: string;
  toc: TocHeading[];
  draft: boolean;
  tags: readonly string[];
  date?: string;
  section: string;
  excerpt?: string;
}

export interface ContentGraph {
  docs: readonly DocsPage[];
  nav: readonly DocsPage[];
  prevNext: ReadonlyMap<string, PrevNext>;
  index: ReadonlyMap<string, DocsPage>;
  search: readonly SearchRecord[];
}

interface BlogPage {
  slug: string;
  title: string;
  date: string;
  draft: boolean;
  tags: readonly string[];
  html: string;
  toc: TocHeading[];
  excerpt?: string;
}

export interface BlogGraph {
  posts: readonly BlogPage[];
  bySlug: ReadonlyMap<string, BlogPage>;
  tags: ReadonlyMap<string, readonly string[]>;
}

// Re-export for any caller that imports it directly (no page currently does).
export { ContentError };

// ---------------------------------------------------------------------------
// Path resolution (keep verbatim — keyed off the compiled module location)
// ---------------------------------------------------------------------------

function resolveContentDir(...segments: string[]): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = __filename.slice(0, __filename.lastIndexOf('/'));
  // compiled: .../website/dist/src/content/index.js
  // content:  .../website/content/
  return resolvePath(__dirname, '..', '..', '..', 'content', ...segments);
}

function resolveCacheDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = __filename.slice(0, __filename.lastIndexOf('/'));
  return resolvePath(__dirname, '..', '..', '..', '.content-cache');
}

// ---------------------------------------------------------------------------
// ContentPage → DocsPage / BlogPage conversion
// ---------------------------------------------------------------------------

import type { ContentPage } from 'jsails/content';

/**
 * `ContentPage.toc` is `readonly TocHeading[]`; the pages' inline types accept
 * mutable `TocHeading[]`.  Shallow-copy `toc` so the type checker is satisfied.
 * The copy is O(headings) per page, done once at build time — the rest of the
 * page object is spread by reference (no deep copy).
 */
function toDocsPage(p: ContentPage): DocsPage {
  return {
    slug: p.slug,
    section: p.section,
    title: p.title,
    order: p.order,
    html: p.html,
    toc: [...p.toc],
    draft: p.draft,
    tags: p.tags,
    date: p.date,
    excerpt: p.excerpt,
  };
}

function toBlogPage(p: ContentPage & { date: string }): BlogPage {
  return {
    slug: p.slug,
    title: p.title,
    date: p.date,
    draft: p.draft,
    tags: p.tags,
    html: p.html,
    toc: [...p.toc],
    excerpt: p.excerpt,
  };
}

// ---------------------------------------------------------------------------
// Versioning descriptor (memoized)
// ---------------------------------------------------------------------------

function resolveVersionsJsonPath(): string {
  return resolveContentDir('versions.json');
}

let _versionsPromise: Promise<ContentVersions> | null = null;

function docsVersions(): Promise<ContentVersions> {
  if (_versionsPromise === null) {
    _versionsPromise = defineContentVersions({
      currentDir: resolveContentDir('docs'),
      versionsDir: resolveContentDir('versions'),
      manifest: readContentVersions(resolveVersionsJsonPath()),
      prefix: '/docs',
      cacheDir: resolveCacheDir(),
    });
  }
  return _versionsPromise;
}

// ---------------------------------------------------------------------------
// Docs build
// ---------------------------------------------------------------------------

let _graphPromise: Promise<ContentGraph> | null = null;
const _graphByVersion = new Map<string, Promise<ContentGraph>>();

/**
 * Build the docs content graph for a version.
 *
 * `version` defaults to (and `'current'` maps to) the latest release — the
 * docs in `content/docs/`.  Any other label reads `content/versions/<label>/`.
 * Results are memoized so every page in one `jsails build` shares each
 * version's O(N) parse.
 */
export function build(version?: string): Promise<ContentGraph> {
  if (version === undefined) {
    if (_graphPromise) return _graphPromise;
    _graphPromise = doBuild(undefined);
    return _graphPromise;
  }
  const key = version === 'current' ? readDocsVersions().current : version;
  const existing = _graphByVersion.get(key);
  if (existing) return existing;
  const promise = doBuild(key);
  _graphByVersion.set(key, promise);
  return promise;
}

async function doBuild(version?: string): Promise<ContentGraph> {
  const versions = await docsVersions();
  // undefined → the default tree (current, or latest when current is absent);
  // a string → resolve by name. Falls back to current when the name is unknown
  // so `'current'` always resolves to the current tree.
  const info =
    version === undefined
      ? (versions.current() ?? versions.latest())
      : (versions.forVersion(version) ?? versions.forVersion('current'));
  if (info === null) {
    throw new ContentError(
      'versions_unknown_version',
      `Unknown docs version "${version ?? 'current'}"`,
    );
  }
  const collection = await discoverContent(info.dir, { cacheDir: resolveCacheDir() });

  const docs = collection.pages.map(toDocsPage);

  const index = new Map<string, DocsPage>();
  for (const page of docs) index.set(page.slug, page);

  return { docs, nav: docs, prevNext: collection.prevNext, index, search: collection.search };
}

// ---------------------------------------------------------------------------
// Blog build
// ---------------------------------------------------------------------------

let _blogPromise: Promise<BlogGraph> | null = null;

export function buildBlog(): Promise<BlogGraph> {
  if (_blogPromise) return _blogPromise;
  _blogPromise = doBuildBlog();
  return _blogPromise;
}

async function doBuildBlog(): Promise<BlogGraph> {
  const collection = await discoverContent(resolveContentDir('blog'), {
    cacheDir: resolveCacheDir(),
  });

  // Blog is date-descending, not the default order — title — slug sort.
  const pages = [...collection.pages].sort((a, b) => {
    const ad = a.date ?? '';
    const bd = b.date ?? '';
    if (ad > bd) return -1;
    if (ad < bd) return 1;
    return 0;
  });

  // `discoverContent` requires `title` but not `date`; the blog requires both.
  for (const page of pages) {
    if (page.date === undefined) {
      throw new ContentError(
        'missing_required_field',
        `Blog file "${page.slug}" is missing a required frontmatter field "date"`,
      );
    }
  }

  // Every page now has a date — narrowing is safe.
  const typed = pages as (ContentPage & { date: string })[];
  const posts = typed.map(toBlogPage);

  const bySlug = new Map<string, BlogPage>(posts.map((p) => [p.slug, p] as const));

  // Tags index: one entry per non-draft post's tags.
  const tags = new Map<string, string[]>();
  for (const post of posts) {
    if (post.draft) continue;
    for (const tag of post.tags) {
      const slugs = tags.get(tag) ?? [];
      slugs.push(post.slug);
      tags.set(tag, slugs);
    }
  }

  return { posts, bySlug, tags };
}
