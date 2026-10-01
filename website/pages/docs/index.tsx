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
    <main class="docs-content">
      <h1>{title}</h1>
      <p>
        JSails documentation — version <strong>{version}</strong>. Browse the topics below.
      </p>
      <ul class="docs-toc-index">
        {slugs.map((s) => (
          <li key={s.slug}>
            <a href={`/docs/${s.slug}`}>{s.title}</a>
          </li>
        ))}
      </ul>
    </main>
  );
}
