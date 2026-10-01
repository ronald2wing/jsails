/**
 * Content configuration for the static blog.
 *
 * Defines the post collection, its tag taxonomy, and the standalone about
 * collection ONCE, then exports them so every page shares a single discovery
 * pass. `discoverContent` is memoized per directory, so importing this module
 * from several pages still reads and renders each Markdown file once.
 *
 * This module lives under `server/`, so it is autoloaded: `tsc` compiles it to
 * `dist/server/content.js`, the build emits a shim that publishes `posts`,
 * `tags`, `categories`, and `about` onto `globalThis`, and pages reference them
 * by bare name with no import. The feed script reaches the same compiled module
 * through the generated `.jsails/project-symbols.js` preload.
 *
 * `defineContentCollection` and `defineTaxonomies` are framework globals, so
 * they too resolve without an import. `zod` is a third-party package, not part
 * of the framework surface, so `z` stays an explicit import.
 *
 * `jsails/content` is server-only: it must never be imported by `client/` or
 * anything bundled for the browser.
 */

import { z } from 'zod';

/** The post frontmatter contract. A malformed entry fails the build. */
const postSchema = z.object({
  title: z.string(),
  date: z.string(),
  tags: z.array(z.string()).default([]),
  category: z.string().optional(),
  excerpt: z.string().optional(),
});

/** Every Markdown post, newest-first is derived by `blogIndex`. */
export const posts = await defineContentCollection({
  dir: 'content/posts',
  route: '[slug]',
  schema: postSchema,
});

/**
 * Tag and category taxonomies over the post collection, defined in one call.
 *
 * Tags sort by post count (the cloud's most-common-first order); categories
 * sort by weight (defaulting to `page.order`, then alphabetical), so the two
 * surfaces stay distinct without a second discovery pass.
 */
export const taxonomy = defineTaxonomies({
  collection: posts,
  taxonomies: [
    { name: 'tags', field: 'tags', route: '/tags/[term]', order: 'count' },
    { name: 'categories', field: 'category', route: '/categories/[term]', order: 'weight' },
  ],
});

/** Named aliases so pages read `tags`/`categories` directly, not `taxonomy.get(...)`. */
export const tags = taxonomy.get('tags')!;
export const categories = taxonomy.get('categories')!;

/** The single about page, rendered by `pages/about.tsx`. */
export const about = await defineContentCollection({ dir: 'content/about', route: '[slug]' });
