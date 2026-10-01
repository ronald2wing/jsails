/**
 * Page metadata loading and SSR head injection tests.
 *
 * Covers {@link loadPageModule} validation of the reserved `metadata` export
 * and {@link generateMetadata} export, and end-to-end SSR head injection via
 * {@link createTestApp}: a page with metadata renders its title and description
 * into the document `<head>`, and `generateMetadata` takes precedence.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { createTestApp } from '../../src/testing/app.js';
import type { TestApplication } from '../../src/testing/index.js';
import { loadPageModule, PageRenderError } from '../../src/pages/page.js';
import type { JsailsAppConfig } from '../../src/testing/index.js';

const root = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'page-metadata-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
});

let sequence = 0;
/** Write a unique compiled ESM fixture and return its absolute path. */
function writeModule(source: string, extension = '.js'): string {
  const file = join(root, `fixture-metadata-${sequence++}${extension}`);
  writeFileSync(file, source);
  return file;
}

/** Create an isolated case directory with page fixtures. */
function makeCase(assets: Record<string, Record<string, string>>): string {
  const dir = join(root, `case-metadata-${sequence++}`);
  for (const [subdir, files] of Object.entries(assets)) {
    const subPath = join(dir, subdir);
    mkdirSync(subPath, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(subPath, rel), content);
    }
  }
  return dir;
}

/** A raw app-config object rooted at `dir`. */
function rawConfig(dir: string, overrides: Partial<JsailsAppConfig> = {}): JsailsAppConfig {
  return { rootDir: dir, port: 0, ...overrides };
}

// ---------------------------------------------------------------------------
// loadPageModule metadata validation
// ---------------------------------------------------------------------------

