/**
 * Static-blog post page.
 *
 * `getStaticPaths()` enumerates every non-draft slug; `load` resolves the post,
 * its prev/next neighbours, and the resolved asset URLs. A missing slug renders
 * a not-found state — defensive only, since the static export enumerates real
 * slugs.
 *
 * The Markdown body is injected through `dangerouslySetInnerHTML` via `Prose`.
 * That is the documented trust model: the content layer's generated HTML is
 * trusted producer output (authored in the repo and rendered by the build), not
 * untrusted request input.
 */

import type { RequestContext } from 'jsails';
import type { ContentPage, PrevNext } from 'jsails/content';

import type { PageMetadata } from 'jsails/seo';
import type { LayoutAssets } from '../../ui/layout.js';

/** Static export enumerates every non-draft post slug. */
export function getStaticPaths() {
  return createMarkdownStaticPaths(posts);
}

/**
 * Head metadata for a post: title, description, canonical, and Open Graph.
 * `SITE_TITLE` is autoloaded (from `ui/layout.tsx`); the slug comes from the
 * request params. A missing slug yields a generic not-found title.
 */
export function generateMetadata(context: RequestContext): PageMetadata {
  const page = posts.getEntry(context.params.slug);
  if (page === undefined) {
    return { title: `Post not found — ${SITE_TITLE}`, robots: 'noindex' };
  }
  return {
    title: `${page.title} — ${SITE_TITLE}`,
    description: page.excerpt,
    canonical: `/blog/${page.slug}`,
    openGraph: {
      type: 'article',
      title: page.title,
      description: page.excerpt,
    },
  };
}

/** A resolved neighbour: its slug plus the title to show on the card. */
interface Neighbour {
  readonly slug: string;
  readonly title: string;
}

export interface BlogPostProps {
  /** The resolved post, or `null` when the slug is unknown. */
  page: ContentPage | null;
  /** Navigation neighbours, or `undefined` when the page does not exist. */
  prevNext?: PrevNext;
  /** Resolved titles for the prev/next cards, so the links read as prose. */
  prev?: Neighbour;
  next?: Neighbour;
  /** Derived reading time in whole minutes (0 when `page` is null). */
  minutes: number;
  readonly assets?: LayoutAssets;
}

/** Render the not-found state with the shared layout. */
function NotFound({ assets }: { assets?: LayoutAssets }) {
  return (
    <Layout assets={assets}>
      <header class="mb-10">
        <p class="eyebrow mb-4">404</p>
        <h1 class="display text-4xl sm:text-5xl">Post not found</h1>
        <p class="mt-4 text-lg text-base-content/65">That post does not exist or was removed.</p>
        <hr class="rule mt-8" />
      </header>
      <a class="tag-link text-sm" href="/blog">
        &larr; Back to the archive
      </a>
    </Layout>
  );
}

/** Resolve a neighbour slug to a titled card, or `undefined` when absent. */
function neighbour(slug: string | null | undefined): Neighbour | undefined {
  if (slug === null || slug === undefined) return undefined;
  const page = posts.getEntry(slug);
  return { slug, title: page?.title ?? slug };
}

export async function load(context: RequestContext): Promise<BlogPostProps> {
  const assets = await loadLayout(context);
  const page = posts.getEntry(context.params.slug);
  if (page === undefined) {
    return { page: null, minutes: 0, assets };
  }
  const prevNext = posts.prevNext(page.slug);
  return {
    page,
    prevNext,
    prev: neighbour(prevNext?.prev),
    next: neighbour(prevNext?.next),
    minutes: readingTime(page),
    assets,
  };
}

export default function BlogPostPage({ page, prev, next, minutes, assets }: BlogPostProps) {
  if (page === null) {
    return <NotFound assets={assets} />;
  }

  const dateLabel = formatDate(page.date);
  const meta = [dateLabel, `${minutes} min read`].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );

  return (
    <Layout assets={assets}>
      <article>
        <header class="mb-10">
          <h1 class="display max-w-2xl text-4xl sm:text-5xl">{page.title}</h1>
          <p class="tabular mt-5 text-xs text-base-content/45">{meta.join('  \u00b7  ')}</p>
          {page.tags.length > 0 ? (
            <ul class="mt-4 flex flex-wrap gap-x-4 gap-y-1">
              {page.tags.map((tag) => (
                <li key={tag}>
                  <TagBadge
                    tag={tag}
                    slug={tags.getTerm(tag.toLowerCase())?.slug ?? tag.toLowerCase()}
                  />
                </li>
              ))}
            </ul>
          ) : null}
          <hr class="rule mt-8" />
        </header>

        {page.toc.length > 0 ? (
          <div class="mb-10">
            <Toc headings={page.toc} />
          </div>
        ) : null}

        <Prose html={page.html} />

        {prev !== undefined || next !== undefined ? (
          <nav
            class="mt-16 grid gap-4 border-t border-base-300/70 pt-8 sm:grid-cols-2"
            aria-label="Post navigation"
          >
            {prev !== undefined ? (
              <a
                class="group rounded-box border border-base-300/70 p-5 transition-colors hover:border-primary/50"
                href={`/blog/${prev.slug}`}
              >
                <span class="eyebrow">&larr; Previous</span>
                <span class="mt-2 block font-serif text-lg leading-snug text-base-content transition-colors group-hover:text-primary">
                  {prev.title}
                </span>
              </a>
            ) : (
              <span />
            )}
            {next !== undefined ? (
              <a
                class="group rounded-box border border-base-300/70 p-5 transition-colors hover:border-primary/50 sm:text-right"
                href={`/blog/${next.slug}`}
              >
                <span class="eyebrow">Next &rarr;</span>
                <span class="mt-2 block font-serif text-lg leading-snug text-base-content transition-colors group-hover:text-primary">
                  {next.title}
                </span>
              </a>
            ) : (
              <span />
            )}
          </nav>
        ) : null}
      </article>
    </Layout>
  );
}
