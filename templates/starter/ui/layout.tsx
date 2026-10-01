/**
 * Starter document shell.
 *
 * A pure Preact component that renders the full `<html>` document shared by
 * every page: the `<head>` (title, content-hashed asset URLs, the pre-paint
 * theme script) and the top-level navigation. It imports only `preact` types
 * and the `jsails` request-context type — no Node built-ins, no CSS, no
 * framework runtime — so the same module renders on the server and can be
 * bundled for the browser.
 *
 * Theme handling: `<html>` carries `data-theme="aqua"` as the deterministic
 * SSR default (the ocean/sea daisyUI theme for the JSails brand). A tiny inline
 * script in `<head>` runs before first paint and swaps in `night` when the user
 * previously chose dark or the OS prefers it, so there is no flash of the wrong
 * theme. The `theme-toggle` island (see `client/main.tsx`) then owns the
 * attribute and persists the choice. The `themeTokens` prop, when supplied by
 * the `jsails/theme` service, still emits its CSS custom properties on `<html>`;
 * the aqua/night toggle is orthogonal.
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

/**
 * Structural contract matching `ThemeTokens` from `jsails/theme`.
 * The scaffolded project imports the real type; the template defines
 * this local alias so framework development typechecks without the
 * subpath entry in `package.json`.
 */
interface ThemeTokens {
  resolve(): Readonly<Record<string, string>>;
  toCss(): string;
  themes(): Readonly<Record<string, Readonly<Record<string, string>>>>;
  activeName(): string | undefined;
}

/** The two fixed assets every starter page loads. */
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

/** The daisyUI theme names declared in `ui/styles.css`. */
const LIGHT_THEME = 'aqua';
const DARK_THEME = 'night';

/**
 * Runs before first paint to apply the persisted/OS theme. Kept as a string so
 * it can be inlined into `<head>`; it must never throw, so every storage and
 * matchMedia access is guarded.
 */
const THEME_BOOT_SCRIPT = `(function(){try{var k='jsails-starter-theme';var s=localStorage.getItem(k);var d=s==='dark'||(s!=='light'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'${DARK_THEME}':'${LIGHT_THEME}');}catch(e){}})();`;

/** Top-level navigation, in reading order. */
const NAV_LINKS: readonly { readonly href: string; readonly label: string }[] = [
  { href: '/', label: 'Home' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/about', label: 'About' },
];

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
  /**
   * Resolved theme tokens from the `jsails/theme` service. When set, the
   * `<html>` element emits the token map as inline CSS custom properties
   * so a plugin-contributed theme reaches the user-facing surface.
   */
  themeTokens?: ThemeTokens;
  /**
   * The current request path, used to mark the active nav link. Optional so
   * direct SSR without a request context still renders (no link is active).
   */
  path?: string;
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

/** True when `href` is the active nav target for `path`. */
function isActive(href: string, path: string | undefined): boolean {
  if (path === undefined) return false;
  if (href === '/') return path === '/';
  return path === href || path.startsWith(`${href}/`);
}

/**
 * Render the shared document shell around `children`.
 *
 * The navigation uses ordinary `<a href>` links: the browser client owns
 * navigation, so no click handler, `history` call, or router is installed here.
 */
export function Layout({ title, children, assets, themeTokens, path }: LayoutProps) {
  const appCss = assets?.appCss ?? DEFAULT_ASSETS.appCss;
  const appJs = assets?.appJs ?? DEFAULT_ASSETS.appJs;
  const style = themeTokens?.toCss() ?? undefined;
  return (
    <html lang="en" data-theme={LIGHT_THEME} style={style}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        {/* Pre-paint theme application: no flash of the wrong theme. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <link rel="stylesheet" href={appCss} data-turbo-track="reload" />
        <script type="module" src={appJs} data-turbo-track="reload" data-turbo-eval="false" />
      </head>
      <body class="flex min-h-screen flex-col bg-base-100 text-base-content antialiased">
        <header class="sticky top-0 z-30 border-b border-base-300/70 bg-base-100/80 backdrop-blur-md">
          <div class="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-6 py-3">
            <a class="flex items-center gap-2.5 font-semibold tracking-tight" href="/">
              <span class="brand-mark" aria-hidden="true">
                J
              </span>
              <span>JSails</span>
            </a>

            <nav class="flex items-center gap-1 text-sm" aria-label="Primary">
              {NAV_LINKS.map((link) => (
                <a
                  class={
                    isActive(link.href, path)
                      ? 'rounded-lg bg-base-200 px-3 py-1.5 font-medium text-base-content'
                      : 'rounded-lg px-3 py-1.5 text-base-content/60 transition-colors hover:bg-base-200 hover:text-base-content'
                  }
                  key={link.href}
                  href={link.href}
                  aria-current={isActive(link.href, path) ? 'page' : undefined}
                >
                  {link.label}
                </a>
              ))}
            </nav>

            <div class="flex items-center gap-2">
              <a class="btn btn-ghost btn-sm hidden sm:inline-flex" href="/dashboard">
                Dashboard
              </a>
              <a class="btn btn-primary btn-sm" href="/login">
                Sign in
              </a>
              <div
                id="theme-toggle-root"
                data-jsails-island="theme-toggle"
                data-jsails-props="{}"
              />
            </div>
          </div>
        </header>

        <main class="mx-auto w-full max-w-5xl flex-1 px-6 py-10 sm:py-14">{children}</main>

        <footer class="border-t border-base-300/70">
          <div class="mx-auto flex w-full max-w-5xl flex-col gap-2 px-6 py-8 text-sm text-base-content/55 sm:flex-row sm:items-center sm:justify-between">
            <p>JSails Starter — a Preact island, a server component, and a local sign-in flow.</p>
            <p class="font-mono text-xs">Built with JSails</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
