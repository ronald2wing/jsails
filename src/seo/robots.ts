/**
 * `robots.txt` generation (`jsails/seo`).
 *
 * {@link buildRobotsTxt} is a pure string producer: it renders a `robots.txt`
 * document from a small options object. No file I/O — the static exporter
 * writes the result into `out/robots.txt`, and the admin panel uses the same
 * builder to emit its `noindex, nofollow` document.
 */

import { SeoError } from './errors.js';

/** Options for {@link buildRobotsTxt}. */
export interface RobotsOptions {
  /** The user-agent group this rule block applies to. Defaults to `*`. */
  readonly userAgent?: string;
  /** Paths to allow. */
  readonly allow?: readonly string[];
  /** Paths to disallow. */
  readonly disallow?: readonly string[];
  /** An absolute `http(s)` URL advertised as the sitemap. */
  readonly sitemap?: string;
  /** An optional `Host` directive (origin only). */
  readonly host?: string;
}

const ABSOLUTE_URL_RE = /^https?:\/\/[^\s<>"'{}|\\^`]+$/;

function assertDirectiveValue(value: string, label: string): void {
  if (value.includes('\n') || value.includes('\r')) {
    throw new SeoError('invalid_robots', `a robots.txt ${label} must not contain a line break`);
  }
}

/**
 * Build a `robots.txt` document. Returns a single `User-agent` block with any
 * `Allow`/`Disallow` rules, plus `Sitemap:` and `Host:` directives when set.
 * An empty options object produces a permissive `User-agent: *` document.
 */
export function buildRobotsTxt(options: RobotsOptions = {}): string {
  const userAgent = options.userAgent ?? '*';
  assertDirectiveValue(userAgent, 'user-agent');

  const lines: string[] = [`User-agent: ${userAgent}`];

  for (const path of options.allow ?? []) {
    assertDirectiveValue(path, 'allow path');
    lines.push(`Allow: ${path}`);
  }
  for (const path of options.disallow ?? []) {
    assertDirectiveValue(path, 'disallow path');
    lines.push(`Disallow: ${path}`);
  }

  if (options.sitemap !== undefined) {
    if (!ABSOLUTE_URL_RE.test(options.sitemap)) {
      throw new SeoError('invalid_robots', 'a robots.txt sitemap must be an absolute http(s) URL');
    }
    lines.push(`Sitemap: ${options.sitemap}`);
  }
  if (options.host !== undefined) {
    assertDirectiveValue(options.host, 'host');
    lines.push(`Host: ${options.host}`);
  }

  return `${lines.join('\n')}\n`;
}
