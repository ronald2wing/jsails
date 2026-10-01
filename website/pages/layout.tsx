/**
 * Shared document shell (nested layout) for the JSails docs site.
 *
 * The layout wraps every page with a persistent header, a fixed sidebar
 * navigation, and a main content column. Because this is a nested layout
 * (`pages/layout.js`), the framework folds it around each page's output:
 * the outermost layout's `<html>` tag is emitted, so the minimal document
 * shell (`withDocumentShell`) is skipped.
 *
 * @see AGENTS.md "Nested layouts"
 */

import type { ComponentChildren } from 'preact';
import type { RequestContext } from 'jsails';
import { build, buildBlog } from '../src/content/index.js';
import { readDocsVersions } from '../src/content/versions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NavItem {
  slug: string;
  title: string;
  url: string;
}

interface LayoutProps {
  /** The page component's resolved props (spread by the framework). */
  title?: string;
  /** The page's rendered JSX content (inserted by the framework). */
  children: ComponentChildren;
}

// ---------------------------------------------------------------------------
// Asset paths
// ---------------------------------------------------------------------------

/**
 * Fallback asset paths used when `assetUrl` is not wired into the context.
 * During `jsails build` the static export attaches a resolver, so these
 * should be unreachable in the production path; keep them as a safety net.
 */
const ASSETS = {
  appCss: '/assets/app.css',
  appJs: '/assets/app.js',
};

// ---------------------------------------------------------------------------
// Active nav detection
// ---------------------------------------------------------------------------

function deriveActiveSlug(route: string, params?: Record<string, string>): string | null {
  // For detail pages: the slug param
  if (params?.slug) return params.slug;
  // For the docs index: route is '/docs'
  if (route === '/docs') return null;
  // For other pages, try to derive from route
  if (route.startsWith('/docs/')) {
    return route.slice('/docs/'.length);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layout component
// ---------------------------------------------------------------------------

/**
 * The shared document shell.
 *
 * Emits the full `<html>` document — the framework's minimal document shell
 * is skipped when the outermost layout emits `<html>`.
 *
 * This is an async component because it loads the navigation from the content
 * pipeline at render time (the pipeline is memoized, so all pages within one
 * build share the same result).
 */
export default async function Layout(
  props: LayoutProps,
  context?: RequestContext,
): Promise<ComponentChildren> {
  // Load content pipelines (memoized — one O(N) pass per build).
  const [{ nav: docsNav }, blog, versions] = await Promise.all([
    build(),
    buildBlog(),
    Promise.resolve(readDocsVersions()),
  ]);

  // Derive the current route and params from the request context.
  const route = context?.url?.pathname ?? '';
  const params = context?.params;
  const activeSlug = deriveActiveSlug(route, params);

  // Build nav items: link to docs index first, then each doc page.
  const docsNavItems: NavItem[] = [
    { slug: '', title: 'Documentation', url: '/docs' },
    ...docsNav.map((doc) => ({
      slug: doc.slug,
      title: doc.title,
      url: `/docs/${doc.slug}`,
    })),
  ];

  // Blog nav: link to blog index first, then each non-draft post.
  const blogNavItems: NavItem[] = [
    { slug: '', title: 'Blog', url: '/blog' },
    ...blog.posts
      .filter((p) => !p.draft)
      .map((p) => ({
        slug: p.slug,
        title: p.title,
        url: `/blog/${p.slug}`,
      })),
  ];

  // Asset URLs: use the unversioned paths (the static export attaches
  // `assetUrl` to the context, but the layout does not receive the context
  // directly from the framework in the current nested-layout call signature.
  // The starter's `loadLayout` approach resolves asset URLs inside the page's
  // `load`, not in the layout — for this layout we emit the unversioned fallback
  // and rely on `data-turbo-track="reload"` to invalidate when the content
  // hash changes between builds.
  const appCss = ASSETS.appCss;
  const appJs = ASSETS.appJs;

  // The page title can come from either `props.title` (the page's resolved
  // prop, forwarded by the framework) or fall back to "JSails Docs".
  const pageTitle = props.title ? `${props.title} — JSails Docs` : 'JSails Docs';

  return (
    <html lang="en" data-theme="light">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{pageTitle}</title>
        <link rel="stylesheet" href={appCss} data-turbo-track="reload" />
        <script type="module" src={appJs} data-turbo-track="reload" data-turbo-eval="false" />
        {/* Pagefind: build-time search index (see `pagefind --site out` in the build script). */}
        <script src="/pagefind/pagefind.js" defer />
      </head>
      <body class="docs-shell">
        {/* Header bar */}
        <header class="docs-header">
          <div class="docs-header-inner">
            <a class="docs-logo" href="/">
              JSails
            </a>
            <div class="docs-header-controls">
              {/* Version switcher: links to each version's docs index. */}
              <div class="docs-version-switcher">
                <span class="docs-version-label">Version</span>
                <div class="docs-version-options">
                  {versions.versions.map((v) => {
                    const isCurrent = v.label === versions.current;
                    const url = isCurrent ? '/docs' : `/docs/${v.label}`;
                    return (
                      <a key={v.label} href={url} class={isCurrent ? 'docs-version-active' : ''}>
                        {v.label}
                        {isCurrent ? ' (latest)' : ''}
                      </a>
                    );
                  })}
                </div>
              </div>
              {/* Search island root — server-rendered, hydrated on the client. */}
              <div data-jsails-island="search" data-jsails-props="{}" />
              {/* Theme toggle island root. */}
              <div data-jsails-island="theme" data-jsails-props="{}" />
            </div>
          </div>
        </header>

        <div class="docs-layout">
          {/* Sidebar navigation */}
          <aside class="docs-sidebar">
            <nav class="docs-nav">
              <ul class="docs-nav-section">
                {docsNavItems.map((item) => (
                  <li key={`docs-${item.slug || 'index'}`}>
                    <a
                      href={item.url}
                      class={
                        item.slug === activeSlug ||
                        (item.slug === '' &&
                          activeSlug === null &&
                          (route === '/docs' || route.startsWith('/docs/')))
                          ? 'docs-nav-active'
                          : ''
                      }
                    >
                      {item.title}
                    </a>
                  </li>
                ))}
              </ul>

              {blogNavItems.length > 1 ? (
                <>
                  <hr class="docs-nav-divider" />
                  <ul class="docs-nav-section">
                    {blogNavItems.map((item) => (
                      <li key={`blog-${item.slug || 'index'}`}>
                        <a
                          href={item.url}
                          class={
                            item.slug === activeSlug ||
                            (item.slug === '' && activeSlug === null && route === '/blog')
                              ? 'docs-nav-active'
                              : ''
                          }
                        >
                          {item.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </nav>
          </aside>

          {/* Main content column */}
          <main class="docs-main">{props.children}</main>
        </div>
      </body>
    </html>
  );
}
