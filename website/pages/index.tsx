/**
 * Docs site home page.
 *
 * Lists all available documentation pages from the content pipeline.
 * Uses `load()` to read the prebuilt content graph so the build step
 * runs the single-pass `build()` exactly once.
 */

import { build } from '../src/content/index.js';

interface HomeProps {
  docs: { slug: string; title: string }[];
}

export async function load(): Promise<HomeProps> {
  const graph = await build();
  return {
    docs: graph.docs.map((d) => ({ slug: d.slug, title: d.title })),
  };
}

export default function HomePage({ docs }: HomeProps) {
  return (
    <div class="docs-home">
      <h1>Documentation</h1>
      <ul>
        {docs.map((doc) => (
          <li key={doc.slug}>
            <a href={`/docs/${doc.slug}`}>{doc.title}</a>
          </li>
        ))}
      </ul>
      <p>
        <a href="/blog">Blog</a>
      </p>
    </div>
  );
}
