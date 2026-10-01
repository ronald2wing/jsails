/**
 * Starter home page.
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
 * the client runtime: it sets `data-hydrated="true"` after hydration, which the
 * browser fixture waits on.
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
  /** The current request path, used to mark the active nav link. */
  path?: string;
}

export async function load(context: RequestContext): Promise<IndexPageProps> {
  return { assets: await loadLayout(context), path: context.url.pathname };
}

export default function IndexPage({ assets, path }: IndexPageProps) {
  return (
    <Layout title="JSails Starter" assets={assets} path={path}>
      <section class="hero-glow flex flex-col items-center gap-6 py-8 text-center sm:py-14">
        <span class="inline-flex items-center gap-2 rounded-full border border-base-300/70 bg-base-100/70 px-3 py-1 text-xs font-medium text-base-content/70">
          <span class="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          Preact islands + server components
        </span>
        <h1 class="max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">
          A crisp starting point for your next app
        </h1>
        <p class="max-w-xl text-base text-base-content/65 sm:text-lg">
          JSails gives you a real application shell: a hydrated Preact island, a live server
          component with a backend action, and a local sign-in flow — no database required to
          explore.
        </p>
        <div class="flex flex-wrap items-center justify-center gap-3">
          <a class="btn btn-primary" href="/tasks">
            Try the task list
          </a>
          <a class="btn btn-ghost" href="/about">
            How it works
          </a>
        </div>
      </section>

      <section class="mt-4 grid gap-6 lg:grid-cols-[1.1fr_1fr] lg:items-start">
        <div class="flex flex-col gap-4">
          <div class="card border border-base-300/70 bg-base-100 shadow-sm">
            <div class="card-body gap-3">
              <h2 class="card-title text-lg">What you get</h2>
              <ul class="flex flex-col gap-3 text-sm text-base-content/70">
                <li class="flex items-start gap-3">
                  <span class="mt-0.5 text-primary" aria-hidden="true">
                    ◆
                  </span>
                  <span>
                    <strong class="font-medium text-base-content">A hydrated island.</strong> The
                    counter below is a Preact component the client runtime hydrates in place.
                  </span>
                </li>
                <li class="flex items-start gap-3">
                  <span class="mt-0.5 text-primary" aria-hidden="true">
                    ◆
                  </span>
                  <span>
                    <strong class="font-medium text-base-content">A live server component.</strong>{' '}
                    The task list keeps state on the server and re-renders through a signed
                    snapshot.
                  </span>
                </li>
                <li class="flex items-start gap-3">
                  <span class="mt-0.5 text-primary" aria-hidden="true">
                    ◆
                  </span>
                  <span>
                    <strong class="font-medium text-base-content">A local sign-in flow.</strong>{' '}
                    Email/password auth and a device-approval page ship in the starter.
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div
          id="counter-root"
          data-jsails-island="counter"
          data-jsails-props={JSON.stringify({ initial: INITIAL_COUNT })}
        >
          <Counter initial={INITIAL_COUNT} />
        </div>
      </section>

      <footer class="mt-10 text-center text-sm text-base-content/55">
        <p>
          The counter is local to this page and resets on reload. The dialog is frontend-only state.
        </p>
      </footer>
    </Layout>
  );
}
