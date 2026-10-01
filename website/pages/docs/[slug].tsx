/**
 * Docs detail page — `/docs/<slug>`.
 *
 * Renders a single markdown document with a TOC sidebar and prev/next
 * navigation. `getStaticPaths` enumerates every non-draft doc slug so the
 * static export produces one `docs/<slug>/index.html` per doc.
 */

import type { RequestContext } from 'jsails';
import { build } from '../../src/content/index.js';

interface DocPageProps {
  title: string;
  html: string;
  toc: { depth: number; id: string; text: string }[];
  prev: string | null;
  next: string | null;
}

export async function getStaticPaths() {
  const graph = await build();
  return graph.docs.map((doc) => ({ slug: doc.slug }));
}

export async function load(context: RequestContext): Promise<DocPageProps> {
  const graph = await build();
  const doc = graph.index.get(context.params.slug);

  if (!doc) {
    throw new Error(`Document not found: ${context.params.slug}`);
  }

  const pn = graph.prevNext.get(doc.slug);

  return {
    title: doc.title,
    html: doc.html,
    toc: doc.toc,
    prev: pn?.prev ?? null,
    next: pn?.next ?? null,
  };
}

export default function DocPage({ title, html, toc, prev, next }: DocPageProps) {
  return (
    <div class="docs-layout">
      <aside class="docs-sidebar">
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
      <main class="docs-content">
        <h1>{title}</h1>
        <article class="prose" dangerouslySetInnerHTML={{ __html: html }} />
        <nav class="prev-next">
          {prev ? (
            <a class="prev-link" href={`/docs/${prev}`}>
              Previous: {prev}
            </a>
          ) : (
            <span class="prev-link disabled" />
          )}
          {next ? (
            <a class="next-link" href={`/docs/${next}`}>
              Next: {next}
            </a>
          ) : (
            <span class="next-link disabled" />
          )}
        </nav>
      </main>
    </div>
  );
}
