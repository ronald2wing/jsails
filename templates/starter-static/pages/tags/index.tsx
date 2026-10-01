/**
 * Static-blog tag cloud.
 *
 * Lists every tag from the shared taxonomy, sorted by post count (most common
 * first) with alphabetical tiebreaking. `tagIndex(tags)` supplies that order.
 *
 * The cloud is weighted: each term's font size and opacity scale with its post
 * count, so the most-used topics read as the largest words. The scale is
 * normalized against the min and max counts in the current set, so a small blog
 * still shows visible contrast.
 */

import type { RequestContext } from 'jsails';
import type { PageMetadata } from 'jsails/seo';

import type { LayoutAssets } from '../../ui/layout.js';

/** Head metadata for the tag cloud. `SITE_TITLE` is autoloaded. */
export const metadata: PageMetadata = {
  title: `Tags — ${SITE_TITLE}`,
  canonical: '/tags',
};

export interface TagsPageProps {
  readonly terms: readonly { term: string; slug: string; count: number }[];
  readonly assets?: LayoutAssets;
}

export async function load(context: RequestContext): Promise<TagsPageProps> {
  const assets = await loadLayout(context);
  return {
    terms: tagIndex(tags).map(({ term, slug, count }) => ({ term, slug, count })),
    assets,
  };
}

/**
 * Map a count to a font size in rem, normalized across the set.
 *
 * A single-term set (or a flat distribution) collapses to the middle size so
 * the cloud never renders one giant word against a wall of tiny ones.
 */
function weightFor(count: number, min: number, max: number): number {
  if (max <= min) return 1.5;
  const ratio = (count - min) / (max - min);
  return 1.1 + ratio * 1.4;
}

export default function TagsPage({ terms, assets }: TagsPageProps) {
  const counts = terms.map((term) => term.count);
  const min = counts.length > 0 ? Math.min(...counts) : 0;
  const max = counts.length > 0 ? Math.max(...counts) : 0;

  return (
    <Layout assets={assets}>
      <header class="mb-12">
        <p class="eyebrow mb-4">Topics</p>
        <h1 class="display text-4xl sm:text-5xl">Tags</h1>
        <p class="mt-4 max-w-prose text-lg text-base-content/65">
          Every topic covered on the blog. Larger words appear in more posts.
        </p>
        <hr class="rule mt-8" />
      </header>

      {terms.length === 0 ? (
        <p class="text-base-content/60">No tags yet.</p>
      ) : (
        <ul class="flex flex-wrap items-baseline gap-x-6 gap-y-4">
          {terms.map(({ term, slug, count }) => (
            <li key={slug}>
              <a
                class="font-serif leading-none text-base-content/70 transition-colors hover:text-primary"
                href={`/tags/${slug}`}
                style={{ fontSize: `${weightFor(count, min, max)}rem` }}
              >
                {term}
                <span class="tabular ml-1.5 align-super text-xs text-base-content/40">{count}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}
