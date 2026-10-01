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
    <div class="blog-list">
      <h1>Blog</h1>
      {posts.length === 0 ? (
        <p>No posts yet.</p>
      ) : (
        posts.map((post) => (
          <article key={post.slug}>
            <h2>
              <a href={`/blog/${post.slug}`}>{post.title}</a>
            </h2>
            <time datetime={post.date}>{post.date}</time>
            {post.excerpt ? <p>{post.excerpt}</p> : null}
            {post.tags.length > 0 ? (
              <p>
                Tags:{' '}
                {post.tags.map((t) => (
                  <span key={t}>{t} </span>
                ))}
              </p>
            ) : null}
          </article>
        ))
      )}
    </div>
  );
}
