/**
 * Content-layer tests (`jsails/content`).
 *
 * Covers recursive discovery and slug/section derivation, deterministic
 * ordering, draft exclusion from navigation/search (while remaining
 * discoverable), tags/date normalization, TOC/excerpt/search-corpus
 * extraction, frontmatter schema validation (value-free `ContentError`),
 * static-path derivation, and the `getEntry`/`getEntries` helpers. Runs
 * entirely against temp directories — no external services.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { z } from 'zod';

import {
  ContentError,
  createMarkdownStaticPaths,
  defineContentCollection,
  discoverContent,
  type FieldError,
} from '../../src/content/index.js';
import { renderMarkdown } from '../../src/content/render.js';

/** Create a fresh temp directory and register its cleanup on the test. */
function tempRoot(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-content-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Keep the incremental content cache inside the temp root so tests stay hermetic. */
function contentCacheDir(root: string): string {
  return join(root, '.cache');
}

/** Write a set of fixture files (paths relative to `root`, dirs created as needed). */
function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }
}

/** Assert a rejection is a `ContentError` with the given code. */
function isContentError(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof ContentError, `expected ContentError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

const FIXTURES: Record<string, string> = {
  'a.md': `---
title: Alpha
order: 2
---
# Alpha Heading

First paragraph for excerpt.

## Sub section

Second paragraph.
`,
  'guide/intro.md': `---
title: Intro
---
# Guide Intro

Guide paragraph.
`,
  'guide/setup.md': `---
title: Setup Draft
draft: true
order: 1
---
# Setup

Draft content.
`,
  'api/ref.md': `---
title: Reference
order: 1
tags:
  - api
  - docs
date: 2026-10-07
---
# Reference

\`\`\`js
const x = 1;
\`\`\`

Ref paragraph.
`,
};

describe('discoverContent', () => {
  it('recursively discovers .md files and derives slug/section', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, FIXTURES);

    const collection = await discoverContent(root, { cacheDir: contentCacheDir(root) });

    const slugs = collection.pages.map((p) => p.slug).sort();
    assert.deepEqual(slugs, ['a', 'api/ref', 'guide/intro', 'guide/setup']);

    const a = collection.bySlug.get('a');
    assert.ok(a);
    assert.equal(a.section, '', 'top-level file has an empty section');

    const intro = collection.bySlug.get('guide/intro');
    assert.ok(intro);
    assert.equal(intro.section, 'guide');
  });

  it('sorts by order → title → slug deterministically', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, FIXTURES);

    const collection = await discoverContent(root, { cacheDir: contentCacheDir(root) });
    const slugs = collection.pages.map((p) => p.slug);

    assert.deepEqual(slugs, ['api/ref', 'guide/setup', 'a', 'guide/intro']);
  });

  it('excludes drafts from prevNext and search but keeps them discoverable', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, FIXTURES);

    const collection = await discoverContent(root, { cacheDir: contentCacheDir(root) });

    assert.ok(collection.bySlug.has('guide/setup'), 'draft stays discoverable by slug');

    assert.equal(collection.prevNext.has('guide/setup'), false, 'draft has no nav neighbours');
    assert.deepEqual(collection.prevNext.get('api/ref'), { prev: null, next: 'a' });
    assert.deepEqual(collection.prevNext.get('a'), { prev: 'api/ref', next: 'guide/intro' });
    assert.deepEqual(collection.prevNext.get('guide/intro'), { prev: 'a', next: null });

    const searchSlugs = collection.search.map((r) => r.slug);
    assert.deepEqual(searchSlugs, ['api/ref', 'a', 'guide/intro']);
  });

  it('extracts title, tags, date, toc, and excerpt', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, FIXTURES);

    const collection = await discoverContent(root, { cacheDir: contentCacheDir(root) });

    const ref = collection.bySlug.get('api/ref');
    assert.ok(ref);
    assert.deepEqual(ref.tags, ['api', 'docs']);
    assert.equal(ref.date, '2026-10-07');
    assert.equal(ref.order, 1);

    const a = collection.bySlug.get('a');
    assert.ok(a);
    assert.equal(a.excerpt, 'First paragraph for excerpt.');
    assert.equal(a.order, 2);

    // TOC: after the leading H1 strip, only the ## Sub section heading remains.
    assert.deepEqual(
      a.toc.map((h) => ({ depth: h.depth, text: h.text })),
      [{ depth: 2, text: 'Sub section' }],
    );
    assert.equal(a.toc[0]?.id, 'sub-section');
  });

  it('returns an empty collection for a missing directory', async (t) => {
    const root = tempRoot(t);
    const missing = join(root, 'does-not-exist');

    const collection = await discoverContent(missing, { cacheDir: contentCacheDir(root) });
    assert.deepEqual(collection.pages, []);
    assert.deepEqual(collection.search, []);
  });

  it('rejects a file missing the required title', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, { 'no-title.md': '---\norder: 1\n---\nbody\n' });

    await assert.rejects(
      discoverContent(root, { cacheDir: contentCacheDir(root) }),
      isContentError('missing_required_field'),
    );
  });
});

