/**
 * Static-blog category detail page.
 *
 * `getStaticPaths()` enumerates every category slug; `load` resolves the term and
 * its pages. An unknown term renders an empty state — defensive only, since the
 * static export enumerates real terms.
 */

import type { RequestContext } from 'jsails';
import type { PageMetadata } from 'jsails/seo';
import type { ContentPage } from 'jsails/content';

import type { LayoutAssets } from '../../ui/layout.js';

/** Static export enumerates every taxonomy term slug. */
export function getStaticPaths() {
  return categories.getStaticPaths();
}

/** Head metadata for one category: uses the resolved term label, or a generic title. */
export function generateMetadata(context: RequestContext): PageMetadata {
  const term = categories.getTerm(context.params.term);
  return {
    title: term === undefined ? `Categories — ${SITE_TITLE}` : `${term.term} — ${SITE_TITLE}`,
    canonical: `/categories/${context.params.term}`,
  };
}

export interface CategoryPageProps {
  /** The raw category label, or '' when the term is unknown. */
  readonly term: string;
  readonly entries: readonly { page: ContentPage; minutes: number }[];
  readonly assets?: LayoutAssets;
}

export async function load(context: RequestContext): Promise<CategoryPageProps> {
  const assets = await loadLayout(context);
  const resolved = categories.getTerm(context.params.term);
  if (resolved === undefined) {
    return { term: '', entries: [], assets };
  }
  return {
    term: resolved.term,
    entries: resolved.pages.map((page) => ({ page, minutes: readingTime(page) })),
    assets,
  };
}

export default function CategoryPage({ term, entries, assets }: CategoryPageProps) {
  const label = term || 'unknown';
  const count = entries.length;

  return (
    <Layout assets={assets}>
      <header class="mb-12">
        <p class="eyebrow mb-4">Category</p>
        <h1 class="display text-4xl sm:text-5xl">{label}</h1>
        <p class="tabular mt-4 text-sm text-base-content/50">
          {count} {count === 1 ? 'post' : 'posts'}
        </p>
        <hr class="rule mt-8" />
      </header>

      {count === 0 ? (
        <p class="text-base-content/60">
          No posts in this category.{' '}
          <a class="text-primary underline underline-offset-2" href="/categories">
            See all categories
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
        <a class="tag-link text-sm" href="/categories">
          &larr; All categories
        </a>
      </p>
    </Layout>
  );
}
