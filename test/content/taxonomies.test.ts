/**
 * Multi-taxonomy registry tests (`jsails/content`).
 *
 * Covers name lookup in declaration order, delegation to `defineTaxonomy` for
 * field/route validation, per-taxonomy order propagation, concatenated
 * static-path enumeration (no dedup), value-free `ContentError` on a bad or
 * duplicate name, the empty registry, and immutability.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
  ContentError,
  defineTaxonomy,
  defineTaxonomies,
  discoverContent,
  type ContentCollection,
} from '../../src/content/index.js';

/** Create a fresh temp directory and register its cleanup on the test. */
function tempRoot(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-taxonomies-'));
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

/** A minimal empty in-memory collection for validation tests. */
function emptyCollection(): ContentCollection {
  return { pages: [], bySlug: new Map(), prevNext: new Map(), search: [] };
}

/** Posts with a `tags` array and a scalar `category`, for per-taxonomy order checks. */
const POSTS: Record<string, string> = {
  'a.md': `---
title: A
weight: 5
category: Engineering
tags:
  - javascript
  - guide
---
# A
`,
  'b.md': `---
title: B
weight: 1
category: Engineering
tags:
  - typescript
  - guide
---
# B
`,
  'c.md': `---
title: C
weight: 3
category: Design
tags:
  - css
---
# C
`,
};

describe('defineTaxonomies', () => {
  it('exposes names in declaration order', async (t) => {
    const collection = await fixtureCollection(t, POSTS);
    const registry = defineTaxonomies({
      collection,
      taxonomies: [
        { name: 'tags', field: 'tags', route: '/tags/[term]' },
        { name: 'categories', field: 'category', route: '/categories/[term]' },
      ],
    });

    assert.deepEqual(registry.names, ['tags', 'categories']);
  });

  it('looks up a taxonomy by name and returns undefined for a missing name', async (t) => {
    const collection = await fixtureCollection(t, POSTS);
    const registry = defineTaxonomies({
      collection,
      taxonomies: [{ name: 'tags', field: 'tags', route: '/tags/[term]' }],
    });

    assert.ok(registry.get('tags'));
    assert.equal(registry.get('tags')?.route, '/tags/[term]');
    assert.equal(registry.get('nope'), undefined);
  });

  it('each taxonomy honours its own order', async (t) => {
    const collection = await fixtureCollection(t, POSTS);
    const registry = defineTaxonomies({
      collection,
      taxonomies: [
        { name: 'tags', field: 'tags', route: '/tags/[term]', order: 'count' },
        {
          name: 'categories',
          field: 'category',
          route: '/categories/[term]',
          order: 'weight',
          weightField: 'weight',
        },
      ],
    });

    // tags: guide(2), css/javascript/typescript(1) — count desc then alpha.
    assert.deepEqual(
      registry.get('tags')?.terms.map((x) => x.term),
      ['guide', 'css', 'javascript', 'typescript'],
    );
    // categories: Engineering min(5,1)=1, Design(3) — weight asc.
    assert.deepEqual(
      registry.get('categories')?.terms.map((x) => x.term),
      ['Engineering', 'Design'],
    );
  });

  it('concatenates getStaticPaths in declaration order with no dedup across taxonomies', async (t) => {
    const files: Record<string, string> = {
      'one.md': `---
title: One
a: shared
b: shared
---
# One
`,
    };
    const collection = await fixtureCollection(t, files);
    const registry = defineTaxonomies({
      collection,
      taxonomies: [
        { name: 'aa', field: 'a', route: '/aa/[term]' },
        { name: 'bb', field: 'b', route: '/bb/[term]' },
      ],
    });

    const paths = registry.getStaticPaths();
    assert.equal(paths.length, 2);
    assert.deepEqual(paths, [{ term: 'shared' }, { term: 'shared' }]);
  });

  it('throws ContentError("duplicate_taxonomy") for a duplicate name', async (t) => {
    const collection = await fixtureCollection(t, POSTS);
    assert.throws(
      () =>
        defineTaxonomies({
          collection,
          taxonomies: [
            { name: 'tags', field: 'tags', route: '/tags/[term]' },
            { name: 'tags', field: 'category', route: '/categories/[term]' },
          ],
        }),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'duplicate_taxonomy');
        return true;
      },
    );
  });

  it('throws ContentError("invalid_taxonomy") for an empty name', async (t) => {
    const collection = await fixtureCollection(t, POSTS);
    for (const name of ['', '   ']) {
      assert.throws(
        () =>
          defineTaxonomies({
            collection,
            taxonomies: [{ name, field: 'tags', route: '/tags/[term]' }],
          }),
        (error: unknown) => {
          assert.ok(error instanceof ContentError);
          assert.equal(error.code, 'invalid_taxonomy');
          return true;
        },
      );
    }
  });

  it('returns an empty registry for an empty taxonomies array', () => {
    const registry = defineTaxonomies({ collection: emptyCollection(), taxonomies: [] });

    assert.deepEqual(registry.names, []);
    assert.equal(registry.get('anything'), undefined);
    assert.deepEqual(registry.getStaticPaths(), []);
  });

  it('is frozen (registry and names)', async (t) => {
    const collection = await fixtureCollection(t, POSTS);
    const registry = defineTaxonomies({
      collection,
      taxonomies: [{ name: 'tags', field: 'tags', route: '/tags/[term]' }],
    });

    assert.ok(Object.isFrozen(registry));
    assert.ok(Object.isFrozen(registry.names));
  });

  it('is a thin loop over defineTaxonomy (equivalent terms and static paths)', async (t) => {
    const collection = await fixtureCollection(t, POSTS);
    const registry = defineTaxonomies({
      collection,
      taxonomies: [{ name: 'tags', field: 'tags', route: '/tags/[term]', order: 'count' }],
    });
    const direct = defineTaxonomy({
      collection,
      field: 'tags',
      route: '/tags/[term]',
      order: 'count',
    });

    assert.deepEqual(registry.get('tags')?.terms, direct.terms);
    assert.deepEqual(registry.get('tags')?.getStaticPaths(), direct.getStaticPaths());
  });

  it('propagates a ContentError for an invalid field or route from defineTaxonomy', async (t) => {
    const collection = await fixtureCollection(t, POSTS);
    assert.throws(
      () =>
        defineTaxonomies({
          collection,
          taxonomies: [{ name: 'tags', field: '', route: '/tags/[term]' }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'invalid_field');
        return true;
      },
    );
    assert.throws(
      () =>
        defineTaxonomies({
          collection,
          taxonomies: [{ name: 'tags', field: 'tags', route: '/no-param' }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'invalid_route');
        return true;
      },
    );
  });
});
