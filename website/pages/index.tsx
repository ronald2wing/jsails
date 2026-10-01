/**
 * Docs site home page.
 *
 * The marketing entry point: an editorial hero, a quick-start terminal, a
 * feature grid, and a curated index into the documentation. Uses `load()` to
 * read the prebuilt content graph so the build step runs the single-pass
 * `build()` exactly once.
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

/** The value-prop grid. Kept inline: it is copy, not data. */
const FEATURES = [
  {
    title: 'Active Record data layer',
    body: 'TypeORM-backed entities, portable schema, linear migrations, transactions, and a composable query API.',
  },
  {
    title: 'Bounded application runtime',
    body: 'Pages, API routes, static export, jobs, broadcast, and a CLI — assembled from maintained libraries.',
  },
  {
    title: 'Extension system',
    body: 'Typed service tokens, HTTP hooks, and first-party plugins for auth, admin, blog, cache, and mail.',
  },
  {
    title: 'Server components',
    body: 'Signed, stateless state with backend actions — Livewire-like ergonomics without a bespoke renderer.',
  },
];

export default function HomePage({ docs }: HomeProps) {
  return (
    <div class="mx-auto max-w-5xl">
      {/* Hero */}
      <section class="hero-glow relative pb-2 pt-6">
        <p class="badge badge-primary badge-outline mb-5 font-semibold uppercase tracking-widest">
          Node.js framework
        </p>
        <h1 class="mb-6 font-serif text-4xl font-semibold leading-[1.05] tracking-tight text-base-content sm:text-5xl lg:text-6xl">
          The data layer and runtime
          <br />
          for <em class="not-italic text-primary">serious</em> Node apps.
        </h1>
        <p class="mb-9 max-w-[58ch] text-lg leading-relaxed text-base-content/70">
          JSails pairs a TypeORM-based Active Record layer with a bounded application runtime —
          extensions, HTTP and pages, jobs, broadcast, static export, and a CLI. It reuses
          maintained libraries instead of reinventing them.
        </p>
        <div class="mb-11 flex flex-wrap items-center gap-3">
          <a
            class="btn btn-primary btn-lg shadow-[var(--shadow-glow)]"
            href="/docs/getting-started"
          >
            Get started
          </a>
          <a class="btn btn-ghost btn-lg" href="/docs">
            Read the docs
            <span aria-hidden="true">→</span>
          </a>
        </div>

        {/* Quick-start terminal */}
        <div
          class="max-w-2xl overflow-hidden rounded-box border border-base-300 bg-base-200 shadow-[var(--shadow-lg)]"
          role="img"
          aria-label="Create a new JSails app"
        >
          <div class="flex h-9 items-center gap-1.5 border-b border-base-300 bg-[var(--color-chrome-bg)] px-3.5">
            <span class="terminal-dot terminal-dot-close" aria-hidden="true" />
            <span class="terminal-dot terminal-dot-min" aria-hidden="true" />
            <span class="terminal-dot terminal-dot-max" aria-hidden="true" />
            <span class="ml-2 font-mono text-[0.6875rem] text-base-content/50">shell</span>
          </div>
          <pre class="m-0 overflow-x-auto p-5 font-mono text-[0.8125rem] leading-[1.75]">
            <code>
              <span class="tok-prompt">$</span> npx jsails create my-app{' '}
              <span class="tok-flag">--install</span>
              {'\n'}
              <span class="tok-prompt">$</span> cd my-app <span class="tok-op">&amp;&amp;</span> npm
              run dev
            </code>
          </pre>
        </div>
      </section>

      {/* Feature grid */}
      <section class="mt-20">
        <h2 class="mb-5 text-xs font-bold uppercase tracking-widest text-base-content/50">
          What you get
        </h2>
        <div class="grid gap-4 sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              class="card border border-base-300 bg-base-100 transition-colors hover:border-primary/40"
            >
              <div class="card-body gap-2 p-5">
                <h3 class="card-title font-serif text-lg font-semibold">{feature.title}</h3>
                <p class="text-sm leading-relaxed text-base-content/70">{feature.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Documentation index */}
      <section class="mt-20">
        <h2 class="mb-5 text-xs font-bold uppercase tracking-widest text-base-content/50">
          Documentation
        </h2>
        <ul class="grid max-w-[var(--content-max)] gap-2">
          {docs.map((doc) => (
            <li key={doc.slug}>
              <a
                href={`/docs/${doc.slug}`}
                class="group flex items-center justify-between gap-3 rounded-box border border-base-300 bg-base-100 px-5 py-3.5 font-semibold text-base-content no-underline transition-all hover:border-primary/40 hover:bg-primary/5 hover:shadow-sm"
              >
                <span>{doc.title}</span>
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
        <p class="mt-7">
          <a href="/blog" class="link link-primary font-semibold no-underline hover:underline">
            Read the blog →
          </a>
        </p>
      </section>
    </div>
  );
}
