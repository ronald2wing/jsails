/**
 * Static-blog archive page.
 *
 * Every non-draft post, grouped by year of publication. `blogIndex(posts)`
 * returns them newest-first, so grouping preserves that order without a second
 * sort. The `tags` taxonomy supplies term slugs for the per-post tag badges.
 *
 * `posts` and `tags` are autoloaded symbols (from `server/content.ts`), so they
 * resolve without an import and share the single discovery pass with every
 * other page.
 */

import type { RequestContext } from 'jsails';
import type { PageMetadata } from 'jsails/seo';
import type { ContentPage } from 'jsails/content';

import type { LayoutAssets } from '../../ui/layout.js';

/** Head metadata for the archive page. `SITE_TITLE` is autoloaded. */
export const metadata: PageMetadata = {
  title: `Archive — ${SITE_TITLE}`,
  canonical: '/blog',
};

/** One year's worth of posts, newest-first within the year. */
interface YearGroup {
  readonly year: string;
  readonly entries: readonly { page: ContentPage; minutes: number }[];
}

export interface BlogIndexProps {
  readonly groups: readonly YearGroup[];
  readonly tagSlugFor: (tag: string) => string;
  readonly assets?: LayoutAssets;
}

/** Group the newest-first list into year buckets, preserving order. */
function groupByYear(entries: readonly { page: ContentPage; minutes: number }[]): YearGroup[] {
  const groups: YearGroup[] = [];
  for (const entry of entries) {
    const year = entry.page.date?.slice(0, 4) ?? 'Undated';
    const current = groups[groups.length - 1];
    if (current?.year === year) {
      (current.entries as { page: ContentPage; minutes: number }[]).push(entry);
    } else {
      groups.push({ year, entries: [entry] });
    }
  }
  return groups;
}

export async function load(context: RequestContext): Promise<BlogIndexProps> {
  const assets = await loadLayout(context);
  const newest = blogIndex(posts);
  return {
    groups: groupByYear(newest.map((page) => ({ page, minutes: readingTime(page) }))),
    tagSlugFor: (tag) => tags.getTerm(tag.toLowerCase())?.slug ?? tag.toLowerCase(),
    assets,
  };
}

export default function BlogIndexPage({ groups, tagSlugFor, assets }: BlogIndexProps) {
  const total = groups.reduce((sum, group) => sum + group.entries.length, 0);

  return (
    <Layout assets={assets}>
      <header class="mb-12">
        <p class="eyebrow mb-4">Archive</p>
        <h1 class="display text-4xl sm:text-5xl">Every post</h1>
        <p class="mt-4 max-w-prose text-lg text-base-content/65">
          {total} {total === 1 ? 'essay' : 'essays'}, newest first. Browse by topic from the{' '}
          <a class="text-primary underline underline-offset-2" href="/tags">
            tags page
          </a>
          .
        </p>
        <hr class="rule mt-8" />
      </header>

      {groups.length === 0 ? (
        <p class="text-base-content/60">No posts yet.</p>
      ) : (
        <div class="space-y-16">
          {groups.map((group) => (
            <section key={group.year} class="post-row">
              <h2 class="display text-3xl text-base-content/30 sm:text-4xl">{group.year}</h2>
              <div class="space-y-7">
                {group.entries.map(({ page, minutes }) => (
                  <PostCard
                    key={page.slug}
                    page={page}
                    readingMinutes={minutes}
                    tagSlugFor={tagSlugFor}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </Layout>
  );
}
