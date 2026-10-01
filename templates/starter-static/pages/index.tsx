/**
 * Static-blog home page.
 *
 * A typographic hero, one featured post, and the recent list. The post list
 * comes from `blogIndex(posts)`, which the content layer sorts newest-first and
 * returns non-draft pages only. `posts` and `tags` are autoloaded symbols (from
 * `server/content.ts`), so they resolve without an import and share the single
 * discovery pass with every other page.
 *
 * The only imports left are the framework's `jsails`/`jsails/content` helpers,
 * which are not part of the project's autoload set, plus the type-only
 * `LayoutAssets` (interfaces carry no runtime value, so they are not
 * autoloaded). `jsails/content` is server-only and never reaches the browser
 * bundle.
 */

import type { RequestContext } from 'jsails';
import type { PageMetadata } from 'jsails/seo';
import type { ContentPage } from 'jsails/content';

import type { LayoutAssets } from '../ui/layout.js';

/** Head metadata for the home page. `SITE_TITLE`/`SITE_DESCRIPTION` are autoloaded. */
export const metadata: PageMetadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  canonical: '/',
};

export interface IndexPageProps {
  /** Newest posts, paired with their derived reading time. */
  entries: readonly { page: ContentPage; minutes: number }[];
  /** Tag term slug lookup, so a card's badges link to the right term page. */
  tagSlugFor: (tag: string) => string;
  /** Resolved asset URLs, produced in `load` and forwarded to the layout. */
  assets?: LayoutAssets;
}

export async function load(context: RequestContext): Promise<IndexPageProps> {
  const assets = await loadLayout(context);
  const newest = blogIndex(posts, { limit: 10 });
  return {
    entries: newest.map((page) => ({ page, minutes: readingTime(page) })),
    tagSlugFor: (tag) => tags.getTerm(tag.toLowerCase())?.slug ?? tag.toLowerCase(),
    assets,
  };
}

export default function IndexPage({ entries, tagSlugFor, assets }: IndexPageProps) {
  const [featured, ...recent] = entries;
  const featuredDate = featured ? formatDate(featured.page.date) : undefined;

  return (
    <Layout assets={assets}>
      <section class="mb-14">
        <p class="eyebrow mb-5">Essays on small, typed software</p>
        <h1 class="display max-w-2xl text-5xl sm:text-6xl">{SITE_TITLE}</h1>
        <p class="mt-6 max-w-prose text-lg text-base-content/65">{SITE_DESCRIPTION}</p>
        <hr class="rule mt-10" />
      </section>

      {featured === undefined ? (
        <p class="text-base-content/60">No posts yet.</p>
      ) : (
        <>
          <section class="mb-16">
            <p class="eyebrow mb-4">Latest</p>
            <article>
              <h2 class="display max-w-2xl text-3xl sm:text-4xl">
                <a
                  class="post-title inline-block text-base-content"
                  href={`/blog/${featured.page.slug}`}
                >
                  {featured.page.title}
                </a>
              </h2>
              <p class="tabular mt-4 text-xs text-base-content/45">
                {[featuredDate, `${featured.minutes} min read`]
                  .filter((part): part is string => typeof part === 'string' && part.length > 0)
                  .join('  \u00b7  ')}
              </p>
              {featured.page.excerpt !== undefined && featured.page.excerpt.length > 0 ? (
                <p class="mt-4 max-w-prose text-lg text-base-content/75">{featured.page.excerpt}</p>
              ) : null}
              {featured.page.tags.length > 0 ? (
                <ul class="mt-5 flex flex-wrap gap-x-4 gap-y-1">
                  {featured.page.tags.map((tag) => (
                    <li key={tag}>
                      <TagBadge tag={tag} slug={tagSlugFor(tag)} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          </section>

          {recent.length > 0 ? (
            <section>
              <p class="eyebrow mb-6">More posts</p>
              <div class="space-y-7">
                {recent.map(({ page, minutes }) => (
                  <PostCard
                    key={page.slug}
                    page={page}
                    readingMinutes={minutes}
                    tagSlugFor={tagSlugFor}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}

      <p class="mt-14">
        <a class="tag-link text-sm" href="/blog">
          Browse the full archive &rarr;
        </a>
      </p>
    </Layout>
  );
}
