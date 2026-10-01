/**
 * Docs detail page — `/docs/<slug>`.
 *
 * Renders a single markdown document with a TOC rail and prev/next
 * navigation. `getStaticPaths` enumerates every non-draft doc slug so the
 * static export produces one `docs/<slug>/index.html` per doc.
 */

import type { RequestContext } from 'jsails';
import { build } from '../../src/content/index.js';

interface Neighbour {
  readonly slug: string;
  readonly title: string;
}

interface DocPageProps {
  title: string;
  html: string;
  toc: { depth: number; id: string; text: string }[];
  prev: Neighbour | null;
  next: Neighbour | null;
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

  // Resolve neighbour slugs to titles so the prev/next cards read as prose
  // rather than displaying raw file-system slugs.
  const prev = resolvedNeighbour(graph, pn?.prev);
  const next = resolvedNeighbour(graph, pn?.next);

  return {
    title: doc.title,
    html: doc.html,
    toc: doc.toc,
    prev,
    next,
  };
}

/** Resolve a neighbour slug to a titled card, or `null` when absent. */
function resolvedNeighbour(
  graph: Awaited<ReturnType<typeof build>>,
  slug: string | null | undefined,
): { slug: string; title: string } | null {
  if (slug === null || slug === undefined) return null;
  const page = graph.index.get(slug);
  return { slug, title: page?.title ?? slug };
}

export default function DocPage({ title, html, toc, prev, next }: DocPageProps) {
  return (
    <div class="flex items-start gap-12">
      <div class="min-w-0 flex-1">
        {/* Breadcrumbs */}
        <div class="breadcrumbs mb-4 p-0 text-sm">
          <ul>
            <li>
              <a href="/docs" class="text-base-content/60 no-underline hover:text-primary">
                Docs
              </a>
            </li>
            <li class="text-base-content/80">{title}</li>
          </ul>
        </div>

        <h1 class="mb-6 font-serif text-4xl font-semibold tracking-tight text-base-content">
          {title}
        </h1>
        <article class="prose" dangerouslySetInnerHTML={{ __html: html }} />

        {/* Prev / next — daisyUI cards. */}
        <nav class="mt-16 grid gap-4 border-t border-base-300 pt-9 sm:grid-cols-2">
          {prev ? (
            <a
              class="card group border border-base-300 bg-base-100 no-underline transition-all hover:-translate-x-0.5 hover:border-primary/40 hover:shadow-md"
              href={`/docs/${prev.slug}`}
            >
              <div class="card-body gap-1 p-5">
                <span class="text-[0.6875rem] font-bold uppercase tracking-wider text-base-content/50">
                  ← Previous
                </span>
                <span class="font-semibold text-base-content group-hover:text-primary">
                  {prev.title}
                </span>
              </div>
            </a>
          ) : (
            <span class="hidden sm:block" />
          )}
          {next ? (
            <a
              class="card group items-end border border-base-300 bg-base-100 text-right no-underline transition-all hover:translate-x-0.5 hover:border-primary/40 hover:shadow-md"
              href={`/docs/${next.slug}`}
            >
              <div class="card-body items-end gap-1 p-5">
                <span class="text-[0.6875rem] font-bold uppercase tracking-wider text-base-content/50">
                  Next →
                </span>
                <span class="font-semibold text-base-content group-hover:text-primary">
                  {next.title}
                </span>
              </div>
            </a>
          ) : (
            <span class="hidden sm:block" />
          )}
        </nav>
      </div>

      {/* On-this-page TOC rail. */}
      {toc.length > 0 ? (
        <aside class="toc-rail hidden lg:block" aria-label="On this page">
          <h2 class="mb-3 text-[0.6875rem] font-bold uppercase tracking-widest text-base-content/50">
            On this page
          </h2>
          <nav>
            <ul>
              {toc.map((heading) => (
                <li key={heading.id} style={`padding-left: ${(heading.depth - 2) * 1}rem`}>
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
