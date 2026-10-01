/**
 * Post-build feed and sitemap generation for the static blog.
 *
 * `jsails build` renders every page to HTML and copies `public/` into `out/`,
 * but it has no raw-output page primitive, so `rss.xml` and `sitemap.xml` are
 * written here instead — the same approach Astro and Hugo take for feeds. This
 * script runs after `jsails build` in the `build` npm script and writes three
 * files into `out/`:
 *
 *   - `rss.xml`     — the RSS 2.0 feed of every non-draft post
 *   - `sitemap.xml` — one `<url>` per non-draft post
 *   - `robots.txt`  — allow-all plus a `Sitemap:` pointer
 *
 * `SITE_URL` sets the canonical origin (default `http://localhost:3000`); set it
 * to the deployed origin so feed and sitemap links are absolute.
 *
 * This is plain ESM (not compiled), so it must run after `tsc`. It is a
 * consumer, not an autoload provider: it references the project's `posts`,
 * `site`, and `tags` globals, which the `jsails build:meta` shim tree installs.
 * The `build` script runs it as `node --import ./.jsails/project-symbols.js
 * scripts/generate-feeds.mjs`, so the globals are installed before this module
 * evaluates.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderRssFeed, renderSitemap } from 'jsails/content';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(rootDir, 'out');
const siteUrl = (process.env.SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

/** Every post lives under `/blog/<slug>`. */
const urlFor = (page) => `${siteUrl}/blog/${page.slug}`;

const rss = renderRssFeed(posts, {
  title: site.title,
  description: site.description,
  siteUrl,
  feedUrl: `${siteUrl}/rss.xml`,
  urlFor,
});

const sitemap = renderSitemap(posts, { siteUrl, urlFor });

// `renderSitemap` covers the post collection; the static pages and tag term
// pages are not part of it, so append them before the closing `</urlset>`.
const extraUrls = [
  `${siteUrl}/`,
  `${siteUrl}/blog`,
  `${siteUrl}/tags`,
  `${siteUrl}/about`,
  ...tags.terms.map((term) => `${siteUrl}/tags/${term.slug}`),
];
const sitemapWithPages = sitemap.replace(
  '</urlset>',
  extraUrls.map((url) => `  <url>\n    <loc>${url}</loc>\n  </url>`).join('\n') + '\n</urlset>',
);

const robots = ['User-agent: *', 'Allow: /', `Sitemap: ${siteUrl}/sitemap.xml`, ''].join('\n');

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'rss.xml'), rss, 'utf-8');
writeFileSync(resolve(outDir, 'sitemap.xml'), sitemapWithPages, 'utf-8');
writeFileSync(resolve(outDir, 'robots.txt'), robots, 'utf-8');

console.log(`generate-feeds: wrote rss.xml, sitemap.xml, robots.txt (${posts.pages.length} posts)`);
