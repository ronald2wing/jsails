---
title: About
---

This is a static blog built on the `jsails/content` layer. The whole site is
rendered to HTML at build time — there is no server, no database, and no backend
actions at runtime.

The pages you can browse are ordinary compiled modules under `pages/`. The post
you are reading, the tag index, and the home page all share one discovery pass
over the Markdown files in `content/posts/`, so adding a new post is a matter of
dropping in a file.

## How it is put together

- **Content** lives in `content/` as Markdown with typed frontmatter.
- **The collection and taxonomy** are defined once in `jsails.content.js` and
  imported by every page.
- **Rendering** is Preact served through the framework's static export.
- **The feed** (`rss.xml`), sitemap, and `robots.txt` are written by a
  post-build script from the same collection.

To add a post, create a Markdown file with a `title` and a `date`, then rebuild.
The home page, archive, tag pages, feed, and sitemap all pick it up.
