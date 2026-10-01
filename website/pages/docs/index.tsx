/**
 * Docs index — `/docs`.
 *
 * A landing page for the latest-release docs: lists every non-draft page in the
 * current version, ordered as the sidebar. (There is no bare `/docs` detail page;
 * the canonical per-doc URL is `/docs/<slug>` for latest and `/docs/<version>/<slug>`
 * for a frozen release.)
 */

import type { RequestContext } from 'jsails';
import { build } from '../../src/content/index.js';
import { readDocsVersions } from '../../src/content/versions.js';

interface DocsIndexProps {
  title: string;
  version: string;
  slugs: { slug: string; title: string }[];
}

export async function load(_context: RequestContext): Promise<DocsIndexProps> {
  const manifest = readDocsVersions();
  const graph = await build(manifest.current);
  return {
    title: 'Documentation',
    version: manifest.current,
    slugs: graph.docs.filter((d) => !d.draft).map((d) => ({ slug: d.slug, title: d.title })),
  };
}

export default function DocsIndex({ title, version, slugs }: DocsIndexProps) {
  return (
    <div class="mx-auto max-w-3xl">
      <h1 class="mb-3 font-serif text-4xl font-semibold tracking-tight text-base-content">
        {title}
      </h1>
      <p class="mb-8 text-base-content/70">
        JSails documentation — version <strong class="text-base-content">{version}</strong>. Browse
        the topics below.
      </p>
      <ul class="grid gap-2">
        {slugs.map((s) => (
          <li key={s.slug}>
            <a
              href={`/docs/${s.slug}`}
              class="group flex items-center justify-between gap-3 rounded-box border border-base-300 bg-base-100 px-5 py-3.5 font-semibold text-base-content no-underline transition-all hover:border-primary/40 hover:bg-primary/5 hover:shadow-sm"
            >
              <span>{s.title}</span>
              <span
                class="text-base-content/40 transition-transform group-hover:translate-x-1 group-hover:text-primary"
                aria-hidden="true"
              >
                →
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
