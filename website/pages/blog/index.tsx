/**
 * Blog list page — `/blog`.
 *
 * Lists all non-draft blog posts sorted by date (newest first).
 * `buildBlog()` yields posts already in date-descending order.
 */

import { buildBlog } from '../../src/content/index.js';

interface BlogListProps {
  posts: {
    slug: string;
    title: string;
    date: string;
    excerpt?: string;
    tags: readonly string[];
  }[];
}

export async function load(): Promise<BlogListProps> {
  const blog = await buildBlog();
  return {
    posts: blog.posts
      .filter((p) => !p.draft)
      .map((p) => ({
        slug: p.slug,
        title: p.title,
        date: p.date,
        excerpt: p.excerpt,
        tags: p.tags,
      })),
  };
}

export default function BlogIndex({ posts }: BlogListProps) {
  return (
    <div class="mx-auto max-w-3xl">
      <h1 class="mb-8 font-serif text-4xl font-semibold tracking-tight text-base-content">Blog</h1>
      {posts.length === 0 ? (
        <p class="text-base-content/70">No posts yet.</p>
      ) : (
        <div class="grid gap-5">
          {posts.map((post) => (
            <article
              key={post.slug}
              class="card border border-base-300 bg-base-100 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
            >
              <div class="card-body gap-2 p-6">
                <time
                  datetime={post.date}
                  class="text-xs font-semibold uppercase tracking-wider text-base-content/50"
                >
                  {post.date}
                </time>
                <h2 class="card-title font-serif text-2xl font-semibold">
                  <a
                    href={`/blog/${post.slug}`}
                    class="text-base-content no-underline transition-colors hover:text-primary"
                  >
                    {post.title}
                  </a>
                </h2>
                {post.excerpt ? <p class="text-base-content/70">{post.excerpt}</p> : null}
                {post.tags.length > 0 ? (
                  <div class="mt-1 flex flex-wrap gap-1.5">
                    {post.tags.map((t) => (
                      <span key={t} class="badge badge-primary badge-outline badge-sm">
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
