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
    <div class="flex items-start gap-12">
      <div class="min-w-0 flex-1">
        <article>
          <header class="mb-8">
            <time
              datetime={date}
              class="mb-2.5 inline-block text-xs font-semibold uppercase tracking-wider text-base-content/50"
            >
              {date}
            </time>
            <h1 class="mb-3.5 font-serif text-4xl font-semibold leading-tight tracking-tight text-base-content">
              {title}
            </h1>
            {tags.length > 0 ? (
              <div class="mt-3.5 flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <span key={t} class="badge badge-primary badge-outline badge-sm">
                    {t}
                  </span>
                ))}
              </div>
            ) : null}
          </header>
          <div class="prose" dangerouslySetInnerHTML={{ __html: html }} />
        </article>
      </div>

      {toc.length > 0 ? (
        <aside class="toc-rail hidden lg:block" aria-label="On this page">
          <h2 class="mb-3 text-[0.6875rem] font-bold uppercase tracking-widest text-base-content/50">
            On this page
          </h2>
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
