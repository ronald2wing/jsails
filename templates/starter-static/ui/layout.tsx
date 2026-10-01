/**
 * Static-blog document shell.
 *
 * A pure Preact component that renders the full `<html>` document shared by
 * every page: the `<head>` (content-hashed asset URLs, the RSS alternate link),
 * the top navigation, the page body, and the footer. It imports only `preact`
 * types and the `jsails` request-context type — no Node built-ins, no CSS, no
 * framework runtime — so the same module renders on the server and can be
 * bundled for the browser.
 *
 * The `<title>` and `<meta name="description">` are NOT rendered here: the SEO
 * layer injects them from each page's `metadata`/`generateMetadata` (merged over
 * the app's `seo.defaults`). Rendering them here too would emit duplicate
 * `<title>` elements, and the browser honors the first — the hardcoded one —
 * defeating per-page metadata.
 *
 * No `data-theme` is pinned on `<html>`: the two daisyUI themes declared in
 * `ui/styles.css` (built-in `light`/`dark`, overridden with the warm palette)
 * let the OS preference pick the warm dark surface automatically, and a future
 * theme toggle can set the attribute without touching this shell.
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

/** The two fixed assets every static-blog page loads. */
export interface LayoutAssets {
  /** Resolved URL of the stylesheet (`/assets/app.css`, content-hashed when possible). */
  readonly appCss: string;
  /** Resolved URL of the client-entry module (`/assets/app.js`, content-hashed when possible). */
  readonly appJs: string;
}

/** Unversioned fallbacks, used when no asset resolver is wired in. */
const DEFAULT_ASSETS: LayoutAssets = {
  appCss: '/assets/app.css',
  appJs: '/assets/app.js',
};

/** The site title shown in the nav and appended to page titles. */
export const SITE_TITLE = site.title;
/** One-line site description, reused by the footer and the feed script. */
export const SITE_DESCRIPTION = site.description;

/** Top-level navigation, in reading order. */
const NAV_LINKS: readonly { readonly href: string; readonly label: string }[] = [
  { href: '/', label: 'Home' },
  { href: '/blog', label: 'Archive' },
  { href: '/tags', label: 'Tags' },
  { href: '/categories', label: 'Categories' },
  { href: '/about', label: 'About' },
];

export interface LayoutProps {
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
export function Layout({ children, assets }: LayoutProps) {
  const appCss = assets?.appCss ?? DEFAULT_ASSETS.appCss;
  const appJs = assets?.appJs ?? DEFAULT_ASSETS.appJs;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="alternate" type="application/rss+xml" title={SITE_TITLE} href="/rss.xml" />
        <link rel="stylesheet" href={appCss} data-turbo-track="reload" />
        <script type="module" src={appJs} data-turbo-track="reload" data-turbo-eval="false" />
      </head>
      <body class="flex min-h-screen flex-col bg-base-100 text-base-content antialiased">
        <header class="sticky top-0 z-20 border-b border-base-300/70 bg-base-100/85 backdrop-blur-md">
          <div class="mx-auto flex w-full max-w-3xl items-baseline justify-between gap-4 px-6 py-4">
            <a class="display text-xl text-base-content" href="/">
              {SITE_TITLE}
            </a>
            <nav class="flex items-center gap-4 text-sm" aria-label="Primary">
              {NAV_LINKS.map((link) => (
                <a
                  class="text-base-content/60 transition-colors hover:text-primary"
                  key={link.href}
                  href={link.href}
                >
                  {link.label}
                </a>
              ))}
            </nav>
          </div>
        </header>

        <main class="mx-auto w-full max-w-3xl flex-1 px-6 py-12 sm:py-16">{children}</main>

        <footer class="mt-8 border-t border-base-300/70">
          <div class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-10 text-sm text-base-content/55 sm:flex-row sm:items-end sm:justify-between">
            <div class="space-y-1">
              <p class="display text-base text-base-content/80">{SITE_TITLE}</p>
              <p class="max-w-sm">{SITE_DESCRIPTION}</p>
            </div>
            <div class="flex items-center gap-4">
              <a class="tag-link" href="/rss.xml">
                RSS
              </a>
              <a class="tag-link" href="/blog">
                Archive
              </a>
              <a class="tag-link" href="/tags">
                Tags
              </a>
              <a class="tag-link" href="/categories">
                Categories
              </a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
