/**
 * Single-pass content pipeline for the docs site.
 *
 * `build()` reads all markdown content once, renders it with Shiki syntax
 * highlighting, extracts headings for the TOC, and builds a content graph.
 * Results are memoized at module level so every page in a single `jsails build`
 * process shares the same O(N) pass.
 *
 * `buildBlog()` is a second independent collection for blog/news content that
 * reuses the same rendering pipeline without disturbing the docs collection.
 *
 * An incremental on-disk cache (`.content-cache/`) keys entries by source file
 * `mtimeMs + size`; unchanged files skip re-parsing and re-highlighting.
 *
 * The markdown output is **trusted producer HTML** — no sanitizer runs here.
 * Content is hand-authored and version-controlled.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';
import MarkdownIt, { type Token } from 'markdown-it';

import { highlightCode } from './highlight.js';
import { readDocsVersions } from './versions.js';
import { createFileCache, type CacheStore } from './cache.js';

// --- Types ------------------------------------------------------------------

interface TocHeading {
  depth: number;
  id: string;
  text: string;
}

interface ContentPage {
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

interface SearchRecord {
  slug: string;
  title: string;
  text: string;
}

interface PrevNext {
  prev: string | null;
  next: string | null;
}

interface ContentGraph {
  docs: ContentPage[];
  nav: ContentPage[];
  prevNext: Map<string, PrevNext>;
  index: Map<string, ContentPage>;
  /** Search corpus (plain text per doc) for future search UI. */
  search: readonly SearchRecord[];
}

interface BlogPost {
  slug: string;
  title: string;
  date: string;
  draft: boolean;
  tags: readonly string[];
  html: string;
  toc: TocHeading[];
  excerpt?: string;
}

interface BlogGraph {
  posts: readonly BlogPost[];
  bySlug: ReadonlyMap<string, BlogPost>;
  tags: ReadonlyMap<string, readonly string[]>;
}

// --- Rendering engine -------------------------------------------------------

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
});

md.enable('table');

// --- Heading extraction ----------------------------------------------------

function extractHeadings(tokens: Token[]): TocHeading[] {
  const headings: TocHeading[] = [];
  const slugCounts = new Map<string, number>();

  function makeSlug(text: string): string {
    const slug =
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'heading';
    const count = slugCounts.get(slug) ?? 0;
    slugCounts.set(slug, count + 1);
    return count === 0 ? slug : `${slug}-${count + 1}`;
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'heading_open') continue;
    const depth = parseInt(token.tag.slice(1), 10);
    const next = tokens[i + 1];
    if (!next || next.type !== 'inline') continue;
    const text = next.content.replace(/<[^>]*>/g, '').trim();
    const id = makeSlug(text);
    headings.push({ depth, id, text });
  }

  return headings;
}

// --- Markdown rendering (with async Shiki highlighting) --------------------

/**
 * Render markdown content to HTML with async Shiki syntax highlighting for
 * fenced code blocks.
 *
 * Approach: parse tokens with `md.parse`, collect all `fence` blocks, highlight
 * each in parallel via the shared Shiki highlighter, store the highlighted HTML
 * on each fence token, then override `md.renderer.rules.fence` to emit it.
 */
async function renderMarkdown(content: string): Promise<{ html: string; toc: TocHeading[] }> {
  const tokens = md.parse(content, {});

  // Collect fence blocks.
  const fenceIndices: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'fence') {
      fenceIndices.push(i);
    }
  }

  // Highlight all fence blocks in parallel.
  if (fenceIndices.length > 0) {
    const highlighted = await Promise.all(
      fenceIndices.map(async (idx) => {
        const token = tokens[idx];
        const lang = token.info.trim().split(/\s+/)[0] || 'text';
        const html = await highlightCode(token.content, lang);
        return { idx, html };
      }),
    );

    for (const { idx, html } of highlighted) {
      (tokens[idx] as any)._highlighted = html;
    }
  }

  // Override fence renderer to emit highlighted HTML.
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, _opts, _env, _renderer) => {
    const token = tokens[idx];
    if ((token as any)._highlighted) {
      return (token as any)._highlighted;
    }
    return defaultFence ? defaultFence(tokens, idx, _opts, _env, _renderer) : '';
  };

  const html = md.renderer.render(tokens, md.options, {});
  const toc = extractHeadings(tokens);

  return { html, toc };
}

