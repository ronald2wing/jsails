/**
 * Static-blog tag detail page.
 *
 * `getStaticPaths()` enumerates every tag slug; `load` resolves the term and its
 * pages. An unknown term renders an empty state — defensive only, since the
 * static export enumerates real terms.
 */

import type { RequestContext } from 'jsails';
import type { PageMetadata } from 'jsails/seo';
import type { ContentPage } from 'jsails/content';

import type { LayoutAssets } from '../../ui/layout.js';

/** Static export enumerates every taxonomy term slug. */
export function getStaticPaths() {
  return tags.getStaticPaths();
}

/** Head metadata for one tag: uses the resolved term label, or a generic title. */
export function generateMetadata(context: RequestContext): PageMetadata {
  const term = tags.getTerm(context.params.term);
  return {
    title: term === undefined ? `Tags — ${SITE_TITLE}` : `${term.term} — ${SITE_TITLE}`,
    canonical: `/tags/${context.params.term}`,
  };
}

export interface TagPageProps {
  /** The raw tag label, or '' when the term is unknown. */
  readonly term: string;
  readonly entries: readonly { page: ContentPage; minutes: number }[];
  readonly assets?: LayoutAssets;
}

export async function load(context: RequestContext): Promise<TagPageProps> {
  const assets = await loadLayout(context);
  const resolved = tags.getTerm(context.params.term);
  if (resolved === undefined) {
    return { term: '', entries: [], assets };
  }
  return {
    term: resolved.term,
    entries: resolved.pages.map((page) => ({ page, minutes: readingTime(page) })),
    assets,
  };
}

export default function TagPage({ term, entries, assets }: TagPageProps) {
  const label = term || 'unknown';
  const count = entries.length;

  return (
    <Layout assets={assets}>
      <header class="mb-12">
        <p class="eyebrow mb-4">Tagged</p>
        <h1 class="display text-4xl sm:text-5xl">{label}</h1>
        <p class="tabular mt-4 text-sm text-base-content/50">
          {count} {count === 1 ? 'post' : 'posts'}
        </p>
        <hr class="rule mt-8" />
      </header>

      {count === 0 ? (
        <p class="text-base-content/60">
          No posts with this tag.{' '}
          <a class="text-primary underline underline-offset-2" href="/tags">
            See all tags
          </a>
        </p>
      ) : (
        <section class="space-y-7">
          {entries.map(({ page, minutes }) => (
            <PostCard key={page.slug} page={page} readingMinutes={minutes} />
          ))}
        </section>
      )}

      <p class="mt-14">
        <a class="tag-link text-sm" href="/tags">
          &larr; All tags
        </a>
      </p>
    </Layout>
  );
}
