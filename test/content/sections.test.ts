/**
 * Sections tests (`jsails/content`).
 *
 * Covers section-tree derivation from page slugs: ghost nodes for intermediate
 * segments, index-page detection (slug match and `index` files), title
 * fallback, deterministic sort, draft exclusion, deep chains, freezing,
 * getSection/breadcrumb lookup, empty collection, and input validation.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
  ContentError,
  defineSections,
  discoverContent,
  type ContentCollection,
} from '../../src/content/index.js';

/** Create a fresh temp directory and register its cleanup on the test. */
function tempRoot(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-sections-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Write a set of fixture files (paths relative to `root`, dirs created as needed). */
function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }
}

/** Build a collection in a temp dir from the given `.md` file map. */
async function fixtureCollection(
  t: TestContext,
  files: Record<string, string>,
): Promise<ContentCollection> {
  const root = tempRoot(t);
  writeFiles(root, files);
  return discoverContent(root);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('defineSections', () => {
  it('[1] single top-level page → root.pages has it, root.children empty', async (t) => {
    const collection = await fixtureCollection(t, {
      'hello.md': `---
title: Hello World
---
# Hello

Content.
`,
    });

    const sections = defineSections(collection);

    assert.equal(sections.root.children.length, 0);
    assert.equal(sections.root.pages.length, 1);
    assert.equal(sections.root.pages[0]?.slug, 'hello');
  });

  it('[2] nested slugs produce ghost nodes with pages placed correctly', async (t) => {
    const collection = await fixtureCollection(t, {
      'docs/api/auth.md': `---
title: Auth Guide
---
# Auth

Auth content.
`,
    });

    const sections = defineSections(collection);
    const { root } = sections;

    // root has `docs` as a child section.
    assert.equal(root.children.length, 1);
    const docsNode = root.children[0];
    assert.ok(docsNode);
    assert.equal(docsNode.slug, 'docs');
    assert.equal(docsNode.page, undefined, 'ghost node has no index page');

    // `docs` has `docs/api` as a child.
    assert.equal(docsNode.children.length, 1);
    const apiNode = docsNode.children[0];
    assert.ok(apiNode);
    assert.equal(apiNode.slug, 'docs/api');
    assert.equal(apiNode.page, undefined);

    // `docs/api` has `auth` in its pages.
    assert.equal(apiNode.children.length, 0);
    assert.equal(apiNode.pages.length, 1);
    assert.equal(apiNode.pages[0]?.slug, 'docs/api/auth');

    // root has no direct pages.
    assert.equal(root.pages.length, 0);
  });

  it('[3] page whose slug is a section path becomes an index (excluded from pages)', async (t) => {
    const collection = await fixtureCollection(t, {
      'docs.md': `---
title: Documentation
order: 1
---
# Docs

Docs index.
`,
      'docs/getting-started.md': `---
title: Getting Started
---
# Start

Content.
`,
    });

    const sections = defineSections(collection);
    const { root } = sections;

    assert.equal(root.children.length, 1);
    const docsNode = root.children[0];
    assert.ok(docsNode);
    assert.equal(docsNode.slug, 'docs');
    assert.ok(docsNode.page);
    assert.equal(docsNode.page?.slug, 'docs');
    assert.equal(docsNode.page?.title, 'Documentation');

    // The index page is excluded from the node's pages.
    assert.equal(docsNode.pages.length, 1);
    assert.equal(docsNode.pages[0]?.slug, 'docs/getting-started');
  });

  it('[4] `docs/index.md` acts as an index for `docs`', async (t) => {
    const collection = await fixtureCollection(t, {
      'docs/index.md': `---
title: Docs Index
---
# Docs

Index page.
`,
      'docs/guide.md': `---
title: Guide
---
# Guide

Guide content.
`,
    });

    const sections = defineSections(collection);
    const { root } = sections;

    assert.equal(root.children.length, 1);
    const docsNode = root.children[0];
    assert.ok(docsNode);
    assert.equal(docsNode.slug, 'docs');
    assert.ok(docsNode.page);
    // The index page is `docs/index`.
    assert.equal(docsNode.page?.slug, 'docs/index');
    assert.equal(docsNode.page?.title, 'Docs Index');
    // Excluded from pages.
    assert.equal(docsNode.pages.length, 1);
    assert.equal(docsNode.pages[0]?.slug, 'docs/guide');
  });

  it('[5] title fallback — no index → title-cased segment', async (t) => {
    const collection = await fixtureCollection(t, {
      'docs/api-auth/guide.md': `---
title: Guide
---
# Guide

Content.
`,
    });

    // Default: titleCaseFallback = true.
    const sections1 = defineSections(collection);
    const apiNode1 = sections1.root.children[0]?.children[0];
    assert.ok(apiNode1);
    assert.equal(apiNode1.title, 'Api Auth');

    // titleCaseFallback: false → raw last segment.
    const sections2 = defineSections(collection, { titleCaseFallback: false });
    const apiNode2 = sections2.root.children[0]?.children[0];
    assert.ok(apiNode2);
    assert.equal(apiNode2.title, 'api-auth');
  });

  it('[6] ordering within a node — order asc → title → slug', async (t) => {
    const collection = await fixtureCollection(t, {
      'posts/c.md': `---
title: Charlie
order: 3
---
# C
`,
      'posts/a.md': `---
title: Alpha
order: 1
---
# A
`,
      'posts/b.md': `---
title: Bravo
order: 2
---
# B
`,
    });

    const sections = defineSections(collection);
    const postsNode = sections.root.children[0];
    assert.ok(postsNode);

    // Pages sorted by order asc.
    const slugs = postsNode.pages.map((p) => p.slug);
    assert.deepEqual(slugs, ['posts/a', 'posts/b', 'posts/c']);
  });

  it('[7] section sort key — node with index order wins over node without', async (t) => {
    const collection = await fixtureCollection(t, {
      'zoo/entry.md': `---
title: Zoo Entry
---
# Zoo Entry

This is a child page that creates the zoo section path.
`,
      'zoo.md': `---
title: Zoo
---
# Zoo

No explicit order — sorts after pages with order < Infinity.
`,
      'alpha.md': `---
title: Alpha
order: 1
---
# Alpha

Index for the alpha section.
`,
      'alpha/one.md': `---
title: One
---
# One
`,
      'beta.md': `---
title: Beta
order: 2
---
# Beta

Index for the beta section.
`,
      'beta/two.md': `---
title: Two
---
# Two
`,
    });

    const sections = defineSections(collection);
    const { root } = sections;

    // Sections: alpha(order=1), beta(order=2), zoo(no index → order Infinity).
    const childSlugs = root.children.map((n) => n.slug);
    assert.deepEqual(childSlugs, ['alpha', 'beta', 'zoo']);
  });

  it('[8] draft exclusion — draft-only path creates no node; draft index ignored', async (t) => {
    const collection = await fixtureCollection(t, {
      'secret/draft.md': `---
title: Secret Draft
draft: true
---
# Secret

Draft content.
`,
      'secret/hidden-index.md': `---
title: Hidden Index
draft: true
---
# Hidden

Draft index for secret section.
`,
    });

    const sections = defineSections(collection);
    // No non-draft pages → no section paths → empty root.
    assert.equal(sections.root.children.length, 0);
    assert.equal(sections.root.pages.length, 0);
  });

  it('[9] deep chain a/b/c/d → 4 ghost nodes with correct parent/child chain', async (t) => {
    const collection = await fixtureCollection(t, {
      'a/b/c/d/deep.md': `---
title: Deep Page
---
# Deep

Content.
`,
    });

    const sections = defineSections(collection);
    const { root } = sections;

    assert.equal(root.children.length, 1);
    const a = root.children[0];
    assert.ok(a);
    assert.equal(a.slug, 'a');

    assert.equal(a.children.length, 1);
    const b = a.children[0];
    assert.ok(b);
    assert.equal(b.slug, 'a/b');

    assert.equal(b.children.length, 1);
    const c = b.children[0];
    assert.ok(c);
    assert.equal(c.slug, 'a/b/c');

    assert.equal(c.children.length, 1);
    const d = c.children[0];
    assert.ok(d);
    assert.equal(d.slug, 'a/b/c/d');
    assert.equal(d.children.length, 0);
    assert.equal(d.pages.length, 1);
    assert.equal(d.pages[0]?.slug, 'a/b/c/d/deep');
  });

  it('[10] freezing — Object.isFrozen at every level', async (t) => {
    const collection = await fixtureCollection(t, {
      'docs/api.md': `---
title: API Reference
---
# API
`,
      'docs/api/auth.md': `---
title: Auth
---
# Auth
`,
    });

    const sections = defineSections(collection);

    assert.ok(Object.isFrozen(sections));
    assert.ok(Object.isFrozen(sections.root));
    assert.ok(Object.isFrozen(sections.root.children));
    assert.ok(Object.isFrozen(sections.root.pages));

    const docsNode = sections.root.children[0];
    assert.ok(docsNode);
    assert.ok(Object.isFrozen(docsNode));
    assert.ok(Object.isFrozen(docsNode.children));
    assert.ok(Object.isFrozen(docsNode.pages));

    // breadcrumb result is also frozen.
    const bc = sections.breadcrumb('docs/api/auth');
    assert.ok(Object.isFrozen(bc));
  });

  it('[11] getSection — `docs/api` node, `missing` undefined, `""` root', async (t) => {
    const collection = await fixtureCollection(t, {
      'docs/api/guide.md': `---
title: Guide
---
# Guide
`,
    });

    const sections = defineSections(collection);

    const apiNode = sections.getSection('docs/api');
    assert.ok(apiNode);
    assert.equal(apiNode.slug, 'docs/api');

    assert.equal(sections.getSection('missing'), undefined);

    const root = sections.getSection('');
    assert.ok(root);
    assert.equal(root.slug, '');
  });

  it('[12] breadcrumb — `docs/api/auth` → [docs, docs/api]; `docs` → []', async (t) => {
    const collection = await fixtureCollection(t, {
      'docs/api/auth.md': `---
title: Auth
---
# Auth
`,
    });

    const sections = defineSections(collection);

    const bc = sections.breadcrumb('docs/api/auth');
    assert.equal(bc.length, 2);
    assert.deepEqual(
      bc.map((n) => n.slug),
      ['docs', 'docs/api'],
    );

    // Top-level page → no ancestors.
    const bcTop = sections.breadcrumb('docs');
    assert.deepEqual(bcTop, []);
  });

  it('[13] empty collection → frozen root, no children/pages', async (t) => {
    const collection = await fixtureCollection(t, {});

    const sections = defineSections(collection);

    assert.ok(Object.isFrozen(sections));
    assert.ok(Object.isFrozen(sections.root));
    assert.equal(sections.root.children.length, 0);
    assert.equal(sections.root.pages.length, 0);
    assert.equal(sections.root.slug, '');
    assert.equal(sections.root.title, '');
  });

  it('[14] bad input — non-array .pages throws ContentError code invalid_collection', () => {
    // The `pages` property must be an array; any non-array value is rejected.
    assert.throws(
      () =>
        defineSections({
          pages: null as unknown as readonly never[],
        } as unknown as ContentCollection),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'invalid_collection');
        return true;
      },
    );
  });
});