describe('defineContentCollection', () => {
  it('validates frontmatter against a schema and types data', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, {
      'post.md': `---
title: Post
views: 3
---
Body.
`,
    });

    const schema = z.object({ title: z.string(), views: z.number() });
    const collection = await defineContentCollection({
      dir: root,
      schema,
      cacheDir: contentCacheDir(root),
    });

    const entry = collection.getEntry('post');
    assert.ok(entry);
    assert.equal(entry.data.views, 3);
    assert.equal(entry.data.title, 'Post');
  });

  it('throws a value-free ContentError for malformed frontmatter', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, {
      'post.md': `---
title: Post
views: not-a-number
---
Body.
`,
    });

    const schema = z.object({ title: z.string(), views: z.number() });
    const promise = defineContentCollection({ dir: root, schema, cacheDir: contentCacheDir(root) });

    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof ContentError);
      assert.equal(error.code, 'invalid_frontmatter');
      assert.ok(error.errors.length > 0);
      const errors: readonly FieldError[] = error.errors;
      const first = errors[0];
      assert.ok(first);
      assert.equal(first.field, 'views');
      // Value-free: the input value never appears in the message.
      assert.ok(!first.message.includes('not-a-number'));
      assert.ok(!error.message.includes('not-a-number'));
      return true;
    });
  });

  it('derives getStaticPaths from the route param (default [slug])', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, FIXTURES);

    const collection = await defineContentCollection({
      dir: root,
      cacheDir: contentCacheDir(root),
    });
    const paths = createMarkdownStaticPaths(collection);

    assert.deepEqual(paths, [{ slug: 'api/ref' }, { slug: 'a' }, { slug: 'guide/intro' }]);
  });

  it('honours a custom route param name', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, FIXTURES);

    const collection = await defineContentCollection({
      dir: root,
      route: '[id]',
      cacheDir: contentCacheDir(root),
    });
    const paths = collection.getStaticPaths();

    assert.deepEqual(paths, [{ id: 'api/ref' }, { id: 'a' }, { id: 'guide/intro' }]);
  });

  it('filters entries via getEntries', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, FIXTURES);

    const collection = await defineContentCollection({
      dir: root,
      cacheDir: contentCacheDir(root),
    });

    assert.deepEqual(
      collection.getEntries({ section: 'guide' }).map((p) => p.slug),
      ['guide/setup', 'guide/intro'],
    );
    assert.deepEqual(
      collection.getEntries({ tag: 'api' }).map((p) => p.slug),
      ['api/ref'],
    );
    assert.deepEqual(
      collection.getEntries({ draft: true }).map((p) => p.slug),
      ['guide/setup'],
    );
    assert.equal(collection.getEntries({ section: 'missing' }).length, 0);
  });

  it('applies a custom order comparator', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, FIXTURES);

    const collection = await defineContentCollection({
      dir: root,
      // Reverse the default: title descending.
      order: (a, b) => (a.title < b.title ? 1 : a.title > b.title ? -1 : 0),
      cacheDir: contentCacheDir(root),
    });

    const first = collection.pages[0];
    assert.ok(first);
    // Highest title among fixtures is "Setup Draft".
    assert.equal(first.title, 'Setup Draft');
  });
});

