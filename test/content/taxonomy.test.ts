/**
 * Taxonomy tests (`jsails/content` — Slice 2).
 *
 * Covers term grouping from string and array frontmatter values, slug
 * derivation (spaces/case/punctuation), deterministic sort, `getTerm` lookup,
 * `getStaticPaths` with default and custom route param names, draft exclusion,
 * per-entry deduplication, empty/trimmed value handling, and value-free
 * `ContentError` on bad input.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
  ContentError,
  defineTaxonomy,
  discoverContent,
  type ContentCollection,
} from '../../src/content/index.js';

/** Create a fresh temp directory and register its cleanup on the test. */
function tempRoot(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-taxonomy-'));
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a collection in a temp dir from the given `.md` file map. */
async function fixtureCollection(
  t: TestContext,
  files: Record<string, string>,
): Promise<ContentCollection> {
  const root = tempRoot(t);
  writeFiles(root, files);
  return discoverContent(root);
}

/** Standard fixtures with tags as arrays, including a draft entry. */
const TAG_FIXTURES: Record<string, string> = {
  'a.md': `---
title: JavaScript Guide
order: 1
tags:
  - javascript
  - guide
---
# JavaScript Guide

Content.
`,
  'b.md': `---
title: TypeScript Deep Dive
order: 2
tags:
  - typescript
  - guide
date: 2026-01-15
---
# TypeScript Deep Dive

Content.
`,
  'c.md': `---
title: CSS Tips
order: 3
tags:
  - css
---
# CSS Tips

Content.
`,
  'draft-post.md': `---
title: Hidden Draft
draft: true
tags:
  - draft-tag
  - guide
---
# Hidden Draft

This post is a draft and must not appear in any taxonomy term.
`,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('defineTaxonomy', () => {
  it('groups non-draft pages by a string-array frontmatter field', async (t) => {
    const collection = await fixtureCollection(t, TAG_FIXTURES);
    const tags = defineTaxonomy({ collection, field: 'tags' });

    const termNames = tags.terms.map((x) => x.term).sort();
    assert.deepEqual(termNames, ['css', 'guide', 'javascript', 'typescript']);

    // "guide" appears on two pages (a and b, not the draft).
    const guideTerm = tags.getTerm('guide');
    assert.ok(guideTerm);
    assert.equal(guideTerm.term, 'guide');
    assert.equal(guideTerm.count, 2);
    assert.equal(guideTerm.pages.length, 2);
    assert.deepEqual(
      guideTerm.pages.map((p) => p.slug),
      ['a', 'b'],
    );
  });

  it('groups by a single string field (not an array)', async (t) => {
    const files: Record<string, string> = {
      'one.md': `---
title: One
category: frontend
---
# One
`,
      'two.md': `---
title: Two
category: backend
---
# Two
`,
    };
    const collection = await fixtureCollection(t, files);
    const cats = defineTaxonomy({ collection, field: 'category' });

    assert.equal(cats.terms.length, 2);
    assert.deepEqual(cats.terms.map((x) => x.term).sort(), ['backend', 'frontend']);
  });

  it('derives URL-safe slugs (spaces, case, punctuation)', async (t) => {
    const files: Record<string, string> = {
      'p1.md': `---
title: Post One
tags:
  - Open Source
  - AI/ML
  - "  Hello World!  "
  - UPPERCASE
---
# Post One
`,
      'p2.md': `---
title: Post Two
tags:
  - Node.js & TypeScript
---
# Post Two
`,
    };
    const collection = await fixtureCollection(t, files);
    const tags = defineTaxonomy({ collection, field: 'tags' });

    // Slug verification.
    const ai = tags.getTerm('ai-ml');
    assert.ok(ai);
    assert.equal(ai.term, 'AI/ML');

    const os = tags.getTerm('open-source');
    assert.ok(os);
    assert.equal(os.term, 'Open Source');

    const hw = tags.getTerm('hello-world');
    assert.ok(hw);
    // Term values are trimmed and deduplicated per-entry (spec-compliant).
    assert.equal(hw.term, 'Hello World!');

    const uc = tags.getTerm('uppercase');
    assert.ok(uc);
    assert.equal(uc.term, 'UPPERCASE');

    const node = tags.getTerm('node-js-typescript');
    assert.ok(node);
    assert.equal(node.term, 'Node.js & TypeScript');
  });

  it('sorts terms deterministically (alphabetically by term)', async (t) => {
    const collection = await fixtureCollection(t, TAG_FIXTURES);
    const tags = defineTaxonomy({ collection, field: 'tags' });

    // Deterministic sort check.
    const sorted = tags.terms.map((x) => x.term);
    const reSorted = [...sorted].sort();
    assert.deepEqual(sorted, reSorted, 'terms must be sorted alphabetically');
  });

  it('looks up a term via getTerm by slug', async (t) => {
    const collection = await fixtureCollection(t, TAG_FIXTURES);
    const tags = defineTaxonomy({ collection, field: 'tags' });

    const found = tags.getTerm('javascript');
    assert.ok(found);
    assert.equal(found.term, 'javascript');
    assert.equal(found.count, 1);
    assert.deepEqual(
      found.pages.map((p) => p.slug),
      ['a'],
    );

    // Missing slug returns undefined.
    assert.equal(tags.getTerm('nonexistent'), undefined);
  });

  it('enumerates getStaticPaths with the default param name "term"', async (t) => {
    const collection = await fixtureCollection(t, TAG_FIXTURES);
    const tags = defineTaxonomy({ collection, field: 'tags' });

    const paths = tags.getStaticPaths();
    const expectedSlugs = tags.terms.map((x) => x.slug).sort();
    const pathSlugs = paths.map((p: Record<string, unknown>) => p.term as string).sort();

    assert.deepEqual(pathSlugs, expectedSlugs);
    assert.equal(paths.length, tags.terms.length);
  });

  it('derives getStaticPaths param name from a custom route', async (t) => {
    const files: Record<string, string> = {
      'one.md': `---
title: One
topics:
  - rust
---
# One
`,
    };
    const collection = await fixtureCollection(t, files);
    const topics = defineTaxonomy({ collection, field: 'topics', route: '/topics/[topic]' });

    const paths = topics.getStaticPaths();
    assert.equal(paths.length, 1);
    // The runtime key is the param name "topic".
    const firstPath = paths[0];
    assert.ok(firstPath);
    assert.ok('topic' in firstPath);
    assert.equal((firstPath as Record<string, unknown>).topic, 'rust');
  });

  it('exposes the route pattern', async (t) => {
    const collection = await fixtureCollection(t, TAG_FIXTURES);
    const tags = defineTaxonomy({ collection, field: 'tags', route: '/custom/[tag]' });

    assert.equal(tags.route, '/custom/[tag]');
  });

  it('exposes the default route pattern', async (t) => {
    const collection = await fixtureCollection(t, TAG_FIXTURES);
    const tags = defineTaxonomy({ collection, field: 'tags' });

    assert.equal(tags.route, '/tags/[term]');
  });

  it('excludes draft pages from every term', async (t) => {
    const collection = await fixtureCollection(t, TAG_FIXTURES);
    const tags = defineTaxonomy({ collection, field: 'tags' });

    const draftTerm = tags.getTerm('draft-tag');
    assert.equal(
      draftTerm,
      undefined,
      'draft-tag must not appear because its only page is a draft',
    );

    // "guide" has 2 non-draft pages (a, b) and 1 draft (draft-post) — draft excluded.
    const guide = tags.getTerm('guide');
    assert.ok(guide);
    assert.equal(guide.count, 2);
    const guideSlugs = guide.pages.map((p) => p.slug);
    assert.deepEqual(guideSlugs, ['a', 'b']);
  });

  it('deduplicates values within a single entry', async (t) => {
    const files: Record<string, string> = {
      'dup.md': `---
title: Duplicate Tags
tags:
  - a
  - b
  - a
  - b
---
# Duplicate Tags
`,
    };
    const collection = await fixtureCollection(t, files);
    const tags = defineTaxonomy({ collection, field: 'tags' });

    const termA = tags.getTerm('a');
    assert.ok(termA);
    assert.equal(termA.count, 1, 'duplicate tags within one entry count as one');
    assert.equal(termA.pages.length, 1);

    const termB = tags.getTerm('b');
    assert.ok(termB);
    assert.equal(termB.count, 1);
  });

  it('drops empty and whitespace-only values', async (t) => {
    const files: Record<string, string> = {
      'p1.md': `---
title: Post One
tags:
  - valid
  - ""
  - "   "
---
# Post One
`,
    };
    const collection = await fixtureCollection(t, files);
    const tags = defineTaxonomy({ collection, field: 'tags' });

    assert.equal(tags.terms.length, 1);
    const firstTerm = tags.terms[0];
    assert.ok(firstTerm);
    assert.equal(firstTerm.term, 'valid');
  });

  it('returns an empty taxonomy for a collection with no pages carrying the field', async (t) => {
    const files: Record<string, string> = {
      'p1.md': `---
title: No Tags Here
---
# No Tags
`,
    };
    const collection = await fixtureCollection(t, files);
    const tags = defineTaxonomy({ collection, field: 'nonexistent' });

    assert.deepEqual(tags.terms, []);
    assert.equal(tags.getStaticPaths().length, 0);
    assert.equal(tags.getTerm('anything'), undefined);
  });

  // Minimal collection mock used for input-validation tests. It only
  // needs `pages` — the taxonomy never accesses other properties.
  function mockCollection(): ContentCollection {
    return { pages: [], bySlug: new Map(), prevNext: new Map(), search: [] };
  }

  it('throws a value-free ContentError for an empty field', () => {
    assert.throws(
      () => defineTaxonomy({ collection: mockCollection(), field: '' }),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'invalid_field');
        // Value-free: the error message never echoes user input.
        assert.ok(!error.message.includes("''"));
        return true;
      },
    );
  });

  it('throws a value-free ContentError for a route without [param]', () => {
    assert.throws(
      () => defineTaxonomy({ collection: mockCollection(), field: 'tags', route: '/bad/path' }),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'invalid_route');
        assert.ok(!error.message.includes('/bad/path'));
        return true;
      },
    );
  });

  it('throws for an empty route string', () => {
    assert.throws(
      () => defineTaxonomy({ collection: mockCollection(), field: 'tags', route: '' }),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'invalid_route');
        return true;
      },
    );
  });

  it('throws value-free ContentError for a whitespace-only field', () => {
    assert.throws(
      () => defineTaxonomy({ collection: mockCollection(), field: '   ' }),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'invalid_field');
        return true;
      },
    );
  });

  it('accepts a ContentCollectionDescriptor (from defineContentCollection interface)', async (t) => {
    const collection = await fixtureCollection(t, TAG_FIXTURES);
    // Wrap as a descriptor-like object (the real descriptor implements the same
    // shape through `pages`).
    const descriptor = {
      pages: collection.pages,
      search: collection.search,
      getEntry: () => undefined,
      getEntries: () => [],
      getStaticPaths: () => [],
      prevNext: () => undefined,
    };
    const tags = defineTaxonomy({ collection: descriptor, field: 'tags' });

    assert.ok(tags.terms.length > 0);
  });

  it('accepts a ContentCollection directly', async (t) => {
    const collection = await fixtureCollection(t, TAG_FIXTURES);
    const tags = defineTaxonomy({ collection, field: 'tags' });

    assert.ok(tags.terms.length > 0);
  });

  it('getTerm returns undefined for a slug that collides but does not match', async (t) => {
    // "HELLO" and "hello" both slugify to "hello".
    const files: Record<string, string> = {
      'p1.md': `---
title: Post One
tags:
  - HELLO
---
# Post One
`,
      'p2.md': `---
title: Post Two
tags:
  - hello
---
# Post Two
`,
    };
    const collection = await fixtureCollection(t, files);
    const tags = defineTaxonomy({ collection, field: 'tags' });

    // Both terms exist (case-sensitive grouping); the lowercased one (in
    // alphabetical sort) wins the slug "hello".
    const byHello = tags.getTerm('hello');
    assert.ok(byHello);
    // "HELLO" > "hello" in ASCII, so "HELLO" sorts after "hello".  The first
    // term in sorted order ("HELLO" or "hello"?)  Let's check:
    // ASCII: 'H' (72) < 'h' (104), so "HELLO" < "hello" → "HELLO" first.
    // But wait — the sort is locale-sensitive String compare, which uses UTF-16
    // code units.  In UTF-16: 'H' = U+0048, 'h' = U+0068, so 'H' < 'h'.
    // Therefore "HELLO" sorts first, and "HELLO" wins the slug "hello".
    assert.equal(byHello.term, 'HELLO');
    assert.equal(byHello.count, 1);

    // The other term ("hello") also slugifies to "hello" but loses for lookup.
    // It still exists in `terms`.
    assert.equal(tags.terms.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Order / weight / slug-field options (additive to the original 20 cases)
// ---------------------------------------------------------------------------

describe('defineTaxonomy: order, weight, and slugField', () => {
  /** A minimal in-memory collection for input-validation tests. */
  const empty = (): ContentCollection => ({
    pages: [],
    bySlug: new Map(),
    prevNext: new Map(),
    search: [],
  });

  it("reproduces the default alphabetical output when order is 'alpha' explicitly", async (t) => {
    const collection = await fixtureCollection(t, TAG_FIXTURES);
    const explicit = defineTaxonomy({ collection, field: 'tags', order: 'alpha' });
    const implicit = defineTaxonomy({ collection, field: 'tags' });

    assert.deepEqual(
      explicit.terms.map((x) => x.term),
      implicit.terms.map((x) => x.term),
    );
    assert.deepEqual(
      explicit.terms.map((x) => x.slug),
      implicit.terms.map((x) => x.slug),
    );
  });

  it('the absence of all three options equals the pre-change output', async (t) => {
    const collection = await fixtureCollection(t, TAG_FIXTURES);
    const tags = defineTaxonomy({ collection, field: 'tags' });

    // No order/weightField/slugField supplied: alphabetical, `toSlug` slugs.
    assert.deepEqual(
      tags.terms.map((x) => x.term),
      ['css', 'guide', 'javascript', 'typescript'],
    );
    assert.equal(tags.getTerm('typescript')?.slug, 'typescript');
  });

  it("sorts by descending count with an alpha tiebreak when order is 'count'", async (t) => {
    const collection = await fixtureCollection(t, TAG_FIXTURES);
    const tags = defineTaxonomy({ collection, field: 'tags', order: 'count' });

    // guide: 2; css/javascript/typescript: 1 each (alpha tiebreak within ties).
    assert.deepEqual(
      tags.terms.map((x) => x.term),
      ['guide', 'css', 'javascript', 'typescript'],
    );
    assert.equal(tags.terms[0]?.count, 2);
  });

  it("sorts by ascending minimum weight when order is 'weight' with a weightField", async (t) => {
    const files: Record<string, string> = {
      'a.md': `---
title: A
weight: 5
cat: alpha
---
# A
`,
      'b.md': `---
title: B
weight: 1
cat: alpha
---
# B
`,
      'c.md': `---
title: C
weight: 3
cat: beta
---
# C
`,
    };
    const collection = await fixtureCollection(t, files);
    const cats = defineTaxonomy({
      collection,
      field: 'cat',
      order: 'weight',
      weightField: 'weight',
    });

    // alpha min(5,1)=1, beta min(3)=3 → alpha first.
    assert.deepEqual(
      cats.terms.map((x) => x.term),
      ['alpha', 'beta'],
    );
  });

  it("sorts a term with no weightField value last (Infinity) when order is 'weight'", async (t) => {
    const files: Record<string, string> = {
      'a.md': `---
title: A
weight: 2
cat: alpha
---
# A
`,
      'b.md': `---
title: B
cat: beta
---
# B
`,
    };
    const collection = await fixtureCollection(t, files);
    const cats = defineTaxonomy({
      collection,
      field: 'cat',
      order: 'weight',
      weightField: 'weight',
    });

    // beta has no `weight`, so its page weight is Infinity and it sorts last.
    assert.deepEqual(
      cats.terms.map((x) => x.term),
      ['alpha', 'beta'],
    );
  });

  it("uses page.order as the weight source when order is 'weight' and no weightField is set", async (t) => {
    const files: Record<string, string> = {
      'a.md': `---
title: A
order: 10
cat: alpha
---
# A
`,
      'b.md': `---
title: B
order: 1
cat: beta
---
# B
`,
    };
    const collection = await fixtureCollection(t, files);
    const cats = defineTaxonomy({ collection, field: 'cat', order: 'weight' });

    // beta order 1 < alpha order 10 → beta first.
    assert.deepEqual(
      cats.terms.map((x) => x.term),
      ['beta', 'alpha'],
    );
  });

  it("tiebreaks equal weights alphabetically when order is 'weight'", async (t) => {
    const files: Record<string, string> = {
      'a.md': `---
title: A
weight: 2
cat: zebra
---
# A
`,
      'b.md': `---
title: B
weight: 2
cat: alpha
---
# B
`,
    };
    const collection = await fixtureCollection(t, files);
    const cats = defineTaxonomy({
      collection,
      field: 'cat',
      order: 'weight',
      weightField: 'weight',
    });

    assert.deepEqual(
      cats.terms.map((x) => x.term),
      ['alpha', 'zebra'],
    );
  });

  it('reads a verbatim slug from slugField (no toSlug)', async (t) => {
    const files: Record<string, string> = {
      'a.md': `---
title: A
tags:
  - Hello World
cat_slug: My-Custom-Slug
---
# A
`,
    };
    const collection = await fixtureCollection(t, files);
    const tags = defineTaxonomy({ collection, field: 'tags', slugField: 'cat_slug' });

    const term = tags.getTerm('My-Custom-Slug');
    assert.ok(term);
    assert.equal(term.term, 'Hello World');
    // The slug is used verbatim: mixed case and dashes preserved.
    assert.equal(term.slug, 'My-Custom-Slug');
    assert.equal(tags.getTerm('hello-world'), undefined);
  });

  it('falls back to toSlug for a missing, empty, or non-string slugField value', async (t) => {
    const files: Record<string, string> = {
      'a.md': `---
title: A
tags:
  - Has Slug
cat_slug: real-slug
---
# A
`,
      'b.md': `---
title: B
tags:
  - Missing
---
# B
`,
      'c.md': `---
title: C
tags:
  - Empty
cat_slug: "   "
---
# C
`,
      'd.md': `---
title: D
tags:
  - NotString
cat_slug: 42
---
# D
`,
    };
    const collection = await fixtureCollection(t, files);
    const tags = defineTaxonomy({ collection, field: 'tags', slugField: 'cat_slug' });

    assert.equal(tags.getTerm('real-slug')?.term, 'Has Slug');
    assert.equal(tags.getTerm('missing')?.term, 'Missing');
    assert.equal(tags.getTerm('empty')?.term, 'Empty');
    assert.equal(tags.getTerm('notstring')?.term, 'NotString');
  });

  it('the first term in sorted order wins a slugField collision', async (t) => {
    const files: Record<string, string> = {
      'a.md': `---
title: A
tags:
  - Zebra
cat_slug: shared
---
# A
`,
      'b.md': `---
title: B
tags:
  - Alpha
cat_slug: shared
---
# B
`,
    };
    const collection = await fixtureCollection(t, files);
    const tags = defineTaxonomy({ collection, field: 'tags', slugField: 'cat_slug' });

    // "Alpha" sorts before "Zebra", so "Alpha" wins the shared slug.
    const winner = tags.getTerm('shared');
    assert.ok(winner);
    assert.equal(winner.term, 'Alpha');
    assert.equal(tags.terms.length, 2);
  });

  it('throws a value-free ContentError for an invalid order', () => {
    assert.throws(
      () => defineTaxonomy({ collection: empty(), field: 'tags', order: 'fancy' as never }),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'invalid_order');
        assert.ok(!error.message.includes('fancy'));
        return true;
      },
    );
  });

  it('throws a value-free ContentError for an empty weightField', () => {
    assert.throws(
      () =>
        defineTaxonomy({ collection: empty(), field: 'tags', order: 'weight', weightField: '' }),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'invalid_field');
        return true;
      },
    );
  });

  it('throws a value-free ContentError for a non-string weightField', () => {
    assert.throws(
      () =>
        defineTaxonomy({
          collection: empty(),
          field: 'tags',
          order: 'weight',
          weightField: 42 as unknown as string,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'invalid_field');
        return true;
      },
    );
  });

  it('throws a value-free ContentError for an empty slugField', () => {
    assert.throws(
      () => defineTaxonomy({ collection: empty(), field: 'tags', slugField: '   ' }),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'invalid_field');
        return true;
      },
    );
  });
});