describe('loadPageModule metadata validation', () => {
  it('accepts a static metadata object', async () => {
    const file = writeModule(
      `export const metadata = { title: 'Page', description: 'Desc' };
       export default function Page() { return null; }
      `,
    );
    const page = await loadPageModule(file);
    assert.equal(typeof page.default, 'function');
    assert.deepEqual(page.metadata, { title: 'Page', description: 'Desc' });
  });

  it('accepts a metadata function', async () => {
    const file = writeModule(
      `export const metadata = () => ({ title: 'Dynamic', robots: 'noindex' });
       export default function Page() { return null; }
      `,
    );
    const page = await loadPageModule(file);
    assert.equal(typeof page.metadata, 'function');
  });

  it('accepts generateMetadata as a function', async () => {
    const file = writeModule(
      `export function generateMetadata(context) { return { title: 'Generated' }; }
       export default function Page() { return null; }
      `,
    );
    const page = await loadPageModule(file);
    assert.equal(typeof page.generateMetadata, 'function');
  });

  it('accepts a page with no metadata export at all', async () => {
    const file = writeModule('export default function Page() { return null; }\n');
    const page = await loadPageModule(file);
    assert.equal(page.metadata, undefined);
    assert.equal(page.generateMetadata, undefined);
  });

  it('rejects a non-object, non-function metadata export (value-free)', async () => {
    const file = writeModule(
      `export const metadata = 42;
       export default function Page() { return null; }
      `,
    );
    await assert.rejects(
      () => loadPageModule(file),
      (error: unknown) => {
        assert.ok(error instanceof PageRenderError);
        assert.match(error.message, /"metadata" must be an object or a function/);
        assert.doesNotMatch(error.message, /42/);
        return true;
      },
    );
  });

  it('rejects a non-function generateMetadata export (value-free)', async () => {
    const file = writeModule(
      `export const generateMetadata = 'not-a-function';
       export default function Page() { return null; }
      `,
    );
    await assert.rejects(
      () => loadPageModule(file),
      (error: unknown) => {
        assert.ok(error instanceof PageRenderError);
        assert.match(error.message, /"generateMetadata" must be a function/);
        assert.doesNotMatch(error.message, /not-a-function/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// SSR head injection via createTestApp
// ---------------------------------------------------------------------------

describe('SSR head injection', () => {
  it('injects title and meta tags into the rendered document', async () => {
    const dir = makeCase({
      pages: {
        'index.mjs': `import { h } from 'preact';
export const metadata = { title: 'SSR Title', description: 'SSR Description', robots: 'index, follow' };
export default function Page() { return h('h1', null, 'Hello SSR'); }
`,
      },
    });

    const app: TestApplication = await createTestApp({
      config: rawConfig(dir, {
        seo: { siteName: 'Test Site' },
      }),
    });

    try {
      const res = await app.request('/');
      assert.equal(res.status, 200);
      const html = await res.text();

      // Title is injected into the <head>.
      assert.match(html, /<title>SSR Title<\/title>/);
      // Description meta tag is present.
      assert.match(html, /<meta name="description" content="SSR Description">/);
      // Robots meta tag is present.
      assert.match(html, /<meta name="robots" content="index, follow">/);
      // The page content rendered.
      assert.match(html, /<h1>Hello SSR<\/h1>/);
    } finally {
      await app.close();
    }
  });

  it('fills openGraph.siteName from the SEO runtime options', async () => {
    const dir = makeCase({
      pages: {
        'index.mjs': `import { h } from 'preact';
export const metadata = { openGraph: { title: 'OG Title' } };
export default function Page() { return h('p', null, 'OG Page'); }
`,
      },
    });

    const app: TestApplication = await createTestApp({
      config: rawConfig(dir, {
        seo: { siteName: 'App Site Name', origin: 'https://app.example' },
      }),
    });

    try {
      const res = await app.request('/');
      const html = await res.text();
      assert.match(html, /<meta property="og:title" content="OG Title">/);
      // siteName from SEO config fills the missing openGraph.siteName.
      assert.match(html, /<meta property="og:site_name" content="App Site Name">/);
    } finally {
      await app.close();
    }
  });

  it('resolves a relative canonical against the configured origin', async () => {
    const dir = makeCase({
      pages: {
        'index.mjs': `import { h } from 'preact';
export const metadata = { canonical: '/about' };
export default function Page() { return h('p', null, 'Canonical'); }
`,
      },
    });

    const app: TestApplication = await createTestApp({
      config: rawConfig(dir, {
        seo: { origin: 'https://example.com' },
      }),
    });

    try {
      const res = await app.request('/');
      const html = await res.text();
      assert.match(html, /<link rel="canonical" href="https:\/\/example\.com\/about">/);
    } finally {
      await app.close();
    }
  });

  it('generateMetadata takes precedence over a static metadata object', async () => {
    const dir = makeCase({
      pages: {
        'index.mjs': `import { h } from 'preact';
export const metadata = { title: 'Static Title' };
export function generateMetadata() { return { title: 'Dynamic Title', description: 'Dynamic Desc' }; }
export default function Page() { return h('h1', null, 'Generated'); }
`,
      },
    });

    const app: TestApplication = await createTestApp({
      config: rawConfig(dir, {
        seo: { siteName: 'Test' },
      }),
    });

    try {
      const res = await app.request('/');
      const html = await res.text();

      // generateMetadata wins over static metadata.
      assert.match(html, /<title>Dynamic Title<\/title>/);
      assert.match(html, /<meta name="description" content="Dynamic Desc">/);
      // Static metadata title is not present.
      assert.doesNotMatch(html, /<title>Static Title<\/title>/);
    } finally {
      await app.close();
    }
  });

  it('renders normally when no metadata is declared', async () => {
    const dir = makeCase({
      pages: {
        'index.mjs': `import { h } from 'preact';
export default function Page() { return h('h1', null, 'No Meta'); }
`,
      },
    });

    const app: TestApplication = await createTestApp({
      config: rawConfig(dir, {
        seo: { siteName: 'Test' },
      }),
    });

    try {
      const res = await app.request('/');
      const html = await res.text();
      // Page renders correctly.
      assert.match(html, /<h1>No Meta<\/h1>/);
      // No seo-specific tags (metadata is empty, and the SEO runtime defaults
      // only fill in openGraph.siteName if page had an openGraph block).
      assert.doesNotMatch(html, /<title>/);
      assert.doesNotMatch(html, /<meta name="description"/);
    } finally {
      await app.close();
    }
  });
});
