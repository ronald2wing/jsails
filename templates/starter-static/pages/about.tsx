/**
 * Static-blog about page.
 *
 * Renders the single-entry `about` collection from the shared content config.
 * The Markdown body is trusted producer HTML (authored in the repo, rendered at
 * build time), so `Prose` injects it without sanitizing — the documented trust
 * model for `jsails/content`.
 */

import type { RequestContext } from 'jsails';
import type { PageMetadata } from 'jsails/seo';
import type { ContentPage } from 'jsails/content';

import type { LayoutAssets } from '../ui/layout.js';

/** Head metadata: uses the resolved about page's title and excerpt when present. */
export function generateMetadata(_context: RequestContext): PageMetadata {
  const page = about.getEntry('about');
  return {
    title: page === undefined ? `About — ${SITE_TITLE}` : `${page.title} — ${SITE_TITLE}`,
    description: page?.excerpt,
    canonical: '/about',
  };
}

export interface AboutPageProps {
  /** The about page, or `null` when the collection is empty. */
  readonly page: ContentPage | null;
  readonly minutes: number;
  readonly assets?: LayoutAssets;
}

export async function load(context: RequestContext): Promise<AboutPageProps> {
  const assets = await loadLayout(context);
  const page = about.getEntry('about');
  return { page: page ?? null, minutes: page ? readingTime(page) : 0, assets };
}

export default function AboutPage({ page, minutes, assets }: AboutPageProps) {
  if (page === null) {
    return (
      <Layout assets={assets}>
        <header class="mb-10">
          <p class="eyebrow mb-4">About</p>
          <h1 class="display text-4xl sm:text-5xl">About</h1>
          <hr class="rule mt-8" />
        </header>
        <p class="text-base-content/60">No about page has been written yet.</p>
      </Layout>
    );
  }

  return (
    <Layout assets={assets}>
      <article>
        <header class="mb-10">
          <p class="eyebrow mb-4">About</p>
          <h1 class="display text-4xl sm:text-5xl">{page.title}</h1>
          {page.excerpt !== undefined && page.excerpt.length > 0 ? (
            <p class="mt-4 max-w-prose text-lg text-base-content/65">{page.excerpt}</p>
          ) : null}
          <p class="tabular mt-5 text-xs text-base-content/45">{minutes} min read</p>
          <hr class="rule mt-8" />
        </header>
        <Prose html={page.html} />
      </article>
    </Layout>
  );
}
