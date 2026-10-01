/**
 * Static-starter document shell.
 *
 * A pure Preact component that renders the full `<html>` document shared by
 * every page: the `<head>` (title, content-hashed asset URLs) and the top-level
 * navigation. It imports only `preact` types and the `jsails` request-context
 * type — no Node built-ins, no CSS, no framework runtime — so the same module
 * renders on the server and can be bundled for the browser.
 *
 * Asset tags carry Turbo Drive markers:
 * - `data-turbo-track="reload"` on both the stylesheet and the module script
 *   asks Turbo to compare the asset URL across navigations and reload when it
 *   changes, so a new content hash after a deploy is picked up.
 * - `data-turbo-eval="false"` on the module script stops Turbo from
 *   re-evaluating the client entry on every navigation.
 *
 * `loadLayout` is the app-owned async helper that resolves the two fixed asset
 * paths through `context.assetUrl` (wired by the HTTP layer and static export).
 * Because the URL now carries a content hash, a content change yields a new URL
 * and triggers a reload, while an unchanged asset keeps the same URL so
 * ordinary links stay fast soft navigations. When no resolver is wired in,
 * `loadLayout` falls back to the plain paths, so browser-free SSR still renders.
 */

import type { ComponentChildren } from 'preact';
import type { RequestContext } from 'jsails';

/** The two fixed assets every static-starter page loads. */
export interface LayoutAssets {
  /** Resolved URL of the stylesheet (`/assets/app.css`, content-hashed when possible). */
  readonly appCss: string;
  /** Resolved URL of the client entry module (`/assets/app.js`, content-hashed when possible). */
  readonly appJs: string;
}

/** Unversioned fallbacks, used when no asset resolver is wired in. */
const DEFAULT_ASSETS: LayoutAssets = {
  appCss: '/assets/app.css',
  appJs: '/assets/app.js',
};

export interface LayoutProps {
  /** Document title. Rendered as text, so it is escaped by Preact. */
  title: string;
  /** Page body content. */
  children: ComponentChildren;
  /**
   * Resolved asset URLs from `loadLayout`. Optional so direct SSR (unit tests,
   * static rendering without a request context) falls back to the plain paths.
   */
  assets?: LayoutAssets;
}

/**
 * Resolve the fixed stylesheet and client-entry URLs for one request.
 *
 * App-owned, not framework code: it reads `context.assetUrl` when the host
 * wired one in (the HTTP layer and static export both do) and falls back to the
 * unversioned paths when it is absent, so a browser-free SSR render never
 * touches disk. Call this from a page's `load` and hand the result to
 * {@link Layout}.
 */
export async function loadLayout(context: RequestContext): Promise<LayoutAssets> {
  const resolve = context.assetUrl;
  if (resolve === undefined) return DEFAULT_ASSETS;
  const [appCss, appJs] = await Promise.all([
    resolve('/assets/app.css'),
    resolve('/assets/app.js'),
  ]);
  return { appCss, appJs };
}

/**
 * Render the shared document shell around `children`.
 *
 * The navigation uses ordinary `<a href>` links: the browser client owns
 * navigation, so no click handler, `history` call, or router is installed here.
 */
export function Layout({ title, children, assets }: LayoutProps) {
  const appCss = assets?.appCss ?? DEFAULT_ASSETS.appCss;
  const appJs = assets?.appJs ?? DEFAULT_ASSETS.appJs;
  return (
    <html lang="en" data-theme="light">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="stylesheet" href={appCss} data-turbo-track="reload" />
        <script type="module" src={appJs} data-turbo-track="reload" data-turbo-eval="false" />
      </head>
      <body class="min-h-screen bg-base-200">
        <nav class="navbar bg-base-100 shadow-sm">
          <div class="mx-auto flex w-full max-w-3xl items-center gap-2 px-6">
            <a class="btn btn-ghost" href="/">
              Home
            </a>
            <a class="btn btn-ghost" href="/about">
              About
            </a>
          </div>
        </nav>
        <main class="mx-auto flex max-w-3xl flex-col items-center justify-center gap-8 p-6">
          {children}
        </main>
      </body>
    </html>
  );
}
