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
}

export async function load(context: RequestContext): Promise<AboutPageProps> {
  return { assets: await loadLayout(context) };
}

export default function AboutPage({ assets }: AboutPageProps) {
  return (
    <Layout title="About — JSails Starter" assets={assets}>
      <header class="text-center">
        <h1 class="text-4xl font-bold tracking-tight">About</h1>
        <p class="mt-2 text-base-content/70">
          A second page served by JSails. It has no backend actions — just static markup and normal
          links.
        </p>
      </header>

      <section id="about" class="card w-full bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title">What this demonstrates</h2>
          <p>
            Navigation between pages is handled by the browser client. The counter island lives only
            on the home page.
          </p>
          <div class="card-actions">
            <a class="btn btn-primary" href="/">
              Back to home
            </a>
            <a class="btn btn-outline" href="/#counter-root">
              Jump to the counter
            </a>
          </div>
        </div>
      </section>
    </Layout>
  );
}
