/**
 * Starter blog index page (static-export / SSG surface).
 *
 * Reads the shared post store through the `blogPostsToken` service when the
 * host wired services in (live `serve`), and degrades to an empty list when it
 * did not (static export, browser-free SSR). The store is database-backed, so a
 * static export never queries it: the build has no request context and must not
 * open a database connection, so this page renders an empty list during SSG.
 * The live interactive list/create surface is the blog plugin's own `GET /blog`
 * and `POST /blog/posts` hook routes, which shadow this page at `/blog` during
 * `serve`; the static export renders this page instead, so `/blog` still has an
 * SSG page.
 */

import type { RequestContext } from 'jsails';
import { blogPostsToken, type BlogPost } from 'jsails/blog';

import { Layout, loadLayout, type LayoutAssets } from '../ui/layout.js';

export interface BlogIndexProps {
  /** Posts in insertion order; empty when no store is wired in. */
  posts: readonly BlogPost[];
  /** Resolved asset URLs, produced in `load` and forwarded to the layout. */
  assets?: LayoutAssets;
}

/** Read the shared store for this request, or an empty list when absent. */
async function listPosts(context: RequestContext): Promise<readonly BlogPost[]> {
  // Static export has no request context and must not open a database
  // connection, so it never queries the store.
  if (context.renderMode === 'static') {
    return [];
  }
  const store = context.services?.tryGet(blogPostsToken);
  return store === undefined ? [] : store.list();
}

export async function load(context: RequestContext): Promise<BlogIndexProps> {
  const [posts, assets] = await Promise.all([listPosts(context), loadLayout(context)]);
  return { posts, assets };
}

export default function BlogIndexPage({ posts, assets }: BlogIndexProps) {
  return (
    <Layout title="Blog — JSails Starter" assets={assets}>
      <header class="text-center">
        <h1 class="text-4xl font-bold tracking-tight">Blog</h1>
        <p class="mt-2 text-base-content/70">
          Posts from the first-party blog plugin (<code>jsails/blog</code>).
        </p>
      </header>

      {posts.length === 0 ? (
        <p class="text-base-content/70">No posts yet.</p>
      ) : (
        <ul class="w-full space-y-2">
          {posts.map((post) => (
            <li key={post.id}>
              <a class="link" href={`/blog/${post.id}`}>
                {post.title}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}
