/**
 * i18n URL helpers — build localized paths and hreflang alternate links.
 *
 * Pure and browser-safe (no `node:*`): these only shape URLs from a route and
 * a locale. Prefix routing (the `/{locale}/...` convention) is owned by the
 * server registration seam; these helpers produce the URLs an app emits.
 */

/** Normalize a route to an absolute, single-slash path. */
function normalizeRoute(route: string): string {
  if (typeof route !== 'string' || route.length === 0) return '/';
  const withSlash = route.startsWith('/') ? route : `/${route}`;
  return withSlash.replace(/\/+/g, '/');
}

/**
 * Build the localized path for `route` under `locale`: `/[locale]/<route>`
 * (the default locale, when passed as `defaultLocale`, stays un-prefixed).
 */
export function localizedPath(route: string, locale: string, defaultLocale?: string): string {
  const normalized = normalizeRoute(route);
  if (locale === defaultLocale) return normalized;
  if (normalized === '/') return `/${locale}`;
  return `/${locale}${normalized}`;
}

/** One hreflang alternate link: a locale and its absolute URL. */
export interface HreflangLink {
  readonly locale: string;
  readonly href: string;
}

/** Options for {@link hreflang}. */
export interface HreflangOptions {
  /** The locales to emit, in order (the first is typically `defaultLocale`). */
  readonly locales: readonly string[];
  /** The un-prefixed locale; its link carries `x-default` and no path prefix. */
  readonly defaultLocale?: string;
  /** Absolute origin (e.g. `https://example.com`) the hrefs are rooted at. */
  readonly origin: string;
}

/** hreflang `rel` for a locale: `x-default` for the default locale. */
export function hreflangRel(locale: string, defaultLocale?: string): string {
  return locale === defaultLocale ? 'x-default' : locale;
}

/**
 * Emit hreflang alternate links for `route`: one `<link rel="alternate"
 * hreflang="..." href="...">` per locale, the default locale marked
 * `x-default`. Links are deterministic (locale order). Returns an empty array
 * when `locales` is empty.
 */
export function hreflang(route: string, options: HreflangOptions): readonly HreflangLink[] {
  if (options.locales.length === 0) return [];
  const origin = options.origin.replace(/\/+$/, '');
  return options.locales.map((locale) => ({
    locale,
    href: `${origin}${localizedPath(route, locale, options.defaultLocale)}`,
  }));
}
