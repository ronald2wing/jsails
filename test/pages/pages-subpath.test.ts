/**
 * Pages subpath tests: `jsails/pages` barrel resolution, re-export identity
 * with the root entry, default export, and `jsails/database` subpath
 * completeness for previously root-only symbols.
 *
 * No connection, database, or external service is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Pages subpath imports from the barrel.
import {
  preactPageRenderer,
  generateStaticSite,
  renderRoute,
  pagesPlugin,
  pageRendererToken,
} from '../../src/pages/index.js';
import type { PageRenderer } from '../../src/pages/index.js';

// Root-entry equivalent imports for same-function-reference verification.
import { preactPageRenderer as rootPreactPageRenderer } from '../../src/pages/page.js';
import { generateStaticSite as rootGenerateStaticSite } from '../../src/pages/static-site/index.js';
import { renderRoute as rootRenderRoute } from '../../src/pages/page.js';
import { pagesPlugin as rootPagesPlugin } from '../../src/pages/plugin.js';
import { pageRendererToken as rootPageRendererToken } from '../../src/pages/plugin.js';

// Database subpath imports — verify previously root-only symbols are now present.
import {
  loadPolymorphic,
  resolveRelation,
  whereHas,
  relationCount,
  defineSeeder,
} from '../../src/database/index.js';

describe('jsails/pages barrel', () => {
  it('re-exports preactPageRenderer from the same source as the root entry', () => {
    assert.strictEqual(preactPageRenderer, rootPreactPageRenderer);
  });

  it('re-exports generateStaticSite from the same source as the root entry', () => {
    assert.strictEqual(generateStaticSite, rootGenerateStaticSite);
  });

  it('re-exports renderRoute from the same source as the root entry', () => {
    assert.strictEqual(renderRoute, rootRenderRoute);
  });

  it('re-exports pagesPlugin from the same source as the root entry', () => {
    assert.strictEqual(pagesPlugin, rootPagesPlugin);
  });

  it('re-exports pageRendererToken from the same source as the root entry', () => {
    assert.strictEqual(pageRendererToken, rootPageRendererToken);
  });

  it('exposes the PageRenderer type (compile-time)', () => {
    // Type-only import above already proves it resolves at compile time.
    const renderer: PageRenderer = preactPageRenderer;
    assert.equal(typeof renderer.render, 'function');
  });
});

describe('jsails/pages default export', () => {
  it('default-export is pagesPlugin itself', async () => {
    const mod = await import('../../src/pages/index.js');
    assert.strictEqual(mod.default, pagesPlugin);
  });

  it('default export is a callable factory that returns a plugin', () => {
    const mod = pagesPlugin;
    const plugin = mod(); // pagesPlugin is a zero-arg factory
    assert.equal(typeof plugin, 'object');
    assert.equal(plugin.name, 'pages');
    assert.equal(typeof plugin.setup, 'function');
  });
});

describe('jsails/database subpath completeness', () => {
  it('re-exports loadPolymorphic (previously root-only)', () => {
    assert.equal(typeof loadPolymorphic, 'function');
  });

  it('re-exports resolveRelation (previously root-only)', () => {
    assert.equal(typeof resolveRelation, 'function');
  });

  it('re-exports whereHas (previously root-only)', () => {
    assert.equal(typeof whereHas, 'function');
  });

  it('re-exports relationCount (previously root-only)', () => {
    assert.equal(typeof relationCount, 'function');
  });

  it('re-exports defineSeeder (previously root-only)', () => {
    assert.equal(typeof defineSeeder, 'function');
  });
});
