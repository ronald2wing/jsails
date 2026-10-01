/**
 * Static-blog category index.
 *
 * Lists every category from the shared taxonomy in its configured order (weight,
 * defaulting to `page.order`, then alphabetical). Unlike the tag cloud, this
 * page renders the taxonomy's own term order — no `tagIndex` re-sort — so the
 * categories surface reflects how the content config ordered them.
 */

import type { RequestContext } from 'jsails';
import type { PageMetadata } from 'jsails/seo';

import type { LayoutAssets } from '../../ui/layout.js';

/** Head metadata for the category index. `SITE_TITLE` is autoloaded. */
export const metadata: PageMetadata = {
  title: `Categories — ${SITE_TITLE}`,
  canonical: '/categories',
};

export interface CategoriesPageProps {
  readonly terms: readonly { term: string; slug: string; count: number }[];
  readonly assets?: LayoutAssets;
}

export async function load(context: RequestContext): Promise<CategoriesPageProps> {
  const assets = await loadLayout(context);
  return {
    terms: categories.terms.map(({ term, slug, count }) => ({ term, slug, count })),
    assets,
  };
}

export default function CategoriesPage({ terms, assets }: CategoriesPageProps) {
  return (
    <Layout assets={assets}>
      <header class="mb-12">
        <p class="eyebrow mb-4">Topics</p>
        <h1 class="display text-4xl sm:text-5xl">Categories</h1>
        <p class="mt-4 max-w-prose text-lg text-base-content/65">
          Broad themes that group the essays.
        </p>
        <hr class="rule mt-8" />
      </header>

      {terms.length === 0 ? (
        <p class="text-base-content/60">No categories yet.</p>
      ) : (
        <ul class="divide-y divide-base-300">
          {terms.map(({ term, slug, count }) => (
            <li key={slug} class="flex items-baseline justify-between gap-4 py-4">
              <a
                class="font-serif text-lg text-base-content/85 transition-colors hover:text-primary"
                href={`/categories/${slug}`}
              >
                {term}
              </a>
              <span class="tabular text-sm text-base-content/40">
                {count} {count === 1 ? 'post' : 'posts'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}
