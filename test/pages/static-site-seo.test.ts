/**
 * Static site SEO output tests.
 *
 * Covers the static exporter's opt-in SEO path: when {@link GenerateStaticSiteOptions.seo}
 * is provided, the build emits `sitemap.xml` and `robots.txt` and lists them in
 * `result.raw`. Pages whose metadata includes `robots: 'noindex'` are excluded
 * from the sitemap. Fixture modules are real compiled ESM files written to a
 * temp directory — the same pattern as `test/pages/static-site.test.ts`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { generateStaticSite, StaticSiteError } from '../../src/pages/static-site/index.js';
import type { GenerateStaticSiteResult } from '../../src/pages/static-site/index.js';
import type { RouteManifest, RouteManifestEntry } from '../../src/routing/routes.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-static-site-seo-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const runtimeUrl = new URL('../../src/jsx/jsx-runtime.js', import.meta.url).href;

let sequence = 0;
/** Write a unique compiled ESM fixture and return its absolute path. */
function writeModule(source: string): string {
  const file = join(root, `module-seo-${sequence++}.js`);
  writeFileSync(file, source);
  return file;
}

/** Create an isolated case directory for one test case. */
function caseDir(): string {
  return mkdtempSync(join(root, 'case-'));
}

function pageEntry(
  route: string,
  file: string,
  dynamic = false,
  params: string[] = [],
  catchAll = false,
): RouteManifestEntry {
  return { kind: 'page', route, file, dynamic, catchAll, params };
}

function manifestOf(entries: RouteManifestEntry[]): RouteManifest {
  return {
    entries,
    byRoute: new Map(entries.map((entry) => [entry.route, entry])),
  };
}

const jsx = (children: string): string =>
  `import { jsx } from ${JSON.stringify(runtimeUrl)};
export default function Page() { return jsx('div', { children: ${JSON.stringify(children)} }); }
`;

describe('static site SEO output', () => {
  it('emits sitemap.xml and robots.txt when seo is configured', async () => {
    const base = caseDir();
    const out = join(base, 'out');

    const home = writeModule(jsx('Home'));
    const about = writeModule(jsx('About'));

    const manifest = manifestOf([pageEntry('/', home), pageEntry('/about', about)]);

    const result: GenerateStaticSiteResult = await generateStaticSite({
      manifest,
      outDir: out,
      baseUrl: 'https://example.com',
      seo: {
        origin: 'https://example.com',
        robots: { sitemap: 'https://example.com/sitemap.xml' },
      },
    });

    // Verify result.raw lists both generated files.
    assert.deepEqual(result.raw, [join(out, 'sitemap.xml'), join(out, 'robots.txt')]);

    // Verify sitemap.xml content.
    const sitemap = readFileSync(join(out, 'sitemap.xml'), 'utf8');
    assert.match(sitemap, /<urlset/);
    assert.match(sitemap, /<loc>https:\/\/example\.com\/<\/loc>/);
    assert.match(sitemap, /<loc>https:\/\/example\.com\/about<\/loc>/);

    // Verify robots.txt content.
    const robots = readFileSync(join(out, 'robots.txt'), 'utf8');
    assert.match(robots, /Sitemap: https:\/\/example\.com\/sitemap\.xml/);

    // Verify the rendered pages are still in written.
    assert.deepEqual(result.written, [join(out, 'index.html'), join(out, 'about', 'index.html')]);
  });

  it('excludes noindex pages from the sitemap via page metadata', async () => {
    const base = caseDir();
    const out = join(base, 'out');

    // Public page: metadata without robots.
    const publicPage = writeModule(jsx('Public'));

    // Private page: metadata with robots: noindex.
    const privatePageFile = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
export const metadata = { robots: 'noindex, nofollow' };
export default function Page() { return jsx('div', { children: 'Private' }); }
`,
    );

    const manifest = manifestOf([
      pageEntry('/', publicPage),
      pageEntry('/private', privatePageFile),
    ]);

    const result = await generateStaticSite({
      manifest,
      outDir: out,
      baseUrl: 'https://example.com',
      seo: {
        origin: 'https://example.com',
        robots: {},
      },
    });

    const sitemap = readFileSync(join(out, 'sitemap.xml'), 'utf8');

    // Public page is in the sitemap.
    assert.match(sitemap, /<loc>https:\/\/example\.com\/<\/loc>/);

    // Private page is absent.
    assert.doesNotMatch(sitemap, /\/private/);
    assert.ok(result.raw.includes(join(out, 'sitemap.xml')));
  });

  it('excludes default-noindex pages from the sitemap via SEO defaults', async () => {
    const base = caseDir();
    const out = join(base, 'out');

    const home = writeModule(jsx('Home'));
    const about = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
export const metadata = { robots: 'noindex' };
export default function Page() { return jsx('div', { children: 'About' }); }
`,
    );

    const manifest = manifestOf([pageEntry('/', home), pageEntry('/about', about)]);

    await generateStaticSite({
      manifest,
      outDir: out,
      baseUrl: 'https://example.com',
      seo: {
        origin: 'https://example.com',
        defaults: { robots: 'index, follow' },
        robots: {},
      },
    });

    const sitemap = readFileSync(join(out, 'sitemap.xml'), 'utf8');
    assert.match(sitemap, /<loc>https:\/\/example\.com\/<\/loc>/);
    // about has explicit noindex, so it's excluded.
    assert.doesNotMatch(sitemap, /\/about/);
  });

  it('does not emit SEO files when seo is not configured', async () => {
    const base = caseDir();
    const out = join(base, 'out');

    const home = writeModule(jsx('Home'));
    const manifest = manifestOf([pageEntry('/', home)]);

    const result = await generateStaticSite({
      manifest,
      outDir: out,
      baseUrl: 'https://example.com',
    });

    assert.deepEqual(result.raw, []);
    assert.deepEqual(result.written, [join(out, 'index.html')]);
  });

  it('rejects a non-http(s) baseUrl for the static export (value-free)', async () => {
    const base = caseDir();
    const out = join(base, 'out');
    const home = writeModule(jsx('Home'));

    await assert.rejects(
      () =>
        generateStaticSite({
          manifest: manifestOf([pageEntry('/', home)]),
          outDir: out,
          baseUrl: 'ftp://example.com',
        }),
      (error: unknown) => error instanceof StaticSiteError && /http or https/.test(error.message),
    );
  });
});
