/**
 * Starter about page.
 *
 * A second, static page rendered through the shared document shell. It has no
 * island, no backend action, and no client state — only normal links. The
 * browser client owns navigation, so the back link and the hash anchor are
 * ordinary `<a href>` elements.
 */

import type { RequestContext } from 'jsails';

import { Layout, loadLayout, type LayoutAssets } from '../ui/layout.js';

export interface AboutPageProps {
  /** Resolved asset URLs, produced in `load` and forwarded to the layout. */
  assets?: LayoutAssets;
  /** The current request path, used to mark the active nav link. */
  path?: string;
}

export async function load(context: RequestContext): Promise<AboutPageProps> {
  return { assets: await loadLayout(context), path: context.url.pathname };
}

export default function AboutPage({ assets, path }: AboutPageProps) {
  return (
    <Layout title="About — JSails Starter" assets={assets} path={path}>
      <header class="flex flex-col gap-3">
        <span class="text-xs font-medium uppercase tracking-wider text-base-content/50">
          How it works
        </span>
        <h1 class="text-4xl font-bold tracking-tight">About</h1>
        <p class="max-w-2xl text-base-content/65">
          A second page served by JSails. It has no backend actions — just static markup and normal
          links.
        </p>
      </header>

      <section id="about" class="mt-8 grid gap-6 sm:grid-cols-2">
        <div class="card border border-base-300/70 bg-base-100 shadow-sm">
          <div class="card-body gap-2">
            <h2 class="card-title text-lg">Client-owned navigation</h2>
            <p class="text-sm text-base-content/70">
              Navigation between pages is handled by the browser client. Ordinary links become fast
              in-place navigations, and the counter island lives only on the home page.
            </p>
          </div>
        </div>

        <div class="card border border-base-300/70 bg-base-100 shadow-sm">
          <div class="card-body gap-2">
            <h2 class="card-title text-lg">Server-owned state</h2>
            <p class="text-sm text-base-content/70">
              The task list is a server component: its state is carried in a signed snapshot and
              updated through a backend action, with no database required.
            </p>
          </div>
        </div>
      </section>

      <div class="mt-8 flex flex-wrap gap-3">
        <a class="btn btn-primary" href="/">
          Back to home
        </a>
        <a class="btn btn-outline" href="/#counter-root">
          Jump to the counter
        </a>
      </div>
    </Layout>
  );
}