// ---- Symlinked root ---- //

describe('symlink safety', () => {
  it('throws symlink_rejected when the content root is a symlink', async (t) => {
    const root = tempRoot(t);
    const real = join(root, 'real');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'index.md'), '---\ntitle: Works\n---\n# Works\n', 'utf-8');

    const link = join(root, 'link');
    symlinkSync(real, link);

    await assert.rejects(
      discoverContent(link, { cacheDir: contentCacheDir(root) }),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'symlink_rejected');
        return true;
      },
    );
  });
});

// ---- Cache-dir isolation ---- //

describe('cache-dir isolation', () => {
  it('returns distinct collections when cacheDir differs', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, { 'a.md': '---\ntitle: Alpha\n---\n# Alpha\n' });

    const a = await discoverContent(root, { cacheDir: contentCacheDir(root) });
    const b = await discoverContent(root, { cacheDir: join(root, 'cache-v2') });

    assert.notStrictEqual(a, b, 'different cacheDir must produce distinct memo keys');
  });
});

// ---- Leading H1 strip (renderMarkdown) ---- //

describe('renderMarkdown H1 stripping', () => {
  it('strips the leading H1 heading from html and toc', async () => {
    // `renderMarkdown` receives the markdown body without frontmatter.
    const body = `# My Title

First paragraph.

## A section

Section content.
`;

    const { html, toc } = await renderMarkdown(body);

    // The leading H1 is stripped so it never duplicates the page's <h1> title.
    assert.ok(!html.includes('<h1'), 'rendered html must not contain <h1');

    // The first rendered content should be the paragraph or the ## section.
    assert.ok(html.includes('First paragraph'), 'rendered html must contain the first paragraph');
    assert.ok(html.includes('A section'), 'rendered html must contain the ## section');

    // TOC must have no depth-1 entry from the stripped H1.
    const depth1 = toc.filter((h) => h.depth === 1);
    assert.equal(depth1.length, 0, 'toc must not contain a depth-1 entry');

    // TOC must still contain the ## section.
    const sectionEntry = toc.find((h) => h.text === 'A section');
    assert.ok(sectionEntry, 'toc must contain the ## section');
    assert.equal(sectionEntry.depth, 2);
  });

  it('leaves a doc with no leading H1 unchanged', async () => {
    // Doc starts at ##, so the first heading is depth 2 — no strip.
    const body = `## First section

Content.

### Nested

More content.
`;

    const { html, toc } = await renderMarkdown(body);

    // The ## heading is preserved in both html and toc.
    assert.ok(html.includes('<h2'), 'rendered html must contain <h2');
    assert.ok(html.includes('First section'), 'rendered html must contain the heading');

    const depth2 = toc.filter((h) => h.depth === 2);
    assert.equal(depth2.length, 1, 'toc must contain the ## section');
    assert.equal(depth2[0]?.text, 'First section');

    const depth3 = toc.filter((h) => h.depth === 3);
    assert.equal(depth3.length, 1, 'toc must contain the ### subsection');
    assert.equal(depth3[0]?.text, 'Nested');
  });

  it('leaves a non-leading H1 later in the body intact', async () => {
    // H1 is NOT the first heading — it appears after a paragraph.
    const body = `Intro paragraph.

# A later H1

Body after.
`;

    const { html, toc } = await renderMarkdown(body);

    // The paragraph is the leading content, not the H1.
    assert.ok(html.includes('Intro paragraph'), 'rendered html must contain intro');

    // The H1 appears later and is NOT stripped.
    assert.ok(html.includes('<h1'), 'rendered html must contain <h1');
    assert.ok(html.includes('A later H1'), 'rendered html must contain the later H1');

    const depth1 = toc.filter((h) => h.depth === 1);
    assert.equal(depth1.length, 1, 'toc must contain the later H1');
    assert.equal(depth1[0]?.text, 'A later H1');
  });
});