// --- Plain text extraction (for search corpus) -----------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<pre[^>]*>[\s\S]*?<\/pre>/g, ' ') // strip code blocks
    .replace(/<[^>]*>/g, ' ') // strip remaining tags
    .replace(/&[a-z]+;/g, ' ') // strip entities
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000); // bounded per doc
}

// --- Content resolution ----------------------------------------------------

function resolveContentDir(...segments: string[]): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = __filename.slice(0, __filename.lastIndexOf('/'));
  // compiled: .../website/dist/src/content/index.js
  // source:   .../website/src/content/index.ts
  // content:  .../website/content/
  return resolvePath(__dirname, '..', '..', '..', 'content', ...segments);
}

function slugFromFilename(filePath: string): string {
  return basename(filePath, '.md');
}

// --- Cache resolution ------------------------------------------------------

function resolveCacheDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = __filename.slice(0, __filename.lastIndexOf('/'));
  return resolvePath(__dirname, '..', '..', '..', '.content-cache');
}

let _cache: CacheStore | null = null;

function getCache(): CacheStore {
  if (!_cache) {
    _cache = createFileCache(resolveCacheDir());
  }
  return _cache;
}

// --- Docs build ------------------------------------------------------------

let _graphPromise: Promise<ContentGraph> | null = null;
const _graphByVersion = new Map<string, Promise<ContentGraph>>();

/**
 * Build the docs content graph for a version.
 *
 * `version` defaults to (and `'current'` maps to) the latest release — the
 * docs in `content/docs/`. Any other label reads the frozen tree
 * `content/versions/<version>/`. Results are memoized per version so every
 * page in one `jsails build` shares each version's O(N) parse.
 */
export function build(version?: string): Promise<ContentGraph> {
  // Unversioned callers (the latest-release pages) use `_graphPromise`;
  // versioned callers key by label.
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
  // Latest release = content/docs/; a frozen version = content/versions/<minor>/.
  const docsDir =
    version === undefined ? resolveContentDir('docs') : resolveContentDir('versions', version);
  const cache = getCache();

  const entries: ContentPage[] = [];

  let files: string[];
  try {
    files = readdirSync(docsDir).filter((f) => f.endsWith('.md'));
    files.sort();
  } catch {
    files = [];
  }

  for (const file of files) {
    const fullPath = resolvePath(docsDir, file);
    const stat = statSync(fullPath);
    const raw = readFileSync(fullPath, 'utf-8');
    const { data, content } = matter(raw);

    const fm = data as Record<string, unknown>;

    if (typeof fm.title !== 'string' || fm.title.length === 0) {
      throw new ContentError(
        'missing_required_field',
        `File "${file}" is missing a required frontmatter field "title"`,
      );
    }

    const slug =
      typeof fm.slug === 'string' && fm.slug.length > 0 ? fm.slug : slugFromFilename(file);
    const order = typeof fm.order === 'number' ? fm.order : Infinity;
    const draft = fm.draft === true;
    const tags = Array.isArray(fm.tags)
      ? (fm.tags as string[]).filter((t) => typeof t === 'string')
      : [];

    const date = normalizeDate(fm.date);

    // Check incremental cache.
    const cached = cache.get(fullPath, stat.mtimeMs, stat.size);
    let html: string;
    let toc: TocHeading[];

    if (cached) {
      html = cached.html;
      toc = cached.toc;
    } else {
      const rendered = await renderMarkdown(content);
      html = rendered.html;
      toc = rendered.toc;
      cache.put(fullPath, stat.mtimeMs, stat.size, { html, toc, headings: toc });
    }

    // Excerpt: first non-empty paragraph text, max 200 chars.
    const excerpt = extractExcerpt(html);

    entries.push({
      slug,
      title: fm.title,
      order,
      html,
      toc,
      draft,
      tags,
      date,
      section: 'docs',
      excerpt,
    });
  }

  // Sort: lower order first, then title, then slug (deterministic).
  entries.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    if (a.title < b.title) return -1;
    if (a.title > b.title) return 1;
    if (a.slug < b.slug) return -1;
    if (a.slug > b.slug) return 1;
    return 0;
  });

  const index = new Map<string, ContentPage>();
  for (const entry of entries) {
    index.set(entry.slug, entry);
  }

  const prevNext = new Map<string, PrevNext>();
  for (let i = 0; i < entries.length; i++) {
    const prev = i > 0 ? entries[i - 1].slug : null;
    const next = i < entries.length - 1 ? entries[i + 1].slug : null;
    prevNext.set(entries[i].slug, { prev, next });
  }

  // Search corpus: one record per non-draft doc.
  const search: SearchRecord[] = entries
    .filter((e) => !e.draft)
    .map((e) => ({
      slug: e.slug,
      title: e.title,
      text: stripHtml(e.html),
    }));

  return { docs: entries, nav: entries, prevNext, index, search };
}

