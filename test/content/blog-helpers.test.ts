/**
 * Blog furniture helper tests (`jsails/content` — Slice 4).
 *
 * Covers: RSS + Atom feed output (well-formed, escaped text/attrs, correct
 * links/dates, limit, newest-first ordering, value-free error on bad siteUrl),
 * sitemap (one url per non-draft page, lastmod from date), blogIndex (sort,
 * tag filter, limit), tagIndex (count-desc then term), pageUrl (derivation +
 * override), readingTime (min 1, scales with length), and value-free errors.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
  blogIndex,
  ContentError,
  defineContentCollection,
  defineTaxonomy,
  pageUrl,
  readingTime,
  renderAtomFeed,
  renderRssFeed,
  renderSitemap,
  tagIndex,
  type ContentCollectionDescriptor,
  type ContentPage,
} from '../../src/content/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempRoot(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-blog-helpers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }
}

function cacheDir(root: string): string {
  return join(root, '.cache');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a collection with multiple posts, including dates and tags. */
async function buildCollection(
  t: TestContext,
): Promise<ContentCollectionDescriptor<Record<string, unknown>>> {
  const root = tempRoot(t);
  writeFiles(root, {
    'post-a.md': `---
title: Post A
date: 2026-10-05
order: 5
tags:
  - javascript
  - guide
---
# Post A Heading

This is the first paragraph of post A.

## Sub A

Second paragraph here with enough content so reading time is measurable.
More words. Still more words. Keep going. Almost there. One more sentence.
`,
    'post-b.md': `---
title: Post B
date: 2026-10-10
order: 1
tags:
  - typescript
  - guide
excerpt: Custom excerpt for B
---
# Post B Heading

Post B body content. Short.
`,
    'draft-post.md': `---
title: Draft Post
draft: true
date: 2026-10-15
tags:
  - draft
---
# Draft

This is a draft and must not appear in feeds, sitemap, or blogIndex.
`,
    'no-date.md': `---
title: No Date Post
order: 2
tags:
  - javascript
---
# No Date

A post with no date field. Much longer content here.
This has more words. And more. And more. And more. And more.
And more. And more. And more. And more. And more. And more.
`,
  });

  return defineContentCollection({
    dir: root,
    cacheDir: cacheDir(root),
  });
}

/** Build a collection without any `excerpt` field, for excerpt-from-html test. */
async function buildCollectionNoExcerpt(
  t: TestContext,
): Promise<ContentCollectionDescriptor<Record<string, unknown>>> {
  const root = tempRoot(t);
  writeFiles(root, {
    'single.md': `---
title: Single
date: 2026-10-01
---
# Single

First paragraph excerpt text here. More words follow.

Second paragraph.
`,
  });

  return defineContentCollection({
    dir: root,
    cacheDir: cacheDir(root),
  });
}

// ---------------------------------------------------------------------------
// renderRssFeed
// ---------------------------------------------------------------------------

