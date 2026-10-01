/**
 * Shared document shell (nested layout) for the JSails docs site.
 *
 * The layout wraps every page with a persistent header, a sidebar navigation,
 * and a main content column. Because this is a nested layout
 * (`pages/layout.js`), the framework folds it around each page's output:
 * the outermost layout's `<html>` tag is emitted, so the minimal document
 * shell (`withDocumentShell`) is skipped.
 *
 * The shell is daisyUI-first: a `drawer` owns the mobile slide-in menu, the
 * header is a `navbar`, the sidebar is a `menu`, and the version switcher is a
 * `dropdown`. Only the prose/code surface and a few shell utilities live in
 * `client/styles.css`.
 *
 * @see AGENTS.md "Nested layouts"
 */

import type { ComponentChildren } from 'preact';
import type { RequestContext } from 'jsails';
import { build } from '../src/content/index.js';
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
  const [{ nav: docsNav }, versions] = await Promise.all([
    build(),
    Promise.resolve(readDocsVersions()),
  ]);

  // Derive the current route and params from the request context.
  const route = context?.url?.pathname ?? '';
  const params = context?.params;
  const activeSlug = deriveActiveSlug(route, params);

  // The docs group's leading item is the section label itself (the sidebar
  // renders the first child as a group heading).
  const docsNavItems: NavItem[] = [
    { slug: '', title: 'Guide', url: '/docs' },
    ...docsNav.map((doc) => ({
      slug: doc.slug,
      title: doc.title,
      url: `/docs/${doc.slug}`,
    })),
  ];

  // Resolve asset URLs through the context's cache buster. `assetUrl` returns
  // `/assets/app.css?v=<sha256>`, so a changed stylesheet or script yields a new
  // URL and busts both the CDN and browser cache on redeploy; the unversioned
  // path would be served stale. Fall back to the bare paths when no resolver is
  // wired in (browser-free SSR / unit tests).
  const resolveAsset = context?.assetUrl;
  const [appCss, appJs] =
    resolveAsset === undefined
      ? [ASSETS.appCss, ASSETS.appJs]
      : await Promise.all([resolveAsset('/assets/app.css'), resolveAsset('/assets/app.js')]);

  // The page title can come from either `props.title` (the page's resolved
  // prop, forwarded by the framework) or fall back to "JSails Docs".
  const pageTitle = props.title ? `${props.title} — JSails Docs` : 'JSails Docs';

  const isActive = (item: NavItem, sectionRoute: string): boolean =>
    item.slug === activeSlug ||
    (item.slug === '' &&
      activeSlug === null &&
      (route === sectionRoute || route.startsWith(`${sectionRoute}/`)));

  const currentVersion = versions.current;

  // The sidebar nav is rendered once, inside the single `.drawer-side` aside:
  // daisyUI's `drawer` + `lg:drawer-open` pins it open on large screens and
  // slides it over on small ones, so one source covers both cases.
  const renderNav = () => (
    <ul class="menu docs-menu w-full gap-0.5 px-2 py-1">
      <li class="menu-title">Documentation</li>
      {docsNavItems.map((item) => (
        <li key={`docs-${item.slug || 'index'}`}>
          <a
            href={item.url}
            aria-current={isActive(item, '/docs') ? 'page' : undefined}
            class={isActive(item, '/docs') ? 'menu-active' : ''}
          >
            {item.title}
          </a>
        </li>
      ))}
    </ul>
  );

  return (
    // No `data-theme` here: the palette is driven by daisyUI's `--prefersdark`
    // (`@media (prefers-color-scheme: dark)`) on first paint, so a dark-OS user
    // on the static export never sees light tokens on a dark surface. The theme
    // island sets `data-theme` only as an explicit persisted override after
    // hydration.
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{pageTitle}</title>
        <meta
          name="description"
          content="JSails — a TypeORM-based data layer and bounded application runtime for Node.js."
        />
        {/* Editorial display face, with a serif fallback stack in the CSS so an
            offline build (no network at runtime) still renders a serif heading. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600;6..72,700&display=swap"
        />
        <link rel="stylesheet" href={appCss} data-turbo-track="reload" />
        <script type="module" src={appJs} data-turbo-track="reload" data-turbo-eval="false" />
        {/* Pagefind: build-time search index (see `pagefind --site out` in the build script). */}
        <script src="/pagefind/pagefind.js" defer />
      </head>
      <body class="min-h-screen bg-base-100 text-base-content">
        <a class="skip-link" href="#main-content">
          Skip to content
        </a>

        {/* daisyUI drawer: the mobile menu slides in from the left. The checkbox
            is the drawer's open state; the overlay label closes it. */}
        <div class="drawer lg:drawer-open">
          <input id="docs-drawer" type="checkbox" class="drawer-toggle" />

          <div class="drawer-content flex min-h-screen flex-col">
            {/* Header bar */}
            <header class="site-header">
              <div class="navbar mx-auto h-full max-w-[1440px] gap-2 px-4 sm:px-7">
                {/* Mobile hamburger — opens the drawer. */}
                <label
                  for="docs-drawer"
                  aria-label="Open navigation"
                  class="btn btn-ghost btn-square btn-sm lg:hidden"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="20"
                    height="20"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    aria-hidden="true"
                  >
                    <line x1="3" y1="6" x2="21" y2="6" />
                    <line x1="3" y1="12" x2="21" y2="12" />
                    <line x1="3" y1="18" x2="21" y2="18" />
                  </svg>
                </label>

                <a class="brand-mark" href="/" aria-label="JSails home">
                  <span>JSails</span>
                </a>

                {/* Primary top menu. Hidden below `md` so the mobile hamburger
                    (which opens the drawer holding the guide nav) stays the
                    only navigation affordance on small screens. */}
                <nav class="top-menu hidden md:flex" aria-label="Primary">
                  <a
                    href="/docs"
                    aria-current={
                      isActive({ slug: '', title: 'Docs', url: '/docs' }, '/docs')
                        ? 'page'
                        : undefined
                    }
                    class={
                      isActive({ slug: '', title: 'Docs', url: '/docs' }, '/docs')
                        ? 'top-menu-active'
                        : ''
                    }
                  >
                    Docs
                  </a>
                  <a
                    href="/blog"
                    aria-current={
                      isActive({ slug: '', title: 'Blog', url: '/blog' }, '/blog')
                        ? 'page'
                        : undefined
                    }
                    class={
                      isActive({ slug: '', title: 'Blog', url: '/blog' }, '/blog')
                        ? 'top-menu-active'
                        : ''
                    }
                  >
                    Blog
                  </a>
                </nav>

                <div class="navbar-end ml-auto flex items-center gap-1.5">
                  {/* Version switcher: a daisyUI dropdown over the version list. */}
                  <div class="dropdown dropdown-end hidden sm:block">
                    <div
                      tabindex={0}
                      role="button"
                      class="btn btn-ghost btn-sm gap-1.5 font-medium"
                      aria-label="Switch documentation version"
                    >
                      <span class="text-base-content/60 text-xs font-semibold uppercase tracking-wider">
                        v{currentVersion}
                      </span>
                      <span class="badge badge-primary badge-sm">latest</span>
                      <svg
                        viewBox="0 0 24 24"
                        width="14"
                        height="14"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </div>
                    <ul
                      tabindex={0}
                      class="dropdown-content menu z-[200] mt-2 w-44 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg"
                    >
                      {versions.versions.map((v) => {
                        const isCurrent = v.label === versions.current;
                        const url = isCurrent ? '/docs' : `/docs/${v.label}`;
                        return (
                          <li key={v.label}>
                            <a
                              href={url}
                              aria-current={isCurrent ? 'page' : undefined}
                              class={isCurrent ? 'menu-active' : ''}
                            >
                              <span>v{v.label}</span>
                              {isCurrent ? (
                                <span class="badge badge-primary badge-xs">latest</span>
                              ) : null}
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  </div>

                  {/* Search island root — server-rendered, hydrated on the client. */}
                  <div data-jsails-island="search" data-jsails-props="{}" />
                  {/* Theme toggle island root. */}
                  <div data-jsails-island="theme" data-jsails-props="{}" />
                  {/* GitHub link: the source of the framework and all of this site. */}
                  <a
                    class="btn btn-ghost btn-square btn-sm"
                    href="https://github.com/ronald2wing/jsails"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="JSails on GitHub"
                    title="JSails on GitHub"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      width="18"
                      height="18"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
                    </svg>
                  </a>
                </div>
              </div>
            </header>

            {/* Main content column. The sidebar lives in the single
                `.drawer-side` aside below, which daisyUI pins open on large
                screens and slides over on small ones. */}
            <main
              class="mx-auto w-full min-w-0 max-w-[1440px] flex-1 px-4 py-8 sm:px-8 sm:py-12 lg:px-14 lg:py-12"
              id="main-content"
            >
              {props.children}
            </main>
          </div>

          {/* Single sidebar: slide-over on mobile, pinned rail on large screens. */}
          <div class="drawer-side z-[300]">
            <label for="docs-drawer" aria-label="Close navigation" class="drawer-overlay" />
            <aside
              class="sidebar-scroll min-h-full w-72 max-w-[85vw] overflow-y-auto border-r border-base-300 bg-base-200 py-4 lg:sticky lg:top-[var(--header-height)] lg:h-[calc(100vh-var(--header-height))] lg:w-[268px] lg:py-5"
              aria-label="Documentation navigation"
            >
              {/* Brand mark: mobile only — the header navbar carries the logo on
                  large screens. */}
              <div class="px-4 pb-2 lg:hidden">
                <a class="brand-mark" href="/" aria-label="JSails home">
                  <span>JSails</span>
                </a>
              </div>
              {renderNav()}
              <div class="mt-6 flex items-center justify-between gap-2 border-t border-base-300 px-5 pt-4 text-xs">
                <span class="font-mono text-base-content/50">v{currentVersion}</span>
                <a
                  href="/docs/getting-started"
                  class="link link-primary font-semibold no-underline"
                >
                  Quick start
                </a>
              </div>
            </aside>
          </div>
        </div>
      </body>
    </html>
  );
}