// --- Blog build ------------------------------------------------------------

let _blogPromise: Promise<BlogGraph> | null = null;

export function buildBlog(): Promise<BlogGraph> {
  if (_blogPromise) return _blogPromise;
  _blogPromise = doBuildBlog();
  return _blogPromise;
}

async function doBuildBlog(): Promise<BlogGraph> {
  const blogDir = resolveContentDir('blog');
  const cache = getCache();

  const posts: BlogPost[] = [];

  let files: string[];
  try {
    files = readdirSync(blogDir).filter((f) => f.endsWith('.md'));
    files.sort();
  } catch {
    files = [];
  }

  for (const file of files) {
    const fullPath = resolvePath(blogDir, file);
    const stat = statSync(fullPath);
    const raw = readFileSync(fullPath, 'utf-8');
    const { data, content } = matter(raw);

    const fm = data as Record<string, unknown>;

    if (typeof fm.title !== 'string' || fm.title.length === 0) {
      throw new ContentError(
        'missing_required_field',
        `Blog file "${file}" is missing a required frontmatter field "title"`,
      );
    }

    const dateVal = normalizeDate(fm.date);
    if (!dateVal) {
      throw new ContentError(
        'missing_required_field',
        `Blog file "${file}" is missing a required frontmatter field "date"`,
      );
    }

    const slug =
      typeof fm.slug === 'string' && fm.slug.length > 0 ? fm.slug : slugFromFilename(file);
    const draft = fm.draft === true;
    const tags = Array.isArray(fm.tags)
      ? (fm.tags as string[]).filter((t) => typeof t === 'string')
      : [];

    // Check incremental cache (reuse same cache store).
    const cached = cache.get(fullPath, stat.mtimeMs, stat.size);
    let html: string;
    let toc: TocHeading[];

    if (cached) {
      html = cached.html;
      toc = cached.toc;
    } else {
      const rendered = await renderMarkdown(content);
      html = rendered.html;
      toc = rendered.toc;
      cache.put(fullPath, stat.mtimeMs, stat.size, { html, toc, headings: toc });
    }

    const excerpt = extractExcerpt(html);

    posts.push({
      slug,
      title: fm.title,
      date: dateVal,
      draft,
      tags,
      html,
      toc,
      excerpt,
    });
  }

  // Sort: date descending (newest first).
  posts.sort((a, b) => {
    if (a.date > b.date) return -1;
    if (a.date < b.date) return 1;
    return 0;
  });

  const bySlug = new Map<string, BlogPost>();
  for (const post of posts) {
    bySlug.set(post.slug, post);
  }

  // Tags index.
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

// --- Helpers ---------------------------------------------------------------

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

function extractExcerpt(html: string): string | undefined {
  // Take the first <p> text content, max 200 chars.
  const match = html.match(/<p>([^<]*)<\/p>/);
  if (!match) return undefined;
  const text = match[1].trim();
  if (text.length === 0) return undefined;
  return text.length > 200 ? text.slice(0, 197) + '...' : text;
}

// --- Errors ----------------------------------------------------------------

export class ContentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContentError';
    this.code = code;
  }
}