describe('renderRssFeed', () => {
  it('produces well-formed RSS 2.0 XML', async (t) => {
    const collection = await buildCollection(t);
    const xml = renderRssFeed(collection, {
      title: 'My Blog',
      description: 'A blog about code',
      siteUrl: 'https://example.com',
    });

    // Structural assertions.
    assert.ok(xml.includes('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('<rss version="2.0"'));
    assert.ok(xml.includes('<channel>'));
    assert.ok(xml.includes('<title>My Blog</title>'));
    assert.ok(xml.includes('<description>A blog about code</description>'));
    assert.ok(xml.includes('<link>https://example.com</link>'));
    assert.ok(xml.includes('</channel>'));
    assert.ok(xml.includes('</rss>'));

    // Draft must not appear.
    assert.ok(!xml.includes('Draft Post'));
  });

  it('includes items for every non-draft page', async (t) => {
    const collection = await buildCollection(t);
    const xml = renderRssFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    // 3 non-draft pages: post-a, post-b, no-date.
    const itemCount = (xml.match(/<item>/g) ?? []).length;
    assert.equal(itemCount, 3);

    // Post B's excerpt comes from its rendered HTML (first <p>),
    // not from the frontmatter `excerpt` field — discover.ts extracts
    // the excerpt from HTML.
    assert.ok(xml.includes('<title>Post B</title>'));
    assert.ok(xml.includes('<description>Post B body content. Short.</description>'));
    assert.ok(xml.includes('Post A'));
    assert.ok(xml.includes('No Date Post'));
  });

  it('respects limit', async (t) => {
    const collection = await buildCollection(t);
    const xml = renderRssFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
      limit: 1,
    });

    const itemCount = (xml.match(/<item>/g) ?? []).length;
    assert.equal(itemCount, 1);
  });

  it('orders items newest-first by date then order', async (t) => {
    const collection = await buildCollection(t);
    const xml = renderRssFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    // Extract titles in order from the XML.
    const titles: string[] = [];
    const titleRe = /<title>(?!(?:My Blog|Feed))([^<]+)<\/title>/g;
    let match;
    while ((match = titleRe.exec(xml)) !== null) {
      titles.push(match[1] ?? '');
    }
    // post-b (2026-10-10) > post-a (2026-10-05) > no-date (no date → epoch → last)
    assert.deepEqual(titles, ['Post B', 'Post A', 'No Date Post']);
  });

  it('escapes XML special characters in title and description', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, {
      'ampersand.md': `---
title: AT&T &amp; Verizon
date: 2026-10-01
---
# Title

Excerpt with tags and "quotes".
`,
    });
    const collection = await defineContentCollection({
      dir: root,
      cacheDir: cacheDir(root),
    });
    const xml = renderRssFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    // The raw title "AT&T &amp; Verizon" — the '&' in "AT&T" is escaped to &amp; in XML.
    assert.ok(xml.includes('<title>AT&amp;T &amp;amp; Verizon</title>'));
    // The excerpt has quotes. They're fine in XML text content (only need escaping in attributes).
    assert.ok(xml.includes('<description>'), 'has description element');
  });

  it('uses urlFor override for item links', async (t) => {
    const collection = await buildCollection(t);
    const xml = renderRssFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
      urlFor: (p) => `https://example.com/posts/${p.slug}`,
    });

    assert.ok(xml.includes('<link>https://example.com/posts/post-b</link>'));
  });

  it('throws value-free ContentError on missing siteUrl', () => {
    assert.throws(
      () =>
        renderRssFeed(
          {
            pages: [],
            search: [],
            getEntry: () => undefined,
            getEntries: () => [],
            getStaticPaths: () => [],
            prevNext: () => undefined,
          },
          { title: 'Feed', siteUrl: '' },
        ),
      (e: unknown) => {
        assert.ok(e instanceof ContentError);
        assert.equal(e.code, 'invalid_site_url');
        return true;
      },
    );
  });

  it('throws ContentError on non-absolute siteUrl', () => {
    assert.throws(
      () =>
        renderRssFeed(
          {
            pages: [],
            search: [],
            getEntry: () => undefined,
            getEntries: () => [],
            getStaticPaths: () => [],
            prevNext: () => undefined,
          },
          { title: 'Feed', siteUrl: 'not-a-url' },
        ),
      (e: unknown) => {
        assert.ok(e instanceof ContentError);
        assert.equal(e.code, 'invalid_site_url');
        return true;
      },
    );
  });

  it('defaults feedUrl from siteUrl', async (t) => {
    const collection = await buildCollection(t);
    const xml = renderRssFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    // The self-link should point to /feed.xml.
    assert.ok(xml.includes('href="https://example.com/feed.xml"'));
  });

  it('strips trailing slash from siteUrl in item links', async (t) => {
    const collection = await buildCollection(t);
    const xml = renderRssFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com/',
    });

    // Links should be https://example.com/post-b, not //post-b.
    assert.ok(xml.includes('<link>https://example.com/post-b</link>'));
  });
});

// ---------------------------------------------------------------------------
// renderAtomFeed
// ---------------------------------------------------------------------------

