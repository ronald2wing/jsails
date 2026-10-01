/**
 * Content discovery (`jsails/content`).
 *
 * `discoverContent` walks one directory tree of `.md` files once per process
 * (memoized by resolved directory), renders each file through the shared
 * markdown/Shiki pipeline, and reduces the result to a frozen, deterministic
 * {@link ContentCollection}. Rendering results are cached incrementally on disk
 * so an unchanged file skips re-parsing and re-highlighting.
 */

import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative as relativePath, resolve as resolvePath } from 'node:path';

import matter from 'gray-matter';

import { createFileCache } from './cache.js';
import { ContentError } from './errors.js';
import { extractExcerpt, renderMarkdown, stripHtml } from './render.js';
import type {
  ContentCollection,
  ContentOptions,
  ContentPage,
  PrevNext,
  TocHeading,
} from './content-model.js';

// --- Memoization ------------------------------------------------------------

const _collections = new Map<string, Promise<ContentCollection>>();

/**
 * Discover and render every `.md` file under `dir` (recursive).
 *
 * The result is memoized per (resolved directory, cacheDir) pair, so every page
 * in one build process with the same cache location shares the same O(N) render
 * pass. Symlinks are rejected; a missing directory yields an empty collection.
 *
 * @param dir - Content directory, resolved against the process working directory.
 * @param options.cacheDir - Incremental cache directory (default `.content-cache`).
 */
export function discoverContent(dir: string, options?: ContentOptions): Promise<ContentCollection> {
  const resolved = resolvePath(dir);
  // Incorporate cacheDir into the memo key so two callers with different
  // incremental-cache locations do not silently share each other's result.
  const key = `${resolved}\u0000${options?.cacheDir ?? ''}`;
  const existing = _collections.get(key);
  if (existing) return existing;

  const promise = doDiscover(resolved, options);
  _collections.set(key, promise);
  return promise;
}

async function doDiscover(dir: string, options?: ContentOptions): Promise<ContentCollection> {
  // Reject a symlinked root: children are already guarded by walkMarkdown,
  // but the root itself was unchecked. Missing directories fall through to
  // walkMarkdown (which yields an empty collection).
  let rootStat;
  try {
    rootStat = lstatSync(dir);
  } catch {
    // Missing dir — walkMarkdown handles this gracefully.
    rootStat = undefined;
  }
  if (rootStat !== undefined && rootStat.isSymbolicLink()) {
    throw new ContentError('symlink_rejected', `Symlinks are not supported: ${dir}`);
  }

  const cache = createFileCache(resolveCacheDir(options?.cacheDir));
  const pages: ContentPage[] = [];

  for (const file of walkMarkdown(dir)) {
    const stat = statSync(file);
    const raw = readFileSync(file, 'utf-8');
    const parsed = matter(raw);
    const fm = (parsed.data ?? {}) as Record<string, unknown>;

    if (typeof fm.title !== 'string' || fm.title.length === 0) {
      throw new ContentError(
        'missing_required_field',
        `File "${file}" is missing a required frontmatter field "title"`,
      );
    }

    const { slug, section } = deriveSlug(dir, file);
    const resolvedSlug = typeof fm.slug === 'string' && fm.slug.length > 0 ? fm.slug : slug;
    const order = typeof fm.order === 'number' ? fm.order : Infinity;
    const draft = fm.draft === true;
    const tags = Array.isArray(fm.tags)
      ? fm.tags.filter((tag): tag is string => typeof tag === 'string')
      : [];
    const date = normalizeDate(fm.date);

    // Check the incremental cache; an unchanged file skips re-render.
    const cached = cache.get(file, stat.mtimeMs, stat.size);
    let html: string;
    let toc: TocHeading[];
    if (cached) {
      html = cached.html;
      toc = cached.toc;
    } else {
      const rendered = await renderMarkdown(parsed.content);
      html = rendered.html;
      toc = rendered.toc;
      cache.put(file, stat.mtimeMs, stat.size, { html, toc, headings: toc });
    }

    pages.push(
      freezePage({
        slug: resolvedSlug,
        section,
        title: fm.title,
        order,
        html,
        toc,
        draft,
        tags,
        date,
        excerpt: extractExcerpt(html),
        data: fm,
      }),
    );
  }

  pages.sort(defaultCompare);
  return buildCollection(pages);
}

// --- Directory walk ---------------------------------------------------------

/** Recursively collect `.md` files, rejecting symlinks at any depth. */
function walkMarkdown(dir: string): string[] {
  const files: string[] = [];
  const stack: string[] = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;

    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip (graceful degradation)
    }

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const full = resolvePath(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new ContentError('symlink_rejected', `Symlinks are not supported: ${full}`);
      }
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(full);
      }
    }
  }

  return files;
}

// --- Slug / section derivation ---------------------------------------------

function deriveSlug(dir: string, filePath: string): { slug: string; section: string } {
  const rel = relativePath(dir, filePath).replace(/\\/g, '/');
  const slug = rel.endsWith('.md') ? rel.slice(0, -3) : rel;
  const section = slug.includes('/') ? slug.slice(0, slug.indexOf('/')) : '';
  return { slug, section };
}

// --- Collection assembly ----------------------------------------------------

/**
 * Build a frozen collection from already-sorted pages.
 *
 * `prevNext` and `search` are derived over the non-draft subset only, so drafts
 * never appear in navigation or the search corpus while remaining discoverable
 * through `pages` / `bySlug`. This matches the docs site's semantics where
 * drafts stay reachable by slug but are excluded from derived navigation.
 */
export function buildCollection(pages: readonly ContentPage[]): ContentCollection {
  const bySlug = new Map<string, ContentPage>();
  for (const page of pages) bySlug.set(page.slug, page);

  const nav = pages.filter((page) => !page.draft);
  const prevNext = new Map<string, PrevNext>();
  for (const [i, current] of nav.entries()) {
    prevNext.set(current.slug, {
      prev: i > 0 ? (nav[i - 1]?.slug ?? null) : null,
      next: i < nav.length - 1 ? (nav[i + 1]?.slug ?? null) : null,
    });
  }

  const search = nav.map((page) => ({
    slug: page.slug,
    title: page.title,
    text: stripHtml(page.html),
  }));
  for (const record of search) Object.freeze(record);

  return Object.freeze({
    pages: Object.freeze(pages),
    bySlug,
    prevNext,
    search: Object.freeze(search),
  });
}

// --- Deterministic ordering -------------------------------------------------

function defaultCompare(a: ContentPage, b: ContentPage): number {
  if (a.order !== b.order) return a.order - b.order;
  if (a.title < b.title) return -1;
  if (a.title > b.title) return 1;
  if (a.slug < b.slug) return -1;
  if (a.slug > b.slug) return 1;
  return 0;
}

// --- Freezing ---------------------------------------------------------------

function freezePage(page: ContentPage): ContentPage {
  for (const heading of page.toc) Object.freeze(heading);
  Object.freeze(page.toc);
  Object.freeze(page.tags);
  Object.freeze(page.data);
  return Object.freeze(page);
}

// --- Helpers ----------------------------------------------------------------

/**
 * gray-matter may parse a YAML date value (e.g. `2026-10-07`) as a Date object.
 * Normalise to an ISO date string (YYYY-MM-DD).
 */
function normalizeDate(val: unknown): string | undefined {
  if (typeof val === 'string') return val;
  if (val instanceof Date && !isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  return undefined;
}

function resolveCacheDir(cacheDir: string | undefined): string {
  return resolvePath(cacheDir ?? '.content-cache');
}
