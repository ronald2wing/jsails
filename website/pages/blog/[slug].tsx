/**
 * Blog post detail page — `/blog/<slug>`.
 *
 * Renders a single blog post with tags and the same markdown+Shiki rendering
 * approach as docs pages.
 */

import type { RequestContext } from 'jsails';
import { buildBlog } from '../../src/content/index.js';

interface BlogPostProps {
  title: string;
  date: string;
  html: string;
  tags: readonly string[];
  toc: { depth: number; id: string; text: string }[];
}

export async function getStaticPaths() {
  const blog = await buildBlog();
  return blog.posts.filter((p) => !p.draft).map((p) => ({ slug: p.slug }));
}

export async function load(context: RequestContext): Promise<BlogPostProps> {
  const blog = await buildBlog();
  const post = blog.bySlug.get(context.params.slug);

  if (!post) {
    throw new Error(`Blog post not found: ${context.params.slug}`);
  }

  return {
    title: post.title,
    date: post.date,
    html: post.html,
    tags: post.tags,
    toc: post.toc,
  };
}

export default function BlogPost({ title, date, html, tags, toc }: BlogPostProps) {
  return (
    <div>
      <article>
        <h1>{title}</h1>
        <time datetime={date}>{date}</time>
        {tags.length > 0 ? (
          <p>
            Tags:{' '}
            {tags.map((t) => (
              <span key={t}>{t} </span>
            ))}
          </p>
        ) : null}
        <div class="prose" dangerouslySetInnerHTML={{ __html: html }} />
      </article>
      {toc.length > 0 ? (
        <aside>
          <h2>On this page</h2>
          <nav>
            <ul>
              {toc.map((heading) => (
                <li key={heading.id} style={`padding-left: ${(heading.depth - 1) * 1}rem`}>
                  <a href={`#${heading.id}`}>{heading.text}</a>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
      ) : null}
    </div>
  );
}
