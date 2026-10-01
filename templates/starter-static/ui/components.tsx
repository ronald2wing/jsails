/**
 * Static-blog UI helpers.
 *
 * Small, app-owned presentational components shared across pages. They import
 * only `preact` types — no Node built-ins, no `jsails/content` — so the module
 * stays browser-safe and never pulls the server-only content layer into the
 * client bundle. Content-layer types are accepted structurally via `import
 * type`, which is erased at compile time.
 *
 * Only wrappers that add real structure live here. Cards, badges, and prose are
 * plain TSX with Tailwind/daisyUI classes; these components exist because the
 * same shape (a post summary, a tag chip, a rendered-markdown block, a table of
 * contents) appears on several pages and should stay consistent.
 */

import type { ComponentChildren } from 'preact';

import type { ContentPage, TocHeading } from 'jsails/content';

/** Merge caller and component class names, dropping empties. */
function cx(...parts: unknown[]): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
}

/* -------------------------------------------------------------------------- */
/* Date formatting                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Format a `YYYY-MM-DD` frontmatter date as a readable label.
 *
 * Parsed as UTC so the rendered day matches the authored date regardless of the
 * build machine's timezone. An unparseable value falls back to the raw string
 * rather than showing `Invalid Date`.
 */
export function formatDate(date: string | undefined): string | undefined {
  if (date === undefined || date.length === 0) return undefined;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * A compact `YYYY-MM-DD` label for the post-row date rail.
 *
 * The rail is monospace and tabular, so the ISO form reads as a column of
 * aligned dates rather than prose. Falls back to the raw value when unparseable.
 */
function railDate(date: string | undefined): string | undefined {
  if (date === undefined || date.length === 0) return undefined;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return date;
}

/* -------------------------------------------------------------------------- */
/* TagBadge                                                                   */
/* -------------------------------------------------------------------------- */

export interface TagBadgeProps {
  /** The raw tag label. */
  readonly tag: string;
  /** URL-safe slug used in the `/tags/<slug>` link. */
  readonly slug: string;
  /** Optional count shown alongside the label (used on the tag-cloud page). */
  readonly count?: number;
}

/**
 * A quiet tag link pointing at one tag's term page.
 *
 * Rendered as monospace text rather than a filled chip so a row of tags reads
 * as metadata, not buttons. The optional count is set in a lighter tone.
 */
export function TagBadge({ tag, slug, count }: TagBadgeProps) {
  return (
    <a class="tag-link" href={`/tags/${slug}`}>
      #{tag}
      {count !== undefined ? <span class="ml-1 opacity-50">{count}</span> : null}
    </a>
  );
}

/* -------------------------------------------------------------------------- */
/* PostCard                                                                   */
/* -------------------------------------------------------------------------- */

export interface PostCardProps {
  /** The content page to summarize. Extra fields (html, data) are ignored. */
  readonly page: ContentPage;
  /** Derived reading time in whole minutes. */
  readonly readingMinutes: number;
  /** Optional tag slug lookup so each badge links to the right term page. */
  readonly tagSlugFor?: (tag: string) => string;
}

/**
 * One post summary as an editorial row: a monospace date rail on the left and
 * the title, excerpt, and tags in the body column.
 *
 * Renders an occupied date/reading-time line only when the values exist, so a
 * post with no `date` (or with tags but no slug lookup) still lays out cleanly.
 */
export function PostCard({ page, readingMinutes, tagSlugFor }: PostCardProps) {
  const dateLabel = railDate(page.date);
  return (
    <article class="post-row group border-b border-base-300/60 pb-7 last:border-b-0 last:pb-0">
      <div class="tabular pt-1 text-xs text-base-content/45">
        {dateLabel !== undefined ? <time datetime={page.date}>{dateLabel}</time> : null}
        <span class="mt-1 block text-base-content/35">{readingMinutes} min</span>
      </div>
      <div>
        <h2 class="text-xl leading-snug sm:text-2xl">
          <a class="post-title inline-block text-base-content" href={`/blog/${page.slug}`}>
            {page.title}
          </a>
        </h2>
        {page.excerpt !== undefined && page.excerpt.length > 0 ? (
          <p class="mt-2 max-w-prose text-base-content/70">{page.excerpt}</p>
        ) : null}
        {page.tags.length > 0 ? (
          <ul class="mt-3 flex flex-wrap gap-x-4 gap-y-1">
            {page.tags.map((tag) => (
              <li key={tag}>
                <TagBadge tag={tag} slug={tagSlugFor?.(tag) ?? tag.toLowerCase()} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/* Prose                                                                      */
/* -------------------------------------------------------------------------- */

export interface ProseProps {
  /**
   * Trusted producer HTML from the content layer's markdown renderer. This is
   * the documented trust model: `jsails/content` output is rendered markdown
   * the build process owns, not untrusted user input, so it is injected as-is.
   */
  readonly html: string;
  readonly class?: string;
}

/** A measured-width wrapper that applies the `.prose` markdown styles. */
export function Prose({ html, class: className }: ProseProps) {
  return (
    <div
      class={cx('prose', className)}
      // The HTML comes from the content layer's markdown renderer (trusted
      // producer output), never from an untrusted request body.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Toc                                                                        */
/* -------------------------------------------------------------------------- */

export interface TocProps {
  /** Headings derived from the page's rendered HTML. */
  readonly headings: readonly TocHeading[];
}

/**
 * An in-page table of contents built from the page's heading anchors.
 *
 * Rendered only when at least one heading exists; each entry links to the
 * heading's generated id. H3-and-deeper headings indent one level. The list is
 * a quiet, ruled block rather than a filled card so it reads as a margin note.
 */
export function Toc({ headings }: TocProps) {
  if (headings.length === 0) return null;
  return (
    <nav class="border-l-2 border-base-300 pl-5" aria-label="Table of contents">
      <p class="eyebrow mb-3">On this page</p>
      <ul class="space-y-1.5 text-sm">
        {headings.map((heading) => (
          <li class={heading.depth > 2 ? 'pl-4' : undefined} key={heading.id}>
            <a
              class="text-base-content/65 transition-colors hover:text-primary"
              href={`#${heading.id}`}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* PageHeader                                                                 */
/* -------------------------------------------------------------------------- */

export interface PageHeaderProps {
  readonly title: string;
  readonly description?: ComponentChildren;
}

/**
 * A consistent page masthead: an eyebrow, a serif display title, an optional
 * lead paragraph, and a thin rule that separates it from the page body.
 */
export function PageHeader({ title, description }: PageHeaderProps) {
  return (
    <header class="mb-10">
      <h1 class="display text-4xl sm:text-5xl">{title}</h1>
      {description !== undefined ? (
        <p class="mt-4 max-w-prose text-lg text-base-content/65">{description}</p>
      ) : null}
      <hr class="rule mt-8" />
    </header>
  );
}
