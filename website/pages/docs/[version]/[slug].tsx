/**
 * Versioned docs detail page — `/docs/<version>/<slug>` for a frozen release.
 *
 * Resolves the doc from the frozen content tree (`content/versions/<version>/`)
 * and renders it with within-version prev/next navigation. `getStaticPaths`
 * enumerates (version, slug) pairs across every released version except the
 * latest release (which lives at the unversioned `/docs/<slug>`).
 */

import type { RequestContext } from 'jsails';
import { build } from '../../../src/content/index.js';
import { readDocsVersions } from '../../../src/content/versions.js';

interface DocPageProps {
  title: string;
  html: string;
  toc: { depth: number; id: string; text: string }[];
  prev: string | null;
  next: string | null;
  version: string;
}

export async function getStaticPaths() {
  const manifest = readDocsVersions();
  // Every released minor except the current (latest) one, which stays at the
  // unversioned /docs/<slug> route.
  const frozen = manifest.versions.filter((v) => v.label !== manifest.current);
  const paths: { version: string; slug: string }[] = [];
  for (const v of frozen) {
    const graph = await build(v.label);
    for (const doc of graph.docs) {
      paths.push({ version: v.label, slug: doc.slug });
    }
  }
  return paths;
}

export async function load(context: RequestContext): Promise<DocPageProps> {
  const version = context.params.version;
  const graph = await build(version);
  const doc = graph.index.get(context.params.slug);

  if (!doc) {
    throw new Error(`Document not found: ${version}/${context.params.slug}`);
  }

  const pn = graph.prevNext.get(doc.slug);

  return {
    title: doc.title,
    html: doc.html,
    toc: doc.toc,
    prev: pn?.prev ?? null,
    next: pn?.next ?? null,
    version,
  };
}

export default function VersionedDocPage({ title, html, toc, prev, next, version }: DocPageProps) {
  return (
    <div class="docs-layout">
      <aside class="docs-sidebar">
        <div class="docs-version-banner">
          Browsing docs for version {version} —{' '}
          <a href="/docs">see the latest ({version === 'latest' ? 'current' : '1.0'})</a>
        </div>
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
            <a class="prev-link" href={`/docs/${version}/${prev}`}>
              Previous: {prev}
            </a>
          ) : (
            <span class="prev-link disabled" />
          )}
          {next ? (
            <a class="next-link" href={`/docs/${version}/${next}`}>
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
