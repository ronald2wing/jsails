/**
 * Static-starter home page.
 *
 * Renders the shared document shell (`ui/layout.tsx`) and mounts the counter
 * island into `#counter-root`. The client entry registers the `counter` island
 * and hydrates that exact element from the `data-jsails-props` marker, so the
 * server markup and the first client render agree.
 *
 * The island markers are the SSR/author contract:
 * - `data-jsails-island="counter"` — the registered component name
 * - `data-jsails-props='{"initial":0}'` — the serialized props
 *
 * The `id="counter-root"` and the `data-hydrated` readiness marker are owned by
 * the client runtime: it sets `data-hydrated="true"` after hydration.
 *
 * Assets are resolved through `loadLayout` / `context.assetUrl` so the emitted
 * `/assets/app.css` (Tailwind + daisyUI) and `/assets/app.js` (the client
 * entry) URLs carry a content hash and Turbo reloads after a deploy. No images,
 * external fonts, or network requests are used.
 */

import type { RequestContext } from 'jsails';

import { Counter, INITIAL_COUNT } from '../ui/counter.js';
import { Layout, loadLayout, type LayoutAssets } from '../ui/layout.js';

export interface IndexPageProps {
  /** Resolved asset URLs, produced in `load` and forwarded to the layout. */
  assets?: LayoutAssets;
}

export async function load(context: RequestContext): Promise<IndexPageProps> {
  return { assets: await loadLayout(context) };
}

export default function IndexPage({ assets }: IndexPageProps) {
  return (
    <Layout title="JSails Static Starter" assets={assets}>
      <header class="text-center">
        <h1 class="text-4xl font-bold tracking-tight">JSails Static Starter</h1>
        <p class="mt-2 text-base-content/70">
          A minimal Preact island exported to static HTML. No server, no database, no backend
          actions — just a local counter and a native dialog.
        </p>
      </header>

      <div
        id="counter-root"
        data-jsails-island="counter"
        data-jsails-props={JSON.stringify({ initial: INITIAL_COUNT })}
      >
        <Counter initial={INITIAL_COUNT} />
      </div>

      <footer class="text-center text-sm text-base-content/60">
        <p>
          The counter is local to this page and resets on reload. The dialog is frontend-only state.
        </p>
      </footer>
    </Layout>
  );
}
