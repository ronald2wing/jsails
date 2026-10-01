/**
 * Starter blog detail page (static-export / SSG surface).
 *
 * Resolves one post by its route parameter (the numeric post id) from the
 * shared store, or renders a "not found" state when the store is absent or the
 * id is unknown. The live interactive surface is the blog plugin's hook routes;
 * this page is the SSG counterpart, reachable live at `/blog/:id` during
 * `serve` (the plugin only shadows `/blog`, not the detail route).
 */

import type { RequestContext } from 'jsails';
import { blogPostsToken, type BlogPost } from 'jsails/blog';

import { Layout, loadLayout, type LayoutAssets } from '../ui/layout.js';

export interface BlogPostPageProps {
  /** The resolved post, or `null` when absent (renders a "not found" state). */
  post: BlogPost | null;
  /** Resolved asset URLs, produced in `load` and forwarded to the layout. */
  assets?: LayoutAssets;
}

/**
 * The static export enumerates detail pages here. The shared store is
 * database-backed, and the build has no request context and must not open a
 * database connection, so no detail pages are generated; a deployment that
 * wants SSG detail pages could seed a store the build is allowed to read and
 * enumerate its post ids here instead.
 */
export function getStaticPaths(): Array<Record<string, string>> {
  return [];
}

/** Look up the post named by `context.params.slug`, or `null`. */
async function findPost(context: RequestContext): Promise<BlogPost | null> {
  // Static export has no request context and must not open a database
  // connection, so it never queries the store.
  if (context.renderMode === 'static') {
    return null;
  }
  const store = context.services?.tryGet(blogPostsToken);
  if (store === undefined) {
    return null;
  }
  const id = Number(context.params.slug);
  if (!Number.isSafeInteger(id)) {
    return null;
  }
  return (await store.get(id)) ?? null;
}

export async function load(context: RequestContext): Promise<BlogPostPageProps> {
  const [post, assets] = await Promise.all([findPost(context), loadLayout(context)]);
  return { post, assets };
}

export default function BlogPostPage({ post, assets }: BlogPostPageProps) {
  return (
    <Layout title="Post — JSails Starter" assets={assets}>
      {post === null ? (
        <p class="text-base-content/70">Post not found.</p>
      ) : (
        <article class="w-full space-y-4">
          <header>
            <h1 class="text-4xl font-bold tracking-tight">{post.title}</h1>
          </header>
          <p class="whitespace-pre-wrap">{post.body}</p>
          <footer class="text-sm text-base-content/60">
            <a class="link" href="/blog">
              Back to blog
            </a>
          </footer>
        </article>
      )}
    </Layout>
  );
}