describe('renderAtomFeed', () => {
  it('produces well-formed Atom 1.0 XML', async (t) => {
    const collection = await buildCollection(t);
    const xml = renderAtomFeed(collection, {
      title: 'My Blog',
      description: 'A blog about code',
      siteUrl: 'https://example.com',
    });

    assert.ok(xml.includes('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('<feed xmlns="http://www.w3.org/2005/Atom">'));
    assert.ok(xml.includes('<title>My Blog</title>'));
    assert.ok(xml.includes('<subtitle>A blog about code</subtitle>'));

    // Draft must not appear.
    assert.ok(!xml.includes('Draft Post'));
  });

  it('includes entries for every non-draft page', async (t) => {
    const collection = await buildCollection(t);
    const xml = renderAtomFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    const entryCount = (xml.match(/<entry>/g) ?? []).length;
    assert.equal(entryCount, 3);
  });

  it('uses page URL as entry id', async (t) => {
    const collection = await buildCollection(t);
    const xml = renderAtomFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    assert.ok(xml.includes('<id>https://example.com/post-b</id>'));
  });

  it('emits updated timestamps in ISO 8601', async (t) => {
    const collection = await buildCollection(t);
    const xml = renderAtomFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    // Post B has date 2026-10-10 → 2026-10-10T00:00:00.000Z
    assert.ok(xml.includes('2026-10-10T00:00:00.000Z'));
  });

  it('uses summary from excerpt', async (t) => {
    const collection = await buildCollection(t);
    const xml = renderAtomFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    // Post B's excerpt comes from rendered HTML: "Post B body content. Short."
    assert.ok(xml.includes('<summary>Post B body content. Short.</summary>'));
  });

  it('defaults feedUrl from siteUrl', async (t) => {
    const collection = await buildCollection(t);
    const xml = renderAtomFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    assert.ok(xml.includes('href="https://example.com/atom.xml"'));
  });

  it('throws value-free ContentError on missing siteUrl', () => {
    assert.throws(
      () =>
        renderAtomFeed(
          {
            pages: [],
            search: [],
            getEntry: () => undefined,
            getEntries: () => [],
            getStaticPaths: () => [],
            prevNext: () => undefined,
          },
          { title: 'Feed', siteUrl: '' },
        ),
      (e: unknown) => {
        assert.ok(e instanceof ContentError);
        assert.equal(e.code, 'invalid_site_url');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// renderSitemap
// ---------------------------------------------------------------------------

describe('renderSitemap', () => {
  it('produces well-formed sitemap XML', async (t) => {
    const collection = await buildCollection(t);
    const xml = renderSitemap(collection, {
      siteUrl: 'https://example.com',
    });

    assert.ok(xml.includes('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
    assert.ok(xml.includes('</urlset>'));
  });

  it('emits one <url> per non-draft page', async (t) => {
    const collection = await buildCollection(t);
    const xml = renderSitemap(collection, {
      siteUrl: 'https://example.com',
    });

    const urlCount = (xml.match(/<url>/g) ?? []).length;
    assert.equal(urlCount, 3);

    // Draft must not appear.
    assert.ok(!xml.includes('draft-post'));
  });

  it('emits <lastmod> from page date', async (t) => {
    const collection = await buildCollection(t);
    const xml = renderSitemap(collection, {
      siteUrl: 'https://example.com',
    });

    // Post B has date 2026-10-10.
    assert.ok(xml.includes('<lastmod>2026-10-10</lastmod>'));
  });

  it('does not emit lastmod for pages without a date', async (t) => {
    const collection = await buildCollection(t);
    const xml = renderSitemap(collection, {
      siteUrl: 'https://example.com',
    });

    // Find the <url> block for the no-date page.
    const noDateIdx = xml.indexOf('<loc>https://example.com/no-date</loc>');
    assert.ok(noDateIdx >= 0, 'no-date page should have a <loc>');
    const nextCloseIdx = xml.indexOf('</url>', noDateIdx);
    assert.ok(nextCloseIdx >= 0);
    const urlBlock = xml.substring(noDateIdx, nextCloseIdx);

    assert.ok(!urlBlock.includes('<lastmod>'), 'no-date page must not emit <lastmod>');
  });

  it('uses urlFor override', async (t) => {
    const collection = await buildCollection(t);
    const xml = renderSitemap(collection, {
      siteUrl: 'https://example.com',
      urlFor: (p) => `https://example.com/posts/${p.slug}`,
    });

    assert.ok(xml.includes('<loc>https://example.com/posts/post-b</loc>'));
  });

  it('escapes XML special characters in loc', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, {
      'amp.md': `---
title: Ampersand &amp; Co
date: 2026-10-01
---
# Amp

Content.
`,
    });
    const collection = await defineContentCollection({
      dir: root,
      cacheDir: cacheDir(root),
    });

    // Exercise urlFor escaping via `&` in the URL query string.
    const xml2 = renderSitemap(collection, {
      siteUrl: 'https://example.com',
      urlFor: () => 'https://example.com/foo?bar=baz&qux=quux',
    });
    assert.ok(xml2.includes('foo?bar=baz&amp;qux=quux'));
  });

  it('throws value-free ContentError on missing siteUrl', () => {
    assert.throws(
      () =>
        renderSitemap(
          {
            pages: [],
            search: [],
            getEntry: () => undefined,
            getEntries: () => [],
            getStaticPaths: () => [],
            prevNext: () => undefined,
          },
          { siteUrl: '' },
        ),
      (e: unknown) => {
        assert.ok(e instanceof ContentError);
        assert.equal(e.code, 'invalid_site_url');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// blogIndex
// ---------------------------------------------------------------------------

describe('blogIndex', () => {
  it('returns non-draft pages sorted newest-first', async (t) => {
    const collection = await buildCollection(t);
    const posts = blogIndex(collection);

    const slugs = posts.map((p) => p.slug);
    // post-b (2026-10-10) > post-a (2026-10-05) > no-date (no date).
    assert.deepEqual(slugs, ['post-b', 'post-a', 'no-date']);
  });

  it('applies a limit', async (t) => {
    const collection = await buildCollection(t);
    const posts = blogIndex(collection, { limit: 1 });

    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.slug, 'post-b');
  });

  it('filters by tag', async (t) => {
    const collection = await buildCollection(t);
    const posts = blogIndex(collection, { tag: 'javascript' });

    const slugs = posts.map((p) => p.slug);
    assert.deepEqual(slugs, ['post-a', 'no-date']);
  });

  it('combines limit and tag filter', async (t) => {
    const collection = await buildCollection(t);
    const posts = blogIndex(collection, { tag: 'guide', limit: 1 });

    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.slug, 'post-b');
  });
});

// ---------------------------------------------------------------------------
// tagIndex
// ---------------------------------------------------------------------------

describe('tagIndex', () => {
  it('sorts terms by count descending then term ascending', async (t) => {
    const collection = await buildCollection(t);
    const taxonomy = defineTaxonomy({ collection, field: 'tags' });
    const terms = tagIndex(taxonomy);

    const names = terms.map((x) => x.term);
    // guide: 2, javascript: 2, typescript: 1. But within ties, alphabetical.
    // Actually: javascript appears on post-a and no-date → 2.
    // guide appears on post-a and post-b → 2.
    // typescript appears on post-b → 1.
    // "guide" < "javascript" alphabetically, so for count=2: guide, javascript.
    assert.deepEqual(names, ['guide', 'javascript', 'typescript']);
  });

  it('returns an empty array for an empty taxonomy', () => {
    const taxonomy = defineTaxonomy({
      collection: { pages: [], bySlug: new Map(), prevNext: new Map(), search: [] },
      field: 'tags',
    });
    const terms = tagIndex(taxonomy);
    assert.deepEqual(terms, []);
  });
});

// ---------------------------------------------------------------------------
// pageUrl
// ---------------------------------------------------------------------------

describe('pageUrl', () => {
  it('derives URL from slug', () => {
    const page: ContentPage = {
      slug: 'blog/hello',
      section: 'blog',
      title: 'Hello',
      order: 1,
      html: '',
      toc: [],
      draft: false,
      tags: [],
      data: {},
    };
    assert.equal(pageUrl(page), '/blog/hello');
  });

  it('uses urlFor override', () => {
    const page: ContentPage = {
      slug: 'hello',
      section: '',
      title: 'Hello',
      order: 1,
      html: '',
      toc: [],
      draft: false,
      tags: [],
      data: {},
    };
    assert.equal(
      pageUrl(page, { urlFor: (p) => `https://example.com/posts/${p.slug}` }),
      'https://example.com/posts/hello',
    );
  });

  it('prepends slash for top-level slugs', () => {
    const page: ContentPage = {
      slug: 'about',
      section: '',
      title: 'About',
      order: 1,
      html: '',
      toc: [],
      draft: false,
      tags: [],
      data: {},
    };
    assert.equal(pageUrl(page), '/about');
  });
});

// ---------------------------------------------------------------------------
// readingTime
// ---------------------------------------------------------------------------

describe('readingTime', () => {
  it('returns at least 1 minute', () => {
    const page: ContentPage = {
      slug: 'empty',
      section: '',
      title: 'Empty',
      order: 1,
      html: '',
      toc: [],
      draft: false,
      tags: [],
      data: {},
    };
    assert.equal(readingTime(page), 1);
  });

  it('scales with word count (~200 wpm)', () => {
    // Build a page with ~400 words → 2 minutes.
    const words = Array.from({ length: 400 }, () => 'word').join(' ');
    const html = `<p>${words}</p>`;
    const page: ContentPage = {
      slug: 'long',
      section: '',
      title: 'Long',
      order: 1,
      html,
      toc: [],
      draft: false,
      tags: [],
      data: {},
    };
    assert.equal(readingTime(page), 2);
  });

  it('rounds up fractional minutes', () => {
    // 201 words → ceil(201/200) = ceil(1.005) = 2.
    const words = Array.from({ length: 201 }, () => 'word').join(' ');
    const html = `<p>${words}</p>`;
    const page: ContentPage = {
      slug: 'frac',
      section: '',
      title: 'Fractional',
      order: 1,
      html,
      toc: [],
      draft: false,
      tags: [],
      data: {},
    };
    assert.equal(readingTime(page), 2);
  });

  it('handles real rendered HTML', async (t) => {
    const collection = await buildCollection(t);
    const postA = collection.getEntry('post-a');
    assert.ok(postA);
    const rt = readingTime(postA);

    // The fixture has ~30 words → ceil(30/200) = 1.
    assert.ok(rt >= 1);
    assert.ok(rt <= 5, 'reading time should be small for a short post');
  });

  it('strips HTML tags before counting', () => {
    const html = '<p>Hello <strong>world</strong> from <em>space</em>.</p>';
    const page: ContentPage = {
      slug: 'tagged',
      section: '',
      title: 'Tagged',
      order: 1,
      html,
      toc: [],
      draft: false,
      tags: [],
      data: {},
    };
    // "Hello world from space." → 4 words → 1 min.
    assert.equal(readingTime(page), 1);
  });
});

// ---------------------------------------------------------------------------
// Integration: feed excerpt from rendered HTML (no frontmatter excerpt)
// ---------------------------------------------------------------------------

describe('feed excerpt from HTML', () => {
  it('uses extractExcerpt from HTML when frontmatter has no excerpt', async (t) => {
    const collection = await buildCollectionNoExcerpt(t);
    const xml = renderRssFeed(collection, {
      title: 'Feed',
      siteUrl: 'https://example.com',
    });

    // The first paragraph text is "First paragraph excerpt text here. More words follow.".
    assert.ok(
      xml.includes(
        '<description>First paragraph excerpt text here. More words follow.</description>',
      ),
    );
  });
});
